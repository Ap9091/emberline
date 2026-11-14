# Emberline: Wildfire Copilot (California)

> Placeholder. The full write-up comes in Phase 5.

Veritas AI Hackathon 2026, Climate track.

Emberline watches California's fires using the GOES-18 weather satellite, which scans the state every 5 minutes. It forecasts where each fire will be over the next 1-3 hours, counts down to each town, and drafts evacuation plans and alerts. A human approves every step.

## Setup

```bash
python3.11 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env        # then fill in your keys (never commit .env)
```

## Phase 1: check the data sources

```bash
.venv/bin/python src/check_sources.py     # tests every key and data source, prints OK / FAIL
.venv/bin/python src/make_fire_list.py    # builds data/fires.csv and the download-time estimate
.venv/bin/python src/phase1_summary.py    # prints the Phase 1 checklist
```

Data sources and credits: [data_sources.md](data_sources.md).
