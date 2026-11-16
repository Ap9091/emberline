// whatif_engine.js - "what if the wind changes?" computed IN THE BROWSER (hosted version only).
//
// The hosted page has no Python server, so this file runs the same steps as the backend
// (app/backend/whatif.py + src/p2_build_dataset.py + src/p3_core.py + app/backend/situation.py):
//   1. features of every candidate square at hour h (from the burning squares known at h)
//   2. the trained logistic regression → chance each square burns in 1 h
//   3. roll forward: the forecast fire becomes "the fire at h+1", features again → +2 h, then +3 h
//   4. town countdowns (EVACUATE / WARNING / MONITOR) and exit-road checks
// with the wind for hours h..h+3 replaced by the scenario wind. The inputs come from data/whatif/*.json,
// written by app/whatif_export.py; app/check_whatif.mjs checks that the answers match the Python backend.

const cache = new Map();
async function json(url) {
  if (!cache.has(url)) cache.set(url, fetch(url).then(r => { if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.json(); }));
  return cache.get(url);
}
export const loadModel = base => json(`${base}/whatif/model.json`);
export const loadFire = (base, fid) => json(`${base}/whatif/${fid}.json`);

const N_HOURS = 74;
const COMPASS8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const STATUS_RANK = { EVACUATE: 0, WARNING: 1, MONITOR: 2 };
const round = (x, d) => { const f = 10 ** d; return Math.round(x * f) / f; };

// 1. features (port of p2_build_dataset.features_for_hour)
/**
 * rows: burning rows [hour, row, col, gapfilled(0/1), max_power_mw|null], nFiles: per-hour file counts,
 * weather: per-hour arrays. Returns {cells: [i...], X: [[...features in model order]]} or null.
 */
function features(F, M, rows, nFiles, weather, h) {
  const N = F.n, S = F.static, cellKm = M.cell_km;
  if (!nFiles[h]) return null;
  const burn = new Uint8Array(N * N), ever = new Uint8Array(N * N);
  let nNow = 0, nBefore = 0, power = 0, powerN = 0;
  for (const [hr, r, c, gap, p] of rows) {
    const known = hr < h || (hr === h && !gap);
    if (!known) continue;
    ever[r * N + c] = 1;
    if (hr === h) { burn[r * N + c] = 1; nNow++; if (p !== null && p !== undefined) { power += p; powerN++; } }
  }
  if (!nNow) return null;
  for (const [hr, , , gap] of rows) if (hr === h - 1 && !gap) nBefore++;
  const bCells = [];
  for (let i = 0; i < N * N; i++) if (burn[i]) bCells.push(i);

  // distances (km) to the nearest burning square, burning squares within 4 km, burning neighbours
  const dist = new Float64Array(N * N), within = new Int32Array(N * N), neigh = new Int32Array(N * N);
  for (let i = 0; i < N * N; i++) {
    const r = Math.floor(i / N), c = i % N;
    let best = Infinity, n4 = 0;
    for (const j of bCells) {
      const d = Math.hypot(r - Math.floor(j / N), c - (j % N)) * cellKm;
      if (d < best) best = d;
      if (d <= M.near_km) n4++;
    }
    dist[i] = best; within[i] = n4;
    let nb = 0;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const rr = r + dr, cc = c + dc;
      if (rr >= 0 && rr < N && cc >= 0 && cc < N && burn[rr * N + cc]) nb++;
    }
    neigh[i] = nb;
  }

  // whole-fire numbers
  let everN = 0; for (let i = 0; i < N * N; i++) everN += ever[i];
  const area = nNow * cellKm * cellKm;
  const growth = (h === 0 || !nFiles[h - 1]) ? NaN : (nNow - nBefore) * cellKm * cellKm;
  const frp = powerN ? power : NaN;
  const local = F.hours.local_hour[h];
  const isNight = (local < 6 || local >= 20) ? 1 : 0;
  const W = k => weather[k][h];
  const u = W('wind_u_kmh'), v = W('wind_v_kmh'), speed = W('wind_speed_kmh');
  let fx = 0, fy = 0, fe = 0;
  for (const j of bCells) { fx += S.x[j]; fy += S.y[j]; fe += S.elevation_m[j]; }
  fx /= bCells.length; fy /= bCells.length; fe /= bCells.length;
  const windLen = Math.hypot(u, v);

  const cells = [], X = [];
  for (let i = 0; i < N * N; i++) {
    if (dist[i] > M.candidate_km) continue;
    const dx = S.x[i] - fx, dy = S.y[i] - fy;
    const len = Math.hypot(dx, dy) * windLen;
    const downwind = len > 0 ? (dx * u + dy * v) / len : 0;
    const elevDiff = S.elevation_m[i] - fe;
    const f = {
      burning_now: burn[i], ever_burned: ever[i], distance_to_fire_km: dist[i], burning_neighbours: neigh[i],
      burning_within_4km: within[i], fire_area_now_km2: area, growth_last_hour_km2: growth,
      burned_area_so_far_km2: everN * cellKm * cellKm, hours_since_start: h - 1, hour_of_day_local: local, is_night: isNight,
      wind_speed_kmh: speed, wind_gust_kmh: W('wind_gust_kmh'), humidity_pct: W('humidity_pct'), temp_c: W('temp_c'),
      downwind, downwind_x_speed: downwind * speed, elevation_diff_m: elevDiff,
      upslope: elevDiff / Math.max(dist[i], 1.0), slope_deg: S.slope_deg[i], elevation_m: S.elevation_m[i],
      frac_tree: S.frac_tree[i], frac_shrub: S.frac_shrub[i], frac_grass: S.frac_grass[i], frac_crop: S.frac_crop[i],
      frac_built: S.frac_built[i], frac_water: S.frac_water[i], frp_now_mw: frp,
    };
    const row = M.numeric.map(k => f[k]);
    for (const code of M.veg_codes) row.push(S.veg_class[i] === code ? 1 : 0);
    cells.push(i); X.push(row);
  }
  return { cells, X };
}

