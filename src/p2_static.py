"""
Emberline - Phase 2: the map features that never change (elevation, slope, vegetation).

Run from the project folder:
    .venv/bin/python src/p2_static.py                 # every fire (skips fires already done)
    .venv/bin/python src/p2_static.py park_fire_2024  # just the fires you name
    .venv/bin/python src/p2_static.py --plots park_fire_2024 palisades_fire_2025   # quick-look pictures

For every fire it writes data/processed/static/{fire_id}.parquet with one row per 2 km square
(40 x 40 = 1600 rows), and adds a line to results/phase2_static_summary.csv.

How it works (same recipe for every fire):
  1. Lay a lattice of sample points every 100 m across the fire's 80 km box
     (800 x 800 points, so every 2 km square holds 20 x 20 = 400 points).
  2. Look up the ELEVATION at each point from AWS Terrain Tiles (zoom 11, about 60-75 m pixels).
  3. Work out the SLOPE at each point from how fast elevation changes to its neighbours 100 m away.
  4. Look up the VEGETATION class at each point from ESA WorldCover (10 m map, read shrunk to ~100 m).
  5. For each 2 km square, summarise its 400 points: mean elevation, mean slope, most common
     vegetation class, and the share of each vegetation type.
"""

import io
import math
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pandas as pd
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from rasterio.windows import from_bounds

import grid  # the shared grid contract (src/grid.py)
import net   # our retry helper (src/net.py)

ROOT = grid.ROOT
TILE_DIR = os.path.join(ROOT, "data", "raw", "terrain_tiles")   # downloaded elevation tiles (reused)
OUT_DIR = os.path.join(ROOT, "data", "processed", "static")
SUMMARY = os.path.join(ROOT, "results", "phase2_static_summary.csv")
FIRST = ["park_fire_2024", "eaton_fire_2025", "palisades_fire_2025"]  # do these fires first

STEP_M = 100                              # distance between sample points
PER_CELL = grid.CELL_M // STEP_M          # 20 sample points across one 2 km square
N_PTS = grid.N_CELLS * PER_CELL           # 800 sample points across the whole box

ZOOM = 11                                 # terrain tile zoom level
TILE_PX = 256                             # each terrain tile is 256 x 256 pixels
LOWEST_LAND_M = -100                      # no California land is lower than this

WORLDCOVER_URL = ("https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/"
                  "ESA_WorldCover_10m_2021_v200_{name}_Map.tif")
WORLDCOVER_SHRINK = 10                    # read every 10th pixel (10 m -> about 100 m)
VEG_NAMES = {10: "Tree cover", 20: "Shrubland", 30: "Grassland", 40: "Cropland", 50: "Built-up",
             60: "Bare/sparse", 70: "Snow/ice", 80: "Water", 90: "Wetland", 95: "Mangroves",
             100: "Moss/lichen"}
# Our simpler groups: which WorldCover codes count towards each "share" column.
VEG_GROUPS = {"frac_tree": [10], "frac_shrub": [20], "frac_grass": [30], "frac_crop": [40],
              "frac_built": [50], "frac_bare": [60, 70, 100], "frac_water": [80, 90, 95]}
OCEAN = 80  # WorldCover has no data far out at sea; we call those points water


# ---------------------------------------------------------------------------
# Step 1. The lattice of sample points
# ---------------------------------------------------------------------------
def sample_points(xmin, ymax):
    """x, y, lon, lat of the 800 x 800 sample points (row 0 = north, col 0 = west)."""
    xs = xmin + (np.arange(N_PTS) + 0.5) * STEP_M      # west -> east
    ys = ymax - (np.arange(N_PTS) + 0.5) * STEP_M      # north -> south
    x, y = np.meshgrid(xs, ys)
    lon, lat = grid.TO_LONLAT.transform(x, y)
    return x, y, lon, lat


