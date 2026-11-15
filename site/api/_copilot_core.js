// copilot_core.js - the copilot for the hosted site, ported line by line from app/backend/copilot.py and
// app/backend/situation.py (ai_context). Used by the Vercel function site/api/copilot.js (copied there as
// site/api/_copilot_core.js by app/build_site.py). tests/test_copilot_parity.py checks that the safety check and the
// AI context give exactly the same answers as the Python code.
//
// The SAFETY CHECK is plain code, no AI. A plan is REJECTED if:
//   1. a town on EVACUATE is not being evacuated, or
//   2. an evacuation route runs into the fire now or the +1 h forecast fire, or
//   3. it names a town or exit that does not exist.
// If every highway exit of a town runs into the fire, that town goes to a human decision instead.

export const MAX_RETRIES = 2;
export const ALERT_MAX = 360;
export const NO_CLEAR_EXIT = 'No clear highway exit - human decision';
export const SYSTEM =
  'You are Emberline, an AI copilot for a California wildfire incident commander or county emergency manager. ' +
  'You write short, calm, factual text for professionals. Use ONLY the facts and numbers in the data you are ' +
  'given; never invent numbers, places, roads or resources. Times are local Pacific time. ' +
  'A human makes every decision; you draft and recommend.';

const fmtPop = n => Number(n).toLocaleString('en-US');

/** Compact facts for the AI. Exits are listed WITHOUT the blocked flags: checking roads is the safety check's job. */
export function aiContext(sit) {
  return {
    fire: sit.name, time_local: sit.time_local, numbers: sit.numbers, wind: sit.wind,
    towns: (sit.towns || []).filter(t => ['EVACUATE', 'WARNING', 'MONITOR'].includes(t.status)).slice(0, 15)
      .map(t => Object.fromEntries(['name', 'status', 'eta_h', 'dist_km', 'chance_3h', 'population', 'bearing_from_fire']
        .map(k => [k, t[k] === undefined ? null : t[k]]))),
    exits: Object.fromEntries(Object.entries(sit.exits || {}).map(([town, opts]) =>
      [town, opts.map(o => ({ id: o.id, direction: o.direction, length_km: o.length_km }))])),
    notes: 'Forecast from a model trained on GOES satellite fire pixels (2-4 km). EVACUATE = fire at the town or ' +
           'forecast within 1 h; WARNING = forecast within 3 h; MONITOR = fire within 20 km.',
  };
}

export function safetyCheck(plan, sit) {
  const reasons = [], human = [];
  const towns = Object.fromEntries((sit.towns || []).map(t => [t.name, t]));
  const evac = plan?.evacuate ?? [];
  if (!Array.isArray(evac)) return [["'evacuate' must be a list"], human];
  const names = evac.filter(e => e && typeof e === 'object' && !Array.isArray(e)).map(e => e.town);
  for (const t of sit.towns || []) {
    if (t.status === 'EVACUATE' && !names.includes(t.name)) {
      const when = t.eta_h === 0 ? 'is already at the town' : 'is forecast within 1 hour';
      reasons.push(`${t.name} (${fmtPop(t.population)} residents): fire ${when}, but the plan does not evacuate it.`);
    }
  }
  for (const e of evac) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      reasons.push('each evacuation entry must be an object with town and exit');
      continue;
    }
    const town = e.town, exitId = String(e.exit || '').trim();
    if (!(town in towns)) { reasons.push(`'${town}' is not a town in this situation.`); continue; }
    const opts = (sit.exits || {})[town] || [];
    const options = Object.fromEntries(opts.map(o => [o.id.toLowerCase(), o]));
    if (!opts.length) continue;                       // no highway near this town: local roads, nothing to check
    const clear = opts.filter(x => x.blocked_1h_at_km === null || x.blocked_1h_at_km === undefined);
    if (!clear.length) {
      human.push(`${town}: every highway exit runs into the fire or the +1 h forecast fire. ` +
                 'No clear route: human decision needed (escort, shelter in place, or local roads).');
      continue;
    }
    const o = options[exitId.toLowerCase()];
    if (!o) reasons.push(`Exit '${exitId}' is not one of ${town}'s exits (${Object.values(options).map(x => x.id).join(', ')}).`);
    else if (o.blocked_1h_at_km !== null && o.blocked_1h_at_km !== undefined) {
      reasons.push(`${o.id} from ${town} runs into the fire or the +1 h forecast fire ${pyNum(o.blocked_1h_at_km)} km from town.`);
    }
  }
  return [reasons, human];
}

/** Python prints 4.0 as "4.0"; JavaScript prints 4. Keep the messages identical. */
function pyNum(x) { return Number.isInteger(x) ? x.toFixed(1) : String(x); }

