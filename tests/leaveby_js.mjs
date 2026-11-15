// Helper for tests/test_leaveby.py: runs app/static/js/leaveby.js on cases from a JSON file.
import { readFileSync } from 'node:fs';
import { leaveBy, roadClosesH } from '../app/static/js/leaveby.js';
const cases = JSON.parse(readFileSync(process.argv[2], 'utf8'));
console.log(JSON.stringify(cases.map(([sit, town]) => ({ lb: leaveBy(sit, town),
  roads: ((sit.exits || {})[town] || []).map(roadClosesH) }))));
