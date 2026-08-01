#!/usr/bin/env python3
"""Generate a synthetic-but-realistic parcel fixture into data/raw/.

Used where GIS hosts are unreachable (restricted sandboxes) and for tests.
Emits the SAME NDJSON schema as 01_download.py, so 02_enrich.py onward runs
unmodified. The demo tileset built from this is watermarked as synthetic.

~N city blocks are laid out over the real Venice/Mar Vista bbox with lots of
varying width/depth, realistic zoning bands, and synthetic overlay polygons
(coastal strip on the west, hillside + fire zone in the northeast).
"""
import argparse
import json
import random

from common import load_sources, ensure_dirs, raw_path

# Degrees per foot near LA (lat 34): 1 deg lat ~ 364,000 ft; 1 deg lon ~ 302,000 ft.
FT_LAT = 1.0 / 364000.0
FT_LON = 1.0 / 302000.0

# (zone string, zone class, weight)
ZONE_BANDS = [
    ("R1-1", "R1", 0.45),
    ("RS-1", "RS", 0.05),
    ("RD1.5-1", "RD1.5", 0.12),
    ("R2-1", "R2", 0.10),
    ("R3-1", "R3", 0.12),
    ("C2-1VL", "C2", 0.08),
    ("CM-1", "CM", 0.04),
    ("M1-1", "M1", 0.04),
]


def rand_use(rng, zone_class):
    """Return (use_code, use_type, units, improvement_value)."""
    roll = rng.random()
    if roll < 0.12:  # vacant
        return ("010V", "Vacant", 0, rng.choice([0, 0, 5000, 15000]))
    if roll < 0.16:  # teardown-ish: tiny improvement, still coded SFR
        return ("0100", "Residential", 1 if rng.random() < 0.5 else 0, rng.randint(0, 19000))
    if zone_class in ("R1", "RS"):
        return ("0100", "Residential", 1, rng.randint(80000, 900000))
    if zone_class in ("R2", "RD1.5"):
        units = rng.choice([1, 2, 2, 3])
        return ("0200", "Residential", units, rng.randint(120000, 1200000))
    if zone_class == "R3":
        units = rng.choice([2, 4, 6, 8, 12])
        return ("0500", "Residential", units, rng.randint(200000, 3000000))
    if zone_class in ("C2", "CM"):
        return ("1100", "Commercial", 0, rng.randint(100000, 2500000))
    return ("3100", "Industrial", 0, rng.randint(100000, 2000000))


def jitter_quad(rng, w, s, e, n):
    """Slightly irregular quadrilateral within the given bounds (lon/lat)."""
    j = 0.06 * (e - w)
    k = 0.06 * (n - s)
    return [[
        [w + rng.uniform(0, j), s + rng.uniform(0, k)],
        [e - rng.uniform(0, j), s + rng.uniform(0, k)],
        [e - rng.uniform(0, j), n - rng.uniform(0, k)],
        [w + rng.uniform(0, j), n - rng.uniform(0, k)],
        [w + rng.uniform(0, j), s + rng.uniform(0, k)],
    ]]


