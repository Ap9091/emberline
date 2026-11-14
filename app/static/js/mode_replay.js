// ─────────────────────────────────────────────────────────────────────────────
// mode_replay.js - REPLAY mode (the demo): step through a past fire hour by hour.
//   map:      real fire, our forecast, baseline, real fire later (toggles), optional split screen
//   panel:    people counter + the same situation panel and copilot as INCIDENT
//   timeline: js/timeline.js
// ─────────────────────────────────────────────────────────────────────────────
import * as api from './api.js';
import { app, setClock, setLoading, setBanner, setToggles, setLegend, toggleRow, segmented } from './app.js';
import { REPLAY_SPEEDS, TEXT } from './config.js';
import { h, fill, $, fmtInt, localHM } from './util.js';
import { MapView, syncMaps } from './mapview.js';
import { SituationPanel } from './panel.js';
import { Copilot } from './copilot.js';
import { Timeline } from './timeline.js';

const s = {
  fires: null,                 // /api/replay
  fireId: null, meta: null,
  hour: 0, sit: null,
  playing: false, speedIdx: 0, playTimer: null,
  split: false, left: null, stopSync: null,      // split screen: second map + camera sync
  toggles: { fire: true, forecast: true, baseline: false, actual: false },
  horizon: 3,
  panel: null, copilot: null,
  copilots: new Map(),         // fire id → Copilot (so each fire keeps its own plans and log)
  lastHour: new Map(),         // fire id → hour we were at
  timeline: null,
  slots: null,
  token: 0,
};

export const replayMode = {
  async enter() {
    setLegend('replay'); setBanner(null);
    app.view.clearState();
    app.view.set3D(app.want3D.replay ?? false, false);
    buildPanel();
    s.timeline = s.timeline || new Timeline($('#timeline'), {
      hour: hr => { pause(); setHour(hr); }, playToggle: () => (s.playing ? pause() : play()),
      step: d => { pause(); setHour(s.hour + d); }, speed: i => { s.speedIdx = i; },
      split: () => setSplit(!s.split), copilot: runCopilot, fire: id => { pause(); loadFire(id); },
    });
    document.addEventListener('keydown', onKey);
    app.on3DChange = on => { if (on && s.split) setSplit(false); };
    try {
      if (!s.fires) s.fires = await api.getReplayList();
      await loadFire(s.fireId || (s.fires.find(f => f.default) || s.fires[0]).fire_id);
    } catch (e) {
      fill(s.slots.sit, h('div', { class: 'note note-red' }, `Could not load the replay: ${e.message}`));
    }
  },
  leave() {
    pause(); s.token++;
    if (s.split) setSplit(false);
    document.removeEventListener('keydown', onKey);
    app.view.setGroup('baseline', false); app.view.setGroup('actual', false);
    app.view.onTownClick = null; app.on3DChange = null;
    setLoading(null);
  },
};

// ── panel skeleton: people counter · situation · copilot · log ───────────────
function buildPanel() {
  s.slots = { people: h('div'), sit: h('div'), ai: h('div', { id: 'copilot-slot' }), log: h('div') };
  fill($('#panel-body'), s.slots.people, s.slots.sit, s.slots.ai, s.slots.log);
  s.panel = new SituationPanel(s.slots.sit, { modelName: app.modelName, onTownSelect: town => {
    app.view.setSelectedTown(town?.name || null);
    if (town) { pause(); app.view.flyToTown(town); }
  } });
  app.view.onTownClick = name => s.panel.select(name);
}

// ── loading a fire and an hour ───────────────────────────────────────────────
async function loadFire(fireId) {
  const token = ++s.token;
  setLoading('Loading replay…');
  const meta = await api.getReplayMeta(fireId);
  if (token !== s.token) return;
  setLoading(null);
  s.fireId = fireId; s.meta = meta; s.sit = null;
  s.panel.modelName = meta.model || app.modelName;
  s.panel.ui.selected = null; app.view.setSelectedTown(null);

  if (!s.copilots.has(fireId)) {
    const c = new Copilot(s.slots.ai, s.slots.log, app.view, {
      onBeforeRun: () => pause(),
      onTownFocus: name => s.panel.select(name),
    });
    s.copilots.set(fireId, c);
    c.events.unshift({ clock: new Date().toLocaleTimeString('en-GB', { hour12: false }), kind: 'info',
      text: `Replay loaded: ${meta.name}, ${meta.hours.length} hours of GOES-18 data (${meta.hours[0].time_local} to ${meta.hours[meta.hours.length - 1].time_local})` });
  }
  s.copilot = s.copilots.get(fireId);
  s.copilot.slot = s.slots.ai; s.copilot.logSlot = s.slots.log;
  s.copilot.drawLog();

  s.hour = s.lastHour.get(fireId) ?? meta.default_hour;
  s.timeline.build(s.fires, meta, timelineUi());
  app.view.fit(meta.bounds, { animate: false, padding: 24 });
  applyLayers();
  await setHour(s.hour);
}

