"""
Emberline - Phase 2: which 2 km squares were burning each hour, from GOES satellite fire pixels.

Run from the project folder (takes roughly 10 minutes for all 70 fires):
    .venv/bin/python src/p2_goes.py                    # every fire in data/fire_windows.csv
    .venv/bin/python src/p2_goes.py park_fire_2024     # just one (or a few) fires

What it does, for each fire:
  1. Lists every GOES fire file (ABI-L2-FDCC, one scan every 5 minutes) for the fire's 74 hours.
  2. Downloads them a few at a time into a temporary folder, reads ONLY the part of the image that
     covers the fire's 80 km box, and deletes the file straight away (the raw files would be ~26 GB).
  3. Saves every fire pixel in the box, or within 4 km outside it (row/col = -1 for those):
                                                     data/raw/goes_crops/{fire_id}.parquet
  4. Turns pixels into "burning squares" per hour:   data/processed/burning/{fire_id}.parquet
     plus a per-hour count table:                    data/processed/burning/{fire_id}_hours.csv
  5. Adds one line per fire to                       results/phase2_goes_summary.csv

The rule (pixel FOOTPRINT): a square is BURNING in hour h if the footprint of any GOES fire pixel,
from any scan that started in that hour, covers the CENTRE of the square. Squares not listed in the
table are not burning.

Why a footprint and not just the pixel's centre point? A GOES pixel is 2 km x 2 km only directly
under the satellite (the "sub-point" on the equator). California is far from there, so the satellite
looks at it at a slant and each pixel covers a bigger patch of ground: roughly 2.2 km x 3 km for
GOES-17/18 (GOES-West) and about 3.9 km x 4.3 km for GOES-16 (GOES-East, even further away). If we
only marked the square holding the pixel's centre, some rows of 2 km squares could NEVER burn (no
pixel centre ever lands in them) and the maps would show fake empty stripes. So for each fire we
measure the two "steps" between neighbouring GOES pixel centres near the middle of the box (one
step to the next pixel across, one step to the next pixel down). A pixel's footprint is the patch
of ground within half a step of its centre in both directions - a slightly slanted rectangle (a
parallelogram), because the satellite image is tilted compared with our map. Footprints of
neighbouring pixels fit together with no gaps and no overlaps, and each fire pixel marks every
square whose centre is inside its footprint (1-3 squares for GOES-West, 2-4 for GOES-East).

Gap filling: smoke, cloud or a missing file can hide a fire for a short time even though it is
still burning. We fill ONLY one-hour gaps, and mark every filled row with gapfilled=True:
  (a) whole-hour gap  - hour h shows no fire at all, but hours h-1 and h+1 both do:
                        copy hour h-1's burning squares into hour h.
  (b) one-square gap  - a square burns at h-1 and at h+1 but not at h: mark it burning at h.
Gaps of 2 hours or more are left empty (we do not guess that far).

The script can be stopped and started again: fires whose outputs already exist are skipped.
"""

import os
import shutil
import sys
import tempfile
import time
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed

import numpy as np
import pandas as pd
import s3fs
import xarray as xr

import grid
from check_sources import FIRE_CODES, goes_lat_lon

ROOT = grid.ROOT
CROPS = os.path.join(ROOT, "data", "raw", "goes_crops")           # every fire pixel (big-ish, not committed)
BURNING = os.path.join(ROOT, "data", "processed", "burning")      # the hourly burning-square tables
SUMMARY = os.path.join(ROOT, "results", "phase2_goes_summary.csv")
for folder in (CROPS, BURNING):
    os.makedirs(folder, exist_ok=True)

FIRES_AT_ONCE = 4        # we work on 4 fires at the same time (one per CPU core)
DOWNLOADS_PER_FIRE = 6   # each fire downloads 6 files at once (4 x 6 = 24 downloads in parallel)
DOWNLOAD_TRIES = 5       # the network sometimes drops a download, so try each file up to 5 times
MARGIN_M = 4000          # also keep GOES pixels up to 4 km outside the box: their footprint can reach inside
FIRST = ["park_fire_2024", "eaton_fire_2025", "palisades_fire_2025"]  # done first so others can test early

fs = None    # the S3 connection; each worker process makes its own (see process_fire)
_INDEX = {}  # (fire, GOES grid) -> where the fire's box sits inside the GOES image (see box_index)


