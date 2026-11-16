"""
Emberline - Phase 3 building blocks (used by notebooks/03_train.ipynb).

The notebook tells the story step by step; the longer code lives here so the notebook stays readable.

What is in this file
  1. Preparing the table for the models (one-hot vegetation, feature list).
  2. The models: logistic regression, gradient-boosted trees, their average, and a "direct" version
     (one tree model per forecast hour).
  3. Rolling a forecast forward to +2 h and +3 h (use the +1 h guess as the new fire, predict again).
  4. The baselines ("looks like now", "grow 1 km every hour").
  5. Scoring: squares (strict and within 2 km), newly burning squares, fire-area IoU, and TOWN warnings.

Two probability cut-offs per model (both chosen on validation fires only):
  * "burn": for squares that have already burned  -> does the fire keep burning there?
  * "new":  for squares that never burned yet     -> does the fire spread there?
  New spread is rarer, so its best cut-off is much lower. One cut-off for both would hide all new spread.
"""

import os
import sys

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import grid                      # noqa: E402  the shared 2 km grid
import p2_build_dataset as p2    # noqa: E402  the Phase 2 feature code (we reuse it for the rollout)

ROOT = grid.ROOT
N = grid.N_CELLS                 # 40 squares across
CELL_KM = grid.CELL_M / 1000     # 2 km
TOWN_NEAR_KM = 1.0               # a town is "reached" if fire is within 1 km of it
HORIZON = 3                      # we forecast 1, 2 and 3 hours ahead

# ---------------------------------------------------------------------------
# 1. Features
# ---------------------------------------------------------------------------
VEG_CODES = [10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100]   # ESA WorldCover classes
NUMERIC = [f for f in p2.FEATURES if f != "veg_class"]       # 28 number features
WIND_FEATURES = ["wind_speed_kmh", "wind_gust_kmh", "downwind", "downwind_x_speed"]
TERRAIN_FEATURES = ["elevation_diff_m", "upslope", "slope_deg", "elevation_m"]


def make_X(df, drop=()):
    """Model input: the 28 number features + vegetation as 0/1 columns (one-hot). `drop` removes features."""
    X = df[[c for c in NUMERIC if c not in drop]].astype("float32").copy()
    if "veg_class" not in drop:
        veg = df["veg_class"].astype(int).to_numpy()
        for code in VEG_CODES:
            X[f"veg_{code}"] = (veg == code).astype("float32")
    return X


def training_rows(d, k=1):
    """Rows we learn from / score on for the k-hour label: label known, and not a gap-filled (guessed) label."""
    ok = d[f"label_{k}h"].notna() & ~d[f"label_{k}h_gapfilled"].astype(bool) & ~d[f"hour_gapfilled_{k}h"].astype(bool)
    return d[ok]


# ---------------------------------------------------------------------------
# 2. Models
# ---------------------------------------------------------------------------
def make_logreg(C):
    """Logistic regression. Missing values -> median, then scale (both learned on train only, inside the pipeline)."""
    return make_pipeline(SimpleImputer(strategy="median"), StandardScaler(),
                         LogisticRegression(C=C, class_weight="balanced", max_iter=3000))


def make_hgb(learning_rate, max_depth, max_iter):
    """Gradient-boosted trees. They handle missing values by themselves."""
    return HistGradientBoostingClassifier(learning_rate=learning_rate, max_depth=max_depth, max_iter=max_iter,
                                          class_weight="balanced", early_stopping=False, random_state=0)


class Model:
    """A fitted model plus the feature list it needs, with one simple method: probability of burning in 1 h."""
    direct = False

    def __init__(self, name, fitted, drop=()):
        self.name, self.fitted, self.drop = name, fitted, tuple(drop)

    def prob(self, df):
        return self.fitted.predict_proba(make_X(df, self.drop))[:, 1]


class Average:
    """The average of two models' probabilities."""
    direct = False

    def __init__(self, name, a, b):
        self.name, self.a, self.b = name, a, b

    def prob(self, df):
        return (self.a.prob(df) + self.b.prob(df)) / 2


