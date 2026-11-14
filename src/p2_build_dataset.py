"""
Emberline Phase 2 - build the ONE training table: data/processed/dataset.parquet

Every row = one candidate square, at one hour, of one fire.
  * Candidate squares = every square within 6 km of a square that is burning at hour h.
  * Features = what we know AT hour h (fire shape, weather, land).
  * Labels   = is the square burning 1, 2 and 3 hours LATER (label_1h, label_2h, label_3h).

Two rules keep the table honest:

  1. NO PEEKING AT THE FUTURE. The burning tables from p2_goes.py contain "gap-filled" rows: a square
     that was seen burning at h-1 and at h+1 is marked burning at h too. That fill uses hour h+1, so at
     hour h we could not have known it yet. Features therefore use ONLY what was known at hour h:
         - real satellite detections at hour h (gapfilled == False), and
         - everything (real + gap-filled) from hours before h  (those fills only needed hours <= h).
     Labels are allowed to use the full gap-filled table - labels are the future by definition.

  2. "NO DATA" IS NOT "NO FIRE". Hours with n_files == 0 have no satellite data at all (GOES-17 had a
     nightly outage in Aug 2020/2021). Such an hour makes no rows, and a label that falls on such an
     hour (or past hour 73) is NaN, not 0.

Run from the project folder (takes about a minute):
    .venv/bin/python src/p2_build_dataset.py

Outputs:
    data/processed/dataset.parquet
    results/phase2_dataset_report.md       (all the checks)
    results/phase2_grid_check_park.png     (3 maps of the Park Fire at one hour)
"""

import os
import time

import matplotlib
matplotlib.use("Agg")  # draw to a file, no screen needed
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

import grid

P = os.path.join(grid.ROOT, "data", "processed")
BURNING_DIR = "burning_tracked"   # one fire per box (src/p2_track.py removes other fires in the box)
OUT = os.path.join(P, "dataset.parquet")
REPORT = os.path.join(grid.ROOT, "results", "phase2_dataset_report.md")
MAP_PNG = os.path.join(grid.ROOT, "results", "phase2_grid_check_park.png")

N = grid.N_CELLS            # 40 squares across and down
CELL_KM = grid.CELL_M / 1000
CELL_AREA_KM2 = CELL_KM ** 2    # one square = 4 km2
CANDIDATE_KM = 6.0          # candidates = squares within 6 km of a burning square
NEAR_KM = 4.0               # radius for burning_within_4km
SPLIT_YEARS = {"train": range(2018, 2023), "val": [2023], "test": [2024, 2025]}

# The columns that the feature function makes (everything Phase 3 may feed to the model).
FEATURES = ["burning_now", "ever_burned", "distance_to_fire_km", "burning_neighbours", "burning_within_4km",
            "fire_area_now_km2", "growth_last_hour_km2", "burned_area_so_far_km2", "hours_since_start",
            "hour_of_day_local", "is_night", "wind_speed_kmh", "wind_gust_kmh", "humidity_pct", "temp_c",
            "downwind", "downwind_x_speed", "elevation_diff_m", "upslope", "slope_deg", "elevation_m",
            "veg_class", "frac_tree", "frac_shrub", "frac_grass", "frac_crop", "frac_built", "frac_water",
            "frp_now_mw"]


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------
def load_fire(fire_id):
    """The four input tables of one fire."""
    burning = pd.read_parquet(os.path.join(P, BURNING_DIR, f"{fire_id}.parquet"))
    hours = pd.read_csv(os.path.join(P, BURNING_DIR, f"{fire_id}_hours.csv"))
    hours["time_utc"] = pd.to_datetime(hours.time_utc, utc=True)
    static = pd.read_parquet(os.path.join(P, "static", f"{fire_id}.parquet")).sort_values(["row", "col"])
    weather = pd.read_parquet(os.path.join(P, "weather", f"{fire_id}.parquet"))
    return burning, hours, static.reset_index(drop=True), weather


