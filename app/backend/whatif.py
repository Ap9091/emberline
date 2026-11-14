"""
WHAT-IF: "What if the wind turns?" The commander sets a wind direction and speed for the next 3 hours,
and the TRAINED MODEL re-runs its forecast with that wind. Fire, terrain, vegetation and towns stay real;
only the weather the model sees for hours h..h+3 changes. Gusts keep the real gust/speed ratio.

This is not a fire-physics simulation: it shows what our model has learned about wind from 2018-2022 fires
(the ablation in Phase 3 found the wind features add ~25% to how well it ranks new spread).
"""

import copy
import math
from functools import lru_cache

from . import live
from . import situation as S

import p3_core as c


@lru_cache(maxsize=8)
def _replay_fire(fire_id):
    """The Phase 2 inputs (burning squares, weather, terrain) of a replay fire."""
    return c.Fire(fire_id)


def scenario(sit, from_deg, speed_kmh):
    """A new situation: the same moment, but with the given wind for the next 3 hours."""
    fire = sit.get("_fire") or _replay_fire(sit["fire_id"])
    h = sit["_h"]
    from_deg = float(from_deg) % 360
    speed = max(0.0, min(float(speed_kmh), 120.0))
    w = fire.weather.copy()
    ratio = float(w.loc[w.hour_idx == h, "wind_gust_kmh"].iloc[0]) / max(float(w.loc[w.hour_idx == h, "wind_speed_kmh"].iloc[0]), 1.0)
    rows = (w.hour_idx >= h) & (w.hour_idx <= h + 3)
    w.loc[rows, "wind_speed_kmh"] = speed
    w.loc[rows, "wind_gust_kmh"] = speed * ratio
    w.loc[rows, "wind_dir_deg"] = from_deg
    w.loc[rows, "wind_u_kmh"] = -speed * math.sin(math.radians(from_deg))   # the vector the wind blows TOWARD
    w.loc[rows, "wind_v_kmh"] = -speed * math.cos(math.radians(from_deg))
    f2 = copy.copy(fire)
    f2.weather = w

    model, th, _ = live._model()
    probs = c.forecast(model, f2, h, th)
    ctx = dict(sit["_ctx"])
    real = sit["wind"]
    ctx.update(probs=probs, check=False,
               wind={**real, "speed_kmh": round(speed, 1), "gust_kmh": round(speed * ratio, 1), "from_deg": round(from_deg)},
               data_note=(f"WHAT-IF scenario: wind {speed:.0f} km/h from {from_deg:.0f} deg for the next 3 h "
                          f"(real: {real['speed_kmh']} km/h from {real['from_deg']} deg). Forecast re-run by the trained model."))
    new = S.build(**ctx)
    new["whatif"] = {"from_deg": round(from_deg), "speed_kmh": round(speed, 1), "gust_kmh": round(speed * ratio, 1),
                     "real_wind": real,
                     "real_forecast_area_km2": sit["numbers"]["forecast_area_km2"],
                     "note": "Only the wind changes; fire, terrain, vegetation and towns are real. "
                             "This shows what the model learned about wind, not a physics simulation."}
    new["_ctx"], new["_h"], new["_fire"] = ctx, h, sit.get("_fire")
    return new