async function setHour(hour) {
  if (!s.meta) return;
  hour = Math.max(0, Math.min(s.meta.hours.length - 1, hour));
  const token = ++s.token;
  s.hour = hour; s.lastHour.set(s.fireId, hour);
  s.timeline.update(timelineUi());                    // move the cursor right away
  let sit;
  try { sit = await api.getReplayHour(s.fireId, hour); }
  catch (e) { if (token === s.token) { pause(); setLoading(`Hour ${hour} could not be loaded: ${e.message}`); } return; }
  if (token !== s.token) return;
  setLoading(null);
  s.sit = sit;
  for (let k = 1; k <= 3; k++) if (hour + k < s.meta.hours.length) api.getReplayHour(s.fireId, hour + k).catch(() => {});   // warm the next hours
  show();
}

/** Draw the current hour everywhere. */
function show() {
  const sit = s.sit;
  app.view.showSituation(sit);
  s.panel.update(sit, 'REPLAY');
  s.copilot.setSituation(sit, { mode: 'replay', fire_id: s.fireId, hour: s.hour });
  drawPeople();
  drawToggles();
  setClock(`REPLAY · ${sit.time_local} · GOES-18`, 'archive');
  s.timeline.update(timelineUi());
  if (s.split) showSplit();
}

function timelineUi() {
  const rec = s.copilot?.records.get(JSON.stringify({ mode: 'replay', fire_id: s.fireId, hour: s.hour }));
  return { hour: s.hour, playing: s.playing, speedIdx: s.speedIdx, split: s.split, copilotRan: !!rec?.started };
}

// ── play / pause ─────────────────────────────────────────────────────────────
function play() {
  if (!s.meta) return;
  if (s.hour >= s.meta.hours.length - 1) s.hour = s.meta.default_hour - 1;    // at the end: start again
  s.playing = true;
  s.timeline.update(timelineUi());
  tick();
}

function tick() {
  clearTimeout(s.playTimer);
  s.playTimer = setTimeout(async () => {
    if (!s.playing) return;
    if (s.hour >= s.meta.hours.length - 1) return pause();
    await setHour(s.hour + 1);
    if (s.playing) tick();
  }, REPLAY_SPEEDS[s.speedIdx]);
}

function pause() {
  if (!s.playing) return;
  s.playing = false;
  clearTimeout(s.playTimer);
  s.timeline?.update(timelineUi());
  if (s.split && s.sit) showSplit();            // paused in split screen: play the fade-in for this hour
}

function onKey(e) {
  if (/INPUT|SELECT|TEXTAREA|BUTTON/.test(e.target.tagName)) return;
  if (e.key === ' ') { e.preventDefault(); s.playing ? pause() : play(); }
  if (e.key === 'ArrowRight') { pause(); setHour(s.hour + 1); }
  if (e.key === 'ArrowLeft') { pause(); setHour(s.hour - 1); }
}

// ── copilot button ───────────────────────────────────────────────────────────
function runCopilot() {
  if (!s.sit) return;
  pause();
  scrollToCopilot();
  if (!s.copilot._record().started) s.copilot.run().then(() => s.timeline.update(timelineUi()));
  s.timeline.update(timelineUi());
}

function scrollToCopilot() {
  requestAnimationFrame(() => s.slots.ai.scrollIntoView({ block: 'start', behavior: 'smooth' }));
}

// ── people counter ───────────────────────────────────────────────────────────
function drawPeople() {
  const tl = s.meta.timeline || [];
  const reached = tl.filter(t => t.fire_arrival_hour !== null && t.fire_arrival_hour !== undefined);
  const warnedFirst = reached.filter(t => t.lead_h > 0);
  const soFar = warnedFirst.filter(t => t.first_warning_hour <= s.hour);
  const sum = list => list.reduce((a, t) => a + (t.population || 0), 0);
  const orders = s.meta.official_orders || [];
  fill(s.slots.people, h('div', { class: 'people' },
    h('div', { class: 'people-main' },
      h('div', { class: 'people-n mono' }, fmtInt(sum(soFar))),
      h('div', { class: 'people-label' }, TEXT.peopleLabel)),
    h('div', { class: 'people-sub mono' },
      `by ${localHM(s.sit.time_local)}: ${soFar.length} of ${reached.length} towns the fire reached · whole replay ${fmtInt(sum(warnedFirst))} · Census 2024`),
    orders.length ? h('div', { class: 'people-sub mono' }, `flagged before the official order: ${fmtInt(flaggedBeforeOrder(tl, orders))} residents`) : null));
}

