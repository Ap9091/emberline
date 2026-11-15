// demo.js - the guided demo. It plays the app by itself; the viewer only presses Next.
//
// One story, told on the real Eaton Fire (Los Angeles, January 2025), plus one step on the Park Fire
// (2024), where the saved copilot run shows the safety check rejecting an AI plan.
// Every number in the cards comes from the replay data or the test results (results/metrics.json):
//   * Eaton hour 2: the 3-hour forecast overlapped 76% with what really burned (fire stays put 65%,
//     grow 1 km/h 31%); one of the best +3 h hours of the Eaton Fire (not the top one). Square check: 13 hit, 4 missed, 0 false alarms.
//     Across all 18 test fires the average +3 h overlap (IoU) is 45%: we say so on screen.
//   * Sierra Madre: Emberline warning 7:00 pm (end of the satellite hour it was made from), fire within
//     1 km of town in the 8-9 pm satellite hour, first published evacuation order 9:26 pm (LA County report).
//   * What-if: same wind direction, 60 instead of 29 km/h → towns in danger 10 → 20 (both the full model re-run;
//     the saved replay keeps chances ≥ 5% only, so it lists 6 at the real wind)
//     (in-browser engine, identical to the Python backend; see app/check_whatif.mjs).
// To change the wording, edit STEPS below.
import { app } from './app.js';
import { h, fill, $, sleep } from './util.js';
import { replayApi as R } from './mode_replay.js';
import { ask, setOpen } from './assistant.js';
import * as api from './api.js';

const EATON = 'eaton_fire_2025', PARK = 'park_fire_2024';
const CA = [-124.4, 32.5, -114.1, 42.0];
const LA = [-118.25, 34.2];
// The 18 test fires (2024-2025), never used for training (data/fires.csv, split = test)
const TEST_FIRES = [['Park', -121.762, 39.779], ['Gifford', -120.098, 35.111], ['Madre', -119.983, 35.099],
  ['Garnet', -119.028, 36.865], ['Borel', -118.684, 35.515], ['Bridge', -117.763, 34.24], ['Line', -117.155, 34.121],
  ['Lake', -120.045, 34.785], ['SQF Lightning', -118.311, 35.987], ['Salt', -120.363, 36.012], ['Airport', -117.566, 33.668],
  ['Palisades', -118.545, 34.07], ['Orleans', -123.418, 41.326], ['Mountain', -118.969, 34.319], ['Sites', -122.469, 39.316],
  ['Green', -122.094, 40.835], ['Boone', -120.588, 36.122], ['Eaton', -118.069, 34.203]];

const p = (...c) => h('p', {}, ...c);
const b = t => h('b', {}, t);

/** Coloured bar for "how much did the guess overlap with what really burned". */
const bar = (label, pct, ours) => h('div', { class: 'dm-bar' + (ours ? ' ours' : '') },
  h('span', { class: 'dm-bar-label' }, label), h('span', { class: 'dm-bar-track' }, h('i', { style: `width:${pct}%` })),
  h('span', { class: 'dm-bar-n mono' }, pct + '%'));

const see = (...c) => h('div', { class: 'dm-see' }, h('span', { class: 'dm-lab' }, 'What you see'), h('div', {}, ...c));
const why = (...c) => h('div', { class: 'dm-why' }, h('span', { class: 'dm-lab' }, 'Why it matters'), h('div', {}, ...c));
const key = (cls, ...c) => h('div', {}, h('span', { class: 'dm-key ' + cls }), h('span', {}, ...c));
const num = (n, ...c) => h('div', {}, h('span', { class: 'dm-key n' }, n), h('span', {}, ...c));

