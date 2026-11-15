// Runs "Why this square?" (app/static/js/whatif_engine.js explain) on the hosted site's data and prints a summary
// for tests/test_explain.py: the explained chance must equal the forecast's own chance, and the reasons must add up.
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { explain, likelySquareNear } = await import(pathToFileURL(path.join(ROOT, 'app/static/js/whatif_engine.js')));
const DATA = path.join(ROOT, 'site/data');
const read = f => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const M = read('whatif/model.json');
const logit = p => Math.log(p / (1 - p));
let n = 0, worstVsForecast = 0, worstSum = 0;
for (const fid of ['eaton_fire_2025', 'park_fire_2024', 'palisades_fire_2025']) {
  const F = read(`whatif/${fid}.json`);
  for (const h of [2, 5, 12]) {
    const sit = read(`replay/${fid}/${h}.json`);
    for (const f of (sit.layers?.forecast?.features || []).filter(x => x.properties.k === 1)) {
      const ring = f.geometry.coordinates[0].slice(0, 4);
      const e = explain(F, M, h, { lon: ring.reduce((a, q) => a + q[0], 0) / 4, lat: ring.reduce((a, q) => a + q[1], 0) / 4 });
      if (!e.ok) continue;
      n++;
      worstVsForecast = Math.max(worstVsForecast, Math.abs(e.p - f.properties.p));
      const sum = logit(e.typical) + e.reasons.reduce((a, r) => a + r.push, 0);         // the reasons add up to the answer
      worstSum = Math.max(worstSum, Math.abs(sum - logit(e.p)));
    }
  }
}
const F = read('whatif/eaton_fire_2025.json');
const demo = explain(F, M, 2, { cell: likelySquareNear(F, M, 2, -118.0548, 34.1616) });
console.log(JSON.stringify({ n, worstVsForecast, worstSum, demo: { p: Math.round(demo.p * 100), typical: Math.round(demo.typical * 100), top: demo.reasons[0].key,
  down: demo.reasons.filter(r => r.push < 0).map(r => r.key) } }));
