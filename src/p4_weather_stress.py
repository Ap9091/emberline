"""
Emberline - weather stress test: would the test results hold with the weather FORECAST people really had?

The model was trained and tested with Open-Meteo's archive (ERA5 "reanalysis": the weather as reconstructed
afterwards). During a real fire, only a forecast exists. So we re-run the SAME trained model (no retraining,
no new settings) on the SAME 18 test fires, swapping in two kinds of archived forecasts from Open-Meteo:

  era5          what the published results used (re-run here as a check: it must match results/metrics.json)
  forecast      Historical Forecast API: short-range weather-model forecasts, as issued at the time
                (each hour comes from a recent model run, a few hours ahead at most)
  day_before    Previous Runs API "previous_day1": the forecast made about a day earlier, a harder test
                than what a fire crew would have had

Same point per fire (the start point), same 74 hours, same scoring code as the test (src/p3_core.py).
Also: the comparison with official evacuation orders on the three replay fires, per weather source.

Run:   .venv/bin/python src/p4_weather_stress.py      (downloads are cached in data/processed/weather_forecast/)
Output: results/weather_stress.json and results/weather_stress.md
"""

import json
import os
import sys
import time

import joblib
import numpy as np
import pandas as pd
import requests

import grid
import p2_build_dataset as p2
import p3_core as c

ROOT = grid.ROOT
OUT_DIR = os.path.join(ROOT, "data", "processed", "weather_forecast")
VARS = ["wind_speed_10m", "wind_direction_10m", "wind_gusts_10m", "relative_humidity_2m", "temperature_2m"]
RENAME = dict(zip(VARS, ["wind_speed_kmh", "wind_dir_deg", "wind_gust_kmh", "humidity_pct", "temp_c"]))
SOURCES = {
    "forecast": ("https://historical-forecast-api.open-meteo.com/v1/forecast", ""),
    "day_before": ("https://previous-runs-api.open-meteo.com/v1/forecast", "_previous_day1"),
}
REPLAY_FIRES = ["park_fire_2024", "eaton_fire_2025", "palisades_fire_2025"]


def fetch(url, params, tries=40):
    for attempt in range(tries):
        try:
            r = requests.get(url, params=params, timeout=60)
            if r.status_code == 429:
                time.sleep(3)
                continue
            r.raise_for_status()
            return r.json()
        except requests.RequestException:
            if attempt == tries - 1:
                raise
            time.sleep(3)
    raise RuntimeError("Open-Meteo kept refusing")


def forecast_weather(fid, kind):
    """74-hour weather table for one fire from an archived forecast, in the same layout as data/processed/weather."""
    path = os.path.join(OUT_DIR, kind, f"{fid}.parquet")
    if os.path.exists(path):
        return pd.read_parquet(path)
    w = pd.read_csv(os.path.join(ROOT, "data", "fire_windows.csv")).set_index("fire_id").loc[fid]
    t0 = pd.Timestamp(w.t_start_utc)
    last = t0 + pd.Timedelta(hours=grid.N_HOURS - 1)
    url, suffix = SOURCES[kind]
    js = fetch(url, {"latitude": w.lat, "longitude": w.lon, "start_date": t0.strftime("%Y-%m-%d"),
                     "end_date": last.strftime("%Y-%m-%d"), "hourly": ",".join(v + suffix for v in VARS),
                     "wind_speed_unit": "kmh", "timezone": "GMT"})
    df = pd.DataFrame(js["hourly"]).rename(columns={v + suffix: RENAME[v] for v in VARS})
    df["time_utc"] = pd.to_datetime(df["time"], utc=True)
    hours = pd.DataFrame({"hour_idx": np.arange(grid.N_HOURS)})
    hours["time_utc"] = t0 + pd.to_timedelta(hours.hour_idx, unit="h")
    df = hours.merge(df.drop(columns="time"), on="time_utc", how="left")
    rad = np.radians(df.wind_dir_deg)
    df["wind_u_kmh"] = -df.wind_speed_kmh * np.sin(rad)
    df["wind_v_kmh"] = -df.wind_speed_kmh * np.cos(rad)
    df = df[["hour_idx", "time_utc", "wind_speed_kmh", "wind_dir_deg", "wind_gust_kmh", "humidity_pct", "temp_c",
             "wind_u_kmh", "wind_v_kmh"]]
    os.makedirs(os.path.dirname(path), exist_ok=True)
    df.to_parquet(path, index=False)
    return df


def use_weather(kind):
    """Make every Fire load its weather from `kind` (era5 = the original files)."""
    original = p2.load_fire.__wrapped__ if hasattr(p2.load_fire, "__wrapped__") else p2.load_fire

    def load(fid):
        burning, hours, static, weather = original(fid)
        if kind != "era5":
            weather = forecast_weather(fid, kind)
        return burning, hours, static, weather
    load.__wrapped__ = original
    p2.load_fire = load


def first_flags(res, threshold, towns):
    """For each (fire, town): the first hour a forecast flagged the town (any square within 1 km >= threshold)."""
    out = {}
    for fid in sorted(set(res["fire_id"])):
        fire = res["fires"][fid]
        t, near = c.town_squares(fire, towns)
        if len(t) == 0:
            continue
        sel = np.nonzero(res["fire_id"] == fid)[0]
        flags = res["pred"]["logreg"][sel] >= threshold
        flagged = np.einsum("ckrs,trs->ct", flags.astype(np.float32), near.astype(np.float32)) > 0
        hours = res["hour"][sel]
        for j, name in enumerate(t.name):
            hit = np.nonzero(flagged[:, j])[0]
            out[(fid, name)] = int(hours[hit[0]]) if len(hit) else None
    return out


