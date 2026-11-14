"""
Print the Phase 1 checklist from the files the other two scripts saved.
    .venv/bin/python src/phase1_summary.py
"""

import json
import os

import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

checks = json.load(open(os.path.join(ROOT, "results", "phase1_checklist.json")))
est = json.load(open(os.path.join(ROOT, "results", "phase1_download_estimate.json")))
fires = pd.read_csv(os.path.join(ROOT, "data", "fires.csv"))

print("EMBERLINE - PHASE 1 CHECKLIST")
print("-" * 70)
for name, res in checks.items():
    print(f"[{res[:4].strip():4s}] {name:32s} {res[6:][:80]}")

print("\nFires per split (data/fires.csv):")
for split in ["train", "val", "test"]:
    f = fires[fires.split == split]
    print(f"  {split:5s} {len(f):3d} fires  ({f.year.min()}-{f.year.max()}, {f.acres.sum():,.0f} acres)")
for name in ["Park Fire", "Eaton Fire", "Palisades Fire"]:
    print(f"  must-have test fire present: {name:15s} {'yes' if name in set(fires[fires.split == 'test'].name) else 'NO'}")

print(f"\nGOES download estimate (3 days per fire): {est['files']:,} files, {est['total_GB']} GB, "
      f"about {est['estimated_hours']} h at {est['MB_per_s']} MB/s -> "
      f"{'fits the 3-hour budget' if est['fits_in_3_hours'] else 'TOO SLOW'}")
