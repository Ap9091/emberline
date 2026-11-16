// tour.js - the 3D movie of a replay fire.
// It starts high above the region and swoops down onto the fire. Burning squares stand up as red towers, Emberline's
// forecast as orange towers (taller = more likely to burn), and white streaks blow across the map with the real wind.
// Then a clock runs the night forward: the real fire grows into the forecast hour by hour, a banner marks the moment
// the official evacuation order came, the forecast is checked square by square (towers turn green / pink / grey), and
// the camera ends low over the town most in danger. Every number, time and square comes from the replay data.
// Started by the "▶ 3D tour" button (REPLAY), by Ask Emberline ("give me a tour"), or by the guided demo (card 2,
// which explains it on its own card instead of the caption box).
import { app } from './app.js';
import { h, fill, sleep, fmtInt, compass, windArrow } from './util.js';
import * as api from './api.js';
import { replayApi as R } from './mode_replay.js';
import { say, hush } from './speech.js';

const EMPTY = { type: 'FeatureCollection', features: [] };
const TZ = 'America/Los_Angeles';                    // every replay fire is in California
const CLOCK = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const DAY = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const clock = ms => CLOCK.format(new Date(ms));
const msOf = iso => new Date(iso).getTime();
const DIRS = { N: 'north', NNE: 'north-north-east', NE: 'north-east', ENE: 'east-north-east', E: 'east', ESE: 'east-south-east',
  SE: 'south-east', SSE: 'south-south-east', S: 'south', SSW: 'south-south-west', SW: 'south-west', WSW: 'west-south-west',
  W: 'west', WNW: 'west-north-west', NW: 'north-west', NNW: 'north-north-west' };

let run = 0;          // a new movie, or stopTour(), ends the one that is playing
let slow = 1;         // window.emberlineMovieSlow = 3 plays the movie 3× slower (for checking it frame by frame)
const T = ms => ms * slow;
let on = null;        // what the playing movie put on screen: { hud, banner, box, label, wind, undo }

/** Stop the movie. putBack: false only when leaving REPLAY (the next mode draws its own map). */
export function stopTour({ putBack = true } = {}) { run++; finish(putBack !== false); }

function finish(putBack = true) {
  if (!on) return;
  const o = on; on = null;
  hush();
  o.wind?.stop();
  for (const el of [o.hud, o.banner, o.box]) el?.remove();
  o.label?.remove();
  document.body.classList.remove('tour-on');
  const v = app.view;
  if (v?.map.getLayer('tower-fc')) {
    v.night(false);
    v.setGroup('towers', false);
    v.setTowers({ fire: EMPTY, fc: EMPTY });
    v.map.setPaintProperty('tower-fc', 'fill-extrusion-opacity', 0.7);
  }
  o.undo?.(putBack);
}

document.addEventListener('keydown', e => { if (e.key === 'Escape' && on) stopTour(); });

// squares
const sqKey = f => `${f.properties.row}-${f.properties.col}`;
const keysOf = sit => new Set((sit?.layers?.fire?.features || []).map(sqKey));
const fc = list => ({ type: 'FeatureCollection', features: list.map(tower) });
/** A square drawn a little smaller than its 2 km cell, so neighbouring towers stand apart instead of merging into a block. */
function tower(f) {
  if (f.properties._t) return f;
  const ring = f.geometry.coordinates[0], n = ring.length - 1;
  let x = 0, y = 0;
  for (let i = 0; i < n; i++) { x += ring[i][0]; y += ring[i][1]; }
  x /= n; y /= n;
  const k = 0.8;
  return { ...f, geometry: { type: 'Polygon', coordinates: [ring.map(([a, b]) => [x + (a - x) * k, y + (b - y) * k])] }, properties: { ...f.properties, _t: 1 } };
}
/** The burning squares as towers; fresh = new since the hour before (they rise from the ground). */
function fireTowers(sit, prev) {
  const before = prev ? keysOf(prev) : new Set();
  return fc((sit?.layers?.fire?.features || []).map(f => ({ ...f, properties: { ...f.properties, fresh: before.has(sqKey(f)) ? 0 : 1 } })));
}
/** Forecast towers for +k hours, without the squares already burning. p0 = the height they move from. */
function forecastTowers(sit, k, burning, from = new Map()) {
  const now = new Map();
  for (const f of sit?.layers?.forecast?.features || []) if (f.properties.k === k && !burning.has(sqKey(f))) now.set(sqKey(f), f);
  const out = [...now.values()].map(f => ({ ...f, properties: { ...f.properties, p0: from.get(sqKey(f))?.properties.p ?? 0 } }));
  for (const [kk, f] of from) if (!now.has(kk) && !burning.has(kk)) out.push({ ...f, properties: { ...f.properties, p0: f.properties.p, p: 0 } });   // shrink away
  return { towers: fc(out), byKey: now };
}

