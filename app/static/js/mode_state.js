// ─────────────────────────────────────────────────────────────────────────────
// mode_state.js - STATE mode: all of California.
//   map:   every GOES-18 fire pixel + one ringed marker per incident
//   panel: LIVE / archive selector, incident list ranked by triage score, AI "why" line for the top 5
// ─────────────────────────────────────────────────────────────────────────────
import * as api from './api.js';
import { app, setClock, setLoading, setBanner, setToggles, setLegend, segmented } from './app.js';
import { CALIFORNIA_BOUNDS, TRIAGE_AI_TOP_N, TEXT } from './config.js';
import { h, fill, $, fmtInt, fmtKm2, fmt1, utcHM, utcDate, windArrow } from './util.js';
import { section, src } from './panel.js';

const SORTS = [['score', 'Score'], ['people', 'People'], ['growth', 'Growth'], ['area', 'Area']];
const SORT_VALUE = {
  score: i => i.triage_score, people: i => i.people_10km, growth: i => i.growth_km2_last_hour, area: i => i.area_km2,
};

const s = {
  at: null,            // null = LIVE NOW, otherwise the ISO time of an archive example
  data: null,          // last /api/state answer
  loading: false,
  error: null,
  sort: 'score',
  triage: new Map(),   // incident id → {state: 'loading'|'done'|'offline', text}
  refreshTimer: null,
  clockTimer: null,
  loadToken: 0,
};

export const stateMode = {
  enter(args = {}) {
    if (args.at !== undefined) s.at = args.at;
    setToggles(); setLegend('state');
    app.view.showSituation(null);
    app.view.setPlan(null); app.view.setSelectedTown(null);
    app.view.set3D(false, false);
    app.view.fit(CALIFORNIA_BOUNDS, { padding: 30 });
    if (s.data && s.data._at === s.at) { showData(); draw(); }
    load();
    s.clockTimer = setInterval(updateClock, 20000);
  },
  leave() {
    clearTimeout(s.refreshTimer); clearInterval(s.clockTimer);
    s.loadToken++;
    setLoading(null); setBanner(null);
    app.view.clearState();
  },
};

/** Label of an archive example, e.g. "25 Jul 2024, 3:00 PM PDT" */
function archiveExample(at) { return (app.config.archive_examples || []).find(e => e.at === at); }
export function archiveWhen(at) {
  const ex = archiveExample(at);
  return ex ? ex.label.split(' - ').slice(1).join(' - ') : utcDate(at) + ' ' + utcHM(at) + ' UTC';
}

// ── loading ──────────────────────────────────────────────────────────────────
async function load() {
  const token = ++s.loadToken;
  clearTimeout(s.refreshTimer);
  s.loading = true; s.error = null;
  const fresh = !(s.data && s.data._at === s.at);
  if (fresh) { s.data = null; app.view.clearState(); }
  draw();
  if (fresh) setLoading(s.at ? 'Downloading GOES-18 scans from the archive… (about 10 s the first time)' : 'Reading the latest GOES-18 scans…');
  setBanner(s.at ? `ARCHIVE · ${archiveWhen(s.at)} · same pipeline on past GOES-18 data` : null);
  try {
    const data = await api.getState(s.at);
    if (token !== s.loadToken) return;
    data._at = s.at;
    s.data = data;
  } catch (e) {
    if (token !== s.loadToken) return;
    s.error = e.message;
  }
  s.loading = false;
  setLoading(null);
  showData(); draw();
  if (!s.at) s.refreshTimer = setTimeout(load, ((s.data?.refresh_s || app.config.refresh_s || 300)) * 1000);
  loadTriageLines(token);
}

function showData() {
  app.view.showState(s.data, openIncident);
  updateClock();
}

function updateClock() {
  const d = s.data;
  if (!d) return setClock(s.at ? `GOES-18 · ARCHIVE ${archiveWhen(s.at)}` : 'GOES-18 · loading…', s.at ? 'archive' : 'idle');
  if (d.archive) return setClock(`GOES-18 scan ${utcHM(d.scan_time_utc)} UTC · ARCHIVE ${utcDate(d.scan_time_utc)}`, 'archive');
  const age = Math.max(0, Math.round((Date.now() - new Date(d.scan_time_utc)) / 60000));
  setClock(`GOES-18 scan ${utcHM(d.scan_time_utc)} UTC · ${age} min ago`, 'live');
}

function openIncident(inc) {
  app.go('incident', { id: inc.id, at: s.at, label: `near ${inc.nearest_town}` });
}

// ── AI "why it ranks high" lines: top 5, one after the other ─────────────────
async function loadTriageLines(token) {
  const top = (s.data?.incidents || []).slice().sort((a, b) => a.rank - b.rank).slice(0, TRIAGE_AI_TOP_N);
  for (const inc of top) {
    if (s.triage.has(inc.id)) continue;
    s.triage.set(inc.id, { state: 'loading' });
    updateTriageLine(inc.id);
    try {
      const r = await api.aiTriage(inc.id);
      s.triage.set(inc.id, { state: 'done', text: r.text, model: r.model, cached: r.cached });
    } catch (e) {
      s.triage.set(inc.id, { state: 'offline', text: e.status === 503 ? TEXT.aiOffline : `AI line not available (${e.message})` });
    }
    if (token !== s.loadToken) return;
    updateTriageLine(inc.id);
  }
}

function triageLine(id) {
  const t = s.triage.get(id);
  if (!t) return null;
  if (t.state === 'loading') return h('div', { class: 'ai-line' }, h('span', { class: 'ai-tag' }, 'AI'), h('span', { class: 'skel skel-inline' }));
  return h('div', { class: 'ai-line' + (t.state === 'offline' ? ' muted' : ''), title: t.model ? `${t.model}${t.cached ? ' · cached' : ''}` : '' },
    h('span', { class: 'ai-tag' }, 'AI'), h('span', {}, t.text));
}

