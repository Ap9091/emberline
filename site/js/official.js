// ─────────────────────────────────────────────────────────────────────────────
// official.js - "EMBERLINE VS OFFICIAL ORDERS" (REPLAY only).
//
// For every town with a real, published evacuation order or warning (data/evac_orders.csv, one source link
// per row), compare it with the first time Emberline put that town on WARNING or EVACUATE.
// Our time is the END of the satellite hour the forecast was made from (that is when it could have been sent).
// Towns we flagged later, or never, are listed too. If there are no official times yet, nothing is invented.
// ─────────────────────────────────────────────────────────────────────────────
import { h, fmtInt, pacific, fmtHours } from './util.js';
import { section, src, plain, tech } from './panel.js';

export function officialCard(meta, hourIso) {
  const cmp = meta.official_comparison;
  const rows = (meta.timeline || []).filter(t => t.official_order_utc || t.official_warning_utc);
  if (!rows.length) {
    return section('Emberline vs official orders', null,
      h('div', { class: 'empty-line' }, meta.official_orders_note || 'No official evacuation times for this fire yet.'));
  }
  const nowT = hourIso ? new Date(hourIso).getTime() : Infinity;
  const isPast = iso => iso && new Date(iso).getTime() <= nowT;

  // one line per official order / warning, earliest first
  const official = t => [['Warning', t.official_warning_utc], ['Order', t.official_order_utc]]
    .filter(([, iso]) => iso).sort((a, b) => new Date(a[1]) - new Date(b[1]));

  // one compact block per town (a 4-column table does not fit the 400 px panel):
  //   Town                                  +2.4 h earlier
  //   Emberline 07 Jan 19:00 · Order 07 Jan 21:26
  //   10,775 residents · fire reached it      source
  const body = rows.map(t => {
    const lead = t.lead_vs_official_h;
    const verdict = lead === null || lead === undefined
      ? h('span', { class: 'dim' }, t.first_warning_issued_utc ? '-' : 'not flagged')
      : h('span', { class: lead > 0 ? 'lead-early' : 'lead-late' }, lead > 0 ? `${fmtHours(lead)} earlier` : `${fmtHours(-lead).replace('+', '')} later`);
    const ours = t.first_warning_issued_utc
      ? h('span', { class: isPast(t.first_warning_issued_utc) ? '' : 'future' }, h('span', { class: 'kind' }, 'Emberline'), pacific(t.first_warning_issued_utc))
      : h('span', { class: 'dim' }, 'Emberline did not flag it');
    return h('div', { class: 'off-row' },
      h('div', { class: 'off-top' }, h('span', { class: 'town' }, t.town), verdict),
      h('div', { class: 'off-times mono' }, ours,
        official(t).map(([kind, iso]) => h('span', { class: isPast(iso) ? '' : 'future' },
          h('span', { class: 'kind' }, kind), pacific(iso) + (t.official_precision === 'approx' ? ' ≈' : '')))),
      h('div', { class: 'off-sub' },
        h('span', {}, `${fmtInt(t.population)} residents · ` + (t.fire_reached ? 'fire reached it' : 'fire did not reach it')),
        t.official_source_url ? h('a', { href: t.official_source_url, target: '_blank', rel: 'noopener', class: 'srclink' }, 'source') : null));
  });
  const others = (meta.official_other || []).map(o => h('div', { class: 'off-other mono' },
    `${o.town}: ${o.order_type} ${pacific(o.order_time_utc)} `,
    o.source_url ? h('a', { href: o.source_url, target: '_blank', rel: 'noopener', class: 'srclink' }, 'source') : null));

  const summary = cmp ? h('div', { class: 'official-summary' },
    h('div', { class: 'big mono' }, `${cmp.towns_flagged_earlier}/${cmp.towns_compared}`),
    h('div', {},
      h('div', {}, `towns flagged before the first official order or warning`),
      h('div', { class: 'sub' },
        `usually by about ${Math.round(cmp.median_lead_h * 60)} minutes · the fire reached ${cmp.towns_flagged_earlier_and_reached} of them`))) : null;

  return section('Emberline vs official orders', 'public records · PT',
    plain('When Emberline first flagged each town, next to when the real evacuation order or warning came. ',
      '"Earlier" means Emberline was first.'),
    summary,
    h('div', { class: 'off-rows' }, body),
    others.length ? h('div', { class: 'off-others' }, h('div', { class: 'stat-label' }, 'Also published (not in our town list)'), others) : null,
    tech(src('Emberline = first WARNING/EVACUATE, timed at the end of the satellite hour it was made from. Official = first ' +
        'published order/warning for that place (some cover only part of a town). Early flags only help if the fire came. ' +
        'Greyed = not yet happened at the replay time. Each row links to its public source.')));
}