class Direct:
    """
    'Direct' forecast: three separate tree models, trained to answer "burning in 1 h?", "in 2 h?", "in 3 h?"
    straight from what we know now (no rolling forward). prob() = the 1-hour model, so it can be scored like the others.
    """
    direct = True

    def __init__(self, name, fitted_by_k):
        self.name, self.models = name, fitted_by_k            # {1: model, 2: model, 3: model}

    def prob(self, df, k=1):
        return self.models[k].predict_proba(make_X(df))[:, 1]


def fit_direct(train, lrate, depth, n_trees, name="hgb_direct"):
    """Train one tree model per forecast hour (k = 1, 2, 3) with the same settings."""
    fitted = {}
    for k in (1, 2, 3):
        d = training_rows(train, k)
        fitted[k] = make_hgb(lrate, depth, n_trees).fit(make_X(d), d[f"label_{k}h"].astype(int))
    return Direct(name, fitted)


# ---------------------------------------------------------------------------
# 3. One fire, its truth, and the forecasts
# ---------------------------------------------------------------------------
class Fire:
    """Everything about one fire that the forecast and the scoring need."""

    def __init__(self, fire_id):
        self.fire_id = fire_id
        self.burning, self.hours, self.static, self.weather = p2.load_fire(fire_id)
        self.has_data = (self.hours.set_index("hour_idx").n_files > 0).reindex(range(grid.N_HOURS), fill_value=False).to_numpy()
        gap_hour = self.hours.set_index("hour_idx").hour_gapfilled.reindex(range(grid.N_HOURS), fill_value=False)
        self.truth_ok = self.has_data & ~gap_hour.astype(bool).to_numpy()   # hours whose truth we trust
        # truth[h] = squares burning at hour h (this is what the labels are made from)
        self.truth = np.zeros((grid.N_HOURS, N, N), bool)
        self.truth[self.burning.hour_idx, self.burning.row, self.burning.col] = True

    def known(self, h):
        """Burning rows we could have had at hour h (no future, no gap-filled guess for hour h itself)."""
        return p2.known_at_hour(self.burning, h)

    def now_and_ever(self, h):
        k = self.known(h)
        now = np.zeros((N, N), bool)
        ever = np.zeros((N, N), bool)
        seen = k[k.hour_idx == h]
        now[seen.row, seen.col] = True
        ever[k.row, k.col] = True
        return now, ever


# A square that is almost all water (the sea, a lake or a reservoir) cannot burn, so the forecast gives it no chance.
# Without this the model, which mostly follows the wind and the nearby fire, can push a coastal fire out over the
# sea. Of 82,556 burning squares the satellite saw in all 70 fires, 28 were 90%+ water (lake shores in two 2018-2020
# fires) and none in the 18 test fires, so this only removes forecast squares that could never burn.
WATER_MAX = 0.9


def no_water(probs, feats):
    """Probabilities with every square that is at least WATER_MAX water set to 0."""
    probs = np.array(probs, dtype=np.float32)
    probs[feats.frac_water.fillna(0).to_numpy() >= WATER_MAX] = 0
    return probs


def as_fire(probs, ever, th):
    """Turn probabilities into 'the fire': burned squares need the 'burn' cut-off, never-burned squares the 'new' one."""
    return np.where(ever, probs >= th["burn"], probs >= th["new"])