// 2. the trained logistic regression: fill missing → scale → weighted sum → probability
function predict(M, X) {
  return X.map(row => {
    let z = M.intercept;
    for (let k = 0; k < row.length; k++) {
      let x = Number.isFinite(row[k]) ? Math.fround(row[k]) : M.median[k];     // model inputs were float32
      z += M.coef[k] * ((x - M.mean[k]) / M.scale[k]);
    }
    return 1 / (1 + Math.exp(-z));
  });
}

const asFire = (p, ever, th) => ever ? p >= th.burn : p >= th.new;

// A square that is almost all water (sea, lake) cannot burn: its chance is 0 (same rule as WATER_MAX in p3_core.py)
export const WATER_MAX = 0.9;
const isWater = (F, i) => F.static.frac_water[i] >= WATER_MAX;

// 3. forecast with rolling forward (port of p3_core.forecast)
function forecast(F, M, weather, h) {
  const N = F.n, th = M.th;
  const rows0 = F.burning.filter(([hr, , , gap]) => hr < h || (hr === h && !gap));      // what was known at hour h
  let feats = features(F, M, rows0, F.hours.n_files, weather, h);
  if (!feats) return null;
  const out = [new Float64Array(N * N), new Float64Array(N * N), new Float64Array(N * N)];
  let rows = rows0.slice();
  const ever = new Uint8Array(N * N);
  for (const [, r, c] of rows0) ever[r * N + c] = 1;
  const nFiles = F.hours.n_files.slice();
  const pw = rows0.filter(x => x[0] === h && x[4] !== null).map(x => x[4]);
  const power = pw.length ? pw.reduce((a, b) => a + b, 0) / pw.length : null;
  for (let k = 1; k <= 3; k++) {
    const p = predict(M, feats.X);
    feats.cells.forEach((i, n) => { out[k - 1][i] = isWater(F, i) ? 0 : p[n]; });
    if (k === 3 || h + k >= N_HOURS) break;
    const pred = [];
    for (let i = 0; i < N * N; i++) if (asFire(out[k - 1][i], ever[i], th)) pred.push(i);
    if (!pred.length) break;
    for (const i of pred) ever[i] = 1;
    rows = rows.filter(x => x[0] < h + k).concat(pred.map(i => [h + k, Math.floor(i / N), i % N, 0, power]));
    nFiles[h + k] = 1;
    feats = features(F, M, rows, nFiles, weather, h + k);
    if (!feats) break;
  }
  return out;
}

