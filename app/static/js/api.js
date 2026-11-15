// api.js - every call to the backend lives here. All URLs are relative (/api/...).
//
// HOSTED MODE (window.EMBERLINE_STATIC = true, set by the hosted index page made by app/build_site.py):
// there is no Python server, so every answer is read from the JSON files in data/ that the build saved,
// the AI answers come from the saved cache, and "what if the wind changes?" runs in the browser
// (js/whatif_engine.js). The rest of the app does not know the difference.
import { loadModel, loadFire, scenario, explain, likelySquareNear } from './whatif_engine.js';

export const STATIC = !!window.EMBERLINE_STATIC;
// Hosted on an ordinary web host (Vercel, GitHub Pages): online map tiles and 3D terrain are allowed.
// On a claude.ai page they are blocked, so that build uses the saved relief images instead.
export const ONLINE_TILES = !STATIC || !!window.EMBERLINE_TILES;
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

// data
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

// AI
// `ref` says which situation the AI should look at:
//   replay:   {mode: 'replay', fire_id, hour}
//   incident: {mode: 'live', incident_id}
export const whatIf = ref => STATIC ? staticWhatIf(ref) : post('/api/whatif', ref);
/** "Why this square?": the model's own reasons for one square of a replay fire, computed in the browser. */
export async function explainSquare(fireId, hour, where) {
  const [M, F] = await Promise.all([loadModel(DATA), loadFire(DATA, fireId)]);
  return explain(F, M, hour, where);
}
/** The forecast square nearest a point (not burning yet, likely to burn within the hour): what the demo explains. */
export async function likelySquare(fireId, hour, lon, lat) {
  const [M, F] = await Promise.all([loadModel(DATA), loadFire(DATA, fireId)]);
  return likelySquareNear(F, M, hour, lon, lat);
}
// sit = the situation on screen: the hosted site sends it to the live copilot when no saved answer exists.
export const aiBriefing = (ref, sit) => STATIC ? staticAi(ref, 'briefing', sit) : post('/api/ai/briefing', ref);
export const aiPlan = (ref, sit) => STATIC ? staticAi(ref, 'plan', sit) : post('/api/ai/plan', ref);
export const aiAlert = (ref, plan, sit) => STATIC ? staticAi(ref, 'alert', sit, plan) : post('/api/ai/alert', { ...ref, plan });
export const aiTriage = incidentId => STATIC
  ? get(`${DATA}/ai/triage.json`).then(all => all[incidentId] || Promise.reject(offline('No saved AI line for this incident.')))
  : post('/api/ai/triage', { incident_id: incidentId });

// hosted mode helpers
/** The same error the server sends when the AI is unavailable (the copilot shows "AI offline, forecast only"). */
function offline(message) {
  const err = new ApiError(503, message);
  err.body = { status: 'AI_OFFLINE', attempts: [], message };
  return err;
}

/**
 * Hosted copilot ("hybrid"):
 *   1. a SAVED answer if there is one (replay → data/ai/replay_{fire}.json[hour], incidents → data/ai/incidents.json[id]).
 *      These are real runs recorded earlier with Gemini, including the Park Fire plan the safety check rejected.
 *   2. otherwise the LIVE copilot: POST api/copilot (Vercel function, Claude Sonnet 5.5, the same code safety check).
 *      Used for every other hour and for what-if winds. On a page with no server (claude.ai) it says "AI offline".
 */
async function staticAi(ref, kind, sit, plan) {
  const whatIfWind = ref.wind_from_deg !== undefined && ref.wind_from_deg !== null;
  if (!whatIfWind) {
    const rec = ref.mode === 'replay'
      ? (await get(`${DATA}/ai/replay_${ref.fire_id}.json`).catch(() => ({})))[ref.hour]
      : (await get(`${DATA}/ai/incidents.json`).catch(() => ({})))[ref.incident_id];
    if (rec?.[kind] && (kind !== 'alert' || !plan || samePlan(rec.plan?.plan, plan))) return rec[kind];
  }
  if (!ONLINE_TILES || !sit) throw offline('No saved AI answer for this moment, and the live AI only runs on the hosted site.');
  if (kind !== 'alert' && !liveAllowed()) throw offline('You have used this visit\'s live copilot runs. Saved answers still work.');
  const body = { kind, sit: compactSit(sit), plan };
  return request('api/copilot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .catch(e => { if ([0, 404, 405, 501].includes(e.status)) throw offline('AI offline, forecast only.'); throw e; });
}

const samePlan = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Only what the copilot reads (keeps the request small: no map layers). */
function compactSit(s) {
  return { name: s.name, time_local: s.time_local, numbers: s.numbers, wind: s.wind, towns: s.towns, exits: s.exits };
}

const LIVE_RUNS = 20;           // live briefings + plans per browser session (the account credit is the real cap)
function liveAllowed() {
  try {
    const n = +sessionStorage.getItem('emberline-copilot-n') || 0;
    if (n >= LIVE_RUNS) return false;
    sessionStorage.setItem('emberline-copilot-n', String(n + 1));
  } catch { /* private mode: no counter */ }
  return true;
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
