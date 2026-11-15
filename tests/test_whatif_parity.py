"""
The hosted website has no Python server, so "what if the wind changes?" runs in the browser
(app/static/js/whatif_engine.js). It must give exactly the same answers as the Python model. Needs Node.js.
Also checks the demo's what-if claim: twice the wind turns 6 towns in danger into 20.
"""
import json
import os
import shutil
import subprocess

import pytest

from backend import situation as S
from backend import whatif

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CASES = [["eaton_fire_2025", 2, 25, 60], ["eaton_fire_2025", 10, 200, 15], ["park_fire_2024", 2, 0, 40],
         ["park_fire_2024", 20, 270, 25], ["palisades_fire_2025", 5, 30, 50]]


def python_answer(fid, h, d, speed):
    s = whatif.scenario(S.replay_situation(fid, h), d, speed)
    return {"towns": [[t["name"], t["status"], t["eta_h"]] for t in s["towns"]], "exits": s["exits"],
            "area": s["numbers"]["forecast_area_km2"], "squares": len(s["layers"]["forecast"]["features"])}


@pytest.mark.skipif(not shutil.which("node"), reason="Node.js not installed")
def test_browser_what_if_matches_python():
    out = subprocess.run(["node", os.path.join(ROOT, "tests", "whatif_js.mjs"), json.dumps(CASES)],
                         capture_output=True, text=True, check=True, cwd=ROOT)
    js = json.loads(out.stdout)
    for case, j in zip(CASES, js):
        py = json.loads(json.dumps(python_answer(*case)))        # same JSON rounding as the website
        assert j["towns"] == py["towns"], case
        assert j["area"] == py["area"], case
        assert j["squares"] == py["squares"], case
        assert j["exits"] == py["exits"], case


def test_twice_the_wind_10_to_20_towns():
    """Like with like: the model re-run with the real wind vs with twice the wind (both full model)."""
    real = S.replay_situation("eaton_fire_2025", 2)
    danger = lambda s: sum(t["status"] != "MONITOR" for t in s["towns"])
    assert round(real["wind"]["speed_kmh"]) == 29
    assert danger(whatif.scenario(real, 25, 29)) == 10
    assert danger(whatif.scenario(real, 25, 60)) == 20
    # the saved replay keeps only chances >= 5%, so its own list is shorter (conservative, never more)
    assert danger(real) == 6
