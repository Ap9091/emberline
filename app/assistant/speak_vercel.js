// api/speak.js - Emberline's voice on the hosted site: text in, MP3 out, using ElevenLabs text-to-speech.
// Copied into site/api/ by app/build_site.py. The key lives ONLY in Vercel's environment variable
// ELEVENLABS_API_KEY; the browser never sees it. Without a key (or if the service fails) the page falls back to
// the browser's own voice (js/speech.js).
//
// POST /api/speak  {text}  ->  audio/mpeg
// API: POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=mp3_44100_128, header xi-api-key.

// Emberline's voice: Rachel (a calm, warm woman's voice). Some accounts can't use Rachel through the API any more
// (she is one of ElevenLabs' older voices), so if she is refused the next woman's voice in the list is used instead,
// and the one that works is remembered. ELEVENLABS_VOICE_ID in Vercel overrides the list.
const VOICES = process.env.ELEVENLABS_VOICE_ID ? [['custom', process.env.ELEVENLABS_VOICE_ID]] : [
  ['Rachel', '21m00Tcm4TlvDq8ikWAM'], ['Sarah', 'EXAVITQu4vr4xnSDxMaL'], ['Jessica', 'cgSgspJ2msm6clMCkdW9'],
  ['Matilda', 'XrExE9yKIg1WjnnlVkGX'], ['George', 'JBFqnCBsd6RMkjVDRZzb']];
let working = 0;                // index of the first voice that worked on this warm instance
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
  const tried = [];
  for (let i = working; i < VOICES.length; i++) {
    const [name, id] = VOICES[i];
    try {
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(id)}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify({ text, model_id: MODEL, voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
        signal: AbortSignal.timeout(15000),
      });
      if (r.ok) {
        working = i;
        const audio = Buffer.from(await r.arrayBuffer());
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Voice', name);
        if (tried.length) res.setHeader('X-Voice-Skipped', tried.join(', '));
        return res.status(200).send(audio);
      }
      const detail = (await r.text()).slice(0, 300);
      console.error('voice error', name, r.status, detail);
      tried.push(`${name} ${r.status}`);
      // this voice refused (not on the account / needs another plan): try the next; anything else (bad key, out of
      // credits, rate limit, outage) would fail for every voice, so stop
      if (![400, 402, 403, 404, 422].includes(r.status) || /quota|credit|invalid_api_key|unauthorized/i.test(detail)) break;
    } catch (e) {
      console.error('voice error', name, e?.message);
      tried.push(`${name} timeout`);
      break;
    }
  }
  if (tried.length) res.setHeader('X-Voice-Skipped', tried.join(', '));
  return res.status(502).json({ error: 'The voice service did not answer.' });
}
