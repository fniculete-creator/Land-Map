#!/usr/bin/env python3
"""Turn a themls_pull.js download into the import CSVs for a City of LA refresh.

    python scripts/listings/city_of_la_csvs.py --raw <download.json> --out <folder> [--clear]

Keeps Active rows whose MLS pin falls inside the City of LA boundary and drops a
second MLS number on the same APN. --clear also takes the current City of LA
records out of data/listings.json, so import_listings.py then refreshes the City
and leaves every record outside it alone.
"""
import argparse
import collections
import csv
import json
import os

import requests
from shapely.geometry import Point, shape
from shapely.ops import unary_union
from shapely.prepared import prep

HERE = os.path.dirname(os.path.abspath(__file__))
LISTINGS = os.path.join(HERE, "..", "..", "data", "listings.json")
CITY = ("https://services1.arcgis.com/tzwalEyxl2rpamKs/arcgis/rest/services/"
        "Los_Angeles_City_Boundary/FeatureServer/0/query")
SFR = ["MLS", "S", "Address", "City", "Zip", "SqFt", "LP", "Lot Sz", "DOM", "APN", "Lat", "Lng"]
# The importer reads a sheet as Land when it has an Acreage or Zoning column.
LAND = ["MLS", "S", "Address", "City", "Zip", "Lot Sz", "Acreage", "Zoning", "LP", "DOM", "APN", "Lat", "Lng"]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--raw", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--clear", action="store_true")
    args = ap.parse_args()

    gj = requests.get(CITY, params={"where": "1=1", "outFields": "*", "outSR": 4326, "f": "geojson"},
                      timeout=120).json()
    # buffer(0): the published rings intermittently fail a plain union.
    inside = prep(unary_union([shape(f["geometry"]).buffer(0) for f in gj["features"]]))

    rows = json.load(open(args.raw, encoding="utf-8"))
    kept = [r for r in rows if r["status"] == "Active" and r["lat"] and inside.contains(Point(r["lng"], r["lat"]))]
    print(f"raw {len(rows)}, active inside the City {len(kept)}")

    # A building can be on TheMLS twice (its own number and a feed number): keep TheMLS's.
    seen, unique = set(), []
    for r in sorted(kept, key=lambda r: (not str(r["mls"]).isdigit(), r["dom"] or 0)):
        key = (r["sheet"], r["apn"])
        if r["apn"] and key in seen:
            continue
        seen.add(key)
        unique.append(r)

    os.makedirs(args.out, exist_ok=True)
    for sheet, cols, name in (("SFR", SFR, "On Market City of LA SFR.csv"),
                              ("Land", LAND, "On Market City of LA Land.csv")):
        out = [r for r in unique if r["sheet"] == sheet]
        with open(os.path.join(args.out, name), "w", newline="", encoding="utf-8-sig") as fh:
            w = csv.DictWriter(fh, cols, extrasaction="ignore")
            w.writeheader()
            for r in out:
                lot = r["lot"] or ""
                w.writerow({"MLS": r["mls"], "S": "A", "Address": r["addr"], "City": r["city"], "Zip": r["zip"],
                            "SqFt": r["sqft"] or "", "LP": r["price"] or "", "Lot Sz": lot,
                            "Acreage": round(lot / 43560, 2) if lot else "", "Zoning": "",
                            "DOM": r["dom"] if r["dom"] is not None else "", "APN": r["apn"] or "",
                            "Lat": r["lat"], "Lng": r["lng"]})
        print(f"{name}: {len(out)}")

    if args.clear:
        cur = json.load(open(LISTINGS, encoding="utf-8"))
        keep = {k: v for k, v in cur.items() if not inside.contains(Point(v["lng"], v["lat"]))}
        print(f"listings.json {len(cur)} -> {len(keep)} outside the City",
              dict(collections.Counter(v["type"] for v in keep.values())))
        with open(LISTINGS, "w", encoding="utf-8") as fh:
            json.dump({k: keep[k] for k in sorted(keep)}, fh, indent=1)
            fh.write("\n")


if __name__ == "__main__":
    main()