def forecast(model, fire, h, th):
    """
    Forecast for hours h+1, h+2, h+3 made at hour h: array (3, 40, 40) of probabilities, or None if hour h has no
    usable data.

    Direct model: features at hour h -> each of the three hour-models.
    Rolling forward (all other models):
      Step 1: features at hour h -> probability each candidate square burns at h+1.
      Step 2: turn that into "the fire at h+1" (two cut-offs, see as_fire), recompute the features from that
              imagined fire and predict h+2. Step 3 is the same again for h+3.
    Squares that are almost all water never burn (see WATER_MAX).
    Honest note: for h+2 and h+3 we use the weather that really happened (a stand-in for a weather forecast).
    Everything about the FIRE after hour h is the model's own guess.
    """
    feats = p2.features_for_hour(fire.burning, fire.hours, fire.static, fire.weather, h)
    if feats is None:
        return None
    out = np.zeros((HORIZON, N, N), np.float32)
    r_idx, c_idx = feats.row.to_numpy(), feats.col.to_numpy()
    if model.direct:
        for k in range(1, HORIZON + 1):
            out[k - 1, r_idx, c_idx] = no_water(model.prob(feats, k), feats)
        return out
    burning = fire.known(h)
    _, ever = fire.now_and_ever(h)
    hours = fire.hours.copy()
    pw = burning[burning.hour_idx == h].max_power_mw.dropna()
    power = float(pw.mean()) if len(pw) else np.nan       # imagined squares get today's average fire power
    for k in range(1, HORIZON + 1):
        out[k - 1, feats.row.to_numpy(), feats.col.to_numpy()] = no_water(model.prob(feats), feats)
        if k == HORIZON or h + k >= grid.N_HOURS:
            break
        pred = as_fire(out[k - 1], ever, th)
        if not pred.any():
            break                                         # the model thinks the fire goes out: nothing more to roll
        ever = ever | pred
        r, c = np.nonzero(pred)
        guess = pd.DataFrame({"hour_idx": h + k, "row": r, "col": c, "n_scans": 1,
                              "max_power_mw": power, "gapfilled": False})
        burning = pd.concat([burning[burning.hour_idx < h + k], guess], ignore_index=True)
        hours.loc[hours.hour_idx == h + k, "n_files"] = 1  # pretend the imagined hour has data
        feats = p2.features_for_hour(burning, hours, fire.static, fire.weather, h + k)
        if feats is None:
            break
    return out


def grow_baseline(now, km_per_hour=1.0):
    """'Grow 1 km every hour': after k hours, a square burns if its edge is within k km of a burning square's edge."""
    out = np.zeros((HORIZON, N, N), bool)
    if not now.any():
        return out
    rows, cols = np.meshgrid(np.arange(N), np.arange(N), indexing="ij")
    br, bc = np.nonzero(now)
    gap_r = np.maximum(np.abs(rows[..., None] - br) - 1, 0)   # whole squares between the two squares (rows)
    gap_c = np.maximum(np.abs(cols[..., None] - bc) - 1, 0)
    edge_km = (np.hypot(gap_r, gap_c) * CELL_KM).min(axis=2)
    for k in range(1, HORIZON + 1):
        out[k - 1] = edge_km <= km_per_hour * k
    return out


BASELINE_TH = {"burn": 0.5, "new": 0.5}     # the baselines give 0 or 1, so any cut-off in between works


# ---------------------------------------------------------------------------
# 4. Run every forecast for a set of fires and keep everything needed for scoring
# ---------------------------------------------------------------------------
def collect(fire_ids, models, th):
    """
    For every fire and every hour with data and fire: the forecasts of each model and baseline,
    the truth 1-3 h later, and which truths we can trust. th = {model name: {"burn": x, "new": y}}.
    """
    keys = {"fire_id": [], "hour": [], "is_night": [], "now": [], "ever": [], "truth": [], "truth_ok": []}
    preds = {m.name: [] for m in models}
    preds["persistence"], preds["grow_1km"] = [], []
    fires = {}
    for fid in fire_ids:
        fire = Fire(fid)
        fires[fid] = fire
        for h in range(grid.N_HOURS - 1):
            now, ever = fire.now_and_ever(h)
            if not fire.has_data[h] or not now.any():
                continue
            outs = {m.name: forecast(m, fire, h, th[m.name]) for m in models}
            if any(o is None for o in outs.values()):
                continue
            for name, o in outs.items():
                preds[name].append(o)
            preds["persistence"].append(np.repeat(now[None], HORIZON, axis=0).astype(np.float32))
            preds["grow_1km"].append(grow_baseline(now).astype(np.float32))
            hk = [min(h + k, grid.N_HOURS - 1) for k in range(1, HORIZON + 1)]
            keys["fire_id"].append(fid)
            keys["hour"].append(h)
            local = fire.hours.set_index("hour_idx").time_utc[h].tz_convert("America/Los_Angeles").hour
            keys["is_night"].append(local < 6 or local >= 20)
            keys["now"].append(now)
            keys["ever"].append(ever)
            keys["truth"].append(fire.truth[hk])
            keys["truth_ok"].append(np.array([h + k < grid.N_HOURS and fire.truth_ok[h + k] for k in range(1, HORIZON + 1)]))
    res = {k: np.array(v) for k, v in keys.items()}
    res["pred"] = {k: (np.stack(v) if v else np.zeros((0, HORIZON, N, N), np.float32)) for k, v in preds.items()}
    res["fires"] = fires
    return res