function bboxOf(features, points = []) {
  let w = 180, s = 90, e = -180, n = -90;
  const add = ([x, y]) => { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); };
  for (const f of features) for (const c of f.geometry.coordinates[0]) add(c);
  points.forEach(add);
  return w > e ? null : [[w, s], [e, n]];
}
const middle = b => [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2];
const pad4 = p => (typeof p === 'number' ? { top: p, bottom: p, left: p, right: p } : { top: 40, bottom: 40, left: 40, right: 40, ...p });

/** White wind streaks drawn over the map, blowing the way the wind goes (they turn with the camera). */
class Wind {
  constructor(map, centre) {
    this.map = map; this.centre = centre; this.toward = 0; this.kmh = 20; this.live = true; this.parts = [];
    this.canvas = h('canvas', { class: 'wind-canvas', 'aria-hidden': 'true' });
    map.getContainer().append(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.tick = this.tick.bind(this);
    requestAnimationFrame(this.tick);
  }
  set(wind) { if (wind) { this.toward = ((wind.from_deg ?? 0) + 180) % 360; this.kmh = wind.speed_kmh ?? 20; } }
  stop() { this.live = false; this.canvas.remove(); }
  tick() {
    if (!this.live) return;
    const c = this.canvas, box = this.map.getContainer(), w = box.clientWidth, ht = box.clientHeight;
    if (c.width !== w || c.height !== ht) { c.width = w; c.height = ht; }
    // which way "downwind" points on screen right now
    const [lon, lat] = this.centre, b = this.toward * Math.PI / 180;
    const p0 = this.map.project([lon, lat]);
    const p1 = this.map.project([lon + Math.sin(b) * 0.01 / Math.cos(lat * Math.PI / 180), lat + Math.cos(b) * 0.01]);
    let dx = p1.x - p0.x, dy = p1.y - p0.y;
    const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
    const v = 1.6 + this.kmh / 9;                                     // pixels per frame
    const ctx = this.ctx;
    ctx.globalCompositeOperation = 'destination-out';                 // fade the old streaks: trails
    ctx.fillStyle = 'rgba(0, 0, 0, 0.09)'; ctx.fillRect(0, 0, w, ht);
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.62)'; ctx.lineWidth = 1.4; ctx.lineCap = 'round';
    const want = Math.round(Math.min(200, w * ht / 4600));
    while (this.parts.length < want) this.parts.push({ x: Math.random() * w, y: Math.random() * ht, age: Math.random() * 80, life: 50 + Math.random() * 60 });
    ctx.beginPath();
    for (const q of this.parts) {
      const nx = q.x + dx * v, ny = q.y + dy * v;
      if (q.age > 0) { ctx.moveTo(q.x, q.y); ctx.lineTo(nx, ny); }
      q.x = nx; q.y = ny; q.age++;
      if (q.age > q.life || nx < -8 || ny < -8 || nx > w + 8 || ny > ht + 8) { q.x = Math.random() * w; q.y = Math.random() * ht; q.age = -1; }
    }
    ctx.stroke();
    requestAnimationFrame(this.tick);
  }
}

