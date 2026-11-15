"""
Emberline - what kind of false alarms does it give?

The test results count ~30 false-alarm town-hours per fire-day (a town flagged in an hour when the fire did not
reach it in the next 3 hours). That number mixes two very different messages:

  EVACUATE  "leave now": the model's forecast fire area reaches the town within 1 hour
  WARNING   "get ready": the fire could reach it within 3 hours (chance above the warning cut-off, or the
            forecast fire area reaches it at +2/+3 h)

Same rules as the app (app/backend/situation.py town_statuses), same 18 test fires and model as the test,
ERA5 weather as published. Hours where the fire is already at the town are not counted (that is not a forecast).

Run:    .venv/bin/python src/p4_false_alarms.py
Output: results/false_alarms.json
"""

import json
import os
import sys

import joblib
import numpy as np
import pandas as pd

import grid
import p3_core as c

ROOT = grid.ROOT


def main():
    sys.stdout.reconfigure(line_buffering=True)
    metrics = json.load(open(os.path.join(ROOT, "results", "metrics.json")))
    b = joblib.load(os.path.join(ROOT, "models", "emberline_model.joblib"))
    model = c.Model("logreg", b["logreg"])
    th, t_town = b["square_thresholds"]["logreg"], b["town_threshold"]["logreg"]
    towns = pd.read_csv(os.path.join(ROOT, "data", "processed", "towns_ca.csv"))
    res = c.collect(metrics["test_fires"], [model], {"logreg": th})

    rows = []
    for fid in sorted(set(res["fire_id"])):
        fire = res["fires"][fid]
        t, near = c.town_squares(fire, towns)
        if len(t) == 0:
            continue
        for ci in np.nonzero(res["fire_id"] == fid)[0]:
            probs, ever, now = res["pred"]["logreg"][ci], res["ever"][ci], res["now"][ci]
            ok = res["truth_ok"][ci]
            if not ok.any():
                continue                                                   # no truth to check against
            rings, e = [], ever.copy()
            for k in range(3):
                r = c.as_fire(probs[k], e, th)
                rings.append(r)
                e = e | r
            for j, name in enumerate(t.name):
                nj = near[j]
                if (now & nj).any():
                    continue                                               # fire already at the town
                ring_k = [k + 1 for k in range(3) if (rings[k] & nj).any()]
                flag = any(probs[k][nj].max() >= t_town for k in range(3)) if nj.any() else False
                if ring_k and ring_k[0] == 1:
                    status = "EVACUATE"
                elif ring_k or flag:
                    status = "WARNING"
                else:
                    continue
                reached = bool(any((res["truth"][ci][k] & nj).any() for k in range(3) if ok[k]))
                rows.append({"fire_id": fid, "hour": int(res["hour"][ci]), "town": name, "status": status, "reached_3h": reached})

    d = pd.DataFrame(rows)
    out = {"note": "Town-hours on EVACUATE or WARNING on the 18 test fires (fire not already at the town), and whether "
                   "the fire reached the town within the next 3 hours. Same rules as the app.", "by_status": {}}
    for st in ["EVACUATE", "WARNING"]:
        g = d[d.status == st]
        out["by_status"][st] = {"town_hours": int(len(g)), "fire_came_within_3h": int(g.reached_3h.sum()),
                                "share_fire_came": round(float(g.reached_3h.mean()), 3) if len(g) else None,
                                "false_alarm_town_hours": int((~g.reached_3h).sum())}
    fa = d[~d.reached_3h]
    out["false_alarms"] = {"total_town_hours": int(len(fa)),
                           "share_warning": round(float((fa.status == "WARNING").mean()), 3) if len(fa) else None,
                           "share_evacuate": round(float((fa.status == "EVACUATE").mean()), 3) if len(fa) else None}
    with open(os.path.join(ROOT, "results", "false_alarms.json"), "w") as f:
        json.dump(out, f, indent=1)
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
