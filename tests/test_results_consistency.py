"""
The test results (results/metrics.json) are quoted in the demo, the assistant's knowledge and the hosted site.
These tests check that every place says the same thing, and that the test fires were never used for training.
"""
import json
import os

import pandas as pd
import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
M = json.load(open(os.path.join(ROOT, "results", "metrics.json")))
KNOWLEDGE = open(os.path.join(ROOT, "app", "assistant", "knowledge.md"), encoding="utf-8").read()
DEMO_JS = open(os.path.join(ROOT, "app", "static", "js", "demo.js"), encoding="utf-8").read()


def table():
    return M["test"]          # method -> test-set scores


def test_split_is_by_year_and_test_fires_are_unseen():
    fires = pd.read_csv(os.path.join(ROOT, "data", "fires.csv"))
    years = fires.groupby("split").year.agg(["min", "max", "count"])
    assert (years.loc["train", "min"], years.loc["train", "max"], years.loc["train", "count"]) == (2018, 2022, 40)
    assert (years.loc["val", "min"], years.loc["val", "max"], years.loc["val", "count"]) == (2023, 2023, 12)
    assert (years.loc["test", "min"], years.loc["test", "max"], years.loc["test", "count"]) == (2024, 2025, 18)
    # the same fire never appears in two splits (two different "Lake Fire"s exist: 2020 Los Angeles, 2024 Santa Barbara)
    key = lambda d: set(zip(d.name, d.year))
    assert not key(fires[fires.split == "test"]) & key(fires[fires.split != "test"])
    # and every test fire started after every training and tuning fire
    assert pd.to_datetime(fires[fires.split == "test"].start_utc).min() > pd.to_datetime(fires[fires.split != "test"].start_utc).max()


@pytest.mark.parametrize("method,key,value", [
    ("logreg", "towns_warned", 18), ("logreg", "towns_reached", 20), ("grow_1km", "towns_warned", 18),
    ("persistence", "towns_warned", 0),
])
def test_town_counts(method, key, value):
    assert table()[method][key] == value


def test_headline_numbers_match_what_we_say():
    t = table()
    assert round(t["logreg"]["mean_lead_h"], 1) == 2.8 and round(t["grow_1km"]["mean_lead_h"], 1) == 2.5
    assert round(t["logreg"]["F1 new (2km)"], 2) == 0.41 and round(t["grow_1km"]["F1 new (2km)"], 2) == 0.24
    assert round(t["logreg"]["IoU +3h"] * 100) == 45 and round(t["persistence"]["IoU +3h"] * 100) == 47
    assert round(t["logreg"]["false_alarms_per_fire_day"]) == 30 and round(t["grow_1km"]["false_alarms_per_fire_day"]) == 23
    for text in ("18 of 20", "2.8 hours", "0.41", "0.24", "45%", "47%"):
        assert text in KNOWLEDGE, text
    for text in ("'18 / 20'", "'2.8 h'", "'0.41'", "'0.24'", "45% vs 47%"):
        assert text in DEMO_JS, text


def test_hosted_site_has_the_same_results():
    site = json.load(open(os.path.join(ROOT, "site", "data", "results.json")))
    assert site["table"]["logreg"]["towns_warned"] == table()["logreg"]["towns_warned"]
    assert site["table"]["logreg"]["IoU +3h"] == table()["logreg"]["IoU +3h"]


def test_readme_quotes_the_same_numbers():
    readme = open(os.path.join(ROOT, "README.md"), encoding="utf-8").read()
    t = table()
    for text in ("18 of 20 (90%)", "2.8 h", "2.5 h", f"{t['logreg']['false_alarms_per_fire_day']:.1f}",
                 f"{t['grow_1km']['false_alarms_per_fire_day']:.1f}", "0.32 / 0.41", "0.14 / 0.24",
                 "0.68 / 0.54 / 0.45", "0.70 / 0.56 / 0.47", "0.31 / 0.19 / 0.17", "98.5%", "237,225", "355,483",
                 "87% against 93%", "Sierra Madre 2.4 h"):
        assert text in readme, text
