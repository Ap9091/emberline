"""
The safety check is the code that stands between the AI and the public: it must reject any evacuation plan that
sends people down a road the fire is about to cross, or that forgets a town in danger. Plain code, no AI.
These tests use small made-up situations, so each rule is checked on its own.
"""
from backend.copilot import safety_check


def situation(exits, towns=None):
    towns = towns or [
        {"name": "Pine Hill", "status": "EVACUATE", "eta_h": 1, "population": 2000},
        {"name": "Oak Flat", "status": "WARNING", "eta_h": 2, "population": 500},
    ]
    return {"towns": towns, "exits": exits}


def road(id_, blocked_1h_at_km=None):
    return {"id": id_, "blocked_1h_at_km": blocked_1h_at_km}


CLEAR_AND_BLOCKED = {"Pine Hill": [road("Hwy 1 (N)"), road("Hwy 1 (S)", blocked_1h_at_km=3.2)]}


def test_safe_plan_passes():
    plan = {"evacuate": [{"town": "Pine Hill", "exit": "Hwy 1 (N)"}]}
    reasons, human = safety_check(plan, situation(CLEAR_AND_BLOCKED))
    assert reasons == [] and human == []


def test_road_into_the_fire_is_rejected():
    plan = {"evacuate": [{"town": "Pine Hill", "exit": "Hwy 1 (S)"}]}
    reasons, _ = safety_check(plan, situation(CLEAR_AND_BLOCKED))
    assert len(reasons) == 1
    assert "Hwy 1 (S)" in reasons[0] and "3.2 km" in reasons[0]


def test_forgetting_a_town_in_danger_is_rejected():
    plan = {"evacuate": [{"town": "Oak Flat", "exit": "Hwy 9"}]}
    reasons, _ = safety_check(plan, situation({"Oak Flat": [road("Hwy 9")], **CLEAR_AND_BLOCKED}))
    assert any("Pine Hill" in r and "does not evacuate" in r for r in reasons)


def test_made_up_town_or_road_is_rejected():
    plan = {"evacuate": [{"town": "Pine Hill", "exit": "Hwy 99"}, {"town": "Atlantis", "exit": "Hwy 1 (N)"}]}
    reasons, _ = safety_check(plan, situation(CLEAR_AND_BLOCKED))
    assert any("Hwy 99" in r for r in reasons)
    assert any("Atlantis" in r for r in reasons)


def test_no_clear_road_goes_to_a_human_not_a_rejection():
    exits = {"Pine Hill": [road("Hwy 1 (N)", 1.0), road("Hwy 1 (S)", 2.0)]}
    plan = {"evacuate": [{"town": "Pine Hill", "exit": "Hwy 1 (N)"}]}
    reasons, human = safety_check(plan, situation(exits))
    assert reasons == []
    assert len(human) == 1 and "human decision" in human[0]


def test_broken_plan_shape_is_rejected():
    reasons, _ = safety_check({"evacuate": "everyone"}, situation(CLEAR_AND_BLOCKED))
    assert reasons
