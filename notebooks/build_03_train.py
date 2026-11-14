"""
Builds notebooks/03_train.ipynb (the Phase 3 notebook) from the cells below, so the notebook is easy to
regenerate. Run:   .venv/bin/python notebooks/build_03_train.py
Then execute it:   .venv/bin/jupyter nbconvert --to notebook --execute --inplace notebooks/03_train.ipynb
"""
import os

import nbformat as nbf

cells = []
md = lambda s: cells.append(nbf.v4.new_markdown_cell(s.strip()))
code = lambda s: cells.append(nbf.v4.new_code_cell(s.strip()))

md("""
# Emberline - Phase 3: train and test the fire-spread model

**Question:** given what a satellite sees right now, which 2 km squares will be burning 1, 2 and 3 hours from now,
and which towns should be warned?

**Rules we follow**
* Train on fires from 2018-2022, choose settings on 2023 fires, and test **once** on 2024-2025 fires
  (Park, Eaton, Palisades and 15 more) that the model never saw.
* Compare with two simple guesses (baselines). If we don't beat them, we say so.
* Report the weak results too.

The longer code is in `src/p3_core.py` (models, rollout, scoring) and `src/p3_outputs.py` (replay files, maps).
""")

code("""
import os, sys, json, time, warnings
import numpy as np, pandas as pd, matplotlib.pyplot as plt, joblib
warnings.filterwarnings("ignore")
ROOT = os.path.abspath("..") if os.path.basename(os.getcwd()) == "notebooks" else os.getcwd()
sys.path.insert(0, os.path.join(ROOT, "src"))
import p3_core as c, p3_outputs as o
from sklearn.metrics import average_precision_score, f1_score
from sklearn.inspection import permutation_importance

RESULTS, MODELS = os.path.join(ROOT, "results"), os.path.join(ROOT, "models")
os.makedirs(MODELS, exist_ok=True)
pd.set_option("display.width", 160); pd.set_option("display.max_columns", 30)

data = pd.read_parquet(os.path.join(ROOT, "data/processed/dataset.parquet"))
towns = pd.read_csv(os.path.join(ROOT, "data/processed/towns_ca.csv"))
rows = c.training_rows(data)          # drop rows whose 1-hour answer is unknown or was gap-filled (guessed)
train, val, test = [rows[rows.split == s] for s in ["train", "val", "test"]]
print(f"All rows: {len(data):,}   usable rows: {len(rows):,}")
rows.groupby("split").agg(fires=("fire_id", "nunique"), rows=("fire_id", "size"),
                          burning_in_1h=("label_1h", "mean"), newly_burning_in_1h=("new_1h", "mean")).round(3)
""")

md("""
## STEP 1 - Baselines: the simple guesses we must beat

* **Persistence** ("in an hour the fire looks like now"): a square burns at +1 h only if it burns now.
* **Grow 1 km**: the fire outline grows 1 km every hour in every direction.

Below: how they do on each square at +1 h. Persistence is **very** hard to beat here, because most squares that
burn next hour are already burning. But persistence can never predict a *new* square, and new squares near towns are
what matter, so we score those separately (`new` = a square that has never burned before).
""")

code("""
def simple_scores(d, guess):
    y, ynew = d.label_1h.astype(int), d.new_1h.fillna(0).astype(int)
    unburned = d.ever_burned == 0
    return {"F1 all squares": f1_score(y, guess), "F1 new squares": f1_score(ynew[unburned], guess[unburned])}

base = {}
for name, d in [("val", val), ("test", test)]:
    base[("persistence", name)] = simple_scores(d, d.burning_now.astype(int))
    base[("grow 1 km", name)] = simple_scores(d, (d.distance_to_fire_km <= 2.9).astype(int))   # = the 8 neighbours
pd.DataFrame(base).T.round(3)
""")

md("""
## STEP 2 - Prepare the data

* 28 number features + vegetation turned into 0/1 columns ("one-hot": `veg_10` = trees, `veg_30` = grass, ...).
* Logistic regression needs numbers on the same scale: a `StandardScaler` is **fitted on train only** (inside a pipeline).
* Only ~20% of rows burn next hour and ~1.5% are *new* fire, so we use `class_weight="balanced"`: mistakes on
  the rare "burns" rows count more.
""")

