// ─────────────────────────────────────────────────────────────────────────────
// whatif.js - "WHAT IF THE WIND CHANGES?" (INCIDENT and REPLAY).
//
// The commander drags the compass (where the wind blows TO) and the speed slider. After a short pause the
// backend re-runs the TRAINED MODEL with that wind for the next 3 hours (POST /api/whatif) and the map,
// countdowns and numbers switch to the scenario. Fire, terrain, vegetation and towns stay real.
// "Real wind" puts everything back.
//
//   const w = new WhatIf(slot, { run: (fromDeg, speed) => api.whatIf({...ref, ...}), onScenario: sit => ... });
//   w.setBase(sit);      // the real situation (call on every new hour / incident)
// ─────────────────────────────────────────────────────────────────────────────
import { h, svg, fill, fmtInt, fmtKm2, compass } from './util.js';
import { section, src } from './panel.js';
import { WHATIF } from './config.js';

const PRESETS = [
  ['Real wind', null],
  ['Reverse', base => [(base.from_deg + 180) % 360, base.speed_kmh]],
  ['Calm', base => [base.from_deg, 5]],
  ['Strong', base => [base.from_deg, 55]],
  ['Santa Ana (NE 60)', () => [45, 60]],
];

export class WhatIf {
  constructor(slot, hooks) {
    this.slot = slot; this.hooks = hooks;
    this.base = null;            // real situation
    this.scenario = null;        // what-if situation (null = real)
    this.fromDeg = 0; this.speed = 0;
    this.busy = false; this.error = null;
    this._timer = null; this._token = 0;
  }

  get active() { return !!this.scenario; }

  /** New real situation. Keeps an active scenario's wind and re-runs it for the new moment. */
  setBase(sit) {
    const wasActive = this.active;
    this.base = sit;
    if (!sit?.numbers?.forecast_area_km2?.length) {          // no forecast at this moment: nothing to re-run
      this.scenario = null; this.hooks.onScenario(null);
      return this.draw();
    }
    if (wasActive) this._schedule(0);
    else { this.fromDeg = sit.wind?.from_deg ?? 0; this.speed = Math.round(sit.wind?.speed_kmh ?? 0); this.draw(); }
  }

  reset() {
    this._token++; clearTimeout(this._timer);
    this.scenario = null; this.busy = false; this.error = null;
    this.fromDeg = this.base?.wind?.from_deg ?? 0; this.speed = Math.round(this.base?.wind?.speed_kmh ?? 0);
    this.hooks.onScenario(null);
    this.draw();
  }

  /** User moved a control. */
  set(fromDeg, speed) {
    this.fromDeg = Math.round(((fromDeg % 360) + 360) % 360);
    this.speed = Math.max(0, Math.min(WHATIF.maxSpeed, Math.round(speed)));
    const real = this.base?.wind || {};
    if (Math.abs(((this.fromDeg - real.from_deg + 540) % 360) - 180) < 3 && Math.abs(this.speed - real.speed_kmh) < 1.5) return this.reset();
    this._drawDial();
    this._schedule(WHATIF.debounceMs);
  }

