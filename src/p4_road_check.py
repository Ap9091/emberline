"""
Emberline - were the leave-by times and escape-road calls right?

For every forecast hour of the three replay fires (all three are test fires the model never saw), every town on
EVACUATE or WARNING, and every highway out of it, we compare what Emberline said with what the satellite really saw
afterwards:

  road said "open 3 h+"         -> did the real fire stay off it for the next 3 hours?
  road said usable for U hours  -> was it still free of real fire for those U hours?
  road said "cut within 1 h"    -> did real fire really reach it (within 1 h, or within 3 h)?
  recommended road              -> was it free of real fire until the town's leave-by time?
  leave-by time                 -> for towns the fire really reached, was the leave-by time before the fire came?

The real fire is the GOES fire squares at +1, +2, +3 h (the same truth as the test). A road counts as cut when it
runs through a burning square beyond the first 1.5 km from town, exactly like the forecast check (app/backend/roads.py).
Hours whose next 3 hours are missing satellite data are skipped.

Run:    .venv/bin/python src/p4_road_check.py
Output: results/road_check.json and results/road_check.md
"""

import json
import math
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "app"))

from backend import roads, store                      # noqa: E402
from backend import situation as S                    # noqa: E402
import grid                                           # noqa: E402

FIRES = ["park_fire_2024", "eaton_fire_2025", "palisades_fire_2025"]


def closes(o):
    """Same rule as app/static/js/leaveby.js: hours until the forecast fire reaches the road (None = 3 h+)."""
    for k, key in ((1, "blocked_1h_at_km"), (2, "blocked_2h_at_km"), (3, "blocked_3h_at_km")):
        if o.get(key) is not None:
            return k
    return None


def usable(o):
    k = closes(o)
    return math.inf if k is None else k - 1


def leave_by(town, exits):
    """Same rule as leaveby.js: (hours, road id) or None for 'now' / 'a person decides' / no highway."""
    if town["eta_h"] == 0:
        return None
    fire_h = town["eta_h"] if town["eta_h"] is not None else math.inf
    ok = [o for o in exits if usable(o) > 0]
    if not exits or not ok:
        return None
    best = sorted(ok, key=lambda o: (-usable(o), o["length_km"]))[0]
    return min(fire_h, usable(best)), best["id"]


def share(a, b):
    return {"n": b, "yes": a, "share": round(a / b, 3) if b else None}


def main():
    sys.stdout.reconfigure(line_buffering=True)
    rows, deadlines = [], []
    for fid in FIRES:
        rp = store.replay(fid)
        meta = S.replay_meta(fid)
        arrival = {t["town"]: t["fire_arrival_hour"] for t in meta["timeline"]}
        g = rp["grid"]
        for h, fr in enumerate(rp["hours"]):
            if fr["forecast"] is None:
                continue
            sit = S.replay_situation(fid, h)
            ctx = sit["_ctx"]
            if not all(ctx["actual_ok"]):
                continue
            real = [ctx["now"].copy()]
            for k in range(3):
                real.append(real[-1] | ctx["actual_future"][k])          # real fire by +1, +2, +3 h
            for town in sit["towns"]:
                if town["status"] not in ("EVACUATE", "WARNING") or town["eta_h"] == 0:
                    continue
                x, y = grid.TO_ALBERS.transform(town["lon"], town["lat"])
                said = {o["id"]: o for o in sit["exits"].get(town["name"], [])}
                real_closes = {}
                for ex in roads.exits_for(float(x), float(y)):
                    rk = next((k for k in (1, 2, 3) if roads.blocked(ex, real[k], g["xmin"], g["ymax"]) is not None), None)
                    real_closes[ex["id"]] = rk
                    o = said.get(ex["id"])
                    if o is not None:
                        rows.append({"fire": fid, "hour": h, "town": town["name"], "road": ex["id"],
                                     "said_closes_h": closes(o), "real_closes_h": rk})
                lb = leave_by(town, list(said.values()))
                if lb is None:
                    continue
                hours, road = lb
                rk = real_closes.get(road)
                a = arrival.get(town["name"])
                deadlines.append({"fire": fid, "hour": h, "town": town["name"], "leave_within_h": hours, "road": road,
                                  "road_clear_until_deadline": rk is None or (math.isfinite(hours) and rk > hours),
                                  "fire_arrival_in_h": (a - h) if a is not None and a > h else None})

    said_open = [r for r in rows if r["said_closes_h"] is None]
    said_usable = [r for r in rows if r["said_closes_h"] != 1]
    said_cut = [r for r in rows if r["said_closes_h"] == 1]
    lim = lambda r: 3 if r["said_closes_h"] is None else r["said_closes_h"] - 1
    reached = [d for d in deadlines if d["fire_arrival_in_h"] is not None]
    out = {
        "note": "Three replay fires (all test fires), every forecast hour with satellite data for the next 3 hours, "
                "every highway out of every town on EVACUATE or WARNING. Real fire = GOES fire squares at +1/+2/+3 h.",
        "road_hours": len(rows),
        "said_open_3h_really_stayed_clear_3h": share(sum(r["real_closes_h"] is None for r in said_open), len(said_open)),
        "said_usable_really_clear_that_long": share(sum(r["real_closes_h"] is None or r["real_closes_h"] > lim(r) for r in said_usable), len(said_usable)),
        "said_cut_1h_really_reached_by_fire_1h": share(sum(r["real_closes_h"] == 1 for r in said_cut), len(said_cut)),
        "said_cut_1h_really_reached_by_fire_3h": share(sum(r["real_closes_h"] is not None for r in said_cut), len(said_cut)),
        "recommended_road_clear_until_leave_by": share(sum(d["road_clear_until_deadline"] for d in deadlines), len(deadlines)),
        "leave_by_before_fire_arrived": share(sum(d["leave_within_h"] <= d["fire_arrival_in_h"] for d in reached), len(reached)),
        "misses": [r for r in rows if r["said_closes_h"] is None and r["real_closes_h"] is not None][:20],
    }
    with open(os.path.join(ROOT, "results", "road_check.json"), "w") as f:
        json.dump(out, f, indent=1)
    lines = ["# Road and leave-by check", "", out["note"], "", "| Check | Result |", "|---|---|"]
    for key in ("said_open_3h_really_stayed_clear_3h", "said_usable_really_clear_that_long", "said_cut_1h_really_reached_by_fire_1h",
                "said_cut_1h_really_reached_by_fire_3h", "recommended_road_clear_until_leave_by", "leave_by_before_fire_arrived"):
        v = out[key]
        lines.append(f"| {key.replace('_', ' ')} | {v['yes']} of {v['n']} ({100 * v['share']:.1f}%) |" if v["n"] else f"| {key.replace('_', ' ')} | none |")
    open(os.path.join(ROOT, "results", "road_check.md"), "w").write("\n".join(lines) + "\n")
    print("\n".join(lines))
    print("misses (said open 3 h+, real fire reached the road):", len([r for r in rows if r["said_closes_h"] is None and r["real_closes_h"] is not None]))


if __name__ == "__main__":
    main()