# ---------------------------------------------------------------------------
# Step 1: list and download the files
# ---------------------------------------------------------------------------
def list_hour(bucket, t):
    """List the GOES fire files whose scan started in the clock hour beginning at time t."""
    prefix = f"{bucket}/ABI-L2-FDCC/{t.year}/{t.day_of_year:03d}/{t.hour:02d}/"
    for attempt in range(1, DOWNLOAD_TRIES + 1):
        try:
            return [f["name"] for f in fs.ls(prefix, detail=True) if f["name"].endswith(".nc")]
        except FileNotFoundError:
            return []  # the satellite has no files for this hour (an outage)
        except Exception:
            if attempt == DOWNLOAD_TRIES:
                raise
            time.sleep(2 * attempt)


def scan_time(name):
    """Scan start time from the file name, e.g. '..._s20242062001171_e...' = year 2024, day 206, 20:01:17 UTC."""
    stamp = os.path.basename(name).split("_s")[1][:13]  # YYYYDDDHHMMSS (we drop the tenths of a second)
    return pd.to_datetime(stamp, format="%Y%j%H%M%S", utc=True)


def download(name, tmp):
    """Download one file into the temp folder. Returns the local path, or None if every try failed."""
    local = os.path.join(tmp, os.path.basename(name))
    for attempt in range(1, DOWNLOAD_TRIES + 1):
        try:
            fs.get(name, local)
            return local
        except Exception:
            time.sleep(2 * attempt)  # wait a little longer after each failed try
    return None


# ---------------------------------------------------------------------------
# Step 2: read the fire pixels inside the fire's box
# ---------------------------------------------------------------------------
def box_index(ds, fire):
    """
    Work out, once per fire, which part of the GOES image covers the fire's box.

    The GOES image is a fixed 1500 x 2500 grid of pixels, so a given fire's box is always the same
    small rectangle of the image. Turning all 3.75 million pixels into lat/lon is slow, so we do it
    once and remember: the rectangle (so we only read that part of each file), the lat/lon and
    map x/y of the pixels in it, and the size of one pixel's footprint on the ground.
    """
    # The grid differs between satellites (and could differ between scan modes), so the key includes it.
    key = (fire.fire_id, ds.sizes["x"], ds.sizes["y"], float(ds["x"][0]), float(ds["y"][0]),
           float(ds["goes_imager_projection"].attrs["longitude_of_projection_origin"]))
    if key not in _INDEX:
        lat, lon = goes_lat_lon(ds)
        x, y = grid.TO_ALBERS.transform(lon, lat)  # pixel centres in EPSG:3310 metres
        near = ((x >= fire.xmin - MARGIN_M) & (x <= fire.xmax + MARGIN_M) &
                (y >= fire.ymin - MARGIN_M) & (y <= fire.ymax + MARGIN_M))
        rows, cols = np.where(near)
        ys = slice(rows.min(), rows.max() + 1)   # the rectangle of the image that holds the box
        xs = slice(cols.min(), cols.max() + 1)
        _INDEX[key] = (ys, xs, lat[ys, xs], lon[ys, xs], x[ys, xs], y[ys, xs], pixel_footprint(x, y, fire))
    return _INDEX[key]


def pixel_footprint(x, y, fire):
    """
    The two "steps" (in metres on our map) between neighbouring GOES pixels near the middle of the box.

    We find the pixel closest to the box centre and look at its neighbours: half the way from the left
    neighbour to the right neighbour is one step ACROSS the image, and half the way from the upper to
    the lower neighbour is one step DOWN the image. Each step is an (x, y) pair because the image is
    tilted compared with our map. Returns (across, down).
    """
    cx, cy = (fire.xmin + fire.xmax) / 2, (fire.ymin + fire.ymax) / 2
    i, j = np.unravel_index(np.nanargmin((x - cx) ** 2 + (y - cy) ** 2), x.shape)
    across = (float(x[i, j + 1] - x[i, j - 1]) / 2, float(y[i, j + 1] - y[i, j - 1]) / 2)   # one pixel to the right
    down = (float(x[i + 1, j] - x[i - 1, j]) / 2, float(y[i + 1, j] - y[i - 1, j]) / 2)     # one pixel down
    return across, down


