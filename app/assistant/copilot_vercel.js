// api/copilot.js - the live AI copilot on the hosted site (Vercel serverless function).
// Copied into site/api/ by app/build_site.py. Used for any hour without a saved answer, and for what-if winds.
// The key lives ONLY in Vercel's environment variable ANTHROPIC_API_KEY.
//
// POST /api/copilot  {kind: 'briefing' | 'plan' | 'alert', sit: <situation on screen>, plan?: <approved plan>}
//   briefing -> {task, provider, model, seconds, text, cached}
//   plan     -> {status: ACCEPTED | MANUAL | AI_OFFLINE, attempts: [...], plan, human_decisions}   (same as /api/ai/plan)
//   alert    -> {..., text, chars, label}
// Every plan goes through the same plain-code safety check as the full app (_copilot_core.js).
import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM, briefingPrompt, planLoop, alertPrompt, parseJson, cutAlert, ALERT_MAX } from './_copilot_core.js';

const MODEL = process.env.EMBERLINE_COPILOT_MODEL || 'claude-sonnet-5-5';
const LIMIT_PER_IP = 15;          // copilot runs per IP per warm instance per hour (each run = a few AI calls)

const hits = new Map();
function limited(ip) {
  const now = Date.now(), list = (hits.get(ip) || []).filter(t => now - t < 3600e3);
  list.push(now); hits.set(ip, list);
  return list.length > LIMIT_PER_IP;
}

/** Keep only the parts of the situation the copilot uses, and check their shape. */
function cleanSit(s) {
  if (!s || typeof s !== 'object' || !Array.isArray(s.towns) || typeof s.exits !== 'object') return null;
  return {
    name: String(s.name || '').slice(0, 80), time_local: String(s.time_local || '').slice(0, 60),
    numbers: s.numbers || {}, wind: s.wind || {},
    towns: s.towns.slice(0, 60).map(t => ({ name: String(t.name), status: t.status, eta_h: t.eta_h ?? null, dist_km: t.dist_km ?? null,
      chance_3h: t.chance_3h ?? null, population: Number(t.population) || 0, bearing_from_fire: t.bearing_from_fire ?? null })),
    exits: Object.fromEntries(Object.entries(s.exits).slice(0, 60).map(([town, opts]) => [String(town), (Array.isArray(opts) ? opts : []).slice(0, 8)
      .map(o => ({ id: String(o.id), direction: o.direction, length_km: o.length_km, blocked_1h_at_km: o.blocked_1h_at_km ?? null,
                   blocked_3h_at_km: o.blocked_3h_at_km ?? null }))])),
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(503).json({ status: 'AI_OFFLINE', attempts: [], message: 'AI offline, forecast only (no API key on the server).' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const kind = body?.kind, sit = cleanSit(body?.sit);
  if (!['briefing', 'plan', 'alert'].includes(kind) || !sit) return res.status(400).json({ error: 'Bad request.' });
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0] || 'unknown';
  if (kind !== 'alert' && limited(ip)) {
    return res.status(503).json({ status: 'AI_OFFLINE', attempts: [], message: 'AI busy: too many copilot runs from here for now. Try again later.' });
  }

  const client = new Anthropic({ apiKey: key, maxRetries: 1, timeout: 25_000 });
  const ask = async (prompt, json) => {
    const t0 = Date.now();
    const base = { model: MODEL, max_tokens: json ? 2000 : 1200, system: SYSTEM,
                   messages: [{ role: 'user', content: json ? prompt + '\n\nReply with ONLY the JSON object, no other text.' : prompt }] };
    let r;
    try {
      // low effort keeps it quick; a server-side fallback model answers if Sonnet declines
      r = await client.beta.messages.create({ ...base, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
        output_config: { effort: 'low' } });
    } catch (e) {
      if (!(e instanceof Anthropic.BadRequestError)) throw e;
      r = await client.messages.create(base);            // an option was not accepted: ask plainly
    }
    if (r.stop_reason === 'refusal') throw new Error('the model declined');
    const text = r.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    const out = { task: kind, provider: 'claude', model: r.model || MODEL, seconds: Math.round((Date.now() - t0) / 100) / 10, cached: false };
    return json ? { ...out, json: parseJson(text) } : { ...out, text };
  };

  try {
    if (kind === 'briefing') return res.status(200).json(await ask(briefingPrompt(sit), false));
    if (kind === 'plan') {
      const out = await planLoop(sit, p => ask(p, true));
      if (out.status === 'AI_OFFLINE') { console.error('copilot plan offline', out.detail); delete out.detail; }
      return res.status(out.status === 'AI_OFFLINE' ? 503 : 200).json(out);
    }
    const r = await ask(alertPrompt(sit, body.plan || {}), false);
    const text = cutAlert(r.text);
    return res.status(200).json({ ...r, text, chars: text.length, max: ALERT_MAX, label: 'Draft for county alert system, not sent' });
  } catch (e) {
    console.error('copilot error', e?.status, e?.message);
    return res.status(503).json({ status: 'AI_OFFLINE', attempts: [], message: 'AI offline, forecast only (the AI service did not answer).' });
  }
}
