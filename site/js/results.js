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
  fill(drawer, head(), h('div', { class: 'results-body' }, plainSummary(), summary(), mainTable(), perFireTable(), ablationTable(), notes()));
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

/** The results in plain words, with bars, computed from the same numbers as the tables below. */
function plainSummary() {
  const us = data.table[data.main_model], grow = data.table.grow_1km, still = data.table.persistence;
  const pct = v => Math.round((v || 0) * 100);
  const row = (label, v, max, text, ours) => h('div', { class: 'rb-row' + (ours ? ' ours' : '') },
    h('span', { class: 'rb-label' }, label),
    h('span', { class: 'rb-track' }, h('i', { style: `width:${Math.max(1, Math.min(100, (v / max) * 100))}%` })),
    h('span', { class: 'rb-n mono' }, text));
  const group = (title, explain, rows) => h('div', { class: 'rb-group' }, h('div', { class: 'rb-title' }, title), h('div', { class: 'rb-explain' }, explain), rows);
  return h('section', { class: 'res-sec res-plain' }, h('h3', {}, 'In plain words'),
    h('p', { class: 'res-lead' },
      `We tested Emberline on ${data.test_fires.length} California fires from 2024 and 2025 that it never saw while learning. `,
      `It warned ${us.towns_warned} of the ${us.towns_reached} towns the fire reached before it got there, about ${us.mean_lead_h.toFixed(1)} hours early. `,
      `It is better than simple guesses at spotting where new fire will start, but it gives more false alarms, on purpose.`),
    h('div', { class: 'rb-grid' },
      group('Towns warned before the fire arrived', 'Higher is better.', [
        row('Emberline', pct(us.town_recall), 100, `${pct(us.town_recall)}%`, true),
        row('Grows 1 km/h', pct(grow.town_recall), 100, `${pct(grow.town_recall)}%`),
        row('Stays put', pct(still.town_recall), 100, `${pct(still.town_recall)}%`)]),
      group('Spotting new fire', 'Score 0 to 1 for squares that were not burning yet. Higher is better.', [
        row('Emberline', us['F1 new (2km)'], 1, us['F1 new (2km)'].toFixed(2), true),
        row('Grows 1 km/h', grow['F1 new (2km)'], 1, grow['F1 new (2km)'].toFixed(2)),
        row('Stays put', still['F1 new (2km)'] || 0, 1, (still['F1 new (2km)'] || 0).toFixed(2))]),
      group('Fire shape 3 hours ahead', 'How much the forecast and the real fire overlap. Higher is better.', [
        row('Emberline', pct(us['IoU +3h']), 100, `${pct(us['IoU +3h'])}%`, true),
        row('Grows 1 km/h', pct(grow['IoU +3h']), 100, `${pct(grow['IoU +3h'])}%`),
        row('Stays put', pct(still['IoU +3h']), 100, `${pct(still['IoU +3h'])}%`)]),
      group('False alarms per fire-day', 'Town-hours on WARNING where the fire never came. Lower is better.', [
        row('Emberline', us.false_alarms_per_fire_day, 40, us.false_alarms_per_fire_day.toFixed(0), true),
        row('Grows 1 km/h', grow.false_alarms_per_fire_day, 40, grow.false_alarms_per_fire_day.toFixed(0)),
        row('Stays put', still.false_alarms_per_fire_day, 40, still.false_alarms_per_fire_day.toFixed(0))])),
    h('div', { class: 'src' }, '"Stays put" never warns anyone, so it has no false alarms and warns 0 towns. The full numbers are below.'));
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
