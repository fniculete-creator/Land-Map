#!/usr/bin/env python3
"""Copy each parcel's computed lot width from the map tiles onto the On Market and
project records, so the Width filter can read them without a parcel being on screen.

    python scripts/listings/add_widths.py

Run after import_listings.py. Reads data/real/*.pmtiles at their top zoom; adds or
updates `w` on data/listings.json and data/projects.json and touches nothing else.
"""
import glob
import gzip
import json
import math
import os

import mapbox_vector_tile
from pmtiles.reader import MmapSource, Reader

REPO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
ZOOM = 15


def tile_xy(lng, lat):
    n = 2 ** ZOOM
    r = math.radians(lat)
    return int((lng + 180) / 360 * n), int((1 - math.asinh(math.tan(r)) / math.pi) / 2 * n)


def tile_lookup():
    """Returns lookup(ain, lng, lat) -> the parcel's tile attributes, or None."""
    handles = [open(p, "rb") for p in sorted(glob.glob(os.path.join(REPO, "data", "real", "*.pmtiles")))]
    readers = [Reader(MmapSource(h)) for h in handles]
    cache = {}

    def parcels_in(x, y):
        if (x, y) not in cache:
            found = {}
            for r in readers:
                raw = r.get(ZOOM, x, y)
                if not raw:
                    continue
                if raw[:2] == b"\x1f\x8b":
                    raw = gzip.decompress(raw)
                for layer in mapbox_vector_tile.decode(raw).values():
                    for f in layer["features"]:
                        p = f["properties"]
                        if p.get("ain") and (str(p["ain"]) not in found or p.get("w") is not None):
                            found[str(p["ain"])] = p
            cache[(x, y)] = found
        return cache[(x, y)]

    def lookup(ain, lng, lat):
        x, y = tile_xy(lng, lat)
        hit = parcels_in(x, y).get(ain)
        if hit:
            return hit
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                hit = parcels_in(x + dx, y + dy).get(ain)
                if hit:
                    return hit
        return None

    return lookup


def main():
    lookup = tile_lookup()
    for name in ("listings.json", "projects.json"):
        path = os.path.join(REPO, "data", name)
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        data = json.loads(text)
        have = 0
        for ain, rec in data.items():
            if rec.get("lng") is None:
                continue
            w = (lookup(ain, rec["lng"], rec["lat"]) or {}).get("w")
            if w is not None:
                rec["w"] = w
                have += 1
            else:
                rec.pop("w", None)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=1)
            if text.endswith("\n"):
                fh.write("\n")
        print(f"{name}: width on {have} of {len(data)}")


if __name__ == "__main__":
    main()