def read_fire_pixels(path, fire):
    """Open one GOES file. Returns a table of the fire pixels in (or just outside) the box, and the footprint steps."""
    ds = xr.open_dataset(path, decode_times=False)  # some files have broken time fields; we do not need them
    try:
        ys, xs, lat, lon, x, y, footprint = box_index(ds, fire)
        mask = ds["Mask"].isel(y=ys, x=xs).values          # only this small rectangle is read from disk
        row, col = grid.cell_of(x, y, fire.xmin, fire.ymax)  # square holding the pixel CENTRE (-1 = outside the box)
        hit = np.isin(mask, FIRE_CODES)
        if "Power" in ds and hit.any():
            power = ds["Power"].isel(y=ys, x=xs).values[hit]  # fire radiative power in megawatts (can be blank)
        else:
            power = np.full(int(hit.sum()), np.nan)
    finally:
        ds.close()
    return pd.DataFrame({"lat": lat[hit], "lon": lon[hit], "x": x[hit], "y": y[hit],
                         "row": row[hit], "col": col[hit],
                         "mask_code": mask[hit].astype("int16"), "power_mw": power.astype("float32")}), footprint


# ---------------------------------------------------------------------------
# Step 3: pixels -> burning squares per hour, with gap filling
# ---------------------------------------------------------------------------
def covered_squares(pixels, fire, footprint):
    """
    Spread each fire pixel over every square whose CENTRE lies inside the pixel's footprint.
    Returns one row per (pixel, covered square): scan_time_utc, hour_idx, row, col, power_mw.
    """
    (ax, ay), (dx, dy) = footprint              # the step across and the step down, in metres
    px, py = pixels.x.values, pixels.y.values   # pixel centres
    # First a rough search area: the upright rectangle that just holds the slanted footprint.
    half_x, half_y = (abs(ax) + abs(dx)) / 2, (abs(ay) + abs(dy)) / 2
    # Square (row, col) has its centre at x = xmin + (col + 0.5) * 2 km, y = ymax - (row + 0.5) * 2 km,
    # so the rectangle from px - half_x to px + half_x holds the centres of columns col_lo..col_hi (same for rows).
    col_lo = np.ceil((px - half_x - fire.xmin) / grid.CELL_M - 0.5).astype(int)
    col_hi = np.floor((px + half_x - fire.xmin) / grid.CELL_M - 0.5).astype(int)
    row_lo = np.ceil((fire.ymax - py - half_y) / grid.CELL_M - 0.5).astype(int)
    row_hi = np.floor((fire.ymax - py + half_y) / grid.CELL_M - 0.5).astype(int)
    parts = []
    if len(pixels):
        for dr in range((row_hi - row_lo).max() + 1):        # the search area is only 1-4 rows and columns,
            for dc in range((col_hi - col_lo).max() + 1):    # so these two loops are tiny
                row, col = row_lo + dr, col_lo + dc
                # How far is this square's centre from the pixel centre, measured in pixel steps?
                # (ex, ey) = u * across + v * down; solving these two equations gives u and v.
                ex = fire.xmin + (col + 0.5) * grid.CELL_M - px
                ey = fire.ymax - (row + 0.5) * grid.CELL_M - py
                det = ax * dy - ay * dx
                u = (ex * dy - ey * dx) / det
                v = (ax * ey - ay * ex) / det
                ok = ((np.abs(u) <= 0.5) & (np.abs(v) <= 0.5) &                              # inside the footprint
                      (row >= 0) & (row < grid.N_CELLS) & (col >= 0) & (col < grid.N_CELLS))  # inside the box
                parts.append(pd.DataFrame({"scan_time_utc": pixels.scan_time_utc.values[ok],
                                           "hour_idx": pixels.hour_idx.values[ok], "row": row[ok],
                                           "col": col[ok], "power_mw": pixels.power_mw.values[ok]}))
    if not parts:
        return pd.DataFrame(columns=["scan_time_utc", "hour_idx", "row", "col", "power_mw"])
    return pd.concat(parts, ignore_index=True)


