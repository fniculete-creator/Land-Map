#!/usr/bin/env python3
"""
Import on-market MLS listings into data/listings.json for the LAAA Land map.

One command turns a folder of raw MLS CSV exports into screened, parcel-matched
On Market records:

    python scripts/listings/import_listings.py --source "<folder with the CSVs>"

The pipeline per row is: parse -> dedupe by MLS number -> geocode (Census) ->
point-in-parcel match (county assessor FeatureServers) -> SB 1123 screen ->
merge. Everything is additive: an existing record is never removed or
overwritten, so listings that have gone off market stay until pulled by hand.

Standing screen rules (Filip, 2026-08-04) are enforced in screen():
  * exclude parcels carrying existing 2+ unit improvements (use code 02xx-05xx)
  * exclude unit-number listings (condo/apartment rows)
  * SFR under $20/SF of land is suspect (mobile-home trap) and is held out

Outside LA City the tiles carry no zoning, so the screen falls back to fire /
coastal / lot-cap / county use code plus a shared-parcel guard.

Every decision, including rejections, is written to a dated audit CSV in the
source folder so the screen can be reviewed row by row.
"""

import argparse
import csv
import datetime as dt
import json
import os
import re
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

try:
    import requests
except ImportError:
    sys.exit("requests is required:  pip install requests")

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
LISTINGS_JSON = os.path.join(REPO, "data", "listings.json")
SOURCES_JSON = os.path.join(REPO, "scripts", "pipeline", "sources.json")
GEOCACHE = os.path.join(HERE, ".geocache.json")

# County assessor parcel layers. Point-in-polygon queries here replace decoding
# the PMTiles archives, and they return the use code and values the screen needs.
PARCEL_LAYERS = {
    "LA": {
        "url": "https://services.arcgis.com/RmCCgQtiZLDCtblq/arcgis/rest/services/Parcels_2022Roll/FeatureServer/0",
        "fields": "AIN,UseType,Roll_ImpValue,Roll_LandValue,SitusFullAddress,Shape__Area",
        "ain": "AIN", "area": "Shape__Area", "situs": "SitusFullAddress",
        "prefix": "",
    },
    "VC": {
        "url": "https://services5.arcgis.com/umIjvohPcWJU5ij6/arcgis/rest/services/Ventura_County_Parcels/FeatureServer/0",
        "fields": "APN10,SITE_USE,ZONE,I_V,L_V,SITUS,Shape__Area",
        "ain": "APN10", "area": "Shape__Area", "situs": "SITUS",
        "prefix": "V",
    },
    "SB": {
        "url": "https://services.arcgis.com/KkJhFbLnXVqahKz2/arcgis/rest/services/Assessor_Parcels_Public1/FeatureServer/0",
        "fields": "APN,LandUse,StrImpr,LandValue,Situs1,Shape__Area",
        "ain": "APN", "area": "Shape__Area", "situs": "Situs1",
        "prefix": "S",
    },
}
USECODE_LAYER = "https://services.arcgis.com/RmCCgQtiZLDCtblq/arcgis/rest/services/ASSR_PARCELS_25_View/FeatureServer/0"
ZONING_LAYER = "https://services5.arcgis.com/7nsPwEMP38bSkCjy/arcgis/rest/services/Zoning/FeatureServer/15"
CITY_LAYER = "https://services1.arcgis.com/tzwalEyxl2rpamKs/arcgis/rest/services/Los_Angeles_City_Boundary/FeatureServer/0"
HILLSIDE_LAYER = "https://maps.lacity.org/lahub/rest/services/Special_Areas/MapServer/6"
# Current adopted FHSZ maps (osfm.fire.ca.gov viewer): LRA adopted 2025 plus
# SRA effective 4/1/2024. The retired fhsz24_1 layer (last edit 4/2024) missed
# the 2025 LRA adoptions and let ~130 High/VH listings through in August 2026.
FIRE_LAYERS = (
    "https://services1.arcgis.com/jUJYIo9tSA7EHvfZ/arcgis/rest/services/FHSALRA25_v1_All/FeatureServer/0",
    "https://services1.arcgis.com/jUJYIo9tSA7EHvfZ/arcgis/rest/services/FHSZSRA_23_3/FeatureServer/0",
)
COASTAL_LAYER = "https://services.arcgis.com/BLN4oKB0N1YSgvY8/arcgis/rest/services/Coastal_Zone/FeatureServer/0"
CENSUS_GEOCODER = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress"