export function briefingPrompt(sit) {
  return "Write the situation briefing for the incident commander: 4-6 short lines, each starting with '- '. " +
    'Cover: fire size and growth, wind and humidity, which towns are EVACUATE / WARNING (with time to ' +
    'fire and residents), and one line on forecast limits (satellite pixels are 2-4 km; smoke and night ' +
    'can hide fire). Use only these facts:\n' + JSON.stringify(aiContext(sit));
}

export function planPrompt(sit, feedback) {
  const rules =
    'Recommend an evacuation plan as JSON with exactly these keys:\n' +
    '{"evacuate": [{"town": "<name>", "exit": "<exit id copied exactly from that town\'s exits list>", ' +
    '"reason": "<max 15 words>"}], "warn": ["<town>", ...], "summary": "<one sentence for the commander>"}\n' +
    "Rules: every EVACUATE town must be in 'evacuate'. WARNING towns go in 'warn' (or 'evacuate' if you judge it " +
    'necessary). For each evacuated town choose ONE exit from ITS exits list, copying the id exactly. Prefer exits ' +
    "that lead AWAY from the fire (towns list 'bearing_from_fire' = direction from the fire to the town, so an exit " +
    'in that same direction leads away) and not downwind. If a town has no exits listed, use "local roads".';
  let prompt = rules + '\n\nSituation:\n' + JSON.stringify(aiContext(sit));
  if (feedback) {
    prompt += '\n\nYOUR PREVIOUS PLAN WAS REJECTED by the safety check for these reasons:\n- ' +
      feedback.join('\n- ') + '\nFix every reason and return a corrected plan.';
  }
  return prompt;
}

export function alertPrompt(sit, approvedPlan) {
  const ctx = { fire: sit.name, time_local: sit.time_local, plan: approvedPlan,
                towns: aiContext(sit).towns.filter(t => t.status === 'EVACUATE' || t.status === 'WARNING') };
  return "Draft the Wireless Emergency Alert text an official would send through the county's existing alert " +
    `system for this APPROVED plan. Under ${ALERT_MAX} characters, plain text, no emojis, no hashtags. Start ` +
    "with 'EVACUATION ORDER' or 'EVACUATION WARNING', name the fire, the town(s), the exit route(s) and a " +
    "short action ('Leave now via ...'). If a town's exit is '" + NO_CLEAR_EXIT + "', do NOT name any road " +
    "for that town: tell its residents to leave now and follow directions from emergency personnel. " +
    'Do not invent phone numbers or links. Facts:\n' + JSON.stringify(ctx);
}

/** Read a JSON object out of a reply (tolerates ```json fences). */
export function parseJson(text) {
  const m = /\{[\s\S]*\}/.exec(String(text || '').trim());
  if (!m) throw new Error('no JSON object in reply');
  return JSON.parse(m[0]);
}

/**
 * The plan loop: AI plan -> safety check -> retry with the reasons (up to 2 retries), as in copilot.py.
 * ask(prompt) -> {json, provider, model, seconds}. Returns the same shape as POST /api/ai/plan.
 */
export async function planLoop(sit, ask) {
  const attempts = [];
  let feedback = null;
  for (let i = 0; i < 1 + MAX_RETRIES; i++) {
    let r;
    try { r = await ask(planPrompt(sit, feedback)); }
    catch (e) {
      return { status: 'AI_OFFLINE', attempts, detail: String(e?.message || e).slice(0, 200),
               message: 'AI offline, forecast only (AI service busy or quota reached; cached answers still work)' };
    }
    const p = r.json;
    const [reasons, human] = safetyCheck(p, sit);
    attempts.push({ attempt: i + 1, plan: p, verdict: reasons.length ? 'REJECTED' : 'ACCEPTED', reasons,
                    human_decisions: human, provider: r.provider, model: r.model, cached: false });
    if (!reasons.length) {
      const stuck = new Set(Object.entries(sit.exits || {})
        .filter(([, opts]) => opts.length && opts.every(o => o.blocked_1h_at_km !== null && o.blocked_1h_at_km !== undefined))
        .map(([t]) => t));
      for (const e of p.evacuate || []) {
        if (e && typeof e === 'object' && stuck.has(e.town)) { e.exit_ai = e.exit; e.exit = NO_CLEAR_EXIT; e.needs_human = true; }
      }
      return { status: 'ACCEPTED', attempts, plan: p, human_decisions: human };
    }
    feedback = reasons;
  }
  return { status: 'MANUAL', attempts, message: 'Manual decision required: the AI plan failed the safety check 3 times.' };
}

/** Keep the alert under 360 characters: cut at the last full sentence that fits (as in copilot.py). */
export function cutAlert(text) {
  text = String(text || '').trim().replace(/^"+|"+$/g, '');
  if (text.length > ALERT_MAX) {
    const cut = text.slice(0, ALERT_MAX);
    text = cut.includes('.') ? cut.slice(0, cut.lastIndexOf('.') + 1) : cut;
  }
  return text;
}
