// ─────────────────────────────────────────────────────────────────────────────
// results.js - the Results drawer: test scores from /api/results, shown plainly (weak ones too).
// ─────────────────────────────────────────────────────────────────────────────
import * as api from './api.js';
import { h, fill, $, fmtInt } from './util.js';

// The three methods compared in the test, in the order they are shown.
const METHODS = [
  ['persistence', 'Looks like now', 'fire stays where it is'],
  ['grow_1km', 'Grow 1 km/h', 'simple rule: every edge moves 1 km per hour'],
];

// Columns of the main table: [key in the API, header, digits, which direction is better]
const COLUMNS = [
  ['town_recall', 'Towns warned', 'pct', 'high'],
  ['mean_lead_h', 'Lead time', 'h', 'high'],
  ['false_alarms_per_fire_day', 'False alarms / fire-day', 1, 'low'],
  ['F1 new', 'F1 new squares', 2, 'high'],
  ['F1 new (2km)', 'F1 new, within 2 km', 2, 'high'],
  ['IoU +1h', 'IoU +1 h', 2, 'high'],
  ['IoU +2h', 'IoU +2 h', 2, 'high'],
  ['IoU +3h', 'IoU +3 h', 2, 'high'],
];

let data = null;

export function initResults() {
  $('#results-btn').addEventListener('click', openResults);
  $('#results-backdrop').addEventListener('click', closeResults);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeResults(); });
}

async function openResults() {
  const drawer = $('#results-drawer');
  drawer.hidden = false; $('#results-backdrop').hidden = false;
  requestAnimationFrame(() => drawer.classList.add('open'));
  if (!data) {
    fill(drawer, head(), h('div', { class: 'progress' }, h('span', { class: 'spinner' }), 'Loading test results…'));
    try { data = await api.getResults(); }
    catch (e) { return fill(drawer, head(), h('div', { class: 'note note-red' }, `Could not load results: ${e.message}`)); }
  }
  fill(drawer, head(), h('div', { class: 'results-body' }, summary(), mainTable(), perFireTable(), ablationTable(), notes()));
}

function closeResults() {
  const drawer = $('#results-drawer');
  drawer.classList.remove('open');
  drawer.hidden = true; $('#results-backdrop').hidden = true;
}

function head() {
  return h('div', { class: 'results-head' },
    h('div', {}, h('h2', {}, 'Test results'),
      h('div', { class: 'src' }, data ? `${data.test_fires.length} unseen California fires, 2024-2025 · main model: ${data.main_model} · town cut-off ${data.town_threshold}` : '')),
    h('button', { class: 'btn', id: 'results-close', onclick: closeResults }, 'Close'));
}

function summary() {
  return h('section', { class: 'res-sec' }, h('h3', {}, 'Summary'),
    h('ol', { class: 'res-summary' }, data.summary.map(line => h('li', {}, line.replace(/^\d+\.\s*/, '')))));
}

function cell(value, digits) {
  if (value === null || value === undefined) return '-';
  if (digits === 'pct') return Math.round(value * 100) + '%';
  if (digits === 'h') return Number(value).toFixed(1) + ' h';
  return Number(value).toFixed(digits);
}