# Zone classes, zone family and public-owner detection are kept identical to
# scripts/pipeline/02_enrich.py so the importer's screen agrees with the tiles.
SF_CLASSES = {"RS", "RA", "RW1", "RZ2.5", "RZ3", "RZ4"}
SF_PREFIXES = ("R1", "RE")
MF_CLASSES = {"R2", "R3", "R4", "R5", "RW2", "RU"}
MF_PREFIXES = ("RD", "RAS", "R3", "R4", "R5")
SB_PUBLIC_KEYWORDS = ("GOVERNMENT", "CHURCH", "SCHOOL", "COLLEGE", "HOSPITAL",
                      "CEMETER", "UTILITY", "MUNICIPAL", "FEDERAL", "STATE OF",
                      "COUNTY", "CITY OF")

# County bounding boxes, checked before the LA default. Cities that straddle a
# line are resolved by the parcel query itself (a miss falls through to LA).
COUNTY_BBOX = {
    "VC": (-119.65, 33.90, -118.63, 34.90),
    "SB": (-120.75, 34.34, -119.44, 35.12),
}
# MLS "City" values that are unambiguously Ventura or Santa Barbara county.
COUNTY_BY_CITY = {
    "VC": {"SIMI VALLEY", "THOUSAND OAKS", "NEWBURY PARK", "MOORPARK", "CAMARILLO",
           "OXNARD", "VENTURA", "SANTA PAULA", "FILLMORE", "OJAI", "PORT HUENEME",
           "WESTLAKE VILLAGE", "OAK PARK", "SOMIS", "PIRU", "OAK VIEW", "CARPINTERIA"},
    "SB": {"SANTA BARBARA", "GOLETA", "CARPINTERIA", "SANTA MARIA", "LOMPOC",
           "SOLVANG", "BUELLTON", "ORCUTT", "SANTA YNEZ", "LOS OLIVOS", "GUADALUPE"},
}
COUNTY_BY_CITY["VC"].discard("CARPINTERIA")  # Carpinteria is Santa Barbara county

SF_MAX_LOT_SQFT = 65340            # 1.5 acres, SB 1123 single-family
# Filip 2026-08-10: flat 1.5 ac cap regardless of zone family. A tied
# double-lot assemblage is a curated manual exception, not auto-imported.
MF_MAX_LOT_SQFT = 65340
SHARED_PARCEL_MULTIPLE = 3.0       # parcel this much larger than the MLS lot = condo trap
SUSPECT_SFR_PPSF = 20              # SFR under $20/SF of land = likely mobile home
NEAREST_SEARCH_M = 120             # candidate radius, only to name the nearest parcel
ENVELOPE_PAD_DEG = 0.012           # ~1.3 km box around the geocode for situs lookups
UNIT_NUMBER_RE = re.compile(r"(^|\s)(#|apt\.?|unit|ste\.?|suite)\s*[\w-]*", re.I)
DIRECTIONALS = {"N", "S", "E", "W", "NE", "NW", "SE", "SW",
                "NORTH", "SOUTH", "EAST", "WEST"}

_session = threading.local()
_lock = threading.Lock()
_geocache = {}
_pointcache = {}
_failures = []


def session():
    if not hasattr(_session, "s"):
        s = requests.Session()
        s.headers["User-Agent"] = "LAAA-Land-Map/1.0 listings importer"
        _session.s = s
    return _session.s


# ---------------------------------------------------------------- CSV parsing

def money(v):
    v = re.sub(r"[^\d.]", "", str(v or ""))
    try:
        return int(round(float(v)))
    except ValueError:
        return None


def integer(v):
    v = re.sub(r"[^\d]", "", str(v or ""))
    return int(v) if v else None


def clean_address(v):
    return re.sub(r"\s+", " ", str(v or "").strip())


