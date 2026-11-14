# Emberline copilot UI - build brief

Emberline is a wildfire copilot for California incident commanders and county emergency managers during the first
hours of a fire. The backend is done. This brief describes the **one-page frontend** in `app/static/`, which the
judges will see in a 2-minute demo video. It must look like **real incident-command software**: calm, dense,
professional and easy to read. It should not look like a hackathon toy.

## Hard constraints
* Files: `app/static/index.html`, `app/static/app.css`, `app/static/app.js` (split JS into a few files if that helps,
  e.g. `app/static/js/*.js`). **Vanilla JS, no build step, no framework.**
* Libraries are **already bundled** (CDNs are blocked here, and the demo must work offline):
  * `vendor/maplibre/maplibre-gl.js` + `maplibre-gl.css` (MapLibre GL JS 4.7.1)
  * `vendor/fonts/plex.css` (IBM Plex Sans 400/500/600 + IBM Plex Mono 400/500/600)
* Base map: OpenFreeMap style `https://tiles.openfreemap.org/styles/liberty` (or `positron` if it reads better under
  the data layers). Make it **earthy and muted** by lowering the saturation/opacity of the base layers after load.
  Terrain: raster-dem source `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`,
  `encoding: "terrarium"`, `tileSize: 256`, `maxzoom: 15`. Use it for hillshade, and for 3D via
  `map.setTerrain({source, exaggeration: 1.5})` + `pitch: 60`. If the base style fails to load (offline), fall back
  to a plain dark background so the data layers still show.
* Must work at **1280 x 800** with no page scroll; the side panel may scroll internally.
* The backend runs at `http://localhost:8000` (`app/run.sh`). The app is served from the same origin: use relative URLs (`/api/...`).