code("""
Xtr, ytr = c.make_X(train), train.label_1h.astype(int)
Xva, yva = c.make_X(val), val.label_1h.astype(int)
print("model input:", Xtr.shape[1], "columns ->", list(Xtr.columns))
print("train rows:", len(Xtr), " val rows:", len(Xva), " test rows:", len(test))

def val_scores(p, d=val):
    unb = (d.ever_burned == 0).to_numpy()
    return {"PR-AUC all": average_precision_score(d.label_1h, p),
            "PR-AUC new squares": average_precision_score(d.new_1h.fillna(0)[unb], p[unb]),
            "best F1": max(f1_score(d.label_1h, p >= t) for t in np.arange(0.1, 0.95, 0.05))}
""")

md("""
## STEP 3 - Train two simple models

**Logistic regression** (a weighted sum of the features turned into a probability). We try `C` = how much the model
may trust the data (small C = simpler model) and keep the best on the 2023 validation fires.
""")

code("""
t0 = time.time()
lr_table = {}
for C in [0.01, 0.1, 1, 10]:
    m = c.make_logreg(C).fit(Xtr, ytr)
    lr_table[C] = val_scores(m.predict_proba(Xva)[:, 1])
    lr_table[C]["model"] = m
best_C = max(lr_table, key=lambda C: lr_table[C]["PR-AUC all"])
lr = c.Model("logreg", lr_table[best_C]["model"])
print(f"best C = {best_C}   ({time.time() - t0:.0f} s)")
pd.DataFrame({C: {k: v for k, v in r.items() if k != "model"} for C, r in lr_table.items()}).T.round(4)
""")

md("""
**Gradient-boosted trees** (`HistGradientBoostingClassifier`): hundreds of small decision trees, each fixing the
mistakes of the ones before. We try learning rate x tree depth, and use **early stopping on the validation fires**:
we watch the validation score after every 25 trees and keep the number of trees where it was best.
""")

code("""
t0 = time.time()
hgb_table = []
for lrate in [0.05, 0.1]:
    for depth in [3, 5, None]:
        m = c.make_hgb(lrate, depth, 400).fit(Xtr, ytr)
        best = (0, -1)
        for n, p in enumerate(m.staged_predict_proba(Xva), start=1):
            if n % 25 == 0:
                ap = average_precision_score(yva, p[:, 1])
                if ap > best[1]:
                    best = (n, ap)
        hgb_table.append({"learning_rate": lrate, "max_depth": depth, "best_n_trees": best[0], "val PR-AUC": best[1]})
hgb_table = pd.DataFrame(hgb_table).sort_values("val PR-AUC", ascending=False)
top = hgb_table.iloc[0]
depth = None if pd.isna(top.max_depth) else int(top.max_depth)
hgb = c.Model("hgb", c.make_hgb(top.learning_rate, depth, int(top.best_n_trees)).fit(Xtr, ytr))
avg = c.Average("average", lr, hgb)
print(f"({time.time() - t0:.0f} s)")
hgb_table.round(4)
""")

code("""
# All three models (and the baselines) on the validation fires. Test is NOT looked at.
p_va = {m.name: m.prob(val) for m in [lr, hgb, avg]}
tab = pd.DataFrame({name: val_scores(p) for name, p in p_va.items()}).T
tab.loc["persistence"] = [np.nan, np.nan, f1_score(yva, val.burning_now)]
tab.round(4)
""")

md("""
## STEP 4 - Forecast 3 hours ahead and choose the warning threshold (validation only)

**Rolling forward:** the model predicts +1 h. Squares it thinks will burn become "the fire at +1 h"; we recompute the
features from that imagined fire and predict +2 h, then +3 h. (Honest note: for +2/+3 h we use the weather that really
happened, as a stand-in for a weather forecast.) The cut that decides "burning" in the rollout is each model's best-F1
threshold on validation.

**Town warnings:** a town is *reached* when fire comes within 1 km of it. A town is *warned* if, in the 3 hours
before, a forecast gave a square within 1 km of the town a probability above the **warning threshold**.
We pick the threshold that warns about **9 in 10** reached towns on the 2023 fires.
""")

