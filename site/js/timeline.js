// timeline.js - the bottom bar in REPLAY mode.
//   left:  fire picker, clock, play / pause / step, speed, split screen, "Run copilot at HH:MM"
//   right: scrubber over all replay hours with three lanes of marks + a fire-area sparkline
//
// The timeline does not know about the map. It calls the functions in `on` (given by mode_replay.js):
//   on.hour(h)  on.playToggle()  on.step(±1)  on.speed(i)  on.split()  on.copilot()  on.fire(id)
import { h, svg, fill, $, fmtInt, showTooltip, hideTooltip, pacific } from './util.js';
import { segmented } from './app.js';

const ICON = {
  play: 'M7 4 L20 12 L7 20 Z',
  pause: 'M6 4 H10 V20 H6 Z M14 4 H18 V20 H14 Z',
  prev: 'M6 4 H9 V20 H6 Z M20 4 L10 12 L20 20 Z',
  next: 'M15 4 H18 V20 H15 Z M4 4 L14 12 L4 20 Z',
};
const icon = name => svg('svg', { viewBox: '0 0 24 24', width: 14, height: 14 }, svg('path', { d: ICON[name], fill: 'currentColor' }));

export class Timeline {
  constructor(root, on) {
    this.root = root; this.on = on;
    this.meta = null;
  }

  /** Build the whole bar for a fire. fires = /api/replay list, meta = /api/replay/{id}. */
  build(fires, meta, ui) {
    this.meta = meta;
    const n = meta.hours.length;
    this.pct = hr => Math.max(0, Math.min(100, (hr / (n - 1)) * 100));
    // position of an exact time (official orders are published to the minute)
    const t0 = new Date(meta.hours[0].time_utc).getTime();
    this.hourOf = iso => (new Date(iso).getTime() - t0) / 3600000;

    // left: controls
    const fireSelect = h('select', { id: 'tl-fire', title: 'Replay fire', onchange: e => this.on.fire(e.target.value) },
      fires.map(f => h('option', { value: f.fire_id, selected: f.fire_id === meta.fire_id }, f.name)));
    this.timeEl = h('span', { class: 'tl-time mono' });
    this.hourEl = h('span', { class: 'tl-hour mono' });
    this.playBtn = h('button', { class: 'btn btn-icon btn-play', id: 'tl-play', title: 'Play / pause (space)', onclick: () => this.on.playToggle() });
    this.splitBtn = h('button', { class: 'btn', id: 'tl-split', title: 'Two maps side by side', onclick: () => this.on.split() }, 'Split screen');
    this.runBtn = h('button', { class: 'btn btn-primary', id: 'tl-run', onclick: () => this.on.copilot() });
    const left = h('div', { class: 'tl-left' },
      h('div', { class: 'tl-row' }, fireSelect, this.timeEl, this.hourEl),
      h('div', { class: 'tl-row' },
        h('button', { class: 'btn btn-icon', id: 'tl-prev', title: 'Back 1 hour (←)', onclick: () => this.on.step(-1) }, icon('prev')),
        this.playBtn,
        h('button', { class: 'btn btn-icon', id: 'tl-next', title: 'Forward 1 hour (→)', onclick: () => this.on.step(1) }, icon('next')),
        segmented([[0, '1 h/s'], [1, '1 h/2 s']], ui.speedIdx, i => this.on.speed(i), 'seg-small'),
        this.splitBtn, this.runBtn));

    // right: lanes + sparkline + axis
    const orders = meta.official_orders || [];
    this.cursor = h('div', { class: 'tl-cursor' });
    this.track = h('div', { class: 'tl-track' },
      this._lane('warn', this._marks(meta.timeline, 'first_warning_hour', 'first flagged by Emberline')),
      this._lane('arrive', this._marks(meta.timeline, 'fire_arrival_hour', 'fire reached town')),
      orders.length
        ? this._lane('official', this._orderMarks(orders))
        : h('div', { class: 'tl-lane tl-lane-note' }, meta.official_orders_note || 'No official evacuation times for this fire.'),
      this._spark(meta.hours),
      this._axis(meta.hours),
      this.cursor);
    this._scrubbing(this.track, n);

    const labels = h('div', { class: 'tl-labels' },
      h('span', { class: 'lab-warn' }, 'Our first warning'), h('span', { class: 'lab-arrive' }, 'Fire reaches town'),
      h('span', { class: 'lab-official' }, 'Official order / warning'), h('span', { class: 'lab-spark' }, 'Fire area'),
      h('span', { class: 'lab-peak mono' }, `peak ${fmtInt(Math.max(...meta.hours.map(x => x.fire_area_km2)))} km²`));
    fill(this.root, left, labels, h('div', { class: 'tl-track-wrap' }, this.track));
    this.update(ui);
  }

