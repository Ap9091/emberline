"""
Emberline - Phase 1, steps 4 and 5.

  Step 4: choose the fires we train / validate / test on and save data/fires.csv
  Step 5: estimate how long downloading 3 days of GOES data for all of them will take

Run after src/check_sources.py (it needs data/raw/calfire_incidents_2018_2025.csv):
    .venv/bin/python src/make_fire_list.py
"""

import json
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pandas as pd
import s3fs
import xarray as xr

from california import in_california
from check_sources import FIRE_CODES, goes_lat_lon

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = os.path.join(ROOT, "data", "raw", "goes_visibility")  # small cache for the visibility check
os.makedirs(TMP, exist_ok=True)
fs = s3fs.S3FileSystem(anon=True)

N_LARGEST = 60          # the 60 largest fires 2018-2025
MIN_VAL_ACRES = 2000    # 2023 was a quiet year, so we add every 2023 fire this big to the validation set
# Hours (relative to CAL FIRE's start time) where we look at one GOES scan. Some fires smoulder for days
# before growing (lightning complexes), and some CAL FIRE start times are late, so we look wide.
SAMPLE_HOURS = [-24, -12, 1, 6, 12, 24, 48, 72, 96]
MUST_HAVE = [("Park Fire", 2024), ("Eaton Fire", 2025), ("Palisades Fire", 2025)]  # test fires for sure
BOX_KM = 40             # we look for fire pixels within 40 km of the reported start point
HOURS = 72              # Phase 2 downloads from 1 h before the start to 72 h after


def satellite_for(t):
    """Which GOES satellite watched California (as 'GOES-West' or best view) at time t."""
    if t < pd.Timestamp("2019-02-12", tz="UTC"):
        return "noaa-goes16"  # GOES-17 was not operational yet; GOES-16 (East) CONUS scan still covers CA
    if t < pd.Timestamp("2023-01-04", tz="UTC"):
        return "noaa-goes17"  # GOES-17 = GOES-West from Feb 2019
    return "noaa-goes18"      # GOES-18 replaced GOES-17 as GOES-West on 4 Jan 2023


def split_for(year):
    """Train on older fires, validate on 2023, test on the newest fires (never mixed)."""
    if year <= 2022:
        return "train"
    if year == 2023:
        return "val"
    return "test"


def hour_files(bucket, t):
    """List the GOES fire files (one every 5 min) for the clock hour containing time t."""
    prefix = f"{bucket}/ABI-L2-FDCC/{t.year}/{t.day_of_year:03d}/{t.hour:02d}/"
    try:
        return fs.ls(prefix, detail=True)
    except FileNotFoundError:
        return []


_READ_LOCK = threading.Lock()  # the netCDF library is not thread-safe: read one file at a time
_GRID = {}  # bucket -> (lat, lon) arrays. The GOES grid is fixed, so we compute it once per satellite.


def fire_pixels_near(path, bucket, lat0, lon0):
    """Count GOES fire pixels within BOX_KM of (lat0, lon0) in one file."""
    with _READ_LOCK:
        return _count(path, bucket, lat0, lon0)


def _count(path, bucket, lat0, lon0):
    ds = xr.open_dataset(path, decode_times=False)  # some files have broken time fields; we do not need them
    if bucket not in _GRID:
        _GRID[bucket] = goes_lat_lon(ds)
    lat, lon = _GRID[bucket]
    dlat = BOX_KM / 111.0                                  # 1 degree of latitude is about 111 km
    dlon = BOX_KM / (111.0 * np.cos(np.radians(lat0)))     # longitude degrees shrink toward the poles
    near = (np.abs(lat - lat0) < dlat) & (np.abs(lon - lon0) < dlon)
    n = int((np.isin(ds["Mask"].values, FIRE_CODES) & near).sum())
    ds.close()
    return n


