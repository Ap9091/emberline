// ─────────────────────────────────────────────────────────────────────────────
// assistant.js - "Ask Emberline": the chat guide in the corner.
//
// The visitor asks a question; the server (Vercel: site/api/chat.js, full app: POST /api/chat in server.py) asks
// Claude Sonnet 5.5 with the facts in app/assistant/knowledge.md plus what is on screen right now, and gets back
//   {reply, actions, suggestions}
// The actions move the app (open a fire, go to an hour, split screen, what-if wind, highlight a card...).
// If the server has no API key, is busy, or this page has no server (claude.ai), the built-in answers
// below (FAQ) take over, so the chat always does something useful.
// ─────────────────────────────────────────────────────────────────────────────
import { app } from './app.js';
import { h, fill, $, sleep } from './util.js';
import { replayApi as R } from './mode_replay.js';

const MAX_PER_SESSION = 30;
const STARTERS = ['What am I looking at?', 'How accurate is it?', 'Show me the AI plan that got rejected', 'What if the wind doubled?'];

const ui = { open: false, busy: false, history: [], box: null, list: null, input: null, offline: false, demo: null };

// ── what is on screen (sent with every question) ─────────────────────────────
function screen() {
  const out = { mode: app.mode, demo_step: ui.demo?.on ? ui.demo.i + 1 : null };
  if (app.mode === 'replay' && R.state?.meta) {
    const s = R.state, sit = s.sit;
    out.fire = { id: s.fireId, name: s.meta.name, hour: s.hour, last_hour: s.meta.hours.length - 1 };
    if (sit) {
      out.time = sit.time_local;
      out.wind = sit.wind;
      out.forecast_area_km2 = sit.numbers?.forecast_area_km2;
      out.towns_in_danger = (sit.towns || []).filter(t => t.status !== 'MONITOR').slice(0, 8)
        .map(t => ({ name: t.name, status: t.status, eta_h: t.eta_h, people: t.population }));
      const v = sit.verification?.[2];
      if (v?.ok) out.check_3h = { hit: v.model.all.tp, missed: v.model.all.fn, false_alarm: v.model.all.fp };
    }
    out.split_screen = s.split; out.hit_miss_view = s.toggles.verify;
    out.what_if = s.whatif?.active ? { from_deg: s.whatif.scenario.whatif.from_deg, speed_kmh: s.whatif.scenario.whatif.speed_kmh } : null;
    out.official = s.meta.official_comparison || null;
  }
  return out;
}

// ── running the actions the assistant asks for ───────────────────────────────
const FIRES = ['eaton_fire_2025', 'park_fire_2024', 'palisades_fire_2025'];
const PANELS = { towns: 'sit', official: 'official', whatif: 'whatif', copilot: 'ai', verify: 'verify' };

async function ensureReplay(fireId) {
  if (app.mode !== 'replay') await app.go('replay', fireId ? { fireId } : {});
  else if (fireId) await R.open(fireId);
}

function flash(el) {
  if (!el) return;
  if (window.innerWidth > 900) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  el.classList.remove('as-flash'); void el.offsetWidth; el.classList.add('as-flash');
  setTimeout(() => el.classList.remove('as-flash'), 2600);
}

