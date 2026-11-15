"""
Leave-by times (app/static/js/leaveby.js): the earlier of the fire reaching the town and its best road being cut,
from the forecast alone. Made-up cases for each rule, plus the Eaton Fire's Sierra Madre at 7 pm. Needs Node.js.
"""
import json
import os
import shutil
import subprocess
import tempfile

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def road(id_, b1=None, b2=None, b3=None, km=10):
    return {"id": id_, "length_km": km, "blocked_1h_at_km": b1, "blocked_2h_at_km": b2, "blocked_3h_at_km": b3}


def sit(eta, roads, status="EVACUATE"):
    return {"time_local": "Tue 07 Jan 2025 19:00 PST", "towns": [{"name": "T", "status": status, "eta_h": eta}],
            "exits": {"T": roads}}


def run(cases):
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(cases, f)
    out = subprocess.run(["node", os.path.join(ROOT, "tests", "leaveby_js.mjs"), f.name], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


@pytest.mark.skipif(not shutil.which("node"), reason="Node.js not installed")
def test_rules():
    r = run([
        [sit(0, [road("A")]), "T"],                                   # fire at the town
        [sit(1, [road("A", b1=2.0), road("B", b1=3.0)]), "T"],        # every road cut within the hour
        [sit(3, [road("A", b2=4.0), road("B", b3=6.0)]), "T"],        # roads close before the fire comes
        [sit(1, [road("A"), road("B", b3=6.0)]), "T"],                # fire first: leave within 1 h
        [sit(2, []), "T"],                                            # no highway: local roads
        [sit(None, [road("A")], status="MONITOR"), "T"],              # not in danger: no advice
        [sit(2, [{"id": "A", "length_km": 5, "blocked_1h_at_km": None, "blocked_3h_at_km": 4.0}]), "T"],   # old data, no +2 h
    ])
    assert r[0]["lb"]["kind"] == "now"
    assert r[1]["lb"]["kind"] == "human" and r[1]["roads"] == [1, 1]
    assert r[2]["lb"]["hours"] == 2 and r[2]["lb"]["road"] == "B" and r[2]["lb"]["by"] == "21:00" and r[2]["roads"] == [2, 3]
    assert r[3]["lb"]["hours"] == 1 and r[3]["lb"]["road"] == "A" and r[3]["lb"]["by"] == "20:00"
    assert r[4]["lb"]["kind"] == "by" and r[4]["lb"]["road"] is None
    assert r[5]["lb"] is None
    assert r[6]["roads"] == [2] and r[6]["lb"]["hours"] == 1          # assumes the worse when the +2 h check is missing


@pytest.mark.skipif(not shutil.which("node"), reason="Node.js not installed")
def test_sierra_madre_leave_by_8pm():
    s = json.load(open(os.path.join(ROOT, "site", "data", "replay", "eaton_fire_2025", "2.json")))
    r = run([[s, "Sierra Madre"]])[0]
    assert r["roads"] == [None, None]                                 # both I-210 directions open 3 h+
    assert r["lb"]["by"] == "20:00" and r["lb"]["hours"] == 1
    demo = open(os.path.join(ROOT, "app", "static", "js", "demo.js"), encoding="utf-8").read()
    assert "Leave by about 8 pm" in demo


def test_saved_replay_hours_have_the_2h_road_check():
    for fid in ("park_fire_2024", "eaton_fire_2025", "palisades_fire_2025"):
        s = json.load(open(os.path.join(ROOT, "site", "data", "replay", fid, "10.json")))
        for opts in s["exits"].values():
            for o in opts:
                assert "blocked_2h_at_km" in o
                # a road cut by +1 h is also cut by +2 h and +3 h
                if o["blocked_1h_at_km"] is not None:
                    assert o["blocked_2h_at_km"] is not None and o["blocked_3h_at_km"] is not None
