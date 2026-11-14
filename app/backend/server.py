"""
Emberline copilot API (FastAPI). Serves the one-page app from app/static/ and these endpoints:

  GET  /api/config                       AI provider/model, data sources, modes
  GET  /api/results                      final test results (Phase 3) for the results panel
  GET  /api/replay                       list of replay fires
  GET  /api/replay/{fire_id}             replay meta: hours, timeline (our warnings vs fire arrival), official orders
  GET  /api/replay/{fire_id}/hour/{h}    the situation at hour h (map layers, towns, exits, numbers)
  GET  /api/state                        LIVE: every active fire in California from the latest GOES-18 scans
  GET  /api/incident/{incident_id}       LIVE: the situation of one live incident (model forecast on live data)
  POST /api/ai/briefing                  AI situation briefing          body: {"mode": "replay", "fire_id", "hour"}
  POST /api/ai/plan                      AI plan + safety check (+retries)    or {"mode": "live", "incident_id"}
  POST /api/ai/alert                     AI alert draft after Approve   body: same + {"plan": {...}}
  POST /api/ai/triage                    AI one-liner for a live incident  body: {"incident_id"}

Run:  app/run.sh   (http://localhost:8000)
"""

import os
from functools import lru_cache

from fastapi import FastAPI, HTTPException
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import ai, copilot, store
from . import situation as S
from .paths import RESULTS, STATIC_DIR

app = FastAPI(title="Emberline copilot API")
app.add_middleware(GZipMiddleware, minimum_size=1000)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
@lru_cache(maxsize=512)
def _replay_sit(fire_id, h):
    return S.replay_situation(fire_id, h)


def _situation(req):
    if req.mode == "replay":
        try:
            return _replay_sit(req.fire_id, int(req.hour))
        except KeyError:
            raise HTTPException(404, "unknown fire or hour")
    if req.mode == "live":
        from . import live
        sit = live.incident_situation(req.incident_id)
        if sit is None:
            raise HTTPException(404, "unknown or expired incident")
        return sit
    raise HTTPException(400, "mode must be 'replay' or 'live'")


def _offline(e):
    return JSONResponse(status_code=503, content={"status": "AI_OFFLINE", "message": f"AI offline, forecast only ({e})"})


class SitReq(BaseModel):
    mode: str = "replay"
    fire_id: str | None = None
    hour: int | None = None
    incident_id: str | None = None


class AlertReq(SitReq):
    plan: dict


class TriageReq(BaseModel):
    incident_id: str


# ---------------------------------------------------------------------------
# routes
# ---------------------------------------------------------------------------
@app.get("/api/config")
def config():
    return {"ai": ai.status(),
            "modes": ["STATE", "INCIDENT", "REPLAY"],
            "archive_examples": ARCHIVE_EXAMPLES,
            "refresh_s": 300,
            "sources": {
                "fire": "NOAA GOES-18 ABI fire product (ABI-L2-FDCC), AWS Open Data, scan every 5 min, ~2-3 km pixels",
                "weather": "Open-Meteo (historical: ERA5 reanalysis; live: forecast API)",
                "terrain": "AWS Terrain Tiles", "vegetation": "ESA WorldCover 2021",
                "towns": "US Census 2024 Gazetteer + population (2020 Census / 2024 estimates)",
                "roads": "US Census TIGER/Line 2024 primary and secondary roads",
                "model": "Emberline gradient-boosted / logistic model trained on 2018-2022 California fires (GOES pixels)"}}


@app.get("/api/results")
def results():
    m = store.metrics()
    main = m["main_model"]
    rows = {k: v for k, v in m["test"].items() if k in ("persistence", "grow_1km", main)}
    summary = open(os.path.join(RESULTS, "phase3_summary.txt")).read().strip().splitlines()
    return {"main_model": main, "test_fires": m["test_fires"], "town_threshold": m["town_threshold"][main],
            "square_thresholds": m["square_thresholds"][main], "table": rows, "per_fire": m["test_per_fire"],
            "summary": summary, "ablation": m["ablation"],
            "notes": ["Test fires (2024-2025) were never used for training or for choosing any setting.",
                      "This is our second test run; the first exposed three bugs (see notebook 03_train).",
                      "Square scores: strict, and 'within 2 km' (GOES pixels are 2-4 km).",
                      "Town warnings tie the simple 'grow 1 km/h' rule (90% vs 90%) with more false alarms."]}


@app.get("/api/replay")
def replay_list():
    out = []
    for fid in store.REPLAY_FIRES:
        try:
            rp = store.replay(fid)
            out.append({"fire_id": fid, "name": rp["name"], "start_utc": rp["hours"][0]["time_utc"],
                        "default": fid == store.REPLAY_FIRES[0]})
        except KeyError:
            pass
    return out


@app.get("/api/replay/{fire_id}")
def replay_meta(fire_id: str):
    try:
        return S.replay_meta(fire_id)
    except KeyError:
        raise HTTPException(404, "unknown fire")


@app.get("/api/replay/{fire_id}/hour/{h}")
def replay_hour(fire_id: str, h: int):
    try:
        return S.public(_replay_sit(fire_id, h))
    except KeyError:
        raise HTTPException(404, "unknown fire or hour")


ARCHIVE_EXAMPLES = [
    {"label": "Park Fire, day 2 - 25 Jul 2024, 3:00 PM PDT", "at": "2024-07-25T22:00:00Z"},
    {"label": "Eaton + Palisades - 8 Jan 2025, 10:00 AM PST", "at": "2025-01-08T18:00:00Z"},
    {"label": "Bridge + Line + Airport - 10 Sep 2024, 2:00 PM PDT", "at": "2024-09-10T21:00:00Z"},
]


@app.get("/api/state")
def state(at: str | None = None):
    """Live California (at=None) or the same pipeline at a past archive time (?at=2024-07-25T22:00:00Z)."""
    from . import live
    import pandas as pd
    if at:
        try:
            t = pd.Timestamp(at)
            t = t.tz_localize("UTC") if t.tzinfo is None else t.tz_convert("UTC")
        except Exception:
            raise HTTPException(400, "bad 'at' time")
        return live.state(at=t)
    return live.state()


@app.get("/api/incident/{incident_id}")
def incident(incident_id: str):
    from . import live
    sit = live.incident_situation(incident_id)
    if sit is None:
        raise HTTPException(404, "unknown or expired incident")
    return S.public(sit)


@app.post("/api/ai/briefing")
def ai_briefing(req: SitReq):
    try:
        return copilot.briefing(_situation(req))
    except ai.AIOffline as e:
        return _offline(e)


@app.post("/api/ai/plan")
def ai_plan(req: SitReq):
    out = copilot.plan(_situation(req))
    return out if out["status"] != "AI_OFFLINE" else JSONResponse(status_code=503, content=out)


@app.post("/api/ai/alert")
def ai_alert(req: AlertReq):
    try:
        return copilot.alert(_situation(req), req.plan)
    except ai.AIOffline as e:
        return _offline(e)


@app.post("/api/ai/triage")
def ai_triage(req: TriageReq):
    from . import live
    inc = live.incident_summary(req.incident_id)
    if inc is None:
        raise HTTPException(404, "unknown incident")
    try:
        return copilot.triage_line(inc)
    except ai.AIOffline as e:
        return _offline(e)


@app.on_event("startup")
def _warm():
    from . import live
    live.warm_up()


# The one-page app (built in app/static/). Must be mounted last.
if os.path.isdir(STATIC_DIR):
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