def burning_squares(pixels, fire, footprint):
    """Turn fire pixels into one row per (hour, burning square), then fill one-hour gaps (see top of file)."""
    covered = covered_squares(pixels, fire, footprint)
    # n_scans = how many of the hour's scans had a fire pixel covering this square.
    seen = (covered.groupby(["hour_idx", "row", "col"])
            .agg(n_scans=("scan_time_utc", "nunique"), max_power_mw=("power_mw", "max"))
            .reset_index())
    seen["gapfilled"] = False

    # For each hour, the set of squares GOES really saw burning.
    squares = {h: set() for h in range(-1, grid.N_HOURS + 1)}
    for h, r, c in zip(seen.hour_idx, seen.row, seen.col):
        squares[h].add((r, c))

    filled, whole_hours = [], []
    for h in range(1, grid.N_HOURS - 1):
        before, now, after = squares[h - 1], squares[h], squares[h + 1]
        if not now and before and after:
            new = before                    # (a) whole hour missing: copy the hour before
            whole_hours.append(h)
        else:
            new = (before & after) - now    # (b) squares burning before AND after, but not now
        filled += [(h, r, c) for r, c in sorted(new)]

    fill = pd.DataFrame(filled, columns=["hour_idx", "row", "col"])
    fill["n_scans"] = 0                 # GOES did not actually see fire here in this hour
    fill["max_power_mw"] = np.nan
    fill["gapfilled"] = True
    out = pd.concat([seen, fill], ignore_index=True).sort_values(["hour_idx", "row", "col"])
    out = out.astype({"hour_idx": "int16", "row": "int16", "col": "int16", "n_scans": "int16",
                      "max_power_mw": "float32", "gapfilled": bool})
    return out.reset_index(drop=True), whole_hours


# ---------------------------------------------------------------------------
# One whole fire
# ---------------------------------------------------------------------------
def process_fire(fire):
    """Download, crop and summarise one fire. Returns one row for the summary table."""
    global fs
    if fs is None:
        fs = s3fs.S3FileSystem(anon=True)  # anonymous = no AWS account needed
    t0 = time.time()
    hours = [fire.t_start_utc + pd.Timedelta(hours=h) for h in range(grid.N_HOURS)]
    tmp = tempfile.mkdtemp(prefix=f"goes_{fire.fire_id}_")
    tables, files_ok, failed, footprint = [], np.zeros(grid.N_HOURS, dtype=int), 0, None
    try:
        with ThreadPoolExecutor(DOWNLOADS_PER_FIRE) as pool:
            names = [n for hour_list in pool.map(lambda t: list_hour(fire.satellite, t), hours) for n in hour_list]
            # Threads download; THIS (main) thread reads the files one at a time, because the
            # netCDF library is not safe to use from several threads at once.
            jobs = {pool.submit(download, n, tmp): n for n in names}
            for job in as_completed(jobs):
                name, local = jobs[job], job.result()
                when = scan_time(name)
                h = int((when - fire.t_start_utc) / pd.Timedelta(hours=1))
                if local is None:
                    print(f"  [{fire.fire_id}] download failed after {DOWNLOAD_TRIES} tries: {os.path.basename(name)}")
                    failed += 1
                    continue
                try:
                    t, footprint = read_fire_pixels(local, fire)
                    t.insert(0, "hour_idx", np.int16(h))
                    t.insert(0, "scan_time_utc", when)
                    tables.append(t)
                    files_ok[h] += 1
                except Exception as e:  # a rare damaged file: skip it rather than stop
                    print(f"  [{fire.fire_id}] skipped damaged file {os.path.basename(name)}: {type(e).__name__}: {str(e)[:80]}")
                    failed += 1
                finally:
                    os.remove(local)  # never keep the raw file (disk space)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    if not tables:
        raise RuntimeError(f"{fire.fire_id}: no files could be read")
    pixels = pd.concat(tables, ignore_index=True).sort_values(["scan_time_utc", "row", "col"]).reset_index(drop=True)
    burning, whole_hours = burning_squares(pixels, fire, footprint)

    # Per-hour table: how many files, fire pixels and burning squares (burning squares include gap-filled ones).
    per_hour = pd.DataFrame({"hour_idx": range(grid.N_HOURS), "time_utc": hours, "n_files": files_ok})
    per_hour["n_fire_pixels"] = pixels.groupby("hour_idx").size().reindex(per_hour.hour_idx, fill_value=0).values
    per_hour["n_burning_squares"] = burning.groupby("hour_idx").size().reindex(per_hour.hour_idx, fill_value=0).values
    per_hour["n_gapfilled_squares"] = (burning[burning.gapfilled].groupby("hour_idx").size()
                                       .reindex(per_hour.hour_idx, fill_value=0).values)
    per_hour["hour_gapfilled"] = per_hour.hour_idx.isin(whole_hours)

    # Save the pixel file LAST-but-one and the burning file last: "burning file exists" means the fire is done.
    pixels.to_parquet(os.path.join(CROPS, f"{fire.fire_id}.parquet"), index=False)
    per_hour.to_csv(os.path.join(BURNING, f"{fire.fire_id}_hours.csv"), index=False)
    burning.to_parquet(os.path.join(BURNING, f"{fire.fire_id}.parquet"), index=False)

    return {"fire_id": fire.fire_id, "split": fire.split, "satellite": fire.satellite,
            "files_downloaded": int(files_ok.sum()), "files_failed": failed,
            "hours_with_no_files": int((files_ok == 0).sum()),
            "n_fire_pixels": len(pixels),
            "hours_with_fire": int((per_hour.n_burning_squares > 0).sum()),
            "max_burning_squares": int(per_hour.n_burning_squares.max()),
            "distinct_squares_ever": int(burning[["row", "col"]].drop_duplicates().shape[0]),
            "burning_square_hours": len(burning),
            "gapfilled_square_hours": int(burning.gapfilled.sum()),
            "whole_hours_gapfilled": len(whole_hours),
            # footprint size = length of the step across the image (roughly east-west) and down it (roughly north-south)
            "footprint_x_m": round(float(np.hypot(*footprint[0]))), "footprint_y_m": round(float(np.hypot(*footprint[1]))),
            "seconds": round(time.time() - t0, 1)}