const STEPS = [
  {
    title: 'One real place: California',
    body: () => [see('Only California is on the map. The glowing outline is ', b('Los Angeles County'), '.'),
      why('We kept the project to one real place, so we could test it properly on real fires.')],
    async run(d) {
      await d.replay(EATON, 1, { fire: true, forecast: false });
      app.view.setGroup('towns', false);
      app.view.showLA(true);
      d.pin(LA, 'Los Angeles');
      d.frame(CA, 1400);
    },
  },
  {
    title: 'Jan 7, 2025, 6 pm: the Eaton Fire',
    body: () => [see(h('span', { class: 'dm-key fire' }), b('Red squares'), ' are land burning right now. Each one is 2 km wide. ',
        'A NOAA weather satellite spots the heat every 5 minutes, while winds gust near 100 km/h.'),
      why('Emberline always starts from where the fire really is, straight from space.')],
    async run(d) {
      await d.replay(EATON, 1, { fire: true, forecast: false });
      d.frameFire(1400);
    },
  },
  {
    title: 'Emberline guesses the next 3 hours',
    body: () => [see(h('div', { class: 'dm-legend' },
        key('fire', b('Red'), ': burning now'),
        key('forecast', b('Orange'), ': may burn soon (darker = more likely)'),
        key('ring', b('Dotted lines'), ': where the edge should be in 1, 2 and 3 hours'))),
      why('Towns see the danger before it arrives. The model learned from ', b('40 past California fires'),
        ', using wind, slopes, plants and how dry the air is.')],
    async run(d) {
      await d.replay(EATON, 2, { fire: true, forecast: true });
      d.frameFire(900);
    },
  },
  {
    title: 'Was the guess right?',
    body: () => [see(b('Left:'), ' what the satellite saw at 7 pm. ', b('Right:'), ' the dotted line is our guess for 10 pm, and the ',
        h('span', { class: 'dm-key actual' }), b('dark squares'), ' are where the fire really was at 10 pm.'),
      h('div', { class: 'dm-bars' }, h('div', { class: 'dm-bars-title' }, 'How much the guess and the real fire overlap (100% = perfect)'),
        bar('Emberline', 76, true), bar('Guess “fire stays put”', 65), bar('Guess “grows 1 km/h”', 31)),
      why('Anyone can check the forecast against what really happened. ', b('This is one of our best hours'),
        '; across all 18 test fires the average overlap is 45%.')],
    async run(d) {
      await d.replay(EATON, 2, { fire: true, forecast: true }, { split: true });
      d.frameFire(0);
    },
    dock: 'right',
  },
  {
    title: 'Square by square',
    body: () => [see('The same guess, checked one square at a time:', h('div', { class: 'dm-legend' },
        key('hit', b('13 green'), ': we said fire, and fire came'),
        key('missed', b('4 pink'), ': fire came, but we missed it'),
        key('false', b('0 grey'), ': we said fire, but none came'))),
      why('Every pink square touches a green one, so the guess was never more than ', b('one square (2 km) off'),
        ', about as sharp as the satellite can see. And it raised no false alarms.')],
    async run(d) {
      await d.replay(EATON, 2, { fire: false, forecast: false, verify: true });
      d.frameFire(900);
      d.focus(R.state.slots.verify);
    },
  },
  {
    title: 'It warns towns before the fire arrives',
    body: () => [see('Every nearby town gets a colour: ', h('span', { class: 'dm-tag evac' }, 'EVACUATE'), ' ',
        h('span', { class: 'dm-tag warn' }, 'WARNING'), ' or ', h('span', { class: 'dm-tag mon' }, 'MONITOR'),
        '. ', b('Sierra Madre'), ' (10,775 people) is told to evacuate. The lines are its roads out.'),
      h('div', { class: 'dm-legend' },
        num('1', b('People'), ': how many live there'),
        num('2', b('Chance'), ': how likely the fire reaches it in 3 hours'),
        num('3', b('Dist.'), ': how far the fire is now')),
      h('div', { class: 'dm-honest' }, b('Leave by about 8 pm. '), 'Both directions of the I-210 stay clear of the forecast fire for at least 3 hours, so the deadline is the fire reaching town.'),
      why('People get a clear answer: when to leave, and which road to take.')],
    async run(d) {
      await d.replay(EATON, 2, { fire: true, forecast: true });
      R.town('Sierra Madre');
      d.focus(R.state.slots.sit);
      d.pinTown('Sierra Madre');
    },
  },
  {
    title: 'Real proof: we were hours early',
    body: () => [see(h('div', { class: 'dm-times' },
        h('div', { class: 'dm-time ours' }, h('span', { class: 'mono' }, '7:00 pm'), h('span', {}, 'Emberline warns Sierra Madre')),
        h('div', { class: 'dm-time' }, h('span', { class: 'mono' }, '8–9 pm'), h('span', {}, 'Satellite sees fire at the edge of town')),
        h('div', { class: 'dm-time official' }, h('span', { class: 'mono' }, '9:26 pm'), h('span', {}, 'Official evacuation order')))),
      why('Emberline flagged Sierra Madre ', b('almost 2½ hours before the official order'), '. On this fire it was first for ',
        b('all 5 towns'), ' with public order times, usually by about half an hour. Across all 3 replay fires: first for ',
        b('8 of 9 towns'), ', including ', b('every town the fire actually reached'), '.'),
      h('div', { class: 'dm-src' }, 'The panel lists each town, our time, the official time, and a link to the public record (LA County report).')],
    async run(d) {
      await d.replay(EATON, 2, { fire: true, forecast: true });
      d.focus(R.state.slots.official);
      d.pinTown('Sierra Madre');
      for (const hr of [3, 4]) {          // let the fire reach the town
        await sleep(1600); if (!d.alive()) return;
        await R.hour(hr);
      }
    },
  },
  {
    title: 'The bar at the bottom tells the whole story',
    body: () => [see('The whole fire, hour by hour, left to right:', h('div', { class: 'dm-legend' },
        key('tick warn', b('Orange ticks'), ': Emberline warns a town'),
        key('tick arrive', b('Red ticks'), ': the fire reaches a town'),
        key('tick official', b('White ticks'), ': official orders'),
        key('hill', b('Brown hill'), ': how big the fire was'))),
      why('Orange before red means a town was warned in time.')],
    async run(d) {
      await d.replay(EATON, 4, { fire: true, forecast: true });
      d.focus($('#timeline'));
    },
  },
  {
    title: 'AI writes the plan. Code checks it.',
    kicker: 'Another real fire: Park Fire, July 2024',
    body: () => [see('The AI wrote an evacuation plan that sent Butte Creek Canyon out on Highway 32 west, but the fire was about to cross that road.',
        h('div', { class: 'dm-legend' },
          key('evacbox', b('Red box'), ': the plan our code ', h('span', { class: 'dm-tag evac' }, 'REJECTED'), ', and why'),
          key('okbox', b('Green box'), ': the fixed plan (Highway 32 north) that passed'),
          num('✓', b('Approve plan'), ': nothing happens until a person presses it'))),
      why('The AI never acts alone. Code checks every road, and a person makes the final call.')],
    async run(d) {
      await d.replay(PARK, 2, { fire: true, forecast: true });
      d.frameFire(900);
      d.focus(R.state.slots.ai);
      await R.copilot(window.innerWidth <= 900);       // phones: no panel scrolling (keeps the card in view)
    },
  },
  {
    title: 'What if the wind changes?',
    body: () => [see('Back on the Eaton Fire, the wind now blows ', b('twice as hard'), '. The map and the towns update in about a second:'),
      h('div', { class: 'dm-compare' },
        h('div', {}, h('span', { class: 'dm-big mono' }, '10'), h('span', {}, 'towns in danger with the real wind (29 km/h)')),
        h('div', { class: 'hot' }, h('span', { class: 'dm-big mono' }, '20'), h('span', {}, 'towns in danger at 60 km/h'))),
      why('Teams can plan for a worse wind before it happens. Drag the compass on the right to try any wind.')],
    async run(d) {
      await d.replay(EATON, 2, { fire: true, forecast: true });
      d.frameFire(900);
      d.focus(R.state.slots.whatif);
      await sleep(900); if (!d.alive()) return;
      await R.wind(R.state.sit.wind.from_deg, 60);
      if (!d.alive()) return;
      d.focus(R.state.slots.whatif);
      d.frameFire(900);
    },
  },
  {
    title: 'Not one lucky fire: we tested 18',
    body: () => [see('The dots are ', b('18 fires from 2024 and 2025 the model never saw'), '. We trained on 40 older fires, then compared it with two simple guesses:'),
      h('table', { class: 'dm-table' },
        h('thead', {}, h('tr', {}, h('th'), h('th', { class: 'ours' }, 'Emberline'), h('th', {}, 'Grows 1 km/h'), h('th', {}, 'Stays put'))),
        h('tbody', {},
          h('tr', {}, h('td', {}, 'Towns warned before the fire came'), h('td', { class: 'ours mono' }, '18 / 20'), h('td', { class: 'mono' }, '18 / 20'), h('td', { class: 'mono' }, '0 / 20')),
          h('tr', {}, h('td', {}, 'How early, on average'), h('td', { class: 'ours mono' }, '2.8 h'), h('td', { class: 'mono' }, '2.5 h'), h('td', { class: 'mono' }, '–')),
          h('tr', {}, h('td', {}, 'Spotting new fire (0 to 1)'), h('td', { class: 'ours mono' }, '0.41'), h('td', { class: 'mono' }, '0.24'), h('td', { class: 'mono' }, '0')))),
      why('The result holds across many fires: 90% of towns warned, almost 3 hours early, and about 1.7 times better at spotting new fire. ',
        'It held up just as well when we swapped in the ', b('weather forecast people really had'), '.')],
    async run(d) {
      R.realWind();
      d.focus(null);
      await d.replay(EATON, 2, { fire: true, forecast: true });
      app.view.setGroup('towns', false);
      d.dots(TEST_FIRES);
      d.frame(CA, 1400);
    },
  },
  {
    title: 'Where it gets things wrong',
    body: () => [h('ul', { class: 'dm-list' },
        h('li', {}, b('False alarms. '), 'It warns some towns the fire never reaches, more often than the simple rule. But 98% of them were “get ready”, not “leave now”. We chose this: missing a town is worse than an extra warning.'),
        h('li', {}, b('Fire shape. '), 'For the overall shape it is about as good as “the fire stays put” (45% vs 47%). Its strength is new spread and town warnings.'),
        h('li', {}, b('Blurry eyes. '), 'The satellite sees 2 km squares, and smoke, clouds and night can hide fire. Local wind gusts are missed.'),
        h('li', {}, b('Few fires. '), 'Good satellite data only goes back to 2018, so there are only so many fires to learn from.')),
      h('div', { class: 'dm-honest' }, 'Emberline is a research demo. In a real fire, follow official orders.')],
    async run(d) {
      d.focus(null);
      await d.replay(EATON, 2, { fire: true, forecast: true });
      app.view.setGroup('towns', false);
      d.dots(TEST_FIRES);
      d.frame(CA, 0);
    },
  },
  {
    title: 'Ask Emberline anything',
    body: () => [see('The ', b('✦ Ask Emberline'), ' guide (Claude Sonnet 5.5) answers in plain words, using our real results, and ', b('moves the app'), ' to the proof.'),
      p('Watch it take a hard one: ', h('i', {}, '“Did Emberline just get lucky with Sierra Madre?”')),
      why('Anyone can explore Emberline without knowing anything about wildfires.')],
    async run(d) {
      d.focus(null);
      await sleep(700); if (!d.alive()) return;
      await ask('Did Emberline just get lucky with Sierra Madre?', { fromDemo: true });
      if (d.alive() && R.state?.slots) d.focus(R.state.slots.verify);
    },
    dock: 'right',
  },
  {
    title: 'Your turn',
    body: () => [h('div', { class: 'dm-modes' },
        h('div', {}, b('REPLAY'), h('span', {}, 'Past fires hour by hour. You are here.')),
        h('div', {}, b('INCIDENT'), h('span', {}, 'One fire up close, with the AI copilot.')),
        h('div', {}, b('STATE'), h('span', {}, 'All of California at once.'))),
      p('Ask the ', b('✦ Ask Emberline'), ' guide anything, and replay this demo any time from the ', b('⚙ menu'), '.')],
    async run(d) {
      d.focus($('#mode-tabs'));
      await d.replay(EATON, 2, { fire: true, forecast: true });
      d.frameFire(1000);
    },
  },
];