/** Residents of towns that we warned before their official order (only when real order times exist). */
function flaggedBeforeOrder(tl, orders) {
  let total = 0;
  for (const t of tl) {
    const o = orders.find(x => x.town === t.town);
    const oh = o && (o.hour_idx ?? o.hour);
    if (o && oh !== undefined && oh !== '' && t.first_warning_hour !== null && t.first_warning_hour < Number(oh)) total += t.population || 0;
  }
  return total;
}

// ── layer toggles ────────────────────────────────────────────────────────────
function applyLayers() {
  const v = app.view, t = s.toggles;
  v.cancelFade();
  v.setGroup('fire', t.fire);
  v.setGroup('forecast', t.forecast && !s.split);     // split screen: rings only, no squares
  v.setGroup('rings', t.forecast || s.split);
  v.setGroup('baseline', t.baseline && !s.split);
  v.setGroup('actual', t.actual || s.split);
  v.setGroup('towns', true);
  v.setGroup('exits', !s.split);
  v.setHorizon(s.split ? 3 : s.horizon);
}

function drawToggles() {
  if (s.split) return setToggles();
  const t = s.toggles;
  const set = key => on => { t[key] = on; applyLayers(); };
  setToggles(
    h('div', { class: 'card-title' }, 'Layers'),
    toggleRow('Real fire', t.fire, set('fire'), 'sw-fire'),
    toggleRow('Our forecast', t.forecast, set('forecast'), 'sw-forecast'),
    toggleRow('Baseline: grow 1 km/h', t.baseline, set('baseline'), 'sw-baseline'),
    toggleRow(`Real fire +${s.horizon} h (hindsight)`, t.actual, set('actual'), 'sw-actual'),
    h('div', { class: 'toggle-sub' }, h('span', {}, 'Compare at'),
      segmented([[1, '+1 h'], [2, '+2 h'], [3, '+3 h']], s.horizon, k => { s.horizon = k; applyLayers(); drawToggles(); })));
}

// ── split screen ─────────────────────────────────────────────────────────────
async function setSplit(on) {
  s.split = on;
  const paneLeft = $('#pane-left'), titleMain = $('#pane-main-title');
  paneLeft.hidden = !on; titleMain.hidden = !on;
  $('#map-area').classList.toggle('split', on);
  if (on) {
    if (app.view.is3D) app.set3D(false);
    if (!s.left) {
      // the left map: only the fire, towns in neutral grey
      s.left = new MapView('map-left', structuredClone(app.baseStyle), { neutralTowns: true });
      await s.left.ready;
      for (const g of ['forecast', 'rings', 'baseline', 'actual', 'exits']) s.left.setGroup(g, false);
    }
    app.view.resize(); s.left.resize();
    s.stopSync = syncMaps(app.view, s.left);
    app.view.fit(s.meta.bounds, { animate: false, padding: 24 });
  } else {
    s.stopSync?.(); s.stopSync = null;
    app.view.resize();
    if (s.meta) app.view.fit(s.meta.bounds, { animate: false, padding: 24 });
  }
  applyLayers();
  drawToggles();
  s.timeline.update(timelineUi());
  if (on && s.sit) showSplit();
}

/** Update both halves for the current hour. When paused, the real fire 3 h later fades in on the right. */
function showSplit() {
  if (!s.left) return;
  const at = localHM(s.sit.time_local);
  const later = s.meta.hours[Math.min(s.hour + 3, s.meta.hours.length - 1)].time_local.slice(-5);
  fill($('#pane-left-title'), h('b', {}, `What officials could see at ${at}`), h('span', {}, 'GOES-18 fire detections only'));
  fill($('#pane-main-title'), h('b', {}, `Emberline forecast at ${at}`),
    h('span', {}, `rings: forecast +1/+2/+3 h · dark: real fire at ${later}`));
  s.left.showSituation(s.sit);
  if (s.playing) { app.view.cancelFade(); app.view.setGroup('actual', true); }
  else app.view.fadeInActual();
}
