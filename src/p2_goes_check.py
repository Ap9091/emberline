"""
Emberline - Phase 2 check: are the GOES burning-square maps free of fake empty stripes?

Run from the project folder (after src/p2_goes.py):
    .venv/bin/python src/p2_goes_check.py

1. For Park Fire 2024 and Palisades Fire 2025, at the hour with the most burning squares, every grid
   row between the most northern and most southern burning row should have at least one burning square,
   unless the box holds several separate fires (it prints the map so you can see which it is).
2. Saves a picture of the Park Fire at hours 6, 24 and 48: results/phase2_goes_park_check.png
"""

import os

import matplotlib
matplotlib.use("Agg")  # draw to a file, no window needed
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

import grid

BURNING = os.path.join(grid.ROOT, "data", "processed", "burning")


def burning_map(burning, hour):
    """40 x 40 picture of one hour: 0 = not burning, 1 = seen by GOES, 2 = gap-filled."""
    m = np.zeros((grid.N_CELLS, grid.N_CELLS))
    b = burning[burning.hour_idx == hour]
    m[b.row, b.col] = np.where(b.gapfilled, 2, 1)
    return m


for fire_id in ["park_fire_2024", "palisades_fire_2025"]:
    burning = pd.read_parquet(os.path.join(BURNING, f"{fire_id}.parquet"))
    peak = burning.groupby("hour_idx").size().idxmax()
    rows = set(burning[burning.hour_idx == peak].row)
    missing = [r for r in range(min(rows), max(rows) + 1) if r not in rows]
    print(f"{fire_id}: peak hour {peak}, {len(burning[burning.hour_idx == peak])} burning squares, "
          f"rows {min(rows)}-{max(rows)}, rows with no burning square in between: {missing or 'none'}")
    # Print the map too. Empty rows are only a problem if they cut THROUGH a fire. The Palisades box also
    # holds other fires burning at the same time (Eaton on the east edge, Hurst to the north), and the
    # empty rows between those separate fires are real.
    for r, line in enumerate(burning_map(burning, peak)):
        print(f"  {r:2d} " + "".join("#" if v else "." for v in line))

park = pd.read_parquet(os.path.join(BURNING, "park_fire_2024.parquet"))
fig, axes = plt.subplots(1, 3, figsize=(15, 5.4))
for ax, hour in zip(axes, [6, 24, 48]):
    m = burning_map(park, hour)
    ax.imshow(m, cmap="hot_r", vmin=0, vmax=3, origin="upper")  # row 0 at the top = north up
    ax.set_title(f"Park Fire 2024 - hour {hour}: {int((m > 0).sum())} burning squares")
    ax.set_xlabel("col (west -> east, 2 km squares)")
    ax.set_ylabel("row (north at top)")
    ax.set_xticks(np.arange(-0.5, grid.N_CELLS, 5), labels=range(0, grid.N_CELLS + 1, 5))
    ax.set_yticks(np.arange(-0.5, grid.N_CELLS, 5), labels=range(0, grid.N_CELLS + 1, 5))
    ax.grid(color="lightgrey", linewidth=0.5)
fig.suptitle("GOES burning squares, pixel-footprint rule (orange = seen by GOES, dark red = gap-filled)")
fig.tight_layout()
out = os.path.join(grid.ROOT, "results", "phase2_goes_park_check.png")
fig.savefig(out, dpi=110)
print("Saved", out)