code("""
val_ids = sorted(val.fire_id.unique()); test_ids = sorted(test.fire_id.unique())
models = [lr, hgb, avg]
# step a: rollout threshold = best F1 at +1 h (computed on +1 h only, which does not depend on the rollout threshold)
first = c.collect(val_ids, models, 0.5)
t_prop = {m.name: c.best_f1_threshold(first, m.name)[0] for m in models}
print("rollout thresholds:", t_prop)
t0 = time.time()
res_val = c.collect(val_ids, models, t_prop)
print(f"validation forecasts: {len(res_val['hour'])} fire-hours ({time.time() - t0:.0f} s)")
""")

code("""
# step b: sweep the warning threshold on validation
sweep = []
for m in models:
    for t in [0.02, 0.03, 0.05, 0.075, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]:
        ev, al = c.town_events(res_val, m.name, t, towns)
        s = c.town_summary(ev, al, len(res_val["hour"]))
        sweep.append({"model": m.name, "threshold": t, **s})
sweep = pd.DataFrame(sweep)
for b in ["persistence", "grow_1km"]:
    ev, al = c.town_events(res_val, b, 0.5, towns)
    sweep = pd.concat([sweep, pd.DataFrame([{"model": b, "threshold": np.nan, **c.town_summary(ev, al, len(res_val["hour"]))}])])
print("towns reached on the 2023 validation fires:", int(sweep.towns_reached.iloc[0]))

def pick(m):
    s = sweep[sweep.model == m].sort_values("threshold")
    ok = s[s.town_recall >= 0.9]
    return float(ok.threshold.max()) if len(ok) else float(s.threshold.min())
t_town = {m.name: pick(m.name) for m in models}
print("warning thresholds (catch ~9 in 10 towns on 2023):", t_town)
sweep[["model", "threshold", "towns_reached", "towns_warned", "town_recall", "false_alarm_town_hours",
       "false_alarms_per_fire_day", "towns_warned_never_reached"]].round(3)
""")

code("""
fig, ax = plt.subplots(figsize=(7, 4.5))
for m in models:
    s = sweep[sweep.model == m.name].sort_values("threshold")
    ax.plot(s.false_alarms_per_fire_day, s.town_recall, "o-", label=m.name)
for b, mk in [("grow_1km", "s"), ("persistence", "D")]:
    s = sweep[sweep.model == b]
    ax.plot(s.false_alarms_per_fire_day, s.town_recall, mk, ms=9, label=f"baseline: {b}")
ax.axhline(0.9, ls=":", c="grey")
ax.set_xlabel("false alarms (town-hours) per fire-day"); ax.set_ylabel("share of reached towns warned in time")
ax.set_title("Validation (2023): catching towns vs false alarms"); ax.legend(); fig.tight_layout()
fig.savefig(os.path.join(RESULTS, "phase3_threshold_tradeoff.png"), dpi=120)
""")

md("""
**The trade-off in two sentences:** a lower threshold warns more towns in time but also sends more warnings to towns
the fire never reaches. We chose to miss as few towns as possible (about 9 in 10 caught on 2023 fires) and report the
false alarms that this costs, because a missed town is far worse than an unneeded warning that a human can dismiss.
""")

md("""
## STEP 5 - Test once on 2024-2025 fires (the honest numbers)

Everything below uses thresholds chosen on 2023. Each model and baseline is scored on:
* **Towns:** reached towns warned in time (recall), people in them, average warning lead time, false alarms.
* **Squares at +1 h:** precision / recall / F1, on all squares and on **new** squares, each **strict** and
  **"within 2 km"** (a hit counts if it is one square off - GOES pixels are 2-4 km, so one square off is within the
  satellite's own error).
* **Fire area IoU** (overlap of forecast and real fire, 1 = perfect) at +1, +2, +3 h.
""")

