// tour.js - a self-driving tour of the replay fire on screen. The map tilts into 3D and circles the fire while the
// forecast grows one hour at a time, then the real fire 3 hours later is laid over it and checked square by square,
// and the tour ends on the town in the most danger. A box on the map explains each step, and Emberline can read it
// aloud (speech.js). Every caption is built from the data of the fire and hour on screen.
// Started from the "3D tour" button (REPLAY), from the Ask Emberline guide ("give me a tour"), or by the guided demo.
import { app } from './app.js';
import { h, fill, sleep, fmtInt, localHM } from './util.js';
import { replayApi as R } from './mode_replay.js';
import { leaveBy, clockPlus } from './leaveby.js';
import { say, hush } from './speech.js';

let run = 0;            // a new tour, or stopTour(), ends the one that is running
let box = null;

export function stopTour() { run++; finish(); }

function finish() {
  hush();
  box?.remove(); box = null;
  document.body.classList.remove('tour-on');
}

document.addEventListener('keydown', e => { if (e.key === 'Escape' && box) stopTour(); });

/** The steps for this fire and hour, in plain words, with the numbers taken from the data. */
function steps(sit, meta, hour) {
  const n = sit.numbers || {}, fc = n.forecast_area_km2 || [];
  const now = localHM(sit.time_local);
  const at = k => clockPlus(sit.time_local, k) || `+${k} h`;
  const check = (meta.verification_by_hour || []).find(x => x.hour_idx === hour)?.k?.find(x => x.k === 3);
  const c = check && check.ok !== false ? check.model?.all : null;
  const iou = c && c.tp + c.fp + c.fn ? Math.round(100 * c.tp / (c.tp + c.fp + c.fn)) : null;
  const top = (sit.towns || []).find(t => t.status === 'EVACUATE') || (sit.towns || []).find(t => t.status === 'WARNING');
  const lb = top ? leaveBy(sit, top.name) : null;
  const list = [
    { key: 'now', title: `Now · ${now}`,
      text: `${fmtInt(n.fire_area_km2)} km² is burning. Each red square is 2 km of land, seen from space by the GOES-18 weather satellite.`,
      go: () => { R.layers({ fire: true, forecast: false, actual: false, verify: false }); } },
    ...[1, 2, 3].map(k => ({ key: 'h' + k, title: `+${k} hour${k > 1 ? 's' : ''} · ${at(k)}`,
      text: k === 1 ? `The model expects about ${fmtInt(fc[0])} km² burning. Orange squares may burn next; darker means more likely.`
        : k === 2 ? `About ${fmtInt(fc[1])} km². The model uses its own forecast as the new fire and steps forward again.`
        : `About ${fmtInt(fc[2])} km². The dotted line is where it expects the edge in 3 hours.`,
      go: () => { R.layers({ forecast: true }); R.horizon(k); app.view.showRings(k); } })),
  ];
  if (c) {
    list.push({ key: 'real', title: `What really happened · ${at(3)}`,
      text: `The dark squares are the fire the satellite really saw 3 hours later. Our forecast overlapped it ${iou}%.`,
      go: () => { R.layers({ actual: true }); app.view.fadeInActual(); } });
    list.push({ key: 'check', title: 'Square by square',
      text: `${c.tp} squares hit (green), ${c.fn} missed (pink) and ${c.fp} false alarm${c.fp === 1 ? '' : 's'} (grey).`,
      go: () => { R.layers({ verify: true }); } });
  }
  if (top) {
    list.push({ key: 'town', title: `In the way · ${top.name}`,
      text: `${top.name} (${fmtInt(top.population)} people) is on ${top.status}. ${lb?.text || ''}`.trim(),
      go: () => { R.layers({ verify: false, actual: false, fire: true, forecast: true }); R.town(top.name); } });
  }
  return list;
}

