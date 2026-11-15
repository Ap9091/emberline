// verify.js - "WAS IT RIGHT?" (REPLAY only): hindsight check of the forecast.
//
// The forecast made at hour h is compared, square by square, with what GOES-18 really saw burning
// k hours later (k = the "+1/+2/+3 h" picker). Our model is always shown next to the two simple
// baselines, so the score means something:
//   * Grow 1 km/h      - the fire outline grows 1 km every hour
//   * Looks like now   - the fire stays exactly as it is
// Two blocks: THIS HOUR, and SO FAR (every forecast hour of this fire up to now, added together).
//
// F1 (0-1): 1 = every square we forecast burned AND every square that burned was forecast.
// "within 2 km": a square counts as right if real fire was within one square (GOES pixels are 2-4 km).
// "new squares": only squares that had never burned before - the hard, useful part of a forecast.
import { h, fmtInt } from './util.js';
import { section, src, plain, tech } from './panel.js';

const METHODS = [['model', 'Emberline'], ['grow', 'Grow 1 km/h'], ['persistence', 'Looks like now']];

/** F1 from counts {tp, fp, fn, tp_p2, tp_r2}; near = the "within 2 km" version. */
function f1(c, near = false) {
  if (!c) return null;
  const nP = c.tp + c.fp, nR = c.tp + c.fn;
  if (nP === 0 && nR === 0) return null;
  const p = nP ? (near ? c.tp_p2 : c.tp) / nP : 0;
  const r = nR ? (near ? c.tp_r2 : c.tp) / nR : 0;
  return p + r > 0 ? (2 * p * r) / (p + r) : 0;
}

/** Add up the counts of every forecast hour <= `hour` (only hours whose +k truth exists). */
function runningTotals(meta, hour, k) {
  const sum = {};
  let hours = 0;
  for (const row of meta.verification_by_hour || []) {
    if (row.hour_idx > hour) break;
    const v = row.k[k - 1];
    if (!v?.ok) continue;
    hours++;
    for (const [m] of METHODS) {
      if (!v[m]) continue;
      for (const part of ['all', 'new']) {
        const acc = (sum[m] ??= { all: { tp: 0, fp: 0, fn: 0, tp_p2: 0, tp_r2: 0 }, new: { tp: 0, fp: 0, fn: 0, tp_p2: 0, tp_r2: 0 } })[part];
        for (const key in acc) acc[key] += v[m][part][key];
      }
    }
  }
  return { sum, hours };
}

const num = x => (x === null || x === undefined) ? h('span', { class: 'dim' }, '–') : x.toFixed(2);

/** Best value in a column gets a subtle underline (ties: all of them). */
function bestOf(values) {
  const real = values.filter(v => v !== null && v !== undefined);
  return real.length ? Math.max(...real) : null;
}

export function verifyCard({ sit, meta, hour, k, showOnMap, onToggleMap }) {
  const v = sit.verification?.[k - 1];
  const later = meta.hours[Math.min(hour + k, meta.hours.length - 1)]?.time_local?.slice(-5) || '';
  const head = (label, sub) => h('th', {}, label, sub ? h('span', { class: 'th-sub' }, sub) : null);

  if (!sit.verification || !v) {
    return section('Was it right?', 'hindsight', h('div', { class: 'empty-line' }, 'No forecast at this hour, so there is nothing to check.'));
  }
  if (!v.ok) {
    return section('Was it right?', `hindsight · +${k} h`,
      h('div', { class: 'empty-line' }, `No satellite data at ${later} (GOES outage), so this forecast cannot be checked.`));
  }

  const { sum, hours } = runningTotals(meta, hour, k);
  const rows = METHODS.map(([m, label]) => ({
    m, label,
    now: [v[m]?.f1, v[m]?.f1_2km, v[m]?.f1_new],
    soFar: [f1(sum[m]?.all), f1(sum[m]?.new)],
  }));
  const bestNow = [0, 1, 2].map(i => bestOf(rows.map(r => r.now[i])));
  const bestSoFar = [0, 1].map(i => bestOf(rows.map(r => r.soFar[i])));
  const cell = (x, best) => h('td', { class: 'mono' + (x !== null && x !== undefined && best !== null && Math.abs(x - best) < 1e-9 ? ' best' : '') }, num(x));

  const c = v.model.all;
  const made = meta.hours[hour].time_local.slice(-5);
  return section('Was it right?', `GOES-18 at ${later} · +${k} h`,
    plain(`The forecast made at ${made}, checked square by square against what the satellite really saw at ${later}.`),
    h('div', { class: 'verify-counts' },
      h('span', { class: 'vc vc-hit' }, h('i'), `${fmtInt(c.tp)} hit`),
      h('span', { class: 'vc vc-missed' }, h('i'), `${fmtInt(c.fn)} missed`),
      h('span', { class: 'vc vc-false' }, h('i'), `${fmtInt(c.fp)} false alarm`),
      h('button', { class: 'btn btn-small' + (showOnMap ? ' on' : ''), onclick: () => onToggleMap(!showOnMap) },
        showOnMap ? 'Hide on map' : 'Show on map')),
    h('details', { class: 'tech' }, h('summary', {}, 'Scores vs two simple guesses'),
    h('table', { class: 'verify-table' },
      h('thead', {},
        h('tr', {}, h('th', {}), h('th', { colspan: 3, class: 'grp' }, 'This hour'), h('th', { colspan: 2, class: 'grp' }, `So far · ${hours} h`)),
        h('tr', {}, h('th', {}), head('F1'), head('F1', '2 km'), head('F1', 'new'), head('F1'), head('F1', 'new'))),
      h('tbody', {}, rows.map(r => h('tr', { class: r.m === 'model' ? 'ours' : '' },
        h('td', { class: 'method' }, r.label),
        r.now.map((x, i) => cell(x, bestNow[i])),
        r.soFar.map((x, i) => cell(x, bestSoFar[i])))))),
    src(`Score (F1) from 0 to 1, 1 = perfect. "2 km" = a square counts if real fire was within one square (GOES pixels are 2-4 km). ` +
        `"new" = squares that had never burned ("Looks like now" can never score there). Underlined = best.`)));
}
