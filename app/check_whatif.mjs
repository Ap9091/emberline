// Checks that the in-browser what-if (static/js/whatif_engine.js) gives the same answers as the Python backend.
// Needs the backend running (app/run.sh) and a built site (app/build_site.py).
//   node app/check_whatif.mjs
import { readFileSync } from 'node:fs';
import { scenario } from './static/js/whatif_engine.js';

const SITE = new URL('../site/data/', import.meta.url);
const read = p => JSON.parse(readFileSync(new URL(p, SITE)));
const M = read('whatif/model.json');
const cases = [
  ['park_fire_2024', 2, 0, 40], ['park_fire_2024', 6, 165, 19], ['park_fire_2024', 6, 45, 60], ['park_fire_2024', 20, 270, 25],
  ['park_fire_2024', 30, 90, 10], ['eaton_fire_2025', 3, 45, 60], ['eaton_fire_2025', 10, 200, 15],
  ['palisades_fire_2025', 5, 30, 50], ['palisades_fire_2025', 20, 250, 20],
];
let bad = 0;
for (const [fid, h, dir, speed] of cases) {
  const F = read(`whatif/${fid}.json`), base = read(`replay/${fid}/${h}.json`);
  const js = scenario(F, M, base, h, dir, speed);
  const py = await (await fetch('http://localhost:8000/api/whatif', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'replay', fire_id: fid, hour: h, wind_from_deg: dir, wind_speed_kmh: speed }) })).json();
  const tj = js.towns.map(t => `${t.name}:${t.status}:${t.eta_h}`).join('|');
  const tp = py.towns.map(t => `${t.name}:${t.status}:${t.eta_h}`).join('|');
  const ej = JSON.stringify(js.exits), ep = JSON.stringify(py.exits);
  const sq = js.layers.forecast.features.length, sqp = py.layers.forecast.features.length;
  const ok = JSON.stringify(js.numbers.forecast_area_km2) === JSON.stringify(py.numbers.forecast_area_km2) && tj === tp && ej === ep && sq === sqp;
  if (!ok) bad++;
  console.log(ok ? 'SAME' : 'DIFF', fid, `h${h}`, `${speed} km/h from ${dir}°`, 'area', js.numbers.forecast_area_km2, 'vs', py.numbers.forecast_area_km2,
    ok ? '' : `\n   towns js ${tj.slice(0, 160)}\n   towns py ${tp.slice(0, 160)}\n   squares ${sq} vs ${sqp} exits ${ej === ep}`);
}
console.log(bad ? `${bad} case(s) differ` : 'all cases match the Python backend');
process.exit(bad ? 1 : 0);