// drawing helpers (port of backend/geo.py)
function corner(F, r, c) { return F.corners[r * (F.n + 1) + c]; }
function squareFeature(F, i, props) {
  const r = Math.floor(i / F.n), c = i % F.n;
  return { type: 'Feature', id: i, properties: { row: r, col: c, ...props },
    geometry: { type: 'Polygon', coordinates: [[corner(F, r, c), corner(F, r, c + 1), corner(F, r + 1, c + 1), corner(F, r + 1, c), corner(F, r, c)]] } };
}
function outline(F, mask, props) {
  const N = F.n, lines = [];
  const on = (r, c) => r >= 0 && r < N && c >= 0 && c < N && mask[r * N + c];
  for (let i = 0; i < N * N; i++) {
    if (!mask[i]) continue;
    const r = Math.floor(i / N), c = i % N;
    if (!on(r - 1, c)) lines.push([corner(F, r, c), corner(F, r, c + 1)]);
    if (!on(r + 1, c)) lines.push([corner(F, r + 1, c), corner(F, r + 1, c + 1)]);
    if (!on(r, c - 1)) lines.push([corner(F, r, c), corner(F, r + 1, c)]);
    if (!on(r, c + 1)) lines.push([corner(F, r, c + 1), corner(F, r + 1, c + 1)]);
  }
  return { type: 'FeatureCollection', features: lines.length ? [{ type: 'Feature', properties: props, geometry: { type: 'MultiLineString', coordinates: lines } }] : [] };
}

// 4. the scenario situation (port of whatif.scenario + situation.build)
/**
 * base = the real situation for this hour (from data/replay/...), h = hour.
 * Returns a situation object shaped exactly like the backend's, or null if there is no forecast at this hour.
 */