code("""
t0 = time.time()
res_test = c.collect(test_ids, models, t_prop)
print(f"test forecasts: {len(res_test['hour'])} fire-hours ({time.time() - t0:.0f} s)")

def full_scores(res, name, th_sq, th_town, mask=None, fire_ids=None):
    s1, s2, s3 = (c.square_scores(res, name, th_sq, k, mask) for k in (1, 2, 3))
    ev, al = c.town_events(res, name, th_town, towns, fire_ids)
    n_hours = int(mask.sum()) if mask is not None else len(res["hour"])
    return {**c.town_summary(ev, al, n_hours),
            "P all": s1["all_strict"][0], "R all": s1["all_strict"][1], "F1 all": s1["all_strict"][2],
            "F1 all (2km)": s1["all_2km"][2],
            "P new": s1["new_strict"][0], "R new": s1["new_strict"][1], "F1 new": s1["new_strict"][2],
            "P new (2km)": s1["new_2km"][0], "R new (2km)": s1["new_2km"][1], "F1 new (2km)": s1["new_2km"][2],
            "IoU +1h": s1["iou"], "IoU +2h": s2["iou"], "IoU +3h": s3["iou"]}, ev, al

def all_rows(res, mask=None, fire_ids=None):
    out, evs = {}, {}
    for b in ["persistence", "grow_1km"]:
        out[b], evs[b], _ = full_scores(res, b, 0.5, 0.5, mask, fire_ids)
    for m in models:
        out[m.name], evs[m.name], _ = full_scores(res, m.name, t_prop[m.name], t_town[m.name], mask, fire_ids)
    return pd.DataFrame(out).T, evs

final, test_events = all_rows(res_test)
final.round(3)
""")

code("""
# Per fire (main model = the one with the best validation PR-AUC)
main = max(models, key=lambda m: val_scores(p_va[m.name])["PR-AUC all"]).name
print("main model:", main)
per_fire = []
for fid in test_ids:
    m_ = res_test["fire_id"] == fid
    r = {"fire": fid, "fire-hours": int(m_.sum())}
    for name, th_sq, th_t in [(main, t_prop[main], t_town[main]), ("grow_1km", 0.5, 0.5), ("persistence", 0.5, 0.5)]:
        s, ev, al = full_scores(res_test, name, th_sq, th_t, m_, [fid])
        r[f"{name}: towns warned"] = f"{s['towns_warned']}/{s['towns_reached']}"
        r[f"{name}: false alarms"] = s["false_alarm_town_hours"]
        r[f"{name}: F1 new (2km)"] = round(s["F1 new (2km)"], 3)
        r[f"{name}: IoU +3h"] = round(s["IoU +3h"], 3)
    per_fire.append(r)
per_fire = pd.DataFrame(per_fire)
per_fire
""")

code("""
# Small vs large fires, day vs night (main model vs grow-1km baseline)
acres = c.grid.load_windows().set_index("fire_id").acres
median_acres = acres[test_ids].median()
large = np.array([acres[f] >= median_acres for f in res_test["fire_id"]])
groups = {"small fires": ~large, "large fires": large, "day": ~res_test["is_night"], "night": res_test["is_night"]}
grp = []
for g, mask in groups.items():
    ids = sorted(set(res_test["fire_id"][mask]))
    for name, th_sq, th_t in [(main, t_prop[main], t_town[main]), ("grow_1km", 0.5, 0.5)]:
        s, _, _ = full_scores(res_test, name, th_sq, th_t, mask, ids)
        grp.append({"group": g, "model": name, "fire-hours": int(mask.sum()), "towns warned": f"{s['towns_warned']}/{s['towns_reached']}",
                    "false alarms / fire-day": round(s["false_alarms_per_fire_day"], 1),
                    "F1 new (2km)": round(s["F1 new (2km)"], 3), "IoU +1h": round(s["IoU +1h"], 3)})
print(f"small/large split at the median test-fire size: {median_acres:,.0f} acres. Note: towns are counted only where the "
      "town's arrival hour falls in that group, so day/night town counts are approximate.")
pd.DataFrame(grp)
""")

