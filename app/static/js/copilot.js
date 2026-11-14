// ─────────────────────────────────────────────────────────────────────────────
// copilot.js - the AI part of the side panel:
//   briefing → plan (every attempt, REJECTED / PASSED banners) → Approve / Dismiss → alert draft → event log
//
// One Copilot object serves one mode (INCIDENT or REPLAY). It remembers its results per situation
// (per replay hour), so scrubbing back to an hour shows the plan you already ran there.
// ─────────────────────────────────────────────────────────────────────────────
import * as api from './api.js';
import { TEXT } from './config.js';
import { h, fill, nowHMS, localHM, copyText, sleep, fmtInt } from './util.js';
import { section } from './panel.js';

const REVEAL_MS = 1100;          // pause between attempts when a new plan is revealed
const PLAN_STEPS = ['Drafting plan…', 'Checking every route against the fire and the +1 h forecast…',
  'Safety check running… a rejected plan is sent back with the reasons…'];

export class Copilot {
  /**
   * @param slot     element for the briefing + plan + alert
   * @param logSlot  element for the event log
   * @param view     main MapView (to show exits and the approved route)
   * @param hooks    {onBeforeRun(), onTownFocus(name)}
   */
  constructor(slot, logSlot, view, hooks = {}) {
    this.slot = slot; this.logSlot = logSlot; this.view = view; this.hooks = hooks;
    this.records = new Map();     // key → record (see _record)
    this.events = [];             // event log, newest first
    this.sit = null; this.ref = null; this.key = null;
    this._stepTimer = null;
  }

  // ── which situation are we looking at ──────────────────────────────────────
  /** ref = {mode:'replay', fire_id, hour} or {mode:'live', incident_id} */
  setSituation(sit, ref) {
    this.sit = sit; this.ref = ref; this.key = JSON.stringify(ref);
    this.draw();
    this._syncMap();
  }

  _record(key = this.key) {
    if (!this.records.has(key)) {
      this.records.set(key, {
        started: false,
        briefing: { state: 'idle', data: null, error: null },     // idle | loading | done | offline | error
        plan: { state: 'idle', data: null, error: null, revealed: 0 },
        decision: null,                                           // null | 'approved' | 'dismissed'
        alert: { state: 'idle', data: null, error: null },
      });
    }
    return this.records.get(key);
  }

  get hasForecast() { return !!(this.sit?.layers?.forecast?.features?.length || this.sit?.towns?.length); }

  // ── event log ──────────────────────────────────────────────────────────────
  /** kind: info | ai | reject | ok | human | alert */
  log(kind, text) {
    const at = this.sit ? localHM(this.sit.time_local) : '';
    this.events.unshift({ clock: nowHMS(), kind, text, at });
    this.drawLog();
  }

  drawLog() {
    fill(this.logSlot, section('Event log', 'operator clock · newest first',
      this.events.length
        ? h('div', { class: 'log' }, this.events.map(e => h('div', { class: 'log-row', 'data-kind': e.kind },
            h('span', { class: 'log-time mono' }, e.clock), h('span', { class: 'log-dot' }), h('span', { class: 'log-text' }, e.text))))
        : h('div', { class: 'empty-line' }, 'Nothing logged yet.')));
  }

  // ── run briefing + plan for the current situation ──────────────────────────
  /** quiet = do not scroll the panel (used when INCIDENT starts the copilot by itself). */
  async run({ quiet = false } = {}) {
    this.quiet = quiet;
    const key = this.key, ref = this.ref, rec = this._record(), at = localHM(this.sit.time_local);
    if (rec.briefing.state === 'loading' || rec.plan.state === 'loading') return;
    this.hooks.onBeforeRun?.();
    rec.started = true;
    rec.decision = null;
    rec.alert = { state: 'idle', data: null, error: null };
    this.log('info', `Copilot run for ${this.sit.name} at ${at}`);
    this._reveal(null);
    await Promise.all([this._runBriefing(key, ref, rec), this._runPlan(key, ref, rec, at)]);
  }