def merge(results):
    """Join several collect() results into one (e.g. held-out training fires + validation fires)."""
    out = {k: np.concatenate([r[k] for r in results]) for k in results[0] if k not in ("pred", "fires")}
    out["pred"] = {m: np.concatenate([r["pred"][m] for r in results]) for m in results[0]["pred"]}
    out["fires"] = {f: fire for r in results for f, fire in r["fires"].items()}
    return out


# ---------------------------------------------------------------------------
# 5. Scoring
# ---------------------------------------------------------------------------
def _dilate_2km(a):
    """Squares within 2 km (centre to centre) of a True square: the square itself + its 4 side neighbours."""
    out = a.copy()
    out[..., 1:, :] |= a[..., :-1, :]
    out[..., :-1, :] |= a[..., 1:, :]
    out[..., :, 1:] |= a[..., :, :-1]
    out[..., :, :-1] |= a[..., :, 1:]
    return out


def _prf(tp_p, n_p, tp_r, n_r):
    p = tp_p / n_p if n_p else np.nan
    r = tp_r / n_r if n_r else np.nan
    f = 2 * p * r / (p + r) if (n_p and n_r and (p + r) > 0) else 0.0
    return p, r, f


def square_scores(res, name, th, k=1, mask=None):
    """
    Precision / recall / F1 on squares k hours ahead, four ways:
      all_strict, all_2km  : every burning square (the 2 km version forgives being one square off)
      new_strict, new_2km  : only NEWLY burning squares (never burned before) - the hard, useful part
    plus mean IoU (overlap) of the forecast fire area with the real fire area.
    th = {"burn": x, "new": y} (see as_fire).
    """
    ok = res["truth_ok"][:, k - 1]
    if mask is not None:
        ok = ok & mask
    ever = res["ever"][ok]
    P = as_fire(res["pred"][name][ok, k - 1], ever, th)
    A = res["truth"][ok, k - 1]
    out = {}
    for label, p, a in [("all", P, A), ("new", P & ~ever, A & ~ever)]:
        out[f"{label}_strict"] = _prf((p & a).sum(), p.sum(), (p & a).sum(), a.sum())
        out[f"{label}_2km"] = _prf((p & _dilate_2km(a)).sum(), p.sum(), (a & _dilate_2km(p)).sum(), a.sum())
    inter = (P & A).sum(axis=(1, 2))
    union = (P | A).sum(axis=(1, 2))
    out["iou"] = float(np.mean(inter[union > 0] / union[union > 0])) if (union > 0).any() else np.nan
    out["cases"] = int(ok.sum())
    return out


def choose_thresholds(res, name, k=1):
    """
    On VALIDATION forecasts: the 'new' cut-off with the best F1 on newly burning squares, then the 'burn' cut-off
    with the best F1 on all squares (given that 'new' cut-off).
    """
    grid_t = np.round(np.arange(0.025, 0.976, 0.025), 3)
    best_new = max(grid_t, key=lambda t: square_scores(res, name, {"burn": 0.5, "new": t}, k)["new_strict"][2])
    best_burn = max(grid_t, key=lambda t: square_scores(res, name, {"burn": t, "new": best_new}, k)["all_strict"][2])
    return {"burn": float(best_burn), "new": float(best_new)}


# ---- towns ---------------------------------------------------------------
def town_squares(fire, towns):
    """For one fire: the towns in its box, and for each the squares within 1 km of the town (n_towns x 40 x 40)."""
    w = grid.load_windows().set_index("fire_id").loc[fire.fire_id]
    pad = TOWN_NEAR_KM * 1000
    t = towns[(towns.x > w.xmin - pad) & (towns.x < w.xmax + pad) & (towns.y > w.ymin - pad) & (towns.y < w.ymax + pad)]
    t = t.reset_index(drop=True)
    # distance from the town point to the nearest point of each 2 km square (0 if the town is inside the square)
    sx = fire.static.x.to_numpy().reshape(N, N)
    sy = fire.static.y.to_numpy().reshape(N, N)
    half = grid.CELL_M / 2
    dx = np.maximum(np.abs(t.x.to_numpy()[:, None, None] - sx) - half, 0)
    dy = np.maximum(np.abs(t.y.to_numpy()[:, None, None] - sy) - half, 0)
    near = np.hypot(dx, dy) <= pad
    return t, near


