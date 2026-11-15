// ─────────────────────────────────────────────────────────────────────────────
// api/chat.js - the "Ask Emberline" assistant on Vercel (a serverless function next to the static site).
// Copied into site/api/ by app/build_site.py. The API key lives ONLY in Vercel's environment variable
// ANTHROPIC_API_KEY; the browser never sees it.
//
// POST /api/chat  {messages: [{role, content}], screen: {...what the app shows}}
//   → {reply, actions, suggestions}
// The knowledge (system prompt) is app/assistant/knowledge.md, copied in as _knowledge.js at build time.
// ─────────────────────────────────────────────────────────────────────────────
import Anthropic from '@anthropic-ai/sdk';
import { KNOWLEDGE } from './_knowledge.js';

const MODEL = process.env.EMBERLINE_ASSISTANT_MODEL || 'claude-sonnet-5-5';
const MAX_TURNS = 12;          // last messages sent to the model
const MAX_CHARS = 600;         // per visitor message
const LIMIT_PER_IP = 25;       // messages per IP per warm instance per hour (the $ cap is the account credit)

const ACTION = {
  type: 'object', additionalProperties: false,
  required: ['type', 'target', 'hour', 'from_deg', 'speed_kmh'],
  properties: {
    type: { type: 'string', enum: ['mode', 'fire', 'hour', 'show', 'wind', 'real_wind', 'town', 'copilot', 'demo'] },
    target: { type: 'string' }, hour: { type: 'integer' }, from_deg: { type: 'integer' }, speed_kmh: { type: 'integer' },
  },
};
export const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['reply', 'actions', 'suggestions'],
  properties: { reply: { type: 'string' }, actions: { type: 'array', items: ACTION }, suggestions: { type: 'array', items: { type: 'string' } } },
};

const hits = new Map();
function limited(ip) {
  const now = Date.now(), list = (hits.get(ip) || []).filter(t => now - t < 3600e3);
  list.push(now); hits.set(ip, list);
  return list.length > LIMIT_PER_IP;
}

/** Keep the conversation clean: alternating user/assistant text, ends with the visitor, trimmed. */
function cleanMessages(raw) {
  const msgs = (Array.isArray(raw) ? raw : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.slice(0, m.role === 'user' ? MAX_CHARS : 2000) }))
    .slice(-MAX_TURNS);
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  return msgs.length && msgs[msgs.length - 1].role === 'user' ? msgs : null;
}

/** Find the JSON object in a text answer (used by the plain fallback request). */
function parseLoose(text) {
  try { return JSON.parse(text); } catch { /* fall through */ }
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch { /* fall through */ } }
  return { reply: text.trim(), actions: [], suggestions: [] };
}

export async function askClaude(messages, screen, apiKey) {
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 25_000 });
  // Live screen context goes in the last user turn, so the long system prompt stays cached.
  const last = messages[messages.length - 1];
  const withScreen = [...messages.slice(0, -1),
    { role: 'user', content: `${last.content}\n\n<screen>${JSON.stringify(screen || {}).slice(0, 4000)}</screen>` }];
  const base = {
    model: MODEL, max_tokens: 1000,
    system: [{ type: 'text', text: KNOWLEDGE, cache_control: { type: 'ephemeral' } }],
    messages: withScreen,
  };
  let res;
  try {
    // Structured JSON answer, low effort (chat), and a server-side fallback model if Sonnet declines.
    res = await client.beta.messages.create({
      ...base, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    });
  } catch (e) {
    if (!(e instanceof Anthropic.BadRequestError)) throw e;
    // Some option was not accepted: ask again plainly, the system prompt already asks for JSON.
    res = await client.messages.create(base);
  }
  if (res.stop_reason === 'refusal') {
    return { reply: 'I can’t help with that one. Ask me about the fires, the forecast or the results.', actions: [], suggestions: ['How accurate is it?', 'What am I looking at?'] };
  }
  const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const out = parseLoose(text);
  return {
    reply: String(out.reply || '').slice(0, 1200),
    actions: Array.isArray(out.actions) ? out.actions.slice(0, 6) : [],
    suggestions: Array.isArray(out.suggestions) ? out.suggestions.slice(0, 3).map(s => String(s).slice(0, 60)) : [],
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(503).json({ offline: true, error: 'The assistant is not connected yet (no API key on the server).' });
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0] || 'unknown';
  if (limited(ip)) return res.status(429).json({ error: 'Too many questions for now. Try again in a while.' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const messages = cleanMessages(body?.messages);
  if (!messages) return res.status(400).json({ error: 'No question.' });
  try {
    return res.status(200).json(await askClaude(messages, body?.screen, key));
  } catch (e) {
    const status = e?.status || 500;
    console.error('assistant error', status, e?.message);
    return res.status(status === 429 ? 429 : 503).json({ offline: status !== 429, error: status === 429 ? 'The assistant is busy. Try again in a moment.' : 'The assistant is unavailable right now.' });
  }
}
