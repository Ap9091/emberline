"""
Emberline - Phase 3 outputs: replay files for the app, failure maps, and the evacuation-order comparison.
Used by notebooks/03_train.ipynb.
"""

import json
import os

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

import grid
import p3_core as c

N = c.N
STATUS_MONITOR_KM = 20      # towns within 20 km of the fire are shown as MONITOR


# ---------------------------------------------------------------------------
# Town status at one forecast (the countdowns in the app)
# ---------------------------------------------------------------------------
def town_status(probs, now, near, threshold):
    """
    For each town: EVACUATE (fire there now, or forecast within 1 h), WARNING (forecast at +2/+3 h),
    MONITOR (fire within 20 km), or '' (far away). Also the hours until fire is forecast (eta_h).
    probs: (3, 40, 40) forecast; now: (40, 40) burning now; near: (towns, 40, 40) squares within 1 km of each town.
    """
    nf = near.astype(np.float32)
    at_town_now = np.einsum("rs,trs->t", now.astype(np.float32), nf) > 0
    hit_k = np.einsum("krs,trs->tk", (probs >= threshold).astype(np.float32), nf) > 0     # towns x 3
    eta = np.where(hit_k.any(axis=1), hit_k.argmax(axis=1) + 1, 0)
    # distance (km) from each town's nearest square to the nearest burning square
    br, bc = np.nonzero(now)
    if len(br):
        rr, cc = np.meshgrid(np.arange(N), np.arange(N), indexing="ij")
        d_sq = (np.hypot(rr[..., None] - br, cc[..., None] - bc).min(axis=2)) * c.CELL_KM
        dist = np.array([d_sq[m].min() if m.any() else np.inf for m in near])
    else:
        dist = np.full(len(near), np.inf)
    status = np.where(at_town_now | (eta == 1), "EVACUATE",
                      np.where(eta >= 2, "WARNING", np.where(dist <= STATUS_MONITOR_KM, "MONITOR", "")))
    eta = np.where(at_town_now, 0, eta)
    return status, eta, dist


# ---------------------------------------------------------------------------
# Replay file (one JSON per fire, read by the app in Phase 4)
# ---------------------------------------------------------------------------
def export_replay(res, fire_id, model_name, t_town, t_prop, towns, out_dir, min_prob=0.05):
    fire = res["fires"][fire_id]
    w = grid.load_windows().set_index("fire_id").loc[fire_id]
    t, near = c.town_squares(fire, towns)
    sel = {int(h): i for i, h in zip(np.nonzero(res["fire_id"] == fire_id)[0], res["hour"][res["fire_id"] == fire_id])}
    hours_tab = fire.hours.set_index("hour_idx")
    wx = fire.weather.set_index("hour_idx")
    frames = []
    for h in range(grid.N_HOURS):
        now, _ = fire.now_and_ever(h)
        frame = {"hour_idx": h, "time_utc": hours_tab.time_utc[h].isoformat(),
                 "has_data": bool(fire.has_data[h]),
                 "burning": np.argwhere(fire.truth[h]).tolist(),          # what GOES really saw (incl. gap fill)
                 "wind": {"speed_kmh": round(float(wx.wind_speed_kmh[h]), 1), "gust_kmh": round(float(wx.wind_gust_kmh[h]), 1),
                          "from_deg": round(float(wx.wind_dir_deg[h])), "humidity_pct": round(float(wx.humidity_pct[h])),
                          "temp_c": round(float(wx.temp_c[h]), 1)},
                 "forecast": None, "baseline_grow_1km": None, "towns": []}
        if h in sel:
            i = sel[h]
            probs = res["pred"][model_name][i]
            frame["forecast"] = {str(k + 1): [[int(r), int(cc), round(float(probs[k, r, cc]), 3)]
                                              for r, cc in np.argwhere(probs[k] >= min_prob)] for k in range(c.HORIZON)}
            grow = res["pred"]["grow_1km"][i]
            frame["baseline_grow_1km"] = {str(k + 1): np.argwhere(grow[k] > 0.5).tolist() for k in range(c.HORIZON)}
            status, eta, dist = town_status(probs, now, near, t_town)
            for j in np.nonzero(status != "")[0]:
                frame["towns"].append({"name": t.name[j], "status": str(status[j]), "eta_h": int(eta[j]),
                                       "dist_km": round(float(dist[j]), 1),
                                       "population": None if pd.isna(t.population[j]) else int(t.population[j])})
        frames.append(frame)
    out = {"fire_id": fire_id, "name": w["name"], "split": w.split, "model": model_name,
           "town_threshold": t_town, "rollout_threshold": t_prop,
           "grid": {"crs": "EPSG:3310", "xmin": float(w.xmin), "ymax": float(w.ymax), "cell_m": grid.CELL_M, "n": N},
           "square_centres_latlon": fire.static[["lat", "lon"]].round(5).to_numpy().tolist(),   # row-major, 1600
           "towns": [{"name": t.name[j], "lat": float(t.lat[j]), "lon": float(t.lon[j]),
                      "population": None if pd.isna(t.population[j]) else int(t.population[j])} for j in range(len(t))],
           "hours": frames}
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"{fire_id}.json")
    with open(path, "w") as f:
        json.dump(out, f)
    return path


