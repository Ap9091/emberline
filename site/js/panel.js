// ─────────────────────────────────────────────────────────────────────────────
// panel.js - the "situation" part of the side panel, shared by INCIDENT and REPLAY:
//   header · wind card · numbers · town countdowns
// The AI part (briefing, plan, alert, event log) is in copilot.js.
// ─────────────────────────────────────────────────────────────────────────────
import { h, fill, fmtInt, fmtKm2, fmt1, fmtPct, utcHM, localHMZone, compass, windArrow } from './util.js';
import { leaveBy, roadClosesH, roadLabel } from './leaveby.js';

/** A panel section: small-caps title, optional source caption on the right, then the content. */
export function section(title, caption, ...body) {
  return h('section', { class: 'sec' },
    h('div', { class: 'sec-head' }, h('h3', {}, title), caption ? h('span', { class: 'src' }, caption) : null),
    ...body);
}

/** Small mono caption that says where a number comes from. */
export const src = text => h('div', { class: 'src' }, text);

/** One plain-English sentence under a section title: what this card shows. */
export const plain = (...text) => h('p', { class: 'plain' }, ...text);

/** Technical detail folded away behind a small "Details" toggle (model names, cut-offs, scores). */
export const tech = (...body) => h('details', { class: 'tech' }, h('summary', {}, 'Details'), ...body);

// ── source captions (every number shows its source and time) ─────────────────
function fireSource(sit) {
  return sit.scan_time_utc ? `GOES-18 · scan ${utcHM(sit.scan_time_utc)} UTC` : `GOES-18 hourly · ${localHMZone(sit.time_local)}`;
}
function windSource(sit) {
  const historical = sit.mode === 'replay' || sit.archive;
  return `Open-Meteo ${historical ? 'ERA5' : 'forecast'} · ${localHMZone(sit.time_local)}`;
}

// ── 1. header ────────────────────────────────────────────────────────────────
export function headerCard(sit, tag) {
  return h('div', { class: 'sit-head' },
    h('div', { class: 'sit-title' },
      h('h2', {}, sit.name),
      tag ? h('span', { class: 'tag tag-archive' }, tag) : null),
    h('div', { class: 'sit-time mono' }, sit.time_local),
    sit.data_note ? h('div', { class: 'sit-note' }, sit.data_note) : null);
}

// ── 2. wind card ─────────────────────────────────────────────────────────────
export function windCard(sit) {
  const w = sit.wind || {};
  const to = ((w.from_deg ?? 0) + 180) % 360;
  const stat = (label, value, unit) => h('div', { class: 'stat' },
    h('div', { class: 'stat-label' }, label),
    h('div', { class: 'stat-value mono' }, value, unit ? h('span', { class: 'unit' }, unit) : null));
  return section('Wind', windSource(sit),
    h('div', { class: 'wind-card' },
      h('div', { class: 'wind-dial', title: `Wind blows toward ${compass(to)} (from ${w.from_deg}°)` }, windArrow(w.from_deg, 30),
        h('div', { class: 'wind-dir mono' }, `to ${compass(to)}`)),
      h('div', { class: 'wind-stats' },
        stat('Speed', fmt1(w.speed_kmh), 'km/h'),
        stat('Gusts', fmt1(w.gust_kmh), 'km/h'),
        stat('Humidity', fmtInt(w.humidity_pct), '%'),
        stat('Temp', fmt1(w.temp_c), '°C'))));
}

