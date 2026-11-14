"""
LIVE mode: California right now, from NOAA GOES-18 (GOES-West), which scans the US every 5 minutes.

state()                  every active fire in California, grouped into incidents and ranked by a triage score
incident_situation(id)   one incident: its last 6 hours from GOES-18, the trained model's forecast for the next
                         1-3 h (with live weather), town countdowns and exits - the same structure as REPLAY

Approximations (shown in the app): fire area = number of fire pixels x pixel size (GOES-18 pixels are about
2.2 x 2.9 km over California); growth compares the last 15 minutes with the same 15 minutes one hour earlier.
"""

import glob
import math
import os
import threading
import time
from types import SimpleNamespace

import joblib
import numpy as np
import pandas as pd
import s3fs
import xarray as xr
from scipy.sparse.csgraph import connected_components
from scipy.spatial import cKDTree

from . import store
from . import situation as S
from .paths import LIVE_CACHE, MODEL_FILE, grid

import net                      # src/net.py (retrying web requests)
import p2_goes                  # src/p2_goes.py (GOES pixels -> burning squares)
import p2_static                # src/p2_static.py (terrain + vegetation per square)
import p2_track                 # src/p2_track.py (follow one fire)
import p3_core as c             # src/p3_core.py (model + forecast)
from california import in_california
from check_sources import FIRE_CODES, goes_lat_lon

BUCKET = "noaa-goes18"
SAT = "GOES-18"
REFRESH_S = 300                  # new GOES scans arrive every 5 minutes
HISTORY_H = 6                    # an incident uses the last 6 hours of scans
LINK_M = 6000                    # fire pixels within 6 km belong to the same incident
PIXEL_KM2 = 2.24 * 2.87          # GOES-18 pixel footprint over California (measured in Phase 2)
GOES_DIR = os.path.join(LIVE_CACHE, "goes")
os.makedirs(GOES_DIR, exist_ok=True)

_lock = threading.Lock()
_fs = None
_grid = None                     # (lat, lon, x, y, california index) for the GOES-18 image, computed once
_state = {"t": 0, "data": None, "registry": {}}
_inc_cache = {}
_wx_cache = {}


def _s3():
    global _fs
    if _fs is None:
        _fs = s3fs.S3FileSystem(anon=True)
    return _fs


# ---------------------------------------------------------------------------
# GOES files
# ---------------------------------------------------------------------------
def _now(at):
    return pd.Timestamp(at) if at is not None else pd.Timestamp.now(tz="UTC")


def _recent_files(hours_back, at=None):
    """GOES-18 fire files from the `hours_back` hours before now (or before the archive time `at`), oldest first."""
    now = _now(at)
    names = []
    for h in range(hours_back + 1, -1, -1):
        t = now - pd.Timedelta(hours=h)
        try:
            names += [n for n in _s3().ls(f"{BUCKET}/ABI-L2-FDCC/{t.year}/{t.day_of_year:03d}/{t.hour:02d}/")
                      if n.endswith(".nc")]
        except FileNotFoundError:
            pass
    out = sorted((p2_goes.scan_time(n), n) for n in set(names))
    cutoff = now - pd.Timedelta(hours=hours_back, minutes=10)
    return [(t, n) for t, n in out if cutoff <= t <= now]


def _local(name):
    """Download a GOES file once (kept in data/live_cache/goes for 8 hours)."""
    path = os.path.join(GOES_DIR, os.path.basename(name))
    if not os.path.exists(path):
        for attempt in range(4):
            try:
                _s3().get(name, path + ".part")
                os.replace(path + ".part", path)
                break
            except Exception:
                time.sleep(1 + attempt)
    return path if os.path.exists(path) else None


def _cleanup():
    for p in glob.glob(os.path.join(GOES_DIR, "*.nc")):
        if time.time() - os.path.getmtime(p) > 8 * 3600:
            os.remove(p)


