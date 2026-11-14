"""
Emberline - Phase 1: check that we can get every piece of data.

Run from the project folder:
    .venv/bin/python src/check_sources.py

Each test downloads ONE small sample, prints what came back, and records OK / FAIL.
Samples are saved to data/raw/samples/ so we can look at them later.
Nothing here builds the dataset yet (that is Phase 2).
"""

import io
import json
import math
import os
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pandas as pd
import requests
from dotenv import load_dotenv

import net  # our retry helper (src/net.py)

from california import in_california  # our small helper: is a lat/lon inside California?

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # project folder
SAMPLES = os.path.join(ROOT, "data", "raw", "samples")
os.makedirs(SAMPLES, exist_ok=True)
load_dotenv(os.path.join(ROOT, ".env"))  # reads API keys from .env (never committed)

CHICO = (39.7285, -121.8375)  # lat, lon - Chico, Butte County (near the Park Fire)
RESULTS = {}  # name -> "OK ..." or "FAIL ..."


def record(name, ok, note=""):
    """Remember the result of one check and print it."""
    RESULTS[name] = ("OK  " if ok else "FAIL") + "  " + note
    print(f"  -> {'OK' if ok else 'FAIL'}  {note}\n")


def run(name, func):
    """Run one check; if it crashes, record FAIL with the error instead of stopping everything."""
    print(f"=== {name} ===")
    try:
        func()
    except Exception as e:  # we want to keep going and see every source
        record(name, False, f"{type(e).__name__}: {str(e)[:200]}")


# ---------------------------------------------------------------------------
# 1. API keys - one tiny request each
# ---------------------------------------------------------------------------
def check_firms_key():
    key = os.environ.get("FIRMS_MAP_KEY", "")
    r = net.get(f"https://firms.modaps.eosdis.nasa.gov/mapserver/mapkey_status/?MAP_KEY={key}")
    info = r.json()  # tells us how many requests we have left in the 10-minute window
    print("  FIRMS key status:", info)
    record("Key: FIRMS_MAP_KEY", r.ok and "current_transactions" in info,
           f"{info.get('current_transactions')}/{info.get('transaction_limit')} transactions used")


def check_gemini_key():
    from google import genai
    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    model = "gemini-3.8-flash"  # newest Flash model the key can see (checked with client.models.list())
    reply = net.retry(lambda: client.models.generate_content(model=model, contents="Reply with the single word: OK"))
    print("  Gemini replied:", repr(reply.text.strip()))
    record("Key: GEMINI_API_KEY", bool(reply.text), f"{model} answered")


def check_anthropic_key():
    key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not key:
        # Expected for now - the key gets added tomorrow. Phases 1-3 do not need it.
        record("Key: ANTHROPIC_API_KEY", False, "empty (expected - add it before Phase 4; Gemini is the fallback)")
        return
    import anthropic
    client = anthropic.Anthropic(api_key=key)
    msg = client.messages.create(model="claude-haiku-5-5", max_tokens=5,
                                 messages=[{"role": "user", "content": "Reply with: OK"}])
    record("Key: ANTHROPIC_API_KEY", True, f"claude-haiku-5-5 answered {msg.content[0].text!r}")


# ---------------------------------------------------------------------------
# 3a. GOES fire product (ABI-L2-FDCC) on AWS - no key needed
# ---------------------------------------------------------------------------
# The fire "Mask" variable is a code per pixel. Codes that mean FIRE (from the GOES ABI
# Fire/Hot Spot product user guide):
#   10 = processed fire (good quality)         30 = same, temporally filtered
#   11 = saturated fire pixel                  31 = same, temporally filtered
#   12 = cloud-contaminated fire               32 = same, temporally filtered
#   13 = high-probability fire                 33 = same, temporally filtered
#   14 = medium-probability fire               34 = same, temporally filtered
#   15 = low-probability fire                  35 = same, temporally filtered
# We count 10-14 and 30-34 as fire, and leave out low probability (15, 35), which is mostly noise.
FIRE_CODES = [10, 11, 12, 13, 14, 30, 31, 32, 33, 34]