# ---------------------------------------------------------------------------
# Step 2. Elevation from AWS Terrain Tiles
# ---------------------------------------------------------------------------
def load_tile(tx, ty):
    """Elevation (metres) of one terrain tile as a 256 x 256 array. Downloads it once, then reuses the file."""
    path = os.path.join(TILE_DIR, f"{ZOOM}_{tx}_{ty}.png")
    if not os.path.exists(path):
        os.makedirs(TILE_DIR, exist_ok=True)   # a fresh clone has no tile cache yet
        url = f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{ZOOM}/{tx}/{ty}.png"
        png = net.get(url, timeout=60).content
        with open(path + ".part", "wb") as f:
            f.write(png)
        os.replace(path + ".part", path)   # only keep the file once it is complete
    rgb = np.asarray(Image.open(path).convert("RGB")).astype(float)
    # Terrarium encoding: height (m) = R*256 + G + B/256 - 32768
    elev = rgb[..., 0] * 256 + rgb[..., 1] + rgb[..., 2] / 256 - 32768
    # The lowest land in California is Death Valley (-86 m). Anything far below that is sea floor,
    # or one of the few broken pixels along the coast (values like -8000 m), so we call it sea level.
    elev[elev < LOWEST_LAND_M] = 0.0
    return elev


def elevation_at(lon, lat):
    """Elevation in metres at every sample point."""
    # Where each point falls on the world-wide web-map image at this zoom, in pixels.
    world_px = TILE_PX * 2 ** ZOOM
    px = (lon + 180) / 360 * world_px
    py = (1 - np.arcsinh(np.tan(np.radians(lat))) / math.pi) / 2 * world_px
    # Which tiles we need (one extra pixel of margin so we can blend between neighbours).
    tx0, tx1 = int((px.min() - 1) // TILE_PX), int((px.max() + 1) // TILE_PX)
    ty0, ty1 = int((py.min() - 1) // TILE_PX), int((py.max() + 1) // TILE_PX)
    jobs = [(tx, ty) for ty in range(ty0, ty1 + 1) for tx in range(tx0, tx1 + 1)]
    with ThreadPoolExecutor(max_workers=8) as pool:
        tiles = list(pool.map(lambda j: load_tile(*j), jobs))
    # Stitch the tiles into one big picture.
    mosaic = np.zeros(((ty1 - ty0 + 1) * TILE_PX, (tx1 - tx0 + 1) * TILE_PX))
    for (tx, ty), tile in zip(jobs, tiles):
        r, c = (ty - ty0) * TILE_PX, (tx - tx0) * TILE_PX
        mosaic[r:r + TILE_PX, c:c + TILE_PX] = tile
    # Position of each point inside the mosaic, measured from pixel centres.
    c = px - tx0 * TILE_PX - 0.5
    r = py - ty0 * TILE_PX - 0.5
    c0, r0 = np.floor(c).astype(int), np.floor(r).astype(int)
    fc, fr = c - c0, r - r0
    # Blend the 4 pixels around each point (bilinear), so slopes come out smooth, not stair-stepped.
    top = mosaic[r0, c0] * (1 - fc) + mosaic[r0, c0 + 1] * fc
    bottom = mosaic[r0 + 1, c0] * (1 - fc) + mosaic[r0 + 1, c0 + 1] * fc
    return top * (1 - fr) + bottom * fr, len(jobs)


# ---------------------------------------------------------------------------
# Step 3. Slope
# ---------------------------------------------------------------------------
def slope_degrees(elev):
    """Steepness at every sample point: 0 = flat, 45 = rises 1 m for every 1 m along the ground."""
    d_south, d_east = np.gradient(elev, STEP_M)       # metres of climb per metre of ground
    return np.degrees(np.arctan(np.hypot(d_south, d_east)))


# ---------------------------------------------------------------------------
# Step 4. Vegetation from ESA WorldCover
# ---------------------------------------------------------------------------
def worldcover_name(lat0, lon0):
    """Tile name from its lower-left corner, e.g. (39, -123) -> 'N39W123'."""
    return f"{'N' if lat0 >= 0 else 'S'}{abs(lat0):02d}{'E' if lon0 >= 0 else 'W'}{abs(lon0):03d}"


def read_worldcover(name, west, south, east, north):
    """Read one box from a WorldCover tile, shrunk 10x. Returns (array, west, north, deg per pixel x, y)."""
    def read():
        with rasterio.open(WORLDCOVER_URL.format(name=name)) as src:
            win = from_bounds(west, south, east, north, src.transform)
            shape = (max(1, round(win.height / WORLDCOVER_SHRINK)), max(1, round(win.width / WORLDCOVER_SHRINK)))
            # Resampling.mode = each shrunk pixel takes the most common class of the pixels it covers.
            return src.read(1, window=win, out_shape=shape, resampling=Resampling.mode)
    data = net.retry(read, tries=6)
    return data, west, north, (east - west) / data.shape[1], (north - south) / data.shape[0]


def vegetation_at(lon, lat):
    """WorldCover class code at every sample point. Also returns notes about anything odd."""
    veg = np.zeros(lon.shape, dtype=np.uint8)   # 0 = "not filled in yet / no data"
    notes = []
    # WorldCover tiles are 3 x 3 degrees. A fire box can touch more than one.
    for lat0 in range(int(math.floor(lat.min() / 3) * 3), int(math.floor(lat.max() / 3) * 3) + 1, 3):
        for lon0 in range(int(math.floor(lon.min() / 3) * 3), int(math.floor(lon.max() / 3) * 3) + 1, 3):
            inside = (lat >= lat0) & (lat < lat0 + 3) & (lon >= lon0) & (lon < lon0 + 3)
            if not inside.any():
                continue
            name = worldcover_name(lat0, lon0)
            # The part of this tile that our points need (small margin, kept inside the tile).
            west, east = max(lon0, lon[inside].min() - 0.01), min(lon0 + 3, lon[inside].max() + 0.01)
            south, north = max(lat0, lat[inside].min() - 0.01), min(lat0 + 3, lat[inside].max() + 0.01)
            try:
                data, w, n, dx, dy = read_worldcover(name, west, south, east, north)
            except Exception as e:
                notes.append(f"WorldCover tile {name} unreadable ({type(e).__name__}), "
                             f"{inside.mean():.0%} of box counted as water")
                continue
            # Nearest shrunk pixel for each point.
            c = np.clip(((lon[inside] - w) / dx).astype(int), 0, data.shape[1] - 1)
            r = np.clip(((n - lat[inside]) / dy).astype(int), 0, data.shape[0] - 1)
            veg[inside] = data[r, c]
    empty = veg == 0
    if empty.any():
        notes.append(f"{empty.mean():.1%} of points had no WorldCover data (open sea), counted as water")
        veg[empty] = OCEAN
    return veg, notes


# ---------------------------------------------------------------------------
# Step 5. Summarise the 400 points of each 2 km square
# ---------------------------------------------------------------------------
def per_cell(a):
    """Reshape an 800 x 800 lattice into (1600 squares, 400 points each), squares in row-then-col order."""
    n, p = grid.N_CELLS, PER_CELL
    return a.reshape(n, p, n, p).swapaxes(1, 2).reshape(n * n, p * p)


def build_fire(f):
    """Make the static table for one fire. Returns (table, notes)."""
    x, y, lon, lat = sample_points(f.xmin, f.ymax)
    elev, n_tiles = elevation_at(lon, lat)
    veg, notes = vegetation_at(lon, lat)
    # The terrain tiles also contain the SEA FLOOR (e.g. -800 m off Malibu). A fire only cares about
    # the surface, so water points below sea level are set to 0 m (flat sea) before we work out slope.
    sea = (veg == OCEAN) & (elev < 0)
    if sea.any():
        elev[sea] = 0.0
        notes.append(f"{sea.mean():.1%} of points are sea (sea floor depth replaced by 0 m)")
    slope = slope_degrees(elev)

    df = grid.cell_centres(f.xmin, f.ymax)            # row, col, x, y, lat, lon
    e, s, v = per_cell(elev), per_cell(slope), per_cell(veg)
    df["elevation_m"] = e.mean(axis=1).round(1)
    df["elevation_std_m"] = e.std(axis=1).round(1)
    df["slope_deg"] = s.mean(axis=1).round(2)
    # Count how many of the 400 points have each class, then pick the biggest count.
    codes = np.array(sorted(VEG_NAMES))
    counts = np.stack([(v == c).sum(axis=1) for c in codes], axis=1)
    df["veg_class"] = codes[counts.argmax(axis=1)]
    df["veg_name"] = df.veg_class.map(VEG_NAMES)
    for col, members in VEG_GROUPS.items():
        df[col] = np.isin(v, members).mean(axis=1).round(4)
    notes.insert(0, f"{n_tiles} terrain tiles")
    return df, notes


def save_picture(fire_id):
    """Quick look: elevation and vegetation class side by side -> results/phase2_static_{fire_id}.png"""
    import matplotlib
    matplotlib.use("Agg")   # draw straight to a file, no window needed
    import matplotlib.pyplot as plt
    from matplotlib.colors import ListedColormap
    df = pd.read_parquet(os.path.join(OUT_DIR, f"{fire_id}.parquet"))
    n = grid.N_CELLS
    elev = df.elevation_m.values.reshape(n, n)       # rows are already north -> south
    veg = df.veg_class.values.reshape(n, n)
    colours = {10: "#1b7837", 20: "#c9a227", 30: "#b8e186", 40: "#f4a6d7", 50: "#d7191c", 60: "#bdbdbd",
               70: "#ffffff", 80: "#2c7fb8", 90: "#66c2a5", 95: "#00cf75", 100: "#fae6a0"}
    codes = sorted(colours)
    index = np.searchsorted(codes, veg)              # class code -> 0, 1, 2, ... for colouring
    fig, (a, b) = plt.subplots(1, 2, figsize=(12, 5.5))
    im = a.imshow(elev, cmap="terrain")
    fig.colorbar(im, ax=a, label="mean elevation (m)")
    a.set_title(f"{fire_id}: elevation")
    b.imshow(index, cmap=ListedColormap([colours[c] for c in codes]), vmin=-0.5, vmax=len(codes) - 0.5)
    present = [c for c in codes if (veg == c).any()]
    b.legend(handles=[plt.Rectangle((0, 0), 1, 1, fc=colours[c], ec="k") for c in present],
             labels=[VEG_NAMES[c] for c in present], loc="center left", bbox_to_anchor=(1, 0.5))
    b.set_title("most common vegetation class (ESA WorldCover 2021)")
    for ax in (a, b):
        ax.set_xlabel("col (west -> east, 2 km squares)")
        ax.set_ylabel("row (north at top)")
    fig.tight_layout()
    fig.savefig(os.path.join(ROOT, "results", f"phase2_static_{fire_id}.png"), dpi=110)
    plt.close(fig)


def main():
    if sys.argv[1:2] == ["--plots"]:                 # .venv/bin/python src/p2_static.py --plots fire_id ...
        for fid in sys.argv[2:]:
            save_picture(fid)
        return
    os.makedirs(TILE_DIR, exist_ok=True)
    os.makedirs(OUT_DIR, exist_ok=True)
    w = grid.load_windows()
    if len(sys.argv) > 1:
        w = w[w.fire_id.isin(sys.argv[1:])]
    # Put the three headline fires first, keep the rest in list order.
    w = pd.concat([w[w.fire_id == fid] for fid in FIRST] + [w[~w.fire_id.isin(FIRST)]])

    for i, f in enumerate(w.itertuples(), 1):
        out = os.path.join(OUT_DIR, f"{f.fire_id}.parquet")
        if os.path.exists(out):
            print(f"[{i}/{len(w)}] {f.fire_id}: already done, skipping", flush=True)
            continue
        t0 = time.time()
        try:
            df, notes = build_fire(f)
        except Exception as e:   # one bad fire must not stop the rest; run again later to retry it
            print(f"[{i}/{len(w)}] {f.fire_id}: FAILED {type(e).__name__}: {e}", flush=True)
            continue
        df.to_parquet(out + ".part", index=False)
        os.replace(out + ".part", out)
        secs = time.time() - t0
        top = df.veg_name.value_counts(normalize=True)
        row = {"fire_id": f.fire_id, "mean_elevation_m": round(df.elevation_m.mean(), 1),
               "min_elevation_m": df.elevation_m.min(), "max_elevation_m": df.elevation_m.max(),
               "mean_slope_deg": round(df.slope_deg.mean(), 2),
               "majority_veg": top.index[0], "majority_veg_share": round(top.iloc[0], 3)}
        for col in VEG_GROUPS:                       # share of the whole box in each vegetation group
            row[col] = round(df[col].mean(), 3)
        row["seconds"] = round(secs, 1)
        row["notes"] = "; ".join(notes)
        pd.DataFrame([row]).to_csv(SUMMARY, mode="a", index=False, header=not os.path.exists(SUMMARY))
        print(f"[{i}/{len(w)}] {f.fire_id}: elev {row['mean_elevation_m']:.0f} m "
              f"({row['min_elevation_m']:.0f}-{row['max_elevation_m']:.0f}), slope {row['mean_slope_deg']:.1f} deg, "
              f"mostly {top.index[0]} {top.iloc[0]:.0%}, {secs:.0f}s | {row['notes']}", flush=True)
    print("Done.", flush=True)


if __name__ == "__main__":
    main()