/** Box around the fire now + the 3-hour forecast + the towns in danger, with some room around it. */
function fireBounds(sit) {
  if (!sit) return null;
  let w = 180, s = 90, e = -180, n = -90;
  const add = ([x, y]) => { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); };
  const walk = c => (typeof c[0] === 'number' ? add(c) : c.forEach(walk));
  for (const key of ['fire', 'forecast']) for (const f of sit.layers?.[key]?.features || []) walk(f.geometry.coordinates);
  for (const t of sit.towns || []) if (t.status !== 'MONITOR') add([t.lon, t.lat]);
  if (w > e) return null;
  const cx = (w + e) / 2, cy = (s + n) / 2, half = Math.max((e - w) * 0.75, (n - s) * 0.75, 0.12);
  return [cx - half, cy - half * 0.8, cx + half, cy + half * 0.8];
}

// Auto-play (URL #demo-auto, for recording the video): seconds per step, matched to the pitch script
// (docs: about 175 words a minute). The welcome screen stays up for AUTO_WELCOME_S first. Space pauses.
const AUTO_SECONDS = [5, 5.5, 9, 6, 14.5, 6, 8, 6.5, 8.2, 4.8, 7.8, 5.8, 9.5, 6];      // about 1:58 in total
const AUTO_WELCOME_S = 15.5;
let autoScale = 1;           // #demo-auto-1.1 = 10% slower, #demo-auto-0.9 = 10% faster