# One hour with a big active California fire, for each satellite era.
GOES_TESTS = [
    # bucket,        year, day-of-year, hour UTC, what was burning
    ("noaa-goes16", 2018, 208, 22, "Carr Fire, 27 Jul 2018"),
    ("noaa-goes17", 2020, 233, 22, "LNU/SCU/CZU complexes, 20 Aug 2020"),
    ("noaa-goes18", 2024, 207, 22, "Park Fire, 25 Jul 2024"),
]


def goes_lat_lon(ds):
    """Turn the GOES fixed-grid x/y (scan angles in radians) into latitude/longitude."""
    from pyproj import Proj
    p = ds["goes_imager_projection"].attrs
    h = float(p["perspective_point_height"])  # satellite height above Earth (m)
    proj = Proj(proj="geos", h=h, lon_0=float(p["longitude_of_projection_origin"]),
                a=float(p["semi_major_axis"]), b=float(p["semi_minor_axis"]),
                sweep=p["sweep_angle_axis"])
    xx, yy = np.meshgrid(ds["x"].values * h, ds["y"].values * h)  # radians -> metres
    lon, lat = proj(xx, yy, inverse=True)  # pixels off the Earth's edge come back as 1e30
    lon[np.abs(lon) > 360] = np.nan
    lat[np.abs(lat) > 90] = np.nan
    return lat, lon


def check_goes():
    import s3fs
    import xarray as xr
    fs = s3fs.S3FileSystem(anon=True)  # anonymous = no AWS account needed
    notes = []
    for bucket, year, doy, hour, what in GOES_TESTS:
        prefix = f"{bucket}/ABI-L2-FDCC/{year}/{doy:03d}/{hour:02d}/"
        files = fs.ls(prefix, detail=True)
        mb = sum(f["size"] for f in files) / 1e6
        print(f"  {bucket} {year} day {doy} {hour:02d}Z ({what}): {len(files)} files, {mb:.1f} MB")

        # Download the whole hour, 8 files at a time, and time it.
        local = os.path.join(SAMPLES, "goes", bucket)
        os.makedirs(local, exist_ok=True)
        t0 = time.time()
        with ThreadPoolExecutor(8) as pool:
            list(pool.map(lambda f: fs.get(f["name"], os.path.join(local, os.path.basename(f["name"]))), files))
        secs = time.time() - t0
        print(f"    downloaded 1 hour in {secs:.1f} s ({mb / secs:.1f} MB/s, 8 parallel)")

        # Open the first file of the hour and count fire pixels inside California.
        first = os.path.join(local, os.path.basename(files[0]["name"]))
        ds = xr.open_dataset(first, decode_times=False)
        mask = ds["Mask"].values
        lat, lon = goes_lat_lon(ds)
        is_fire = np.isin(mask, FIRE_CODES)
        ca = in_california(lat, lon)
        n_ca = int((is_fire & ca).sum())
        print(f"    file: {os.path.basename(first)}")
        print(f"    Mask variable: shape {mask.shape}, dtype {mask.dtype}, "
              f"long_name '{ds['Mask'].attrs.get('long_name')}'")
        print(f"    scan start {ds.attrs['time_coverage_start']}  |  fire pixels in all of CONUS: "
              f"{int(is_fire.sum())}, inside California: {n_ca}")
        codes, counts = np.unique(mask[is_fire & ca], return_counts=True)
        print(f"    California fire codes: {dict(zip(codes.tolist(), counts.tolist()))}")
        notes.append(f"{bucket}: {n_ca} CA fire px, 1 h = {mb:.1f} MB in {secs:.0f}s")
        ds.close()
    with open(os.path.join(SAMPLES, "goes_timing.json"), "w") as f:
        json.dump(notes, f, indent=1)
    record("3a GOES ABI-L2-FDCC (AWS)", True, "; ".join(notes))