## Look and feel
* Dark top bar and dark side panel (for example #14171a / #1b1f23). The map is the light, earthy area.
* ONE font family: IBM Plex Sans for text, IBM Plex Mono for every number, time and code.
* **Colour only for status**: EVACUATE red (#d64541), WARNING amber (#e8a33d), MONITOR blue (#4a90c2).
  The fire itself is shown as deep orange/red squares. Everything else is greys.
* **Every number shows its source and time** in a small mono caption, e.g. `GOES-18 · scan 15:16 UTC`,
  `Open-Meteo ERA5 · 19:00 PDT`, `Census 2024`, `Model · logreg · cut-off 0.01`.
* No emoji. Short labels in uppercase small caps for section headers.
* Subtle borders, 4 px radius, tight spacing, aligned columns.

## Layout
```
┌ TOP BAR: EMBERLINE | STATE  INCIDENT  REPLAY | [source clock: GOES-18 scan 15:16 UTC · 4 min ago] [AI: Gemini 3.5 Flash] [2D/3D] [Results] ┐
├──────────────────────────────────────────── MAP ─────────────────────────────────────┬──── SIDE PANEL (≈400 px) ────┤
│                                                                                        │                              │
│  legend (bottom-left), layer toggles (top-left)                                        │  mode content (scrolls)      │
├──────────────────────────────────── REPLAY TIMELINE (replay mode only, ≈110 px) ─────┴──────────────────────────────┤
```

## The three modes

### STATE (California)
* `GET /api/state` (live). Re-fetch every `refresh_s` (300 s) and update the clock: "GOES-18 scan HH:MM UTC · N min ago".
* Map of California with every fire pixel (`pixels` GeoJSON points) as small glowing orange dots, and each incident
  as a ringed marker sized by area. Clicking an incident opens INCIDENT.
* Side panel: an incident list ranked by `triage_score` (sortable by score / people / growth / area). Each row shows the
  rank, "near <nearest_town>", a score bar, area km², growth in the last hour, people within 10 km, and wind (arrow + km/h).
  Underneath, one AI line on why it ranks high: `POST /api/ai/triage {"incident_id"}` → `text`. Load these lazily
  for the top 5 and show a skeleton while loading.
* Show the triage formula (`triage_formula`) and the `notes` in a small collapsible "How ranking works".
* **Archive selector:** "LIVE NOW" plus `config.archive_examples` (`/api/state?at=<iso>`). In archive mode show a clear
  amber banner: `ARCHIVE · 25 Jul 2024 15:00 PDT · same pipeline on past GOES-18 data`. Live California often has
  **no fires** (it has none right now). Show a calm empty state: "No active fires detected in California in the
  latest GOES-18 scans (15:16 UTC)", with a button to open an archive example. (Sample: `docs/api_samples/state_live_now.json`.)
* A first archive state takes about 10 s and a live incident about 20 s (they download satellite files), so show
  progress text ("Downloading GOES-18 scans…").

### INCIDENT (command view)
* `GET /api/incident/{id}` returns a **situation** (same shape as a replay hour, see below).
* Map: zoom to `bounds`. Default is 3D (pitch 60, terrain), with a 2D/3D toggle in the top bar.
* Layers:
  * current fire (`layers.fire`), filled deep orange
  * forecast squares (`layers.forecast`, property `p` 0-1 and `k` 1/2/3), shaded by probability, with a toggle for +1/+2/+3 h
  * forecast rings (`layers.forecast_rings[k-1]`, MultiLineString outlines): +1 h solid, +2 h dashed, +3 h dotted
  * towns (`layers.towns`, points with `status`), coloured by status, labelled for EVACUATE/WARNING
  * exits (`layers.exits`, LineStrings with `blocked_1h`): show them only for the selected/planned town; blocked
    exits red dashed, clear exits neutral; the APPROVED route highlighted
* Side panel, top to bottom:
  1. Header: name, local time, `data_note` (small), ARCHIVE tag if `archive`.
  2. **Wind card**: an arrow pointing where the wind blows TO (`from_deg` + 180), speed, gusts, humidity, temperature, with source.
  3. **Numbers**: fire area, growth in the last hour, forecast area at +1/+2/+3 h.
  4. **Town countdowns** (`towns`, already sorted): a status chip (EVACUATE / WARNING / MONITOR), name, "fire in < 1 h"
     / "fire in ~2 h" / "fire at town" (eta_h 0), residents, chance (`chance_3h`), distance. Click → fly to the town and show its exits.
  5. **AI situation briefing**: `POST /api/ai/briefing` → `text` (lines starting with "- "). Show provider/model + "cached".
  6. **AI recommendation**: `POST /api/ai/plan` → `{status, attempts[], plan?, human_decisions?, message?}`.
     * Show EVERY attempt in order. A REJECTED attempt gets a **red banner "REJECTED BY SAFETY CHECK"** with its
       `reasons`, then the next attempt below it (slide/fade in). An ACCEPTED one gets a green-grey "PASSED SAFETY CHECK".
     * `human_decisions` (e.g. "no clear highway exit") are shown as amber "HUMAN DECISION NEEDED" notes.
     * status `MANUAL` → big "Manual decision required" card. status `AI_OFFLINE` (HTTP 503) → "AI offline, forecast only".
     * The final plan: evacuate list (town → exit, reason), warn list, summary, and **Approve / Dismiss** buttons.
     * The plan step takes 5-30 s the first time, so show a progress state ("Drafting plan… checking against forecast…").
  7. After **Approve**: `POST /api/ai/alert {..., "plan": <plan>}` → show the alert text in a phone-like WEA card with
     the char count (`chars`/360) and the label **"Draft for county alert system, not sent"** + a Copy button.
     Dismiss → plan collapses, logged.
  8. **Event log**: timestamped (local time) list of everything: data loaded, plan drafted, REJECTED (reason),
     accepted, approved by operator, alert drafted, dismissed.
* Always visible footer line in the panel: "AI drafts, code checks the forecast, a human decides."

### REPLAY (the demo)
* `GET /api/replay` lists fires (Park default, Eaton, Palisades). `GET /api/replay/{fire_id}` gives meta:
  `hours[]` (hour_idx, time_local, has_data, has_forecast, fire_area_km2), `default_hour`, `timeline[]`,
  `official_orders[]` (+ `official_orders_note`), and `results` (this fire's test scores).
* `GET /api/replay/{fire_id}/hour/{h}` → the situation for hour h. Same panel as INCIDENT.
* Bottom **timeline** (full width): play / pause / step buttons, speed (1 h per 1 s / 2 s), a scrubber across 74 hours
  with the local time, and a small fire-area sparkline. **Marks on the timeline**:
  our first warning for each town (amber tick, labelled with the town on hover), fire arrival at the town (red tick),
  and official evacuation orders if `official_orders` is non-empty (white tick). If there are none, show the
  `official_orders_note` in small text (we only show real public times).
* Layer toggles (replay only): **Real fire** (`layers.fire`), **Our forecast** (squares + rings), **Baseline: grow 1 km/h**
  (`layers.baseline_rings`, thin grey dashed), **Real fire +1/+2/+3 h** (`layers.actual_future[k-1]`).
* While playing, do NOT call the AI each hour. Show a **"Run copilot at HH:MM"** button that runs briefing + plan for
  the current hour (cached answers come back instantly). Pause playback when it runs.
* **Split screen** toggle (the "wow"): two synced maps side by side.
  Left: **"What officials could see at HH:MM"** = only the current fire. Right: **"Emberline forecast at HH:MM"** =
  current fire + forecast rings + towns coloured by status, and the **real fire 3 h later fading in** over it
  (animate opacity 0 → 0.8 over ~1.5 s, after a short delay).
* **People counter** (top of the panel in replay): residents of towns we put on WARNING/EVACUATE before the fire reached
  them, from `timeline` (towns with `lead_h > 0`, summed `population`). Label it honestly: "residents in towns warned
  before fire arrival (GOES-based arrival time)". If `official_orders` exist, ALSO show "flagged before the official order".
* **Results** button (top bar) → a modal/drawer from `GET /api/results`: the test table (persistence / grow_1km /
  main model) with town recall, false alarms per fire-day, F1 new squares (strict and within 2 km), IoU +1/+2/+3 h,
  the per-fire table, the `summary` lines and the `notes`. Weak results are shown plainly. Do not hide them.

## API data shapes
Real responses are in `docs/api_samples/` (big layers trimmed to a few features). The shared **situation** object:
```
{fire_id, name, mode: "replay"|"live", time_utc, time_local, scan_time_utc, data_note, archive?, incident?, history?,
 bounds: [w,s,e,n], wind: {speed_kmh, gust_kmh, from_deg, humidity_pct, temp_c},
 numbers: {fire_area_km2, growth_last_hour_km2, forecast_area_km2: [a1,a2,a3], residents_evacuate, residents_warning},
 thresholds: {squares: {burn, new}, town_warning},
 towns: [{name, status, eta_h, dist_km, chance_3h, population, lat, lon, bearing_from_fire}],
 exits: {"<town>": [{id, road, direction, length_km, blocked_1h_at_km|null, blocked_3h_at_km|null}]},
 layers: {fire: FC(Polygons), forecast: FC(Polygons, props p,k), forecast_rings: [FC×3 MultiLineString],
          baseline_rings: [FC×3], actual_future: [FC×3 Polygons, props k], exits: FC(LineString, props id, town,
          blocked_1h, blocked_3h), towns: FC(Points, props as towns[])}}
```
Feature ids are `row*40+col`, so they are stable and you can use feature-state or diff layers cheaply.
AI responses: `{text|json, provider, model, cached, seconds}`. Plan: see `docs/api_samples/ai_plan.json`.

## Demo script the UI must make easy (in this order)
1. STATE live → empty state → click the archive "Park Fire, day 2" → ranked list, Park Fire #1 → open INCIDENT in 3D.
2. REPLAY → Park Fire, play from hour 1: rings grow, towns change MONITOR → WARNING → EVACUATE.
3. Pause, "Run copilot": briefing, plan, a REJECTED banner if the safety check catches a road, the corrected plan, Approve → alert draft.
4. Split screen at the same hour: officials' view vs forecast, with the real fire fading in.
5. Results drawer.

## Done = verified
* Start the server if it is not running (`cd /home/user/emberline/app && nohup ./run.sh > ../logs/server.log 2>&1 &`).
  The backend code is NOT yours to change. If an endpoint is broken or missing something you need, describe it in
  your final report instead of editing `app/backend/`.
* Use Playwright (already installed: `require('playwright')`, `chromium.launch()`) to load http://localhost:8000 at
  1280x800, click through all three modes, and save screenshots to `docs/screenshots/`:
  `state_live.png`, `state_archive.png`, `incident.png`, `replay.png`, `replay_split.png`, `replay_rejected_or_plan.png`,
  `results.png`. Look at the screenshots yourself and fix what looks off (overlaps, unreadable text, empty panels,
  layers not showing). WebGL in headless Chromium: launch with `args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist']`.
* Check the browser console has no errors.