def parse_csv(path, today):
    """Yield normalized rows from one MLS export. Column sets differ between the
    SFR sheets (SqFt/BR/YB) and the Land sheets (Acreage/Zoning), so the parser
    keys off whichever headers are present."""
    rows = []
    with open(path, newline="", encoding="utf-8-sig") as fh:
        for r in csv.DictReader(fh):
            r = {(k or "").strip(): v for k, v in r.items()}
            mls = (r.get("MLS") or "").strip()
            if not mls:
                continue
            if (r.get("S") or "A").strip().upper() not in ("A", "ACTIVE"):
                continue  # backup/pending/withdrawn rows in a mixed export

            is_land = "Acreage" in r or "Zoning" in r
            dom = integer(r.get("DOM"))
            # Prefer a real list date column when the export includes one;
            # otherwise derive it from days-on-market.
            list_date = ""
            for key in ("List Date", "Listing Date", "On Market Date", "OMD"):
                if r.get(key):
                    list_date = normalize_date(r[key])
                    break
            if not list_date and dom is not None:
                list_date = (today - dt.timedelta(days=dom)).isoformat()

            rows.append({
                "sheet": os.path.basename(path),
                "mls": mls,
                "address": clean_address(r.get("Address")),
                "city": clean_address(r.get("City")).title(),
                "price": money(r.get("LP")),
                "lotSqft": integer(r.get("Lot Sz")),
                "type": "Land" if is_land else "SFR",
                "bldgSqft": integer(r.get("SqFt")),
                "mlsZoning": clean_address(r.get("Zoning")),
                "dom": dom,
                "listDate": list_date,
            })
    return rows


def normalize_date(v):
    v = str(v or "").strip()
    for fmt in ("%m/%d/%Y", "%Y-%m-%d", "%m/%d/%y", "%m-%d-%Y"):
        try:
            return dt.datetime.strptime(v, fmt).date().isoformat()
        except ValueError:
            pass
    return ""


# ------------------------------------------------------------------ geocoding

def geocode(address, city):
    key = f"{address}|{city}".upper()
    with _lock:
        if key in _geocache:
            return _geocache[key]
    result = None
    if re.match(r"^\d+\s", address):  # Census needs a house number
        try:
            r = session().get(CENSUS_GEOCODER, timeout=45, params={
                "address": f"{address}, {city}, CA",
                "benchmark": "Public_AR_Current", "format": "json"})
            matches = r.json().get("result", {}).get("addressMatches") or []
            if matches:
                c = matches[0]["coordinates"]
                result = (round(c["x"], 6), round(c["y"], 6))
        except Exception:
            result = None
    with _lock:
        _geocache[key] = result
    return result


# ------------------------------------------------------- ArcGIS point queries

def point_query(layer, lng, lat, fields, distance=None, centroid=False):
    params = {
        "geometry": f"{lng},{lat}", "geometryType": "esriGeometryPoint", "inSR": 4326,
        "spatialRel": "esriSpatialRelIntersects", "outFields": fields,
        "returnGeometry": "false", "f": "json",
    }
    if centroid:
        params["returnCentroid"] = "true"
        params["outSR"] = 4326
    if distance:
        params["distance"] = distance
        params["units"] = "esriSRUnit_Meter"
    return arcgis_query(layer, params)


def arcgis_get(layer, params, tries=3):
    """GET with retries. A swallowed failure here is worse than a slow run: it
    looks exactly like 'no parcel exists', which silently drops good listings."""
    import time
    for attempt in range(tries):
        try:
            d = session().get(layer + "/query", params=params, timeout=90).json()
            if d.get("error"):
                raise RuntimeError(d["error"].get("message", "arcgis error"))
            return d
        except Exception as e:
            if attempt == tries - 1:
                with _lock:
                    _failures.append((layer.rsplit("/services/", 1)[-1], str(e)[:90]))
                return {}
            time.sleep(1.5 * (attempt + 1))
    return {}


def arcgis_query(layer, params, tries=3):
    return arcgis_get(layer, params, tries).get("features") or []


def inside_layer(layer, lng, lat, precision=5):
    """True when the point falls inside any polygon of an overlay.

    Asking for object ids sidesteps the fact that these layers disagree on what
    their id field is called (FID / OBJECTID / OBJECTID_1). Naming the wrong one
    returns 'Invalid query parameters', which is indistinguishable from a clean
    miss and silently disables the check - that is what made every coastal-zone
    lookup fail."""
    key = (layer, "ids", round(lng, precision), round(lat, precision))
    with _lock:
        if key in _pointcache:
            return _pointcache[key]
    d = arcgis_get(layer, {
        "geometry": f"{lng},{lat}", "geometryType": "esriGeometryPoint", "inSR": 4326,
        "spatialRel": "esriSpatialRelIntersects", "returnIdsOnly": "true", "f": "json"})
    val = bool(d.get("objectIds"))
    with _lock:
        _pointcache[key] = val
    return val


