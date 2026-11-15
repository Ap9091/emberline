// api/speak.js - Emberline's voice on the hosted site: text in, MP3 out, using ElevenLabs text-to-speech.
// Copied into site/api/ by app/build_site.py. The key lives ONLY in Vercel's environment variable
// ELEVENLABS_API_KEY; the browser never sees it. Without a key (or if the service fails) the page falls back to
// the browser's own voice (js/speech.js).
//
// POST /api/speak  {text}  ->  audio/mpeg
// API: POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=mp3_44100_128, header xi-api-key.

const VOICE = process.env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb';   // "George", a calm narrator voice from the voice library
const MODEL = process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';
const MAX_CHARS = 420;          // about 30 seconds of speech per request, so one request stays cheap
const LIMIT_PER_IP = 40;        // requests per IP per warm instance per hour (protects the account's credits)

const hits = new Map();
function limited(ip) {
  const now = Date.now(), list = (hits.get(ip) || []).filter(t => now - t < 3600e3);
  list.push(now); hits.set(ip, list);
  return list.length > LIMIT_PER_IP;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return res.status(503).json({ error: 'No voice key on the server.' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const text = String(body?.text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
  if (!text) return res.status(400).json({ error: 'No text.' });
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0] || 'unknown';
  if (limited(ip)) return res.status(429).json({ error: 'Too many voice requests for now.' });
  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(VOICE)}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: MODEL, voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) {
      console.error('voice error', r.status, (await r.text()).slice(0, 300));
      return res.status(502).json({ error: 'The voice service did not answer.' });
    }
    const audio = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(audio);
  } catch (e) {
    console.error('voice error', e?.message);
    return res.status(502).json({ error: 'The voice service did not answer.' });
  }
}
