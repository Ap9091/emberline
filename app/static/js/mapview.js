// ─────────────────────────────────────────────────────────────────────────────
// mapview.js - one MapLibre map with all Emberline data layers.
// The app creates one MapView for the main map and a second one for the left half of the split screen.
//
//   const view = new MapView('map-main', style);
//   await view.ready;
//   view.showSituation(sit);        // INCIDENT / REPLAY data (fire, forecast, rings, towns, exits)
//   view.showState(state, onClick); // STATE data (fire pixels + incident markers)
//   view.setGroup('forecast', false) // layer toggles
// ─────────────────────────────────────────────────────────────────────────────
import { COLORS, TERRAIN_EXAGGERATION, PITCH_3D, SPLIT_FADE } from './config.js';
import { h } from './util.js';

const EMPTY = { type: 'FeatureCollection', features: [] };

// Dash pattern for the +1 h / +2 h / +3 h rings: solid, dashed, dotted
const RING_DASH = [null, [3, 2], [0.6, 1.8]];

// Layer groups that can be switched on/off. Each group lists the MapLibre layer ids it controls.
const GROUPS = {
  fire: ['fire-fill', 'fire-line'],
  forecast: ['forecast-fill'],
  rings: ['ring-casing-1', 'ring-1', 'ring-casing-2', 'ring-2', 'ring-casing-3', 'ring-3'],
  baseline: ['baseline'],
  actual: ['actual-fill', 'actual-line'],
  exits: ['exit-casing', 'exit-clear', 'exit-blocked', 'exit-approved-casing', 'exit-approved'],
  pixels: ['pixel-glow', 'pixel-core'],
  verify: ['verify-fill', 'verify-line'],
};