def cached_point_flag(layer, lng, lat, fields, precision=5):
    """Overlay hit at a point, cached by rounded coordinate.

    Precision matters: city boundary, fire and coastal are broad areas where
    ~100 m of rounding is harmless, but zoning and hillside change lot to lot,
    so those are cached at ~1 m or neighbors inherit each other's answers."""
    key = (layer, round(lng, precision), round(lat, precision))
    with _lock:
        if key in _pointcache:
            return _pointcache[key]
    feats = point_query(layer, lng, lat, fields)
    val = feats[0]["attributes"] if feats else None
    with _lock:
        _pointcache[key] = val
    return val


def county_for(city, lng, lat):
    up = (city or "").upper()
    for c in ("SB", "VC"):
        if up in COUNTY_BY_CITY[c]:
            return c
    for c, (w, s, e, n) in COUNTY_BBOX.items():
        if w <= lng <= e and s <= lat <= n:
            return c
    return "LA"


def street_key(addr):
    """'14301 Roscoe BLVD LOS ANGELES CA' -> ('14301', 'ROSCOE').

    House number plus the first real street-name token, with leading
    directionals and secondary numbers ('1463 - 1467 Wellesley') dropped. This
    is what makes a fallback match verifiable rather than a guess."""
    toks = re.sub(r"[^\w ]", " ", str(addr or "").upper()).split()
    num = ""
    while toks and toks[0].isdigit():
        if not num:
            num = toks[0]
        toks.pop(0)
    while toks and toks[0] in DIRECTIONALS:
        toks.pop(0)
    return num, (toks[0] if toks else "")


def match_parcel(county, lng, lat, listing_addr):
    """Point-in-polygon first, which is authoritative.

    The Census geocoder interpolates along the street centerline, so a large
    share of addresses land in the right-of-way and hit no parcel at all. Those
    fall back to a radius search, but a nearby parcel is only accepted when its
    situs house number and street name match the listing. Taking whichever
    parcel the service happened to return first silently matched listings to
    their neighbors."""
    cfg = PARCEL_LAYERS[county]
    feats = point_query(cfg["url"], lng, lat, cfg["fields"], centroid=True)
    if feats:
        return with_centroid(feats[0]), "exact", ""

    want_num, want_street = street_key(listing_addr)
    if not want_num or not want_street:
        return None, None, "no house number to verify a nearby parcel against"

    # Ask the assessor for the address itself, bounded to an envelope around the
    # geocode so a same-named street in another city cannot win. This beats
    # picking a nearby parcel: the house number has to agree exactly.
    hits = situs_query(cfg, want_num, want_street, lng, lat)
    if len(hits) == 1:
        return hits[0], "situs-verified", ""
    if len(hits) > 1:
        return None, None, (f"{len(hits)} parcels share situs {want_num} {want_street} "
                            f"near the geocode")

    # Vacant land, the population this map exists for, frequently carries no
    # situs address at all, so an address lookup can never find it. Fall back to
    # the genuinely nearest parcel centroid, computed rather than taken from
    # whatever the service listed first, and record the distance for review.
    feats = point_query(cfg["url"], lng, lat, cfg["fields"],
                        distance=NEAREST_SEARCH_M, centroid=True)
    best = None
    for f in feats:
        c = f.get("centroid") or {}
        if c.get("x") is None:
            continue
        d = metres_between(lng, lat, c["x"], c["y"])
        if best is None or d < best[0]:
            best = (d, f)
    if best:
        return with_centroid(best[1]), f"nearest-{best[0]:.0f}m", ""
    return None, None, "no parcel within %dm of the geocode" % NEAREST_SEARCH_M


def metres_between(lng1, lat1, lng2, lat2):
    """Flat-earth distance, accurate enough at parcel scale in LA."""
    import math
    kx = 111320.0 * math.cos(math.radians(lat1))
    return math.hypot((lng2 - lng1) * kx, (lat2 - lat1) * 110540.0)


def with_centroid(feature):
    """Fold the parcel centroid into the attribute dict. Overlays are then
    tested at the parcel itself, not at the geocode, which for most listings
    sits in the street where no zoning or parcel polygon exists at all."""
    a = dict(feature.get("attributes") or {})
    c = feature.get("centroid") or {}
    a["_cx"], a["_cy"] = c.get("x"), c.get("y")
    return a


