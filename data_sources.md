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
| OpenStreetMap via the Overpass API | https://www.openstreetmap.org/ , https://overpass-api.de/ | ODbL 1.0. Credit: "© OpenStreetMap contributors". | Extra small communities, and roads for evacuation routes (Phase 4). | FAIL: connection dropped from our cloud machine; retry from a laptop |
| **CAL FIRE incident list** | https://www.fire.ca.gov/incidents (JSON: `https://incidents.fire.ca.gov/umbraco/api/IncidentApi/List?inactive=true&year=YYYY`) | Public information from the California Department of Forestry and Fire Protection. | Names, start time (UTC), start location and final acres of 2018-2025 fires: our fire list (`data/fires.csv`). | OK (2,471 incidents) |
| Official evacuation order times | (added by the team in `data/evac_orders.csv`, one source link per row) | Public records | Comparing our warnings with real orders in REPLAY. | Phase 3 |

## AI and software

| Tool | Link | Licence / terms | What we use it for |
|---|---|---|---|
| Claude (Anthropic): claude-haiku-5-5 while building, claude-sonnet-5-5 for the demo | https://www.anthropic.com/ | Anthropic API terms | Agents that write the evacuation plan, the alert drafts and the briefing (Phase 4). Claude Code also helped write this code. |
| Gemini (Google), `gemini-3.8-flash` | https://ai.google.dev/ | Gemini API terms | Fallback AI model if no Claude key is set. |
| Python libraries: pandas, NumPy, xarray, s3fs, netCDF4, h5netcdf, pyproj, scikit-learn, PyArrow, requests, Pillow, rasterio, Matplotlib, FastAPI, Uvicorn, python-dotenv | PyPI | BSD / MIT / Apache 2.0 | Data download, processing, model training, and the app server. |
| MapLibre GL JS, OpenFreeMap tiles | https://maplibre.org/ , https://openfreemap.org/ | BSD-3 / map data © OpenStreetMap contributors | App maps (Phase 4). |

Idea credit: inspired by ContainOS (TreeHacks 2026). All code in this repo was written new this weekend.
