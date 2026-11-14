"""
Builds the HOSTED version of Emberline into site/: the same app, with the API answers saved as files.

A hosted page (for example a claude.ai artifact or GitHub Pages) has no Python server, and it may not load
map tiles or call AI services on other sites. So this script:
  1. copies app/static/ (the app) and writes an index page that switches the app to "hosted mode"
  2. saves every API answer the demo uses as JSON files in site/data/ (replay hours, archive days, incidents,
     results) - the app's api.js reads these files instead of calling /api/... in hosted mode
  3. saves the AI answers that were already generated (data/ai_cache) - hosted mode replays them
  4. renders a relief basemap image for each fire area and for California from the AWS terrain tiles,
     and clips the Census highways for each area (map tiles from other sites are blocked on hosted pages)
  5. saves the inputs and the logistic-regression model that the in-browser "what if the wind changes?" uses

Run:  cd app && ../.venv/bin/python build_site.py
"""

import io
import json
import math
import os
import re
import shutil
import sys

import numpy as np
import pandas as pd
from PIL import Image

from backend import ai, copilot, live, store
from backend import roads as R
from backend import situation as S
from backend import server
from backend.paths import ROOT, STATIC_DIR, grid

import net

OUT = os.path.join(ROOT, "site")
DATA = os.path.join(OUT, "data")
TILE_DIR = os.path.join(ROOT, "data", "raw", "terrain_tiles")


def write(rel, obj):
    path = os.path.join(DATA, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f, separators=(",", ":"), default=str)
    return os.path.getsize(path)


def slug(s):
    """A file-name-safe version of an archive time or incident id."""
    return re.sub(r"[^A-Za-z0-9_-]+", "_", s)


# ---------------------------------------------------------------------------
# AI: replay the cache only (no new AI calls while building)
# ---------------------------------------------------------------------------
def _cache_only(*_a, **_k):
    raise RuntimeError("cache only")


ai._call_gemini = _cache_only
ai._call_claude = _cache_only
ai.time.sleep = lambda s: None          # no waiting between "retries" of a cache miss


def ai_try(fn, *args):
    try:
        out = fn(*args)
        if isinstance(out, dict) and out.get("status") == "AI_OFFLINE":
            return None
        return out
    except ai.AIOffline:
        return None


def copilot_for(sit):
    """Briefing, plan (with the safety check) and the alert for the plan, if they are in the cache."""
    rec = {}
    b = ai_try(copilot.briefing, sit)
    if b:
        rec["briefing"] = b
    p = ai_try(copilot.plan, sit)
    if p:
        rec["plan"] = p
        if p["status"] == "ACCEPTED":
            a = ai_try(copilot.alert, sit, p["plan"])
            if a:
                rec["alert"] = a
    return rec


# ---------------------------------------------------------------------------
# Basemap images: shaded relief from the AWS terrain tiles (Web Mercator, so they line up exactly)
# ---------------------------------------------------------------------------
def tile_xy(lon, lat, z):
    n = 2 ** z
    x = (lon + 180) / 360 * n
    y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    return x, y


def tile_lonlat(x, y, z):
    n = 2 ** z
    lon = x / n * 360 - 180
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    return lon, lat


