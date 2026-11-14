"""
Emberline - Phase 2 fix: follow ONE fire per box.

Problem found in the first Phase 3 test run: an 80 km box can contain other fires. The Palisades box also holds
the Eaton Fire (35 km east), so "Palisades reached Altadena" was really Eaton. The model was then blamed for not
predicting fire that belonged to a different fire.

Fix (simple fire tracking):
  * Start from the square of the CAL FIRE start point (fire within 15 km of it counts as ours: start points of
    lightning complexes are often a few km off).
  * Hour by hour, a burning square belongs to OUR fire if it is within 6 km of the start square or of any square
    our fire has burned so far - or within 6 km of another square kept in the same hour (so a fast run is followed).
  * Everything else in the box is another fire and is removed.
6 km is the same distance we use for candidate squares, so spot fires up to ~6 km ahead are still kept.
Fires that start far away and later merge into ours are added from the moment they come within 6 km.

Run:   .venv/bin/python src/p2_track.py
Reads  data/processed/burning/{fire_id}.parquet and _hours.csv
Writes data/processed/burning_tracked/{fire_id}.parquet and _hours.csv (same columns) and results/phase2_tracking_summary.csv
"""

import os

import numpy as np
import pandas as pd
from scipy.ndimage import distance_transform_edt

import grid

P = os.path.join(grid.ROOT, "data", "processed")
SRC, DST = os.path.join(P, "burning"), os.path.join(P, "burning_tracked")
LINK_KM = 6.0
SEED_KM = 15.0   # CAL FIRE start points of complexes/lightning fires can be far from the first detections
N = grid.N_CELLS


def within(mask, km):
    """Squares whose centre is within `km` of a True square (distance measured in 2 km squares)."""
    if not mask.any():
        return np.zeros_like(mask)
    return distance_transform_edt(~mask) * (grid.CELL_M / 1000) <= km


def track(burning, start_rc):
    """Keep only the burning rows connected to our fire. Returns the kept rows."""
    ours = np.zeros((N, N), bool)          # every square our fire has burned so far
    seed = np.zeros((N, N), bool)
    seed[start_rc] = True
    keep = []
    for h in range(grid.N_HOURS):
        rows = burning[burning.hour_idx == h]
        if rows.empty:
            continue
        now = np.zeros((N, N), bool)
        now[rows.row, rows.col] = True
        kept = now & (within(ours, LINK_KM) | within(seed, SEED_KM))
        while True:                        # flood fill: squares linked to kept squares in the same hour
            more = now & within(kept, LINK_KM) & ~kept
            if not more.any():
                break
            kept |= more
        ours |= kept
        keep.append(rows[kept[rows.row, rows.col]])
    return pd.concat(keep) if keep else burning.iloc[0:0]


def main():
    os.makedirs(DST, exist_ok=True)
    w = grid.load_windows()
    summary = []
    for _, f in w.iterrows():
        burning = pd.read_parquet(os.path.join(SRC, f"{f.fire_id}.parquet"))
        hours = pd.read_csv(os.path.join(SRC, f"{f.fire_id}_hours.csv"))
        x, y = grid.TO_ALBERS.transform(f.lon, f.lat)
        r, c = grid.cell_of(x, y, f.xmin, f.ymax)
        kept = track(burning, (int(r), int(c)))
        kept.to_parquet(os.path.join(DST, f"{f.fire_id}.parquet"), index=False)
        hours["n_burning_squares"] = hours.hour_idx.map(kept.groupby("hour_idx").size()).fillna(0).astype(int)
        hours.to_csv(os.path.join(DST, f"{f.fire_id}_hours.csv"), index=False)
        summary.append({"fire_id": f.fire_id, "split": f.split, "square_hours_before": len(burning),
                        "square_hours_kept": len(kept), "removed_pct": round(100 * (1 - len(kept) / max(len(burning), 1)), 1)})
    s = pd.DataFrame(summary)
    s.to_csv(os.path.join(grid.ROOT, "results", "phase2_tracking_summary.csv"), index=False)
    print(s.groupby("split")[["square_hours_before", "square_hours_kept"]].sum())
    print("\nFires that lost the most (other fires in the box):")
    print(s.sort_values("removed_pct", ascending=False).head(12).to_string(index=False))


if __name__ == "__main__":
    main()
