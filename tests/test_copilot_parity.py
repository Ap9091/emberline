"""
The hosted site's live copilot (app/assistant/copilot_core.js, run by Vercel) must make exactly the same safety
decisions as the Python copilot, and give the AI exactly the same facts. Checked on real replay situations with
safe, unsafe, incomplete and made-up plans. Needs Node.js.
"""
import json
import os
import shutil
import subprocess
import tempfile

import pytest

from backend import copilot
from backend import situation as S

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MOMENTS = [("park_fire_2024", 2), ("park_fire_2024", 10), ("park_fire_2024", 20), ("eaton_fire_2025", 2),
           ("eaton_fire_2025", 4), ("eaton_fire_2025", 12), ("palisades_fire_2025", 5), ("palisades_fire_2025", 30)]


def plans_for(sit):
    """Plans that should pass, fail on a road, miss a town, or name things that do not exist."""
    evac = [t["name"] for t in sit["towns"] if t["status"] == "EVACUATE"]
    first = lambda town: (sit["exits"].get(town) or [{"id": "local roads"}])[0]["id"]
    clear = lambda town: next((o["id"] for o in sit["exits"].get(town, []) if o["blocked_1h_at_km"] is None), first(town))
    blocked = lambda town: next((o["id"] for o in sit["exits"].get(town, []) if o["blocked_1h_at_km"] is not None), first(town))
    return [
        {"evacuate": [{"town": t, "exit": clear(t)} for t in evac]},
        {"evacuate": [{"town": t, "exit": blocked(t)} for t in evac]},
        {"evacuate": [{"town": t, "exit": clear(t)} for t in evac[1:]]},
        {"evacuate": [{"town": t, "exit": "Hwy 999"} for t in evac] + [{"town": "Atlantis", "exit": "x"}]},
        {"evacuate": "everyone"},
        {"evacuate": [{"town": t, "exit": clear(t).upper()} for t in evac] + ["not an object"]},
    ]


@pytest.mark.skipif(not shutil.which("node"), reason="Node.js not installed")
def test_hosted_copilot_matches_python():
    cases, expected = [], []
    for fid, h in MOMENTS:
        sit = json.loads(json.dumps(S.public(S.replay_situation(fid, h)), default=str))   # what the website has
        plans = plans_for(sit)
        cases.append({"sit": sit, "plans": plans})
        expected.append({"context": json.loads(json.dumps(S.ai_context(sit), default=str)),
                         "checks": [list(copilot.safety_check(json.loads(json.dumps(p)), sit)) for p in plans]})
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(cases, f)
    out = subprocess.run(["node", os.path.join(ROOT, "tests", "copilot_js.mjs"), f.name],
                         capture_output=True, text=True, check=True, cwd=ROOT)
    js = json.loads(out.stdout)
    n_reject = 0
    for (fid, h), e, j in zip(MOMENTS, expected, js["out"]):
        assert j["context"] == e["context"], (fid, h)
        assert j["checks"] == e["checks"], (fid, h)
        n_reject += sum(bool(r) for r, _ in e["checks"])
    assert n_reject >= 10                                     # the cases really exercise the rejections
    assert all(loop["status"] in ("ACCEPTED", "MANUAL") for loop in js["loops"])
    assert len(js["cut"]) <= copilot.ALERT_MAX and js["cut"].endswith(".")


def test_park_fire_rejection_is_the_same_on_the_website():
    sit = json.loads(json.dumps(S.public(S.replay_situation("park_fire_2024", 2)), default=str))
    first = {"evacuate": [{"town": "Chico", "exit": "State Rte 32 (W)"}, {"town": "Butte Creek Canyon", "exit": "State Hwy 32 (W)"}]}
    reasons, _ = copilot.safety_check(first, sit)
    assert reasons and "4.4 km" in reasons[0]
