"""
Makes app/static/california.geojson: the map shows California only.

  mask   the whole world minus California (drawn dark over everything outside the state)
  ca     the state border
  la     Los Angeles County (the demo highlights it)

Source: US Census Bureau 2024 cartographic boundary files (public domain), simplified to ~400 m.
  https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_us_state_5m.zip
  https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_us_county_5m.zip
Run:  python app/make_california.py cb_2024_us_state_5m.zip cb_2024_us_county_5m.zip   (needs pyshp + shapely)
"""

import json
import os
import sys

import shapefile
from shapely.geometry import box, mapping, shape


def load(path, keep):
    for sr in shapefile.Reader(path).iterShapeRecords():
        if keep(sr.record.as_dict()):
            return shape(sr.shape.__geo_interface__)
    raise SystemExit(f"not found in {path}")


def rounded(geom):
    gj = mapping(geom)

    def r(c):
        return [round(c[0], 4), round(c[1], 4)] if isinstance(c[0], (int, float)) else [r(x) for x in c]
    return {"type": gj["type"], "coordinates": r(gj["coordinates"])}


def main(states_zip, counties_zip):
    ca = load(states_zip, lambda d: d["STUSPS"] == "CA").simplify(0.004, preserve_topology=True)
    la = load(counties_zip, lambda d: d["STATEFP"] == "06" and d["NAME"] == "Los Angeles").simplify(0.003, preserve_topology=True)
    feats = [("mask", box(-180, -85, 180, 85).difference(ca)), ("ca", ca.boundary), ("la", la)]
    out = {"type": "FeatureCollection",
           "features": [{"type": "Feature", "properties": {"kind": k}, "geometry": rounded(g)} for k, g in feats]}
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static", "california.geojson")
    with open(path, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(path, os.path.getsize(path) // 1024, "KB")


if __name__ == "__main__":
    main(*sys.argv[1:3])
