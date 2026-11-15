# Emberline data sources and credits

Every dataset, API and tool used in Emberline: where we got it, its licence, and what we use it for.
Status is what `src/check_sources.py` found in Phase 1 (14 Nov 2026).

## Satellite fire data

| Source | Link | Licence / terms | What we use it for | Phase 1 |
|---|---|---|---|---|
| **NOAA GOES-16 / 17 / 18 ABI L2 Fire/Hot Spot Characterization, CONUS (ABI-L2-FDCC)** | AWS Open Data: https://registry.opendata.aws/noaa-goes/ (buckets `noaa-goes16`, `noaa-goes17`, `noaa-goes18`) | U.S. Government work, public domain. Distributed by the NOAA Open Data Dissemination program. | Fire pixels (~2 km) every 5 min: the model's training data (2018: GOES-16; Feb 2019 to 2022: GOES-17; 2023 onward: GOES-18) and the live STATE map. | OK |
| **NASA FIRMS, VIIRS 375 m active fires (NOAA-20, standard product `VIIRS_NOAA20_SP`)** | https://firms.modaps.eosdis.nasa.gov/ | NASA open data. Requested credit: "We acknowledge the use of data and/or imagery from NASA's Fire Information for Resource Management System (FIRMS) (https://www.earthdata.nasa.gov/data/tools/firms), part of NASA's Earth Science Data and Information System (ESDIS)." | Sharper fire outlines when a VIIRS pass is available. (Suomi-NPP `VIIRS_SNPP_SP` returned 0 rows for July 2024, so we use NOAA-20.) | OK |

## Weather, terrain, vegetation

| Source | Link | Licence / terms | What we use it for | Phase 1 |
|---|---|---|---|---|
| **Open-Meteo Historical Weather API** (based on ECMWF ERA5 / ERA5-Land reanalysis) | https://open-meteo.com/en/docs/historical-weather-api | Data CC BY 4.0. Free API for non-commercial use. Cite: Zippenfenig, P. (2023), *Open-Meteo.com Weather API*, Zenodo, doi:10.5281/zenodo.7970649; Hersbach, H. et al. (2023), *ERA5 hourly data*, Copernicus C3S CDS, doi:10.24381/cds.adbb2d47. | Hourly wind speed, wind direction, gusts, humidity and temperature at each fire. | OK |
| **AWS Terrain Tiles** (Mapzen/Tilezen "terrarium" elevation PNGs) | https://registry.opendata.aws/terrain-tiles/ | Open. Attribution to the underlying sources (USGS 3DEP/NED, SRTM, others): https://github.com/tilezen/joerd/blob/master/docs/attribution.md | Elevation and slope features; hillshade and 3D terrain in the app. | OK |
| **ESA WorldCover 10 m 2021 v200** | https://esa-worldcover.org/ (data: `s3://esa-worldcover/v200/2021/map/`) | CC BY 4.0. Cite: Zanaga, D. et al. (2022), *ESA WorldCover 10 m 2021 v200*, doi:10.5281/zenodo.7254221. "© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium." | Vegetation / land-cover class for each 2 km square. | OK (3 s for a 40x20 km window) |
| LANDFIRE FBFM40 fuel models | https://landfire.gov/ | Public domain (USFS/USGS). | Backup fuel-model source. **Not used**: WorldCover downloaded in seconds, and the LANDFIRE Product Service is a slower job-based download. | not needed |

## Towns, people, fires

