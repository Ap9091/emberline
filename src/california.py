"""
A simple outline of California, used to keep only fire pixels inside the state.

The outline is hand-drawn from about 30 border/coast points, so it is approximate
(roughly 5-10 km accuracy). Good enough for "is this fire in California?",
not for anything legal. For the real border use the US Census state boundary file.
"""

import numpy as np
from matplotlib.path import Path

# (longitude, latitude) points going around California clockwise from the north-west corner.
CA_OUTLINE = [
    (-124.21, 42.00), (-120.00, 42.00),             # Oregon border
    (-120.00, 39.00),                               # down the Nevada border to Lake Tahoe
    (-114.63, 35.00),                               # diagonal border to the Colorado River
    (-114.57, 34.80), (-114.13, 34.27), (-114.43, 34.08), (-114.53, 33.03),
    (-114.72, 32.72),                               # Colorado River (Arizona border)
    (-117.12, 32.53),                               # Mexico border
    (-117.25, 32.90), (-117.60, 33.40), (-118.10, 33.75), (-118.50, 34.00),
    (-119.20, 34.15), (-120.00, 34.40), (-120.62, 34.55), (-120.65, 35.20),
    (-121.30, 35.70), (-121.90, 36.30), (-122.00, 36.95), (-122.50, 37.50),
    (-122.52, 37.80), (-123.00, 38.00), (-123.70, 38.90), (-123.85, 39.80),
    (-124.40, 40.40), (-124.10, 41.00), (-124.21, 42.00),  # Pacific coast back to the start
]
_PATH = Path(CA_OUTLINE)


def in_california(lat, lon):
    """True where the point(s) fall inside the outline. Works on single numbers or arrays."""
    lat = np.asarray(lat, dtype=float)
    lon = np.asarray(lon, dtype=float)
    pts = np.column_stack([lon.ravel(), lat.ravel()])
    ok = np.isfinite(pts).all(axis=1)
    inside = np.zeros(len(pts), dtype=bool)
    inside[ok] = _PATH.contains_points(pts[ok])
    return inside.reshape(lat.shape)