async function runActions(actions, { fromDemo = false } = {}) {
  for (const a of actions || []) {
    try {
      if (!fromDemo && ui.demo?.on && a.type !== 'demo') ui.demo.stop();
      const hour = Number.isInteger(a.hour) && a.hour >= 0 ? a.hour : null;
      switch (a.type) {
        case 'mode':
          if (['state', 'incident', 'replay'].includes(a.target) && app.mode !== a.target) await app.go(a.target);
          break;
        case 'fire':
          if (!FIRES.includes(a.target)) break;
          await ensureReplay(a.target);
          if (hour !== null) await R.hour(hour);
          if (R.state.meta && !R.state.split) {              // zoom to the fire, in the part of the map the chat does not cover
            const wide = window.innerWidth > 900;
            const [w, s, e, n] = R.state.meta.bounds, dx = (e - w) * 0.2, dy = (n - s) * 0.2;     // the box has wide margins
            app.view.map.fitBounds([[w + dx, s + dy], [e - dx, n - dy]],
              { padding: { top: 30, bottom: 30, left: 30, right: wide && ui.open ? 420 : 30 }, duration: 900 });
          }
          break;
        case 'hour':
          await ensureReplay(); if (hour !== null) await R.hour(hour);
          break;
        case 'show':
          if (a.target === 'results') { $('#results-btn')?.click(); break; }
          if (a.target === 'timeline') { await ensureReplay(); flash($('#timeline')); break; }
          await ensureReplay();
          if (a.target === 'split') await R.split(true);
          else if (a.target === 'check') { await R.split(false); R.layers({ verify: true }); flash(R.state.slots.verify); }
          else if (a.target === 'forecast') { await R.split(false); R.layers({ verify: false, fire: true, forecast: true }); }
          else if (PANELS[a.target]) flash(R.state.slots[PANELS[a.target]]);
          break;
        case 'wind':
          await ensureReplay();
          if (Number.isFinite(a.from_deg) && a.from_deg >= 0 && Number.isFinite(a.speed_kmh) && a.speed_kmh >= 0) {
            flash(R.state.slots.whatif);
            await R.wind(a.from_deg, Math.min(a.speed_kmh, 120));
          }
          break;
        case 'real_wind': R.realWind?.(); break;
        case 'town':
          await ensureReplay();
          if (R.state.sit?.towns?.some(t => t.name === a.target)) { R.town(a.target); flash(R.state.slots.sit); }
          break;
        case 'copilot':
          await ensureReplay(); flash(R.state.slots.ai); await R.copilot(window.innerWidth <= 900);
          break;
        case 'demo':
          if (ui.demo) { setOpen(false); ui.demo.start(Math.max(0, (hour ?? 1) - 1)); }
          break;
      }
    } catch (e) { console.warn('assistant action', a, e); }
  }
}

