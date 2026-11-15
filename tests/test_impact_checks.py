"""
The three real-world checks quoted in the app and the write-up (src/p4_*.py), read back from their saved results.
"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
def load(name):
    return json.load(open(os.path.join(ROOT, "results", name)))


def test_results_hold_with_forecast_weather():
    s = load("weather_stress.json")["test_fires"]
    pub = load("metrics.json")["test"]["logreg"]
    assert s["era5"]["towns_warned"] == pub["towns_warned"] and abs(s["era5"]["IoU +3h"] - pub["IoU +3h"]) < 1e-3
    for kind in ("forecast", "day_before"):
        assert (s[kind]["towns_warned"], s[kind]["towns_reached"]) == (18, 20)
        assert round(s[kind]["mean_lead_h"], 1) == 2.8
        assert s[kind]["weather_hours_missing"] == 0
    o = load("weather_stress.json")["official_orders"]
    for kind in ("forecast", "day_before"):
        assert (o[kind]["reached_flagged_earlier"], o[kind]["reached"]) == (5, 5)
        assert o[kind]["sierra_madre_lead_h"] == 2.4


def test_false_alarms_are_almost_all_get_ready():
    f = load("false_alarms.json")
    assert f["false_alarms"]["total_town_hours"] == load("metrics.json")["test"]["logreg"]["false_alarm_town_hours"]
    assert f["false_alarms"]["share_warning"] >= 0.98
    assert f["by_status"]["EVACUATE"]["false_alarm_town_hours"] == 19


def test_fast_enough_for_5_minute_scans():
    s = load("speed.json")
    assert s["forecast_towns_roads_s"] < 5 and s["safety_check_ms"] < 10
    assert s["ai_answer_s"]["p90"] < 60


def test_app_quotes_these_checks():
    js = open(os.path.join(ROOT, "app", "static", "js", "results.js"), encoding="utf-8").read()
    k = open(os.path.join(ROOT, "app", "assistant", "knowledge.md"), encoding="utf-8").read()
    for text in ("'18/20'", "'98%'", "'~4 s'", "Only 19 town-hours"):
        assert text in js, text
    assert "98.5% of the 1,301" in k and "18 of 20 towns about 2.8 hours early" in k