def bbox_poly(w, s, e, n):
    return {"type": "Polygon", "coordinates": [[[w, s], [e, s], [e, n], [w, n], [w, s]]]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--parcels", type=int, default=8000, help="approximate parcel count")
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    rng = random.Random(args.seed)
    sources = load_sources()
    ensure_dirs()
    west, south, east, north = sources["subsets"]["venice"]

    # Block grid: streets every ~660 ft x 330 ft.
    block_w_deg = 660 * FT_LON
    block_h_deg = 330 * FT_LAT
    street_deg = 60 * FT_LON

    cols = int((east - west) / block_w_deg)
    rows = int((north - south) / block_h_deg)

    # Deterministic zone band per column (bands run north-south like real corridors).
    def band_for_col(c):
        r = random.Random(args.seed * 1000 + c).random()
        acc = 0.0
        for zone, zc, wgt in ZONE_BANDS:
            acc += wgt
            if r <= acc:
                return zone, zc
        return ZONE_BANDS[0][0], ZONE_BANDS[0][1]

    # Shuffle block order so the fixture covers the whole bbox (incl. the
    # fire/hillside NE corner) even when the parcel quota fills only some blocks.
    blocks = [(c, r) for c in range(cols) for r in range(rows)]
    rng.shuffle(blocks)

    n_parcels = 0
    ain = 4200000000
    with open(raw_path("parcels"), "w") as pf:
        for c, r in blocks:
            if n_parcels >= args.parcels:
                break
            zone, zc = band_for_col(c)
            bw = west + c * block_w_deg
            if True:
                bs = south + r * block_h_deg
                # Two rows of lots per block, backing onto each other.
                depth_ft = rng.choice([100, 120, 130, 150])
                for half in (0, 1):
                    x = bw + street_deg / 2
                    block_right = bw + block_w_deg - street_deg / 2
                    while x < block_right - 20 * FT_LON:
                        width_ft = rng.choices(
                            [25, 30, 40, 45, 50, 60, 80, 120, 200],
                            weights=[5, 10, 30, 15, 20, 10, 5, 3, 2],
                        )[0]
                        lot_w_deg = width_ft * FT_LON
                        if x + lot_w_deg > block_right:
                            lot_w_deg = block_right - x
                            if lot_w_deg < 20 * FT_LON:
                                break
                        lot_d_deg = depth_ft * FT_LAT
                        ls = bs + street_deg / 2 * FT_LAT / FT_LON + half * lot_d_deg
                        coords = jitter_quad(rng, x, ls, x + lot_w_deg, ls + lot_d_deg)
                        use_code, use_type, units, iv = rand_use(rng, zc)
                        ain += rng.randint(1, 9)
                        feat = {
                            "type": "Feature",
                            "geometry": {"type": "Polygon", "coordinates": coords},
                            "properties": {
                                "AIN": str(ain),
                                "UseCode": use_code,
                                "UseType": use_type,
                                "Units": units,
                                "Roll_ImpValue": iv,
                                "SitusCity": "LOS ANGELES CA",
                            },
                        }
                        pf.write(json.dumps(feat, separators=(",", ":")) + "\n")
                        n_parcels += 1
                        x += lot_w_deg

    # Overlays. City boundary = whole fixture bbox (everything is "in the city").
    def write_overlay(key, geometry, props):
        with open(raw_path(key), "w") as f:
            f.write(json.dumps({"type": "Feature", "geometry": geometry, "properties": props},
                               separators=(",", ":")) + "\n")

    lon_span = east - west
    lat_span = north - south
    write_overlay("city_boundary", bbox_poly(west, south, east, north), {})
    # Coastal strip: western 20%.
    write_overlay("coastal", bbox_poly(west, south, west + 0.20 * lon_span, north), {})
    # Hillside: northeast corner.
    write_overlay("hillside", bbox_poly(west + 0.70 * lon_span, south + 0.65 * lat_span, east, north), {})
    # Fire zones: Very High in the far NE, High in a band next to it.
    with open(raw_path("vhfhsz"), "w") as f:
        f.write(json.dumps({
            "type": "Feature",
            "geometry": bbox_poly(west + 0.85 * lon_span, south + 0.75 * lat_span, east, north),
            "properties": {"HAZ_CLASS": "Very High"},
        }, separators=(",", ":")) + "\n")
        f.write(json.dumps({
            "type": "Feature",
            "geometry": bbox_poly(west + 0.75 * lon_span, south + 0.65 * lat_span, west + 0.85 * lon_span, north),
            "properties": {"HAZ_CLASS": "High"},
        }, separators=(",", ":")) + "\n")

    # Zoning polygons: one band polygon per column.
    with open(raw_path("zoning"), "w") as f:
        for c in range(cols):
            zone, zc = band_for_col(c)
            f.write(json.dumps({
                "type": "Feature",
                "geometry": bbox_poly(west + c * block_w_deg, south, west + (c + 1) * block_w_deg, north),
                "properties": {"ZONE_CMPLT": zone, "ZONE_CLASS": zc},
            }, separators=(",", ":")) + "\n")

    # Mark raw data as synthetic so 02_enrich can watermark the tileset.
    with open(raw_path("parcels") + ".meta", "w") as f:
        json.dump({"synthetic": True, "seed": args.seed, "count": n_parcels}, f)

    print(f"fixture: wrote {n_parcels} synthetic parcels + overlays to data/raw/")


if __name__ == "__main__":
    main()