def _goes_grid(ds):
    """lat/lon/x/y of every GOES-18 pixel, and the flat index of the pixels inside California (computed once)."""
    global _grid
    if _grid is None:
        lat, lon = goes_lat_lon(ds)
        ok = np.isfinite(lat) & (lat > 32) & (lat < 42.5) & (lon > -125) & (lon < -113.5)
        ca = np.zeros_like(ok)
        ca[ok] = in_california(lat[ok], lon[ok])
        idx = np.flatnonzero(ca)
        x, y = grid.TO_ALBERS.transform(lon.ravel()[idx], lat.ravel()[idx])
        _grid = (lat.ravel()[idx], lon.ravel()[idx], np.asarray(x), np.asarray(y), idx, ds["Mask"].shape)
    return _grid


def _ca_fire_pixels(path):
    """Fire pixels inside California in one GOES file: DataFrame lat, lon, x, y, power_mw, code."""
    ds = xr.open_dataset(path, decode_times=False)
    try:
        lat, lon, x, y, idx, shape = _goes_grid(ds)
        mask = ds["Mask"].values.ravel()[idx]
        hit = np.isin(mask, FIRE_CODES)
        power = ds["Power"].values.ravel()[idx][hit] if "Power" in ds else np.full(hit.sum(), np.nan)
    finally:
        ds.close()
    return pd.DataFrame({"lat": lat[hit], "lon": lon[hit], "x": x[hit], "y": y[hit],
                         "power_mw": power.astype(float), "code": mask[hit].astype(int)})


# ---------------------------------------------------------------------------
# Weather (Open-Meteo forecast API, no key)
# ---------------------------------------------------------------------------
WX_VARS = "wind_speed_10m,wind_direction_10m,wind_gusts_10m,relative_humidity_2m,temperature_2m"


def _is_archive(at):
    return at is not None and (pd.Timestamp.now(tz="UTC") - pd.Timestamp(at)) > pd.Timedelta(days=2)


def _weather_now(points, at=None):
    """Current weather (or weather at archive time `at`) for a list of (lat, lon). Cached. List of dicts (or None)."""
    if _is_archive(at):
        out = []
        for a, b in points:
            try:
                w = _weather_hourly(a, b, [pd.Timestamp(at)], at).iloc[0]
                out.append({"speed_kmh": round(w.wind_speed_kmh, 1), "gust_kmh": round(w.wind_gust_kmh, 1),
                            "from_deg": round(w.wind_dir_deg), "humidity_pct": round(w.humidity_pct),
                            "temp_c": round(w.temp_c, 1)})
            except Exception:
                out.append(None)
        return out
    key = tuple((round(a, 2), round(b, 2)) for a, b in points)
    if key in _wx_cache and time.time() - _wx_cache[key][0] < 900:
        return _wx_cache[key][1]
    out = [None] * len(points)
    if points:
        try:
            js = net.get("https://api.open-meteo.com/v1/forecast", tries=3, timeout=30, params={
                "latitude": ",".join(f"{a:.3f}" for a, _ in points), "longitude": ",".join(f"{b:.3f}" for _, b in points),
                "current": WX_VARS, "wind_speed_unit": "kmh", "timezone": "GMT"}).json()
            js = js if isinstance(js, list) else [js]
            out = [{"speed_kmh": j["current"]["wind_speed_10m"], "gust_kmh": j["current"]["wind_gusts_10m"],
                    "from_deg": j["current"]["wind_direction_10m"], "humidity_pct": j["current"]["relative_humidity_2m"],
                    "temp_c": j["current"]["temperature_2m"]} for j in js]
        except Exception:
            pass
    _wx_cache[key] = (time.time(), out)
    return out