/** Load everything the demo shows before it is needed, so no step waits on a download. */
function preload() {
  const hours = { eaton_fire_2025: [1, 2, 3, 4], park_fire_2024: [2] };
  for (const [fid, hs] of Object.entries(hours)) {
    api.getReplayMeta(fid).catch(() => {});
    hs.forEach(hr => api.getReplayHour(fid, hr).catch(() => {}));
  }
}

class Demo {
  constructor() { this.i = -1; this.token = 0; this.markers = []; this.card = null; this.auto = false; this.paused = false; this.timer = null; }

  get on() { return this.i >= 0; }

  async start(step = 0, { auto = false } = {}) {
    this.auto = auto; this.paused = false;
    preload();
    $('#results-backdrop')?.click();
    closeOverlays();
    document.body.classList.add('demo-on');
    if (!this.card) {
      this.card = h('aside', { id: 'demo-card', 'aria-live': 'polite' });
      $('#map-area').append(this.card);
      document.addEventListener('keydown', e => {
        if (!this.on) return;
        if (e.key === 'Escape') this.stop();
        if (e.key === 'Enter' && !/INPUT|TEXTAREA/.test(e.target.tagName)) { e.preventDefault(); this.next(); }
        if (e.key === ' ' && this.auto && !/INPUT|TEXTAREA/.test(e.target.tagName)) { e.preventDefault(); this.togglePause(); }
      });
    }
    this.card.hidden = false;
    setOpen(false);
    this.show(Math.max(0, Math.min(STEPS.length - 1, step)));
  }

