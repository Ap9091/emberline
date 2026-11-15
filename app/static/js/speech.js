// speech.js - talk to Emberline and hear it answer.
// Speaking: on the hosted site, Emberline's voice comes from ElevenLabs through api/speak (the key stays on the
// server); if that is not set up or does not answer, the browser's own voice reads the text instead.
// Listening: the browser's speech recognition (Chrome, Edge or Safari turn speech into text with their own service).
// If a browser can do neither, the buttons simply do not appear.
import { STATIC } from './api.js';

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const browserVoice = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
export const canListen = !!Recognition;
export const canSpeak = STATIC || browserVoice;

let eleven = STATIC ? null : false;     // null = not tried yet, true = working, false = use the browser's voice
let audio = null, sayToken = 0;

let voice = null;
function pickVoice() {
  const voices = speechSynthesis.getVoices();
  const en = voices.filter(v => /^en[-_]/i.test(v.lang));
  voice = en.find(v => /natural|neural|google us|aria|jenny|samantha/i.test(v.name)) || en.find(v => /en[-_](us|ca)/i.test(v.lang)) || en[0] || null;
}
if (browserVoice) { pickVoice(); speechSynthesis.addEventListener?.('voiceschanged', pickVoice); }

/** Read units and symbols the way a person would say them. */
function speakable(text) {
  return String(text || '')
    .replace(/\*\*|__|`/g, '')
    .replace(/km\/h/g, ' kilometres an hour').replace(/km²/g, ' square kilometres').replace(/\bkm\b/g, ' kilometres')
    .replace(/°C/g, ' degrees').replace(/(\d)\s?h\b/g, '$1 hours').replace(/\+(\d)/g, 'plus $1')
    .replace(/\bI-210\b/g, 'the 210').replace(/\s+/g, ' ').trim();
}

/** Say something out loud. Resolves when it has been said (or right away if nothing can speak). */
export async function say(text, { rate = 1.04 } = {}) {
  if (!text) return;
  hush();
  const me = sayToken, words = speakable(text);
  if (eleven !== false) {
    const said = await sayEleven(words, me);
    if (said || me !== sayToken) return;            // said it, or something newer took over
  }
  if (me === sayToken) await sayBrowser(words, rate);
}

/** ElevenLabs through api/speak. Returns true once the audio has played. */
async function sayEleven(text, me) {
  try {
    const r = await fetch('api/speak', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }), signal: AbortSignal.timeout(9000) });
    if ([404, 405, 501, 503].includes(r.status)) { eleven = false; return false; }   // no key or no server: browser voice from now on
    if (!r.ok || me !== sayToken) return false;
    const url = URL.createObjectURL(await r.blob());
    if (me !== sayToken) { URL.revokeObjectURL(url); return false; }
    eleven = true;
    return await new Promise(resolve => {
      audio = new Audio(url);
      const end = ok => { URL.revokeObjectURL(url); resolve(ok); };
      audio.onended = () => end(true);
      audio.onerror = () => end(false);
      audio.play().catch(() => end(false));
    });
  } catch { return false; }
}

function sayBrowser(text, rate) {
  if (!browserVoice) return Promise.resolve();
  return new Promise(resolve => {
    const u = new SpeechSynthesisUtterance(text);
    if (voice) u.voice = voice;
    u.rate = rate; u.pitch = 1;
    const done = () => { clearTimeout(guard); resolve(); };
    const guard = setTimeout(done, 30000);                   // never wait forever on a stuck voice
    u.onend = done; u.onerror = done;
    speechSynthesis.speak(u);
  });
}

export function hush() {
  sayToken++;
  const a = audio; audio = null;
  if (a) { a.pause(); a.onended?.(); }            // stopped counts as finished, so nothing waits forever
  if (browserVoice) speechSynthesis.cancel();
}

/** Listen once. onText(text, final) is called as the words come in; onEnd() when listening stops. */
export function listen({ onText, onEnd }) {
  if (!canListen) return null;
  hush();
  const r = new Recognition();
  r.lang = 'en-US'; r.interimResults = true; r.maxAlternatives = 1;
  r.onresult = ev => {
    const text = [...ev.results].map(x => x[0].transcript).join('');
    onText(text, ev.results[ev.results.length - 1].isFinal);
  };
  let ended = false;
  const end = () => { if (!ended) { ended = true; onEnd?.(); } };
  r.onend = end; r.onerror = end;
  try { r.start(); } catch { end(); return null; }
  return r;
}