export function scenario(F, M, base, h, fromDeg, speedKmh) {
  const N = F.n, th = M.th, cellKm = M.cell_km;
  fromDeg = ((fromDeg % 360) + 360) % 360;
  const speed = Math.max(0, Math.min(speedKmh, 120));
  // weather with the scenario wind for hours h..h+3 (gusts keep the real gust/speed ratio)
  const weather = Object.fromEntries(Object.entries(F.weather).map(([k, a]) => [k, a.slice()]));
  const ratio = weather.wind_gust_kmh[h] / Math.max(weather.wind_speed_kmh[h], 1);
  for (let k = h; k <= Math.min(h + 3, N_HOURS - 1); k++) {
    weather.wind_speed_kmh[k] = speed; weather.wind_gust_kmh[k] = speed * ratio; weather.wind_dir_deg[k] = fromDeg;
    weather.wind_u_kmh[k] = -speed * Math.sin(fromDeg * Math.PI / 180);
    weather.wind_v_kmh[k] = -speed * Math.cos(fromDeg * Math.PI / 180);
  }
  const probs = forecast(F, M, weather, h);
  if (!probs) return null;

  // the fire as the replay shows it (GOES squares incl. one-hour gap fills): now and everything burned so far
  const now = new Uint8Array(N * N), ever = new Uint8Array(N * N);
  for (const [hr, r, c] of F.burning) { if (hr === h) now[r * N + c] = 1; if (hr <= h) ever[r * N + c] = 1; }
  // forecast fire area at +1/+2/+3 h (rolled the same way as the model)
  const rings = [], e = ever.slice();
  for (let k = 0; k < 3; k++) {
    const ring = new Uint8Array(N * N);
    for (let i = 0; i < N * N; i++) if (asFire(probs[k][i], e[i], th)) ring[i] = 1;
    for (let i = 0; i < N * N; i++) if (ring[i]) e[i] = 1;
    rings.push(ring);
  }
  const danger = now.map((v, i) => v || rings[0][i]);
  const within2h = now.map((v, i) => v || rings[0][i] || rings[1][i]);
  const later = now.map((v, i) => v || rings[0][i] || rings[1][i] || rings[2][i]);

  // town countdowns (port of situation.town_statuses)
  const nowCells = []; for (let i = 0; i < N * N; i++) if (now[i]) nowCells.push(i);
  let cx = null, cy = null;
  if (nowCells.length) {
    cx = F.xmin + (nowCells.reduce((a, i) => a + (i % N), 0) / nowCells.length + 0.5) * F.cell_m;
    cy = F.ymax - (nowCells.reduce((a, i) => a + Math.floor(i / N), 0) / nowCells.length + 0.5) * F.cell_m;
  }
  const towns = [], exits = {}, exitFeatures = [];
  for (const t of F.towns) {
    const near = t.near.map(([r, c]) => r * N + c);
    const atNow = near.some(i => now[i]);
    const ringK = [0, 1, 2].filter(k => near.some(i => rings[k][i])).map(k => k + 1);
    const chance = [0, 1, 2].map(k => near.length ? Math.max(...near.map(i => probs[k][i])) : 0);
    const flagK = [0, 1, 2].filter(k => chance[k] >= M.t_town).map(k => k + 1);
    let dist = Infinity;
    for (const i of nowCells) {
      const sx = F.xmin + ((i % N) + 0.5) * F.cell_m, sy = F.ymax - (Math.floor(i / N) + 0.5) * F.cell_m;
      dist = Math.min(dist, Math.hypot(sx - t.x, sy - t.y) / 1000);
    }
    let status, eta;
    if (atNow) { status = 'EVACUATE'; eta = 0; }
    else if (ringK.length && ringK[0] === 1) { status = 'EVACUATE'; eta = 1; }
    else if (ringK.length || flagK.length) { status = 'WARNING'; eta = Math.min(...ringK, ...flagK); }
    else if (dist <= 20) { status = 'MONITOR'; eta = null; }
    else continue;
    const item = { name: t.name, status, eta_h: eta, dist_km: round(dist, 1), chance_3h: round(Math.max(...chance), 3),
                   population: t.population, lat: t.lat, lon: t.lon };
    if (cx !== null) {
      const deg = Math.atan2(t.x - cx, t.y - cy) * 180 / Math.PI;
      item.bearing_from_fire = COMPASS8[Math.floor((((deg % 360) + 360) % 360 + 22.5) / 45) % 8];
    }
    towns.push(item);
    if (status === 'EVACUATE' || status === 'WARNING') {
      exits[t.name] = t.exits.map(ex => {
        const firstHit = mask => { for (const [r, c, km] of ex.path) if (mask[r * N + c]) return round(km, 1); return null; };
        const b1 = firstHit(danger), b2 = firstHit(within2h), b3 = firstHit(later);
        exitFeatures.push({ type: 'Feature', properties: { id: ex.id, town: t.name, blocked_1h: b1 !== null, blocked_3h: b3 !== null },
          geometry: { type: 'LineString', coordinates: ex.coords } });
        return { id: ex.id, road: ex.road, direction: ex.direction, length_km: ex.length_km, blocked_1h_at_km: b1, blocked_2h_at_km: b2, blocked_3h_at_km: b3 };
      });
    }
  }
  towns.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || (a.eta_h || 9) - (b.eta_h || 9) || b.population - a.population);

  const area = mask => round(mask.reduce((a, v) => a + v, 0) * cellKm * cellKm, 1);
  const forecastSquares = [];
  for (let k = 0; k < 3; k++) for (let i = 0; i < N * N; i++) if (probs[k][i] >= 0.05) forecastSquares.push(squareFeature(F, i, { p: round(probs[k][i], 3), k: k + 1 }));
  const real = base.wind;
  return {
    ...base,
    data_note: `WHAT-IF scenario: wind ${Math.round(speed)} km/h from ${Math.round(fromDeg)} deg for the next 3 h ` +
      `(real: ${real.speed_kmh} km/h from ${real.from_deg} deg). Forecast re-run by the trained model in your browser.`,
    wind: { ...real, speed_kmh: round(speed, 1), gust_kmh: round(speed * ratio, 1), from_deg: Math.round(fromDeg) },
    numbers: {
      fire_area_km2: base.numbers.fire_area_km2, growth_last_hour_km2: base.numbers.growth_last_hour_km2,
      forecast_area_km2: rings.map(area),
      residents_evacuate: towns.filter(t => t.status === 'EVACUATE').reduce((a, t) => a + (t.population || 0), 0),
      residents_warning: towns.filter(t => t.status === 'WARNING').reduce((a, t) => a + (t.population || 0), 0),
    },
    towns, exits, verification: null,
    layers: {
      ...base.layers,
      forecast: { type: 'FeatureCollection', features: forecastSquares },
      forecast_rings: rings.map((r, k) => outline(F, r, { k: k + 1 })),
      exits: { type: 'FeatureCollection', features: exitFeatures },
      towns: { type: 'FeatureCollection', features: towns.map(({ lat, lon, ...p }) => ({ type: 'Feature', properties: p, geometry: { type: 'Point', coordinates: [lon, lat] } })) },
      verify: [],
    },
    whatif: {
      from_deg: Math.round(fromDeg), speed_kmh: round(speed, 1), gust_kmh: round(speed * ratio, 1), real_wind: real,
      real_forecast_area_km2: base.numbers.forecast_area_km2,
      note: 'Only the wind changes; fire, terrain, vegetation and towns are real. Computed in your browser by the same trained model.',
    },
  };
}

