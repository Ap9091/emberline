"""
Add the "+2 h" road check (blocked_2h_at_km, used for the leave-by times) to the hosted site's saved replay hours,
without rebuilding the whole site. Recomputes each hour with the same code as the app and checks that the road
values already saved (+1 h and +3 h) are unchanged.

    cd app && ../.venv/bin/python patch_replay_roads.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from backend import situation as S  # noqa: E402

SITE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "site", "data", "replay")


def main():
    for fid in sorted(d for d in os.listdir(SITE) if os.path.isdir(os.path.join(SITE, d))):
        n = 0
        for name in sorted(os.listdir(os.path.join(SITE, fid))):
            if not name[:-5].isdigit():
                continue
            path = os.path.join(SITE, fid, name)
            saved = json.load(open(path))
            fresh = S.replay_situation(fid, int(name[:-5]))["exits"]
            for town, opts in saved.get("exits", {}).items():
                new = {o["id"]: o for o in fresh.get(town, [])}
                out = []
                for o in opts:
                    f = new[o["id"]]
                    assert (f["blocked_1h_at_km"], f["blocked_3h_at_km"]) == (o["blocked_1h_at_km"], o["blocked_3h_at_km"]), (fid, name, town)
                    out.append({k: o[k] for k in ("id", "road", "direction", "length_km", "blocked_1h_at_km")}
                               | {"blocked_2h_at_km": f["blocked_2h_at_km"], "blocked_3h_at_km": o["blocked_3h_at_km"]})
                saved["exits"][town] = out
            with open(path, "w") as fh:
                json.dump(saved, fh, separators=(",", ":"))
            n += 1
        print(fid, n, "hours updated", flush=True)


if __name__ == "__main__":
    main()
