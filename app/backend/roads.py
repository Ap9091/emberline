"""
Exit roads for towns, from US Census TIGER/Line 2024 primary and secondary roads (California).
(OpenStreetMap's Overpass API was unreachable from our cloud machine, so we use the Census road file.)

An "exit" = one highway leaving a town in one direction, e.g. "State Hwy 32 (NE)": the stretch of that
highway from the point nearest the town out to 20 km away. The safety check tests whether that stretch
runs through the fire now or the +1 h forecast fire.
"""

import math
from functools import lru_cache

import numpy as np
import shapefile

from .paths import ROADS_ZIP, grid

NEAR_M = 3000        # a highway counts as an exit if it passes within 3 km of the town
NEAR_FALLBACK_M = 8000
REACH_M = 20000      # we follow each exit for 20 km
STEP_M = 250         # points every 250 m along the road for the fire check
MIN_LEN_M = 4000     # ignore stubs shorter than 4 km
SKIP_TOWN_M = 1500   # the road check starts 1.5 km from the town (see blocked)
COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]


def _pretty(name):
    name = " ".join(name.split()).replace("I- ", "I-")
    return name or "Unnamed highway"


@lru_cache(maxsize=1)
def _roads():
    """Every road part as (name, x array, y array) in EPSG:3310 metres, plus bounding boxes for quick filtering."""
    reader = shapefile.Reader(ROADS_ZIP)
    parts, boxes = [], []
    for sr in reader.iterShapeRecords():
        pts = np.asarray(sr.shape.points, float)
        if len(pts) < 2:
            continue
        idx = list(sr.shape.parts) + [len(pts)]
        for a, b in zip(idx[:-1], idx[1:]):
            if b - a < 2:
                continue
            x, y = grid.TO_ALBERS.transform(pts[a:b, 0], pts[a:b, 1])
            x, y = np.asarray(x), np.asarray(y)
            parts.append((_pretty(sr.record["FULLNAME"]), x, y))
            boxes.append((x.min(), y.min(), x.max(), y.max()))
    return parts, np.array(boxes)


def _densify(x, y):
    """Points every ~250 m along a polyline."""
    seg = np.hypot(np.diff(x), np.diff(y))
    dist = np.concatenate([[0], np.cumsum(seg)])
    if dist[-1] == 0:
        return x[:1], y[:1]
    s = np.arange(0, dist[-1] + STEP_M, STEP_M).clip(max=dist[-1])
    return np.interp(s, dist, x), np.interp(s, dist, y)


def _compass(dx, dy):
    ang = (math.degrees(math.atan2(dx, dy)) + 360) % 360      # 0 = north, 90 = east
    return COMPASS[int((ang + 22.5) // 45) % 8], ang


@lru_cache(maxsize=4096)
def exits_for(town_x, town_y):
    """All exits of a town: list of dicts {id, road, direction, bearing_deg, length_km, x, y (arrays)}."""
    parts, boxes = _roads()
    for near in (NEAR_M, NEAR_FALLBACK_M):
        hit = ((boxes[:, 0] <= town_x + REACH_M) & (boxes[:, 2] >= town_x - REACH_M) &
               (boxes[:, 1] <= town_y + REACH_M) & (boxes[:, 3] >= town_y - REACH_M))
        best = {}
        for i in np.nonzero(hit)[0]:
            name, x, y = parts[i]
            px, py = _densify(x, y)
            d = np.hypot(px - town_x, py - town_y)
            if d.min() > near:
                continue
            i0 = int(d.argmin())
            for path in (np.arange(i0, len(px)), np.arange(i0, -1, -1)):   # both directions from the nearest point
                path = path[d[path] <= REACH_M]
                # keep the stretch until the road first leaves the 20 km circle
                if len(path) > 1:
                    breaks = np.nonzero(np.diff(path) != (1 if path[-1] > path[0] else -1))[0]
                    if len(breaks):
                        path = path[:breaks[0] + 1]
                if len(path) < 2:
                    continue
                ex, ey = px[path], py[path]
                length = float(np.hypot(np.diff(ex), np.diff(ey)).sum())
                end_d = float(np.hypot(ex[-1] - town_x, ey[-1] - town_y))
                if length < MIN_LEN_M or end_d < MIN_LEN_M / 2:
                    continue
                label, bearing = _compass(ex[-1] - town_x, ey[-1] - town_y)
                key = (name, label)
                if key not in best or end_d > best[key]["_end"]:
                    best[key] = {"id": f"{name} ({label})", "road": name, "direction": label,
                                 "bearing_deg": round(bearing), "length_km": round(length / 1000, 1),
                                 "x": ex, "y": ey, "_end": end_d, "start_m": float(d[i0]),
                                 "start_km_from_town": round(float(d[i0]) / 1000, 1)}
        if best:
            # The Census file lists some highways twice under two names (State Hwy 32 = "Deer Creek Hwy").
            # Keep one exit per direction and end point, preferring the numbered name.
            numbered = lambda n: 0 if n.startswith(("I-", "US Hwy", "State Hwy", "State Rte")) else 1
            out = []
            for e in sorted(best.values(), key=lambda e: (numbered(e["road"]), e["start_km_from_town"], e["id"])):
                same = [o for o in out if o["direction"] == e["direction"]
                        and math.hypot(o["x"][-1] - e["x"][-1], o["y"][-1] - e["y"][-1]) < 1500]
                if not same:
                    out.append(e)
            return tuple(sorted(out, key=lambda e: (e["start_km_from_town"], e["id"])))
    return tuple()


def blocked(exit_, fire_mask, xmin, ymax):
    """
    Does this exit run through a burning (or forecast-burning) square of the fire's grid?
    Returns None if clear, else the distance (km) along the road from the town to the first fire square.
    """
    r, c = grid.cell_of(exit_["x"], exit_["y"], xmin, ymax)
    along = np.concatenate([[0], np.cumsum(np.hypot(np.diff(exit_["x"]), np.diff(exit_["y"])))])
    # Ignore the first 1.5 km: that is the town itself. If fire is AT the town, every road starts in it;
    # the question is whether the road then runs INTO more fire.
    inside = (r >= 0) & (along + exit_.get("start_m", 0) > SKIP_TOWN_M)
    hit = np.zeros(len(r), bool)
    hit[inside] = fire_mask[r[inside], c[inside]]
    if not hit.any():
        return None
    k = int(np.argmax(hit))
    return round(float(along[k] + exit_.get("start_m", 0)) / 1000, 1)


def exit_geojson(exit_, props=None):
    lon, lat = grid.TO_LONLAT.transform(exit_["x"], exit_["y"])
    coords = [[round(a, 5), round(b, 5)] for a, b in zip(lon, lat)][::2] + [[round(lon[-1], 5), round(lat[-1], 5)]]
    return {"type": "Feature", "properties": {"id": exit_["id"], **(props or {})},
            "geometry": {"type": "LineString", "coordinates": coords}}