  next() { this.i + 1 < STEPS.length ? this.show(this.i + 1) : this.stop(); }

  togglePause() {
    this.paused = !this.paused;
    clearTimeout(this.timer);
    if (!this.paused) this._arm();
    const st = this.card?.querySelector('.dm-status');
    if (st) st.textContent = this.paused ? 'Paused · Space to play' : 'Auto · Space to pause';
  }

  _arm() {
    clearTimeout(this.timer);
    if (!this.auto || this.paused || !this.on) return;
    const i = this.i;
    this.timer = setTimeout(() => { if (this.i === i && i < STEPS.length - 1) this.next(); }, (AUTO_SECONDS[i] ?? 7) * autoScale * 1000);
  }

  async show(i) {
    const token = ++this.token;
    this.i = i;
    const step = STEPS[i];
    this.clearMarks();
    this.focus(null);
    app.view.showLA(false);
    this.card.classList.toggle('dock-right', step.dock === 'right');
    if (step.title !== 'Ask Emberline anything' && step.title !== 'Your turn') setOpen(false);
    const last = i === STEPS.length - 1;
    fill(this.card,
      h('div', { class: 'dm-head' },
        h('span', { class: 'dm-count mono' }, `${i + 1} / ${STEPS.length}`),
        h('div', { class: 'dm-dots' }, STEPS.map((_, k) => h('i', { class: k < i ? 'done' : k === i ? 'on' : '' }))),
        h('button', { class: 'dm-x', title: 'Close the demo (Esc)', onclick: () => this.stop() }, '✕')),
      step.kicker ? h('div', { class: 'dm-kicker' }, step.kicker) : null,
      h('h2', {}, step.title),
      h('div', { class: 'dm-body' }, step.body()),
      h('div', { class: 'dm-foot' },
        h('span', { class: 'dm-status' }, this.auto ? 'Auto · Space to pause' : ''),
        h('button', { class: 'btn btn-primary dm-next', onclick: () => this.next() }, last ? 'Finish' : 'Next  →')));
    this.card.scrollTop = 0;
    this.card.querySelector('.dm-next').focus({ preventScroll: true });
    this._arm();
    const d = this._ctx(token);
    try { await step.run(d); }
    catch (e) { console.warn('demo step', i + 1, e); }
    if (window.innerWidth <= 900 && d.alive()) window.scrollTo({ top: 0, behavior: 'smooth' });   // the copilot scrolls its panel
  }

