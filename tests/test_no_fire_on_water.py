"""
A square that is almost all water (the sea, a lake) cannot burn, so no forecast square may sit on one.
Checked on every hour of the three replay fires the hosted site shows (the Palisades Fire runs along the ocean).
"""
import glob
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WATER_MAX = 0.9          # the same rule as WATER_MAX in src/p3_core.py and static/js/whatif_engine.js


def test_no_forecast_square_on_water():
    checked = 0
    for fid in ("palisades_fire_2025", "eaton_fire_2025", "park_fire_2024"):
        w = json.load(open(os.path.join(ROOT, "site", "data", "whatif", f"{fid}.json")))
        n, water = w["n"], w["static"]["frac_water"]
        for path in glob.glob(os.path.join(ROOT, "site", "data", "replay", fid, "*.json")):
            if path.endswith("meta.json"):
                continue
            sit = json.load(open(path))
            for f in (sit.get("layers") or {}).get("forecast", {}).get("features", []):
                r, c = f["properties"]["row"], f["properties"]["col"]
                assert water[r * n + c] < WATER_MAX, f"{fid} {os.path.basename(path)}: forecast square {r},{c} is on water"
                checked += 1
    assert checked > 1000


def test_same_water_rule_everywhere():
    core = open(os.path.join(ROOT, "src", "p3_core.py")).read()
    js = open(os.path.join(ROOT, "app", "static", "js", "whatif_engine.js")).read()
    assert f"WATER_MAX = {WATER_MAX}" in core and f"export const WATER_MAX = {WATER_MAX};" in js