/** The clock in the corner, run from one time to another over ms (onTick gets each time). Resolves false if stopped. */
function runClock(alive, from, to, ms, onTick) {
  return new Promise(resolve => {
    const start = performance.now();
    const step = now => {
      if (!alive()) return resolve(false);
      const t = Math.max(0, Math.min(1, (now - start) / ms));
      onTick(from + (to - from) * t);
      if (t < 1) requestAnimationFrame(step); else resolve(true);
    };
    requestAnimationFrame(step);
  });
}

// the on-screen pieces
function makeHud(name, dayMs) {
  const el = {
    time: h('span', { class: 'mh-time mono' }), chip: h('span', { class: 'mh-chip' }),
    wind: h('div', { class: 'mh-wind' }), key: h('div', { class: 'mh-key' }),
  };
  el.root = h('div', { id: 'movie-hud' }, h('div', { class: 'mh-card' }, h('div', { class: 'mh-top' }, el.time, el.chip),
    h('div', { class: 'mh-sub' }, `${name} · ${DAY.format(new Date(dayMs))}`), el.wind, el.key));
  document.getElementById('map-area').append(el.root);
  return el;
}
const KEYS = { fire: ['k-fire', 'Burning (satellite)'], fc: ['k-fc', 'Forecast · taller = more likely'], ghost: ['k-ghost', 'Forecast'],
  hit: ['k-hit', 'Hit'], missed: ['k-missed', 'Missed'], false: ['k-false', 'False alarm'] };
function hudKey(hud, ...names) {
  fill(hud.key, names.map(n => { const [cls, text] = Array.isArray(n) ? n : KEYS[n]; return h('span', {}, h('i', { class: cls }), text); }));
}
function hudWind(hud, w) {
  if (!w) return fill(hud.wind);
  fill(hud.wind, windArrow(w.from_deg, 14), ` Wind ${fmtInt(w.speed_kmh)} km/h from the ${compass(w.from_deg)}, gusts ${fmtInt(w.gust_kmh)}`);
}
function captionBox(i, total, title, text) {
  if (!on) return;
  if (!on.box) { on.box = h('aside', { id: 'tour-box', 'aria-live': 'polite' }); document.getElementById('map-area').append(on.box); }
  fill(on.box,
    h('div', { class: 'tour-top' }, h('span', { class: 'tour-tag' }, '3D movie'), h('span', { class: 'tour-count mono' }, `${i + 1} / ${total}`),
      h('button', { class: 'tour-x', title: 'Stop (Esc)', onclick: () => stopTour() }, '✕')),
    h('div', { class: 'tour-title' }, title), h('div', { class: 'tour-text' }, text),
    h('div', { class: 'tour-dots' }, Array.from({ length: total }, (_, k) => h('i', { class: k < i ? 'done' : k === i ? 'on' : '' }))));
}

/**
 * Play the movie of the replay fire (or fireId), with the forecast made at `hour` (default: the hour on screen). Options:
 *   speak     Emberline reads each part aloud (the movie waits for the voice)
 *   captions  the caption box (the demo uses its own card instead)
 *   onStep    onStep(key) as the movie reaches 'space', 'forecast', 'h1', 'h2', 'h3', 'race', 'order', 'overlap',
 *             'check', 'town' and 'end' (the demo lights its card lines)
 *   padding   room to keep clear on the map (the demo card): a number, {top, bottom, left, right}, or a function
 *             that returns one (asked once the movie's own pieces are on screen)
 *   restore   put the normal map back at the end (the demo keeps the last frame until Next)
 * Resolves when the movie ends or is stopped.
 */