  _schedule(ms) {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._run(), ms);
  }

  async _run() {
    const token = ++this._token;
    this.busy = true; this.error = null; this.draw();
    try {
      const sit = await this.hooks.run(this.fromDeg, this.speed);
      if (token !== this._token) return;
      this.scenario = sit; this.busy = false;
      this.hooks.onScenario(sit);
    } catch (e) {
      if (token !== this._token) return;
      this.busy = false; this.error = e.message;
    }
    this.draw();
  }

  // ── drawing ────────────────────────────────────────────────────────────────
  draw() {
    const base = this.base;
    if (!base) return fill(this.slot);
    if (!base.numbers?.forecast_area_km2?.length) {
      return fill(this.slot, section('What if the wind changes?', null,
        h('div', { class: 'empty-line' }, 'No forecast at this moment, so there is nothing to re-run.')));
    }
    this.dialEl = h('div', { class: 'wi-dial' });
    this.readout = h('div', { class: 'wi-readout mono' });
    const slider = h('input', { type: 'range', min: 0, max: WHATIF.maxSpeed, step: 1, value: this.speed, class: 'wi-slider',
      'aria-label': 'Wind speed', oninput: e => this.set(this.fromDeg, Number(e.target.value)) });
    this._drawDial();

    const presets = h('div', { class: 'wi-presets' }, PRESETS.map(([label, fn]) =>
      h('button', { class: 'btn btn-small' + (!fn && !this.active ? ' on' : ''),
        onclick: () => fn ? this.set(...fn(base.wind)) : this.reset() }, label)));

    fill(this.slot, section('What if the wind changes?', this.active ? 'SCENARIO · not real data' : 'drag the compass',
      h('div', { class: 'wi-body' + (this.active ? ' active' : '') },
        this.dialEl,
        h('div', { class: 'wi-side' },
          this.readout,
          h('label', { class: 'wi-speed' }, h('span', { class: 'stat-label' }, 'Speed'), slider),
          presets)),
      this._comparison(),
      src('Only the wind for the next 3 h changes; fire, terrain, vegetation and towns stay real. ' +
          'The trained model re-runs its forecast. This shows what it learned about wind, not a physics simulation.')));
    this._drawDial();
  }

  /** The compass: arrow = where the wind blows TO (same as the wind card). Drag or click to set it. */
  _drawDial() {
    if (!this.dialEl) return;
    const to = (this.fromDeg + 180) % 360, real = this.base?.wind || {};
    const realTo = ((real.from_deg ?? 0) + 180) % 360;
    const R = 46, C = 56;
    const pt = (deg, r) => [C + r * Math.sin(deg * Math.PI / 180), C - r * Math.cos(deg * Math.PI / 180)];
    const ticks = [];
    for (let d = 0; d < 360; d += 15) {
      const [x1, y1] = pt(d, d % 45 ? R - 3 : R - 6), [x2, y2] = pt(d, R);
      ticks.push(svg('line', { x1, y1, x2, y2, class: d % 45 ? 'tick' : 'tick major' }));
    }
    const labels = ['N', 'E', 'S', 'W'].map((l, i) => { const [x, y] = pt(i * 90, R + 8); return svg('text', { x, y, class: 'lab' }, l); });
    const arrow = (deg, cls, len) => {
      const [tx, ty] = pt(deg, len), [bx, by] = pt(deg + 180, len * 0.55);
      const [lx, ly] = pt(deg + 155, len * 0.42), [rx, ry] = pt(deg - 155, len * 0.42);
      return svg('g', { class: cls },
        svg('line', { x1: bx, y1: by, x2: tx, y2: ty }),
        svg('path', { d: `M${tx},${ty} L${lx + (tx - lx) * 0.35},${ly + (ty - ly) * 0.35} M${tx},${ty} L${rx + (tx - rx) * 0.35},${ry + (ty - ry) * 0.35}` }));
    };
    const el = svg('svg', { viewBox: '0 0 112 112', width: 112, height: 112 },
      svg('circle', { cx: C, cy: C, r: R, class: 'ring' }),
      ...ticks, ...labels,
      this.active ? arrow(realTo, 'arrow real', 30) : null,
      arrow(to, 'arrow ' + (this.active ? 'scenario' : 'current'), 34),
      svg('circle', { cx: C, cy: C, r: 2.5, class: 'hub' }));
    fill(this.dialEl, el);
    const angleAt = e => {
      const r = el.getBoundingClientRect();
      return (Math.atan2(e.clientX - (r.left + r.width / 2), -(e.clientY - (r.top + r.height / 2))) * 180 / Math.PI + 360) % 360;
    };
    let dragging = false;
    el.addEventListener('pointerdown', e => { dragging = true; el.setPointerCapture(e.pointerId); this.set(angleAt(e) + 180, this.speed); });
    el.addEventListener('pointermove', e => { if (dragging) this.set(angleAt(e) + 180, this.speed); });
    el.addEventListener('pointerup', () => { dragging = false; });
    if (this.readout) {
      fill(this.readout,
        h('div', { class: 'wi-big' }, `${this.speed}`, h('span', { class: 'unit' }, 'km/h')),
        h('div', {}, `from ${compass(this.fromDeg)} (${this.fromDeg}°) → blows ${compass(to)}`),
        this.active || this.busy ? h('div', { class: 'dim' }, `real: ${Math.round(real.speed_kmh)} km/h from ${compass(real.from_deg)}`) : null);
    }
  }

  /** What changed compared with the real wind: forecast area and town statuses. */
  _comparison() {
    if (this.busy) return h('div', { class: 'progress' }, h('span', { class: 'spinner' }), 'Re-running the model with this wind…');
    if (this.error) return h('div', { class: 'note note-red' }, `Could not re-run the forecast: ${this.error}`);
    if (!this.active) return null;
    const real = this.base, sc = this.scenario;
    const ra = real.numbers.forecast_area_km2, sa = sc.numbers.forecast_area_km2;
    // towns whose countdown status is different with this wind (only changes that touch EVACUATE or WARNING)
    const byName = list => Object.fromEntries((list || []).map(t => [t.name, t]));
    const R = byName(real.towns), S = byName(sc.towns);
    const RANK = { EVACUATE: 0, WARNING: 1, MONITOR: 2, '': 3 };
    const urgent = st => st === 'EVACUATE' || st === 'WARNING';
    const changes = [...new Set([...Object.keys(R), ...Object.keys(S)])]
      .map(n => ({ name: n, population: (S[n] || R[n]).population, from: R[n]?.status || '', to: S[n]?.status || '' }))
      .filter(c => c.from !== c.to && (urgent(c.from) || urgent(c.to)))
      .sort((a, b) => RANK[a.to] - RANK[b.to] || (b.population || 0) - (a.population || 0))
      .slice(0, 6);
    const chip = st => h('span', { class: 'chip-status', 'data-status': st || 'NONE' }, st || 'none');   // same chips as the countdowns
    const delta = (a, b) => { const d = b - a; return h('span', { class: 'mono ' + (d > 0 ? 'up' : d < 0 ? 'down' : '') }, `${d > 0 ? '+' : d < 0 ? '−' : ''}${fmtKm2(Math.abs(d))}`); };
    return h('div', { class: 'wi-compare' },
      h('table', { class: 'wi-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Forecast area'), h('th', {}, 'Real wind'), h('th', {}, 'Scenario'), h('th', {}, 'Change'))),
        h('tbody', {}, [0, 1, 2].map(k => h('tr', {}, h('td', {}, `+${k + 1} h`),
          h('td', { class: 'mono' }, `${fmtKm2(ra[k])} km²`), h('td', { class: 'mono' }, `${fmtKm2(sa[k])} km²`), h('td', {}, delta(ra[k], sa[k])))))),
      h('div', { class: 'wi-towns' },
        h('div', { class: 'stat-label' }, 'Town countdowns that change'),
        changes.length ? changes.map(c => h('div', { class: 'wi-town' },
          h('span', { class: 'name' }, c.name), h('span', { class: 'sub mono' }, fmtInt(c.population)),
          chip(c.from), h('span', { class: 'arrow' }, '→'), chip(c.to)))
          : h('div', { class: 'empty-line' }, 'No town changes status with this wind.'),
        h('div', { class: 'sub mono' }, `EVACUATE: ${fmtInt(sc.numbers.residents_evacuate)} residents (real ${fmtInt(real.numbers.residents_evacuate)}) · ` +
          `WARNING: ${fmtInt(sc.numbers.residents_warning)} (real ${fmtInt(real.numbers.residents_warning)})`)));
  }
}