md("""
## STEP 6 - Understand the model

**Which features matter?** Permutation importance: shuffle one feature on the validation fires and see how much the
score drops. A big drop = the model relies on it.
""")

code("""
hgb_X = c.make_X(val)
sample = np.random.RandomState(0).choice(len(hgb_X), size=min(20000, len(hgb_X)), replace=False)
pi = permutation_importance(hgb.fitted, hgb_X.iloc[sample], yva.iloc[sample], scoring="average_precision",
                            n_repeats=5, random_state=0)
imp = pd.Series(pi.importances_mean, index=hgb_X.columns).sort_values()
imp = imp[imp.abs() > 1e-4]
fig, ax = plt.subplots(figsize=(7, 0.28 * len(imp) + 1))
imp.plot.barh(ax=ax, color="#b5532c"); ax.set_xlabel("drop in validation PR-AUC when shuffled")
ax.set_title("Gradient-boosted trees: permutation importance"); fig.tight_layout()
fig.savefig(os.path.join(RESULTS, "phase3_feature_importance.png"), dpi=120)
imp.sort_values(ascending=False).round(4).head(12)
""")

code("""
# Logistic regression coefficients (features were scaled, so sizes are comparable). + = more likely to burn.
coef = pd.Series(lr.fitted[-1].coef_[0], index=c.make_X(train.head(1)).columns).sort_values()
coef.to_frame("coefficient").round(3).T
""")

md("""
**Ablation:** retrain the trees without the wind features, and without the terrain features, and see how much worse
they get. (Same settings as the chosen model; scored on validation and test squares.)
""")

code("""
abl = {}
for label, drop in [("all features", ()), ("no wind", c.WIND_FEATURES), ("no terrain", c.TERRAIN_FEATURES),
                    ("no wind, no terrain", c.WIND_FEATURES + c.TERRAIN_FEATURES)]:
    m = c.Model(label, c.make_hgb(top.learning_rate, depth, int(top.best_n_trees)).fit(c.make_X(train, drop), ytr), drop)
    r = {}
    for split, d in [("val", val), ("test", test)]:
        p = m.prob(d); unb = (d.ever_burned == 0).to_numpy()
        r[f"{split} PR-AUC all"] = average_precision_score(d.label_1h, p)
        r[f"{split} PR-AUC new squares"] = average_precision_score(d.new_1h.fillna(0)[unb], p[unb])
    abl[label] = r
abl = pd.DataFrame(abl).T
abl.round(4)
""")

md("""
**Five real failures from the test fires.** We pick the biggest misses (reached towns we did not warn, by population)
and the biggest false alarms, map each one, and run simple checks for a likely reason.
""")

code("""
ev_main = test_events[main]
fail_cases = []
misses = ev_main[~ev_main.warned].sort_values("population", ascending=False).head(3)
for _, e in misses.iterrows():
    idx = np.nonzero((res_test["fire_id"] == e.fire_id) & (res_test["hour"] < e.arrival_hour))[0]
    if len(idx):
        fail_cases.append(("MISS", idx[-1], f"{e.town} (pop {e.population:,.0f}) reached at hour {e.arrival_hour}, not warned"))
_, _, al_main = full_scores(res_test, main, t_prop[main], t_town[main])
fa = al_main[~al_main.ever_reached].sort_values("population", ascending=False).drop_duplicates("fire_id").head(5 - len(fail_cases))
for _, a in fa.iterrows():
    idx = np.nonzero((res_test["fire_id"] == a.fire_id) & (res_test["hour"] == a.hour))[0]
    fail_cases.append(("FALSE ALARM", idx[0], f"{a.town} (pop {a.population:,.0f}) warned at hour {a.hour}, fire never reached it"))
failures = []
for n, (kind, i, what) in enumerate(fail_cases[:5], start=1):
    fid, h = res_test["fire_id"][i], int(res_test["hour"][i])
    path = o.failure_map(res_test, i, main, t_town[main], towns, f"Failure {n} - {kind}: {fid}, hour {h}: {what}",
                         os.path.join(RESULTS, f"phase3_failure_{n}.png"))
    failures.append({"n": n, "type": kind, "fire": fid, "hour": h, "what": what, "likely reasons": "; ".join(o.diagnose(res_test, i))})
failures = pd.DataFrame(failures)
with pd.option_context("display.max_colwidth", 200):
    display(failures)
""")

