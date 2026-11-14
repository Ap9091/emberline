"""
Emberline Phase 2 - hourly weather for every fire.

For each fire in data/fire_windows.csv we ask the Open-Meteo historical archive (free, no key)
for the weather at the fire's START POINT, for every hour of the fire's 74-hour window
(hour 0..73, the same hours as src/grid.py). One small file per fire:

    data/processed/weather/{fire_id}.parquet
    results/phase2_weather_summary.csv      (one line per fire, for a quick sanity check)

KNOWN LIMIT (we report this): Open-Meteo's archive is built on ERA5 "reanalysis" weather models
with squares about 9-25 km wide. That is a smoothed picture: it UNDERESTIMATES strong local winds
such as Santa Ana / Diablo winds funnelled through canyons. Also, we use ONE point per fire (the
start point), so every square of a fire's grid gets the same weather for a given hour.

Run:  .venv/bin/python src/p2_weather.py        (skips fires already saved; add --redo to refetch)
"""

import os
import sys
import time

import numpy as np
import pandas as pd
import requests

import grid

URL = "https://archive-api.open-meteo.com/v1/archive"
OUT_DIR = os.path.join(grid.ROOT, "data", "processed", "weather")
SUMMARY = os.path.join(grid.ROOT, "results", "phase2_weather_summary.csv")

# Open-Meteo's names -> our column names
RENAME = {
    "wind_speed_10m": "wind_speed_kmh",
    "wind_direction_10m": "wind_dir_deg",   # direction the wind blows FROM (0 = from north, 90 = from east)
    "wind_gusts_10m": "wind_gust_kmh",
    "relative_humidity_2m": "humidity_pct",
    "temperature_2m": "temp_c",
}


def fetch(params, tries=80):
    """Ask Open-Meteo, retrying. HTTP 429 means "too many requests": wait and try again.
    (Our network goes out through shared addresses; some of them have used up Open-Meteo's
    free daily allowance, so a retry a few seconds later often works.)"""
    for attempt in range(1, tries + 1):
        wait = 3   # short wait: the next try usually leaves through a different address
        try:
            r = requests.get(URL, params=params, timeout=45)
            if r.status_code == 429:
                print(f"    (rate limited: {r.text[:80].strip()} - waiting {wait}s)")
                time.sleep(wait)
                continue
            r.raise_for_status()
            return r.json()
        except requests.RequestException as e:
            if attempt == tries:
                raise
            print(f"    (try {attempt} failed: {type(e).__name__}, retrying in {wait}s)")
            time.sleep(wait)
    raise RuntimeError("Open-Meteo kept rate-limiting us - run the script again later (it skips finished fires)")


def weather_for_fire(f):
    """Return the 74-row weather table for one fire (a row of fire_windows.csv)."""
    last_hour = f.t_start_utc + pd.Timedelta(hours=grid.N_HOURS - 1)   # start of hour 73
    params = {
        "latitude": f.lat, "longitude": f.lon,
        # We ask for whole UTC days that cover the window, then cut down to our 74 hours below.
        "start_date": f.t_start_utc.strftime("%Y-%m-%d"),
        "end_date": last_hour.strftime("%Y-%m-%d"),
        "hourly": ",".join(RENAME),
        "wind_speed_unit": "kmh", "timezone": "GMT",
    }
    df = pd.DataFrame(fetch(params)["hourly"]).rename(columns=RENAME)
    df["time_utc"] = pd.to_datetime(df["time"], utc=True)

    # Line the weather up with the grid's hours: hour h starts at t_start_utc + h hours.
    hours = pd.DataFrame({"hour_idx": np.arange(grid.N_HOURS)})
    hours["time_utc"] = f.t_start_utc + pd.to_timedelta(hours.hour_idx, unit="h")
    df = hours.merge(df.drop(columns="time"), on="time_utc", how="left")

    # Wind as an arrow pointing where the wind blows TOWARD (u = east part, v = north part).
    # wind_dir_deg is where it comes FROM, so we flip the sign. Example: wind FROM the north
    # (dir = 0) blows TOWARD the south: u = 0, v = -speed. "Downwind" of a fire is along (u, v).
    rad = np.radians(df.wind_dir_deg)
    df["wind_u_kmh"] = -df.wind_speed_kmh * np.sin(rad)
    df["wind_v_kmh"] = -df.wind_speed_kmh * np.cos(rad)

    return df[["hour_idx", "time_utc", "wind_speed_kmh", "wind_dir_deg", "wind_gust_kmh",
               "humidity_pct", "temp_c", "wind_u_kmh", "wind_v_kmh"]]


def main():
    redo = "--redo" in sys.argv
    os.makedirs(OUT_DIR, exist_ok=True)
    windows = grid.load_windows()
    summary, gaps = [], []
    for i, f in enumerate(windows.itertuples(), 1):
        path = os.path.join(OUT_DIR, f"{f.fire_id}.parquet")
        if os.path.exists(path) and not redo:
            df = pd.read_parquet(path)
        else:
            df = weather_for_fire(f)
            time.sleep(1)   # be polite: Open-Meteo rate-limits fast callers
            n_missing = int(df.isna().sum().sum())
            if len(df) != grid.N_HOURS or n_missing > 0:
                gaps.append(f"{f.fire_id}: {len(df)} rows, {n_missing} missing values")
                print(f"  !! GAP {gaps[-1]} - not saved")
                continue
            df.to_parquet(path, index=False)
        assert len(df) == grid.N_HOURS and df.notna().all().all(), f"{f.fire_id}: bad saved file"
        summary.append({"fire_id": f.fire_id, "split": f.split,
                        "wind_mean_kmh": round(df.wind_speed_kmh.mean(), 1),
                        "wind_max_kmh": df.wind_speed_kmh.max(),
                        "gust_max_kmh": df.wind_gust_kmh.max(),
                        "humidity_min_pct": df.humidity_pct.min(),
                        "temp_max_c": df.temp_c.max()})
        s = summary[-1]
        print(f"  [{i}/{len(windows)}] {f.fire_id}: wind mean {s['wind_mean_kmh']} max {s['wind_max_kmh']} km/h, "
              f"gust {s['gust_max_kmh']}, min humidity {s['humidity_min_pct']}%, max temp {s['temp_max_c']} C")

    pd.DataFrame(summary).to_csv(SUMMARY, index=False)
    print(f"\nSaved {len(summary)} of {len(windows)} fires to data/processed/weather/ and {os.path.relpath(SUMMARY, grid.ROOT)}")
    if gaps:
        print("FIRES WITH GAPS (not saved):")
        for g in gaps:
            print("  " + g)
        sys.exit(1)
    print("No gaps: every fire has 74 hours with no missing values.")


if __name__ == "__main__":
    main()