def _weather_hourly(lat, lon, times, at=None):
    """Hourly weather table (hour_idx, ...) for the given UTC times: forecast API (live) or archive API (past)."""
    if _is_archive(at):
        js = net.get("https://archive-api.open-meteo.com/v1/archive", tries=6, timeout=30, params={
            "latitude": lat, "longitude": lon, "hourly": WX_VARS, "wind_speed_unit": "kmh", "timezone": "GMT",
            "start_date": min(times).strftime("%Y-%m-%d"), "end_date": max(times).strftime("%Y-%m-%d")}).json()
    else:
        js = net.get("https://api.open-meteo.com/v1/forecast", tries=3, timeout=30, params={
            "latitude": lat, "longitude": lon, "hourly": WX_VARS, "wind_speed_unit": "kmh", "timezone": "GMT",
            "past_hours": HISTORY_H + 2, "forecast_hours": 6}).json()
    h = pd.DataFrame(js["hourly"])
    h["time"] = pd.to_datetime(h.time, utc=True)
    rows = []
    for i, t in enumerate(times):
        j = int((h.time - t.floor("h")).abs().argmin())
        r = h.iloc[j]
        sp, d = float(r.wind_speed_10m), float(r.wind_direction_10m)
        rows.append({"hour_idx": i, "time_utc": t, "wind_speed_kmh": sp, "wind_dir_deg": d,
                     "wind_gust_kmh": float(r.wind_gusts_10m), "humidity_pct": float(r.relative_humidity_2m),
                     "temp_c": float(r.temperature_2m),
                     # the vector the wind blows TOWARD (u east, v north), as in Phase 2
                     "wind_u_kmh": -sp * math.sin(math.radians(d)), "wind_v_kmh": -sp * math.cos(math.radians(d))})
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# STATE: all of California
# ---------------------------------------------------------------------------
def _cluster(px):
    """Group fire pixels into incidents: pixels within 6 km of each other belong together."""
    if len(px) == 0:
        return np.array([], int)
    pts = np.column_stack([px.x, px.y])
    pairs = cKDTree(pts).query_pairs(LINK_M, output_type="ndarray")
    from scipy.sparse import coo_matrix
    m = coo_matrix((np.ones(len(pairs)), (pairs[:, 0], pairs[:, 1])), shape=(len(pts), len(pts))) if len(pairs) else \
        coo_matrix((len(pts), len(pts)))
    return connected_components(m, directed=False)[1]


def _incident_id(lat, lon, at=None):
    iid = f"inc_{abs(lat):.2f}N_{abs(lon):.2f}W".replace(".", "p")
    return iid + (f"@{pd.Timestamp(at):%Y%m%dT%H%MZ}" if at is not None else "")


