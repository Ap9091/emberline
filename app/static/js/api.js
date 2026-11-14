// ─────────────────────────────────────────────────────────────────────────────
// api.js - every call to the backend lives here. All URLs are relative (/api/...).
//
// HOSTED MODE (window.EMBERLINE_STATIC = true, set by the hosted index page made by app/build_site.py):
// there is no Python server, so every answer is read from the JSON files in data/ that the build saved,
// the AI answers come from the saved cache, and "what if the wind changes?" runs in the browser
// (js/whatif_engine.js). The rest of the app does not know the difference.
// ─────────────────────────────────────────────────────────────────────────────
import { loadModel, loadFire, scenario } from './whatif_engine.js';

export const STATIC = !!window.EMBERLINE_STATIC;
const DATA = 'data';
const slug = s => String(s).replace(/[^A-Za-z0-9_-]+/g, '_');

/** Error thrown for a failed request; .status is the HTTP status (0 = network down). */
export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function request(url, options) {
  let res;
  try { res = await fetch(url, options); }
  catch (e) { throw new ApiError(0, 'Server not reachable'); }
  let body = null;
  try { body = await res.json(); } catch { /* no JSON body */ }
  if (!res.ok) {
    const detail = body && (body.detail || body.message);
    const err = new ApiError(res.status, typeof detail === 'string' ? detail : `HTTP ${res.status}`);
    err.body = body;
    throw err;
  }
  return body;
}

const get = url => request(url);
const post = (url, data) => request(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
});

// ── data ─────────────────────────────────────────────────────────────────────
export const getConfig = () => get(STATIC ? `${DATA}/config.json` : '/api/config');
export const getResults = () => get(STATIC ? `${DATA}/results.json` : '/api/results');
export const getState = at => get(STATIC ? `${DATA}/state/${at ? slug(at) : 'live'}.json`
  : '/api/state' + (at ? `?at=${encodeURIComponent(at)}` : ''));
export const getIncident = id => get(STATIC ? `${DATA}/incident/${slug(id)}.json` : `/api/incident/${encodeURIComponent(id)}`);
export const getReplayList = () => get(STATIC ? `${DATA}/replay/list.json` : '/api/replay');
export const getReplayMeta = fireId => get(STATIC ? `${DATA}/replay/${fireId}/meta.json` : `/api/replay/${fireId}`);

// Replay hours never change, so keep them in memory: scrubbing back and forth is instant.
const hourCache = new Map();
export function getReplayHour(fireId, hour) {
  const key = `${fireId}/${hour}`;
  if (!hourCache.has(key)) {
    const url = STATIC ? `${DATA}/replay/${fireId}/${hour}.json` : `/api/replay/${fireId}/hour/${hour}`;
    hourCache.set(key, get(url).catch(e => { hourCache.delete(key); throw e; }));
  }
  return hourCache.get(key);
}

// ── AI ───────────────────────────────────────────────────────────────────────
// `ref` says which situation the AI should look at:
//   replay:   {mode: 'replay', fire_id, hour}
//   incident: {mode: 'live', incident_id}
export const whatIf = ref => STATIC ? staticWhatIf(ref) : post('/api/whatif', ref);
export const aiBriefing = ref => STATIC ? staticAi(ref, 'briefing') : post('/api/ai/briefing', ref);
export const aiPlan = ref => STATIC ? staticAi(ref, 'plan') : post('/api/ai/plan', ref);
export const aiAlert = (ref, plan) => STATIC ? staticAi(ref, 'alert') : post('/api/ai/alert', { ...ref, plan });
export const aiTriage = incidentId => STATIC
  ? get(`${DATA}/ai/triage.json`).then(all => all[incidentId] || Promise.reject(offline('No saved AI line for this incident.')))
  : post('/api/ai/triage', { incident_id: incidentId });

// ── hosted mode helpers ──────────────────────────────────────────────────────
/** The same error the server sends when the AI is unavailable (the copilot shows "AI offline, forecast only"). */
function offline(message) {
  const err = new ApiError(503, message);
  err.body = { status: 'AI_OFFLINE', attempts: [], message };
  return err;
}

/** Saved copilot answers: replay → data/ai/replay_{fire}.json[hour], incidents → data/ai/incidents.json[id]. */
async function staticAi(ref, kind) {
  if (ref.wind_from_deg !== undefined && ref.wind_from_deg !== null) {
    throw offline('Hosted demo: the copilot answers were saved for the real wind only. Press "Real wind", or run the full app for a what-if plan.');
  }
  const rec = ref.mode === 'replay'
    ? (await get(`${DATA}/ai/replay_${ref.fire_id}.json`))[ref.hour]
    : (await get(`${DATA}/ai/incidents.json`))[ref.incident_id];
  if (!rec?.[kind]) {
    throw offline('Hosted demo: no saved AI answer for this moment. Saved copilot runs: Park Fire, the first 30 hours ' +
      '(24 Jul 14:00 to 25 Jul 19:00). Run the full app for new answers.');
  }
  return rec[kind];
}

/** "What if the wind changes?" computed in the browser with the exported model (replay fires only). */
async function staticWhatIf(ref) {
  if (ref.mode !== 'replay') throw new ApiError(501, 'In the hosted demo, what-if runs on the REPLAY fires. Run the full app for live incidents.');
  const [M, F, base] = await Promise.all([loadModel(DATA), loadFire(DATA, ref.fire_id), getReplayHour(ref.fire_id, ref.hour)]);
  // same rounding as the server (5° and 1 km/h steps), so both versions give identical answers
  const sit = scenario(F, M, base, ref.hour, Math.round(ref.wind_from_deg / 5) * 5, Math.round(ref.wind_speed_kmh));
  if (!sit) throw new ApiError(409, 'No forecast at this moment, so there is nothing to re-run.');
  return sit;
}
