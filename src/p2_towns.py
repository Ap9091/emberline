"""
Emberline Phase 2 - a table of every California town with its location and population.

"Town" here means a US Census "place": incorporated cities and towns, plus CDPs
(Census-designated places = unincorporated communities such as Magalia).

Three free Census sources, no key needed:
  1. 2024 Gazetteer (data/raw/2024_gaz_place_06.txt): every place and its centre point.
  2. Vintage 2024 population estimates (data/raw/sub-est2024.csv): incorporated cities/towns only.
  3. 2020 Census redistricting file "PL 94-171" (data/raw/ca2020.pl.zip, ~80 MB): the real 2020
     head count for EVERY place, including CDPs.

population = the 2024 estimate where there is one, otherwise the 2020 census count.

Output: data/processed/towns_ca.csv
Run:    .venv/bin/python src/p2_towns.py
"""

import os
import zipfile

import pandas as pd

import grid
import net

RAW = os.path.join(grid.ROOT, "data", "raw")
OUT = os.path.join(grid.ROOT, "data", "processed", "towns_ca.csv")
PL_URL = ("https://www2.census.gov/programs-surveys/decennial/2020/data/"
          "01-Redistricting_File--PL_94-171/California/ca2020.pl.zip")
BUTTE_BOX = (39.29, -122.07, 40.16, -121.07)   # south, west, north, east (same box as check_sources.py)

# The PL files have no header line, and fields are separated by "|". Column positions (counting
# from 0) come from the Census PL 94-171 technical documentation; we double-check them below
# with two towns whose 2020 population we know.
GEO_SUMLEV, GEO_LOGRECNO, GEO_GEOCODE, GEO_NAME, GEO_POP100 = 2, 7, 9, 87, 90   # in cageo2020.pl
SEG_LOGRECNO, SEG_P1_001N = 4, 5                                                # in ca000012020.pl


def load_gazetteer():
    """Every California place: geoid, name, type, centre lat/lon."""
    gaz = pd.read_csv(os.path.join(RAW, "2024_gaz_place_06.txt"), sep="\t", dtype={"GEOID": str})
    gaz.columns = [c.strip() for c in gaz.columns]   # the last column name has trailing spaces

    # The Census name ends with the kind of place, e.g. "Chico city", "Paradise town", "Magalia CDP".
    # Split that last word off into its own "type" column.
    def split_name(full):
        for suffix, kind in [(" city", "city"), (" town", "town"), (" CDP", "CDP")]:
            if full.endswith(suffix):
                return full[: -len(suffix)], kind
        return full, "other"

    parts = gaz.NAME.map(split_name)
    return pd.DataFrame({"geoid": gaz.GEOID, "name": parts.str[0], "type": parts.str[1],
                         "lat": gaz.INTPTLAT, "lon": gaz.INTPTLONG})


def load_pop_2024():
    """2024 population estimate for incorporated places (cities and towns) only."""
    pop = pd.read_csv(os.path.join(RAW, "sub-est2024.csv"), encoding="latin-1", dtype=str)
    pop = pop[(pop.STATE == "06") & (pop.SUMLEV == "162")]   # 162 = an incorporated place in California
    return pd.DataFrame({"geoid": "06" + pop.PLACE, "pop_2024_est": pop.POPESTIMATE2024.astype(int)})