  async _runBriefing(key, ref, rec) {
    rec.briefing = { state: 'loading', data: null, error: null };
    this._drawIfCurrent(key);
    try {
      rec.briefing = { state: 'done', data: await api.aiBriefing(ref), error: null };
      this.log('ai', `Briefing drafted (${rec.briefing.data.model}${rec.briefing.data.cached ? ', cached' : ''})`);
    } catch (e) {
      rec.briefing = { state: e.status === 503 ? 'offline' : 'error', data: null, error: e.message };
      this.log('reject', e.status === 503 ? `Briefing: ${TEXT.aiOffline}` : `Briefing failed: ${e.message}`);
    }
    this._drawIfCurrent(key);
    if (key === this.key && rec.plan.state === 'loading') this._reveal(null);
  }

  async _runPlan(key, ref, rec, at) {
    rec.plan = { state: 'loading', data: null, error: null, revealed: 0 };
    this._drawIfCurrent(key);
    let data;
    try { data = await api.aiPlan(ref); }
    catch (e) {
      if (e.status === 503 && e.body) data = e.body;        // AI_OFFLINE comes back as HTTP 503 with a body
      else {
        rec.plan = { state: 'error', data: null, error: e.message, revealed: 0 };
        this.log('reject', `Plan failed: ${e.message}`);
        return this._drawIfCurrent(key);
      }
    }
    rec.plan = { state: 'done', data, error: null, revealed: 0 };
    // Reveal the attempts one at a time so a REJECTED banner is seen before the corrected plan.
    const attempts = data.attempts || [];
    for (let i = 0; i < attempts.length; i++) {
      rec.plan.revealed = i + 1;
      const a = attempts[i];
      if (a.verdict === 'REJECTED') this.log('reject', `Plan attempt ${a.attempt} REJECTED by safety check: ${a.reasons.join(' ')}`);
      else this.log('ok', `Plan attempt ${a.attempt} passed the safety check`);
      this._drawIfCurrent(key);
      if (key === this.key) this._reveal('.attempt');
      if (i < attempts.length - 1) await sleep(REVEAL_MS);
    }
    rec.plan.revealed = attempts.length + 1;               // +1 = final card is visible too
    if (data.status === 'ACCEPTED') {
      for (const hd of data.human_decisions || []) this.log('human', `Human decision needed: ${hd}`);
      this.log('ai', `Plan for ${at} ready for operator decision`);
    } else if (data.status === 'MANUAL') this.log('human', data.message || 'Manual decision required');
    else this.log('reject', TEXT.aiOffline);
    this._drawIfCurrent(key);
    if (key === this.key) { this._syncMap(); this._reveal('.plan, .big-card'); }
  }

  // ── operator decisions ─────────────────────────────────────────────────────
  async approve() {
    const key = this.key, ref = this.ref, rec = this._record();
    const plan = rec.plan.data.plan;
    rec.decision = 'approved';
    this.quiet = false;
    this.log('ok', `Plan APPROVED by operator: evacuate ${(plan.evacuate || []).map(e => `${e.town} via ${e.exit}`).join('; ') || 'none'}`);
    this._syncMap();
    rec.alert = { state: 'loading', data: null, error: null };
    this._drawIfCurrent(key);
    try {
      rec.alert = { state: 'done', data: await api.aiAlert(ref, plan), error: null };
      this.log('alert', `Alert drafted (${rec.alert.data.chars}/360 characters). ${TEXT.alertLabel}.`);
    } catch (e) {
      rec.alert = { state: e.status === 503 ? 'offline' : 'error', data: null, error: e.message };
      this.log('reject', e.status === 503 ? `Alert: ${TEXT.aiOffline}. Write the alert manually.` : `Alert failed: ${e.message}`);
    }
    this._drawIfCurrent(key);
    if (key === this.key) this._reveal('.wea, .big-card');
  }

  dismiss() {
    this._record().decision = 'dismissed';
    this.log('info', 'Plan DISMISSED by operator');
    this.draw(); this._syncMap();
  }

  reopen() {
    this._record().decision = null;
    this.draw(); this._syncMap();
  }

