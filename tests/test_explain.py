"""
"Why this square?" (app/static/js/why.js) says its reasons are exact. Check that on the hosted site's data:
the explained chance equals the forecast's own chance, the reasons add up to the answer, and the demo's numbers hold.
"""
import json
import os
import shutil
import subprocess

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEMO_JS = open(os.path.join(ROOT, "app", "static", "js", "demo.js"), encoding="utf-8").read()


@pytest.mark.skipif(not shutil.which("node"), reason="Node.js not installed")
def test_reasons_are_exact_and_match_the_demo():
    out = subprocess.run(["node", os.path.join(ROOT, "tests", "explain_js.mjs")], capture_output=True, text=True, check=True)
    r = json.loads(out.stdout)
    assert r["n"] > 100
    assert r["worstVsForecast"] < 0.001          # same chance as the forecast squares (stored to 3 decimals)
    assert r["worstSum"] < 0.004                 # the pushes add up to the answer (each push is rounded to 3 decimals)
    d = r["demo"]
    assert (d["p"], d["typical"], d["top"]) == (29, 22, "wind")
    assert "air" in d["down"] and "plants" in d["down"]
    assert "29% chance" in DEMO_JS and "against 22%" in DEMO_JS and "Biggest push up: the wind" in DEMO_JS
