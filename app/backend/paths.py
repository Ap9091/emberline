"""Where things live, and access to the Phase 1-3 code in src/."""

import os
import sys

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))     # .../emberline/app
ROOT = os.path.dirname(APP)                                           # .../emberline
SRC = os.path.join(ROOT, "src")
if SRC not in sys.path:
    sys.path.insert(0, SRC)

import grid  # noqa: E402,F401  (re-exported: the shared 2 km grid)

RESULTS = os.path.join(ROOT, "results")
REPLAY_DIR = os.path.join(RESULTS, "replay")
TOWNS_CSV = os.path.join(ROOT, "data", "processed", "towns_ca.csv")
ROADS_ZIP = os.path.join(ROOT, "data", "reference", "tl_2024_06_prisecroads.zip")   # US Census TIGER/Line 2024 roads (committed)
MODEL_FILE = os.path.join(ROOT, "models", "emberline_model.joblib")
EVAC_CSV = os.path.join(ROOT, "data", "evac_orders.csv")
AI_CACHE = os.path.join(ROOT, "data", "ai_cache")
LIVE_CACHE = os.path.join(ROOT, "data", "live_cache")
STATIC_DIR = os.path.join(APP, "static")
for d in (AI_CACHE, LIVE_CACHE):
    os.makedirs(d, exist_ok=True)