def _compute_state(at=None):
    files = _recent_files(2, at)
    if not files:
        return {"satellite": SAT, "error": "No GOES-18 files found", "incidents": []}
    latest_t = files[-1][0]
    now_files = [f for f in files if f[0] > latest_t - pd.Timedelta(minutes=14)]          # last 3 scans
    ago_files = [f for f in files if latest_t - pd.Timedelta(minutes=74) < f[0] <= latest_t - pd.Timedelta(minutes=60)]
    tables = {}
    for t, n in now_files + ago_files:
        p = _local(n)
        if p:
            tables[n] = _ca_fire_pixels(p)
    now_px = pd.concat([tables[n] for _, n in now_files if n in tables] or [pd.DataFrame()], ignore_index=True)
    ago_px = pd.concat([tables[n] for _, n in ago_files if n in tables] or [pd.DataFrame()], ignore_index=True)
    if len(now_px):
        now_px = now_px.drop_duplicates(["lat", "lon"])   # the same pixel in 2-3 scans counts once
    if len(ago_px):
        ago_px = ago_px.drop_duplicates(["lat", "lon"])
    labels = _cluster(now_px)
    towns = store.towns()
    tx, ty, tpop = towns.x.to_numpy(), towns.y.to_numpy(), towns.population.to_numpy()
    incidents, registry, features = [], {}, []
    groups = [now_px[labels == k] for k in (np.unique(labels) if len(labels) else [])]
    centroids = [(float(g.lat.mean()), float(g.lon.mean())) for g in groups]
    wx_all = _weather_now(centroids, at)
    for g, (lat0, lon0), wx in zip(groups, centroids, wx_all):
        cx, cy = float(g.x.mean()), float(g.y.mean())
        n_ago = int(((np.hypot(ago_px.x - cx, ago_px.y - cy) < LINK_M + 3000).sum()) if len(ago_px) else 0)
        d_town = np.hypot(tx - cx, ty - cy)
        j = int(d_town.argmin())
        # people within 10 km of any fire pixel
        dmin = np.min(np.hypot(tx[:, None] - g.x.to_numpy()[None], ty[:, None] - g.y.to_numpy()[None]), axis=1)
        people = int(tpop[dmin <= 10000].sum())
        # wind toward towns: is the wind blowing from the fire toward a town within 25 km? (1 = straight at it)
        toward = 0.0
        if wx:
            u, v = -math.sin(math.radians(wx["from_deg"])), -math.cos(math.radians(wx["from_deg"]))
            near = np.nonzero((d_town < 25000) & (tpop >= 500))[0]
            for k in near:
                dx, dy = tx[k] - cx, ty[k] - cy
                toward = max(toward, (u * dx + v * dy) / max(math.hypot(dx, dy), 1))
        area = len(g) * PIXEL_KM2
        growth = (len(g) - n_ago) * PIXEL_KM2
        wind_part = max(toward, 0) * min(1, (wx["speed_kmh"] if wx else 0) / 30)
        parts = {"people": round(min(1, math.log10(1 + people) / 5), 3), "wind_toward_towns": round(wind_part, 3),
                 "growth": round(min(1, max(growth, 0) / 20), 3)}
        score = round(100 * (0.5 * parts["people"] + 0.3 * parts["wind_toward_towns"] + 0.2 * parts["growth"]), 1)
        iid = _incident_id(lat0, lon0, at)
        inc = {"id": iid, "lat": round(lat0, 4), "lon": round(lon0, 4), "n_pixels": len(g),
               "area_km2": round(area, 1), "growth_km2_last_hour": round(growth, 1),
               "frp_mw": round(float(np.nansum(g.power_mw)), 1),
               "nearest_town": towns.name.iloc[j], "nearest_town_km": round(float(d_town[j]) / 1000, 1),
               "people_10km": people, "wind": wx, "wind_toward_towns": round(max(toward, 0), 2),
               "triage_score": score, "triage_parts": parts, "at": None if at is None else pd.Timestamp(at).isoformat(),
               "bounds": [round(float(g.lon.min()), 4), round(float(g.lat.min()), 4),
                          round(float(g.lon.max()), 4), round(float(g.lat.max()), 4)]}
        incidents.append(inc)
        registry[iid] = inc
        for _, p in g.iterrows():
            features.append({"type": "Feature", "properties": {"incident_id": iid, "power_mw": None if pd.isna(p.power_mw)
                             else round(float(p.power_mw), 1)},
                             "geometry": {"type": "Point", "coordinates": [round(p.lon, 4), round(p.lat, 4)]}})
    incidents.sort(key=lambda i: -i["triage_score"])
    for rank, inc in enumerate(incidents, start=1):
        inc["rank"] = rank
    age = (pd.Timestamp.now(tz="UTC") - latest_t).total_seconds() / 60
    return {"satellite": SAT, "archive": at is not None, "at": None if at is None else pd.Timestamp(at).isoformat(),
            "scan_time_utc": latest_t.isoformat(), "scan_age_min": None if at is not None else round(age, 1),
            "computed_utc": pd.Timestamp.now(tz="UTC").isoformat(), "refresh_s": REFRESH_S,
            "scans_used": len(now_files), "incidents": incidents,
            "pixels": {"type": "FeatureCollection", "features": features},
            "triage_formula": "score = 100 x (0.5 people within 10 km [log scale] + 0.3 wind blowing toward a town "
                              "within 25 km x wind strength + 0.2 growth in the last hour)",
            "notes": ["Area = fire pixels x GOES-18 pixel size (about 6.4 km2): approximate.",
                      "Growth compares the last 15 min with the same 15 min one hour earlier.",
                      "Small agricultural or industrial heat sources can appear as 1-pixel incidents."]}, registry


_archive = {}                     # archive time -> (state, registry); archive states never change