def to_grid(rows, cols, values=True, fill=False):
    """Put a list of (row, col) squares onto a 40x40 picture of the grid."""
    g = np.full((N, N), fill, dtype=type(fill) if not isinstance(fill, float) else float)
    g[np.asarray(rows, dtype=int), np.asarray(cols, dtype=int)] = values
    return g


# ---------------------------------------------------------------------------
# THE CORE: features of one fire at one hour, from information known at that hour
# ---------------------------------------------------------------------------
def known_at_hour(burning, h):
    """The burning rows we could really have had at hour h (rule 1 at the top of this file)."""
    past = burning.hour_idx < h
    seen_now = (burning.hour_idx == h) & ~burning.gapfilled
    return burning[past | seen_now]


def features_for_hour(burning, hours, static, weather, h):
    """
    One row per candidate square of one fire at hour h, with every feature column.
    Returns None if hour h has no satellite data or no square was seen burning.

    Only uses: burning rows known at hour h, the hour table up to h, weather at h, and the land table.
    """
    hour_info = hours.set_index("hour_idx")
    if hour_info.n_files[h] == 0:
        return None                                   # no satellite data: we know nothing about this hour
    known = known_at_hour(burning, h)
    now = known[known.hour_idx == h]                  # squares really seen burning at hour h
    if len(now) == 0:
        return None

    burn = to_grid(now.row, now.col)                  # True where burning now
    ever = to_grid(known.row, known.col)              # True where burned at any hour <= h
    rows, cols = np.meshgrid(np.arange(N), np.arange(N), indexing="ij")
    b_rows, b_cols = np.nonzero(burn)

    # Distance (km) from every square to every burning square; keep the nearest.
    d_all = np.hypot(rows[..., None] - b_rows, cols[..., None] - b_cols) * CELL_KM   # shape 40 x 40 x n_burning
    dist = d_all.min(axis=2)
    within_4km = (d_all <= NEAR_KM).sum(axis=2)       # burning squares within 4 km (counts the square itself)

    # How many of the 8 neighbours are burning: add up the grid shifted in the 8 directions.
    padded = np.pad(burn, 1).astype(int)
    neighbours = sum(padded[1 + dr:N + 1 + dr, 1 + dc:N + 1 + dc]
                     for dr in (-1, 0, 1) for dc in (-1, 0, 1) if (dr, dc) != (0, 0))

    cand = (dist <= CANDIDATE_KM).ravel()             # the candidate squares (static is in row, col order)
    out = static.loc[cand, ["row", "col"]].copy()
    flat = lambda a: a.ravel()[cand]
    out["burning_now"] = flat(burn).astype("int8")
    out["ever_burned"] = flat(ever).astype("int8")
    out["distance_to_fire_km"] = flat(dist)
    out["burning_neighbours"] = flat(neighbours)
    out["burning_within_4km"] = flat(within_4km)

    # Whole-fire numbers (the same for every square this hour).
    out["fire_area_now_km2"] = len(now) * CELL_AREA_KM2
    if h == 0 or hour_info.n_files[h - 1] == 0:
        out["growth_last_hour_km2"] = np.nan          # no "hour before" to compare with
    else:
        before = burning[(burning.hour_idx == h - 1) & ~burning.gapfilled]   # real detections, like "now"
        out["growth_last_hour_km2"] = (len(now) - len(before)) * CELL_AREA_KM2
    out["burned_area_so_far_km2"] = ever.sum() * CELL_AREA_KM2
    out["frp_now_mw"] = now.max_power_mw.sum(min_count=1)   # fire power; NaN only if no square has a value

    # Time of day (Pacific time, handles summer/winter time).
    local = hour_info.time_utc[h].tz_convert("America/Los_Angeles")
    out["hours_since_start"] = h - 1                  # hour 1 is the anchor hour
    out["hour_of_day_local"] = local.hour
    out["is_night"] = int(local.hour < 6 or local.hour >= 20)

    # Weather at hour h (one value for the whole fire).
    wx = weather.set_index("hour_idx").loc[h]
    for c in ["wind_speed_kmh", "wind_gust_kmh", "humidity_pct", "temp_c"]:
        out[c] = wx[c]

    # Downwind: +1 if the square lies exactly where the wind is blowing the fire, -1 if exactly upwind.
    # It is the cosine of the angle between the wind arrow (u, v) and the arrow fire centre -> square.
    fire_x, fire_y = static.x[burn.ravel()].mean(), static.y[burn.ravel()].mean()
    dx, dy = static.x[cand] - fire_x, static.y[cand] - fire_y
    length = np.hypot(dx, dy) * np.hypot(wx.wind_u_kmh, wx.wind_v_kmh)
    out["downwind"] = np.where(length > 0, (dx * wx.wind_u_kmh + dy * wx.wind_v_kmh) / np.where(length > 0, length, 1), 0.0)
    out["downwind_x_speed"] = out.downwind * wx.wind_speed_kmh

    # Land: is the square higher than the fire (fire runs uphill fast)?
    out["elevation_diff_m"] = static.elevation_m[cand] - static.elevation_m[burn.ravel()].mean()
    out["upslope"] = out.elevation_diff_m / np.maximum(out.distance_to_fire_km, 1.0)   # metres up per km
    for c in ["slope_deg", "elevation_m", "veg_class", "frac_tree", "frac_shrub", "frac_grass", "frac_crop",
              "frac_built", "frac_water"]:
        out[c] = static.loc[cand, c]
    out.insert(0, "hour_idx", h)
    return out.reset_index(drop=True)