// ── built-in answers (no server, no key, or the server is busy) ───────────────
const A = (type, target = '', hour = -1, from_deg = -1, speed_kmh = -1) => ({ type, target, hour, from_deg, speed_kmh });
const FAQ = [
  [/\b(python|javascript|typescript|java|c\+\+|html|css|sql|homework|essay|poem|translate|recipe|joke)\b|\b(write|make|build|fix|debug)\b.*\b(code|program|script|function|app|website|essay)\b/i,
    'I can only help with Emberline and its wildfire forecasts. Want to see how accurate it is, or the AI plan our code rejected?',
    [], ['How accurate is it?', 'Show me the AI plan that got rejected']],
  [/lucky|luck|fluke|chance/i, 'Not just luck. At 7 pm Emberline predicted 13 of the 17 squares that burned by 10 pm, with zero false alarms, and each miss was right next to a predicted square. That is one of its best hours, so we also tested 18 fires it never saw: it warned 18 of 20 towns, about 2.8 hours early.',
    [A('fire', 'eaton_fire_2025', 2), A('show', 'check')], ['Show the official orders', 'Where does it fail?']],
  [/reject|safety|unsafe|bad plan|road|copilot|plan|code/i, 'On the Park Fire at 3 pm, the AI first sent Butte Creek Canyon out on Highway 32 west, but that road ran into the forecast fire. Plain code checked it and said REJECTED, so the AI picked Highway 32 north instead. A person still has to press Approve.',
    [A('fire', 'park_fire_2024', 2), A('copilot'), A('show', 'copilot')], ['What does the code check?', 'How accurate is it?']],
  [/real wind|go back/i, 'Back to the real wind.', [A('real_wind')], ['What if the wind doubled?', 'How accurate is it?']],
  [/what.?if|wind|doubl|stronger/i, 'Here is the Eaton Fire with the wind twice as strong (60 km/h instead of 29). Emberline re-runs its forecast in about a second, and the towns in danger go from 6 to 20. Press "Real wind" to go back.',
    [A('fire', 'eaton_fire_2025', 2), A('wind', '', -1, 25, 60)], ['How does the forecast work?', 'Go back to the real wind']],
  [/official|order|earl|late|altadena|sierra/i, 'This card compares Emberline with the real evacuation orders. Emberline warned Sierra Madre at 7:00 pm; the official order came at 9:26 pm. For all 5 towns with published times, Emberline was first, usually by about half an hour.',
    [A('fire', 'eaton_fire_2025', 2), A('show', 'official')], ['What does the bar at the bottom mean?', 'How accurate is it?']],
  [/split/i, 'Split screen: on the left is only what the satellite saw at 7 pm. On the right, the dotted line is our 3-hour guess and the dark squares fading in are where the fire really was at 10 pm.',
    [A('fire', 'eaton_fire_2025', 2), A('show', 'split')], ['Check it square by square', 'How accurate is it?']],
  [/show the forecast|the forecast$/i, 'Red squares are burning now. Orange squares may burn in the next 3 hours (darker = more likely), and the dotted lines are where the edge should be in 1, 2 and 3 hours.',
    [A('fire', 'eaton_fire_2025', 2), A('show', 'forecast')], ['Was the guess right?', 'How does the model work?']],
  [/13|17|miss|square|right|check|compare/i, 'Green squares: we said fire and fire came (13). Pink: fire came but we missed it (4). Grey: false alarms (0). Every pink square touches a green one, so the guess was never more than one 2 km square off.',
    [A('fire', 'eaton_fire_2025', 2), A('show', 'check')], ['Is this one lucky fire?', 'Show the split screen']],
  [/accura|good|test|score|result|lucky|consistent|reliab/i, 'We tested on 18 California fires from 2024 and 2025 that the model never saw. It warned 18 of the 20 towns the fire reached, about 2.8 hours early, and was about 1.7 times better than a simple rule at spotting new fire. The full table is open now.',
    [A('show', 'results')], ['Where does it fail?', 'Show the Eaton Fire']],
  [/fail|limit|wrong|weak|bad|problem/i, 'It gives more false alarms than a simple rule, on purpose, because missing a town is worse. For the overall fire shape it is only as good as "the fire stays put". And the satellite sees 2 km squares, so smoke, clouds and night can hide fire.',
    [], ['How accurate is it?', 'What data does it use?']],
  [/data|satellite|source|weather|train|learn|model|work/i, 'The fire comes from the NOAA GOES weather satellite (every 5 minutes). Weather from Open-Meteo, slopes from terrain maps, plants from ESA WorldCover, towns and roads from the US Census. The model learned from 40 fires (2018 to 2022) and was tested on 18 newer ones.',
    [], ['How accurate is it?', 'Show the forecast']],
  [/bar|timeline|bottom|tick/i, 'The bar at the bottom shows the whole fire from left to right. Orange ticks are when Emberline first warned a town, red ticks are when the fire reached a town, white ticks are official orders, and the brown hill is the fire size.',
    [A('show', 'timeline')], ['Show the official orders', 'How accurate is it?']],
  [/park/i, 'Here is the Park Fire (Butte County, July 2024), one of the biggest fires in California history.', [A('fire', 'park_fire_2024', 2)], ['Show the AI plan that got rejected', 'How accurate is it?']],
  [/palisades/i, 'Here is the Palisades Fire (Los Angeles, January 2025).', [A('fire', 'palisades_fire_2025', -1)], ['Show the forecast', 'How accurate is it?']],
  [/eaton/i, 'Here is the Eaton Fire at 7 pm on January 7, 2025, the forecast in the demo.', [A('fire', 'eaton_fire_2025', 2)], ['Was the guess right?', 'Show the official orders']],
  [/demo|tour|start over/i, 'Starting the guided demo.', [A('demo', '', 1)], []],
  [/state|all fire|california/i, 'STATE shows every fire in California from the latest satellite scan.', [A('mode', 'state')], ['Show the Eaton Fire', 'How accurate is it?']],
];
const OVERVIEW = ['Emberline predicts where a wildfire will spread in the next 3 hours, warns nearby towns, and checks that escape roads are safe. Red squares are burning now, orange may burn soon, and the dotted lines are the predicted edge at 1, 2 and 3 hours.',
  [], ['How accurate is it?', 'Show the AI plan that got rejected', 'What if the wind doubled?']];

function faq(text) {
  const hit = FAQ.find(([rx]) => rx.test(text)) || [null, ...OVERVIEW];
  return { reply: hit[1], actions: hit[2], suggestions: hit[3] };
}