def official_comparison(first, kind):
    """Per replay fire: towns with published order times, our first flag time (end of that hour) vs the official time."""
    sys.path.insert(0, os.path.join(ROOT, "app"))
    from backend import situation as S
    rows = []
    for fid in REPLAY_FIRES:
        meta = S.replay_meta(fid)
        t0 = pd.Timestamp(meta["hours"][0]["time_utc"])
        for t in meta["timeline"]:
            offs = [x for x in (t["official_order_utc"], t["official_warning_utc"]) if x]
            if not offs:
                continue
            official = min(pd.Timestamp(x) for x in offs)
            h = first.get((fid, t["town"]))
            ours = t0 + pd.Timedelta(hours=h + 1) if h is not None else None    # issued at the end of the satellite hour
            lead = round((official - ours).total_seconds() / 3600, 1) if ours is not None else None
            rows.append({"weather": kind, "fire": fid, "town": t["town"], "fire_reached": t["fire_reached"],
                         "official_utc": official.isoformat(), "ours_utc": ours.isoformat() if ours is not None else None,
                         "lead_vs_official_h": lead})
    return rows


def main():
    sys.stdout.reconfigure(line_buffering=True)
    metrics = json.load(open(os.path.join(ROOT, "results", "metrics.json")))
    test_ids = metrics["test_fires"]
    b = joblib.load(os.path.join(ROOT, "models", "emberline_model.joblib"))
    model = c.Model("logreg", b["logreg"])
    th, t_town = b["square_thresholds"]["logreg"], b["town_threshold"]["logreg"]
    towns = pd.read_csv(os.path.join(ROOT, "data", "processed", "towns_ca.csv"))

    summary, official = {}, []
    for kind in ["era5", "forecast", "day_before"]:
        if kind != "era5":
            for fid in test_ids:
                forecast_weather(fid, kind)
        use_weather(kind)
        t0 = time.time()
        res = c.collect(test_ids, [model], {"logreg": th})
        ev, al = c.town_events(res, "logreg", t_town, towns)
        s = c.town_summary(ev, al, len(res["hour"]))
        sq = {k: c.square_scores(res, "logreg", th, k) for k in (1, 3)}
        summary[kind] = {"towns_reached": s["towns_reached"], "towns_warned": s["towns_warned"],
                         "mean_lead_h": round(s["mean_lead_h"], 2), "false_alarms_per_fire_day": round(s["false_alarms_per_fire_day"], 1),
                         "F1 new (2km) +1h": round(sq[1]["new_2km"][2], 3), "IoU +3h": round(sq[3]["iou"], 3),
                         "weather_hours_missing": int(sum(res["fires"][f].weather.wind_speed_kmh.isna().sum() for f in test_ids))}
        official += official_comparison(first_flags(res, t_town, towns), kind)
        print(kind, summary[kind], f"({time.time() - t0:.0f} s)")

    # sanity: the ERA5 re-run must reproduce the published test results
    pub = metrics["test"]["logreg"]
    assert summary["era5"]["towns_warned"] == pub["towns_warned"] and abs(summary["era5"]["IoU +3h"] - pub["IoU +3h"]) < 1e-3, "ERA5 re-run does not match"

    off = pd.DataFrame(official)
    per = {k: {"towns_compared": int(len(g)), "flagged_earlier": int((g.lead_vs_official_h > 0).sum()),
               "reached": int(g.fire_reached.sum()), "reached_flagged_earlier": int(((g.lead_vs_official_h > 0) & g.fire_reached).sum()),
               "sierra_madre_lead_h": float(g[g.town == "Sierra Madre"].lead_vs_official_h.iloc[0]) if (g.town == "Sierra Madre").any() and g[g.town == "Sierra Madre"].lead_vs_official_h.notna().iloc[0] else None}
           for k, g in off.groupby("weather")}
    out = {"note": "Same trained model, same 18 test fires, same scoring; only the weather source changes. "
                   "era5 = published results (hindsight weather). forecast = archived short-range forecasts. "
                   "day_before = the forecast issued about a day earlier.",
           "test_fires": summary, "official_orders": per, "official_rows": official}
    with open(os.path.join(ROOT, "results", "weather_stress.json"), "w") as f:
        json.dump(out, f, indent=1)
    lines = ["# Weather stress test", "", out["note"], "",
             "| Weather | Towns warned | Lead (h) | False alarms / fire-day | Spotting new fire (F1, 2 km) | Overlap +3 h |",
             "|---|---|---|---|---|---|"]
    for k, s in summary.items():
        lines.append(f"| {k} | {s['towns_warned']}/{s['towns_reached']} | {s['mean_lead_h']:.1f} | {s['false_alarms_per_fire_day']:.1f} | "
                     f"{s['F1 new (2km) +1h']:.2f} | {s['IoU +3h']:.2f} |")
    lines += ["", "| Weather | Towns flagged before the official order | Of the towns the fire reached | Sierra Madre lead (h) |", "|---|---|---|---|"]
    for k, p in per.items():
        lines.append(f"| {k} | {p['flagged_earlier']}/{p['towns_compared']} | {p['reached_flagged_earlier']}/{p['reached']} | {p['sierra_madre_lead_h']} |")
    open(os.path.join(ROOT, "results", "weather_stress.md"), "w").write("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