# ---------------------------------------------------------------------------
# Labels (these DO look at the future - that is what a label is)
# ---------------------------------------------------------------------------
def add_labels(feat, burning, hours, h):
    """Add label_kh, new_kh and the gap-fill flags for k = 1, 2, 3 hours after hour h."""
    n_files = hours.set_index("hour_idx").n_files
    whole_gap = hours.set_index("hour_idx").hour_gapfilled
    r, c = feat.row.values, feat.col.values
    for k in (1, 2, 3):
        t = h + k
        if t >= grid.N_HOURS or n_files[t] == 0:
            # Past the end of the window, or no satellite data: we do not know the answer.
            feat[f"label_{k}h"] = np.nan
            feat[f"new_{k}h"] = np.nan
            feat[f"label_{k}h_gapfilled"] = False
            feat[f"hour_gapfilled_{k}h"] = False
            continue
        later = burning[burning.hour_idx == t]
        label = to_grid(later.row, later.col)[r, c]
        feat[f"label_{k}h"] = label.astype(float)
        feat[f"new_{k}h"] = (label & (feat.ever_burned.values == 0)).astype(float)   # burning then, never before
        # True if this label comes from a gap-filled row (not directly seen by the satellite).
        filled = later[later.gapfilled]
        feat[f"label_{k}h_gapfilled"] = to_grid(filled.row, filled.col)[r, c]
        feat[f"hour_gapfilled_{k}h"] = bool(whole_gap[t])    # the WHOLE hour h+k was copied from the hour before
    return feat


# ---------------------------------------------------------------------------
# One whole fire, and the nearest town of every square
# ---------------------------------------------------------------------------
def nearest_towns(static, towns, tree):
    """Nearest town (straight-line, EPSG:3310 metres) for each of the fire's 1600 squares."""
    dist_m, idx = tree.query(static[["x", "y"]].values)
    return pd.DataFrame({"row": static.row, "col": static.col,
                         "nearest_town": towns.name.values[idx],
                         "nearest_town_pop": towns.population.values[idx],
                         "nearest_town_dist_km": dist_m / 1000})


def build_fire(fire, towns, tree):
    """All rows of one fire."""
    burning, hours, static, weather = load_fire(fire.fire_id)
    parts = []
    for h in range(grid.N_HOURS):
        feat = features_for_hour(burning, hours, static, weather, h)
        if feat is not None:
            parts.append(add_labels(feat, burning, hours, h))
    if not parts:
        return None
    d = pd.concat(parts, ignore_index=True)
    d = d.merge(static[["row", "col", "x", "y", "lat", "lon"]], on=["row", "col"])
    d = d.merge(nearest_towns(static, towns, tree), on=["row", "col"])
    d = d.merge(hours[["hour_idx", "time_utc"]], on="hour_idx")
    d["fire_id"], d["fire_name"], d["split"] = fire.fire_id, fire["name"], fire.split
    d["square_id"] = d.fire_id + "_" + d.row.astype(str) + "_" + d.col.astype(str)
    return d.sort_values(["hour_idx", "row", "col"]).reset_index(drop=True)