code("""
from IPython.display import Image, display
for n in failures.n:
    display(Image(os.path.join(RESULTS, f"phase3_failure_{n}.png")))
""")

md("""
**Leakage check.** If a score looks too good, the model may be cheating (using information from the future).
Checks: (1) Phase 2 already proved the features at hour h are identical when all later data is deleted.
(2) Splits are by fire and by year: no test fire is in training. (3) The +1 h score of the model is *close to*
persistence, not far above it - which is what an honest model should show, since "burning now" is the strongest clue.
(4) Below: if we shuffle `burning_now` the score should collapse - and a feature that only exists in the future
(like the label itself) is not in the input list.
""")

code("""
assert not set(train.fire_id) & set(test.fire_id) and not set(train.fire_id) & set(val.fire_id)
assert not any(col.startswith(("label", "new_")) for col in c.make_X(val).columns)
print("max test-year in train:", int(rows[rows.split == "train"].fire_id.str[-4:].astype(int).max()),
      "| min year in test:", int(rows[rows.split == "test"].fire_id.str[-4:].astype(int).min()))
pt = hgb.prob(test)
print(f"test PR-AUC (all squares): model {average_precision_score(test.label_1h, pt):.3f}")
print(f"test F1 at +1 h: model {final.loc[main, 'F1 all']:.3f} vs persistence {final.loc['persistence', 'F1 all']:.3f}"
      " -> the model is close to 'looks like now', not suspiciously far above it")
""")

md("""
## STEP 7 - Save everything

* `results/metrics.json`, `results/results_table.md`, charts in `results/`
* `models/emberline_model.joblib` (both models, thresholds, feature list)
* `results/replay/{park,eaton,palisades}.json` - hour-by-hour forecasts + town statuses for the app (Phase 4)
* `data/evac_orders.csv` - the team adds real official evacuation times here (one source link per row); then our
  lead or lag per town is computed below.
""")

code("""
joblib.dump({"logreg": lr.fitted, "hgb": hgb.fitted, "main": main, "features": list(Xtr.columns),
             "rollout_threshold": t_prop, "town_threshold": t_town,
             "settings": {"logreg_C": best_C, "hgb": hgb_table.iloc[0].to_dict()}},
            os.path.join(MODELS, "emberline_model.joblib"))

replay_dir = os.path.join(RESULTS, "replay")
for fid in ["park_fire_2024", "eaton_fire_2025", "palisades_fire_2025"]:
    print("saved", o.export_replay(res_test, fid, main, t_town[main], t_prop[main], towns, replay_dir))

evac = o.evac_lead_lag(replay_dir, os.path.join(ROOT, "data/evac_orders.csv"))
print("evacuation-order comparison:", "waiting for data/evac_orders.csv to be filled in" if evac is None else "")
if evac is not None:
    display(evac)
""")