/** Main table: one row per method, best value in each column marked. */
function mainTable() {
  const methods = [...METHODS, [data.main_model, `Emberline (${data.main_model})`, 'our model']];
  const rows = methods.map(([key]) => data.table[key]);
  const best = COLUMNS.map(([key, , , dir]) => {
    const vals = rows.map(r => r?.[key]).filter(v => v !== null && v !== undefined);
    return vals.length ? (dir === 'high' ? Math.max(...vals) : Math.min(...vals)) : null;
  });
  return h('section', { class: 'res-sec' }, h('h3', {}, 'All test fires together'),
    h('table', { class: 'res-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Method'), COLUMNS.map(([, label]) => h('th', { class: 'num' }, label)))),
      h('tbody', {}, methods.map(([key, name, sub], i) => {
        const r = rows[i] || {};
        return h('tr', { class: key === data.main_model ? 'ours' : '' },
          h('td', {}, h('div', { class: 'method' }, name), h('div', { class: 'method-sub' }, sub)),
          COLUMNS.map(([col, , digits], c) => h('td', { class: 'num mono' + (r[col] !== null && r[col] !== undefined && r[col] === best[c] ? ' best' : '') },
            cell(r[col], digits),
            col === 'town_recall' ? h('div', { class: 'cell-sub' }, `${fmtInt(r.towns_warned)} of ${fmtInt(r.towns_reached)}`) : null)));
      }))),
    h('div', { class: 'src' }, 'Underlined = best in that column. "Looks like now" gives no warnings, so it has no false alarms and no lead time. ' +
      'False alarms = town-hours on WARNING for towns the fire did not reach. IoU = overlap of forecast and real fire area. ' +
      `Square cut-offs: ${data.square_thresholds.burn} burning / ${data.square_thresholds.new} new.`));
}

function perFireTable() {
  const m = data.main_model;
  const name = id => id.replace(/_/g, ' ').replace(/\b(20\d\d)$/, '· $1').replace(/^./, c => c.toUpperCase());
  const cols = [[`${m}: towns warned`, 'Towns warned'], [`${m}: false alarms`, 'False alarms'], [`${m}: F1 new (2km)`, 'F1 new (2 km)'], [`${m}: IoU +3h`, 'IoU +3 h'],
    ['grow_1km: towns warned', 'Towns warned'], ['grow_1km: false alarms', 'False alarms'], ['grow_1km: F1 new (2km)', 'F1 new (2 km)'], ['grow_1km: IoU +3h', 'IoU +3 h'],
    ['persistence: IoU +3h', 'IoU +3 h']];
  const fmt = v => typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(2) : v;
  return h('section', { class: 'res-sec' }, h('h3', {}, 'Each test fire'),
    h('div', { class: 'res-scroll' }, h('table', { class: 'res-table res-small' },
      h('thead', {},
        h('tr', {}, h('th', { rowspan: 2 }, 'Fire'), h('th', { class: 'num', rowspan: 2 }, 'Hours'),
          h('th', { class: 'group ours', colspan: 4 }, `Emberline (${m})`), h('th', { class: 'group', colspan: 4 }, 'Grow 1 km/h'), h('th', { class: 'group', colspan: 1 }, 'Looks like now')),
        h('tr', {}, cols.map(([, label], i) => h('th', { class: 'num' + (i < 4 ? ' ours' : '') }, label)))),
      h('tbody', {}, data.per_fire.map(f => h('tr', {},
        h('td', {}, name(f.fire)), h('td', { class: 'num mono' }, f['fire-hours']),
        cols.map(([key], i) => h('td', { class: 'num mono' + (i < 4 ? ' ours' : '') }, fmt(f[key])))))))),
    h('div', { class: 'src' }, 'Towns warned = warned before arrival / reached by fire. False alarms in town-hours.'));
}

function ablationTable() {
  if (!data.ablation) return null;
  const keys = Object.keys(Object.values(data.ablation)[0] || {});
  return h('section', { class: 'res-sec' }, h('h3', {}, 'What each input adds (PR-AUC)'),
    h('table', { class: 'res-table res-small' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Inputs'), keys.map(k => h('th', { class: 'num' }, k)))),
      h('tbody', {}, Object.entries(data.ablation).map(([name, row]) =>
        h('tr', {}, h('td', {}, name), keys.map(k => h('td', { class: 'num mono' }, Number(row[k]).toFixed(3))))))));
}

function notes() {
  return h('section', { class: 'res-sec' }, h('h3', {}, 'Notes'),
    h('ul', { class: 'res-notes' }, data.notes.map(n => h('li', {}, n))));
}