  /** Refresh everything that depends on the current hour / play state. */
  update(ui) {
    if (!this.meta) return;
    const hr = this.meta.hours[ui.hour];
    const hm = hr.time_local.slice(-5);
    this.timeEl.textContent = hr.time_local;
    this.hourEl.textContent = `HOUR ${ui.hour}/${this.meta.hours.length - 1}`;
    fill(this.playBtn, icon(ui.playing ? 'pause' : 'play'));
    this.playBtn.classList.toggle('on', ui.playing);
    this.splitBtn.classList.toggle('on', ui.split);
    this.runBtn.textContent = ui.copilotRan ? `Copilot at ${hm}: show` : `Run copilot at ${hm}`;
    this.runBtn.disabled = !hr.has_forecast;
    this.cursor.style.left = this.pct(ui.hour) + '%';
    this.cursor.dataset.label = hm;
  }

  // pieces
  _lane(kind, marks) { return h('div', { class: 'tl-lane tl-lane-' + kind }, marks); }

  /** One tick per hour that has an event; towns that share an hour share a tick. */
  _marks(timeline, field, what) {
    const byHour = new Map();
    for (const t of timeline) {
      if (t[field] === null || t[field] === undefined) continue;
      if (!byHour.has(t[field])) byHour.set(t[field], []);
      byHour.get(t[field]).push(t);
    }
    return [...byHour].map(([hour, towns]) => {
      // a warning made from hour h's satellite data can only go out when hour h ends
      const issued = field === 'first_warning_hour';
      const at = issued ? hour + 1 : hour;
      const when = issued ? pacific(towns[0].first_warning_issued_utc) : (this.meta.hours[hour]?.time_local || `hour ${hour}`);
      const names = towns.map(t => t.town + (field === 'fire_arrival_hour' && t.lead_h > 0 ? ` (warned ${t.lead_h} h before)` : '')).join(', ');
      return this._tick(at, `${names} · ${what} ${when}`);
    });
  }

  /** Official orders/warnings from data/evac_orders.csv, placed at their published time (to the minute). */
  _orderMarks(orders) {
    return orders.map(o => {
      if (!o.order_time_utc) return null;
      const at = this.hourOf(o.order_time_utc);
      if (at < 0 || at > this.meta.hours.length - 1) return null;
      return this._tick(at, `${o.town} · official evacuation ${o.order_type} ${pacific(o.order_time_utc)}` +
        (o.precision === 'approx' ? ' (approximate)' : ''), o.order_type === 'warning' ? 'tl-tick-soft' : '');
    });
  }

  _tick(hour, tip, extra = '') {
    return h('span', { class: 'tl-tick ' + extra, style: `left:${this.pct(hour)}%`,
      onmouseenter: e => { const r = e.target.getBoundingClientRect(); showTooltip(tip, r.left + r.width / 2, r.top); },
      onmouseleave: hideTooltip });
  }

  _spark(hours) {
    const n = hours.length, max = Math.max(1, ...hours.map(x => x.fire_area_km2));
    const pts = hours.map((x, i) => `${i},${(100 - (x.fire_area_km2 / max) * 92).toFixed(1)}`);
    return h('div', { class: 'tl-spark' },
      svg('svg', { viewBox: `0 0 ${n - 1} 100`, preserveAspectRatio: 'none' },
        svg('path', { d: `M0,100 L${pts.join(' L')} L${n - 1},100 Z`, class: 'spark-area' }),
        svg('path', { d: `M${pts.join(' L')}`, class: 'spark-line', 'vector-effect': 'non-scaling-stroke' })));
  }

  _axis(hours) {
    const labels = [];
    hours.forEach((x, i) => {
      const [day, mon, hm] = x.time_local.split(' ');
      const hh = parseInt(hm, 10);
      if (hh % 6 !== 0) return;
      labels.push(h('span', { class: 'tl-axis-label' + (hh === 0 ? ' day' : ''), style: `left:${this.pct(i)}%` }, hh === 0 ? `${day} ${mon}` : hm));
    });
    return h('div', { class: 'tl-axis mono' }, labels);
  }

  /** Click or drag anywhere on the track to jump to that hour. */
  _scrubbing(track, n) {
    const hourAt = e => {
      const r = track.getBoundingClientRect();
      return Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / r.width) * (n - 1))));
    };
    let dragging = false;
    track.addEventListener('pointerdown', e => { dragging = true; track.setPointerCapture(e.pointerId); this.on.hour(hourAt(e)); });
    track.addEventListener('pointermove', e => { if (dragging) this.on.hour(hourAt(e)); });
    const stop = () => { dragging = false; };
    track.addEventListener('pointerup', stop); track.addEventListener('pointercancel', stop);
  }
}