def save_summary(row):
    """Add (or replace) one fire's row in results/phase2_goes_summary.csv."""
    old = pd.read_csv(SUMMARY) if os.path.exists(SUMMARY) else pd.DataFrame()
    if len(old):
        old = old[old.fire_id != row["fire_id"]]
    pd.concat([old, pd.DataFrame([row])], ignore_index=True).to_csv(SUMMARY, index=False)


def main():
    t0 = time.time()
    w = grid.load_windows()
    wanted = sys.argv[1:]                       # optional: fire ids typed after the script name
    if wanted:
        w = w[w.fire_id.isin(wanted)]
    order = FIRST + [f for f in w.fire_id if f not in FIRST]   # the three demo fires go first
    w = w.set_index("fire_id", drop=False).reindex([f for f in order if f in set(w.fire_id)])

    todo = []
    for _, fire in w.iterrows():   # each "fire" is one row of fire_windows.csv
        if os.path.exists(os.path.join(BURNING, f"{fire.fire_id}.parquet")) and not wanted:
            print(f"{fire.fire_id}: already done, skipping")
        else:
            todo.append(fire)
    print(f"{len(todo)} fires to do. Rule: a square burns if a fire pixel's footprint covers its centre. Gap filling: one-hour gaps only (whole hour copied from the hour "
          f"before; single squares filled when burning before and after).", flush=True)

    with ProcessPoolExecutor(FIRES_AT_ONCE) as pool:
        jobs = {pool.submit(process_fire, fire): fire.fire_id for fire in todo}
        for n, job in enumerate(as_completed(jobs), 1):
            try:
                r = job.result()
            except Exception as e:  # one bad fire should not stop the other 69
                print(f"FAILED {jobs[job]}: {type(e).__name__}: {str(e)[:200]}", flush=True)
                continue
            save_summary(r)
            print(f"[{n}/{len(todo)}] {r['fire_id']}: {r['files_downloaded']} files ({r['files_failed']} failed), "
                  f"{r['n_fire_pixels']} fire pixels, fire in {r['hours_with_fire']}/74 hours, "
                  f"max {r['max_burning_squares']} squares in one hour, {r['distinct_squares_ever']} squares ever, "
                  f"gap-filled {r['gapfilled_square_hours']} square-hours ({r['whole_hours_gapfilled']} whole hours), "
                  f"GOES pixel footprint about {r['footprint_x_m']} m (E-W) x {r['footprint_y_m']} m (N-S), "
                  f"{r['seconds']:.0f} s", flush=True)
    print(f"All done in {(time.time() - t0) / 60:.1f} minutes. Summary: {SUMMARY}", flush=True)


if __name__ == "__main__":
    main()