# ---------------------------------------------------------------------------
# Our warnings vs the real evacuation orders
# ---------------------------------------------------------------------------
EVAC_COLUMNS = ["fire_id", "town", "order_type", "order_time_utc", "source_url"]


def evac_lead_lag(replay_dir, path):
    """
    Compare each official order in data/evac_orders.csv with the first time Emberline put that town on
    WARNING or EVACUATE. lead_h > 0 means we were EARLIER than the official order.
    If the file does not exist yet, write an empty template and return None.
    """
    if not os.path.exists(path):
        pd.DataFrame(columns=EVAC_COLUMNS).to_csv(path, index=False)
        return None
    orders = pd.read_csv(path)
    if orders.empty:
        return None
    rows = []
    for _, o in orders.iterrows():
        rp = os.path.join(replay_dir, f"{o.fire_id}.json")
        first = None
        if os.path.exists(rp):
            rep = json.load(open(rp))
            for fr in rep["hours"]:
                if any(tw["name"] == o.town and tw["status"] in ("WARNING", "EVACUATE") for tw in fr["towns"]):
                    first = pd.Timestamp(fr["time_utc"])
                    break
        official = pd.Timestamp(o.order_time_utc)
        if official.tzinfo is None:
            official = official.tz_localize("UTC")
        rows.append({**o.to_dict(), "emberline_first_warning_utc": first,
                     "lead_h": None if first is None else round((official - first).total_seconds() / 3600, 1)})
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# Failure cases: map + simple diagnosis
# ---------------------------------------------------------------------------
def diagnose(res, i, town_near=None):
    """Simple checks that suggest WHY a forecast went wrong. Returns a list of short reasons."""
    fid, h = res["fire_id"][i], int(res["hour"][i])
    fire = res["fires"][fid]
    hrs = fire.hours.set_index("hour_idx")
    wx = fire.weather.set_index("hour_idx")
    reasons = []
    if h <= 3:
        reasons.append(f"first hours of the fire (hour {h}): very little history to learn from")
    later = [k for k in range(h + 1, min(h + 4, grid.N_HOURS))]
    if any(hrs.n_files[k] < 6 for k in later):
        reasons.append("missing satellite scans in the next 3 h")
    px_now = hrs.n_fire_pixels[h]
    if px_now > 0 and any(hrs.n_fire_pixels[k] < 0.4 * px_now for k in later):
        reasons.append("fire pixels drop sharply next hours (smoke/cloud hiding the fire, or the fire calming at night)")
    d0 = wx.wind_dir_deg[h]
    turn = max(abs((wx.wind_dir_deg[k] - d0 + 180) % 360 - 180) for k in later) if later else 0
    if turn >= 45:
        reasons.append(f"wind direction changes by {turn:.0f} deg within 3 h")
    if wx.wind_gust_kmh[h] >= 50:
        reasons.append(f"strong gusts ({wx.wind_gust_kmh[h]:.0f} km/h): fast runs and embers")
    now = res["now"][i]
    new = res["truth"][i] & ~res["ever"][i][None]
    if now.any() and new.any():
        br, bc = np.nonzero(now)
        far = 0.0
        for k in range(c.HORIZON):
            for r, cc in np.argwhere(new[k]):
                far = max(far, np.hypot(br - r, bc - cc).min() * c.CELL_KM)
        if far > 6:
            reasons.append(f"new fire appears {far:.0f} km from the old edge (spot fire / ember jump, or a separate fire)")
    if not reasons:
        reasons.append("no simple cause found: fire grew faster than similar past cases")
    return reasons


def failure_map(res, i, model_name, threshold, towns, title, path):
    """Three panels: burning now, our forecast (max over +1..+3 h), what really burned in the next 3 h."""
    fid, h = res["fire_id"][i], int(res["hour"][i])
    probs = res["pred"][model_name][i].max(axis=0)
    real = res["truth"][i].any(axis=0)
    fig, ax = plt.subplots(1, 3, figsize=(13, 4.4))
    ax[0].imshow(res["now"][i], cmap="Reds", vmin=0, vmax=1.3)
    ax[0].set_title(f"Burning now (hour {h})")
    im = ax[1].imshow(probs, cmap="magma_r", vmin=0, vmax=1)
    ax[1].contour(probs >= threshold, levels=[0.5], colors="cyan", linewidths=1)
    ax[1].set_title("Forecast: highest chance in next 3 h\n(cyan = above warning threshold)")
    fig.colorbar(im, ax=ax[1], fraction=0.046)
    ax[2].imshow(real, cmap="Oranges", vmin=0, vmax=1.3)
    ax[2].set_title("Really burned in next 3 h")
    fire = res["fires"][fid]
    t, near = c.town_squares(fire, towns)
    for a in ax:
        for j in range(len(t)):
            rr, cc = np.argwhere(near[j]).mean(axis=0)
            if (t.population[j] or 0) >= 1000:
                a.plot(cc, rr, "k^", ms=4)
                a.text(cc + 0.6, rr, t.name[j], fontsize=6)
        a.set_xlim(-0.5, N - 0.5)
        a.set_ylim(N - 0.5, -0.5)
        a.set_xticks([])
        a.set_yticks([])
    fig.suptitle(title, fontsize=10)
    fig.tight_layout()
    fig.savefig(path, dpi=110)
    plt.close(fig)
    return path