export async function startTour({ speak = false, captions = true, onStep = null, fireId = null, hour = null, restore = true, padding = 40 } = {}) {
  const me = ++run;
  const alive = () => me === run;
  slow = Math.min(10, Math.max(1, Number(window.emberlineMovieSlow) || 1));
  finish();
  if (app.mode !== 'replay') await app.go('replay', { fireId });
  else if (fireId) await R.open(fireId);
  if (!alive() || !R.state.meta) return;
  R.pause(); R.closeWhy();
  if (R.state.split) await R.split(false);
  R.realWind();

  // the forecast hour: the one on screen, moved on until the hour before it already has fire to show
  const fid = R.state.fireId, meta = R.state.meta, hours = meta.hours, nH = hours.length;
  let h0 = Math.max(1, Math.min(hour ?? R.state.hour, nH - 1));
  while (h0 < nH - 1 && !(hours[h0 - 1]?.fire_area_km2 > 0)) h0++;
  // load every hour the movie shows first, so nothing waits on a download while it plays
  const list = [h0 - 1, h0, h0 + 1, h0 + 2, h0 + 3].filter(k => k >= 0 && k < nH);
  let sits;
  try { sits = Object.fromEntries(await Promise.all(list.map(async k => [k, await api.getReplayHour(fid, k)]))); }
  catch (e) { console.warn('movie', e); return; }
  if (!alive()) return;
  const before = sits[h0 - 1], base = sits[h0], ahead = list.filter(k => k > h0);
  const last = sits[ahead[ahead.length - 1]] || base;
  const t0 = msOf(base.time_utc), tEnd = msOf(last.time_utc);

  // what it will say, all from the data
  const check = (meta.verification_by_hour || []).find(x => x.hour_idx === h0)?.k?.find(x => x.k === 3);
  const c = check && check.ok !== false && ahead.length === 3 ? check.model?.all : null;
  const iou = c && c.tp + c.fp + c.fn ? Math.round(100 * c.tp / (c.tp + c.fp + c.fn)) : null;
  const verify = c ? base.layers?.verify?.[2]?.features || [] : [];
  const town = (base.towns || []).find(t => t.status === 'EVACUATE') || (base.towns || []).find(t => t.status === 'WARNING') || null;
  const row = town && (meta.timeline || []).find(r => r.town === town.name);
  // the official order the movie shows: this town's if it falls inside the movie's hours and Emberline beat it, else any such
  const orders = (meta.timeline || []).filter(r => r.official_order_utc && r.first_warning_issued_utc && r.lead_vs_official_h > 0)
    .map(r => ({ ...r, t: msOf(r.official_order_utc), warned: msOf(r.first_warning_issued_utc) }))
    .filter(r => r.t > t0 && r.t < tEnd + 3600e3);
  const order = orders.find(r => r.town === town?.name) || orders.sort((a, b) => a.t - b.t)[0] || null;
  const name = meta.name || 'The fire';

  // on screen first (the clock panel; the demo card shrinks on phones), then the camera keeps clear of them
  const v = app.view, m = v.map;
  document.body.classList.add('tour-on');
  const hud = makeHud(name, t0);
  hud.time.textContent = clock(msOf((before || base).time_utc));
  on = {
    hud: hud.root, banner: null, box: null, label: null, wind: null,
    undo: putBack => {                       // put the normal replay map back
      Object.assign(R.state.toggles, { fire: true, forecast: true, actual: false, verify: false });
      v.setSelectedTown(null);
      if (!putBack || app.mode !== 'replay') return;
      R.layers({}); R.horizon(3); v.showRings(3);
      m.easeTo({ pitch: v.is3D ? 60 : 0, bearing: 0, duration: 800 });          // level the camera again
      if (R.state.fireId === fid && R.state.hour !== h0) R.hour(h0);
    },
  };
  const pad = pad4(typeof padding === 'function' ? padding() : padding);
  const mapBox = m.getContainer().getBoundingClientRect(), hudBox = hud.root.getBoundingClientRect();
  if (hudBox.width > mapBox.width * 0.6) pad.top = Math.max(pad.top, hudBox.bottom - mapBox.top + 8);     // phones: the clock spans the top
  const offset = [(pad.left - pad.right) / 2, (pad.top - pad.bottom) / 2];
  // the camera's view of the fire: everything that burns or may burn in the movie, plus the town
  const area = bboxOf([...(last.layers?.fire?.features || []), ...(base.layers?.forecast?.features || []).filter(f => f.properties.k === 3 && f.properties.p >= 0.275)],
    town ? [[town.lon, town.lat]] : []) || [[meta.bounds[0], meta.bounds[1]], [meta.bounds[2], meta.bounds[3]]];
  const centre = middle(area);
  const fit = m.cameraForBounds(area, { padding: { top: pad.top + 30, bottom: pad.bottom + 30, left: pad.left + 30, right: pad.right + 30 } });
  const zFire = Math.max(9.6, Math.min(11.8, (fit?.zoom ?? 11) - 0.45));
  const steps = ['space', 'forecast', ...(order || ahead.length ? ['race'] : []), ...(c ? ['check'] : []), ...(town ? ['town'] : [])];
  const total = steps.length;
  const part = async (key, title, text, ms, words = null) => {
    if (!alive()) return false;
    onStep?.(key);
    if (captions) captionBox(steps.indexOf(key), total, title, text);
    await Promise.all([sleep(T(ms)), speak ? say(words || text) : null]);
    return alive();
  };
  R.layers({ fire: false, forecast: false, actual: false, verify: false });
  v.setGroup('exits', false);
  v.setTowers({ fire: EMPTY, fc: EMPTY });
  v.setGroup('towers', true);
  v.map.setPaintProperty('tower-fc', 'fill-extrusion-opacity', 0.7);
  v.night(true, T(1600));                    // it is night in the movie: the base map dims, the towers and the wind stand out
  const setClock = ms => { hud.time.textContent = clock(ms); };

  // 1. from high above, swoop down onto the fire
  const start = before || base;
  await R.hour(before ? h0 - 1 : h0);
  if (!alive()) return;
  setClock(msOf(start.time_utc)); hud.chip.textContent = 'SATELLITE';
  hudWind(hud, start.wind); hudKey(hud, 'fire');
  if (m.getZoom() > zFire - 1.6 || m.getPitch() > 5) {    // start high: rise up first if the map is close in
    m.easeTo({ center: centre, zoom: Math.min(8.8, zFire - 2.4), pitch: 0, bearing: 0, duration: T(1000) });
    if (!await sleep(T(1050)).then(alive)) return;
  }
  on.wind = new Wind(m, centre);
  on.wind.set(start.wind);
  v.setTowers({ fire: fireTowers(start, null) });
  v.growTowers(T(1600));
  m.flyTo({ center: centre, zoom: zFire, pitch: 60, bearing: -26, offset, duration: T(3600), curve: 1.5, essential: true });
  const dir = DIRS[compass(start.wind.from_deg)] || compass(start.wind.from_deg);
  if (!await part('space', `${clock(msOf(start.time_utc))} · seen from space`,
    `Each red tower is a 2 km square the GOES-18 weather satellite sees burning. The white streaks are the real wind, ${fmtInt(start.wind.speed_kmh)} km/h from the ${dir}, gusting to ${fmtInt(start.wind.gust_kmh)}.`,
    3700)) return;

  // 2. the forecast: orange towers for +1, +2 and +3 hours, taller = more likely to burn
  if (before) {
    if (!await runClock(alive, msOf(before.time_utc), t0, T(600), setClock)) return;
    await R.hour(h0);
    if (!alive()) return;
    v.setTowers({ fire: fireTowers(base, before) });
    v.growTowers(T(700));
  }
  setClock(t0); hud.chip.textContent = 'FORECAST';
  on.wind.set(base.wind); hudWind(hud, base.wind); hudKey(hud, 'fire', 'fc');
  m.easeTo({ center: centre, offset, bearing: -12, duration: T(4000), easing: t => t });
  const burning0 = keysOf(base);
  const forecastText = 'Orange towers are where Emberline expects the fire in the next 1, 2 and 3 hours. Taller means more likely to burn.';
  onStep?.('forecast');
  if (captions) captionBox(steps.indexOf('forecast'), total, `${clock(t0)} · the forecast`, forecastText);
  const voice1 = speak ? say(forecastText) : null;
  let prevFc = new Map();
  for (const k of [1, 2, 3]) {
    if (!await sleep(T(k === 1 ? 500 : 1100)).then(alive)) return;
    const { towers, byKey } = forecastTowers(base, k, burning0, prevFc);
    prevFc = byKey;
    v.setTowers({ fc: towers });
    v.growTowers(T(900), { fire: false, fc: true });
    onStep?.('h' + k);
  }
  await Promise.all([sleep(T(1300)), voice1]);
  if (!alive()) return;

  // 3. the night runs on: the real fire grows into the forecast, and the official order comes
  let shown = base;
  if (ahead.length) {
    m.setPaintProperty('tower-fc', 'fill-extrusion-opacity', 0.3);
    const ghostOf = sit => forecastTowers(base, ahead.length, keysOf(sit)).towers;
    v.setTowers({ fc: ghostOf(base) });
    hud.chip.textContent = 'REAL FIRE';
    hudKey(hud, ['k-fire', 'Real fire (satellite)'], ['k-ghost', `Forecast for ${clock(t0 + ahead.length * 3600e3)}`]);
    m.easeTo({ center: centre, offset, bearing: 4, zoom: zFire + 0.15, duration: T(1300) * ahead.length + 1000, easing: t => t });
    const raceText = `The clock runs to ${clock(tEnd)}. Red towers are what the satellite really saw. The faint orange is the forecast it had to match.`;
    const raceWords = 'The clock runs on, and the real fire grows into the forecast.' +
      (order ? ` At ${clock(order.t)} came the official evacuation order for ${order.town}, ${spokenLead(order.t - order.warned)} after Emberline first warned.` : '');
    onStep?.('race');
    if (captions) captionBox(steps.indexOf('race'), total, 'The real fire grows into it', raceText);
    const voice2 = speak ? say(raceWords) : null;
    let next = 0;
    const ok = await runClock(alive, t0, tEnd, T(1300 * ahead.length), ms => {
      setClock(ms);
      while (next < ahead.length && ms >= msOf(sits[ahead[next]].time_utc)) {          // a new satellite hour
        const sit = sits[ahead[next++]];
        R.hour(ahead[next - 1]);              // the panel, timeline and town colours follow the clock
        v.setTowers({ fire: fireTowers(sit, shown), fc: ghostOf(sit) });
        v.growTowers(T(700));
        on.wind?.set(sit.wind); hudWind(hud, sit.wind);
        shown = sit;
      }
      if (order && !on.banner && ms >= order.t) showOrder(order);
    });
    if (!ok) return;
    if (order && !on.banner && order.t <= tEnd + 3600e3) showOrder(order);       // an order late in the last hour
    await Promise.all([sleep(T(1000)), voice2]);
    if (!alive()) return;
  }

  // 4. the check: how much of the real fire was inside the forecast, square by square
  if (c) {
    hud.chip.textContent = 'THE CHECK';
    m.easeTo({ center: centre, offset, bearing: 14, duration: T(3800), easing: t => t });
    if (!await part('overlap', `${clock(tEnd)} · the check`, `${iou}% of the real fire at ${clock(tEnd)} overlapped the forecast made at ${clock(t0)}.`, 1200)) return;
    const mid = middle(bboxOf(base.layers?.fire?.features || []) || area);
    const d2 = f => { const [x, y] = middle(bboxOf([f])); return (x - mid[0]) ** 2 + (y - mid[1]) ** 2; };
    const order_ = [...verify].sort((a, b) => d2(a) - d2(b));
    const real = shown.layers?.fire?.features || [];
    v.setTowers({ fc: EMPTY });
    hudKey(hud, 'hit', 'missed', 'false');
    onStep?.('check');
    if (captions) captionBox(steps.indexOf('check'), total, 'Square by square', `${c.tp} green hits, ${c.fn} pink misses and ${c.fp} grey false alarm${c.fp === 1 ? '' : 's'}.`);
    const voice3 = speak ? say(`${iou} percent overlap. Square by square, ${c.tp} hits, ${c.fn} misses and ${c.fp} false alarm${c.fp === 1 ? '' : 's'}.`) : null;
    const per = Math.max(40, Math.min(110, 1300 / Math.max(1, order_.length)));
    for (let i = 1; i <= order_.length; i++) {
      const done = new Set(order_.slice(0, i).map(sqKey));
      v.setTowers({ fire: fc([...order_.slice(0, i).map(f => ({ ...f, properties: { ...f.properties, fresh: 0 } })),
        ...real.filter(f => !done.has(sqKey(f))).map(f => ({ ...f, properties: { ...f.properties, fresh: 0 } }))]) });
      if (!await sleep(T(per)).then(alive)) return;
    }
    await Promise.all([sleep(T(1200)), voice3]);
    if (!alive()) return;
  }

  // 5. down to the town most in danger
  if (town) {
    on.banner?.remove(); on.banner = null;
    v.setTowers({ fire: fireTowers(shown, shown), fc: EMPTY });
    hud.chip.textContent = 'IN THE WAY'; hudKey(hud, ['k-fire', 'Real fire']);
    const fireMid = middle(bboxOf(shown.layers?.fire?.features || []) || area);
    const look = Math.atan2((fireMid[0] - town.lon) * Math.cos(town.lat * Math.PI / 180), fireMid[1] - town.lat) * 180 / Math.PI;
    v.setSelectedTown(town.name);
    m.flyTo({ center: [town.lon, town.lat], zoom: Math.min(12.4, zFire + 0.7), pitch: 64, bearing: look, offset: [offset[0], offset[1] + Math.min(90, (mapBox.height - pad.top - pad.bottom) * 0.2)], duration: T(3200), essential: true });
    on.label = new maplibregl.Marker({ element: h('div', { class: 'movie-label' }, h('b', {}, town.name),
      h('span', {}, `${fmtInt(town.population)} people · ${town.status}`)), anchor: 'bottom', offset: [0, -22] }).setLngLat([town.lon, town.lat]).addTo(m);
    const warned = row?.first_warning_issued_utc ? msOf(row.first_warning_issued_utc) : null;
    const official = row?.official_order_utc ? msOf(row.official_order_utc) : null;
    const text = `${fmtInt(town.population)} people.` + (warned ? ` Emberline warned at ${clock(warned)}.` : '') +
      (official ? ` The official evacuation order came at ${clock(official)}.` : '');
    if (!await part('town', town.name, text, 3400)) return;
  }
  onStep?.('end');
  if (restore && alive()) {
    finish(true);
    m.fitBounds(area, { padding: { top: pad.top + 50, bottom: pad.bottom + 50, left: pad.left + 50, right: pad.right + 50 }, maxZoom: 11,
      pitch: v.is3D ? 55 : 0, bearing: 0, duration: T(1800) });
  }

  function showOrder(o) {
    const lead = Math.round((o.t - o.warned) / 60000);
    on.banner = h('div', { id: 'movie-banner', role: 'status' }, h('span', { class: 'mb-time mono' }, clock(o.t)),
      h('div', {}, h('b', {}, `Official evacuation order for ${o.town}.`),
        ` Emberline first warned at ${clock(o.warned)}, ${Math.floor(lead / 60) ? `${Math.floor(lead / 60)} h ` : ''}${lead % 60} min earlier.`));
    hud.root.append(on.banner);            // under the clock
    onStep?.('order');
  }
}

function spokenLead(ms) {
  const min = Math.round(ms / 60000), hh = Math.floor(min / 60), mm = min % 60;
  return [hh ? `${hh} hour${hh > 1 ? 's' : ''}` : '', mm ? `${mm} minutes` : ''].filter(Boolean).join(' ');
}