def compact(d):
    """Smaller number types so the file and memory stay small; fixed column order."""
    ids = ["fire_id", "fire_name", "split", "hour_idx", "time_utc", "square_id", "row", "col", "x", "y", "lat", "lon"]
    labels = [f"{name}_{k}h" for k in (1, 2, 3) for name in ("label", "new")]
    flags = [name.format(k=k) for k in (1, 2, 3) for name in ("label_{k}h_gapfilled", "hour_gapfilled_{k}h")]
    towns = ["nearest_town", "nearest_town_pop", "nearest_town_dist_km"]
    d = d[ids + FEATURES + labels + flags + towns].copy()
    for c in ["fire_id", "fire_name", "split", "nearest_town"]:
        d[c] = d[c].astype("category")
    for c in ["burning_now", "ever_burned", "burning_neighbours", "is_night", "hour_of_day_local"]:
        d[c] = d[c].astype("int8")
    for c in ["hour_idx", "row", "col", "burning_within_4km", "hours_since_start", "veg_class"]:
        d[c] = d[c].astype("int16")
    for c in d.columns:
        if d[c].dtype == "float64" and c not in ("x", "y", "lat", "lon"):
            d[c] = d[c].astype("float32")     # labels stay float so they can hold NaN
    return d


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------
def refill_gaps(seen):
    """The gap-fill rule of p2_goes.py, redone on a table of real detections only (used by the test)."""
    last = int(seen.hour_idx.max()) if len(seen) else 0
    squares = {h: set() for h in range(-1, last + 2)}
    for h, r, c in zip(seen.hour_idx, seen.row, seen.col):
        squares[h].add((r, c))
    filled = []
    for h in range(1, last):                      # hour h can only be filled once hour h+1 exists
        before, now, after = squares[h - 1], squares[h], squares[h + 1]
        new = before if (not now and before and after) else (before & after) - now
        filled += [(h, r, c) for r, c in sorted(new)]
    fill = pd.DataFrame(filled, columns=["hour_idx", "row", "col"])
    fill["n_scans"], fill["max_power_mw"], fill["gapfilled"] = 0, np.nan, True
    out = pd.concat([seen, fill], ignore_index=True).sort_values(["hour_idx", "row", "col"])
    return out.astype({"hour_idx": "int16", "row": "int16", "col": "int16", "max_power_mw": "float32",
                       "gapfilled": bool}).reset_index(drop=True)


def no_future_test(fire_id):
    """
    Proof that features do not use the future. For every hour h of one fire:
      1. Throw away EVERYTHING after hour h: keep only the real satellite detections of hours 0..h,
         the hour table up to h and the weather up to h.
      2. Redo the gap filling from scratch on that cut-down data (so no fill can use hour h+1).
      3. Run the feature function and demand exactly the same numbers as with the full tables.
    Returns (hours tested, feature rows compared).
    """
    burning, hours, static, weather = load_fire(fire_id)
    seen = burning[~burning.gapfilled]
    # First make sure our copy of the gap-fill rule rebuilds the real table exactly.
    key = ["hour_idx", "row", "col", "gapfilled"]
    pd.testing.assert_frame_equal(refill_gaps(seen)[key], burning[key].reset_index(drop=True), check_dtype=False)

    n_hours, n_rows = 0, 0
    for h in range(grid.N_HOURS):
        full = features_for_hour(burning, hours, static, weather, h)
        cut = features_for_hour(refill_gaps(seen[seen.hour_idx <= h]), hours[hours.hour_idx <= h], static,
                                weather[weather.hour_idx <= h], h)
        assert (full is None) == (cut is None), f"{fire_id} hour {h}: rows appear/disappear with future data"
        if full is not None:
            pd.testing.assert_frame_equal(full, cut)      # identical values, or this stops with an error
            n_hours, n_rows = n_hours + 1, n_rows + len(full)
    return n_hours, n_rows


