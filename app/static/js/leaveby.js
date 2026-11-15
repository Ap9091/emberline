// leaveby.js - "leave by" times: when a town should be gone, from the forecast alone.
//
// For each escape road we know whether the forecast fire reaches it within 1, 2 or 3 hours
// (blocked_1h_at_km / blocked_2h_at_km / blocked_3h_at_km, from app/backend/situation.py and whatif_engine.js).
//   road closes within 1 h -> not usable now
//   road closes within k h -> usable for about k-1 hours (to be safe, the earliest end of that hour)
//   road never closes      -> open for at least 3 h (the forecast goes no further)
// A town's leave-by time is the earlier of: when the fire may reach the town (its countdown), and when its best
// road closes. It uses only the forecast: no traffic, no road closures by police, no evacuation zones.
// Pure functions (no page), so tests/test_leaveby.py can run them in Node.

const set = v => v !== null && v !== undefined;

/** Hours until the forecast fire reaches this road: 1, 2, 3, or null (not within the 3-hour forecast). */
export function roadClosesH(o) {
  if (set(o.blocked_1h_at_km)) return 1;
  if (set(o.blocked_2h_at_km)) return 2;
  if (!('blocked_2h_at_km' in o) && set(o.blocked_3h_at_km)) return 2;   // older saved data without the +2 h check: assume the worse
  if (set(o.blocked_3h_at_km)) return 3;
  return null;
}

/** Hours this road can still be used: 0 (already cut), 1, 2, or Infinity (open at least 3 h). */
export const roadUsableH = o => { const k = roadClosesH(o); return k === null ? Infinity : k - 1; };

/** "HH:MM" of the situation clock plus `hours` (situation time_local looks like "Tue 07 Jan 2025 19:00 PST"). */
export function clockPlus(timeLocal, hours) {
  const m = /(\d{1,2}):(\d{2})/.exec(timeLocal || '');
  if (!m) return null;
  const mins = (+m[1] * 60 + +m[2] + Math.round(hours * 60)) % (24 * 60);
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

/**
 * The leave-by advice for one town in a situation.
 * Returns {kind, hours, by, road, text}:
 *   kind 'now'   fire at the town already
 *   kind 'human' every highway out is cut within the hour: a person decides (escort, shelter, local roads)
 *   kind 'by'    leave within `hours` (clock `by`) via `road`
 *   kind 'open'  roads open and fire not expected within 3 h
 */
export function leaveBy(sit, townName) {
  const town = (sit.towns || []).find(t => t.name === townName);
  if (!town || !['EVACUATE', 'WARNING'].includes(town.status)) return null;
  if (town.eta_h === 0) return { kind: 'now', hours: 0, by: null, road: null, text: 'Leave now: the fire is at the town.' };
  const exits = (sit.exits || {})[townName] || [];
  const fireH = set(town.eta_h) ? town.eta_h : Infinity;
  if (!exits.length) {
    const by = clockPlus(sit.time_local, fireH);
    return { kind: 'by', hours: fireH, by, road: null, text: `Leave within ${fireH} h${by ? ` (by ${by})` : ''} by local roads (no highway nearby).` };
  }
  const usable = exits.filter(o => roadUsableH(o) > 0);
  if (!usable.length) {
    return { kind: 'human', hours: 0, by: null, road: null,
             text: 'Every highway out meets the fire within the hour: a person decides (escort, shelter in place, local roads).' };
  }
  // the road that stays open longest (ties: the shorter road)
  const best = usable.slice().sort((a, b) => roadUsableH(b) - roadUsableH(a) || a.length_km - b.length_km)[0];
  const roadH = roadUsableH(best);
  const hours = Math.min(fireH, roadH);
  if (!Number.isFinite(hours)) {
    return { kind: 'open', hours: Infinity, by: null, road: best.id, text: `Roads open for at least 3 h (best: ${best.id}).` };
  }
  const by = clockPlus(sit.time_local, hours);
  const when = `Leave within ${hours} h${by ? ` (by ${by})` : ''}`;
  const text = roadH < fireH
    ? `${when} via ${best.id}, before the fire cuts that road.`
    : `${when}, before the fire may reach the town. Best road: ${best.id} (${roadH === Infinity ? 'open 3 h+' : `open about ${roadH} h`}).`;
  return { kind: 'by', hours, by, road: best.id, text };
}

/** Short label for a road in the exit list. */
export function roadLabel(o) {
  const k = roadClosesH(o);
  if (k === 1) return `fire within 1 h at ${o.blocked_1h_at_km} km`;
  if (k === 2) return `open ~1 h · fire by +2 h at ${o.blocked_2h_at_km} km`;
  if (k === 3) return `open ~2 h · fire by +3 h at ${o.blocked_3h_at_km} km`;
  return 'open 3 h+';
}
