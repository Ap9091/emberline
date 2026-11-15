// speech.js - talk to Emberline and hear it answer, with the browser's own speech tools (Web Speech API).
// Speaking works in every modern browser. Listening needs Chrome, Edge or Safari (those browsers turn speech into
// text with their own speech service). If a browser has neither, the buttons simply do not appear.

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
export const canListen = !!Recognition;
export const canSpeak = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;

let voice = null;
function pickVoice() {
  const voices = speechSynthesis.getVoices();
  const en = voices.filter(v => /^en[-_]/i.test(v.lang));
  voice = en.find(v => /natural|neural|google us|aria|jenny|samantha/i.test(v.name)) || en.find(v => /en[-_](us|ca)/i.test(v.lang)) || en[0] || null;
}
if (canSpeak) { pickVoice(); speechSynthesis.addEventListener?.('voiceschanged', pickVoice); }

/** Read units and symbols the way a person would say them. */
function speakable(text) {
  return String(text || '')
    .replace(/\*\*|__|`/g, '')
    .replace(/km\/h/g, ' kilometres an hour').replace(/km²/g, ' square kilometres').replace(/\bkm\b/g, ' kilometres')
    .replace(/°C/g, ' degrees').replace(/(\d)\s?h\b/g, '$1 hours').replace(/\+(\d)/g, 'plus $1')
    .replace(/\bI-210\b/g, 'the 210').replace(/\s+/g, ' ').trim();
}

/** Say something out loud. Resolves when it has been said (or right away if the browser cannot speak). */
export function say(text, { rate = 1.04 } = {}) {
  if (!canSpeak || !text) return Promise.resolve();
  speechSynthesis.cancel();
  return new Promise(resolve => {
    const u = new SpeechSynthesisUtterance(speakable(text));
    if (voice) u.voice = voice;
    u.rate = rate; u.pitch = 1;
    const done = () => { clearTimeout(guard); resolve(); };
    const guard = setTimeout(done, 30000);                   // never wait forever on a stuck voice
    u.onend = done; u.onerror = done;
    speechSynthesis.speak(u);
  });
}

export function hush() { if (canSpeak) speechSynthesis.cancel(); }

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