// ── 3. numbers ───────────────────────────────────────────────────────────────
export function numbersCard(sit, modelName) {
  const n = sit.numbers || {};
  const fc = n.forecast_area_km2 || [];
  const cut = sit.thresholds?.squares;
  const growth = n.growth_last_hour_km2;
  const tile = (label, value, unit, cls = '') => h('div', { class: 'tile ' + cls },
    h('div', { class: 'stat-label' }, label),
    h('div', { class: 'tile-value mono' }, value, h('span', { class: 'unit' }, unit)));
  return section('Fire size', fireSource(sit),
    h('div', { class: 'tiles five' },
      tile('Burning now', fmtKm2(n.fire_area_km2), 'km²'),
      tile('Last hour', (growth > 0 ? '+' : growth < 0 ? '−' : '') + fmtKm2(Math.abs(growth ?? 0)), 'km²'),
      [1, 2, 3].map(k => tile(`In ${k} h`, fc.length ? fmtKm2(fc[k - 1]) : '-', 'km²', 'tile-small'))),
    plain('How much land is burning now, and how much our model expects to be burning in 1, 2 and 3 hours.'),
    tech(src(`Forecast model: ${modelName || 'logreg'} (logistic regression)` +
      (cut ? ` · a square counts as burning at chance ≥ ${cut.burn} (already burning) / ≥ ${cut.new} (new)` : '') + ' · 1 km² ≈ 250 acres')));
}

// ── 4. town countdowns ───────────────────────────────────────────────────────
const ETA_TEXT = { 0: 'fire at town', 1: 'fire in < 1 h', 2: 'fire in ~2 h', 3: 'fire in ~3 h' };

export function etaText(t) {
  return t.eta_h === null || t.eta_h === undefined ? `${fmt1(t.dist_km)} km from fire` : ETA_TEXT[t.eta_h] || `fire in ~${t.eta_h} h`;
}

function exitRows(sit, town) {
  const exits = sit.exits?.[town] || [];
  const lb = leaveBy(sit, town);
  const advice = lb ? h('div', { class: 'leave-by lb-' + lb.kind }, lb.text) : null;
  if (!exits.length) return h('div', { class: 'exit-list' }, advice, h('div', { class: 'exit-row muted' }, 'No highway exit near this town (local roads only).'));
  return h('div', { class: 'exit-list' }, advice,
    exits.map(e => h('div', { class: 'exit-row' + (roadClosesH(e) === 1 ? ' blocked' : roadClosesH(e) ? ' closing' : '') },
      h('span', { class: 'exit-swatch' }),
      h('span', { class: 'exit-name' }, e.id),
      h('span', { class: 'mono exit-len' }, `${fmt1(e.length_km)} km`),
      h('span', { class: 'mono exit-state' }, roadLabel(e)))),
    src('Roads: Census TIGER 2024 · checked against the fire now and the +1, +2, +3 h forecast · traffic not included'));
}

/** Small "leave by 20:00" line under a town's countdown. */
function leaveTag(sit, t) {
  const lb = leaveBy(sit, t.name);
  if (!lb) return null;
  const text = lb.kind === 'now' ? 'leave now' : lb.kind === 'human' ? 'no clear road' : lb.kind === 'open' ? 'roads open 3 h+'
    : `leave by ${lb.by || `+${lb.hours} h`}`;
  return h('span', { class: 'town-leave lb-' + lb.kind }, text);
}

function townRow(sit, t, selected, onSelect) {
  const row = h('button', { class: 'town-row' + (selected ? ' selected' : ''), 'data-status': t.status, onclick: () => onSelect(selected ? null : t.name) },
    h('span', { class: 'chip-status', 'data-status': t.status }, t.status),
    h('span', { class: 'town-name' }, t.name),
    h('span', { class: 'town-eta' }, etaText(t), leaveTag(sit, t)),
    h('span', { class: 'town-meta mono' },
      h('span', { title: 'Residents (Census)' }, fmtInt(t.population)),
      h('span', { title: 'Chance that fire reaches the town within 3 h (model)' }, fmtPct(t.chance_3h)),
      h('span', { title: 'Distance from the fire edge' }, `${fmt1(t.dist_km)} km`)));
  return selected ? [row, exitRows(sit, t.name)] : [row];
}

/**
 * Town list. EVACUATE and WARNING towns are always shown; MONITOR towns are folded away.
 * ui = {selected, showMonitor} is kept by the caller so it survives re-draws while the replay plays.
 */