def goes_can_see(row):
    """Download one scan at each SAMPLE_HOURS; GOES 'sees' the fire if any scan shows fire pixels nearby."""
    counts, sizes = [], []
    for h in SAMPLE_HOURS:
        files = hour_files(row.satellite, row.start_utc + pd.Timedelta(hours=h))
        if not files:
            counts.append(0)
            continue
        sizes += [f["size"] for f in files]
        local = os.path.join(TMP, os.path.basename(files[0]["name"]))
        if not os.path.exists(local):
            fs.get(files[0]["name"], local)
        try:
            counts.append(fire_pixels_near(local, row.satellite, row.lat, row.lon))
        except Exception as e:  # a rare damaged file: skip it rather than stop
            print(f"  skipped damaged file {os.path.basename(local)}: {type(e).__name__}")
            counts.append(0)
    seen = [h for h, c in zip(SAMPLE_HOURS, counts) if c > 0]
    first_seen = seen[0] if seen else None  # first sampled hour with fire pixels (Phase 2 anchors on this)
    return max(counts), counts, (np.mean(sizes) if sizes else np.nan), first_seen


def main():
    # ---- Load and clean the CAL FIRE list -------------------------------------------------
    cf = pd.read_csv(os.path.join(ROOT, "data", "raw", "calfire_incidents_2018_2025.csv"))
    cf["start_utc"] = pd.to_datetime(cf.Started, utc=True, errors="coerce")  # CAL FIRE times are UTC ("Z")
    cf = cf[(cf.Type == "Wildfire") & cf.AcresBurned.notna() & cf.start_utc.notna()]
    cf = cf[(cf.start_utc.dt.year >= 2018) & (cf.start_utc.dt.year <= 2025)]
    cf = cf[in_california(cf.Latitude.values, cf.Longitude.values)]  # drops bad / 0,0 coordinates
    cf = cf.rename(columns={"Name": "name", "Latitude": "lat", "Longitude": "lon", "AcresBurned": "acres",
                            "County": "county", "Url": "calfire_url"})
    cf["name"] = cf.name.str.strip()
    cf["year"] = cf.start_utc.dt.year
    cf = cf.sort_values("acres", ascending=False)

    # ---- Candidate pool: a few more than we need, in case GOES cannot see some -----------------
    pool = cf.head(N_LARGEST + 20)
    val_extra = cf[(cf.year == 2023) & (cf.acres >= MIN_VAL_ACRES)]
    must = pd.concat([cf[(cf.name == n) & (cf.year == y)].head(1) for n, y in MUST_HAVE])
    pool = pd.concat([pool, val_extra, must]).drop_duplicates("UniqueId")
    pool["satellite"] = pool.start_utc.apply(satellite_for)
    print(f"Checking whether GOES can see {len(pool)} candidate fires...")

    # ---- Step 4: check GOES visibility (4 fires at a time) -------------------------------------
    with ThreadPoolExecutor(4) as ex:
        res = list(ex.map(goes_can_see, [r for _, r in pool.iterrows()]))
    pool["goes_fire_px"] = [r[0] for r in res]
    pool["goes_px_samples"] = [str(r[1]) for r in res]
    pool["goes_first_seen_h"] = [r[3] for r in res]
    pool["avg_file_mb"] = [r[2] / 1e6 for r in res]
    pool["goes_visible"] = pool.goes_fire_px > 0
    for _, r in pool[~pool.goes_visible].iterrows():
        print(f"  NOT visible: {r['name']} ({r.year}, {r.acres:,.0f} ac) pixels at hours {SAMPLE_HOURS} = {r.goes_px_samples}")

    visible = pool[pool.goes_visible].sort_values("acres", ascending=False)
    chosen_ids = set(visible.head(N_LARGEST).UniqueId)                    # the 60 largest that GOES sees
    chosen_ids |= set(visible[(visible.year == 2023) & (visible.acres >= MIN_VAL_ACRES)].UniqueId)
    for n, y in MUST_HAVE:                                                # the 3 test fires, always
        chosen_ids |= set(pool[(pool.name == n) & (pool.year == y)].UniqueId)
    fires = pool[pool.UniqueId.isin(chosen_ids)].copy()
    fires["split"] = fires.year.apply(split_for)
    fires["is_complex"] = fires.name.str.contains("Complex|Lightning", case=False)  # many fires under one name
    fires["start_utc"] = fires.start_utc.dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    cols = ["name", "start_utc", "lat", "lon", "acres", "split", "year", "county", "satellite",
            "is_complex", "goes_fire_px", "goes_first_seen_h", "goes_px_samples", "calfire_url"]
    fires = fires.sort_values(["split", "acres"], ascending=[True, False])[cols]
    fires.to_csv(os.path.join(ROOT, "data", "fires.csv"), index=False)
    print(f"\nSaved data/fires.csv with {len(fires)} fires")
    print(fires.groupby("split").agg(fires=("name", "size"), complexes=("is_complex", "sum"),
                                     total_acres=("acres", "sum")).to_string())
    print("\nTest + validation fires:")
    print(fires[fires.split != "train"][["name", "start_utc", "acres", "split", "goes_fire_px", "goes_first_seen_h"]].to_string(index=False))

    # ---- Step 5: download-time estimate -------------------------------------------------------
    # Measure real speed: download 6 hours (about 72 files) of GOES-18 with 16 parallel downloads.
    t = pd.Timestamp("2024-07-25T18:00Z")
    files = sum([hour_files("noaa-goes18", t + pd.Timedelta(hours=h)) for h in range(6)], [])
    speed_dir = os.path.join(TMP, "speedtest")
    os.makedirs(speed_dir, exist_ok=True)
    t0 = time.time()
    with ThreadPoolExecutor(16) as ex:
        list(ex.map(lambda f: fs.get(f["name"], os.path.join(speed_dir, os.path.basename(f["name"]))), files))
    secs = time.time() - t0
    files_per_s = len(files) / secs
    mb = sum(f["size"] for f in files) / 1e6
    print(f"\nSpeed test: {len(files)} files ({mb:.0f} MB) in {secs:.1f} s = {files_per_s:.1f} files/s, {mb/secs:.1f} MB/s")
    for f in os.listdir(speed_dir):
        os.remove(os.path.join(speed_dir, f))

    # Every fire: 73 hours x 12 scans per hour. File size depends on the satellite.
    size_mb = fires.merge(pool[["name", "start_utc", "avg_file_mb"]].assign(
        start_utc=pool.start_utc.dt.strftime("%Y-%m-%dT%H:%M:%SZ")), on=["name", "start_utc"]).avg_file_mb
    n_files = len(fires) * (HOURS + 1) * 12
    total_gb = float((size_mb.fillna(size_mb.mean()) * (HOURS + 1) * 12).sum() / 1e3)
    est_h = n_files / files_per_s / 3600
    # Speed is limited by both file count and MB/s, so take the slower of the two.
    est_h = max(est_h, total_gb * 1e3 / (mb / secs) / 3600)
    estimate = {"fires": len(fires), "hours_per_fire": HOURS + 1, "files": n_files,
                "total_GB": round(total_gb, 1), "files_per_s": round(files_per_s, 1),
                "MB_per_s": round(mb / secs, 1), "estimated_hours": round(est_h, 2),
                "fits_in_3_hours": est_h <= 3}
    print(f"Estimate: {n_files:,} files, {total_gb:.1f} GB raw, about {est_h:.2f} hours "
          f"({'fits' if est_h <= 3 else 'TOO SLOW - reduce fires'} the 3-hour budget)")
    with open(os.path.join(ROOT, "results", "phase1_download_estimate.json"), "w") as f:
        json.dump(estimate, f, indent=1)


if __name__ == "__main__":
    main()
