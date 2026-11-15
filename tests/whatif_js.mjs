// Helper for tests/test_whatif_parity.py: runs the in-browser what-if engine (app/static/js/whatif_engine.js)
// on the hosted site's data and prints the answers as JSON.   node tests/whatif_js.mjs '[["eaton_fire_2025",2,25,60]]'
import { readFileSync } from 'node:fs';
import { scenario } from '../app/static/js/whatif_engine.js';

const DATA = new URL('../site/data/', import.meta.url);
const read = p => JSON.parse(readFileSync(new URL(p, DATA)));
const M = read('whatif/model.json');
const out = JSON.parse(process.argv[2]).map(([fid, h, dir, speed]) => {
  const s = scenario(read(`whatif/${fid}.json`), M, read(`replay/${fid}/${h}.json`), h, dir, speed);
  return { towns: s.towns.map(t => [t.name, t.status, t.eta_h]), exits: s.exits,
           area: s.numbers.forecast_area_km2, squares: s.layers.forecast.features.length };
});
console.log(JSON.stringify(out));