def leak_if_gapfill_used(d, burning_by_fire):
    """How many candidate rows are gap-filled-burning at hour h (what a careless build would have leaked)."""
    n = 0
    for fire_id, b in burning_by_fire.items():
        g = b[b.gapfilled][["hour_idx", "row", "col"]].assign(fire_id=fire_id)
        n += len(d[d.fire_id == fire_id].merge(g, on=["fire_id", "hour_idx", "row", "col"]))
    return n


def precision_recall(truth, guess):
    """Precision = of the squares we said would burn, how many did. Recall = of those that burned, how many we said."""
    hit = ((truth == 1) & (guess == 1)).sum()
    return hit / max((guess == 1).sum(), 1), hit / max((truth == 1).sum(), 1)


def draw_map(d, h):
    """Three maps of the Park Fire at hour h: burning now, burning in 1 hour, and the downwind feature."""
    fire_id = "park_fire_2024"
    one = d[(d.fire_id == fire_id) & (d.hour_idx == h)]
    weather = pd.read_parquet(os.path.join(P, "weather", f"{fire_id}.parquet")).set_index("hour_idx").loc[h]
    when = one.time_utc.iloc[0]
    local = when.tz_convert("America/Los_Angeles")

    def picture(column):
        g = np.full((N, N), np.nan)
        g[one.row, one.col] = one[column]
        return g

    grey, red = "#e9e7e1", "#b3261e"
    fig, axes = plt.subplots(1, 3, figsize=(17, 6.4), constrained_layout=True)
    panels = [("burning_now", f"1. Burning now (hour {h}): {int(one.burning_now.sum())} squares"),
              ("label_1h", f"2. Label: burning 1 hour later (hour {h + 1}): {int(one.label_1h.sum())} squares")]
    for ax, (column, title) in zip(axes[:2], panels):
        g = picture(column)
        ax.imshow(np.where(np.isnan(g), 0, 0.35), cmap="Greys", vmin=0, vmax=1, extent=(0, N, N, 0))  # candidates
        ax.imshow(np.where(g == 1, 1.0, np.nan), cmap=matplotlib.colors.ListedColormap([red]), extent=(0, N, N, 0))
        ax.set_title(title, fontsize=12, loc="left")
        ax.legend(handles=[matplotlib.patches.Patch(color=red, label="burning"),
                           matplotlib.patches.Patch(color="#a6a6a6", label="candidate square (within 6 km), not burning"),
                           matplotlib.patches.Patch(facecolor="white", edgecolor="#999", label="not in the table")],
                  loc="lower right", fontsize=8, framealpha=0.9)

    ax = axes[2]
    ax.set_facecolor(grey)
    im = ax.imshow(picture("downwind"), cmap="RdBu_r", vmin=-1, vmax=1, extent=(0, N, N, 0))
    fig.colorbar(im, ax=ax, shrink=0.75, label="downwind  (+1 = straight downwind of the fire centre,  -1 = upwind)")
    # Wind arrow from the fire centre, pointing where the wind blows TOWARD (rows go down, so north = -row).
    now = one[one.burning_now == 1]
    cx, cy = now.col.mean() + 0.5, now.row.mean() + 0.5
    speed = np.hypot(weather.wind_u_kmh, weather.wind_v_kmh)
    ux, uy = weather.wind_u_kmh / speed, weather.wind_v_kmh / speed
    ax.annotate("", xy=(cx + 9 * ux, cy - 9 * uy), xytext=(cx, cy),
                arrowprops=dict(facecolor="black", edgecolor="white", width=4, headwidth=13))
    ax.plot(cx, cy, "o", color="black", markeredgecolor="white", markersize=8)
    ax.text(cx + 10 * ux, cy - 10 * uy, f"wind blows this way\n{weather.wind_speed_kmh:.0f} km/h from {weather.wind_dir_deg:.0f} deg",
            ha="center", va="bottom" if uy > 0 else "top", fontsize=9, fontweight="bold",
            bbox=dict(facecolor="white", edgecolor="none", alpha=0.8, pad=1.5))
    ax.set_title("3. Candidate squares coloured by 'downwind'  (dot = fire centre)", fontsize=12, loc="left")

    for ax in axes:
        ax.set_xticks(range(0, N + 1, 5)); ax.set_yticks(range(0, N + 1, 5))
        ax.set_xticks(range(N + 1), minor=True); ax.set_yticks(range(N + 1), minor=True)
        ax.grid(which="minor", color="#cfcfcf", linewidth=0.3)
        ax.set_xlabel("col  (0 = west edge; each square is 2 km)"); ax.set_ylabel("row  (0 = north edge)")
        ax.text(0.02, 0.97, "N ^", transform=ax.transAxes, va="top", fontsize=11, fontweight="bold")
    fig.suptitle(f"Park Fire 2024 - dataset check at hour {h}  ({local:%d %b %Y %H:%M} Pacific = {when:%H:%M} UTC), "
                 f"40 x 40 grid of 2 km squares, north up", fontsize=13)
    fig.savefig(MAP_PNG, dpi=130)
    plt.close(fig)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    t0 = time.time()
    lines = []                                    # everything we print also goes into the report

    def say(text=""):
        print(text)
        lines.append(text)

    windows = grid.load_windows()
    towns = pd.read_csv(os.path.join(P, "towns_ca.csv"))
    tree = cKDTree(towns[["x", "y"]].values)      # fast "which town is nearest" lookup

    # ---- Build ----
    parts, burning_by_fire, no_rows = [], {}, []
    for _, fire in windows.iterrows():
        d = build_fire(fire, towns, tree)
        burning_by_fire[fire.fire_id] = load_fire(fire.fire_id)[0]
        if d is None:
            no_rows.append(fire.fire_id)
        else:
            parts.append(d)
    d = compact(pd.concat(parts, ignore_index=True))
    d.to_parquet(OUT, index=False)
    build_s = time.time() - t0
    size_mb = os.path.getsize(OUT) / 1e6
    mem_mb = d.memory_usage(deep=True).sum() / 1e6

    say("# Emberline Phase 2 - dataset report")
    say(f"\nMade by `src/p2_build_dataset.py`. Table: `data/processed/dataset.parquet`")
    say(f"\n- {len(d):,} rows x {d.shape[1]} columns, {d.fire_id.nunique()} fires "
        f"(fires with no rows: {no_rows or 'none'})")
    say(f"- file size {size_mb:.1f} MB, in memory {mem_mb:.0f} MB, build time {build_s:.0f} s")
    say(f"- {len(FEATURES)} feature columns: {', '.join(FEATURES)}")
    say("- Each row = one candidate square (within 6 km of a square burning at hour h) at one hour of one fire.")

    # ---- 1. Rows, fires and positive shares per split ----
    say("\n## 1. Rows and labels per split\n")
    table = d.groupby("split", observed=True).agg(
        fires=("fire_id", "nunique"), rows=("label_1h", "size"),
        label_1h_pct=("label_1h", lambda s: 100 * s.mean()), new_1h_pct=("new_1h", lambda s: 100 * s.mean()),
        label_3h_pct=("label_3h", lambda s: 100 * s.mean()), new_3h_pct=("new_3h", lambda s: 100 * s.mean()),
        burning_now_pct=("burning_now", lambda s: 100 * s.mean())).loc[["train", "val", "test"]]
    say("```\n" + table.round(2).to_string() + "\n```")
    say("(percentages are of rows whose label is known; NaN labels are left out)")

    say("\nRows with a NaN (unknown) label, and why:\n")
    n_files = {(f, h): n for f in d.fire_id.cat.categories
               for h, n in zip(range(grid.N_HOURS), pd.read_csv(os.path.join(P, BURNING_DIR, f"{f}_hours.csv")).n_files)}
    why = []
    for k in (1, 2, 3):
        nan = d[d[f"label_{k}h"].isna()]
        past_end = (nan.hour_idx + k >= grid.N_HOURS)
        no_data = [(not p) and n_files[(f, h + k)] == 0 for f, h, p in zip(nan.fire_id, nan.hour_idx, past_end)]
        why.append({"label": f"label_{k}h", "NaN rows": len(nan), "past hour 73": int(past_end.sum()),
                    "no satellite data that hour": int(np.sum(no_data)),
                    "unexplained": int(len(nan) - past_end.sum() - np.sum(no_data))})
        assert why[-1]["unexplained"] == 0, "a label is NaN for an unknown reason"
        assert d[f"new_{k}h"].isna().equals(d[f"label_{k}h"].isna())
    say("```\n" + pd.DataFrame(why).to_string(index=False) + "\n```")
    say(f"\nLabels that come from gap-filled rows (Phase 3 can drop them): label_1h_gapfilled = "
        f"{int(d.label_1h_gapfilled.sum()):,} rows; hour_gapfilled_1h (whole hour h+1 copied) = "
        f"{int(d.hour_gapfilled_1h.sum()):,} rows.")

    # How much of the next hour's fire is inside our candidate squares at all?
    say("\nCoverage: of all squares burning at h+1 (when hour h had fire and data), the share that is a candidate row at h:\n")
    cover = []
    for split in ["train", "val", "test"]:
        inside, total = d[d.split == split].label_1h.sum(), 0
        for fire_id in windows.fire_id[windows.split == split]:
            b = burning_by_fire[fire_id]
            hours_with_rows = set(d.hour_idx[d.fire_id == fire_id])
            total += b.hour_idx.isin([h + 1 for h in hours_with_rows]).sum()
        cover.append({"split": split, "burning at h+1": int(total), "inside candidates": int(inside),
                      "coverage_pct": round(100 * inside / total, 1)})
    say("```\n" + pd.DataFrame(cover).to_string(index=False) + "\n```")
    say("(the rest is fire that appears more than 6 km from any square burning at h - the model can never predict those)")

    # ---- 2. Example rows ----
    say("\n## 2. Five example rows (test split)\n")
    test = d[d.split == "test"]
    picks = pd.concat([test[(test.new_1h == 1)].sample(1, random_state=1),
                       test[(test.label_1h == 1) & (test.burning_now == 1)].sample(1, random_state=2),
                       test[(test.label_1h == 0) & (test.burning_now == 1)].sample(1, random_state=3),
                       test[(test.label_1h == 0) & (test.burning_now == 0)].sample(2, random_state=4)])
    say("```\n" + picks.T.to_string() + "\n```")

    # ---- 3. No-future-data test ----
    say("\n## 3. No-future-data test\n")
    say("For each hour h we delete everything after hour h (burning detections, hour table, weather), redo the\n"
        "gap filling on what is left, rerun `features_for_hour` and require identical features (assert).\n")
    for fire_id in ["park_fire_2024", "caldor_fire_2021", "palisades_fire_2025"]:
        if fire_id not in set(windows.fire_id):
            continue
        n_hours, n_rows = no_future_test(fire_id)
        say(f"- PASS  {fire_id}: {n_hours} hours, {n_rows:,} feature rows identical with and without future data")
    leak = leak_if_gapfill_used(d, burning_by_fire)
    gap_total = sum(int(b.gapfilled.sum()) for b in burning_by_fire.values())
    say(f"\nWhy this matters: the burning tables hold {gap_total:,} gap-filled square-hours (burning at h-1 and h+1, so\n"
        f"marked burning at h). Using them as 'burning_now' would leak hour h+1. They are NOT used for the features of\n"
        f"their own hour; {leak:,} candidate rows would have been affected. In those rows burning_now = 0.")
    still = d.merge(pd.concat([b[b.gapfilled].assign(fire_id=f) for f, b in burning_by_fire.items()])
                    [["fire_id", "hour_idx", "row", "col"]], on=["fire_id", "hour_idx", "row", "col"])
    assert (still.burning_now == 0).all(), "a gap-filled square is marked burning_now"
    say("- PASS  no gap-filled square is marked burning_now in its own hour")

    # ---- 4. Split check ----
    say("\n## 4. Split check\n")
    splits_per_fire = d.groupby("fire_id", observed=True).split.nunique()
    assert (splits_per_fire == 1).all(), "a fire is in two splits"
    say(f"- PASS  no fire_id appears in two splits ({len(splits_per_fire)} fires checked)")
    year = d.fire_id.map(windows.set_index("fire_id").year).astype(int)
    for split, years in SPLIT_YEARS.items():
        assert year[d.split == split].isin(list(years)).all(), f"{split} has a fire from the wrong year"
    say("- PASS  split matches the year (train 2018-2022, val 2023, test 2024-2025)")
    assert not d.duplicated(["fire_id", "hour_idx", "row", "col"]).any()
    say("- PASS  no duplicate (fire, hour, square) rows")
    assert (d.distance_to_fire_km <= CANDIDATE_KM).all() and ((d.distance_to_fire_km == 0) == (d.burning_now == 1)).all()
    say("- PASS  every row is within 6 km of the fire; distance is 0 exactly for burning squares")
    assert d.downwind.between(-1.0001, 1.0001).all()
    missing = d[FEATURES].isna().sum()
    say(f"- Missing feature values: {missing[missing > 0].to_dict() or 'none'}")
    say(f"- nearest_town_pop missing in {int(d.nearest_town_pop.isna().sum()):,} rows "
        f"(towns with no population in towns_ca.csv)")

    # ---- 5. Persistence baseline ----
    say("\n## 5. Baseline for Phase 3: 'persistence' (predict label_1h = burning_now)\n")
    base = []
    for split in ["train", "val", "test"]:
        s = d[(d.split == split) & d.label_1h.notna()]
        p, r = precision_recall(s.label_1h, s.burning_now)
        base.append({"split": split, "rows": len(s), "precision": round(p, 3), "recall": round(r, 3),
                     "F1": round(2 * p * r / (p + r), 3)})
    say("```\n" + pd.DataFrame(base).to_string(index=False) + "\n```")
    say("Persistence can never find a newly burning square (new_1h), so Phase 3 should also score on new_1h.")

    # ---- 6. Map ----
    park = d[(d.fire_id == "park_fire_2024") & d.hour_idx.between(20, 30) & d.label_1h.notna()]
    h = int(park.groupby("hour_idx").burning_now.sum().idxmax())
    draw_map(d, h)
    say(f"\n## 6. Map check\n\n`results/phase2_grid_check_park.png` - Park Fire at hour {h}: burning now, label 1 h later, downwind + wind arrow.")
    say("\n![Park Fire grid check](phase2_grid_check_park.png)")

    say("\n## Notes and approximations\n")
    say("- Features at hour h use real detections at h plus everything known from earlier hours; labels use the gap-filled table.")
    say("- Hours whose fire is entirely gap-filled (64 fire-hours) or that have no satellite data make no rows.")
    say("- 'Fire centre' (for downwind) and the mean fire elevation use ALL squares burning in the 80 km box, so a second\n"
        "  fire in the box pulls the centre towards it.")
    say("- growth_last_hour_km2 counts real detections in both hours; it is NaN at hour 0 or after a no-data hour.")
    say("- burning_within_4km counts the square itself if it is burning; burning_neighbours does not.")
    say("- frp_now_mw adds up the squares that have a power value (GOES gives no power for some fire pixels).")
    say("- Squares near the box edge have fewer neighbours inside the box; fire outside the box is not seen.")
    say("- Weather is one point per fire (its start point), the same for every square in an hour.")
    say("- nearest_town_* columns are for warnings only - NOT model features. Do not train on them or on the ID columns.")
    say(f"\nTotal run time {time.time() - t0:.0f} s.")

    with open(REPORT, "w") as f:
        f.write("\n".join(lines) + "\n")
    print(f"\nSaved {OUT}\nSaved {REPORT}\nSaved {MAP_PNG}")


if __name__ == "__main__":
    main()
