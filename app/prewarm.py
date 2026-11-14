"""
Pre-compute (and cache) the AI answers for the replay fires, so the demo is instant and works offline.

    cd app && ../.venv/bin/python prewarm.py park_fire_2024            # every hour of the Park Fire
    cd app && ../.venv/bin/python prewarm.py eaton_fire_2025 10 20     # hours 10-20 of the Eaton Fire

For each hour with a forecast: briefing + plan (with the safety check). If the plan passes, the alert draft too.
Prints which hours had a REJECTED attempt (the safety check catching a bad plan).
"""

import sys
import time

from backend import ai, copilot, store
from backend import situation as S


def main():
    fire_id = sys.argv[1] if len(sys.argv) > 1 else "park_fire_2024"
    lo = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    hi = int(sys.argv[3]) if len(sys.argv) > 3 else 73
    rp = store.replay(fire_id)
    rejected = []
    for fr in rp["hours"][lo:hi + 1]:
        h = fr["hour_idx"]
        if fr["forecast"] is None:
            continue
        t0 = time.time()
        sit = S.replay_situation(fire_id, h)
        try:
            copilot.briefing(sit)
            p = copilot.plan(sit)
            n_rej = sum(a["verdict"] == "REJECTED" for a in p["attempts"])
            if n_rej:
                rejected.append((h, n_rej, p["status"], [r for a in p["attempts"] for r in a["reasons"]][:2]))
            if p["status"] == "ACCEPTED":
                copilot.alert(sit, p["plan"])
            print(f"hour {h:2d} {sit['time_local']}: plan {p['status']:8s} rejected {n_rej}  ({time.time() - t0:.0f} s)",
                  flush=True)
        except ai.AIOffline as e:
            print(f"hour {h:2d}: AI offline ({e})", flush=True)
    print("\nHours with a REJECTED attempt:")
    for r in rejected:
        print("  ", r)


if __name__ == "__main__":
    main()
