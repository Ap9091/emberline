"""
Emberline - is it fast enough for a real fire? Times each step from a new satellite scan to a checked plan.

  1. download the newest GOES-18 fire scan (5-minute product) and find the fire pixels in California
  2. run the trained model for the next 3 hours and work out every town's status and every exit road
     (timed on the Eaton Fire at 7 pm, the demo's moment; same code as the live app)
  3. the code safety check of an evacuation plan
  4. the AI briefing / plan (from the saved Gemini answers: how long they took when they were made)

Run:    .venv/bin/python src/p4_speed.py
Output: results/speed.json
"""

import glob
import json
import os
import statistics
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "app"))

from backend import live, whatif                    # noqa: E402
from backend import situation as S                  # noqa: E402
from backend.copilot import safety_check            # noqa: E402


def timed(fn, *a, repeat=1):
    best = None
    for _ in range(repeat):
        t0 = time.perf_counter()
        out = fn(*a)
        dt = time.perf_counter() - t0
        best = dt if best is None else min(best, dt)
    return out, best


def main():
    sys.stdout.reconfigure(line_buffering=True)
    out = {}

    # 1. newest scan: list, download, read California fire pixels
    try:
        files, t_list = timed(live._recent_files, 1)
        scan_time, name = files[-1]
        path, t_dl = timed(live._local, name)
        px, t_read = timed(live._ca_fire_pixels, path)
        out["scan"] = {"scan_time_utc": str(scan_time), "list_s": round(t_list, 2), "download_s": round(t_dl, 2),
                       "read_s": round(t_read, 2), "fire_pixels_in_california": int(len(px))}
    except Exception as e:                                  # no network: report it rather than guess
        out["scan"] = {"error": f"{type(e).__name__}: {e}"[:200]}
    print("scan", out["scan"])

    # 2. forecast + town statuses + exit roads (the full model run, as the what-if re-runs it)
    sit = S.replay_situation("eaton_fire_2025", 2)
    whatif._replay_fire("eaton_fire_2025")                  # load the fire's inputs once (startup cost, not per update)
    w = sit["wind"]
    _, t_model = timed(whatif.scenario, sit, w["from_deg"], w["speed_kmh"], repeat=3)
    out["forecast_towns_roads_s"] = round(t_model, 2)
    print("forecast + towns + roads", out["forecast_towns_roads_s"], "s")

    # 3. the safety check
    plan = {"evacuate": [{"town": "Sierra Madre", "exit": "I-210 (E)"}]}
    _, t_check = timed(safety_check, plan, sit, repeat=50)
    out["safety_check_ms"] = round(t_check * 1000, 3)
    print("safety check", out["safety_check_ms"], "ms")

    # 4. AI answers: how long they took when they were generated (saved with the answers)
    secs = []
    for p in glob.glob(os.path.join(ROOT, "data", "ai_cache", "*.json")):
        try:
            s = json.load(open(p)).get("seconds")
            if isinstance(s, (int, float)) and s > 0:
                secs.append(s)
        except (ValueError, OSError):
            pass
    out["ai_answer_s"] = {"median": round(statistics.median(secs), 1), "p90": round(sorted(secs)[int(0.9 * (len(secs) - 1))], 1),
                          "n": len(secs)} if secs else None
    print("AI answers", out["ai_answer_s"])

    total = sum(v for v in [out["scan"].get("download_s"), out["scan"].get("read_s"), out["forecast_towns_roads_s"],
                            (out["ai_answer_s"] or {}).get("median")] if isinstance(v, (int, float)))
    out["scan_to_checked_plan_s"] = round(total, 1)
    out["note"] = ("One run on a cloud machine. The satellite publishes a new California fire scan every 5 minutes; "
                   "Emberline needs scan_to_checked_plan_s seconds to turn it into a forecast and a checked AI plan.")
    with open(os.path.join(ROOT, "results", "speed.json"), "w") as f:
        json.dump(out, f, indent=1)
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