  stop() {
    this.token++; this.i = -1;
    clearTimeout(this.timer); this.auto = false;
    this.clearMarks(); this.focus(null);
    app.view.showLA(false);
    R.realWind?.();
    document.body.classList.remove('demo-on');
    if (this.card) this.card.hidden = true;
  }

  // what the steps can do
  _ctx(token) {
    const demo = this;
    return {
      alive: () => token === demo.token,
      /** Put REPLAY on a fire + hour with the given layers (and split screen on/off). */
      async replay(fireId, hour, layers, { split = false } = {}) {
        if (token !== demo.token) return;
        if (app.mode !== 'replay') await app.go('replay', { fireId });
        else await R.open(fireId);
        if (token !== demo.token) return;
        R.realWind();
        await R.split(split);
        R.layers({ baseline: false, actual: false, verify: false, ...layers });
        R.horizon(3);
        if (R.state.hour !== hour || !R.state.sit) await R.hour(hour);
      },
      frame: (bounds, ms) => token === demo.token && demo.frame(bounds, ms),
      frameFire: ms => token === demo.token && demo.frame(fireBounds(R.state.sit) || R.state.meta?.bounds, ms),
      focus: el => token === demo.token && demo.focus(el),
      pin: (lonlat, label) => token === demo.token && demo.pin(lonlat, label),
      pinTown: name => {
        const t = R.state.sit?.towns?.find(x => x.name === name);
        if (t && token === demo.token) demo.pin([t.lon, t.lat], name, 'town');
      },
      dots: list => token === demo.token && list.forEach(([name, lon, lat]) => demo.pin([lon, lat], name, 'dot')),
    };
  }

  /** Fit the camera, leaving room for the demo card on the left. shrink trims the fire box (it has 80 km of margin). */
  frame(bounds, ms = 1000, shrink = 0) {
    if (!bounds) return;
    let [w, s, e, n] = bounds;
    if (shrink) { const dx = (e - w) * shrink, dy = (n - s) * shrink; w += dx; e -= dx; s += dy; n -= dy; }
    const narrow = window.innerWidth <= 900;
    const split = $('#map-area').classList.contains('split');
    const left = narrow || split || this.card?.classList.contains('dock-right') ? 30 : Math.min(420, (this.card?.offsetWidth || 360) + 40);
    app.view.map.fitBounds([[w, s], [e, n]], { padding: { top: 40, bottom: 40, left, right: 40 }, duration: ms, pitch: app.view.is3D ? 50 : 0, bearing: 0 });
  }

