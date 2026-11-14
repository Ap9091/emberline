// ─────────────────────────────────────────────────────────────────────────────
// api.js - every call to the backend lives here. All URLs are relative (/api/...).
// ─────────────────────────────────────────────────────────────────────────────

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
export const getConfig = () => get('/api/config');
export const getResults = () => get('/api/results');
export const getState = at => get('/api/state' + (at ? `?at=${encodeURIComponent(at)}` : ''));
export const getIncident = id => get(`/api/incident/${encodeURIComponent(id)}`);
export const getReplayList = () => get('/api/replay');
export const getReplayMeta = fireId => get(`/api/replay/${fireId}`);

// Replay hours never change, so keep them in memory: scrubbing back and forth is instant.
const hourCache = new Map();
export function getReplayHour(fireId, hour) {
  const key = `${fireId}/${hour}`;
  if (!hourCache.has(key)) {
    hourCache.set(key, get(`/api/replay/${fireId}/hour/${hour}`).catch(e => { hourCache.delete(key); throw e; }));
  }
  return hourCache.get(key);
}

// ── AI ───────────────────────────────────────────────────────────────────────
// `ref` says which situation the AI should look at:
//   replay:   {mode: 'replay', fire_id, hour}
//   incident: {mode: 'live', incident_id}
export const whatIf = ref => post('/api/whatif', ref);
export const aiBriefing = ref => post('/api/ai/briefing', ref);
export const aiPlan = ref => post('/api/ai/plan', ref);
export const aiAlert = (ref, plan) => post('/api/ai/alert', { ...ref, plan });
export const aiTriage = incidentId => post('/api/ai/triage', { incident_id: incidentId });
