"""
Map helpers: turn our 2 km squares (row, col on a fire's grid) into GeoJSON polygons the map can draw.

Every fire has its own 40 x 40 grid in EPSG:3310 (California Albers, metres). A square's corners are
exact in that projection; we convert them to longitude/latitude for the web map.
"""

import numpy as np

from .paths import grid

N = grid.N_CELLS
CELL = grid.CELL_M


def square_ring(xmin, ymax, r, c):
    """The 5-point outline (lon, lat) of square (r, c)."""
    x0, y0 = xmin + c * CELL, ymax - r * CELL
    xs = [x0, x0 + CELL, x0 + CELL, x0, x0]
    ys = [y0, y0, y0 - CELL, y0 - CELL, y0]
    lon, lat = grid.TO_LONLAT.transform(xs, ys)
    return [[round(a, 5), round(b, 5)] for a, b in zip(lon, lat)]


def squares_fc(xmin, ymax, cells, props=None):
    """
    GeoJSON FeatureCollection of squares. cells = list of (r, c) or (r, c, value).
    props(cell) -> dict of extra properties (optional). Each feature gets id = r*40 + c.
    """
    feats = []
    for cell in cells:
        r, c = int(cell[0]), int(cell[1])
        p = {"row": r, "col": c}
        if len(cell) > 2:
            p["p"] = round(float(cell[2]), 3)
        if props:
            p.update(props(cell))
        feats.append({"type": "Feature", "id": r * N + c, "properties": p,
                      "geometry": {"type": "Polygon", "coordinates": [square_ring(xmin, ymax, r, c)]}})
    return {"type": "FeatureCollection", "features": feats}


def outline_fc(xmin, ymax, mask, props=None):
    """
    The OUTER EDGE of a set of squares as GeoJSON lines (one line per square side that touches the outside).
    Good for drawing forecast rings and the baseline without filling them.
    """
    mask = np.asarray(mask, bool)
    lines = []
    for r, c in np.argwhere(mask):
        x0, y0 = xmin + c * CELL, ymax - r * CELL
        sides = []
        if r == 0 or not mask[r - 1, c]:
            sides.append(((x0, y0), (x0 + CELL, y0)))                 # north
        if r == N - 1 or not mask[r + 1, c]:
            sides.append(((x0, y0 - CELL), (x0 + CELL, y0 - CELL)))   # south
        if c == 0 or not mask[r, c - 1]:
            sides.append(((x0, y0), (x0, y0 - CELL)))                 # west
        if c == N - 1 or not mask[r, c + 1]:
            sides.append(((x0 + CELL, y0), (x0 + CELL, y0 - CELL)))   # east
        for (ax, ay), (bx, by) in sides:
            lon, lat = grid.TO_LONLAT.transform([ax, bx], [ay, by])
            lines.append([[round(lon[0], 5), round(lat[0], 5)], [round(lon[1], 5), round(lat[1], 5)]])
    geom = {"type": "MultiLineString", "coordinates": lines}
    return {"type": "FeatureCollection",
            "features": [{"type": "Feature", "properties": props or {}, "geometry": geom}] if lines else []}


def box_bounds(xmin, ymax):
    """[west, south, east, north] of the whole 80 km box, for fitting the map view."""
    xs = [xmin, xmin + N * CELL]
    ys = [ymax - N * CELL, ymax]
    lon, lat = grid.TO_LONLAT.transform([xs[0], xs[1], xs[0], xs[1]], [ys[0], ys[0], ys[1], ys[1]])
    return [round(min(lon), 4), round(min(lat), 4), round(max(lon), 4), round(max(lat), 4)]


def cell_of_lonlat(xmin, ymax, lon, lat):
    """(row, col) of the square holding a lon/lat point, or (-1, -1) outside the box."""
    x, y = grid.TO_ALBERS.transform(lon, lat)
    r, c = grid.cell_of(np.atleast_1d(x), np.atleast_1d(y), xmin, ymax)
    return int(r[0]), int(c[0])