// ── talking to the server ────────────────────────────────────────────────────
async function askServer(history) {
  if (window.EMBERLINE_STATIC && !window.EMBERLINE_TILES) throw Object.assign(new Error('no server'), { offline: true });   // claude.ai page
  const res = await fetch('api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: history.slice(-12), screen: screen() }) });
  let body = null; try { body = await res.json(); } catch { /* not JSON: no server here */ }
  if (!res.ok || !body || typeof body.reply !== 'string') throw Object.assign(new Error(body?.error || `HTTP ${res.status}`), { offline: !body || body.offline !== false });
  return body;
}

function count() { try { return +sessionStorage.getItem('emberline-chat-n') || 0; } catch { return 0; } }
function bump() { try { sessionStorage.setItem('emberline-chat-n', String(count() + 1)); } catch { /* private mode */ } }

/** Ask a question (typed by the visitor, tapped as a chip, or sent by the demo). */
export async function ask(text, { fromDemo = false } = {}) {
  text = String(text || '').trim().slice(0, 600);
  if (!text || ui.busy) return;
  setOpen(true);
  ui.history.push({ role: 'user', content: text });
  addMsg('user', text);
  ui.busy = true; drawInput();
  const typing = addMsg('bot', h('span', { class: 'as-typing' }, h('i'), h('i'), h('i')));
  let out, source = 'claude';
  try {
    if (count() >= MAX_PER_SESSION) throw Object.assign(new Error('limit'), { offline: true });
    out = await askServer(ui.history);
    bump();
  } catch (e) {
    out = faq(text); source = 'faq';
    ui.offline = true;
  }
  typing.remove();
  ui.history.push({ role: 'assistant', content: out.reply });
  addMsg('bot', out.reply, out.suggestions, source);
  ui.busy = false; drawInput();
  await runActions(out.actions, { fromDemo });
}

// ── the window ───────────────────────────────────────────────────────────────
function addMsg(who, content, suggestions = [], source = null) {
  const row = h('div', { class: `as-msg as-${who}` }, h('div', { class: 'as-bubble' }, content),
    source === 'faq' ? h('div', { class: 'as-note' }, 'Built-in answer (the AI assistant is offline right now)') : null,
    suggestions?.length ? h('div', { class: 'as-chips' }, suggestions.map(s => h('button', { class: 'as-chip', onclick: () => ask(s) }, s))) : null);
  ui.list.append(row);
  ui.list.scrollTop = ui.list.scrollHeight;
  return row;
}

function drawInput() {
  ui.input.disabled = ui.busy;
  ui.box.querySelector('.as-send').disabled = ui.busy;
  if (!ui.busy) ui.input.focus({ preventScroll: true });
}

export function setOpen(open) {
  ui.open = open;
  ui.box.hidden = !open;
  $('#as-launch').classList.toggle('on', open);
  if (open) { ui.list.scrollTop = ui.list.scrollHeight; if (!ui.busy) ui.input.focus({ preventScroll: true }); }
}

export function initAssistant(demo) {
  ui.demo = demo;
  const launch = h('button', { id: 'as-launch', title: 'Ask Emberline (AI guide)', onclick: () => setOpen(!ui.open) },
    h('span', { class: 'as-spark' }, '✦'), h('span', {}, 'Ask Emberline'));
  ui.list = h('div', { class: 'as-list' });
  ui.input = h('input', { type: 'text', maxlength: '600', placeholder: 'Ask anything, or "take me to…"', 'aria-label': 'Ask Emberline' });
  const form = h('form', { class: 'as-form', onsubmit: e => { e.preventDefault(); const v = ui.input.value; ui.input.value = ''; ask(v); } },
    ui.input, h('button', { class: 'btn btn-primary as-send', type: 'submit', 'aria-label': 'Send' }, '↑'));
  ui.box = h('section', { id: 'as-box', hidden: true, role: 'dialog', 'aria-label': 'Ask Emberline' },
    h('header', { class: 'as-head' },
      h('div', {}, h('b', {}, '✦ Ask Emberline'), h('span', {}, 'AI guide · Claude Sonnet 5.5')),
      h('button', { class: 'as-x', title: 'Close', onclick: () => setOpen(false) }, '✕')),
    ui.list, form,
    h('div', { class: 'as-foot' }, 'Research demo. In a real fire, follow official orders.'));
  document.body.append(launch, ui.box);
  addMsg('bot', 'Hi! Ask me anything about Emberline, or ask me to take you somewhere, like "show me the Park Fire" or "what if the wind doubled?"', STARTERS);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && ui.open && !ui.demo?.on) setOpen(false); });
}

export { runActions, sleep };
