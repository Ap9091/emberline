"""
Shared set-up for the tests. Run from the repository root:

    .venv/bin/python -m pytest -q

The tests use the committed data (data/processed, results/, models/), so they need no network and no API key.
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for p in (os.path.join(ROOT, "app"), os.path.join(ROOT, "src")):
    if p not in sys.path:
        sys.path.insert(0, p)

# The assistant must never call the real API during tests.
os.environ.pop("ANTHROPIC_API_KEY", None)
