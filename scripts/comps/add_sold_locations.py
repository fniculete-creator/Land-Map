#!/usr/bin/env python3
"""Add each sold lot's location and parcel facts to data/sold_land.json, so the Sold view
lists and filters from its own data rather than the parcels the map happens to draw (the
tiles thin parcels out below zoom 13: citywide, the list showed 5 of 1,150 lots).

    python scripts/comps/add_sold_locations.py

Run after build_land_sales.py. Adds lng/lat and address from the 2026 assessor roll; lot SF,
width, vacant flag and tier from the map tiles (tier by area when the tiles have no record).
"""
import json
import os
import sys

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "scripts", "listings"))
from add_widths import tile_lookup  # noqa: E402

ROLL = ("https://services.arcgis.com/RmCCgQtiZLDCtblq/ArcGIS/rest/services/"
        "Assessor%20Parcel%20Data%20Roll%202026/FeatureServer/0/query")


def main():
    path = os.path.join(REPO, "data", "sold_land.json")
    data = json.load(open(path, encoding="utf-8"))
    tiers = {k: v for k, v in json.load(open(os.path.join(REPO, "scripts", "pipeline", "sources.json")))["tiers"].items()
             if k in "ABC"}
    ains = list(data)
    located = 0
    for i in range(0, len(ains), 200):
        chunk = ains[i:i + 200]
        where = "AIN IN (%s)" % ",".join(f"'{a}'" for a in chunk)
        r = requests.post(ROLL, data={"where": where, "returnGeometry": "false", "f": "json",
                                      "outFields": "AIN,CENTER_LAT,CENTER_LON,SitusHouseNo,SitusDirection,SitusStreet"},
                          timeout=120).json()
        if r.get("error"):
            sys.exit(f"assessor roll error: {r['error']}")
        for f in r.get("features", []):
            at = f["attributes"]
            rec = data.get(at["AIN"])
            if rec is None or not at.get("CENTER_LON"):
                continue
            located += 1
            rec["lng"], rec["lat"] = round(at["CENTER_LON"], 6), round(at["CENTER_LAT"], 6)
            parts = [str(at["SitusHouseNo"]) if at.get("SitusHouseNo") else "",
                     (at.get("SitusDirection") or "").strip(), (at.get("SitusStreet") or "").strip()]
            rec["a"] = " ".join(x for x in parts if x)
    print(f"located {located} of {len(ains)} from the roll")

    lookup = tile_lookup()
    in_tiles = 0
    for ain, rec in data.items():
        if rec.get("lng") is None:
            continue
        p = lookup(ain, rec["lng"], rec["lat"])
        if p:
            in_tiles += 1
            for key in ("lsf", "w", "v", "t"):
                if p.get(key) not in (None, ""):
                    rec[key] = p[key]
            if p.get("a"):
                rec["a"] = p["a"]
        if not rec.get("t"):
            for name in ("A", "B", "C"):
                if any(w <= rec["lng"] <= e and s <= rec["lat"] <= n for w, s, e, n in tiers.get(name, [])):
                    rec["t"] = name
                    break
    print(f"parcel facts from the tiles on {in_tiles}")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, separators=(",", ":"))


if __name__ == "__main__":
    main()