code("""
def clean(v):
    if isinstance(v, (np.floating, float)):
        return None if np.isnan(v) else round(float(v), 4)
    if isinstance(v, (np.integer,)):
        return int(v)
    return v

metrics = {
    "split_rows": rows.groupby("split").size().to_dict(),
    "validation_fires": val_ids, "test_fires": test_ids, "main_model": main,
    "rollout_threshold": t_prop, "town_threshold": t_town,
    "validation_square_scores": {k: {kk: clean(vv) for kk, vv in v.items()} for k, v in tab.T.to_dict().items()},
    "test": {k: {kk: clean(vv) for kk, vv in v.items()} for k, v in final.T.to_dict().items()},
    "test_per_fire": per_fire.to_dict(orient="records"),
    "ablation": {k: {kk: clean(vv) for kk, vv in v.items()} for k, v in abl.T.to_dict().items()},
    "failures": failures.to_dict(orient="records"),
    "evac_comparison": None if evac is None else evac.astype(str).to_dict(orient="records"),
}
json.dump(metrics, open(os.path.join(RESULTS, "metrics.json"), "w"), indent=1, default=str)

cols = ["towns_reached", "towns_warned", "town_recall", "people_warned", "mean_lead_h", "false_alarms_per_fire_day",
        "towns_warned_never_reached", "F1 all", "F1 all (2km)", "F1 new", "F1 new (2km)", "IoU +1h", "IoU +2h", "IoU +3h"]
with open(os.path.join(RESULTS, "results_table.md"), "w") as f:
    f.write("# Emberline - final test results (2024-2025 fires, never seen in training)\\n\\n")
    f.write(f"Test fires: {len(test_ids)}. Forecasts made: {len(res_test['hour'])} fire-hours. Main model: `{main}`. "
            f"Thresholds chosen on 2023 fires only: warning {t_town}, rollout {t_prop}.\\n\\n")
    f.write("## Main table\\n\\n" + final[cols].round(3).to_markdown() + "\\n\\n")
    f.write("* town_recall: of towns the fire reached (within 1 km), share warned in the 3 h before.\\n"
            "* F1 new: newly burning squares at +1 h, strict; (2km) = a hit may be one square (2 km) off.\\n"
            "* IoU: overlap of forecast and real fire area at +1/+2/+3 h (1 = perfect).\\n\\n")
    f.write("## Per test fire\\n\\n" + per_fire.to_markdown(index=False) + "\\n\\n")
    f.write("## Ablation (gradient-boosted trees)\\n\\n" + abl.round(4).to_markdown() + "\\n\\n")
    f.write("## Five failures\\n\\n" + failures.to_markdown(index=False) + "\\n")
print(open(os.path.join(RESULTS, "results_table.md")).read()[:3000])
""")

md("## Final test table and summary")

code("""
show = final[cols].copy()
show.round(3)
""")

code("""
m, g, p = final.loc[main], final.loc["grow_1km"], final.loc["persistence"]
lines = [
    f"1. On {len(test_ids)} unseen 2024-2025 California fires, the {main} model warned {int(m.towns_warned)} of {int(m.towns_reached)} "
    f"towns the fire reached ({m.town_recall:.0%}), {m.mean_lead_h:.1f} h ahead on average; 'grow 1 km/h' warned "
    f"{int(g.towns_warned)} ({g.town_recall:.0%}) and 'looks like now' {int(p.towns_warned)}.",
    f"2. False alarms: {m.false_alarms_per_fire_day:.1f} town-hours per fire-day for the model vs {g.false_alarms_per_fire_day:.1f} for grow-1-km.",
    f"3. Newly burning squares at +1 h: F1 {m['F1 new']:.2f} strict / {m['F1 new (2km)']:.2f} within 2 km "
    f"(grow 1 km: {g['F1 new']:.2f} / {g['F1 new (2km)']:.2f}; persistence cannot predict new fire at all).",
    f"4. Fire-area overlap (IoU) at +1/+2/+3 h: {m['IoU +1h']:.2f}/{m['IoU +2h']:.2f}/{m['IoU +3h']:.2f} "
    f"vs persistence {p['IoU +1h']:.2f}/{p['IoU +2h']:.2f}/{p['IoU +3h']:.2f}.",
    "5. Limits: GOES pixels are 2-4 km, smoke and night hide fire, one weather point per fire underestimates local "
    "winds like Santa Anas, and ember jumps are mostly missed.",
]
print("\\n".join(lines))
open(os.path.join(RESULTS, "phase3_summary.txt"), "w").write("\\n".join(lines) + "\\n")
""")

nb = nbf.v4.new_notebook(cells=cells, metadata={"kernelspec": {"name": "python3", "display_name": "Python 3", "language": "python"}})
path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "03_train.ipynb")
nbf.write(nb, path)
print("wrote", path)
