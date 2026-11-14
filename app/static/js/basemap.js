// ─────────────────────────────────────────────────────────────────────────────
// basemap.js - loads the OpenFreeMap "liberty" style and makes it earthy and muted,
// so the fire data is the only strong colour on the map.
// If the style cannot be downloaded (offline), we fall back to a plain dark background.
// ─────────────────────────────────────────────────────────────────────────────
import { BASE_STYLE_URL, TERRAIN_TILES } from './config.js';

const SATURATION = 0.38;                 // 1 = original colours, 0 = grey
const PAPER = [226, 220, 205];           // warm paper tone that every colour is pulled toward
const PAPER_MIX = 0.16;

// Base-map layers that only add clutter under the fire data
const DROP_LAYERS = [/^poi_/, /^building-3d$/, /^road_one_way/, /^airport$/, /^highway-name-(path|minor)$/,
  /^label_(other|village|town)$/, /^water_name_point_label$/];

// Terrain sources: one for the hillshade layer, one for 3D (MapLibre wants them separate).
function demSource() {
  return { type: 'raster-dem', tiles: [TERRAIN_TILES], encoding: 'terrarium', tileSize: 256, maxzoom: 15,
           attribution: 'Terrain: AWS Terrain Tiles' };
}

/** Plain dark style used when the base map cannot be loaded. Data layers still show on top. */
export function fallbackStyle() {
  return { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#262b30' } }] };
}

/** Download the base style, mute it, and add hillshade. Never throws: returns the fallback style on any error. */
export async function loadBaseStyle() {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 7000);
    const res = await fetch(BASE_STYLE_URL, { signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error('style HTTP ' + res.status);
    return muteStyle(await res.json());
  } catch (e) {
    console.warn('Base map not available, using plain background:', e.message);
    return fallbackStyle();
  }
}

function muteStyle(style) {
  style.layers = style.layers.filter(l => !DROP_LAYERS.some(rx => rx.test(l.id)));
  for (const layer of style.layers) {
    for (const [key, value] of Object.entries(layer.paint || {})) {
      if (key.endsWith('-color')) layer.paint[key] = mapColors(value);
    }
    if (layer.type === 'raster') layer.paint = { ...layer.paint, 'raster-saturation': -0.6, 'raster-opacity': 0.6 };
    if (layer.type === 'symbol') layer.paint = { ...layer.paint, 'text-opacity': 0.75, 'icon-opacity': 0.6 };
  }
  // hillshade goes above the land cover and below water/roads
  style.sources['dem-hillshade'] = demSource();
  style.sources['dem-terrain'] = demSource();
  const at = style.layers.findIndex(l => l.id === 'waterway_tunnel');
  style.layers.splice(at < 0 ? 2 : at, 0, {
    id: 'hillshade', type: 'hillshade', source: 'dem-hillshade',
    paint: { 'hillshade-exaggeration': 0.45, 'hillshade-shadow-color': '#4b4033',
             'hillshade-highlight-color': '#fffaf0', 'hillshade-accent-color': '#6b5d4b' },
  });
  return style;
}

/** Walk a paint value (plain string, expression array or {stops}) and mute every colour inside it. */
function mapColors(v) {
  if (typeof v === 'string') { const c = parseColor(v); return c ? muted(c) : v; }
  if (Array.isArray(v)) return v.map(mapColors);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapColors(x)]));
  return v;
}

function muted([r, g, b, a]) {
  const grey = 0.3 * r + 0.59 * g + 0.11 * b;
  const mix = x => {
    const desat = grey + (x - grey) * SATURATION;
    return Math.round(desat);
  };
  const out = [mix(r), mix(g), mix(b)].map((x, i) => Math.round(x * (1 - PAPER_MIX) + PAPER[i] * PAPER_MIX * (x / 255 + 0.35)));
  return `rgba(${Math.min(255, out[0])},${Math.min(255, out[1])},${Math.min(255, out[2])},${a})`;
}

/** Parse #rgb, #rrggbb, rgb(), rgba(), hsl(), hsla() → [r, g, b, a] or null if it is not a colour. */
function parseColor(s) {
  s = s.trim().toLowerCase();
  let m;
  if ((m = /^#([0-9a-f]{3})$/.exec(s))) return [...m[1]].map(ch => parseInt(ch + ch, 16)).concat(1);
  if ((m = /^#([0-9a-f]{6})$/.exec(s))) return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)).concat(1);
  if ((m = /^rgba?\(([^)]+)\)$/.exec(s))) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
    return p.length >= 3 ? [p[0], p[1], p[2], p[3] ?? 1] : null;
  }
  if ((m = /^hsla?\(([^)]+)\)$/.exec(s))) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
    return p.length >= 3 ? [...hslToRgb(p[0], p[1] / 100, p[2] / 100), p[3] ?? 1] : null;
  }
  return null;
}

function hslToRgb(hDeg, s, l) {
  const k = n => (n + hDeg / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)].map(x => Math.round(x * 255));
}
