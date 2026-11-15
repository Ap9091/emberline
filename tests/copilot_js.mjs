// Helper for tests/test_copilot_parity.py: runs the hosted copilot's safety check and AI context
// (app/assistant/copilot_core.js) on cases read from a JSON file and prints the answers.
import { readFileSync } from 'node:fs';
import { safetyCheck, aiContext, planLoop, cutAlert } from '../app/assistant/copilot_core.js';

const cases = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const out = cases.map(({ sit, plans }) => ({ context: aiContext(sit), checks: plans.map(p => safetyCheck(p, sit)) }));
// the retry loop: a fake AI that first proposes the given plans in order
const loops = [];
for (const { sit, plans } of cases.slice(0, 3)) {
  let i = 0;
  const r = await planLoop(sit, async () => ({ json: structuredClone(plans[Math.min(i++, plans.length - 1)]), provider: 'test', model: 'test' }));
  loops.push({ status: r.status, verdicts: r.attempts.map(a => a.verdict) });
}
console.log(JSON.stringify({ out, loops, cut: cutAlert('"' + 'A'.repeat(200) + '. ' + 'B'.repeat(300) + '."') }));
