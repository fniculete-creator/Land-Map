"""Build the Overlay dropdown layers for LA County: data/overlay_oz.json, data/overlay_hr.json, data/overlay_qct.json.

usage: python scripts/overlays/build_overlays.py [--work DIR]
- OZ: federal Opportunity Zones (2018 designations), HUD eGIS Opportunity_Zones, Los Angeles County tracts.
- High Resource: CTCAC/HCD 2026 Opportunity Map (final), High and Highest Resource areas in Los Angeles County,
  from the Treasurer's GeoPackage (downloaded to --work).
- QCT/DDA: HUD 2026 Qualified Census Tracts (Los Angeles County) and 2026 Difficult Development Areas (ZIP areas in LA County).
Each layer is dissolved by category and simplified (about 5 m) so it ships small. OZ 2.0 stays in data/oz2.json.
Built 10/24/2026."""
import argparse, io, json, os, sqlite3, struct, time, urllib.parse, urllib.request, zipfile
from shapely import wkb
from shapely.geometry import shape, mapping, box
from shapely.ops import unary_union

ap = argparse.ArgumentParser()
HERE = os.path.dirname(os.path.abspath(__file__))
ap.add_argument("--work", default=os.path.join(HERE, "_work"))
A = ap.parse_args(); os.makedirs(A.work, exist_ok=True)
REPO = os.path.dirname(os.path.dirname(HERE))
HUD = "https://services.arcgis.com/VTyQ9soqVukalItT/arcgis/rest/services"
TCAC = "https://www.treasurer.ca.gov/sites/default/files/2025-11/shapefile.zip"   # final_opp_2026_public.gpkg
LA_BOX = box(-118.95, 33.70, -117.64, 34.83)                                     # LA County mainland


def get(url, data=None, raw=False):
    for i in range(5):
        try:
            req = urllib.request.Request(url, data=urllib.parse.urlencode(data).encode() if data else None,
                                         headers={"User-Agent": "Mozilla/5.0"})
            body = urllib.request.urlopen(req, timeout=180).read()
            return body if raw else json.loads(body)
        except Exception as e:
            err = e; time.sleep(4 * (i + 1))
    raise err


def hud(service, where):
    feats, off = [], 0
    while True:
        r = get(f"{HUD}/{service}/query", {"where": where, "outFields": "*", "outSR": 4326, "f": "geojson",
                                            "resultOffset": off, "resultRecordCount": 1000, "orderByFields": "OBJECTID"})
        fs = r.get("features", [])
        feats += fs; off += len(fs)
        if len(fs) < 1000: return feats


def rnd(c):
    return [round(c[0], 5), round(c[1], 5)] if isinstance(c[0], float) else [rnd(x) for x in c]


def write(name, groups, label):
    feats = []
    for cat, geoms in groups.items():
        u = unary_union(geoms).buffer(0).simplify(0.00005).intersection(LA_BOX)
        if u.is_empty: continue
        g = json.loads(json.dumps(mapping(u), default=list)); g["coordinates"] = rnd(g["coordinates"])
        feats.append({"type": "Feature", "properties": {"cat": cat}, "geometry": g})
    json.dump({"type": "FeatureCollection", "name": label, "features": feats},
              open(os.path.join(REPO, "data", name), "w"), separators=(",", ":"))
    print(name, {f["properties"]["cat"]: f["geometry"]["type"] for f in feats},
          round(os.path.getsize(os.path.join(REPO, "data", name)) / 1024), "KB")


# OZ (2018)
oz = hud("Opportunity_Zones/FeatureServer/13", "STATE='06' AND COUNTY='037'")
print(len(oz), "OZ tracts")
write("overlay_oz.json", {"OZ": [shape(f["geometry"]) for f in oz if f.get("geometry")]}, "Opportunity Zones (2018)")

# QCT + DDA (2026)
qct = hud("QUALIFIED_CENSUS_TRACTS_2026/FeatureServer/0", "STATE='06' AND COUNTY='037'")
dda = [f for f in hud("Difficult_Development_Areas_2026/FeatureServer/0", "ZCTA5 LIKE '90%' OR ZCTA5 LIKE '91%' OR ZCTA5 LIKE '93%'")
       if f.get("geometry") and shape(f["geometry"]).intersects(LA_BOX)]
print(len(qct), "QCT tracts;", len(dda), "DDA ZIP areas")
write("overlay_qct.json", {"QCT": [shape(f["geometry"]) for f in qct if f.get("geometry")],
                           "DDA": [shape(f["geometry"]) for f in dda]}, "QCT and DDA (2026)")

# High Resource (CTCAC/HCD 2026)
gpkg = os.path.join(A.work, "final_opp_2026_public.gpkg")
if not os.path.exists(gpkg):
    z = zipfile.ZipFile(io.BytesIO(get(TCAC, raw=True)))
    z.extract("final_opp_2026_public.gpkg", A.work)


def gpkg_geom(b):
    flags = b[3]; env = (flags >> 1) & 7
    return wkb.loads(bytes(b[8 + {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}[env]:]))


c = sqlite3.connect(gpkg)
rows = c.execute("SELECT oppcat, geom FROM final_opp_2026_public WHERE county_name='Los Angeles' "
                 "AND oppcat IN ('High Resource','Highest Resource')").fetchall()
print(len(rows), "High/Highest Resource areas")
groups = {}
for cat, g in rows:
    groups.setdefault(cat, []).append(gpkg_geom(g).buffer(0))
write("overlay_hr.json", groups, "High Resource (CTCAC/HCD 2026)")