function updateTriageLine(id) {
  const slot = document.querySelector(`[data-triage="${CSS.escape(id)}"]`);
  if (slot) fill(slot, triageLine(id));
}

// ── drawing the panel ────────────────────────────────────────────────────────
function draw() {
  if (app.mode !== 'state') return;
  fill($('#panel-body'), sourcePicker(), body(), s.data ? howRankingWorks() : null);
}

function sourcePicker() {
  const option = (at, title, sub) => h('button', { class: 'source-opt' + (s.at === at ? ' on' : ''), onclick: () => { if (s.at !== at) { s.at = at; load(); } } },
    h('span', { class: 'radio' }), h('span', { class: 'source-title' }, title), h('span', { class: 'source-sub mono' }, sub));
  return section('Data', 'GOES-18 ABI fire product · every 5 min',
    h('div', { class: 'source-list' },
      option(null, 'LIVE NOW', 'latest scans'),
      (app.config.archive_examples || []).map(ex => {
        const [name, ...when] = ex.label.split(' - ');
        return option(ex.at, name, 'ARCHIVE · ' + when.join(' - '));
      })));
}

function body() {
  const d = s.data;
  if (s.error && !d) return h('div', { class: 'note note-red' }, `Could not load the state view: ${s.error}`,
    h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: load }, 'Try again')));
  if (!d) return section('Incidents', null,
    h('div', { class: 'progress' }, h('span', { class: 'spinner' }), s.at ? 'Downloading GOES-18 scans… finding fire pixels… grouping incidents…' : 'Reading the latest GOES-18 scans…'),
    h('div', { class: 'skeleton-lines' }, [90, 70, 85, 60].map(w => h('div', { class: 'skel', style: `width:${w}%` }))));
  if (!d.incidents.length) return emptyState(d);

  const sorted = d.incidents.slice().sort((a, b) => SORT_VALUE[s.sort](b) - SORT_VALUE[s.sort](a));
  const caption = `GOES-18 · scan ${utcHM(d.scan_time_utc)} UTC · ${d.scans_used} scans`;
  return section(`Incidents · ${d.incidents.length}`, caption,
    h('div', { class: 'sort-row' }, h('span', { class: 'muted' }, 'Sort by'), segmented(SORTS, s.sort, v => { s.sort = v; draw(); })),
    h('div', { class: 'inc-list' }, sorted.map(incidentRow)),
    src('People: Census 2024 within 10 km · Wind: Open-Meteo · click a row to open the incident'));
}

function incidentRow(inc) {
  const growth = inc.growth_km2_last_hour;
  const stat = (label, value, unit) => h('div', { class: 'inc-stat' },
    h('span', { class: 'stat-label' }, label), h('span', { class: 'mono' }, value, unit ? h('span', { class: 'unit' }, unit) : null));
  return h('div', { class: 'inc-row', role: 'button', tabindex: 0, onclick: () => openIncident(inc),
    onkeydown: e => { if (e.key === 'Enter') openIncident(inc); } },
    h('div', { class: 'inc-top' },
      h('span', { class: 'inc-rank mono' }, inc.rank),
      h('span', { class: 'inc-name' }, 'near ', h('b', {}, inc.nearest_town), h('span', { class: 'mono muted' }, ` ${fmt1(inc.nearest_town_km)} km`)),
      h('span', { class: 'inc-score' },
        h('span', { class: 'bar' }, h('span', { class: 'bar-fill', style: `width:${Math.max(2, Math.min(100, inc.triage_score))}%` })),
        h('span', { class: 'mono inc-score-n' }, Math.round(inc.triage_score)))),
    h('div', { class: 'inc-stats' },
      stat('Area', fmtKm2(inc.area_km2), 'km²'),
      stat('Last hour', (growth > 0 ? '+' : '') + fmtKm2(growth), 'km²'),
      stat('People ≤10 km', fmtInt(inc.people_10km)),
      h('div', { class: 'inc-stat' }, h('span', { class: 'stat-label' }, 'Wind'),
        h('span', { class: 'mono wind-inline' }, windArrow(inc.wind?.from_deg, 12), fmtInt(inc.wind?.speed_kmh), h('span', { class: 'unit' }, 'km/h')))),
    h('div', { 'data-triage': inc.id }, triageLine(inc.id)));
}

function emptyState(d) {
  const examples = app.config.archive_examples || [];
  return h('div', { class: 'empty-state' },
    h('div', { class: 'empty-title' }, d.archive ? 'No fires detected at this archive time' : 'No active fires detected in California'),
    h('div', { class: 'empty-text' }, `No active fires detected in California in the latest GOES-18 scans (${utcHM(d.scan_time_utc)} UTC).`),
    src(`GOES-18 · ${d.scans_used} scans checked · next check in ${Math.round((d.refresh_s || 300) / 60)} min`),
    h('div', { class: 'empty-sub' }, 'To see the copilot at work, open a past moment. The same pipeline runs on archived GOES-18 scans:'),
    examples.map((ex, i) => h('button', { class: 'btn btn-block' + (i === 0 ? ' btn-primary' : ''), 'data-archive': ex.at, onclick: () => { s.at = ex.at; load(); } },
      'Open archive: ' + ex.label.split(' - ')[0])));
}

function howRankingWorks() {
  const d = s.data;
  return h('details', { class: 'how' },
    h('summary', {}, 'How ranking works'),
    h('div', { class: 'how-formula mono' }, d.triage_formula),
    h('ul', {}, (d.notes || []).map(n => h('li', {}, n))));
}