| Source | Link | Licence / terms | What we use it for | Phase 1 |
|---|---|---|---|---|
| **US Census Bureau 2024 Gazetteer, Places (California)** | https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.html | U.S. Government work, public domain. | Location (centre point) of every city, town and CDP (Census-designated place). | OK |
| **US Census Bureau Vintage 2024 population estimates for cities and towns (SUB-EST2024)** | https://www.census.gov/data/tables/time-series/demo/popest/2020s-total-cities-and-towns.html | Public domain. | Residents per incorporated city/town. | OK |
| US Census Data API (2020 Decennial Census) | https://api.census.gov/ | Public domain. Now requires a free key: https://api.census.gov/data/key_signup.html | Population of unincorporated CDPs (e.g. Magalia, Cohasset). | needs free key |
| OpenStreetMap via the Overpass API | https://www.openstreetmap.org/ , https://overpass-api.de/ | ODbL 1.0. Credit: "© OpenStreetMap contributors". | Planned for small communities and local roads. **Not used**: unreachable from our cloud machine, so we used Census places and Census TIGER roads instead. (Base map tiles still contain OpenStreetMap data.) | not used |
| **CAL FIRE incident list** | https://www.fire.ca.gov/incidents (JSON: `https://incidents.fire.ca.gov/umbraco/api/IncidentApi/List?inactive=true&year=YYYY`) | Public information from the California Department of Forestry and Fire Protection. | Names, start time (UTC), start location and final acres of 2018-2025 fires: our fire list (`data/fires.csv`). | OK (2,471 incidents) |
| **US Census Bureau TIGER/Line 2024, primary and secondary roads (California)** | https://www2.census.gov/geo/tiger/TIGER2024/PRISECROADS/ (file in `data/reference/`) | Public domain. | Exit highways for each town and the safety check (does a route run into the forecast fire?). Used instead of OpenStreetMap, which our cloud machine could not reach. | used |
| **US Census Bureau 2024 cartographic boundaries (state and county, 1:5M)** | https://www2.census.gov/geo/tiger/GENZ2024/shp/ | Public domain. | The California-only map (everything outside the state is covered) and the Los Angeles County outline in the demo. Made by `app/make_california.py` into `app/static/california.geojson`. | used |
| **Official evacuation orders and warnings** (public records) | One source link per row in `data/evac_orders.csv`; research notes in `data/evac_orders_notes.md`. Sources: Butte County Sheriff posts (X), news reports quoting officials, the Los Angeles County after-action investigation report of the Eaton and Palisades evacuations, the LAFD Palisades after-action report, City of Santa Monica and Santa Monica PD posts. | Public information | Comparing Emberline's first warning for each town with the first published official order or warning (REPLAY). Only times a source states; one derived time was removed. Quotes were collected from search results and should be checked against each link. | used |

## AI and software

| Tool | Link | Licence / terms | What we use it for |
|---|---|---|---|
| Claude (Anthropic): claude-haiku-5-5 while building, claude-sonnet-5-5 for the demo | https://www.anthropic.com/ | Anthropic API terms | Agents that write the evacuation plan, the alert drafts and the briefing (Phase 4). Claude Code also helped write this code. |
| Gemini (Google): `gemini-3.8-flash`, falling back to other Gemini Flash / Flash-Lite models when busy (each answer records the model that wrote it) | https://ai.google.dev/ | Gemini API terms | The AI model used while no Claude key is set: triage lines, briefings, evacuation plans, alert drafts. Answers are cached in `data/ai_cache/` so the demo runs offline. |
| humanizer (blader/humanizer) | https://github.com/blader/humanizer | MIT | A writing-style checklist (based on Wikipedia's "Signs of AI writing"), used with Claude Code to tidy the comments in the code. It changes wording only, never the code. |
| Python libraries: pandas, NumPy, xarray, s3fs, netCDF4, h5netcdf, pyproj, scikit-learn, PyArrow, requests, Pillow, rasterio, Matplotlib, FastAPI, Uvicorn, python-dotenv | PyPI | BSD / MIT / Apache 2.0 | Data download, processing, model training, and the app server. |
| MapLibre GL JS 4.7.1 (bundled in `app/static/vendor/`), OpenFreeMap tiles | https://maplibre.org/ , https://openfreemap.org/ | BSD-3 / map data © OpenStreetMap contributors, OpenMapTiles | App maps, 3D terrain (Phase 4). |
| IBM Plex Sans and IBM Plex Mono (bundled in `app/static/vendor/fonts/`) | https://github.com/IBM/plex | SIL Open Font License 1.1 | The app's typefaces. |

Idea credit: inspired by ContainOS (TreeHacks 2026). All code in this repo was written new this weekend.
