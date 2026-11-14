// ─────────────────────────────────────────────────────────────────────────────
// app.js - the shared "app" object: things every mode needs (the map, the config, the top-bar clock,
// the loading pill, the archive banner, the legend). main.js fills it in at start-up.
// ─────────────────────────────────────────────────────────────────────────────
import { h, fill, $ } from './util.js';

export const app = {
  config: null,        // /api/config
  modelName: 'logreg', // main model name from /api/results
  view: null,          // main MapView
  baseStyle: null,     // muted base style (re-used by the split-screen map)
  mode: null,          // 'state' | 'incident' | 'replay'
  want3D: {},          // remembered 2D/3D choice per mode
  go: null,            // go(mode, args) - set by main.js
  on3DChange: null,    // set by the active mode if it wants to hear about the 2D/3D toggle
};

// ── top-bar clock chip ───────────────────────────────────────────────────────
/** kind: 'live' (green dot) | 'archive' (amber dot) | 'idle' (grey dot) */
export function setClock(text, kind = 'idle') {
  $('#clock-text').textContent = text;
  $('#clock-chip').dataset.kind = kind;
}

// ── loading pill on the map ──────────────────────────────────────────────────
export function setLoading(text) {
  $('#map-loading').hidden = !text;
  $('#map-loading-text').textContent = text || '';
}

// ── amber archive banner on top of the map ───────────────────────────────────
export function setBanner(text) {
  const el = $('#map-banner');
  el.hidden = !text;
  el.textContent = text || '';
}

// ── layer toggle card (top-left of the map) ──────────────────────────────────
export function setToggles(...children) {
  const el = $('#layer-toggles');
  el.hidden = !children.length;
  fill(el, children);
}

/** A checkbox row for the layer card. swatch = css class of the little colour sample. */
export function toggleRow(label, checked, onChange, swatch) {
  const input = h('input', { type: 'checkbox', onchange: () => onChange(input.checked) });
  input.checked = checked;
  return h('label', { class: 'toggle-row' }, input, swatch ? h('span', { class: 'sw ' + swatch }) : null, h('span', {}, label));
}

/** A small segmented control: segmented([['1','+1 h'],...], current, onPick) */
export function segmented(options, current, onPick, cls = '') {
  const el = h('div', { class: 'seg ' + cls });
  const draw = value => fill(el, options.map(([v, label]) =>
    h('button', { class: v === value ? 'on' : '', onclick: () => { draw(v); onPick(v); } }, label)));
  draw(current);
  return el;
}

// ── legend (bottom-left of the map) ──────────────────────────────────────────
const LEGENDS = {
  state: [['sw sw-pixel', 'GOES-18 fire pixel'], ['sw sw-incident', 'Incident (ring size = area, number = rank)']],
  situation: [
    ['sw sw-fire', 'Fire now'], ['sw sw-forecast', 'Forecast squares (darker = more likely)'],
    ['sw sw-ring1', 'Forecast edge +1 h'], ['sw sw-ring2', '+2 h'], ['sw sw-ring3', '+3 h'],
    ['sw sw-town', 'Town: evacuate / warning / monitor'],
    ['sw sw-exit', 'Exit: clear / fire within 1 h'],
  ],
  replayExtra: [['sw sw-baseline', 'Baseline: grow 1 km/h'], ['sw sw-actual', 'Real fire later (hindsight)']],
  verify: [['sw sw-hit', 'Hit: forecast fire, real fire came'], ['sw sw-missed', 'Missed: real fire, not forecast'],
    ['sw sw-false', 'False alarm: forecast fire, none came'], ['sw sw-town', 'Town: evacuate / warning / monitor']],
};

export function setLegend(kind) {
  const rows = kind === 'state' ? LEGENDS.state : kind === 'replay' ? [...LEGENDS.situation, ...LEGENDS.replayExtra]
    : kind === 'replayVerify' ? LEGENDS.verify : LEGENDS.situation;
  fill($('#legend'), h('div', { class: 'card-title' }, 'Legend'), rows.map(([sw, label]) => h('div', { class: 'legend-row' }, h('span', { class: sw }), h('span', {}, label))));
}