def situs_query(cfg, num, street, lng, lat, pad=ENVELOPE_PAD_DEG):
    """Parcels whose situs address starts '<number> <street>', within a small
    envelope of the geocoded point."""
    where = (f"UPPER({cfg['situs']}) LIKE '{num} {street}%' OR "
             f"UPPER({cfg['situs']}) LIKE '{num} % {street}%'")
    feats = arcgis_query(cfg["url"], {
        "where": where, "outFields": cfg["fields"], "returnGeometry": "false",
        "returnCentroid": "true", "outSR": 4326,
        "geometry": f"{lng - pad},{lat - pad},{lng + pad},{lat + pad}",
        "geometryType": "esriGeometryEnvelope", "inSR": 4326,
        "spatialRel": "esriSpatialRelIntersects", "f": "json"})
    # The second LIKE also admits a directional ('1050 S NORTON'); re-verify.
    return [with_centroid(f) for f in feats
            if street_key((f.get("attributes") or {}).get(cfg["situs"])) == (num, street)]


def la_use_code(ain):
    feats = arcgis_query(USECODE_LAYER, {
        "where": f"AIN='{ain}'", "outFields": "AIN,UseCode",
        "returnGeometry": "false", "f": "json"})
    return (feats[0]["attributes"].get("UseCode") or "").strip() if feats else ""


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


def is_public_owner(county, use_code, use_type):
    """Publicly and institutionally owned parcels are not acquirable."""
    uc = (use_code or "").strip()
    ut = (use_type or "").strip().lower()
    if county == "LA":
        return ut in ("government", "institutional") or uc[:1] in ("7", "8")
    if county == "VC":
        return uc[:1] in ("8", "9")
    if county == "SB":
        return any(k in ut.upper() for k in SB_PUBLIC_KEYWORDS)
    return False


# --------------------------------------------------------------- the screen

def screen(row, county, parcel, lng, lat):
    """Return (verdict, detail). verdict is KEEP, SUSPECT or REJECT."""
    cfg = PARCEL_LAYERS[county]
    lot = row["lotSqft"]
    parcel_area = parcel.get(cfg["area"])

    # Standing rule: no condo/apartment rows.
    if UNIT_NUMBER_RE.search(row["address"]):
        return "REJECT", "unit number in address (condo/apartment)"

    # Standing rule: no parcels already carrying 2+ unit improvements. Also
    # drop publicly and institutionally owned parcels, which are not for sale
    # in any practical sense.
    if county == "LA":
        uc = la_use_code(parcel["AIN"])
        use_type = parcel.get("UseType")
        if uc[:2] in ("02", "03", "04", "05"):
            return "REJECT", f"existing 2+ unit improvements (assessor use code {uc})"
    elif county == "VC":
        uc, use_type = str(parcel.get("SITE_USE") or "").strip(), ""
        if uc and uc[:2] not in ("10", "11"):
            return "REJECT", f"Ventura use code {uc} is not single-family/vacant"
    else:
        uc, use_type = "", str(parcel.get("LandUse") or "")
    if is_public_owner(county, uc, use_type):
        return "REJECT", f"public/institutional owner ({use_type or uc})"

    # Overlays are tested at the parcel centroid. The geocode usually sits in
    # the street, where there is no zoning polygon at all, which reads back as
    # "not residentially zoned" for perfectly good lots.
    ox = parcel.get("_cx") if parcel.get("_cx") is not None else lng
    oy = parcel.get("_cy") if parcel.get("_cy") is not None else lat

    # Fire, coastal and hillside all disqualify, matching sb1123_eligible() in
    # scripts/pipeline/02_enrich.py.
    for fire_layer in FIRE_LAYERS:
        fire = cached_point_flag(fire_layer, ox, oy, "FHSZ_Description", precision=3)
        if fire and str(fire.get("FHSZ_Description") or "").strip().lower() in ("high", "very high"):
            return "REJECT", f"{fire['FHSZ_Description']} fire hazard"
    if inside_layer(COASTAL_LAYER, ox, oy, precision=3):
        return "REJECT", "inside the California Coastal Zone"

    # Zoning exists only inside LA City. There it governs both the residential
    # test and which lot cap applies; elsewhere the flat SB 1123 cap is used.
    in_city = county == "LA" and inside_layer(CITY_LAYER, ox, oy, precision=3)
    max_lot = SF_MAX_LOT_SQFT
    if in_city:
        if inside_layer(HILLSIDE_LAYER, ox, oy):
            return "REJECT", "hillside"
        zone = (cached_point_flag(ZONING_LAYER, ox, oy, "Zoning") or {}).get("Zoning") or ""
        zf = zone_family(zone_class_of(zone))
        if zf == 0:
            return "REJECT", f"not residentially zoned ({zone or '?'})"
        max_lot = MF_MAX_LOT_SQFT if zf == 2 else SF_MAX_LOT_SQFT

    effective_lot = lot or (int(parcel_area) if parcel_area else None)
    if effective_lot and effective_lot > max_lot:
        return "REJECT", (f"lot {effective_lot:,} sf over the "
                          f"{max_lot / 43560:.1f} ac cap")

    # Shared-parcel guard: an MLS lot far smaller than the parcel it sits on is
    # a condo or a fractional interest, not a developable site.
    if lot and parcel_area and parcel_area > lot * SHARED_PARCEL_MULTIPLE:
        return "REJECT", (f"parcel {int(parcel_area):,} sf is {parcel_area / lot:.1f}x "
                          f"the MLS lot {lot:,} sf (shared parcel)")

    # Standing rule: cheap SFR land is usually a mobile home on leased ground.
    if row["type"] == "SFR" and lot and row["price"] and row["price"] / lot < SUSPECT_SFR_PPSF:
        return "SUSPECT", (f"${row['price'] / lot:.0f}/SF land under ${SUSPECT_SFR_PPSF} "
                           f"(possible mobile home)")

    return "KEEP", "ok" if lot else "no MLS lot size, parcel area used"


