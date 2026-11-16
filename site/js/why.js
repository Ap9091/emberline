// why.js - "Why this square?": click any square near a REPLAY fire and the model shows its own reasons.
// The numbers come from whatif_engine.explain: the model is a logistic regression, so each reason is exact
// (coef × scaled input) and the reasons add up to the model's chance. Hosted site only (it uses data/whatif).
import { app } from './app.js';
import { h } from './util.js';
import * as api from './api.js';

const MSG = {
  outside: 'This spot is outside the fire’s 80 km box.',
  far: 'This square is more than 6 km from the fire, so the model does not score it.',
  nofire: 'No fire was seen at this hour, so there is nothing to forecast.',
  water: 'This square is the sea or a lake (90% or more water), so it cannot burn. Emberline gives it no chance.',
  error: '“Why this square?” runs on the replay fires of the hosted site.',
};
let popup = null;

export function closeWhy() {
  if (popup) { const p = popup; popup = null; p.remove(); }
  app.view?.setWhySquare(null);
}

/** Open the reasons for the square at where = {lon, lat} (or {cell}). note = an extra line (e.g. what-if is on). */
export async function showWhy(fireId, hour, where, { note = null } = {}) {
  let e;
  try { e = await api.explainSquare(fireId, hour, where); }
  catch { e = { ok: false, why: 'error' }; }
  closeWhy();
  const at = e.ok ? e.centre : [where.lon, where.lat];
  popup = new maplibregl.Popup({ className: 'why-pop', maxWidth: '300px', offset: 14, focusAfterOpen: false })
    .setLngLat(at).setDOMContent(e.ok ? card(e, note) : h('div', { class: 'why-msg' }, MSG[e.why] || MSG.error)).addTo(app.view.map);
  popup.on('close', () => { if (popup) { popup = null; app.view.setWhySquare(null); } });
  if (e.ok) app.view.setWhySquare(e.square);
  return e;
}

/** Light up one reason row (used by the guided demo). */
export function markReason(key) {
  for (const el of document.querySelectorAll('.why-row')) el.classList.toggle('on', el.dataset.reason === key);
}

function card(e, note) {
  const max = Math.max(...e.reasons.map(r => Math.abs(r.push)), 0.05);
  const pct = x => `${Math.round(x * 100)}%`;
  return h('div', { class: 'why' },
    h('div', { class: 'why-head' }, 'Why this square?'),
    h('div', { class: 'why-p' }, h('b', { class: 'mono' }, pct(e.p)),
      h('span', {}, e.burning ? ' chance it is still burning in 1 hour' : ' chance it burns within the next hour')),
    h('div', { class: 'why-sub' }, `A typical square near a fire: ${pct(e.typical)}. What moved this one:`),
    h('div', { class: 'why-list' }, e.reasons.map(r => h('div', { class: 'why-row ' + (r.push >= 0 ? 'up' : 'down'), 'data-reason': r.key },
      h('span', { class: 'why-label' }, r.label),
      h('span', { class: 'why-bar' }, h('i', { style: `width:${Math.max(4, Math.abs(r.push) / max * 100)}%` })),
      h('span', { class: 'why-n mono' }, (r.push >= 0 ? '+' : '−') + Math.abs(r.push).toFixed(2)),
      h('span', { class: 'why-fact' }, r.fact)))),
    note ? h('div', { class: 'why-note' }, note) : null,
    h('div', { class: 'why-foot' }, 'Exact, not a guess: the model is a weighted sum (logistic regression), so these pushes ',
      'add up to its answer. Red pushes the chance up, blue pushes it down (units: log-odds).'));
}