  /** Tell the map which plan (if any) is on screen, so it shows the right exits. */
  _syncMap() {
    const rec = this.records.get(this.key);
    const plan = rec?.plan.data?.status === 'ACCEPTED' && rec.plan.revealed > (rec.plan.data.attempts || []).length && rec.decision !== 'dismissed'
      ? rec.plan.data.plan : null;
    this.view.setPlan(plan, rec?.decision === 'approved');
  }

  _drawIfCurrent(key) { if (key === this.key) this.draw(); }

  // ── drawing ────────────────────────────────────────────────────────────────
  draw() {
    clearInterval(this._stepTimer);
    if (!this.sit) return fill(this.slot);
    const rec = this._record();
    const at = localHM(this.sit.time_local);
    if (!rec.started) return fill(this.slot, this._idle(at));
    fill(this.slot, this._briefing(rec.briefing), this._plan(rec, at));
  }

  _idle(at) {
    const ok = this.hasForecast;
    return section('AI copilot', null,
      h('div', { class: 'run-card' },
        h('button', { class: 'btn btn-primary btn-run', id: 'run-copilot', disabled: !ok, onclick: () => this.run() }, `Run copilot at ${at}`),
        h('div', { class: 'hint' }, ok
          ? 'Drafts a situation briefing and an evacuation plan for this hour. The plan is checked by code against the forecast before you see it.'
          : 'No forecast for this hour, so there is nothing for the copilot to plan.')));
  }

  _aiMeta(d) {
    if (!d) return null;
    const secs = d.seconds !== undefined && !d.cached ? ` · ${Number(d.seconds).toFixed(1)} s` : '';
    return `${d.provider} · ${d.model}${d.cached ? ' · cached' : secs}`;
  }

  _briefing(b) {
    let body;
    if (b.state === 'loading') body = skeleton('Reading the situation…', 4);
    else if (b.state === 'offline') body = offlineCard(b.error);
    else if (b.state === 'error') body = h('div', { class: 'note note-red' }, `Briefing failed: ${b.error}`);
    else if (b.state === 'done') {
      const lines = String(b.data.text || '').split('\n').map(s => s.trim()).filter(Boolean).map(s => s.replace(/^[-•]\s*/, ''));
      body = h('ul', { class: 'briefing' }, lines.map(l => h('li', {}, l)));
    }
    return section('AI situation briefing', b.state === 'done' ? this._aiMeta(b.data) : null, body);
  }

  _plan(rec, at) {
    const p = rec.plan;
    if (p.state === 'loading') {
      const text = h('span', {}, PLAN_STEPS[0]);
      let i = 0;
      this._stepTimer = setInterval(() => { i = Math.min(i + 1, PLAN_STEPS.length - 1); text.textContent = PLAN_STEPS[i]; }, 3500);
      return section('AI recommendation', null, h('div', { class: 'progress' }, h('span', { class: 'spinner' }), text),
        h('div', { class: 'skeleton-lines' }, [80, 95, 60].map(w => h('div', { class: 'skel', style: `width:${w}%` }))));
    }
    if (p.state === 'error') return section('AI recommendation', null, h('div', { class: 'note note-red' }, `Plan failed: ${p.error}`), this._rerun(at));
    if (p.state !== 'done') return null;

    const d = p.data, attempts = d.attempts || [];
    const parts = attempts.slice(0, p.revealed).map((a, i) => this._attempt(a, attempts.length, i === p.revealed - 1));
    const finalVisible = p.revealed > attempts.length;
    if (!finalVisible) parts.push(h('div', { class: 'progress' }, h('span', { class: 'spinner' }), 'Sending the reasons back to the AI… corrected plan follows'));
    else if (d.status === 'ACCEPTED') parts.push(this._finalPlan(rec, d));
    else if (d.status === 'MANUAL') parts.push(h('div', { class: 'big-card big-manual' },
      h('div', { class: 'big-title' }, 'Manual decision required'),
      h('div', {}, String(d.message || 'The AI plan failed the safety check 3 times.').replace(/^Manual decision required:\s*/i, '').replace(/^./, c => c.toUpperCase())),
      h('div', { class: 'hint' }, 'Use the town countdowns and exits above to decide. Nothing is recommended automatically.')), this._rerun(at));
    else parts.push(offlineCard(d.message), this._rerun(at));
    return section('AI recommendation', attempts.length ? this._aiMeta(attempts[attempts.length - 1]) : null, parts);
  }