def tier_for(tiers, lng, lat):
    for name in ("A", "B", "C"):
        for w, s, e, n in tiers.get(name, []):
            if w <= lng <= e and s <= lat <= n:
                return name
    return None


# ------------------------------------------------------------------ the run

def process(row, tiers):
    """Screen one CSV row. Returns an audit dict; 'record' is set when it keeps."""
    out = dict(row, ain="", result="", detail="", record=None)
    if not row["price"]:
        out.update(result="REJECT", detail="no list price")
        return out

    pt = geocode(row["address"], row["city"])
    if not pt:
        out.update(result="NOT LOCATED",
                   detail="address did not geocode (no house number or outside coverage)")
        return out
    lng, lat = pt

    # County bboxes overlap along the LA/Ventura line (West Hills is LA City but
    # sits inside the Ventura box), so a miss falls through to the neighbours
    # rather than being reported as unlocatable.
    county = county_for(row["city"], lng, lat)
    order = [county] + [c for c in ("LA", "VC", "SB") if c != county]
    parcel = how = None
    for cand in order:
        parcel, how, why = match_parcel(cand, lng, lat, row["address"])
        if parcel:
            county = cand
            break
    if not parcel:
        out.update(result="NOT LOCATED",
                   detail=why or f"no parcel at {lat:.5f},{lng:.5f}")
        return out

    cfg = PARCEL_LAYERS[county]
    # Kept exactly as the assessor publishes it: LA and Ventura are plain
    # digits, Santa Barbara is dashed (151-030-026), and the curated records
    # are keyed that way.
    raw_ain = str(parcel.get(cfg["ain"]) or "").strip()
    if not raw_ain:
        out.update(result="NOT LOCATED", detail="parcel has no AIN")
        return out
    ain = cfg["prefix"] + raw_ain
    out["ain"] = ain

    verdict, detail = screen(row, county, parcel, lng, lat)
    out.update(result=verdict, detail=f"{detail} ({how})")
    if verdict == "REJECT":
        return out

    rec = {
        "address": f"{row['address'].upper()} {row['city'].upper()} CA",
        "price": row["price"],
        "type": row["type"],
        "lotSqft": row["lotSqft"] or int(parcel.get(cfg["area"]) or 0) or None,
        "lng": lng, "lat": lat,
        "mls": row["mls"],
    }
    if row["listDate"]:
        rec["listDate"] = row["listDate"]
    t = tier_for(tiers, lng, lat)
    if t:
        rec["tier"] = t
    if verdict == "SUSPECT":
        rec["note"] = detail
    out["record"] = rec
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", required=True, help="folder holding the MLS CSV exports")
    ap.add_argument("--since", help="only import listings on market since this date (YYYY-MM-DD)")
    ap.add_argument("--include-suspect", action="store_true",
                    help="import the sub-$20/SF SFR rows the screen holds out by default")
    ap.add_argument("--dry-run", action="store_true", help="screen and report, write nothing")
    ap.add_argument("--workers", type=int, default=6)
    args = ap.parse_args()

    today = dt.date.today()
    tiers = {k: v for k, v in json.load(open(SOURCES_JSON))["tiers"].items() if k in "ABC"}

    global _geocache
    if os.path.exists(GEOCACHE):
        _geocache = {k: (tuple(v) if v else None)
                     for k, v in json.load(open(GEOCACHE)).items()}

    with open(LISTINGS_JSON, encoding="utf-8") as fh:
        listings = json.load(fh)
    known_mls = {str(v.get("mls") or "").upper() for v in listings.values()}
    before = len(listings)

    csvs = sorted(
        os.path.join(dp, f)
        for dp, _, fns in os.walk(args.source) for f in fns
        if f.lower().endswith(".csv") and not f.lower().startswith("screening results")
    )
    if not csvs:
        sys.exit(f"no MLS CSVs found under {args.source}")

    rows, skipped_known, skipped_old = [], 0, 0
    for path in csvs:
        for row in parse_csv(path, today):
            if row["mls"].upper() in known_mls:
                skipped_known += 1
                continue
            if args.since and row["listDate"] and row["listDate"] < args.since:
                skipped_old += 1
                continue
            rows.append(row)

    print(f"{len(csvs)} CSV(s), {len(rows)} rows to screen "
          f"({skipped_known} already imported"
          + (f", {skipped_old} listed before {args.since}" if args.since else "") + ")")
    if not rows:
        return

    audit = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for i, res in enumerate(pool.map(lambda r: process(r, tiers), rows), 1):
            audit.append(res)
            if i % 25 == 0 or i == len(rows):
                print(f"  screened {i}/{len(rows)}", flush=True)

    added, held = 0, 0
    for res in audit:
        rec = res["record"]
        if not rec:
            continue
        if res["result"] == "SUSPECT" and not args.include_suspect:
            res["result"] = "HELD"
            held += 1
            continue
        if res["ain"] in listings:  # additive only: never overwrite a curated record
            res["result"] = "DUPLICATE"
            res["detail"] = f"AIN already in listings.json (MLS {listings[res['ain']].get('mls')})"
            continue
        listings[res["ain"]] = rec
        added += 1

    counts = {}
    for res in audit:
        counts[res["result"]] = counts.get(res["result"], 0) + 1
    print("\n" + "  ".join(f"{k}: {v}" for k, v in sorted(counts.items())))
    print(f"listings.json: {before} -> {before + added}  (+{added}"
          + (f", {held} suspect held out" if held else "") + ")")

    # The geocode cache is saved even on a dry run: the lookups already cost the
    # Census geocoder a round trip, and a rerun should not pay for them twice.
    with open(GEOCACHE, "w", encoding="utf-8") as fh:
        json.dump({k: list(v) if v else None for k, v in _geocache.items()}, fh)

    stamp = today.isoformat()
    audit_path = os.path.join(args.source, f"Screening Results {stamp}.csv")
    if args.dry_run:
        audit_path = os.path.join(HERE, f"dry-run-audit-{stamp}.csv")

    with open(audit_path, "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        w.writerow(["sheet", "mls", "addr", "city", "ain", "price", "type",
                    "lotSqft", "listDate", "result", "detail"])
        for r in audit:
            w.writerow([r["sheet"], r["mls"], r["address"], r["city"], r["ain"],
                        r["price"], r["type"], r["lotSqft"], r["listDate"],
                        r["result"], r["detail"]])

    if args.dry_run:
        print(f"\ndry run: listings.json untouched, audit at {audit_path}")
        return

    with open(LISTINGS_JSON, "w", encoding="utf-8") as fh:
        json.dump({k: listings[k] for k in sorted(listings)}, fh, indent=1)
        fh.write("\n")

    print(f"\nwrote data/listings.json")
    print(f"wrote {audit_path}")
    print("\nreview, then:  git add data/listings.json && git commit -m 'listings: "
          f"import {stamp}' && git push")


if __name__ == "__main__":
    main()
