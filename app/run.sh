#!/usr/bin/env bash
# Start the Emberline copilot at http://localhost:8000
cd "$(dirname "$0")"
exec ../.venv/bin/uvicorn backend.server:app --host 0.0.0.0 --port "${PORT:-8000}" "$@"