  _rerun(at) {
    return h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: () => this.run() }, `Run copilot again at ${at}`));
  }

  /** One attempt: what the AI proposed + the verdict of the safety check. */
  _attempt(a, total, isNewest) {
    const rejected = a.verdict === 'REJECTED';
    const evac = Array.isArray(a.plan?.evacuate) ? a.plan.evacuate : [];
    const proposal = evac.length
      ? evac.map(e => `${e.town} → ${e.exit}`).join(' · ')
      : 'no evacuation';
    return h('div', { class: 'attempt ' + (rejected ? 'attempt-rejected' : 'attempt-ok') + (isNewest ? ' slide-in' : '') },
      h('div', { class: 'attempt-head' },
        h('span', { class: 'attempt-n mono' }, `ATTEMPT ${a.attempt}${total > 1 ? '/' + total : ''}`),
        h('span', { class: 'attempt-prop' }, 'AI proposed: ', h('b', {}, proposal))),
      rejected
        ? h('div', { class: 'banner banner-rejected' },
            h('div', { class: 'banner-title' }, 'REJECTED BY SAFETY CHECK'),
            h('ul', {}, a.reasons.map(r => h('li', {}, r))))
        : h('div', { class: 'banner banner-ok' },
            h('div', { class: 'banner-title' }, 'PASSED SAFETY CHECK'),
            h('div', { class: 'banner-sub' }, 'Every EVACUATE town is covered and no chosen route crosses the fire or the +1 h forecast.')));
  }

  /** The accepted plan with Approve / Dismiss, or what happened after the decision. */
  _finalPlan(rec, d) {
    const plan = d.plan || {};
    const evac = plan.evacuate || [], warn = plan.warn || [];
    const pop = name => this.sit.towns.find(t => t.name === name)?.population;

    if (rec.decision === 'dismissed') {
      return h('div', { class: 'plan plan-dismissed slide-in' },
        h('span', {}, 'Plan dismissed by operator. Nothing was sent.'),
        h('button', { class: 'btn btn-small', onclick: () => this.reopen() }, 'Show plan again'));
    }

    const card = h('div', { class: 'plan slide-in' + (rec.decision === 'approved' ? ' plan-approved' : '') },
      h('div', { class: 'plan-label' }, rec.decision === 'approved' ? 'APPROVED BY OPERATOR' : 'RECOMMENDED PLAN · WAITING FOR YOUR DECISION'),
      evac.length ? h('div', { class: 'plan-block' },
        h('div', { class: 'plan-h', 'data-status': 'EVACUATE' }, 'Evacuate'),
        evac.map(e => h('button', { class: 'plan-evac', onclick: () => this.hooks.onTownFocus?.(e.town) },
          h('div', { class: 'plan-evac-top' },
            h('b', {}, e.town), pop(e.town) ? h('span', { class: 'mono muted' }, `${fmtInt(pop(e.town))} residents`) : null),
          h('div', { class: 'plan-route' + (e.needs_human ? ' plan-route-human' : '') }, h('span', { class: 'route-arrow' }, e.needs_human ? '!' : '→'),
            h('span', { class: 'mono' }, e.exit || 'no exit named')),
          this._routeWarning(e),
          e.reason ? h('div', { class: 'plan-reason' }, e.reason) : null))) : null,
      h('div', { class: 'plan-block' },
        h('div', { class: 'plan-h', 'data-status': 'WARNING' }, 'Warn'),
        h('div', { class: 'plan-warn' }, warn.length ? warn.map(w => h('span', { class: 'pill' }, w)) : h('span', { class: 'muted' }, 'No town'))),
      plan.summary ? h('div', { class: 'plan-summary' }, plan.summary) : null,
      (d.human_decisions || []).map(t => h('div', { class: 'note note-amber' }, h('div', { class: 'note-title' }, 'HUMAN DECISION NEEDED'), t)),
      rec.decision === null ? h('div', { class: 'btn-row' },
        h('button', { class: 'btn btn-approve', id: 'approve-plan', onclick: () => this.approve() }, 'Approve plan'),
        h('button', { class: 'btn', id: 'dismiss-plan', onclick: () => this.dismiss() }, 'Dismiss')) : null);

    return rec.decision === 'approved' ? [card, this._alert(rec.alert)] : card;
  }

  /**
   * Under the route: when the town has NO clear highway exit (every exit runs into the fire within 1 h), the backend
   * replaces the AI's road with "No clear highway exit" and keeps the AI's choice in exit_ai. We say so plainly.
   */
  _routeWarning(e) {
    if (e.needs_human) {
      const ai = (this.sit.exits?.[e.town] || []).find(x => x.id === e.exit_ai);
      return h('div', { class: 'plan-route-warn mono' },
        `AI suggested ${e.exit_ai || 'a road'}` + (ai?.blocked_1h_at_km !== null && ai ? `, which meets fire ${ai.blocked_1h_at_km} km out` : '') +
        '. Not used: choose escort, shelter in place or local roads.');
    }
    const exit = (this.sit.exits?.[e.town] || []).find(x => x.id === e.exit);
    if (!exit || exit.blocked_1h_at_km === null) return null;
    return h('div', { class: 'plan-route-warn mono' }, `route meets fire or +1 h forecast ${exit.blocked_1h_at_km} km from town`);
  }

  /** Scroll the side panel so the newest part of the copilot output can be seen. */
  _reveal(selector) {
    if (this.quiet) return;
    requestAnimationFrame(() => {
      const els = selector ? this.slot.querySelectorAll(selector) : [this.slot];
      els[els.length - 1]?.scrollIntoView({ block: selector ? 'nearest' : 'start', behavior: 'smooth' });
    });
  }

  /** Phone-like card with the WEA alert draft. */
  _alert(al) {
    if (al.state === 'loading') return h('div', { class: 'progress' }, h('span', { class: 'spinner' }), 'Drafting the public alert (max 360 characters)…');
    if (al.state === 'offline') return offlineCard('Write the alert manually. ' + (al.error || ''));
    if (al.state === 'error') return h('div', { class: 'note note-red' }, `Alert failed: ${al.error}`);
    if (al.state !== 'done') return null;
    const d = al.data;
    const copyBtn = h('button', { class: 'btn btn-small', onclick: async () => {
      copyBtn.textContent = (await copyText(d.text)) ? 'Copied' : 'Copy failed';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
    } }, 'Copy');
    return h('div', { class: 'wea slide-in' },
      h('div', { class: 'wea-label' }, d.label || TEXT.alertLabel),
      h('div', { class: 'wea-phone' },
        h('div', { class: 'wea-top' }, h('span', { class: 'wea-icon' }, '!'), h('span', {}, 'EMERGENCY ALERT'), h('span', { class: 'wea-now mono' }, 'draft')),
        h('div', { class: 'wea-text' }, d.text)),
      h('div', { class: 'wea-foot' },
        h('span', { class: 'mono' + (d.chars > 360 ? ' over' : '') }, `${d.chars}/360 characters · WEA`),
        h('span', { class: 'src' }, `${d.model}${d.cached ? ' · cached' : ''}`),
        copyBtn));
  }
}

// ── small shared pieces ──────────────────────────────────────────────────────
export function skeleton(text, lines = 3) {
  return h('div', {},
    h('div', { class: 'progress' }, h('span', { class: 'spinner' }), text),
    h('div', { class: 'skeleton-lines' }, Array.from({ length: lines }, (_, i) => h('div', { class: 'skel', style: `width:${[92, 78, 88, 64][i % 4]}%` }))));
}

export function offlineCard(detail) {
  return h('div', { class: 'big-card big-offline' },
    h('div', { class: 'big-title' }, TEXT.aiOffline),
    h('div', { class: 'hint' }, 'The map, forecast and town countdowns still work. ' +
      (detail ? String(detail).replace(/^AI offline, forecast only\s*/i, '').slice(0, 160) : '')));
}
