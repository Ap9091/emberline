"""
Every fact the demo, the pitch and the assistant state about the replay fires, recomputed from the real data.
If the data or the model changes, these tests fail before a wrong number reaches a judge.
"""
import json
import os
import re
from datetime import datetime, timezone

import pytest

from backend import situation as S
from backend.copilot import safety_check

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEMO_JS = open(os.path.join(ROOT, "app", "static", "js", "demo.js"), encoding="utf-8").read()
FIRES = ["park_fire_2024", "eaton_fire_2025", "palisades_fire_2025"]


@pytest.fixture(scope="module")
def eaton():
    return S.replay_meta("eaton_fire_2025")


@pytest.fixture(scope="module")
def eaton_h2():
    return S.replay_situation("eaton_fire_2025", 2)


def town(sit, name):
    return next(t for t in sit["towns"] if t["name"] == name)


def test_sierra_madre_told_to_evacuate_at_7pm(eaton_h2):
    t = town(eaton_h2, "Sierra Madre")
    assert t["status"] == "EVACUATE" and t["population"] == 10775
    assert "10,775" in DEMO_JS


def test_square_by_square_13_hit_4_missed_0_false(eaton_h2):
    v = eaton_h2["verification"][2]                    # forecast made at 7 pm, checked against 10 pm
    c = v["model"]["all"]
    assert (c["tp"], c["fn"], c["fp"]) == (13, 4, 0)
    assert c["tp_r2"] == c["tp"] + c["fn"]              # every burned square was within one square of a forecast square
    for text in ("13 green", "4 pink", "0 grey"):
        assert text in DEMO_JS


def test_overlap_76_vs_65_vs_31(eaton_h2):
    v = eaton_h2["verification"][2]
    iou = lambda c: round(100 * c["tp"] / (c["tp"] + c["fp"] + c["fn"]))
    assert (iou(v["model"]["all"]), iou(v["persistence"]["all"]), iou(v["grow"]["all"])) == (76, 65, 31)
    assert "bar('Emberline', 76" in DEMO_JS


def test_sierra_madre_flagged_almost_2_5_hours_before_the_order(eaton):
    row = next(t for t in eaton["timeline"] if t["town"] == "Sierra Madre")
    ours = datetime.fromisoformat(row["first_warning_issued_utc"])
    official = datetime.fromisoformat(row["official_order_utc"].replace("Z", "+00:00"))
    assert ours == datetime(2025, 1, 8, 3, 0, tzinfo=timezone.utc)          # 7:00 pm PST
    assert official == datetime(2025, 1, 8, 5, 26, tzinfo=timezone.utc)     # 9:26 pm PST
    assert row["lead_vs_official_h"] == 2.4 and row["fire_reached"]


def test_eaton_all_5_towns_flagged_first(eaton):
    c = eaton["official_comparison"]
    assert (c["towns_flagged_earlier"], c["towns_compared"]) == (5, 5)


def test_all_fires_8_of_9_towns_first_and_every_reached_town_first():
    compared = earlier = reached = reached_first = 0
    for fid in FIRES:
        for t in S.replay_meta(fid)["timeline"]:
            if t["lead_vs_official_h"] is None:
                continue
            compared += 1
            earlier += t["lead_vs_official_h"] > 0
            reached += bool(t["fire_reached"])
            reached_first += bool(t["fire_reached"]) and t["lead_vs_official_h"] > 0
    assert (earlier, compared) == (8, 9)
    assert (reached_first, reached) == (5, 5)
    assert "8 of 9 towns" in DEMO_JS and "every town the fire actually reached" in DEMO_JS


def test_park_fire_first_ai_plan_is_rejected_and_second_passes():
    sit = S.replay_situation("park_fire_2024", 2)
    first = {"evacuate": [{"town": "Chico", "exit": "State Rte 32 (W)"}, {"town": "Butte Creek Canyon", "exit": "State Hwy 32 (W)"}]}
    second = {"evacuate": [{"town": "Chico", "exit": "State Rte 32 (W)"}, {"town": "Butte Creek Canyon", "exit": "State Hwy 32 (N)"}]}
    reasons, _ = safety_check(first, sit)
    assert len(reasons) == 1 and "State Hwy 32 (W)" in reasons[0] and "4.4 km" in reasons[0]
    assert safety_check(second, sit)[0] == []


def test_demo_does_not_claim_more_than_the_data():
    # the welcome line must say it is a replay, and the honest note must not call this the single best hour
    assert "Replaying the 2025 Eaton Fire" in DEMO_JS
    assert "one of our best hours" in DEMO_JS
    assert not re.search(r"our best hour[^s]", DEMO_JS)