export class MapView {
  /**
   * @param container  id of the map <div>
   * @param style      MapLibre style object from basemap.js
   * @param options    {neutralTowns: true} draws every town grey (the "what officials could see" map)
   */
  constructor(container, style, options = {}) {
    this.options = options;
    this.sit = null;                 // situation on screen
    this.horizon = 3;                // forecast hour shown as squares: 1, 2 or 3
    this.visible = { fire: true, forecast: true, rings: true, baseline: false, actual: false, exits: true, pixels: true, towns: true, verify: false };
    this.selectedTown = null;        // town whose exits are shown
    this.plan = null;                // AI plan on screen (its evacuation towns also show exits)
    this.approved = false;           // plan approved → highlight the chosen routes
    this.townMarkers = new Map();    // name → {marker, el}
    this.incidentMarkers = [];
    this.onTownClick = null;
    this.is3D = false;
    this._fadeTimer = null;

    this.map = new maplibregl.Map({
      container, style, center: [-119.6, 37.3], zoom: 5, maxPitch: 75,
      attributionControl: { compact: true }, fadeDuration: 0,
    });
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }), 'top-right');
    this.map.addControl(new maplibregl.ScaleControl({ unit: 'metric', maxWidth: 90 }), 'bottom-right');
    this.map.on('error', e => console.warn('map:', e?.error?.message || e));
    this.map.on('move', () => this._placeLabelsSoon());
    this.ready = new Promise(resolve => this.map.on('load', () => { this._addLayers(); resolve(); }));
  }

  // ── set-up: all sources and layers, bottom to top ──────────────────────────
  _addLayers() {
    const m = this.map;
    // California only: everything outside the state is covered, the border drawn, Los Angeles County ready to glow
    // (california.geojson: US Census 2024 cartographic boundaries, simplified; see app/make_california.py)
    m.addSource('california', { type: 'geojson', data: 'california.geojson' });
    m.addLayer({ id: 'ca-mask', type: 'fill', source: 'california', filter: ['==', ['get', 'kind'], 'mask'],
      paint: { 'fill-color': '#15181b', 'fill-opacity': 0.86 } });
    m.addLayer({ id: 'la-fill', type: 'fill', source: 'california', filter: ['==', ['get', 'kind'], 'la'],
      layout: { visibility: 'none' }, paint: { 'fill-color': '#ffb454', 'fill-opacity': 0.16 } });
    m.addLayer({ id: 'la-line', type: 'line', source: 'california', filter: ['==', ['get', 'kind'], 'la'],
      layout: { visibility: 'none', 'line-join': 'round' }, paint: { 'line-color': '#ffb454', 'line-width': 2.2 } });
    m.addLayer({ id: 'ca-line', type: 'line', source: 'california', filter: ['==', ['get', 'kind'], 'ca'],
      paint: { 'line-color': '#e6e9ec', 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.8, 9, 1.6], 'line-opacity': 0.55 } });
    for (const id of ['forecast', 'actual', 'fire', 'verify', 'baseline', 'ring-1', 'ring-2', 'ring-3', 'exits', 'pixels']) {
      m.addSource(id, { type: 'geojson', data: EMPTY });
    }

    // forecast squares: opacity = probability
    m.addLayer({ id: 'forecast-fill', type: 'fill', source: 'forecast', paint: {
      'fill-color': COLORS.forecast,
      'fill-opacity': ['interpolate', ['linear'], ['get', 'p'], 0.05, 0.08, 0.3, 0.3, 0.65, 0.5, 1, 0.68],
    } });

    // real fire 1-3 h later (replay only)
    m.addLayer({ id: 'actual-fill', type: 'fill', source: 'actual', paint: { 'fill-color': COLORS.actual, 'fill-opacity': 0.6 } });
    m.addLayer({ id: 'actual-line', type: 'line', source: 'actual', paint: { 'line-color': COLORS.actual, 'line-width': 0.6, 'line-opacity': 0.6 } });

    // fire now
    m.addLayer({ id: 'fire-fill', type: 'fill', source: 'fire', paint: { 'fill-color': COLORS.fire, 'fill-opacity': 0.82 } });
    m.addLayer({ id: 'fire-line', type: 'line', source: 'fire', paint: { 'line-color': COLORS.fireEdge, 'line-width': 0.7, 'line-opacity': 0.7 } });

    // "Was it right?" (replay): every square of the forecast or of the real fire k hours later
    const byResult = ['match', ['get', 'result'], 'hit', COLORS.hit, 'missed', COLORS.missed, COLORS.falseAlarm];
    m.addLayer({ id: 'verify-fill', type: 'fill', source: 'verify', paint: {
      'fill-color': byResult,
      'fill-opacity': ['match', ['get', 'result'], 'false_alarm', 0.32, 0.78] } });
    m.addLayer({ id: 'verify-line', type: 'line', source: 'verify', paint: {
      'line-color': byResult, 'line-width': ['match', ['get', 'result'], 'false_alarm', 1.2, 0.6],
      'line-opacity': 0.95 } });

    // baseline "grow 1 km/h" ring for the selected hour
    m.addLayer({ id: 'baseline', type: 'line', source: 'baseline', layout: { 'line-cap': 'butt' },
      paint: { 'line-color': COLORS.baseline, 'line-width': 1.4, 'line-dasharray': [4, 3] } });

    // forecast rings +1/+2/+3 h: a dark casing under a bright line so they read on any background
    for (const k of [1, 2, 3]) {
      const dash = RING_DASH[k - 1];
      const round = k === 3;     // dotted ring = round caps on a tiny dash
      m.addLayer({ id: `ring-casing-${k}`, type: 'line', source: `ring-${k}`, layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': COLORS.ringCasing, 'line-width': k === 1 ? 4.2 : 3.4, 'line-opacity': k === 1 ? 0.95 : 0.65 } });
      m.addLayer({ id: `ring-${k}`, type: 'line', source: `ring-${k}`,
        layout: { 'line-cap': round ? 'round' : 'butt', 'line-join': 'round' },
        paint: { 'line-color': COLORS.ring, 'line-width': k === 1 ? 2.2 : 1.7, ...(dash ? { 'line-dasharray': dash } : {}) } });
    }

    // exits of the selected / planned towns
    const lineLayout = { 'line-cap': 'round', 'line-join': 'round' };
    // approved route = wide white band UNDER the road line, so a blocked (red dashed) road still shows as blocked
    m.addLayer({ id: 'exit-approved-casing', type: 'line', source: 'exits', layout: lineLayout,
      paint: { 'line-color': '#101316', 'line-width': 12 } });
    m.addLayer({ id: 'exit-approved', type: 'line', source: 'exits', layout: lineLayout,
      paint: { 'line-color': COLORS.exitApproved, 'line-width': 8.5 } });
    m.addLayer({ id: 'exit-casing', type: 'line', source: 'exits', layout: lineLayout,
      paint: { 'line-color': '#ffffff', 'line-width': 6, 'line-opacity': 0.75 } });
    m.addLayer({ id: 'exit-clear', type: 'line', source: 'exits', layout: lineLayout,
      paint: { 'line-color': COLORS.exitClear, 'line-width': 3 } });
    m.addLayer({ id: 'exit-blocked', type: 'line', source: 'exits', layout: { 'line-join': 'round' },
      paint: { 'line-color': COLORS.exitBlocked, 'line-width': 3.2, 'line-dasharray': [1.6, 1.2] } });

    // GOES fire pixels on the state map: a soft glow under a small core
    m.addLayer({ id: 'pixel-glow', type: 'circle', source: 'pixels', paint: {
      'circle-color': COLORS.pixel, 'circle-blur': 1, 'circle-opacity': 0.55,
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 7, 8, 14, 11, 26] } });
    m.addLayer({ id: 'pixel-core', type: 'circle', source: 'pixels', paint: {
      'circle-color': COLORS.fire, 'circle-stroke-color': '#fff3e0', 'circle-stroke-width': 0.6,
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 1.8, 8, 3, 11, 5] } });

    this._applyVisibility();
    this._applyExitFilters();
  }

  // ── data ───────────────────────────────────────────────────────────────────
  _setData(source, data) { this.map.getSource(source)?.setData(data || EMPTY); }

  /** Draw an INCIDENT / REPLAY situation. Pass null to clear. */
  showSituation(sit) {
    this.sit = sit;
    const L = sit?.layers || {};
    this._setData('fire', L.fire);
    this._setData('forecast', L.forecast);
    for (const k of [1, 2, 3]) this._setData(`ring-${k}`, L.forecast_rings?.[k - 1]);
    this._setData('exits', L.exits);
    this._applyHorizon();
    this._updateTownMarkers(sit?.towns || []);
    this._baseLabels(!sit);
  }

  /** Draw the STATE map: every fire pixel + one ringed marker per incident. */
  showState(state, onIncidentClick) {
    this.clearState();
    this._setData('pixels', state?.pixels);
    for (const inc of state?.incidents || []) {
      const size = Math.round(Math.max(22, Math.min(70, 16 + Math.sqrt(inc.area_km2) * 2.6)));
      const el = h('div', { class: 'incident-marker', title: `#${inc.rank} near ${inc.nearest_town}`, onclick: () => onIncidentClick?.(inc) },
        h('span', { class: 'ring', style: `width:${size}px;height:${size}px` }),
        h('span', { class: 'rank' }, inc.rank));
      this.incidentMarkers.push(new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([inc.lon, inc.lat]).addTo(this.map));
    }
  }

  clearState() {
    this._setData('pixels', EMPTY);
    this.incidentMarkers.forEach(mk => mk.remove());
    this.incidentMarkers = [];
  }

  // ── towns: HTML markers (crisp IBM Plex labels, work without map fonts) ────
  _updateTownMarkers(towns) {
    const seen = new Set();
    for (const t of towns) {
      seen.add(t.name);
      let entry = this.townMarkers.get(t.name);
      if (!entry) {
        const el = h('div', { class: 'town-marker', onclick: ev => { ev.stopPropagation(); this.onTownClick?.(t.name); } },
          h('span', { class: 'dot' }), h('span', { class: 'label' }, t.name));
        const marker = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([t.lon, t.lat]).addTo(this.map);
        entry = { marker, el };
        this.townMarkers.set(t.name, entry);
      }
      entry.el.dataset.status = this.options.neutralTowns ? 'NONE' : t.status;
      entry.el.classList.toggle('selected', t.name === this.selectedTown);
      entry.el.style.display = this.visible.towns ? '' : 'none';
    }
    for (const [name, entry] of this.townMarkers) {
      if (!seen.has(name)) { entry.marker.remove(); this.townMarkers.delete(name); }
    }
    this._placeLabelsSoon();
  }

  _placeLabelsSoon() {
    if (this._labelFrame) return;
    this._labelFrame = requestAnimationFrame(() => { this._labelFrame = null; this._placeLabels(); });
  }

  /**
   * Keep town labels from covering each other: the most urgent towns choose first, and each label
   * takes the first free side of its dot (right, left, above, below). data-side is used by app.css.
   */
  _placeLabels() {
    const towns = (this.sit?.towns || []).filter(t => this.townMarkers.has(t.name));   // already sorted by urgency
    const taken = [];
    const hits = box => taken.some(b => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]);
    for (const t of towns) {
      const p = this.map.project([t.lon, t.lat]);
      const urgent = !this.options.neutralTowns && t.status !== 'MONITOR';
      const w = t.name.length * (urgent ? 6.9 : 6.1) + (urgent ? 14 : 2), hgt = urgent ? 19 : 14, gap = urgent ? 10 : 7;
      const sides = {
        right: [p.x + gap, p.y - hgt / 2, p.x + gap + w, p.y + hgt / 2],
        left: [p.x - gap - w, p.y - hgt / 2, p.x - gap, p.y + hgt / 2],
        above: [p.x - w / 2, p.y - gap - hgt, p.x + w / 2, p.y - gap],
        below: [p.x - w / 2, p.y + gap, p.x + w / 2, p.y + gap + hgt],
      };
      // no free side: EVACUATE towns keep their label anyway, the others show only their dot
      const side = Object.keys(sides).find(k => !hits(sides[k])) || (t.status === 'EVACUATE' && urgent ? 'right' : 'none');
      if (side !== 'none') taken.push(sides[side]);
      taken.push([p.x - 7, p.y - 7, p.x + 7, p.y + 7]);
      this.townMarkers.get(t.name).el.dataset.side = side;
    }
  }

  /** Base-map city labels would duplicate our town labels, so hide them while a situation is shown. */
  _baseLabels(show) {
    for (const id of ['label_city', 'label_city_capital']) {
      if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', show ? 'visible' : 'none');
    }
  }

  // ── layer toggles ──────────────────────────────────────────────────────────
  setGroup(group, on) {
    this.visible[group] = on;
    if (group === 'towns') this._updateTownMarkers(this.sit?.towns || []);
    else this._applyVisibility();
  }

  _applyVisibility() {
    for (const [group, ids] of Object.entries(GROUPS)) {
      for (const id of ids) {
        if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', this.visible[group] ? 'visible' : 'none');
      }
    }
  }

  /** Los Angeles County outline (used by the demo). */
  showLA(on) {
    for (const id of ['la-fill', 'la-line']) if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }

  /** Which forecast hour (1, 2 or 3) the squares, the baseline ring and the "real fire later" layer show. */
  setHorizon(k) { this.horizon = k; this._applyHorizon(); }

  _applyHorizon() {
    const L = this.sit?.layers || {};
    if (this.map.getLayer('forecast-fill')) this.map.setFilter('forecast-fill', ['==', ['get', 'k'], this.horizon]);
    this._setData('baseline', L.baseline_rings?.[this.horizon - 1]);
    this._setData('actual', L.actual_future?.[this.horizon - 1]);
    this._setData('verify', L.verify?.[this.horizon - 1]);
  }

  // ── exits ──────────────────────────────────────────────────────────────────
  setSelectedTown(name) {
    this.selectedTown = name;
    for (const [n, entry] of this.townMarkers) entry.el.classList.toggle('selected', n === name);
    this._applyExitFilters();
  }

  /** Show the exits of the plan's evacuation towns; approved = highlight the chosen routes. */
  setPlan(plan, approved = false) {
    this.plan = plan; this.approved = approved;
    this._applyExitFilters();
  }

  _applyExitFilters() {
    if (!this.map.getLayer('exit-clear')) return;
    const evac = (this.plan?.evacuate || []).filter(e => e && e.town);
    const towns = [...new Set([this.selectedTown, ...evac.map(e => e.town)].filter(Boolean))];
    const inTowns = ['in', ['get', 'town'], ['literal', towns]];
    this.map.setFilter('exit-casing', inTowns);
    this.map.setFilter('exit-clear', ['all', inTowns, ['!', ['get', 'blocked_1h']]]);
    this.map.setFilter('exit-blocked', ['all', inTowns, ['get', 'blocked_1h']]);
    // approved routes: match town + exit id pairs
    const pairs = this.approved ? evac.map(e => `${e.town}|${e.exit}`) : [];
    const isApproved = ['in', ['concat', ['get', 'town'], '|', ['get', 'id']], ['literal', pairs]];
    this.map.setFilter('exit-approved-casing', isApproved);
    this.map.setFilter('exit-approved', isApproved);
  }

  // ── camera ─────────────────────────────────────────────────────────────────
  /** Zoom to [west, south, east, north]. */
  fit(bounds, { animate = true, padding = 48 } = {}) {
    if (!bounds) return;
    this.map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]],
      { padding, pitch: this.is3D ? PITCH_3D : 0, bearing: 0, duration: animate ? 900 : 0 });
  }

  /** Move the camera so the town and all of its exits are in view. */
  flyToTown(town) {
    const box = new maplibregl.LngLatBounds([town.lon, town.lat], [town.lon, town.lat]);
    for (const f of this.sit?.layers?.exits?.features || []) {
      if (f.properties.town === town.name) f.geometry.coordinates.forEach(c => box.extend(c));
    }
    this.map.fitBounds(box, { padding: { top: 70, bottom: 70, left: 250, right: 70 }, maxZoom: 10.2, duration: 900,
      pitch: this.is3D ? PITCH_3D : 0 });
  }

  /** Switch 3D terrain on or off. */
  set3D(on, animate = true) {
    this.is3D = on;
    if (this.map.getSource('dem-terrain')) {
      this.map.setTerrain(on ? { source: 'dem-terrain', exaggeration: TERRAIN_EXAGGERATION } : null);
    }
    this.map.easeTo({ pitch: on ? PITCH_3D : 0, bearing: 0, duration: animate ? 700 : 0 });
    this.on3D?.(on);                 // lets the top bar keep its 2D/3D buttons in step
  }

  resize() { this.map.resize(); }

  // ── split screen: fade the real fire 3 h later in over the forecast ────────
  fadeInActual() {
    this.cancelFade();
    this.horizon = 3; this._applyHorizon();
    this.visible.actual = true; this._applyVisibility();
    const setOpacity = o => {
      this.map.setPaintProperty('actual-fill', 'fill-opacity', o);
      this.map.setPaintProperty('actual-line', 'line-opacity', o);
    };
    setOpacity(0);
    this._fadeTimer = setTimeout(() => {
      const start = performance.now();
      const step = now => {
        const t = Math.min(1, (now - start) / SPLIT_FADE.durationMs);
        setOpacity(SPLIT_FADE.opacity * t);
        if (t < 1) this._fadeFrame = requestAnimationFrame(step);
      };
      this._fadeFrame = requestAnimationFrame(step);
    }, SPLIT_FADE.delayMs);
  }

  cancelFade() {
    clearTimeout(this._fadeTimer);
    cancelAnimationFrame(this._fadeFrame);
    if (this.map.getLayer('actual-fill')) {
      this.map.setPaintProperty('actual-fill', 'fill-opacity', 0.6);
      this.map.setPaintProperty('actual-line', 'line-opacity', 0.6);
    }
  }
}

/** Keep two maps on the same camera (used by the split screen). Returns a function that stops the sync. */
export function syncMaps(a, b) {
  let busy = false;
  const follow = (from, to) => () => {
    if (busy) return;
    busy = true;
    to.jumpTo({ center: from.getCenter(), zoom: from.getZoom(), bearing: from.getBearing(), pitch: from.getPitch() });
    busy = false;
  };
  const ab = follow(a.map, b.map), ba = follow(b.map, a.map);
  a.map.on('move', ab); b.map.on('move', ba);
  ab();
  return () => { a.map.off('move', ab); b.map.off('move', ba); };
}
