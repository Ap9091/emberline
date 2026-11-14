"""Loads (once) the files made in Phases 2-3: towns, replay forecasts, results, evacuation orders."""

import json
import os
from functools import lru_cache

import pandas as pd

from .paths import EVAC_CSV, REPLAY_DIR, RESULTS, TOWNS_CSV

REPLAY_FIRES = ["park_fire_2024", "eaton_fire_2025", "palisades_fire_2025"]   # Park is the default demo


@lru_cache(maxsize=1)
def towns():
    t = pd.read_csv(TOWNS_CSV)
    t["population"] = t.population.fillna(0).astype(int)
    return t


@lru_cache(maxsize=8)
def replay(fire_id):
    path = os.path.join(REPLAY_DIR, f"{fire_id}.json")
    if not os.path.exists(path):
        raise KeyError(fire_id)
    with open(path) as f:
        return json.load(f)


@lru_cache(maxsize=1)
def metrics():
    with open(os.path.join(RESULTS, "metrics.json")) as f:
        return json.load(f)


def evac_orders(fire_id=None):
    """Official evacuation orders typed in by the team (data/evac_orders.csv). Empty list if none yet."""
    if not os.path.exists(EVAC_CSV):
        return []
    d = pd.read_csv(EVAC_CSV)
    if fire_id:
        d = d[d.fire_id == fire_id]
    return d.fillna("").to_dict(orient="records")
