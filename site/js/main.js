// ─────────────────────────────────────────────────────────────────────────────
// main.js - start-up and the app shell: top bar, mode switching, 2D/3D toggle.
//
// File map (all in app/static/js):
//   config.js        colours, constants, shared wording          ← change colours here
//   util.js          DOM + formatting helpers
//   api.js           every backend call
//   app.js           shared app object + clock / banner / legend / layer-card helpers
//   basemap.js       muted OpenFreeMap style (+ offline fallback)
//   mapview.js       MapLibre map with all data layers
//   panel.js         situation panel (header, wind, numbers, towns)
//   copilot.js       AI briefing, plan + safety-check banners, approve → alert, event log
//   mode_state.js    STATE mode        mode_incident.js  INCIDENT mode
//   mode_replay.js   REPLAY mode       timeline.js       replay timeline bar
//   results.js       Results drawer
// ─────────────────────────────────────────────────────────────────────────────
import * as api from './api.js';
import { app, setClock } from './app.js';
import { COLORS, TEXT } from './config.js';
import { $ } from './util.js';
import { loadBaseStyle } from './basemap.js';
import { STATIC, ONLINE_TILES } from './api.js';
import { MapView } from './mapview.js';
import { stateMode } from './mode_state.js';
import { incidentMode } from './mode_incident.js';
import { replayMode } from './mode_replay.js';
import { initResults } from './results.js';
import { demo, showWelcome, initSettings } from './demo.js';
import { initAssistant } from './assistant.js';

const MODES = { state: stateMode, incident: incidentMode, replay: replayMode };

/** Copy the colours from config.js into CSS variables, so CSS and the map always agree. */
function applyColors() {
  for (const [name, value] of Object.entries(COLORS)) document.documentElement.style.setProperty('--' + name, value);
}

/** Switch mode: state | incident | replay. args are passed to the mode's enter(). */
async function go(mode, args) {
  if (app.mode) MODES[app.mode].leave();
  app.mode = mode;
  $('#app').dataset.mode = mode;
  for (const btn of document.querySelectorAll('#mode-tabs button')) btn.classList.toggle('on', btn.dataset.mode === mode);
  $('#panel-body').scrollTop = 0;
  app.view.resize();                      // the timeline appears/disappears, so the map changes height
  await MODES[mode].enter(args);
  show3DButtons();
}

/** 2D / 3D: remembered per mode. */
function set3D(on) {
  if (!ONLINE_TILES) return;              // claude.ai version: no terrain tiles, so no 3D (see build_site.py)
  app.want3D[app.mode] = on;
  app.view.set3D(on);
  app.on3DChange?.(on);
  show3DButtons();
}

function show3DButtons() {
  for (const btn of document.querySelectorAll('#dim-toggle button')) btn.classList.toggle('on', (btn.dataset.dim === '3d') === app.view.is3D);
  $('#dim-toggle').classList.toggle('disabled', app.mode === 'state' || !ONLINE_TILES);
  if (!ONLINE_TILES) $('#dim-toggle').title = '3D terrain runs in the full app (app/run.sh); this version is 2D';
}

async function start() {
  applyColors();
  $('#panel-foot').textContent = TEXT.footer;
  setClock('Starting…');

  // config + model name (both small); the app still starts if the model name cannot be read
  try { app.config = await api.getConfig(); }
  catch (e) { app.config = { ai: { provider: 'offline', model: '-' }, archive_examples: [], refresh_s: 300 }; setClock('Backend not reachable', 'idle'); }
  api.getResults().then(r => { app.modelName = r.main_model || app.modelName; }).catch(() => {});
  const ai = app.config.ai || {};
  $('#ai-chip').textContent = `AI: ${ai.provider || '-'} · ${ai.model || '-'}`;
  $('#ai-chip').title = ai.note || ai.switch || '';

  // map (hosted version: 2D only)
  if (!ONLINE_TILES) app.want3D = { incident: false, replay: false };
  app.baseStyle = await loadBaseStyle();
  $('#map-area').classList.toggle('no-basemap', !Object.keys(app.baseStyle.sources).length);   // offline: dark map, light labels
  app.view = new MapView('map-main', structuredClone(app.baseStyle));
  await app.view.ready;
  app.view.on3D = show3DButtons;

  // top bar
  app.go = go; app.set3D = set3D;
  for (const btn of document.querySelectorAll('#mode-tabs button')) btn.addEventListener('click', () => go(btn.dataset.mode));
  for (const btn of document.querySelectorAll('#dim-toggle button')) btn.addEventListener('click', () => { if (app.mode !== 'state') set3D(btn.dataset.dim === '3d'); });
  initResults();
  window.addEventListener('resize', () => app.view.resize());

  initSettings();
  initAssistant(demo);

  // The page opens on STATE with the welcome screen (start the guided demo, or explore).
  // URL #replay / #incident opens another mode without the welcome screen; #demo starts the demo straight away.
  const wanted = location.hash.replace('#', '');
  await go(MODES[wanted] ? wanted : 'state');
  if (wanted === 'demo') demo.start();
  else if (!MODES[wanted]) showWelcome();
}

window.emberline = app;       // handy in the browser console: emberline.view.map, emberline.go('replay')
start();