// 5. "Why this square?" The model is a logistic regression (a weighted sum), so its reasons for one square are exact:
//    each input moves the answer up or down by coef × (scaled value), and the moves add up to the model's chance.
//    The inputs are grouped into plain-word reasons. Explains the chance of burning within the next hour at hour h.
const REASONS = [
  ['fire', 'Nearby fire', ['burning_now', 'ever_burned', 'distance_to_fire_km', 'burning_neighbours', 'burning_within_4km']],
  ['size', 'Fire size and growth', ['fire_area_now_km2', 'growth_last_hour_km2', 'burned_area_so_far_km2', 'frp_now_mw']],
  ['wind', 'Wind', ['wind_speed_kmh', 'wind_gust_kmh', 'downwind', 'downwind_x_speed']],
  ['air', 'Humidity and temperature', ['humidity_pct', 'temp_c']],
  ['slope', 'Slope and height', ['elevation_diff_m', 'upslope', 'slope_deg', 'elevation_m']],
  ['plants', 'Plants on the ground', ['frac_tree', 'frac_shrub', 'frac_grass', 'frac_crop', 'frac_built', 'frac_water', 'veg_']],
  ['time', 'Time of day', ['hours_since_start', 'hour_of_day_local', 'is_night']],
];
const VEG_NAMES = { 10: 'trees', 20: 'shrubs', 30: 'grass', 40: 'crops', 50: 'buildings', 60: 'bare ground', 70: 'snow',
                    80: 'water', 90: 'wetland', 95: 'mangroves', 100: 'moss' };

function cellAt(F, lon, lat) {
  const N = F.n, k = Math.cos(lat * Math.PI / 180);
  let cell = -1, best = Infinity;
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const a = corner(F, r, c), b = corner(F, r + 1, c + 1);
    const d = (((a[0] + b[0]) / 2 - lon) * k) ** 2 + ((a[1] + b[1]) / 2 - lat) ** 2;
    if (d < best) { best = d; cell = r * N + c; }
  }
  return Math.sqrt(best) * 111 > 2.5 ? -1 : cell;            // more than about one square away: outside the fire's box
}