def state(force=False, at=None):
    """California now (cached, recomputed when older than 5 minutes) - or at a past archive time `at`."""
    if at is not None:
        key = pd.Timestamp(at).floor("5min").isoformat()
        with _lock:
            if key not in _archive:
                data, registry = _compute_state(pd.Timestamp(key))
                _archive[key] = data
                _state["registry"].update(registry)
            return _archive[key]
    with _lock:
        if force or _state["data"] is None or time.time() - _state["t"] > REFRESH_S - 30:
            try:
                data, registry = _compute_state()
                _state.update(t=time.time(), data=data)
                _state["registry"].update(registry)
                _cleanup()
            except Exception as e:
                if _state["data"] is None:
                    return {"satellite": SAT, "error": f"{type(e).__name__}: {e}", "incidents": []}
        out = dict(_state["data"])
        out["scan_age_min"] = round((pd.Timestamp.now(tz="UTC") - pd.Timestamp(out["scan_time_utc"])).total_seconds() / 60, 1) \
            if out.get("scan_time_utc") else None
        return out


def _lookup(incident_id):
    if incident_id not in _state["registry"]:
        if "@" in incident_id:
            state(at=pd.Timestamp(incident_id.split("@")[1]))
        else:
            state()
    return _state["registry"].get(incident_id)


def incident_summary(incident_id):
    if _lookup(incident_id) is None:
        return None
    inc = _state["registry"].get(incident_id)
    if inc is None:
        return None
    return {k: inc[k] for k in ("rank", "area_km2", "growth_km2_last_hour", "nearest_town", "nearest_town_km",
                                "people_10km", "wind", "wind_toward_towns", "triage_score") if k in inc}


# ---------------------------------------------------------------------------
# INCIDENT: one live fire, forecast by the trained model
# ---------------------------------------------------------------------------
_bundle = None


def _model():
    global _bundle
    if _bundle is None:
        b = joblib.load(MODEL_FILE)
        main = b["main"]
        lr, hgb = c.Model("logreg", b["logreg"]), c.Model("hgb", b["hgb"])
        models = {"logreg": lr, "hgb": hgb, "average": c.Average("average", lr, hgb),
                  "hgb_direct": c.Direct("hgb_direct", b["hgb_direct"])}
        _bundle = (models[main], b["square_thresholds"][main], b["town_threshold"][main])
    return _bundle


class LiveFire(c.Fire):
    """A Fire built from live data instead of the Phase 2 files (same attributes, so the same forecast code runs)."""

    def __init__(self, fire_id, burning, hours, static, weather):
        self.fire_id = fire_id
        self.burning, self.hours, self.static, self.weather = burning, hours, static, weather
        n = len(hours)
        self.has_data = (hours.n_files > 0).to_numpy()
        self.truth_ok = self.has_data.copy()
        self.truth = np.zeros((max(n, grid.N_HOURS), c.N, c.N), bool)
        self.truth[burning.hour_idx, burning.row, burning.col] = True


def _static_for(box):
    path = os.path.join(LIVE_CACHE, f"static_{int(box.xmin)}_{int(box.ymax)}.parquet")
    if os.path.exists(path):
        return pd.read_parquet(path)
    df, _ = p2_static.build_fire(box)
    df = df.sort_values(["row", "col"]).reset_index(drop=True)
    df.to_parquet(path, index=False)
    return df