# ---------------------------------------------------------------------------
# 3b. NASA FIRMS - VIIRS fire points for California, one day
# ---------------------------------------------------------------------------
def check_firms():
    key = os.environ["FIRMS_MAP_KEY"]
    bbox = "-124.5,32.5,-114.1,42.0"  # west,south,east,north around California
    # VIIRS_NOAA20_SP = NOAA-20 satellite, standard (science-quality) archive, April 2018 onward.
    # (We tried VIIRS_SNPP_SP first: it returned 0 rows for July 2024, so we use NOAA-20.)
    # "1" = one day starting on the date.
    url = f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/{key}/VIIRS_NOAA20_SP/{bbox}/1/2024-07-25"
    df = pd.read_csv(io.StringIO(net.get(url).text))
    df = df[in_california(df.latitude.values, df.longitude.values)]  # box -> real California shape
    df.to_csv(os.path.join(SAMPLES, "firms_viirs_2024-07-25.csv"), index=False)
    print(f"  {len(df)} VIIRS points in California on 2024-07-25 (Park Fire day 2)")
    print(f"  columns: {list(df.columns)}")
    print(f"  times: {df.acq_date.min()} {int(df.acq_time.min()):04d} to {df.acq_date.max()} {int(df.acq_time.max()):04d} UTC")
    print(f"  confidence counts: {df.confidence.value_counts().to_dict()}  (n=nominal, h=high, l=low)")
    print(df.head(3).to_string())
    record("3b NASA FIRMS VIIRS", len(df) > 0, f"{len(df)} points, {len(df.columns)} columns")


# ---------------------------------------------------------------------------
# 3c. Open-Meteo archive weather - one point, one day (no key)
# ---------------------------------------------------------------------------
def check_open_meteo():
    params = {
        "latitude": CHICO[0], "longitude": CHICO[1],
        "start_date": "2024-07-24", "end_date": "2024-07-24",
        "hourly": "wind_speed_10m,wind_direction_10m,wind_gusts_10m,relative_humidity_2m,temperature_2m",
        "wind_speed_unit": "kmh", "timezone": "GMT",
    }
    js = net.get("https://archive-api.open-meteo.com/v1/archive", params=params).json()
    df = pd.DataFrame(js["hourly"])
    df.to_csv(os.path.join(SAMPLES, "open_meteo_chico_2024-07-24.csv"), index=False)
    print(f"  {len(df)} hourly rows, columns {list(df.columns)}")
    print(f"  time range {df.time.iloc[0]} to {df.time.iloc[-1]} UTC")
    print(df.iloc[20:24].to_string(index=False))
    record("3c Open-Meteo archive", len(df) == 24 and df.notna().all().all(), f"{len(df)} hours x {len(df.columns)} cols")


# ---------------------------------------------------------------------------
# 3d. AWS Terrain Tiles - one "terrarium" PNG near Chico, decoded to metres
# ---------------------------------------------------------------------------
def lat_lon_to_tile(lat, lon, z):
    """Standard web-map tile numbers (x, y) for a point at zoom z."""
    n = 2 ** z
    x = int((lon + 180) / 360 * n)
    y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    return x, y


def check_terrain():
    from PIL import Image
    z = 12  # zoom 12 tile = about 7.5 km wide, ~30 m per pixel here
    x, y = lat_lon_to_tile(*CHICO, z)
    url = f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
    png = net.get(url).content
    with open(os.path.join(SAMPLES, f"terrarium_{z}_{x}_{y}.png"), "wb") as f:
        f.write(png)
    rgb = np.asarray(Image.open(io.BytesIO(png)).convert("RGB")).astype(float)
    # Terrarium encoding: height (m) = R*256 + G + B/256 - 32768
    elev = rgb[..., 0] * 256 + rgb[..., 1] + rgb[..., 2] / 256 - 32768
    print(f"  tile z{z}/{x}/{y}: {elev.shape} pixels, elevation {elev.min():.0f} to {elev.max():.0f} m, "
          f"mean {elev.mean():.0f} m")
    record("3d AWS Terrain Tiles", 0 < elev.mean() < 1500, f"{elev.min():.0f}-{elev.max():.0f} m near Chico")


