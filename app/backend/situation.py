"""
The "situation" at one moment of one fire: everything the map, the countdowns, the AI and the safety check need.

The same structure is used for REPLAY (a past fire, hour by hour) and INCIDENT (a live fire from GOES-18).
"""

import math

import numpy as np
import pandas as pd

from . import geo, roads, store
from .paths import grid

N = grid.N_CELLS
CELL_KM2 = (grid.CELL_M / 1000) ** 2
MIN_P = 0.05           # forecast squares below 5% are not drawn


def as_fire(probs, ever, th):
    """Same rule as the model (src/p3_core.as_fire): burned squares use the 'burn' cut-off, new squares the 'new' one."""
    return np.where(ever, probs >= th["burn"], probs >= th["new"])


def mask_of(cells):
    m = np.zeros((N, N), bool)
    for cell in cells:
        m[int(cell[0]), int(cell[1])] = True
    return m


def _bearing_label(deg):
    return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][int(((deg % 360) + 22.5) // 45) % 8]


MONITOR_KM = 20


def town_near(towns, xmin, ymax):
    """For each town: the squares within 1 km of the town point (towns x 40 x 40), and the town x/y."""
    x, y = grid.TO_ALBERS.transform([t["lon"] for t in towns], [t["lat"] for t in towns])
    x, y = np.asarray(x, float), np.asarray(y, float)
    cx = xmin + (np.arange(N) + 0.5) * grid.CELL_M
    cy = ymax - (np.arange(N) + 0.5) * grid.CELL_M
    half = grid.CELL_M / 2
    dx = np.maximum(np.abs(x[:, None, None] - cx[None, None, :]) - half, 0)
    dy = np.maximum(np.abs(y[:, None, None] - cy[None, :, None]) - half, 0)
    return np.hypot(dx, dy) <= 1000, x, y


def forecast_rings(now, ever, probs, th):
    """Forecast fire area at +1, +2, +3 h, rolled forward the same way as the model."""
    rings, e = [], ever.copy()
    if probs is not None:
        for k in range(3):
            ring = as_fire(probs[k], e, th)
            rings.append(ring)
            e = e | ring
    return rings


def town_statuses(towns, xmin, ymax, now, probs, rings, t_town):
    """
    Two-tier countdowns for each town:
      EVACUATE = fire already within 1 km of the town, or the model's forecast fire area reaches it within 1 h
                 (the model's own 'will burn' cut-offs, chosen on validation fires)
      WARNING  = forecast fire area reaches it at +2/+3 h, OR any square near it has a chance above the
                 warning threshold within 3 h (tuned to catch about 9 in 10 towns - expect false alarms)
      MONITOR  = fire within 20 km.        '' = farther away (not shown)
    """
    if not towns:
        return []
    near, x, y = town_near(towns, xmin, ymax)
    at_now = (near & now[None]).any(axis=(1, 2))
    out = []
    br, bc = np.nonzero(now)
    for j, t in enumerate(towns):
        ring_k = [k + 1 for k, r in enumerate(rings) if (r & near[j]).any()]
        chance = [float(probs[k][near[j]].max()) if probs is not None and near[j].any() else 0.0 for k in range(3)]
        flag_k = [k + 1 for k in range(3) if chance[k] >= t_town]
        if len(br):
            sx = xmin + (bc + 0.5) * grid.CELL_M
            sy = ymax - (br + 0.5) * grid.CELL_M
            dist = float(np.hypot(sx - x[j], sy - y[j]).min() / 1000)
        else:
            dist = float("inf")
        if at_now[j]:
            status, eta = "EVACUATE", 0
        elif ring_k and ring_k[0] == 1:
            status, eta = "EVACUATE", 1
        elif ring_k or flag_k:
            status, eta = "WARNING", min(ring_k + flag_k)
        elif dist <= MONITOR_KM:
            status, eta = "MONITOR", None
        else:
            continue
        out.append({"name": t["name"], "status": status, "eta_h": eta, "dist_km": round(dist, 1),
                    "chance_3h": round(max(chance), 3), "population": int(t.get("population") or 0),
                    "lat": t["lat"], "lon": t["lon"]})
    return out


# ---------------------------------------------------------------------------
# "Was it right?" - compare a forecast with what really burned (replay only)
# ---------------------------------------------------------------------------
def _dilate(a):
    """Squares within 2 km (centre to centre) of a True square: itself + its 4 side neighbours."""
    out = a.copy()
    out[1:, :] |= a[:-1, :]
    out[:-1, :] |= a[1:, :]
    out[:, 1:] |= a[:, :-1]
    out[:, :-1] |= a[:, 1:]
    return out


def counts(P, A, ever):
    """True positives / false positives / misses for all squares and for NEW squares (never burned before)."""
    def c(p, a):
        return {"tp": int((p & a).sum()), "fp": int((p & ~a).sum()), "fn": int((~p & a).sum()),
                # 'within 2 km': a forecast square counts as right if real fire is within one square of it
                "tp_p2": int((p & _dilate(a)).sum()), "tp_r2": int((a & _dilate(p)).sum())}
    return {"all": c(P, A), "new": c(P & ~ever, A & ~ever)}


def f1(c, near=False):
    """F1 from counts (None if there was nothing to score)."""
    tp_p, tp_r = (c["tp_p2"], c["tp_r2"]) if near else (c["tp"], c["tp"])
    n_p, n_r = c["tp"] + c["fp"], c["tp"] + c["fn"]
    if n_p == 0 and n_r == 0:
        return None
    p = tp_p / n_p if n_p else 0.0
    r = tp_r / n_r if n_r else 0.0
    return round(2 * p * r / (p + r), 3) if p + r > 0 else 0.0


def verify(now, ever, rings, grow, actual, actual_ok):
    """Per forecast hour (+1/+2/+3): counts for our model, 'grow 1 km/h' and 'looks like now'."""
    out = []
    for k in range(3):
        row = {"k": k + 1, "ok": bool(actual_ok[k]) and bool(rings)}
        if row["ok"]:
            row["model"] = counts(rings[k], actual[k], ever)
            row["grow"] = counts(grow[k], actual[k], ever) if grow else None
            row["persistence"] = counts(now, actual[k], ever)
            for m in ("model", "grow", "persistence"):
                if row[m]:
                    row[m]["f1"] = f1(row[m]["all"])
                    row[m]["f1_2km"] = f1(row[m]["all"], near=True)
                    row[m]["f1_new"] = f1(row[m]["new"])
        out.append(row)
    return out


def build(*, fire_id, name, mode, time_utc, xmin, ymax, now, ever, probs, grow, th, t_town, wind,
          towns, prev_area_km2=None, actual_future=None, actual_ok=None, data_note=None, scan_time_utc=None,
          check=True):
    """
    now, ever: (40, 40) bool. probs: (3, 40, 40) or None. grow: list of 3 masks (baseline) or None.
    towns: list of {name, population, lat, lon} in or near the box.
    actual_future: list of 3 masks (what really burned at +1/+2/+3 h; replay only), actual_ok: whether each of those
    hours had satellite data. check=False skips the "was it right?" comparison (used for what-if scenarios).
    """
    rings = forecast_rings(now, ever, probs, th)
    t = town_statuses(towns, xmin, ymax, now, probs, rings, t_town)
    danger_1h = now | (rings[0] if rings else False)

    # --- fire centre, for directions from the fire to each town
    if now.any():
        rr, cc = np.nonzero(now)
        cx = xmin + (cc.mean() + 0.5) * grid.CELL_M
        cy = ymax - (rr.mean() + 0.5) * grid.CELL_M
    else:
        cx = cy = None

    towns_out, exits_out, exits_geo = [], {}, []
    for tw in t:
        x, y = grid.TO_ALBERS.transform(tw["lon"], tw["lat"])
        item = dict(tw)
        if cx is not None:
            dx, dy = x - cx, y - cy
            item["bearing_from_fire"] = _bearing_label(math.degrees(math.atan2(dx, dy)))
        towns_out.append(item)
        if tw["status"] in ("EVACUATE", "WARNING"):
            opts = []
            for ex in roads.exits_for(float(x), float(y)):
                b1 = roads.blocked(ex, danger_1h, xmin, ymax)
                later = now.copy()
                for ring in rings:
                    later |= ring
                b3 = roads.blocked(ex, later, xmin, ymax)
                opts.append({"id": ex["id"], "road": ex["road"], "direction": ex["direction"],
                             "length_km": ex["length_km"], "blocked_1h_at_km": b1, "blocked_3h_at_km": b3})
                exits_geo.append(roads.exit_geojson(ex, {"town": tw["name"], "blocked_1h": b1 is not None,
                                                         "blocked_3h": b3 is not None}))
            exits_out[tw["name"]] = opts

    area = float(now.sum() * CELL_KM2)
    layers = {
        "fire": geo.squares_fc(xmin, ymax, np.argwhere(now).tolist()),
        "forecast": geo.squares_fc(xmin, ymax, [
            (r, c, probs[k, r, c], k + 1) for k in range(3) for r, c in np.argwhere(probs[k] >= MIN_P)],
            props=lambda cell: {"k": cell[3]}) if probs is not None else geo.squares_fc(xmin, ymax, []),
        "forecast_rings": [geo.outline_fc(xmin, ymax, ring, {"k": k + 1}) for k, ring in enumerate(rings)],
        "baseline_rings": [geo.outline_fc(xmin, ymax, g, {"k": k + 1}) for k, g in enumerate(grow)] if grow else [],
        "actual_future": [geo.squares_fc(xmin, ymax, np.argwhere(m).tolist(), lambda cell, k=k: {"k": k + 1})
                          for k, m in enumerate(actual_future)] if actual_future else [],
        "exits": {"type": "FeatureCollection", "features": exits_geo},
        "towns": {"type": "FeatureCollection", "features": [
            {"type": "Feature", "properties": {k: v for k, v in tw.items() if k not in ("lat", "lon")},
             "geometry": {"type": "Point", "coordinates": [tw["lon"], tw["lat"]]}} for tw in towns_out]},
        "verify": [],
    }
    verification = None
    if check and actual_future and rings:
        ok = actual_ok if actual_ok is not None else [True] * 3
        verification = verify(now, ever, rings, grow, actual_future, ok)
        # map layer: each square of the forecast or of the real fire, marked hit / missed / false alarm
        for k in range(3):
            P, A = rings[k], actual_future[k]
            cells = ([(r, c, "hit") for r, c in np.argwhere(P & A)] + [(r, c, "missed") for r, c in np.argwhere(~P & A)] +
                     [(r, c, "false_alarm") for r, c in np.argwhere(P & ~A)]) if ok[k] else []
            layers["verify"].append(geo.squares_fc(xmin, ymax, [(r, c) for r, c, _ in cells],
                                                   props=None))
            for feat, (_, _, res) in zip(layers["verify"][-1]["features"], cells):
                feat["properties"]["result"] = res
                feat["properties"]["k"] = k + 1
    numbers = {
        "fire_area_km2": round(area, 1),
        "growth_last_hour_km2": None if prev_area_km2 is None else round(float(area - prev_area_km2), 1),
        "forecast_area_km2": [round(float(r.sum() * CELL_KM2), 1) for r in rings],
        "residents_evacuate": int(sum(tw["population"] or 0 for tw in t if tw["status"] == "EVACUATE")),
        "residents_warning": int(sum(tw["population"] or 0 for tw in t if tw["status"] == "WARNING")),
    }
    return {
        "fire_id": fire_id, "name": name, "mode": mode, "time_utc": time_utc,
        "time_local": pd.Timestamp(time_utc).tz_convert("America/Los_Angeles").strftime("%a %d %b %Y %H:%M %Z"),
        "scan_time_utc": scan_time_utc, "data_note": data_note,
        "bounds": geo.box_bounds(xmin, ymax), "wind": wind, "numbers": numbers,
        "thresholds": {"squares": th, "town_warning": t_town},
        "towns": sorted(towns_out, key=lambda x: ({"EVACUATE": 0, "WARNING": 1, "MONITOR": 2}.get(x["status"], 3),
                                                  x.get("eta_h") or 9, -(x["population"] or 0))),
        "exits": exits_out, "layers": layers, "verification": verification,
        "_masks": {"now": now, "danger_1h": danger_1h, "xmin": xmin, "ymax": ymax},
    }


def public(sit):
    """The situation without internal arrays (for JSON responses)."""
    return {k: v for k, v in sit.items() if not k.startswith("_")}


def ai_context(sit):
    """Compact facts for the AI. Exits are listed WITHOUT the blocked flags: checking roads is the safety check's job."""
    return {
        "fire": sit["name"], "time_local": sit["time_local"], "numbers": sit["numbers"], "wind": sit["wind"],
        "towns": [{k: tw.get(k) for k in ("name", "status", "eta_h", "dist_km", "chance_3h", "population", "bearing_from_fire")}
                  for tw in sit["towns"] if tw["status"] in ("EVACUATE", "WARNING", "MONITOR")][:15],
        "exits": {town: [{"id": o["id"], "direction": o["direction"], "length_km": o["length_km"]} for o in opts]
                  for town, opts in sit["exits"].items()},
        "notes": "Forecast from a model trained on GOES satellite fire pixels (2-4 km). EVACUATE = fire at the town or "
                 "forecast within 1 h; WARNING = forecast within 3 h; MONITOR = fire within 20 km.",
    }


# ---------------------------------------------------------------------------
# REPLAY: one hour of a past fire
# ---------------------------------------------------------------------------
def _frame_masks(rp):
    return [mask_of(fr["burning"]) for fr in rp["hours"]]


def _replay_probs(fr):
    if fr["forecast"] is None:
        return None
    probs = np.zeros((3, N, N), np.float32)
    for k in range(3):
        for r, c, p in fr["forecast"][str(k + 1)]:
            probs[k, r, c] = p
    return probs


def _replay_hour(rp, h, masks):
    """Town statuses and the hour's 'was it right?' counts (cheap: no exits, no map layers)."""
    g, fr = rp["grid"], rp["hours"][h]
    probs = _replay_probs(fr)
    ever = np.logical_or.reduce(masks[:h + 1])
    rings = forecast_rings(masks[h], ever, probs, rp["rollout_threshold"])
    statuses = town_statuses(rp["towns"], g["xmin"], g["ymax"], masks[h], probs, rings, rp["town_threshold"])
    grow = [mask_of(fr["baseline_grow_1km"][str(k + 1)]) for k in range(3)] if fr["baseline_grow_1km"] else None
    future, ok = _future(rp, h, masks)
    ver = verify(masks[h], ever, rings, grow, future, ok) if rings else None
    return statuses, ver


def _future(rp, h, masks):
    """What really burned 1, 2, 3 h after hour h, and whether those hours had satellite data."""
    frames = rp["hours"]
    future = [masks[h + k] if h + k < len(masks) else np.zeros((N, N), bool) for k in (1, 2, 3)]
    ok = [h + k < len(frames) and frames[h + k]["has_data"] for k in (1, 2, 3)]
    return future, ok


def _utc(t):
    return pd.Timestamp(t).tz_convert("UTC")


def replay_meta(fire_id):
    rp = store.replay(fire_id)
    masks = _frame_masks(rp)
    g = rp["grid"]
    town_pos = {t["name"]: t for t in rp["towns"]}
    # Timeline: for each town, our first WARNING/EVACUATE and the hour fire first reached it
    first_warn, first_evac, arrival = {}, {}, {}
    by_hour = []
    for fr in rp["hours"]:
        statuses, ver = _replay_hour(rp, fr["hour_idx"], masks)
        if ver:
            by_hour.append({"hour_idx": fr["hour_idx"], "k": ver})
        for tw in statuses:
            n, h = tw["name"], fr["hour_idx"]
            if tw["status"] == "EVACUATE" and tw["eta_h"] == 0:
                arrival.setdefault(n, h)
            elif tw["status"] in ("WARNING", "EVACUATE"):
                if n not in arrival:
                    first_warn.setdefault(n, h)
                if tw["status"] == "EVACUATE" and n not in arrival:
                    first_evac.setdefault(n, h)
    # Times: a forecast made from the satellite data of hour h can only be ISSUED when that hour ends,
    # so our warning time = end of the data hour. Fire arrival = start of the hour GOES first saw fire near the town.
    hour_t = [_utc(fr["time_utc"]) for fr in rp["hours"]]
    orders = store.evac_orders(fire_id)
    # Only places in our town list can be compared. Others (e.g. Pacific Palisades, a part of the City of
    # Los Angeles and not a Census place) are listed separately as context.
    official_other = [o for o in orders if o["town"] not in town_pos]
    orders_in_list = [o for o in orders if o["town"] in town_pos]
    official = {}
    for o in orders_in_list:
        try:
            t = _utc(o["order_time_utc"])
        except Exception:
            continue
        cur = official.setdefault(o["town"], {})
        if o["order_type"] not in cur or t < cur[o["order_type"]]["t"]:
            cur[o["order_type"]] = {"t": t, "url": o.get("source_url"), "precision": o.get("precision")}
    timeline = []
    for n in sorted(set(first_warn) | set(arrival) | set(official),
                    key=lambda n: min(first_warn.get(n, 99), arrival.get(n, 99))):
        issued = hour_t[first_warn[n]] + pd.Timedelta(hours=1) if n in first_warn else None
        off = official.get(n, {})
        first_off = min((v["t"] for v in off.values()), default=None)
        timeline.append({
            "town": n, "population": town_pos.get(n, {}).get("population"),
            "first_warning_hour": first_warn.get(n), "first_evacuate_hour": first_evac.get(n),
            "fire_arrival_hour": arrival.get(n),
            "lead_h": (arrival[n] - first_warn[n]) if n in arrival and n in first_warn else None,
            "first_warning_issued_utc": issued.isoformat() if issued is not None else None,
            "fire_arrival_utc": hour_t[arrival[n]].isoformat() if n in arrival else None,
            "official_order_utc": off["order"]["t"].isoformat() if "order" in off else None,
            "official_warning_utc": off["warning"]["t"].isoformat() if "warning" in off else None,
            "official_source_url": next((v["url"] for v in off.values() if v.get("url")), None),
            "official_precision": next((v["precision"] for v in off.values() if v.get("precision")), None),
            "fire_reached": n in arrival,
            # > 0: we flagged the town that many hours BEFORE the first official order or warning
            "lead_vs_official_h": round((first_off - issued).total_seconds() / 3600, 1)
            if first_off is not None and issued is not None else None})
    compared = [t for t in timeline if t["lead_vs_official_h"] is not None]
    earlier = [t for t in compared if t["lead_vs_official_h"] > 0]
    official_comparison = {
        "towns_compared": len(compared), "towns_flagged_earlier": len(earlier),
        "towns_flagged_earlier_and_reached": sum(1 for t in earlier if t["fire_reached"]),
        "towns_flagged_later_or_same": len(compared) - len(earlier),
        "residents_flagged_earlier": int(sum(t["population"] or 0 for t in earlier)),
        "median_lead_h": float(np.median([t["lead_vs_official_h"] for t in compared])) if compared else None,
        "note": "Our warning time = end of the satellite hour it was made from. Official times as published, "
                "with sources. Not-flagged towns and later flags are counted too. Flagging a town early only helps if "
                "the fire really came: see 'fire reached' for each town."} if compared else None
    per_fire = next((r for r in store.metrics().get("test_per_fire", []) if r["fire"] == fire_id), None)
    return {
        "fire_id": fire_id, "name": rp["name"], "split": rp["split"], "model": rp["model"],
        "bounds": geo.box_bounds(g["xmin"], g["ymax"]),
        "hours": [{"hour_idx": fr["hour_idx"], "time_utc": fr["time_utc"],
                   "time_local": pd.Timestamp(fr["time_utc"]).tz_convert("America/Los_Angeles").strftime("%d %b %H:%M"),
                   "has_data": fr["has_data"], "has_forecast": fr["forecast"] is not None,
                   "fire_area_km2": round(float(masks[i].sum() * CELL_KM2), 1)} for i, fr in enumerate(rp["hours"])],
        "default_hour": next((fr["hour_idx"] for fr in rp["hours"] if fr["forecast"] is not None), 0),
        "timeline": timeline, "official_orders": orders, "official_comparison": official_comparison,
        "official_other": official_other,
        "verification_by_hour": by_hour,
        "official_orders_note": None if orders else
            "Official evacuation times not added yet (data/evac_orders.csv). We only show real public times.",
        "results": per_fire,
    }


def replay_situation(fire_id, h):
    rp = store.replay(fire_id)
    frames = rp["hours"]
    if not 0 <= h < len(frames):
        raise KeyError(h)
    g, fr = rp["grid"], frames[h]
    masks = _frame_masks(rp)
    now = masks[h]
    ever = np.logical_or.reduce(masks[:h + 1]) if h >= 0 else now
    probs = _replay_probs(fr)
    grow = [mask_of(fr["baseline_grow_1km"][str(k + 1)]) for k in range(3)] if fr["baseline_grow_1km"] else None
    future, ok = _future(rp, h, masks)
    prev = next((masks[j].sum() * CELL_KM2 for j in range(h - 1, -1, -1) if frames[j]["has_data"]), None)
    note = None if fr["has_data"] else "No satellite data this hour (outage): showing the last known fire."
    if fr["forecast"] is None and fr["has_data"]:
        note = "No forecast this hour (no fire pixels seen)."
    ctx = dict(fire_id=fire_id, name=rp["name"], mode="replay", time_utc=fr["time_utc"], xmin=g["xmin"],
               ymax=g["ymax"], now=now, ever=ever, probs=probs, grow=grow, th=rp["rollout_threshold"],
               t_town=rp["town_threshold"], wind=fr["wind"], towns=rp["towns"],
               prev_area_km2=prev, actual_future=future, actual_ok=ok, data_note=note)
    sit = build(**ctx)
    sit["_ctx"], sit["_h"], sit["_fire"] = ctx, h, None      # what-if loads the fire's model inputs when needed
    return sit