def incident_situation(incident_id):
    inc = _lookup(incident_id)
    if inc is None:
        return None
    at = pd.Timestamp(inc["at"]) if inc.get("at") else None
    scan = (state(at=at) if at is not None else _state["data"])["scan_time_utc"]
    key = (incident_id, scan)
    if key in _inc_cache:
        return _inc_cache[key]

    xmin, ymin, xmax, ymax = grid.grid_box(inc["lat"], inc["lon"])
    box = SimpleNamespace(fire_id=incident_id, xmin=xmin, ymin=ymin, xmax=xmax, ymax=ymax)
    t_end = pd.Timestamp(scan) + pd.Timedelta(minutes=5)
    t_start = t_end - pd.Timedelta(hours=HISTORY_H)
    slots = [t_start + pd.Timedelta(hours=h) for h in range(HISTORY_H + 3)]      # 6 past hours + 3 forecast hours

    # 1. the last 6 hours of GOES-18 scans -> burning squares per hour (same code as Phase 2)
    files = [(t, n) for t, n in _recent_files(HISTORY_H + 1, pd.Timestamp(scan) + pd.Timedelta(minutes=1)) if t >= t_start]
    tables, n_files, footprint = [], np.zeros(len(slots), int), None
    for t, n in files:
        p = _local(n)
        if not p:
            continue
        h = int((t - t_start) // pd.Timedelta(hours=1))
        if not 0 <= h < HISTORY_H:
            continue
        px, footprint = p2_goes.read_fire_pixels(p, box)
        n_files[h] += 1
        px["scan_time_utc"], px["hour_idx"] = t, h
        tables.append(px)
    pixels = pd.concat(tables, ignore_index=True) if tables else pd.DataFrame()
    burning, whole = p2_goes.burning_squares(pixels, box, footprint) if footprint and len(pixels) else \
        (pd.DataFrame(columns=["hour_idx", "row", "col", "n_scans", "max_power_mw", "gapfilled"]), [])
    burning = burning[burning.hour_idx < HISTORY_H]
    r0, c0 = grid.cell_of(*grid.TO_ALBERS.transform(inc["lon"], inc["lat"]), xmin, ymax)
    burning = p2_track.track(burning, (int(r0), int(c0))) if len(burning) else burning
    hours = pd.DataFrame({"hour_idx": range(len(slots)), "time_utc": slots, "n_files": n_files,
                          "n_fire_pixels": [int((pixels.hour_idx == h).sum()) if len(pixels) else 0 for h in range(len(slots))],
                          "n_burning_squares": [int((burning.hour_idx == h).sum()) for h in range(len(slots))],
                          "hour_gapfilled": [h in whole for h in range(len(slots))]})

    # 2. land + live weather
    static = _static_for(box)
    weather = _weather_hourly(inc["lat"], inc["lon"], slots, at)

    # 3. the trained model's forecast at the latest hour
    model, th, t_town = _model()
    fire = LiveFire(incident_id, burning.reset_index(drop=True), hours, static, weather)
    h_now = HISTORY_H - 1
    now, ever = fire.now_and_ever(h_now)
    note = ("ARCHIVE replay of the live pipeline at a past time: " if at is not None else "Live: ") + (
        "fire squares from the last 6 h of GOES-18 scans; forecast by the model trained on 2018-2022 fires "
        + ("using Open-Meteo archive weather." if at is not None else "using live Open-Meteo weather."))
    probs = None
    if now.any():
        probs = c.forecast(model, fire, h_now, th)
    else:
        note = "GOES-18 saw no fire pixels for this incident in the last hour: no forecast."
    grow = list(c.grow_baseline(now)) if now.any() else None
    tw = store.towns()
    pad = 1000
    near = tw[(tw.x > xmin - pad) & (tw.x < xmax + pad) & (tw.y > ymin - pad) & (tw.y < ymax + pad)]
    towns = near[["name", "lat", "lon", "population"]].to_dict(orient="records")
    prev = float((burning.hour_idx == h_now - 1).sum() * 4) if fire.has_data[h_now - 1] else None
    wx = weather.iloc[h_now]
    sit = S.build(fire_id=incident_id, name=f"Incident near {inc['nearest_town']}", mode="live",
                  time_utc=str(pd.Timestamp(scan)), xmin=xmin, ymax=ymax, now=now, ever=ever, probs=probs, grow=grow,
                  th=th, t_town=t_town, towns=towns, prev_area_km2=prev, data_note=note, scan_time_utc=scan,
                  wind={"speed_kmh": round(float(wx.wind_speed_kmh), 1), "gust_kmh": round(float(wx.wind_gust_kmh), 1),
                        "from_deg": round(float(wx.wind_dir_deg)), "humidity_pct": round(float(wx.humidity_pct)),
                        "temp_c": round(float(wx.temp_c), 1)})
    sit["incident"] = inc
    sit["archive"] = at is not None
    sit["history"] = [{"hour_idx": int(r.hour_idx), "time_utc": str(r.time_utc), "n_files": int(r.n_files),
                       "n_burning_squares": int(r.n_burning_squares)} for r in hours.itertuples() if r.hour_idx < HISTORY_H]
    _inc_cache[key] = sit
    return sit


def warm_up():
    """Compute the state once in the background when the server starts."""
    threading.Thread(target=lambda: state(), daemon=True).start()