/** Fit the camera close on the fire, its forecast and any town told to evacuate. */
function fitFire(sit, padding) {
  let w = 180, s = 90, e = -180, nn = -90;
  const add = ([x, y]) => { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); nn = Math.max(nn, y); };
  const walk = c => (typeof c[0] === 'number' ? add(c) : c.forEach(walk));
  for (const key of ['fire', 'forecast']) for (const f of sit.layers?.[key]?.features || []) walk(f.geometry.coordinates);
  for (const t of sit.towns || []) if (t.status === 'EVACUATE') add([t.lon, t.lat]);
  if (w > e) return;
  const pad = Math.max(e - w, nn - s) * 0.12 + 0.02;
  app.view.map.fitBounds([[w - pad, s - pad], [e + pad, nn + pad]], { padding, duration: 1200, pitch: app.view.is3D ? 58 : 0, bearing: 0 });
}

/** Turn a little around the fire, then hold still so the new squares can draw (3D when the map has terrain). */
function glide(ms) {
  const m = app.view.map;
  m.easeTo({ pitch: app.view.is3D ? 58 : 0, bearing: m.getBearing() - 12, duration: Math.max(600, Math.min(ms - 400, 2200)) });
}

function showBox(i, total, step) {
  if (!box) { box = h('aside', { id: 'tour-box', 'aria-live': 'polite' }); document.getElementById('map-area').append(box); }
  fill(box,
    h('div', { class: 'tour-top' }, h('span', { class: 'tour-tag' }, '3D tour'), h('span', { class: 'tour-count mono' }, `${i + 1} / ${total}`),
      h('button', { class: 'tour-x', title: 'Stop the tour (Esc)', onclick: stopTour }, '✕')),
    h('div', { class: 'tour-title' }, step.title),
    h('div', { class: 'tour-text' }, step.text),
    h('div', { class: 'tour-dots' }, Array.from({ length: total }, (_, k) => h('i', { class: k < i ? 'done' : k === i ? 'on' : '' }))));
}

/**
 * Run the tour. Options: speak (read each step aloud), captions (the box; the demo uses its own card instead),
 * onStep(i, step) (the demo lights its card lines), pace (ms per step), fireId / hour (where to tour), restore
 * (put the layers back afterwards), only (step keys to play), padding (camera padding, e.g. room for the demo card).
 * Resolves when the tour ends or is stopped.
 */
export async function startTour({ speak = false, captions = true, onStep = null, pace = null, fireId = null, hour = null, restore = true,
                                  only = null, padding = 40 } = {}) {
  const me = ++run;
  const alive = () => me === run;
  if (app.mode !== 'replay') await app.go('replay', { fireId });
  else if (fireId) await R.open(fireId);
  if (hour !== null && hour !== undefined) await R.hour(hour);
  if (!alive() || !R.state.sit) return;
  R.pause(); R.closeWhy();
  if (R.state.split) await R.split(false);
  R.realWind();
  const list = steps(R.state.sit, R.state.meta, R.state.hour).filter(x => !only || only.includes(x.key));
  const was3D = app.view.is3D;
  document.body.classList.add('tour-on');
  fitFire(R.state.sit, padding);
  if (!was3D) app.set3D(true);                     // ignored where there is no terrain (the claude.ai copy)
  await sleep(1300);
  if (!alive()) return;
  for (let i = 0; i < list.length; i++) {
    if (!alive()) return;
    const step = list[i];
    if (captions) showBox(i, list.length, step);
    onStep?.(i, step);
    step.go();
    if (step.key !== 'town') glide(pace?.[i] ?? 4200);           // the town step flies to the town itself
    await Promise.all([sleep(pace?.[i] ?? 4200), speak ? say(step.text) : null]);
  }
  if (!alive()) return;
  finish();
  if (restore) {
    R.layers({ fire: true, forecast: true, actual: false, verify: false });
    R.horizon(3); app.view.showRings(3);
    if (!was3D) app.set3D(false);
  }
}