# ---------------------------------------------------------------------------
# 3e. Vegetation - ESA WorldCover 10 m (2021), small box near Chico
# ---------------------------------------------------------------------------
WORLDCOVER_CLASSES = {10: "Tree cover", 20: "Shrubland", 30: "Grassland", 40: "Cropland", 50: "Built-up",
                      60: "Bare/sparse", 70: "Snow/ice", 80: "Water", 90: "Wetland", 95: "Mangroves",
                      100: "Moss/lichen"}


def check_vegetation():
    import rasterio
    from rasterio.windows import from_bounds
    # WorldCover is stored as 3x3 degree Cloud-Optimized GeoTIFFs named by their lower-left corner.
    # Chico (39.7N, 121.8W) is in tile N39W123. Cloud-Optimized = we can read just a small window.
    url = ("https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/"
           "ESA_WorldCover_10m_2021_v200_N39W123_Map.tif")
    t0 = time.time()
    with rasterio.open(url) as src:
        box = (-121.9, 39.7, -121.5, 39.9)  # west, south, east, north: Chico up to Paradise
        data = src.read(1, window=from_bounds(*box, src.transform))
    secs = time.time() - t0
    np.save(os.path.join(SAMPLES, "worldcover_chico_box.npy"), data)
    codes, counts = np.unique(data, return_counts=True)
    share = {WORLDCOVER_CLASSES.get(int(c), c): f"{100 * n / data.size:.0f}%" for c, n in zip(codes, counts)}
    print(f"  window {data.shape} pixels (10 m) read in {secs:.1f} s")
    print(f"  land cover share: {share}")
    record("3e Vegetation (ESA WorldCover)", data.size > 0, f"{data.shape} px in {secs:.0f}s")


# ---------------------------------------------------------------------------
# 3f. Towns + population for Butte County
# ---------------------------------------------------------------------------
BUTTE_BOX = (39.29, -122.07, 40.16, -121.07)  # south, west, north, east (approx. county box)