def load_pop_2020():
    """2020 Census population for every place (cities, towns AND CDPs). Downloads the zip if needed."""
    zip_path = os.path.join(RAW, "ca2020.pl.zip")
    if not os.path.exists(zip_path):
        print("  downloading ca2020.pl.zip (~80 MB)...")
        with open(zip_path, "wb") as f:
            f.write(net.get(PL_URL, timeout=600).content)

    # We read straight out of the zip, so nothing big is left unpacked on disk.
    with zipfile.ZipFile(zip_path) as z:
        # Geographic header: says WHAT each record is. Keep only summary level 160 = "place".
        with z.open("cageo2020.pl") as f:
            geo = pd.read_csv(f, sep="|", header=None, dtype=str, encoding="latin-1",
                              usecols=[GEO_SUMLEV, GEO_LOGRECNO, GEO_GEOCODE, GEO_NAME, GEO_POP100])
        geo.columns = ["sumlev", "logrecno", "geoid", "pl_name", "pop100"]
        geo = geo[geo.sumlev == "160"]
        # Segment 1: the counts. P1_001N (first number of table P1) = total population.
        # LOGRECNO is the record number that links a line here to a line in the geographic header.
        with z.open("ca000012020.pl") as f:
            seg = pd.read_csv(f, sep="|", header=None, dtype=str, usecols=[SEG_LOGRECNO, SEG_P1_001N])
        seg.columns = ["logrecno", "pop_2020"]

    pl = geo.merge(seg, on="logrecno", how="left")
    pl["pop_2020"] = pl.pop_2020.astype(int)

    # Checks that we picked the right columns.
    assert (pl.pop_2020 == pl.pop100.astype(int)).all(), "P1_001N disagrees with the header's own count"
    known = pl.set_index("pl_name").pop_2020
    assert known["Chico city"] == 101475 and known["Paradise town"] == 4764, "known 2020 values do not match"
    print(f"  2020 Census: {len(pl)} California places (checked: Chico 101,475 and Paradise 4,764)")
    return pl[["geoid", "pop_2020"]]


def main():
    towns = load_gazetteer()
    towns = towns.merge(load_pop_2024(), on="geoid", how="left")
    try:
        towns = towns.merge(load_pop_2020(), on="geoid", how="left")
    except Exception as ex:
        print(f"  !! 2020 Census PL file FAILED ({type(ex).__name__}: {ex}).")
        print("  !! FALLING BACK: only incorporated cities/towns will have a population (no CDPs).")
        towns["pop_2020"] = pd.NA

    # Prefer the newer 2024 estimate; otherwise the 2020 count.
    towns["population"] = towns.pop_2024_est.fillna(towns.pop_2020)
    towns["pop_source"] = "none"
    towns.loc[towns.pop_2020.notna(), "pop_source"] = "census_2020"
    towns.loc[towns.pop_2024_est.notna(), "pop_source"] = "estimate_2024"

    # Map position in metres (EPSG:3310), the same projection as the fire grids.
    towns["x"], towns["y"] = grid.TO_ALBERS.transform(towns.lon.values, towns.lat.values)
    towns[["x", "y"]] = towns[["x", "y"]].round(0)

    for c in ["population", "pop_2020", "pop_2024_est"]:
        towns[c] = towns[c].astype("Int64")    # whole numbers, with blanks allowed
    towns = towns[["geoid", "name", "type", "lat", "lon", "x", "y",
                   "population", "pop_2020", "pop_2024_est", "pop_source"]]
    assert towns.geoid.is_unique
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    towns.to_csv(OUT, index=False)

    print(f"\nSaved {os.path.relpath(OUT, grid.ROOT)}: {len(towns)} places")
    print(towns.type.value_counts().to_string())
    print(f"With population: {towns.population.notna().sum()}   without: {towns.population.isna().sum()}")
    print(towns.pop_source.value_counts().to_string())
    if towns.population.isna().any():
        # (Usually brand-new CDPs the Census created after 2020, so the 2020 count has no row for them.)
        print("Places without population:")
        print(towns[towns.population.isna()][["geoid", "name", "type"]].to_string(index=False))

    s, w, n, e = BUTTE_BOX
    butte = towns[towns.lat.between(s, n) & towns.lon.between(w, e)].sort_values("population", ascending=False)
    print(f"\nButte County area: {len(butte)} places, {butte.population.sum():,} people")
    print(butte[["name", "type", "lat", "lon", "population", "pop_source"]].to_string(index=False))


if __name__ == "__main__":
    main()
