// mode_incident.js - INCIDENT mode: the command view of one fire.
//   map:   3D terrain, fire, forecast squares + rings, towns, exits
//   panel: header · wind · numbers · town countdowns · AI briefing · AI plan · alert · event log
import * as api from './api.js';
import { app, setClock, setLoading, setBanner, setToggles, setLegend, toggleRow, segmented } from './app.js';
import { h, fill, $, utcHM, utcDate, compass } from './util.js';
import { TEXT } from './config.js';
import { WhatIf } from './whatif.js';
import { SituationPanel } from './panel.js';
import { Copilot } from './copilot.js';
import { archiveWhen, topIncident } from './mode_state.js';

const s = {
  id: null, at: null, label: '',
  sit: null,
  panel: null, copilot: null, whatif: null,
  loadToken: 0, refreshTimer: null, clockTimer: null,
  horizon: 3,
};

export const incidentMode = {
  enter(args = {}) {
    setLegend('situation'); setToggles();
    const changed = args.id && args.id !== s.id;
    if (changed) { s.id = args.id; s.at = args.at || null; s.label = args.label || ''; s.sit = null; s.copilot = null; }
    if (!s.id) {
      // Nothing picked yet: open the top fire from STATE instead of an empty screen.
      drawEmpty();
      topIncident().then(top => {
        if (!top || app.mode !== 'incident' || s.id) return;
        s.id = top.id; s.at = top.at; s.label = top.label; s.sit = null; s.copilot = null;
        load();
        s.clockTimer = setInterval(updateClock, 20000);
      });
      return;
    }
    if (s.sit) show(true);          // coming back to the same incident: no reload
    else load();
    s.clockTimer = setInterval(updateClock, 20000);
  },
  leave() {
    s.loadToken++;
    clearTimeout(s.refreshTimer); clearInterval(s.clockTimer);
    setLoading(null); setBanner(null);
    app.on3DChange = null;
  },
};

function drawEmpty() {
  setClock('No incident selected', 'idle');
  app.view.showSituation(null);
  fill($('#panel-body'), h('div', { class: 'empty-state' },
    h('div', { class: 'empty-title' }, 'No incident selected'),
    h('div', { class: 'empty-text' }, 'Pick an incident from the ranked list in STATE to open its command view.'),
    h('button', { class: 'btn btn-primary btn-block', onclick: () => app.go('state') }, 'Go to STATE')));
}

async function load(isRefresh = false) {
  const token = ++s.loadToken;
  if (!isRefresh) {
    app.view.showSituation(null);
    setLoading('Downloading GOES-18 scans for this incident… building the forecast… (about 20 s the first time)');
    setClock(`Incident ${s.label} · loading…`, s.at ? 'archive' : 'idle');
    fill($('#panel-body'),
      h('div', { class: 'sit-head' }, h('div', { class: 'sit-title' }, h('h2', {}, `Incident ${s.label}`))),
      h('div', { class: 'progress' }, h('span', { class: 'spinner' }), 'Downloading GOES-18 scans… weather… running the spread model…'),
      h('div', { class: 'skeleton-lines' }, [90, 70, 85, 60, 75, 50].map(w => h('div', { class: 'skel', style: `width:${w}%` }))));
  }
  try {
    const sit = await api.getIncident(s.id);
    if (token !== s.loadToken) return;
    s.sit = sit;
    setLoading(null);
    if (isRefresh) s.whatif?.setBase(sit);
    show(!isRefresh);
  } catch (e) {
    if (token !== s.loadToken) return;
    setLoading(null);
    if (isRefresh) return;          // keep the last good picture on screen
    fill($('#panel-body'), h('div', { class: 'note note-red' },
      e.status === 404 ? 'This incident is no longer in the latest scans (it may have gone out or merged).' : `Could not load the incident: ${e.message}`,
      h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: () => app.go('state') }, 'Back to STATE'))));
  }
}