def check_towns():
    raw = os.path.join(ROOT, "data", "raw")
    # (1) US Census Gazetteer: every Census "place" (cities + CDPs) with its centre point. No key.
    gaz_path = os.path.join(raw, "2024_gaz_place_06.txt")
    if not os.path.exists(gaz_path):
        url = "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_gaz_place_06.txt"
        with open(gaz_path, "wb") as f:
            f.write(net.get(url).content)
    gaz = pd.read_csv(gaz_path, sep="\t", dtype={"GEOID": str})
    gaz.columns = [c.strip() for c in gaz.columns]

    # (2) US Census population estimates (Vintage 2024) for incorporated cities/towns. No key.
    pop_path = os.path.join(raw, "sub-est2024.csv")
    if not os.path.exists(pop_path):
        url = "https://www2.census.gov/programs-surveys/popest/datasets/2020-2024/cities/totals/sub-est2024.csv"
        with open(pop_path, "wb") as f:
            f.write(net.get(url, timeout=300).content)
    pop = pd.read_csv(pop_path, encoding="latin-1", dtype=str)
    pop = pop[(pop.STATE == "06") & (pop.SUMLEV == "162")]  # 162 = an incorporated place in California
    pop["GEOID"] = "06" + pop.PLACE
    pop = pop[["GEOID", "POPESTIMATE2024"]]

    s, w, n, e = BUTTE_BOX
    towns = gaz[(gaz.INTPTLAT.between(s, n)) & (gaz.INTPTLONG.between(w, e))]
    towns = towns.merge(pop, on="GEOID", how="left")[["NAME", "INTPTLAT", "INTPTLONG", "POPESTIMATE2024"]]
    print(f"  Census places in Butte County box: {len(towns)} "
          f"({towns.POPESTIMATE2024.notna().sum()} incorporated with population)")
    print(towns.head(12).to_string(index=False))

    # (3) OpenStreetMap places via the Overpass API (extra small communities, some with population tags).
    osm_note = ""
    try:
        q = f'[out:json][timeout:60];node["place"~"city|town|village|hamlet"]({s},{w},{n},{e});out;'
        js = net.post("https://overpass-api.de/api/interpreter", data={"data": q}, tries=4, timeout=90).json()
        osm = pd.DataFrame([{"name": el["tags"].get("name"), "place": el["tags"]["place"],
                             "population": el["tags"].get("population"), "lat": el["lat"], "lon": el["lon"]}
                            for el in js["elements"]])
        osm.to_csv(os.path.join(SAMPLES, "osm_places_butte.csv"), index=False)
        print(f"  OpenStreetMap places: {len(osm)} ({osm.population.notna().sum()} with population tag)")
        osm_note = f", OSM {len(osm)} places"
    except Exception as ex:
        print(f"  OpenStreetMap Overpass FAILED ({type(ex).__name__}) - using Census places only")
        osm_note = ", OSM Overpass unreachable (Census used instead)"
    towns.to_csv(os.path.join(SAMPLES, "towns_butte.csv"), index=False)
    record("3f Towns + population", len(towns) > 10, f"Census {len(towns)} places{osm_note}")


# ---------------------------------------------------------------------------
# 3g. CAL FIRE incident list 2018-2025
# ---------------------------------------------------------------------------
def check_calfire():
    rows = []
    for year in range(2018, 2026):
        url = f"https://incidents.fire.ca.gov/umbraco/api/IncidentApi/List?inactive=true&year={year}"
        rows += net.get(url).json()
    df = pd.DataFrame(rows)
    df = df[["Name", "Started", "County", "Location", "AcresBurned", "Latitude", "Longitude",
             "AdminUnit", "Type", "CalFireIncident", "UniqueId", "Url"]]
    df.to_csv(os.path.join(ROOT, "data", "raw", "calfire_incidents_2018_2025.csv"), index=False)
    started = pd.to_datetime(df.Started, utc=True, errors="coerce")
    print(f"  {len(df)} incidents, columns {list(df.columns)}")
    print(f"  start times {started[started.dt.year >= 2018].min()} to {started.max()}")
    print(df.sort_values("AcresBurned", ascending=False).head(5)[["Name", "Started", "AcresBurned"]].to_string(index=False))
    record("3g CAL FIRE incidents", len(df) > 1000, f"{len(df)} incidents 2018-2025 saved")


# ---------------------------------------------------------------------------
if __name__ == "__main__":
    for name, func in [("Key: FIRMS_MAP_KEY", check_firms_key), ("Key: GEMINI_API_KEY", check_gemini_key),
                       ("Key: ANTHROPIC_API_KEY", check_anthropic_key),
                       ("3a GOES ABI-L2-FDCC (AWS)", check_goes), ("3b NASA FIRMS VIIRS", check_firms),
                       ("3c Open-Meteo archive", check_open_meteo), ("3d AWS Terrain Tiles", check_terrain),
                       ("3e Vegetation (ESA WorldCover)", check_vegetation),
                       ("3f Towns + population", check_towns), ("3g CAL FIRE incidents", check_calfire)]:
        run(name, func)

    print("\n================ CHECKLIST ================")
    for name, res in RESULTS.items():
        print(f"{res[:4]}  {name:34s} {res[6:]}")
    with open(os.path.join(ROOT, "results", "phase1_checklist.json"), "w") as f:
        json.dump(RESULTS, f, indent=1)
