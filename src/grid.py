"""
Emberline - the shared map grid and time window for every fire (Phase 2).

Every Phase 2 script uses THIS file, so that "square (row, col) at hour h of fire F"
means exactly the same place and time everywhere.

The grid
  * Projection: EPSG:3310 (California Albers), units are metres. Distances are true on the ground.
  * Squares are 2 km x 2 km (about one GOES pixel).
  * Each fire gets an 80 km x 80 km box (40 km each side of the CAL FIRE start point) = 40 x 40 squares.
  * Box edges snap to multiples of 2 km, so squares of different fires line up with each other.
  * Row 0 is the NORTH edge, col 0 is the WEST edge (like an image).

The time window
  * Hour 0 starts at the clock hour 1 hour before the fire's anchor time; we keep hours 0..73
    (1 h before to 72 h after). Hour h covers [t_start + h hours, t_start + h+1 hours).
  * Anchor time = CAL FIRE start time, EXCEPT for fires that GOES did not see until much later
    (lightning fires smoulder for days, and some CAL FIRE start times are late). For those we move
    the anchor to the last sampled hour BEFORE GOES first saw fire (see Phase 1 goes_first_seen_h).

Run this file to write data/fire_windows.csv (one row per fire) for the other scripts:
    .venv/bin/python src/grid.py
"""

import os
import re

import numpy as np
import pandas as pd
from pyproj import Transformer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

CELL_M = 2000            # square size in metres
HALF_BOX_M = 40_000      # 40 km each side of the start point
N_CELLS = 2 * HALF_BOX_M // CELL_M   # 40 squares across and down
N_HOURS = 74             # hours 0..73 (1 h before the anchor to 72 h after)
SAMPLE_HOURS = [-24, -12, 1, 6, 12, 24, 48, 72, 96]  # the hours Phase 1 looked at (make_fire_list.py)

TO_ALBERS = Transformer.from_crs("EPSG:4326", "EPSG:3310", always_xy=True)   # lon/lat -> x/y metres
TO_LONLAT = Transformer.from_crs("EPSG:3310", "EPSG:4326", always_xy=True)   # x/y metres -> lon/lat


def fire_id(name, year):
    """A short, file-name-safe id, e.g. 'park_fire_2024'."""
    return re.sub(r"[^a-z0-9]+", "_", f"{name} {year}".lower()).strip("_")


def anchor_shift_hours(first_seen_h):
    """How many hours to move the window start later, for fires GOES only saw late."""
    if pd.isna(first_seen_h) or first_seen_h < 12:
        return 0  # seen within ~12 h (or even before the listed start): keep CAL FIRE's time
    i = SAMPLE_HOURS.index(int(first_seen_h))
    return SAMPLE_HOURS[i - 1]  # the last sampled hour where GOES still saw nothing


def grid_box(lat, lon):
    """West, south, east, north edges (EPSG:3310 metres) of the 80 km box around a point, snapped to 2 km."""
    x, y = TO_ALBERS.transform(lon, lat)
    cx = round(x / CELL_M) * CELL_M
    cy = round(y / CELL_M) * CELL_M
    return cx - HALF_BOX_M, cy - HALF_BOX_M, cx + HALF_BOX_M, cy + HALF_BOX_M


def cell_of(x, y, xmin, ymax):
    """(row, col) of the square containing point(s) x, y. Points outside the box get -1."""
    col = np.floor((np.asarray(x) - xmin) / CELL_M).astype(int)
    row = np.floor((ymax - np.asarray(y)) / CELL_M).astype(int)
    outside = (col < 0) | (col >= N_CELLS) | (row < 0) | (row >= N_CELLS)
    return np.where(outside, -1, row), np.where(outside, -1, col)


def cell_centres(xmin, ymax):
    """DataFrame of every square: row, col, x, y (centre, metres), lat, lon."""
    rows, cols = np.meshgrid(np.arange(N_CELLS), np.arange(N_CELLS), indexing="ij")
    x = xmin + (cols + 0.5) * CELL_M
    y = ymax - (rows + 0.5) * CELL_M
    lon, lat = TO_LONLAT.transform(x, y)
    return pd.DataFrame({"row": rows.ravel(), "col": cols.ravel(), "x": x.ravel(), "y": y.ravel(),
                         "lat": lat.ravel(), "lon": lon.ravel()})


def load_windows():
    """Read data/fire_windows.csv with times parsed."""
    w = pd.read_csv(os.path.join(ROOT, "data", "fire_windows.csv"))
    for c in ["calfire_start_utc", "t_start_utc", "t_end_utc"]:
        w[c] = pd.to_datetime(w[c], utc=True)
    return w


def main():
    fires = pd.read_csv(os.path.join(ROOT, "data", "fires.csv"))
    out = []
    for _, f in fires.iterrows():
        start = pd.Timestamp(f.start_utc)
        shift = anchor_shift_hours(f.goes_first_seen_h)
        anchor = start + pd.Timedelta(hours=shift)
        t_start = anchor.floor("h") - pd.Timedelta(hours=1)
        xmin, ymin, xmax, ymax = grid_box(f.lat, f.lon)
        out.append({"fire_id": fire_id(f["name"], f.year), "name": f["name"], "year": f.year,
                    "split": f.split, "satellite": f.satellite, "acres": f.acres,
                    "lat": f.lat, "lon": f.lon, "is_complex": f.is_complex,
                    "calfire_start_utc": start, "anchor_shift_h": shift,
                    "t_start_utc": t_start, "t_end_utc": t_start + pd.Timedelta(hours=N_HOURS),
                    "xmin": xmin, "ymin": ymin, "xmax": xmax, "ymax": ymax})
    w = pd.DataFrame(out)
    assert w.fire_id.is_unique, "two fires got the same id"
    w.to_csv(os.path.join(ROOT, "data", "fire_windows.csv"), index=False)
    print(f"Saved data/fire_windows.csv: {len(w)} fires, {N_CELLS}x{N_CELLS} squares, {N_HOURS} hours each")
    print(w[w.anchor_shift_h > 0][["fire_id", "calfire_start_utc", "anchor_shift_h"]].to_string(index=False))


if __name__ == "__main__":
    main()