/** Put the loaded situation on the map and in the panel. firstTime = also move the camera and start the AI. */
function show(firstTime) {
  const real = s.sit, view = app.view;
  const sc = s.whatif?.active ? s.whatif.scenario : null;      // "what if the wind changes?" scenario
  const sit = sc || real;
  setBanner(sc ? TEXT.whatIfBanner(Math.round(sc.whatif.speed_kmh), compass(sc.whatif.from_deg))
    : real.archive ? `ARCHIVE · ${archiveWhen(s.at)} · same pipeline on past GOES-18 data` : null);
  updateClock();

  // map
  view.setGroup('fire', true); view.setGroup('forecast', true); view.setGroup('rings', true);
  view.setGroup('baseline', false); view.setGroup('actual', false); view.setGroup('towns', true);
  view.setHorizon(s.horizon);
  view.showSituation(sit);
  drawToggles();
  if (firstTime) {
    view.set3D(app.want3D.incident ?? true, false);
    view.fit(sit.bounds, { padding: 30 });
  }

  // panel
  const body = $('#panel-body');
  if (firstTime || !s.panel || !body.contains(s.panel.container)) {
    const back = h('button', { class: 'link-back', onclick: () => app.go('state') }, '← State list');
    const sitSlot = h('div'), whatifSlot = h('div'), aiSlot = h('div', { id: 'copilot-slot' }), logSlot = h('div');
    fill(body, back, sitSlot, whatifSlot, aiSlot, logSlot);
    s.whatif = new WhatIf(whatifSlot, {
      run: (fromDeg, speed) => api.whatIf({ mode: 'live', incident_id: s.id, wind_from_deg: fromDeg, wind_speed_kmh: speed }),
      onScenario: scn => {
        if (scn) s.copilot?.log('info', `What-if: wind ${Math.round(scn.whatif.speed_kmh)} km/h from ${compass(scn.whatif.from_deg)} ` +
          `→ +3 h forecast ${scn.numbers.forecast_area_km2[2]} km² (real wind ${s.sit.numbers.forecast_area_km2[2]} km²)`);
        show(false);
      },
    });
    s.whatif.setBase(real);
    s.panel = new SituationPanel(sitSlot, { modelName: app.modelName, onTownSelect: town => {
      view.setSelectedTown(town?.name || null);
      if (town) view.flyToTown(town);
    } });
    view.onTownClick = name => s.panel.select(name);
    if (!s.copilot) {
      s.copilot = new Copilot(aiSlot, logSlot, view, { onTownFocus: name => s.panel.select(name) });
      s.copilot.sit = sit;
      s.copilot.log('info', `Data loaded: ${sit.name}, GOES-18 scan ${utcHM(sit.scan_time_utc)} UTC`);
    } else { s.copilot.slot = aiSlot; s.copilot.logSlot = logSlot; }
  }
  s.panel.update(sit, sc ? 'WHAT-IF' : real.archive ? 'ARCHIVE' : null);
  view.setSelectedTown(s.panel.ui.selected);
  const ref = sc ? { mode: 'live', incident_id: s.id, wind_from_deg: sc.whatif.from_deg, wind_speed_kmh: sc.whatif.speed_kmh }
    : { mode: 'live', incident_id: s.id };
  s.copilot.setSituation(sit, ref);
  s.copilot.drawLog();
  // In INCIDENT the copilot starts by itself (in REPLAY the operator presses "Run copilot").
  if (!s.copilot._record().started && s.copilot.hasForecast) s.copilot.run({ quiet: true });

  // live incidents are refreshed like the state view; archive ones never change
  clearTimeout(s.refreshTimer);
  if (!real.archive) s.refreshTimer = setTimeout(() => load(true), (app.config.refresh_s || 300) * 1000);
}

function updateClock() {
  const sit = s.sit;
  if (!sit) return;
  if (sit.archive) return setClock(`GOES-18 scan ${utcHM(sit.scan_time_utc)} UTC · ARCHIVE ${utcDate(sit.scan_time_utc)}`, 'archive');
  const age = Math.max(0, Math.round((Date.now() - new Date(String(sit.scan_time_utc).replace(' ', 'T'))) / 60000));
  setClock(`GOES-18 scan ${utcHM(sit.scan_time_utc)} UTC · ${age} min ago`, 'live');
}

function drawToggles() {
  const view = app.view;
  setToggles(
    h('div', { class: 'card-title' }, 'Layers'),
    toggleRow('Fire now', view.visible.fire, on => view.setGroup('fire', on), 'sw-fire'),
    toggleRow('Forecast', view.visible.forecast, on => { view.setGroup('forecast', on); view.setGroup('rings', on); }, 'sw-forecast'),
    h('div', { class: 'toggle-sub' }, h('span', {}, 'Squares at'),
      segmented([[1, '+1 h'], [2, '+2 h'], [3, '+3 h']], s.horizon, k => { s.horizon = k; view.setHorizon(k); })));
}
