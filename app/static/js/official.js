// ─────────────────────────────────────────────────────────────────────────────
// official.js - "EMBERLINE VS OFFICIAL ORDERS" (REPLAY only).
//
// For every town with a real, published evacuation order or warning (data/evac_orders.csv, one source link
// per row), compare it with the first time Emberline put that town on WARNING or EVACUATE.
// Our time is the END of the satellite hour the forecast was made from (that is when it could have been sent).
// Towns we flagged later, or never, are listed too. If there are no official times yet, nothing is invented.
// ─────────────────────────────────────────────────────────────────────────────
import { h, fmtInt, pacific, fmtHours } from './util.js';
import { section, src } from './panel.js';

export function officialCard(meta, hourIso) {
  const cmp = meta.official_comparison;
  const rows = (meta.timeline || []).filter(t => t.official_order_utc || t.official_warning_utc);
  if (!rows.length) {
    return section('Emberline vs official orders', null,
      h('div', { class: 'empty-line' }, meta.official_orders_note || 'No official evacuation times for this fire yet.'));
  }
  const nowT = hourIso ? new Date(hourIso).getTime() : Infinity;
  const isPast = iso => iso && new Date(iso).getTime() <= nowT;

  const official = t => {
    const parts = [];
    if (t.official_warning_utc) parts.push(['Warning', t.official_warning_utc]);
    if (t.official_order_utc) parts.push(['Order', t.official_order_utc]);
    parts.sort((a, b) => new Date(a[1]) - new Date(b[1]));
    return parts;
  };

  const body = rows.map(t => {
    const lead = t.lead_vs_official_h;
    const verdict = lead === null || lead === undefined
      ? h('span', { class: 'dim' }, t.first_warning_issued_utc ? '-' : 'not flagged')
      : h('span', { class: lead > 0 ? 'lead-early' : 'lead-late' }, lead > 0 ? `${fmtHours(lead)} earlier` : `${fmtHours(-lead).replace('+', '')} later`);
    return h('tr', {},
      h('td', { class: 'town' }, t.town, h('div', { class: 'sub mono' }, `${fmtInt(t.population)} res.`)),
      h('td', { class: 'mono' + (isPast(t.first_warning_issued_utc) ? '' : ' future') },
        t.first_warning_issued_utc ? pacific(t.first_warning_issued_utc) : h('span', { class: 'dim' }, 'not flagged')),
      h('td', { class: 'mono' },
        official(t).map(([kind, iso]) => h('div', { class: isPast(iso) ? '' : 'future' }, h('span', { class: 'kind' }, kind), ' ', pacific(iso)))),
      h('td', { class: 'mono' }, verdict),
      h('td', {}, t.official_source_url ? h('a', { href: t.official_source_url, target: '_blank', rel: 'noopener', class: 'srclink' }, 'source') : null));
  });

  const summary = cmp ? h('div', { class: 'official-summary' },
    h('div', { class: 'big mono' }, `${cmp.towns_flagged_earlier}/${cmp.towns_compared}`),
    h('div', {},
      h('div', {}, `towns flagged before the first official order or warning`),
      h('div', { class: 'sub mono' },
        `median ${fmtHours(cmp.median_lead_h)} · ${fmtInt(cmp.residents_flagged_earlier)} residents in towns flagged earlier`))) : null;

  return section('Emberline vs official orders', 'public records · Pacific time',
    summary,
    h('table', { class: 'official-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Town'), h('th', {}, 'Emberline'), h('th', {}, 'Official'), h('th', {}, 'Difference'), h('th', {}))),
      h('tbody', {}, body)),
    src('Emberline = first WARNING/EVACUATE, timed at the end of the satellite hour it was made from. Official = first ' +
        'published order/warning for that place (some cover only part of a town). Greyed = not yet happened at the replay time.'));
}
