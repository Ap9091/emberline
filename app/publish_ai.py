"""
Copy the cached AI copilot answers for the replay fires into the hosted site (site/data/ai/), without a full rebuild.
Only answers already in data/ai_cache are used (no new AI calls). Run after app/prewarm.py:
    cd app && ../.venv/bin/python publish_ai.py eaton_fire_2025
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_site as B          # noqa: E402  (patches the AI client to cache-only)
from backend import situation as S  # noqa: E402


def main(fire_ids):
    for fid in fire_ids:
        meta_path = os.path.join(B.DATA, "replay", fid, "meta.json")
        with open(meta_path) as f:
            meta = json.load(f)
        saved = {}
        for hr in meta["hours"]:
            if hr["has_forecast"]:
                rec = B.copilot_for(S.replay_situation(fid, hr["hour_idx"]))
                if rec:
                    saved[hr["hour_idx"]] = rec
        meta["ai_hours"] = sorted(saved)
        B.write(f"replay/{fid}/meta.json", meta)
        B.write(f"ai/replay_{fid}.json", saved)
        print(fid, "copilot answers saved for hours", meta["ai_hours"], flush=True)


if __name__ == "__main__":
    main(sys.argv[1:] or ["eaton_fire_2025"])