  /** Spotlight one element: the rest of the side panel fades back. null = no spotlight (panel faded). */
  focus(el) {
    document.querySelectorAll('.demo-focus').forEach(x => x.classList.remove('demo-focus'));
    $('#panel').classList.toggle('demo-dim', this.on);
    if (!el) return;
    el.classList.add('demo-focus');
    // phones: the panel is below the map, so scrolling to it would hide the demo card; keep the page still
    if ($('#panel').contains(el) && window.innerWidth > 900) requestAnimationFrame(() => el.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  }

  pin([lon, lat], label, kind = 'place') {
    const el = h('div', { class: `demo-pin demo-pin-${kind}` }, h('i'), kind === 'place' ? h('span', {}, label) : null);
    if (kind === 'dot') el.title = label + ' Fire';
    this.markers.push(new maplibregl.Marker({ element: el, anchor: kind === 'place' ? 'bottom' : 'center' }).setLngLat([lon, lat]).addTo(app.view.map));
  }

  clearMarks() { this.markers.forEach(m => m.remove()); this.markers = []; }
}

export const demo = new Demo();

// welcome screen + settings menu
function closeOverlays() {
  $('#welcome')?.remove();
  $('#settings-menu')?.setAttribute('hidden', '');
  $('#howto')?.remove();
}

export function showWelcome({ auto = false, scale = 1 } = {}) {
  autoScale = scale;
  closeOverlays();
  const box = h('div', { id: 'welcome', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'welcome-title' },
    h('div', { class: 'wl-card' },
      h('div', { class: 'wl-brand' }, h('span', { class: 'brand-mark' }), 'EMBERLINE'),
      h('h1', { id: 'welcome-title' }, 'See a wildfire’s next 3 hours'),
      h('p', {}, 'Emberline is a wildfire copilot for California. It guesses where a fire will spread, warns towns early, and checks that the escape roads are safe.'),
      h('div', { class: 'wl-proof' }, h('b', {}, '2½ h'),
        h('span', {}, 'Replaying the 2025 Eaton Fire, Emberline flagged Sierra Madre almost 2½ hours before the official evacuation order.')),
      h('div', { class: 'wl-points' },
        h('div', {}, h('b', {}, '1'), 'Satellites spot the fire'),
        h('div', {}, h('b', {}, '2'), 'Emberline forecasts the spread'),
        h('div', {}, h('b', {}, '3'), 'Towns and roads get checked')),
      h('div', { class: 'wl-actions' },
        h('button', { class: 'btn btn-primary wl-start', onclick: () => { clearTimeout(box._t); box.remove(); demo.start(0, { auto }); } }, '▶  Start the demo  ·  2 min'),
        h('button', { class: 'btn wl-skip', onclick: () => box.remove() }, 'Explore on my own')),
      h('div', { class: 'wl-note' }, 'The demo plays by itself. You only press Next.')));
  document.body.append(box);
  box.querySelector('.wl-start').focus();
  preload();
  if (auto) box._t = setTimeout(() => box.querySelector('.wl-start')?.click(), AUTO_WELCOME_S * autoScale * 1000);
}

function showHowTo() {
  closeOverlays();
  const box = h('div', { id: 'howto', role: 'dialog', 'aria-modal': 'true', onclick: e => { if (e.target === box) box.remove(); } },
    h('div', { class: 'wl-card' },
      h('h1', {}, 'How Emberline works'),
      h('ol', { class: 'howto-list' },
        h('li', {}, h('b', {}, 'Watch. '), 'The GOES-18 weather satellite photographs California every 5–10 minutes. Hot spots = fire.'),
        h('li', {}, h('b', {}, 'Forecast. '), 'A model trained on 40 past fires uses wind, slope, plants and dryness to colour the squares likely to burn in the next 1–3 hours.'),
        h('li', {}, h('b', {}, 'Warn. '), 'Towns near those squares get EVACUATE, WARNING or MONITOR, with a countdown.'),
        h('li', {}, h('b', {}, 'Check the roads. '), 'An AI drafts the evacuation plan. Plain code rejects any road the fire is about to cross.'),
        h('li', {}, h('b', {}, 'A person decides. '), 'Nothing is sent until a human approves it.')),
      h('div', { class: 'wl-actions' }, h('button', { class: 'btn btn-primary', onclick: () => box.remove() }, 'Got it'))));
  document.body.append(box);
}

/** The ⚙ menu in the top bar: replay the demo, 2D/3D, map layer card, how it works. */
export function initSettings() {
  const btn = $('#settings-btn'), menu = $('#settings-menu');
  const layersOn = () => !document.body.classList.contains('hide-layers');
  const draw = () => fill(menu,
    h('button', { class: 'sm-item', onclick: () => { menu.hidden = true; demo.start(); } }, h('span', {}, '▶'), 'Replay the demo'),
    h('button', { class: 'sm-item', onclick: () => { menu.hidden = true; showHowTo(); } }, h('span', {}, '?'), 'How Emberline works'),
    h('div', { class: 'sm-sep' }),
    h('div', { class: 'sm-row' }, h('span', {}, 'Map'),
      h('div', { class: 'seg' + (app.mode === 'state' ? ' disabled' : '') },
        ['2d', '3d'].map(dim => h('button', { class: (dim === '3d') === app.view.is3D ? 'on' : '',
          onclick: () => { if (app.mode !== 'state') { app.set3D(dim === '3d'); draw(); } } }, dim.toUpperCase())))),
    h('label', { class: 'sm-row sm-check' }, h('span', {}, 'Layer and legend boxes'),
      h('input', { type: 'checkbox', checked: layersOn(), onchange: e => document.body.classList.toggle('hide-layers', !e.target.checked) })));
  btn.addEventListener('click', e => { e.stopPropagation(); menu.hidden = !menu.hidden; if (!menu.hidden) draw(); });
  document.addEventListener('click', e => { if (!menu.hidden && !menu.contains(e.target)) menu.hidden = true; });
  $('#demo-btn').addEventListener('click', () => demo.start());
}
