// demo.js - the guided demo. It plays the app by itself; the viewer only presses Next.
//
// Seven cards that follow the video script (problem on the welcome card, then the demo, how it works, next steps).
// One story, told on the real Eaton Fire (Los Angeles, January 2025), plus one card on the Park Fire
// (2024), where the saved copilot run shows the safety check rejecting an AI plan. Inside a card, the feature plays
// in timed beats: the card line, the map and the panel part being talked about light up together.
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
import { ask, setOpen, flashMic } from './assistant.js';
import { markReason } from './why.js';
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

/** A line in the card that lights up when the narration reaches it (see d.beat). */
const beat = (n, ...c) => h('div', { class: 'dm-beat', 'data-beat': String(n) }, ...c);
/** A section of the situation panel by its title (Wind, Fire size, Town countdowns), and one of its number tiles. */
const sec = title => [...(R.state.slots?.sit?.querySelectorAll('section.sec') || [])].find(x => x.querySelector('h3')?.textContent === title) || null;
const tile = (title, i) => sec(title)?.querySelectorAll('.tile')[i] || sec(title);

// Seven cards, one per part of the video script. Each card plays its feature in timed beats and spotlights what
// the narration is about: the line on the card (d.beat), the map, and the panel (d.focus).
const STEPS = [
  {
    title: 'The Eaton Fire, seen from space',
    kicker: 'Jan 7, 2025, 6 pm · Los Angeles',
    body: () => [
      beat(1, see('Only California is on the map. The glowing outline is ', b('Los Angeles County'), '.')),
      beat(2, p(h('span', { class: 'dm-key fire' }), b('Red squares'), ' are land burning right now, 2 km each. ',
        'A NOAA weather satellite spots the heat every 5 minutes, while winds gust near 100 km/h.')),
      why('That night the winds grounded the aircraft. The satellite kept watching, and Emberline always starts from where the fire really is.')],
    async run(d) {
      await d.replay(EATON, 1, { fire: true, forecast: false });
      if (!d.alive()) return;
      app.view.setGroup('towns', false);
      app.view.showLA(true);
      d.pin(LA, 'Los Angeles');
      d.frame(CA, 1200);
      d.beat(1);
      if (!await d.wait(2600)) return;
      d.clearPins();
      app.view.setGroup('towns', true);
      d.frameFire(1800);
      d.beat(2);
      if (!await d.wait(2200)) return;
      d.focus(tile('Fire size', 0));
    },
  },
  {
    title: 'The next 3 hours, in 3D',
    kicker: 'Forecast made at 7 pm, checked at 10 pm',
    body: () => [
      beat(1, p('The model adds the ', b('wind, humidity, slope and plants'), ' to the satellite picture, then forecasts hour by hour.')),
      h('div', { class: 'dm-hours' }, beat(2, '+1 h'), beat(3, '+2 h'), beat(4, '+3 h')),
      beat(5, h('div', { class: 'dm-bars' }, h('div', { class: 'dm-bars-title' }, 'The real fire at 10 pm fades in. Overlap with the guess (100% = perfect)'),
        bar('Emberline', 76, true), bar('Guess “fire stays put”', 65), bar('Guess “grows 1 km/h”', 31))),
      beat(6, see('Square by square:', h('div', { class: 'dm-legend' },
        key('hit', b('13 green'), ': we said fire, and fire came'),
        key('missed', b('4 pink'), ': fire came, but we missed it (each one next to a green)'),
        key('false', b('0 grey'), ': we said fire, but none came')))),
      why(b('This is one of our best hours'), '; across all 18 test fires the average overlap is 45%.')],
    async run(d) {
      await d.replay(EATON, 2, { fire: true, forecast: false });
      if (!d.alive()) return;
      d.beat(1);
      const wide = window.innerWidth > 900;
      // the self-driving 3D tour (tour.js), without its own box: this card is the explanation
      await app.tour?.({ captions: false, restore: false, only: ['now', 'h1', 'h2', 'h3', 'real', 'check'],
        pace: [3200, 1700, 1600, 2400, 3600, 3400], padding: { top: 40, bottom: 40, right: 40, left: wide ? 400 : 30 },
        onStep: i => { if (d.alive()) { d.beat(i + 1); if (i === 4 || i === 5) d.focus(R.state.slots.verify); } } });
    },
  },
  {
    title: 'Why this square? Ask the model',
    body: () => [
      beat(1, see('Click any square and the model shows its own reasons. This one is next to ', b('Sierra Madre'), ': a ',
        b('29% chance'), ' it burns within the hour, against 22% for a typical square.')),
      beat(2, p(h('span', { class: 'dm-key fire' }), b('Biggest push up: the wind'), ', 29 km/h with gusts of 99, blowing straight at it.')),
      beat(3, p(h('span', { class: 'dm-key mon' }), b('Pushing down:'), ' cool, humid air and trees on the ground.')),
      beat(4, why('Exact, not a guess. The model is a weighted sum (logistic regression), so the reasons add up to its answer.'))],
    async run(d) {
      if (app.view.is3D) app.set3D(false);           // back to a flat map after the 3D card: quicker, and easier to read
      await d.replay(EATON, 2, { fire: true, forecast: true });
      if (!d.alive()) return;
      d.frameFire(900);
      if (!await d.wait(900)) return;
      await R.why({ lon: -118.0548, lat: 34.1616 }, { near: true });     // the forecast square next to Sierra Madre
      if (!d.alive()) return;
      d.beat(1);
      if (!await d.wait(3600)) return;
      markReason('wind'); d.beat(2);
      if (!await d.wait(3200)) return;
      markReason('air'); d.beat(3);
      if (!await d.wait(1600)) return;
      markReason('plants');
      if (!await d.wait(1400)) return;
      markReason(null); d.beat(4);
    },
  },
  {
    title: 'Who should leave, and when',
    body: () => [
      beat(1, see('Every town gets ', h('span', { class: 'dm-tag evac' }, 'EVACUATE'), ' ', h('span', { class: 'dm-tag warn' }, 'WARNING'),
        ' or ', h('span', { class: 'dm-tag mon' }, 'MONITOR'), ', a countdown and a leave-by time.')),
      beat(2, h('div', { class: 'dm-honest' }, b('Sierra Madre'), ' (10,775 people, under 3 km from the fire) is told to evacuate. ',
        b('Leave by about 8 pm.'), ' Both directions of the I-210 stay clear of the forecast fire for at least 3 hours.')),
      beat(3, h('div', { class: 'dm-times' },
        h('div', { class: 'dm-time ours' }, h('span', { class: 'mono' }, '7:00 pm'), h('span', {}, 'Emberline warns Sierra Madre')),
        h('div', { class: 'dm-time' }, h('span', { class: 'mono' }, '8–9 pm'), h('span', {}, 'Satellite sees fire at the edge of town')),
        h('div', { class: 'dm-time official' }, h('span', { class: 'mono' }, '9:26 pm'), h('span', {}, 'Official evacuation order')))),
      beat(4, why('Across all 3 replay fires, Emberline was first for ', b('8 of 9 towns'), ' with public order times, including ',
        b('every town the fire actually reached'), '. On the bar at the bottom, our orange warning ticks come before the white official ones.'))],
    async run(d) {
      R.closeWhy();
      await d.replay(EATON, 2, { fire: true, forecast: true });
      if (!d.alive()) return;
      d.frameFire(900);
      d.focus(sec('Town countdowns'));
      d.beat(1);
      if (!await d.wait(4200)) return;
      R.town('Sierra Madre');
      d.pinTown('Sierra Madre');
      const row = R.state.slots.sit.querySelector('.town-row.selected');
      d.focus(row || sec('Town countdowns'), row?.nextElementSibling?.classList.contains('exit-list') ? row.nextElementSibling : null);
      d.beat(2);
      if (!await d.wait(7400)) return;
      d.focus(R.state.slots.official, $('#timeline'));
      d.beat(3);
      for (const hr of [3, 4]) {                  // let the fire reach the town
        if (!await d.wait(1500)) return;
        await R.hour(hr);
      }
      if (!await d.wait(2000)) return;
      d.beat(4);
    },
  },
  {
    title: 'AI writes the plan. Code checks it.',
    kicker: 'Another real fire: Park Fire, July 2024',
    body: () => [
      beat(1, p('An AI drafts the evacuation plan for every town in danger.')),
      beat(2, h('div', { class: 'dm-legend' }, key('evacbox', b('Red box'), ': it sent Butte Creek Canyon out on Highway 32 west, but the fire was about to cross that road. Our code said ',
        h('span', { class: 'dm-tag evac' }, 'REJECTED'), '.'))),
      beat(3, h('div', { class: 'dm-legend' }, key('okbox', b('Green box'), ': the fixed plan (Highway 32 north) passed the check.'))),
      beat(4, h('div', { class: 'dm-legend' }, num('✓', b('Approve plan'), ': nothing happens until a person presses it.'))),
      why('The AI never acts alone. Code checks every road, and a person makes the final call.')],
    async run(d) {
      await d.replay(PARK, 2, { fire: true, forecast: true });
      if (!d.alive()) return;
      d.frameFire(900);
      d.focus(R.state.slots.ai);
      d.beat(1);
      R.copilot(window.innerWidth <= 900).catch(() => {});      // phones: no panel scrolling (keeps the card in view)
      if (!await d.wait(5400)) return;
      d.focus(R.state.slots.ai.querySelector('.attempt-rejected') || R.state.slots.ai);
      d.beat(2);
      if (!await d.wait(3600)) return;
      d.focus(R.state.slots.ai.querySelector('.attempt-ok') || R.state.slots.ai);
      d.beat(3);
      if (!await d.wait(2000)) return;
      d.focus($('#approve-plan') || R.state.slots.ai);
      d.beat(4);
    },
  },
  {
    title: 'Ask out loud. It answers out loud.',
    chat: true,
    body: () => [
      beat(1, see('Press the 🎤 in ', b('✦ Ask Emberline'), ' (Claude Sonnet 5.5) and just ask. It answers in plain words, reads the answer aloud, and moves the app.')),
      beat(2, p(b('“What happens if the wind doubles?”'))),
      beat(3, h('div', { class: 'dm-compare' },
        h('div', {}, h('span', { class: 'dm-big mono' }, '10'), h('span', {}, 'towns in danger with the real wind (29 km/h)')),
        h('div', { class: 'hot' }, h('span', { class: 'dm-big mono' }, '20'), h('span', {}, 'towns in danger at 60 km/h')))),
      why('Emberline reruns the forecast in about a second, so teams can plan for a worse wind before it arrives.')],
    async run(d) {
      const phone = window.innerWidth <= 900;      // on phones the chat would cover the card, so only the map changes
      await d.replay(EATON, 2, { fire: true, forecast: true });
      if (!d.alive()) return;
      if (!phone) { setOpen(true); flashMic(true); }
      d.frameFire(900);
      d.beat(1);
      if (!await d.wait(2200)) return;
      flashMic(false);
      d.beat(2);
      // the demo changes the wind itself (so the map is always right); the guide explains it, out loud
      if (!phone) ask('What happens if the wind doubles to 60 km/h?', { fromDemo: true, actions: false, speak: 'short' });
      if (!await d.wait(1400)) return;
      d.focus(R.state.slots.whatif);
      await R.wind(R.state.sit.wind.from_deg, 60);
      if (!d.alive()) return;
      d.frameFire(900);
      d.focus(R.state.slots.whatif);
      d.beat(3);
    },
  },
  {
    title: 'How it works: tested on 18 fires it never saw',
    body: () => [
      beat(1, p(b('Data. '), 'NOAA GOES satellite scans of 70 California fires (2018 to 2025): 355,483 examples, each a 2 km square at one hour.')),
      beat(2, p(b('Model. '), 'A logistic regression with 39 inputs (the fire, wind, humidity, slope and plants), trained on 38 older fires and tested on the ',
        b('18 dots'), ': fires from 2024 and 2025 it never saw.')),
      beat(3, h('table', { class: 'dm-table' },
        h('thead', {}, h('tr', {}, h('th'), h('th', { class: 'ours' }, 'Emberline'), h('th', {}, 'Grows 1 km/h'), h('th', {}, 'Stays put'))),
        h('tbody', {},
          h('tr', {}, h('td', {}, 'Towns warned before the fire came'), h('td', { class: 'ours mono' }, '18 / 20'), h('td', { class: 'mono' }, '18 / 20'), h('td', { class: 'mono' }, '0 / 20')),
          h('tr', {}, h('td', {}, 'How early, on average'), h('td', { class: 'ours mono' }, '2.8 h'), h('td', { class: 'mono' }, '2.5 h'), h('td', { class: 'mono' }, '–')),
          h('tr', {}, h('td', {}, 'Spotting new fire (0 to 1)'), h('td', { class: 'ours mono' }, '0.41'), h('td', { class: 'mono' }, '0.24'), h('td', { class: 'mono' }, '0')),
          h('tr', {}, h('td', {}, 'Fire shape at +3 h'), h('td', { class: 'ours mono' }, '45%'), h('td', { class: 'mono' }, '17%'), h('td', { class: 'mono' }, '47%'))))),
      beat(4, h('div', { class: 'dm-honest' }, b('Not perfect. '), 'On fire shape it ties “stays put” (45% vs 47%), and it gives extra “get ready” warnings on purpose. ',
        b('Next: '), 'official evacuation zones, and a trial beside a county emergency office.')),
      h('div', { class: 'dm-src' }, 'Explore on your own: the ▶ 3D tour, click any square, STATE (all of California), INCIDENT, REPLAY, Results and ✦ Ask Emberline.')],
    async run(d) {
      R.realWind();
      setOpen(false);
      await d.replay(EATON, 2, { fire: true, forecast: true });
      if (!d.alive()) return;
      app.view.setGroup('towns', false);
      d.frame(CA, 1400);
      d.beat(1);
      if (!await d.wait(5200)) return;
      d.beat(2);
      if (!await d.wait(3000)) return;
      d.dots(TEST_FIRES);
      if (!await d.wait(4000)) return;
      d.beat(3);
      if (!await d.wait(7600)) return;
      d.beat(4);
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

// Auto-play (URL #demo-auto, for recording the video): seconds per card, matched to the 7-card video script read
// fast (about 250 words a minute). The welcome card (the problem) stays up for AUTO_WELCOME_S first, and the last
// card stays up while the speaker gives the next steps. Space pauses.
const AUTO_SECONDS = [8.5, 18.5, 12.5, 17, 12, 14, 40];   // the cards take about 1:45, the welcome card 15 s first
const AUTO_WELCOME_S = 15;
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
    app.stopTour?.(); R.closeWhy?.(); flashMic(false);
    app.view.showLA(false);
    this.card.classList.toggle('dock-right', step.dock === 'right');
    if (!step.chat) setOpen(false);
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
    app.stopTour?.(); R.closeWhy?.(); flashMic(false);
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
      focus: (...els) => token === demo.token && demo.focus(...els),
      /** Wait, then say whether this card is still on screen (false = the viewer moved on: stop). */
      wait: async ms => { await sleep(ms); return token === demo.token; },
      beat: n => token === demo.token && demo.beat(n),
      clearPins: () => token === demo.token && demo.clearMarks(),
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
    const chat = document.getElementById('as-box');
    const right = !narrow && chat && !chat.hidden ? 420 : 40;          // the chat window sits over the right of the map
    // phones: the card sits over the lower part of the map, so keep the fire in the part above it
    let bottom = 40;
    if (narrow && this.card && !this.card.hidden) {
      const mapBox = app.view.map.getContainer().getBoundingClientRect(), cardBox = this.card.getBoundingClientRect();
      const covered = mapBox.bottom - cardBox.top;
      if (covered > 40) bottom = Math.min(covered + 16, mapBox.height * 0.6);
    }
    app.view.map.fitBounds([[w, s], [e, n]], { padding: { top: 40, bottom, left, right }, duration: ms, pitch: app.view.is3D ? 50 : 0, bearing: 0 });
  }

  /** Spotlight elements: the rest of the side panel fades back. No element = no spotlight (panel faded). */
  focus(...els) {
    document.querySelectorAll('.demo-focus, .demo-lit').forEach(x => x.classList.remove('demo-focus', 'demo-lit'));
    $('#panel').classList.toggle('demo-dim', this.on);
    els = els.filter(Boolean);
    if (!els.length) return;
    const body = $('#panel-body');
    for (const el of els) {
      el.classList.add('demo-focus');
      if (body.contains(el) && el.parentElement !== body) {      // a piece inside a panel block: light up that block too
        let top = el;
        while (top.parentElement && top.parentElement !== body) top = top.parentElement;
        top.classList.add('demo-lit');
      }
    }
    // phones: the panel is below the map, so scrolling to it would hide the demo card; keep the page still
    const first = els[0];
    if ($('#panel').contains(first) && window.innerWidth > 900) {
      requestAnimationFrame(() => first.scrollIntoView({ block: first.parentElement === body ? 'start' : 'center', behavior: 'smooth' }));
    }
  }

  /** Light up the card line the narration has reached (made with beat(n, ...)) and keep it in view. */
  beat(n) {
    let first = null;
    for (const el of this.card?.querySelectorAll('[data-beat]') || []) {
      const on = el.dataset.beat === String(n);
      el.classList.toggle('dm-on', on);
      if (on && !first) first = el;
    }
    if (!first) return;
    const c = this.card, foot = c.querySelector('.dm-foot')?.offsetHeight || 0;       // Next sits pinned at the bottom
    const top = first.offsetTop - 50, bottom = first.offsetTop + first.offsetHeight - c.clientHeight + foot + 16;
    if (top < c.scrollTop) c.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    else if (bottom > c.scrollTop) c.scrollTo({ top: bottom, behavior: 'smooth' });
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
        h('li', {}, h('b', {}, 'Forecast. '), 'A model trained on 38 past fires uses wind, slope, plants and dryness to colour the squares likely to burn in the next 1–3 hours.'),
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