/** Explain one square at hour h. where = {lon, lat} or {cell}. Returns {ok:false, why} or the reasons. */
export function explain(F, M, h, where) {
  const N = F.n, cell = where.cell ?? cellAt(F, where.lon, where.lat);
  if (cell < 0) return { ok: false, why: 'outside' };
  const rows0 = F.burning.filter(([hr, , , gap]) => hr < h || (hr === h && !gap));
  const feats = features(F, M, rows0, F.hours.n_files, F.weather, h);
  if (!feats) return { ok: false, why: 'nofire' };
  const n = feats.cells.indexOf(cell);
  if (n < 0) return { ok: false, why: 'far' };             // more than 6 km from the fire: the model does not score it
  if (isWater(F, cell)) return { ok: false, why: 'water', square: squareFeature(F, cell, {}) };   // the sea or a lake: it cannot burn
  const row = feats.X[n];
  const v = Object.fromEntries(M.features.map((name, j) => [name, row[j]]));
  const push = M.features.map((name, j) => {
    const x = Number.isFinite(row[j]) ? Math.fround(row[j]) : M.median[j];
    return M.coef[j] * ((x - M.mean[j]) / M.scale[j]);
  });
  const z = M.intercept + push.reduce((a, b) => a + b, 0);
  const sum = keys => M.features.reduce((t, name, j) => t + (keys.some(k => name === k || (k.endsWith('_') && name.startsWith(k))) ? push[j] : 0), 0);
  const fmt = (x, d = 0) => Number.isFinite(x) ? round(x, d).toLocaleString('en-US') : '-';
  const veg = Object.entries(VEG_NAMES).find(([code]) => v['veg_' + code] === 1);
  const side = v.downwind > 0.3 ? 'blowing toward it' : v.downwind < -0.3 ? 'blowing away from it' : 'blowing across it';
  const facts = {
    fire: v.burning_now ? 'burning right now'
      : `${v.distance_to_fire_km <= 2.9 ? 'right next to the fire' : `${fmt(v.distance_to_fire_km, 1)} km from the fire`}, ${v.burning_neighbours} burning square${v.burning_neighbours === 1 ? '' : 's'} touching it`,
    size: `${fmt(v.fire_area_now_km2)} km² burning, ${v.growth_last_hour_km2 >= 0 ? '+' : ''}${fmt(v.growth_last_hour_km2)} km² in the last hour`,
    wind: `${fmt(v.wind_speed_kmh)} km/h, gusts ${fmt(v.wind_gust_kmh)}, ${side}`,
    air: `humidity ${fmt(v.humidity_pct)}%, ${fmt(v.temp_c, 1)}°C`,
    slope: `${fmt(Math.abs(v.elevation_diff_m))} m ${v.elevation_diff_m >= 0 ? 'above' : 'below'} the fire, ${fmt(v.slope_deg)}° slope`,
    plants: veg ? `mostly ${veg[1]}` : 'mixed ground cover',
    time: `${String(v.hour_of_day_local).padStart(2, '0')}:00${v.is_night ? ', night' : ''}`,
  };
  const reasons = REASONS.map(([key, label, keys]) => ({ key, label, push: round(sum(keys), 3), fact: facts[key] }))
    .sort((a, b) => Math.abs(b.push) - Math.abs(a.push));
  const r = Math.floor(cell / N), c = cell % N;
  return { ok: true, cell, square: squareFeature(F, cell, {}), p: 1 / (1 + Math.exp(-z)), typical: 1 / (1 + Math.exp(-M.intercept)),
           burning: !!v.burning_now, reasons, centre: [(corner(F, r, c)[0] + corner(F, r + 1, c + 1)[0]) / 2, (corner(F, r, c)[1] + corner(F, r + 1, c + 1)[1]) / 2] };
}

/** The forecast square (not burning yet, likely to burn within the hour) closest to a point: what the demo explains. */
export function likelySquareNear(F, M, h, lon, lat) {
  const rows0 = F.burning.filter(([hr, , , gap]) => hr < h || (hr === h && !gap));
  const feats = features(F, M, rows0, F.hours.n_files, F.weather, h);
  if (!feats) return null;
  const p = predict(M, feats.X), k = Math.cos(lat * Math.PI / 180), N = F.n;
  let best = null, bd = Infinity;
  feats.cells.forEach((i, n) => {
    if (feats.X[n][0] || p[n] < M.th.new || isWater(F, i)) return;     // already burning, not forecast to burn, or water
    const r = Math.floor(i / N), c = i % N, a = corner(F, r, c), b = corner(F, r + 1, c + 1);
    const d = (((a[0] + b[0]) / 2 - lon) * k) ** 2 + ((a[1] + b[1]) / 2 - lat) ** 2;
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}