def terrain_tile(z, x, y):
    path = os.path.join(TILE_DIR, f"{z}_{x}_{y}.png")
    if not os.path.exists(path):
        os.makedirs(TILE_DIR, exist_ok=True)
        png = net.get(f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png", timeout=60).content
        with open(path, "wb") as f:
            f.write(png)
    rgb = np.asarray(Image.open(path).convert("RGB")).astype(float)
    return rgb[..., 0] * 256 + rgb[..., 1] + rgb[..., 2] / 256 - 32768


def relief(bounds, z, name, margin_deg=0.12):
    """Render a shaded-relief JPEG covering bounds [w, s, e, n]; returns the MapLibre image-source entry."""
    w, s, e, n = bounds
    x0, y0 = tile_xy(w - margin_deg, n + margin_deg, z)
    x1, y1 = tile_xy(e + margin_deg, s - margin_deg, z)
    xs, ys = range(int(x0), int(x1) + 1), range(int(y0), int(y1) + 1)
    elev = np.vstack([np.hstack([terrain_tile(z, x, y) for x in xs]) for y in ys])
    land = elev > 0.5
    elev = np.where(elev < -100, 0, elev)
    # metres per pixel at this latitude and zoom
    lat_c = (s + n) / 2
    m_px = 156543.03 * math.cos(math.radians(lat_c)) / 2 ** z
    gy, gx = np.gradient(elev, m_px)
    slope = np.arctan(np.hypot(gx, gy) * 1.6)
    aspect = np.arctan2(-gx, gy)
    az, alt = math.radians(315), math.radians(42)
    shade = np.clip(np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect), 0, 1)
    # earthy colour by elevation (valley paper -> foothill khaki -> mountain stone), then shade
    t = np.clip(elev / 2400, 0, 1)[..., None]
    low, mid, high = np.array([228, 222, 206]), np.array([206, 196, 172]), np.array([188, 182, 170])
    base = np.where(t < 0.35, low + (mid - low) * (t / 0.35), mid + (high - mid) * ((t - 0.35) / 0.65))
    rgb = base * (0.62 + 0.45 * shade[..., None])
    water = np.array([178, 194, 200])
    rgb = np.where(land[..., None], rgb, water)
    img = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8))
    path = os.path.join(OUT, "basemap", f"{name}.jpg")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, quality=80, optimize=True, progressive=True)
    lw, ln = tile_lonlat(xs[0], ys[0], z)
    le, ls = tile_lonlat(xs[-1] + 1, ys[-1] + 1, z)
    return {"id": name, "url": f"basemap/{name}.jpg",
            "coordinates": [[round(lw, 5), round(ln, 5)], [round(le, 5), round(ln, 5)],
                            [round(le, 5), round(ls, 5)], [round(lw, 5), round(ls, 5)]],
            "kb": os.path.getsize(path) // 1024}


def roads_geojson(boxes, margin_m=15000):
    """Census TIGER highways inside the given EPSG:3310 boxes, as one GeoJSON (every 2nd point, enough at this scale)."""
    parts, bb = R._roads()
    keep = set()
    for (xmin, ymin, xmax, ymax) in boxes:
        hit = ((bb[:, 0] <= xmax + margin_m) & (bb[:, 2] >= xmin - margin_m) &
               (bb[:, 1] <= ymax + margin_m) & (bb[:, 3] >= ymin - margin_m))
        keep |= set(np.nonzero(hit)[0].tolist())
    feats = []
    for i in sorted(keep):
        name, x, y = parts[i]
        step = 2 if len(x) > 6 else 1
        xs, ys = np.r_[x[::step], x[-1]], np.r_[y[::step], y[-1]]
        lon, lat = grid.TO_LONLAT.transform(xs, ys)
        numbered = name.startswith(("I-", "US Hwy", "State Hwy", "State Rte"))
        feats.append({"type": "Feature", "properties": {"name": name, "major": numbered},
                      "geometry": {"type": "LineString", "coordinates": [[round(a, 4), round(b, 4)] for a, b in zip(lon, lat)]}})
    return {"type": "FeatureCollection", "features": feats}


# ---------------------------------------------------------------------------
def main():
    if os.path.exists(OUT):
        shutil.rmtree(OUT)
    shutil.copytree(STATIC_DIR, OUT, ignore=shutil.ignore_patterns("index.html", "fonts"))
    build_data()
    write_pages()
    write_vercel_api()


def write_vercel_api():
    """The 'Ask Emberline' assistant on Vercel: site/api/chat.js (serverless function) + its knowledge + package.json.
    The API key is NOT here: it goes in Vercel's settings as the environment variable ANTHROPIC_API_KEY."""
    here = os.path.dirname(os.path.abspath(__file__))
    os.makedirs(os.path.join(OUT, "api"), exist_ok=True)
    shutil.copy2(os.path.join(here, "assistant", "chat_vercel.js"), os.path.join(OUT, "api", "chat.js"))
    with open(os.path.join(here, "assistant", "knowledge.md"), encoding="utf-8") as f:
        knowledge = f.read()
    with open(os.path.join(OUT, "api", "_knowledge.js"), "w", encoding="utf-8") as f:
        f.write("// Generated by app/build_site.py from app/assistant/knowledge.md - edit that file, not this one.\n"
                "export const KNOWLEDGE = " + json.dumps(knowledge, ensure_ascii=False) + ";\n")
    with open(os.path.join(OUT, "package.json"), "w") as f:
        json.dump({"name": "emberline-site", "private": True, "type": "module",
                   "dependencies": {"@anthropic-ai/sdk": "1.3.0"}}, f, indent=2)
        f.write("\n")
    with open(os.path.join(OUT, "vercel.json"), "w") as f:
        json.dump({"functions": {"api/chat.js": {"maxDuration": 30}}}, f, indent=2)
        f.write("\n")


def frontend_only():
    """Copy the changed app code (js, css, california outline) into site/ and rewrite the pages; keep site/data.
    No backend needed:  python app/build_site.py --frontend-only"""
    for name in os.listdir(STATIC_DIR):
        if name in ("index.html", "fonts", "vendor"):
            continue
        src, dst = os.path.join(STATIC_DIR, name), os.path.join(OUT, name)
        if os.path.isdir(src):
            shutil.rmtree(dst, ignore_errors=True)
            shutil.copytree(src, dst)
        else:
            shutil.copy2(src, dst)
    write_pages()
    write_vercel_api()


def build_data():
    sizes = {}

    # ── config + results ──
    cfg = server.config()
    cfg["static"] = True
    cfg["ai"] = {"provider": "Gemini", "model": "cached answers",
                 "note": "Hosted demo: the AI answers were generated earlier with Gemini and are replayed here. "
                         "Run the full app (app/run.sh) for new answers."}
    write("config.json", cfg)
    write("results.json", server.results())

    # ── replay ──
    boxes, ai_replay = [], {}
    write("replay/list.json", server.replay_list())
    for fid in store.REPLAY_FIRES:
        meta = S.replay_meta(fid)
        rp = store.replay(fid)
        g = rp["grid"]
        boxes.append((fid, (g["xmin"], g["ymax"] - grid.N_CELLS * grid.CELL_M, g["xmin"] + grid.N_CELLS * grid.CELL_M, g["ymax"]), meta["bounds"]))
        ai_replay[fid] = {}
        total = 0
        for h in range(len(meta["hours"])):
            sit = S.replay_situation(fid, h)
            total += write(f"replay/{fid}/{h}.json", S.public(sit))
            if meta["hours"][h]["has_forecast"]:
                rec = copilot_for(sit)
                if rec:
                    ai_replay[fid][h] = rec
        meta["ai_hours"] = sorted(ai_replay[fid])
        write(f"replay/{fid}/meta.json", meta)
        write(f"ai/replay_{fid}.json", ai_replay[fid])
        sizes[fid] = total // 1024
        print(f"{fid}: {len(meta['hours'])} hours, {total // 1024} KB, copilot cached for {len(ai_replay[fid])} hours", flush=True)

    # ── archive days (STATE) + their incidents ──
    # Archive days and their incidents come from the RUNNING server (app/run.sh): it already holds them,
    # and asking it avoids downloading the satellite scans and weather again.
    import requests
    api = "http://localhost:8000/api"
    states, ai_inc, triage = {}, {}, {}
    for ex in cfg["archive_examples"]:
        st = requests.get(f"{api}/state", params={"at": ex["at"]}, timeout=900).json()
        write(f"state/{slug(ex['at'])}.json", st)
        for inc in st["incidents"]:
            r = requests.get(f"{api}/incident/{inc['id']}", timeout=900)
            if r.status_code != 200:
                print("   skipped incident", inc["id"], r.status_code, flush=True)
                continue
            sit = r.json()
            write(f"incident/{slug(inc['id'])}.json", sit)
            boxes.append((inc["id"], tuple(grid.grid_box(inc["lat"], inc["lon"])), sit["bounds"]))
            rec = copilot_for(sit)
            if rec:
                ai_inc[inc["id"]] = rec
            summary = {k: inc[k] for k in ("rank", "area_km2", "growth_km2_last_hour", "nearest_town", "nearest_town_km",
                                           "people_10km", "wind", "wind_toward_towns", "triage_score") if k in inc}
            t = ai_try(copilot.triage_line, summary)          # same question as the server's /api/ai/triage
            if t:
                triage[inc["id"]] = t
        print(f"archive {ex['label']}: {len(st['incidents'])} incidents", flush=True)
    write("ai/incidents.json", ai_inc)
    write("ai/triage.json", triage)
    # live: a snapshot of the latest scan when the site was built (hosted pages cannot download GOES data)
    now = requests.get(f"{api}/state", timeout=300).json()
    now["static_snapshot"] = True
    write("state/live.json", now)

    # ── basemaps + highways ──
    images, seen = [relief([-124.6, 32.3, -113.9, 42.2], 7, "california", margin_deg=0.3)], []
    for key, box, bounds in boxes:
        c = ((bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2)
        if any(abs(c[0] - o[0]) < 0.25 and abs(c[1] - o[1]) < 0.25 for o in seen):
            continue                                   # an image for (almost) the same area already exists
        seen.append(c)
        images.append(relief(bounds, 11, slug(key)))
    write("basemaps.json", images)
    print("basemap images:", len(images), "total KB", sum(i["kb"] for i in images), flush=True)
    write("roads.geojson", roads_geojson([b for _, b, _ in boxes]))

    # ── in-browser what-if: model + per-fire inputs ──
    import whatif_export
    whatif_export.export(DATA, [fid for fid in store.REPLAY_FIRES])


def write_pages():
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "site_index.html")) as f:
        page = f.read()
    # claude.ai page: the host adds <html>/<head>, and outside map tiles are blocked
    with open(os.path.join(OUT, "claude.html"), "w") as f:
        f.write(page)
    # ordinary web host (Vercel, GitHub Pages): a full HTML document, online map tiles + 3D allowed
    full = ("<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n"
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n"
            + page.split("<div id=\"app\"")[0] + "</head>\n<body>\n<div id=\"app\"" + page.split("<div id=\"app\"", 1)[1]
            .replace("window.EMBERLINE_STATIC = true;", "window.EMBERLINE_STATIC = true; window.EMBERLINE_TILES = true;")
            + "</body>\n</html>\n")
    with open(os.path.join(OUT, "index.html"), "w") as f:
        f.write(full)
    n_files = sum(len(fs) for _, _, fs in os.walk(OUT))
    mb = sum(os.path.getsize(os.path.join(d, x)) for d, _, fs in os.walk(OUT) for x in fs) / 1e6
    print(f"site/: {n_files} files, {mb:.1f} MB", flush=True)


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    frontend_only() if "--frontend-only" in sys.argv else main()
