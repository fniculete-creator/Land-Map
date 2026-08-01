#!/usr/bin/env python3
"""Enrich raw parcels with overlay flags, computed lot width, vacancy, and
SB 1123/684 eligibility. Streams parcels line-by-line (never holds the full
set in memory); overlay layers are small and held fully in STRtrees.

Input:  data/raw/{parcels,city_boundary,zoning,hillside,coastal,vhfhsz}.ndjson
Output: data/enriched/parcels.ndjson    (polygon features, short-key props)
        data/enriched/centroids.ndjson  (point features: ain,e,v,lsf)
        data/enriched/stats.json        (counters for validation + UI metadata)
"""
import argparse
import json
import os
import sys

from pyproj import Transformer
from shapely import STRtree, oriented_envelope
from shapely.geometry import shape, mapping, Point, box as shp_box
from shapely.ops import transform as shp_transform
from shapely.validation import make_valid

from common import load_sources, ensure_dirs, raw_path, read_ndjson, ENRICHED_DIR

# WGS84 -> CA State Plane Zone V (US survey ft) for all measurements.
TO_FT = Transformer.from_crs("EPSG:4326", "EPSG:2229", always_xy=True).transform

SF_CLASSES = {"RS", "RA", "RW1", "RZ2.5", "RZ3", "RZ4"}
SF_PREFIXES = ("R1", "RE")
MF_CLASSES = {"R2", "R3", "R4", "R5", "RW2", "RU"}
MF_PREFIXES = ("RD", "RAS", "R3", "R4", "R5")


def zone_class_of(zone_complete):
    """'R1V2-1-HPOZ' -> 'R1V2'; '[Q]R3-1' -> 'R3'."""
    z = (zone_complete or "").strip().upper()
    while z and z[0] in "[(TQ]) ":
        z = z[1:]
    return z.split("-")[0].strip()


def zone_family(zc):
    """0 = other, 1 = single-family, 2 = multifamily."""
    if zc in SF_CLASSES or zc.startswith(SF_PREFIXES):
        return 1
    if zc in MF_CLASSES or zc.startswith(MF_PREFIXES) or zc.startswith("R2"):
        return 2
    return 0


def is_vacant(props_use_code, props_use_type, units, improvement_value, vac_cfg):
    uc = (props_use_code or "").strip().upper()
    ut = (props_use_type or "").strip().lower()
    if any(uc.startswith(p.upper()) for p in vac_cfg["vacant_use_codes"]):
        return True
    if any(ut == t.lower() for t in vac_cfg["vacant_use_types"]):
        return True
    return units == 0 and improvement_value < vac_cfg["improvement_value_max"]


def sb1123_eligible(vacant, fire, coastal, hillside, zf, lot_sqft, sb_cfg):
    """Screening heuristic for SB 1123 (vacant SF lots) / SB 684 (MF lots).

    Fire (High/Very High), coastal zone, and hillside all disqualify — the
    map colors qualifying parcels only, and these don't qualify.
    """
    if not vacant or fire != 0 or coastal or hillside:
        return 0
    if zf == 1 and lot_sqft <= sb_cfg["sf_max_lot_sqft"]:
        return 1
    if zf == 2 and lot_sqft <= sb_cfg["mf_max_lot_sqft"]:
        return 1
    return 0