def town_events(res, name, threshold, towns, fire_ids=None):
    """
    Town warnings for one model at one probability threshold.

    A town is REACHED at hour a when a square within 1 km of it burns at a, and none did at any earlier hour
    (first arrival). We count an arrival only if the fire was not there when the window started and
    at least one forecast was made in the 3 hours before.
    WARNED = some forecast made in the 3 hours before arrival flagged the town (probability >= threshold
    on a square within 1 km, at +1, +2 or +3 h). LEAD = hours between the first such warning and arrival.

    FALSE ALARM (town-hours) = a forecast at hour h flags a town that the fire does NOT reach in the next 3 h
    (only hours whose truth we can check). Also counted: distinct towns warned at least once but never reached.
    """
    fires = res["fires"]
    events, alarms = [], []
    for fid in (fire_ids or sorted(set(res["fire_id"]))):
        fire = fires[fid]
        t, near = town_squares(fire, towns)
        if len(t) == 0:
            continue
        sel = np.nonzero(res["fire_id"] == fid)[0]
        hours = res["hour"][sel]
        nf = near.astype(np.float32)
        flags = (res["pred"][name][sel] >= threshold)                       # cases x 3 x 40 x 40
        # flagged[c, town] = any square near the town forecast to burn in the next 3 h
        flagged = np.einsum("ckrs,trs->ct", flags.astype(np.float32), nf) > 0
        touched = np.einsum("hrs,trs->ht", fire.truth.astype(np.float32), nf) > 0  # hours x towns
        touched_now = np.einsum("crs,trs->ct", res["now"][sel].astype(np.float32), nf) > 0

        # --- arrivals and warnings
        for j in range(len(t)):
            hit = np.nonzero(touched[:, j] & fire.has_data)[0]
            if len(hit) == 0 or hit[0] == 0:
                continue                                                      # never reached, or burning at the start
            a = hit[0]
            before = (hours >= a - HORIZON) & (hours < a)
            if not before.any():
                continue                                                      # no forecast was possible in time
            warn_hours = hours[before & flagged[:, j]]
            events.append({"fire_id": fid, "town": t.name[j], "population": t.population[j], "arrival_hour": int(a),
                           "warned": len(warn_hours) > 0,
                           "lead_h": int(a - warn_hours.min()) if len(warn_hours) else 0})
        # --- false alarms: flagged now, not touched now, and not reached within 3 h (where truth is known)
        for ci, h in enumerate(hours):
            ks = [h + k for k in range(1, HORIZON + 1) if h + k < grid.N_HOURS and fire.truth_ok[h + k]]
            if not ks:
                continue
            reached = touched[ks].any(axis=0)
            fa = flagged[ci] & ~touched_now[ci] & ~reached
            for j in np.nonzero(fa)[0]:
                alarms.append({"fire_id": fid, "hour": int(h), "town": t.name[j], "population": t.population[j],
                               "ever_reached": bool(touched[:, j].any())})
    ev = pd.DataFrame(events, columns=["fire_id", "town", "population", "arrival_hour", "warned", "lead_h"])
    al = pd.DataFrame(alarms, columns=["fire_id", "hour", "town", "population", "ever_reached"])
    return ev, al


def town_summary(ev, al, n_fire_hours):
    """One line of numbers for the results table."""
    reached = len(ev)
    warned = int(ev.warned.sum()) if reached else 0
    never = al[~al.ever_reached].drop_duplicates(["fire_id", "town"]) if len(al) else al
    return {"towns_reached": reached, "towns_warned": warned,
            "town_recall": warned / reached if reached else np.nan,
            "people_warned": float(ev[ev.warned].population.fillna(0).sum()) if reached else 0.0,
            "people_reached": float(ev.population.fillna(0).sum()) if reached else 0.0,
            "mean_lead_h": float(ev[ev.warned].lead_h.mean()) if warned else np.nan,
            "false_alarm_town_hours": len(al),
            "false_alarms_per_fire_day": len(al) / max(n_fire_hours, 1) * 24,
            "towns_warned_never_reached": len(never)}