export function townsCard(sit, modelName, ui, onSelect, onToggleMonitor) {
  const towns = sit.towns || [];
  const urgent = towns.filter(t => t.status !== 'MONITOR');
  const monitor = towns.filter(t => t.status === 'MONITOR');
  const n = sit.numbers || {};
  const cut = sit.thresholds?.town_warning;

  const summary = h('div', { class: 'town-summary mono' },
    h('span', { class: 'sum', 'data-status': 'EVACUATE' }, h('b', {}, fmtInt(n.residents_evacuate)), ' residents EVACUATE'),
    h('span', { class: 'sum', 'data-status': 'WARNING' }, h('b', {}, fmtInt(n.residents_warning)), ' WARNING'));
  const head = h('div', { class: 'town-cols' }, h('span', {}, 'Status'), h('span', {}, 'Town'), h('span', {}, ''),
    h('span', { class: 'town-meta' }, h('span', {}, 'People'), h('span', {}, 'Chance'), h('span', {}, 'Dist.')));

  const rows = urgent.flatMap(t => townRow(sit, t, ui.selected === t.name, onSelect));
  if (!urgent.length) rows.push(h('div', { class: 'empty-line' }, towns.length ? 'No town on WARNING or EVACUATE at this time.' : 'No town within 20 km of the fire.'));
  if (monitor.length) {
    const open = ui.showMonitor || monitor.some(t => t.name === ui.selected);
    rows.push(h('button', { class: 'fold', onclick: onToggleMonitor },
      h('span', { class: 'fold-arrow' }, open ? '▾' : '▸'), `${monitor.length} town${monitor.length > 1 ? 's' : ''} on MONITOR (fire within 20 km)`));
    if (open) rows.push(...monitor.flatMap(t => townRow(sit, t, ui.selected === t.name, onSelect)));
  }
  return section('Town countdowns', 'Census 2024 + our forecast',
    plain(h('b', {}, 'EVACUATE'), ': fire is there or expected within 1 hour. ', h('b', {}, 'WARNING'),
      ': it could get there within 3 hours. Click a town to see its roads out.'),
    summary, head, h('div', { class: 'town-list' }, rows),
    tech(src(`People = residents (Census 2024). Chance = the model's highest chance of fire on any 2 km square within 1 km of the town in the next 3 h. ` +
      `WARNING from a chance of ${cut ?? '-'} up (set on past fires, so few towns are missed). Model: ${modelName || 'logreg'}.`)));
}

// ── the whole situation block ────────────────────────────────────────────────
/**
 * Keeps the situation sections in one container and re-draws them for each new situation.
 *   const sp = new SituationPanel(container, {modelName, onTownSelect});
 *   sp.update(sit, 'ARCHIVE');
 */
export class SituationPanel {
  constructor(container, { modelName, onTownSelect }) {
    this.container = container;
    this.modelName = modelName;
    this.onTownSelect = onTownSelect;
    this.ui = { selected: null, showMonitor: false };
    this.sit = null;
    this.tag = null;
  }

  update(sit, tag = null) {
    this.sit = sit; this.tag = tag;
    if (this.ui.selected && !(sit.towns || []).some(t => t.name === this.ui.selected)) this.ui.selected = null;
    this.draw();
  }

  /** Select a town (from the list or from the map). null = nothing selected. */
  select(name) {
    this.ui.selected = name;
    this.draw();
    this.onTownSelect?.(name ? this.sit.towns.find(t => t.name === name) : null);
  }

  draw() {
    const sit = this.sit;
    if (!sit) return fill(this.container);
    fill(this.container,
      headerCard(sit, this.tag),
      windCard(sit),
      numbersCard(sit, this.modelName),
      townsCard(sit, this.modelName, this.ui, name => this.select(name),
        () => { this.ui.showMonitor = !this.ui.showMonitor; this.draw(); }));
  }
}