class Overlay:
    """STRtree of overlay polygons for point-in-polygon lookups."""

    def __init__(self, path, keep_props=None):
        self.geoms = []
        self.props = []
        if os.path.exists(path):
            for feat in read_ndjson(path):
                geom = make_valid(shape(feat["geometry"]))
                self.geoms.append(geom)
                self.props.append(feat.get("properties") or {})
        self.tree = STRtree(self.geoms) if self.geoms else None

    def lookup(self, point):
        """Return properties of the first polygon containing point, else None."""
        if not self.tree:
            return None
        for idx in self.tree.query(point, predicate="intersects"):
            return self.props[idx]
        return None

    def contains(self, point):
        return self.lookup(point) is not None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep-outside-city", action="store_true",
                    help="keep parcels outside the LA City boundary (e.g. Santa Monica, "
                         "West Hollywood, Culver City in a Westside pull). They carry "
                         "no LA zoning, so zone-based filters won't match them.")
    args = ap.parse_args()

    sources = load_sources()
    ensure_dirs()
    os.makedirs(ENRICHED_DIR, exist_ok=True)

    pf = sources["parcels"]["fields"]
    vac_cfg = sources["vacancy"]
    sb_cfg = sources["sb1123"]
    haz_map = {k.lower(): v for k, v in sources["vhfhsz"].get("hazard_class_map", {}).items()}
    haz_field = sources["vhfhsz"].get("fields", {}).get("hazard_class")
    haz_default = sources["vhfhsz"].get("default_hazard_when_inside", 2)
    zone_field = sources["zoning"]["fields"]["zone_complete"]

    # Market tiers: parcel gets the first tier (A, then B, then C…) whose box
    # contains its representative point; overlaps resolve to the better tier.
    tier_boxes = []
    for letter in sorted(k for k in sources.get("tiers", {}) if not k.startswith("_")):
        for bb in sources["tiers"][letter]:
            tier_boxes.append((letter, shp_box(bb[0], bb[1], bb[2], bb[3])))

    def tier_of(pt):
        for letter, b in tier_boxes:
            if b.contains(pt):
                return letter
        return ""

    print("loading overlays...")
    boundary = Overlay(raw_path("city_boundary"))
    zoning = Overlay(raw_path("zoning"))
    hillside = Overlay(raw_path("hillside"))
    coastal = Overlay(raw_path("coastal"))
    fire = Overlay(raw_path("vhfhsz"))
    print(f"  boundary={len(boundary.geoms)} zoning={len(zoning.geoms)} hillside={len(hillside.geoms)} "
          f"coastal={len(coastal.geoms)} fire={len(fire.geoms)}")

    stats = {
        "total_read": 0, "written": 0, "outside_city": 0, "duplicate_ain": 0,
        "invalid_geometry": 0, "vacant": 0, "eligible": 0, "fire1": 0, "fire2": 0,
        "coastal": 0, "hillside": 0, "no_zone": 0, "widths": [], "tiers": {},
    }
    seen_ains = set()  # multi-bbox downloads duplicate parcels where boxes overlap

    meta_path = raw_path("parcels") + ".meta"
    synthetic = False
    if os.path.exists(meta_path):
        with open(meta_path) as f:
            synthetic = bool(json.load(f).get("synthetic"))

    out_parcels = os.path.join(ENRICHED_DIR, "parcels.ndjson")
    out_centroids = os.path.join(ENRICHED_DIR, "centroids.ndjson")

    with open(out_parcels, "w") as po, open(out_centroids, "w") as co:
        for feat in read_ndjson(raw_path("parcels")):
            stats["total_read"] += 1
            if stats["total_read"] % 20000 == 0:
                print(f"  {stats['total_read']} read, {stats['written']} written", end="\r", flush=True)

            geom_json = feat.get("geometry")
            if not geom_json:
                stats["invalid_geometry"] += 1
                continue
            try:
                geom = shape(geom_json)
                if not geom.is_valid:
                    geom = make_valid(geom)
                if geom.is_empty or geom.geom_type not in ("Polygon", "MultiPolygon"):
                    stats["invalid_geometry"] += 1
                    continue
            except Exception:
                stats["invalid_geometry"] += 1
                continue

            props = feat.get("properties") or {}
            ain = str(props.get(pf["ain"]) or "").strip()
            if ain:
                if ain in seen_ains:
                    stats["duplicate_ain"] += 1
                    continue
                seen_ains.add(ain)

            rep = geom.representative_point()
            if boundary.tree and not boundary.contains(rep):
                stats["outside_city"] += 1
                if not args.keep_outside_city:
                    continue

            # Measurements in State Plane feet. For MultiPolygon width, use the
            # largest part (pole/remnant slivers shouldn't define the lot).
            geom_ft = shp_transform(TO_FT, geom)
            lot_sqft = int(round(geom_ft.area))
            main_part = geom_ft
            if geom_ft.geom_type == "MultiPolygon":
                main_part = max(geom_ft.geoms, key=lambda g: g.area)
            mrr = oriented_envelope(main_part)
            xs, ys = mrr.exterior.coords.xy
            side1 = Point(xs[0], ys[0]).distance(Point(xs[1], ys[1]))
            side2 = Point(xs[1], ys[1]).distance(Point(xs[2], ys[2]))
            width_ft = int(round(min(side1, side2)))

            use_code = str(props.get(pf["use_code"]) or "")
            use_type = str(props.get(pf.get("use_type", "")) or "")
            try:
                units = int(props.get(pf["units"]) or 0)
            except (TypeError, ValueError):
                units = 0
            try:
                iv = int(props.get(pf["improvement_value"]) or 0)
            except (TypeError, ValueError):
                iv = 0

            zprops = zoning.lookup(rep)
            zone_str = (zprops or {}).get(zone_field) or ""
            if not zone_str:
                stats["no_zone"] += 1
            zc = zone_class_of(zone_str)
            zf = zone_family(zc)

            fprops = fire.lookup(rep)
            if fprops is None:
                f_cls = 0
            elif haz_field and fprops.get(haz_field):
                f_cls = haz_map.get(str(fprops[haz_field]).strip().lower(), haz_default)
            else:
                f_cls = haz_default

            tier = tier_of(rep)
            stats["tiers"][tier or "none"] = stats["tiers"].get(tier or "none", 0) + 1

            c_flag = 1 if coastal.contains(rep) else 0
            h_flag = 1 if hillside.contains(rep) else 0
            v_flag = 1 if is_vacant(use_code, use_type, units, iv, vac_cfg) else 0
            e_flag = sb1123_eligible(v_flag, f_cls, c_flag, h_flag, zf, lot_sqft, sb_cfg)

            stats["vacant"] += v_flag
            stats["eligible"] += e_flag
            stats["fire1"] += 1 if f_cls == 1 else 0
            stats["fire2"] += 1 if f_cls == 2 else 0
            stats["coastal"] += c_flag
            stats["hillside"] += h_flag
            if zf == 1:
                stats["widths"].append(width_ft)

            out_props = {
                "ain": ain, "z": zone_str, "zc": zc, "zf": zf, "uc": use_code,
                "u": units, "lsf": lot_sqft, "w": width_ft, "iv": iv,
                "v": v_flag, "f": f_cls, "c": c_flag, "h": h_flag, "e": e_flag,
                "t": tier,
            }
            po.write(json.dumps({
                "type": "Feature", "geometry": mapping(geom), "properties": out_props,
            }, separators=(",", ":")) + "\n")
            co.write(json.dumps({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [round(rep.x, 6), round(rep.y, 6)]},
                "properties": {"ain": ain, "e": e_flag, "v": v_flag, "lsf": lot_sqft, "t": tier},
            }, separators=(",", ":")) + "\n")
            stats["written"] += 1

    print()
    widths = sorted(stats.pop("widths"))
    stats["sf_width_median"] = widths[len(widths) // 2] if widths else None
    stats["synthetic"] = synthetic
    with open(os.path.join(ENRICHED_DIR, "stats.json"), "w") as f:
        json.dump(stats, f, indent=2)
    print(json.dumps(stats, indent=2))
    if stats["written"] == 0:
        print("ERROR: no parcels written", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
