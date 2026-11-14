"""
Exports what the in-browser "what if the wind changes?" needs (used by build_site.py for the hosted version):

  data/whatif/model.json      the trained logistic regression: feature order, median fill values, scaler, weights,
                              the square cut-offs and the town warning threshold
  data/whatif/{fire}.json     one replay fire: grid, land per square, weather and time per hour, the burning squares,
                              square corners (for drawing), towns (with the squares within 1 km) and their exits

app/static/js/whatif_engine.js runs the same steps as the Python backend (features -> model -> rolling forward ->
town countdowns -> exit checks) on these files. build_site.py checks that both give the same answers.
"""

import json
import os

import joblib
import numpy as np

from backend import roads as R
from backend import situation as S
from backend import store
from backend.paths import MODEL_FILE, grid

import p2_build_dataset as p2
import p3_core as c

N = grid.N_CELLS


def _r(a, d=3):
    return [None if (isinstance(v, float) and np.isnan(v)) else round(float(v), d) for v in a]


def model_json():
    b = joblib.load(MODEL_FILE)
    if b["main"] != "logreg":
        raise SystemExit(f"in-browser what-if needs the logistic regression; main model is {b['main']}")
    pipe = b["logreg"]
    imp, sc, lr = pipe.named_steps["simpleimputer"], pipe.named_steps["standardscaler"], pipe.named_steps["logisticregression"]
    return {"features": list(b["features"]), "numeric": c.NUMERIC, "veg_codes": c.VEG_CODES,
            "median": _r(imp.statistics_, 6), "mean": _r(sc.mean_, 6), "scale": _r(sc.scale_, 6),
            "coef": _r(lr.coef_[0], 8), "intercept": round(float(lr.intercept_[0]), 8),
            "th": b["square_thresholds"]["logreg"], "t_town": b["town_threshold"]["logreg"],
            "candidate_km": p2.CANDIDATE_KM, "near_km": p2.NEAR_KM, "cell_km": c.CELL_KM}


def fire_json(fid):
    rp = store.replay(fid)
    g = rp["grid"]
    fire = c.Fire(fid)
    st = fire.static.sort_values(["row", "col"]).reset_index(drop=True)
    hours = fire.hours.set_index("hour_idx")
    local = [hours.time_utc[h].tz_convert("America/Los_Angeles").hour for h in range(grid.N_HOURS)]
    w = fire.weather.set_index("hour_idx")
    b = fire.burning
    # corners of every square, (41 x 41) lon/lat, for drawing squares and outlines in the browser
    cx = g["xmin"] + np.arange(N + 1) * grid.CELL_M
    cy = g["ymax"] - np.arange(N + 1) * grid.CELL_M
    X, Y = np.meshgrid(cx, cy)
    lon, lat = grid.TO_LONLAT.transform(X.ravel(), Y.ravel())
    # towns: the same list the replay uses, with the squares within 1 km of each
    towns = rp["towns"]
    near, tx, ty = S.town_near(towns, g["xmin"], g["ymax"])
    town_rows = []
    for j, t in enumerate(towns):
        exits = []
        for ex in R.exits_for(float(tx[j]), float(ty[j])):
            r_, c_ = grid.cell_of(ex["x"], ex["y"], g["xmin"], g["ymax"])
            along = np.concatenate([[0], np.cumsum(np.hypot(np.diff(ex["x"]), np.diff(ex["y"])))]) + ex.get("start_m", 0)
            ok = (r_ >= 0) & (along > R.SKIP_TOWN_M)
            # keep each square once, with the distance where the road first enters it
            seen, path = set(), []
            for rr, cc, d in zip(r_[ok], c_[ok], along[ok]):
                if (rr, cc) not in seen:
                    seen.add((rr, cc))
                    path.append([int(rr), int(cc), round(float(d) / 1000, 4)])
            feat = R.exit_geojson(ex, {"town": t["name"]})
            exits.append({"id": ex["id"], "road": ex["road"], "direction": ex["direction"], "length_km": ex["length_km"],
                          "path": path, "coords": feat["geometry"]["coordinates"]})
        town_rows.append({"name": t["name"], "lat": t["lat"], "lon": t["lon"], "population": int(t.get("population") or 0),
                          "x": round(float(tx[j])), "y": round(float(ty[j])),
                          "near": np.argwhere(near[j]).tolist(), "exits": exits})
    return {
        "fire_id": fid, "xmin": g["xmin"], "ymax": g["ymax"], "n": N, "cell_m": grid.CELL_M,
        "corners": [[round(a, 5), round(b_, 5)] for a, b_ in zip(lon, lat)],
        "static": {k: _r(st[k].to_numpy(), 3) for k in ["x", "y", "elevation_m", "slope_deg", "frac_tree", "frac_shrub",
                                                          "frac_grass", "frac_crop", "frac_built", "frac_water"]}
                  | {"veg_class": [int(v) for v in st.veg_class]},
        "hours": {"n_files": [int(hours.n_files.get(h, 0)) for h in range(grid.N_HOURS)], "local_hour": local},
        "weather": {k: _r([w[k].get(h, np.nan) for h in range(grid.N_HOURS)], 3)
                    for k in ["wind_speed_kmh", "wind_gust_kmh", "wind_dir_deg", "humidity_pct", "temp_c", "wind_u_kmh", "wind_v_kmh"]},
        "burning": [[int(r.hour_idx), int(r.row), int(r.col), int(bool(r.gapfilled)),
                     None if np.isnan(r.max_power_mw) else round(float(r.max_power_mw), 1)] for r in b.itertuples()],
        "towns": town_rows,
    }


def export(data_dir, fire_ids):
    out = os.path.join(data_dir, "whatif")
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "model.json"), "w") as f:
        json.dump(model_json(), f, separators=(",", ":"))
    for fid in fire_ids:
        path = os.path.join(out, f"{fid}.json")
        with open(path, "w") as f:
            json.dump(fire_json(fid), f, separators=(",", ":"))
        print(f"what-if inputs {fid}: {os.path.getsize(path) // 1024} KB", flush=True)
