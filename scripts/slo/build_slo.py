"""Build data/slo.json: every LA City Small Lot Ordinance subdivision (ZIMAS cases with SL: AA parcel maps, TT/VTT tract maps,
2005 to date), one record per case, with built homes from the 2026 LA County assessor roll.

usage: python scripts/slo/build_slo.py [--work DIR]
Steps: (1) ZIMAS case table zim4s.search_case, CASE_NUM like -SL (not -SLD design reviews) -> PIN per lot; (2) PIN -> AIN on the
City landbase, then the assessor roll for each AIN; (3) per case: address range, lots, built = 2+ new SFR/condo homes on the roll
(year built at or after 2005 and the filing year), home count, size range, completion years, location (roll centroids, else the
landbase parcel). Modification cases (-M1, -1A, -A2) fold into the original case. Cases with no location are dropped.
Built 10/23/2026 (797 cases: 365 built with 3,501 homes, 432 not built)."""
import argparse, collections, json, os, re, statistics, time, urllib.parse, urllib.request
ap = argparse.ArgumentParser(); ap.add_argument("--work", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "_work"))
A = ap.parse_args(); os.makedirs(A.work, exist_ok=True); D = A.work
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ROLL = "https://services.arcgis.com/RmCCgQtiZLDCtblq/ArcGIS/rest/services/Assessor%20Parcel%20Data%20Roll%202026/FeatureServer/0/query"


def post(url, params, tries=5):
    err = None
    for _ in range(tries):
        try:
            req = urllib.request.Request(url, data=urllib.parse.urlencode(params).encode(), headers={"User-Agent": "Mozilla/5.0"})
            return json.load(urllib.request.urlopen(req, timeout=120))
        except Exception as e:
            err = e; time.sleep(5)
    raise err

# ---- 1. cases ----
OUT = os.path.join(D, "cases.json")
layer = json.dumps({"id": 0, "source": {"type": "dataLayer", "dataSource": {"type": "table", "workspaceId": "w2", "dataSourceName": "zim4s.search_case"}}})
base = "https://zimas.lacity.org/arcgis/rest/services/zm4/landbase/MapServer/dynamicLayer/query"


def q(p):
    for _ in range(5):
        try:
            req = urllib.request.Request(base, data=urllib.parse.urlencode(p).encode(), headers={"User-Agent": "Mozilla/5.0"})
            return json.load(urllib.request.urlopen(req, timeout=120))
        except Exception as e:
            err = e; time.sleep(4)
    raise err


p0 = {"layer": layer, "where": "CASE_NUM LIKE '%-SL%'", "outFields": "*", "returnGeometry": "false", "f": "json", "orderByFields": "CASE_NUM,PIN"}
rows, off = [], 0
first = q(dict(p0, resultRecordCount=3)); print("fields:", [f["name"] for f in first.get("fields", [])]); print(first.get("features", [])[:3])
while True:
    r = q(dict(p0, resultOffset=off, resultRecordCount=1000))
    fs = [f["attributes"] for f in r.get("features", [])]
    rows += fs
    if len(fs) < 1000 and not r.get("exceededTransferLimit"):
        break
    off += len(fs)
    if not fs: break
pat = re.compile(r"-SL(-|$)")
keep = [x for x in rows if pat.search(x.get("CASE_NUM") or "")]
print(len(rows), "rows;", len(keep), "true -SL rows;", len({x["CASE_NUM"] for x in keep}), "cases")
json.dump(keep, open(OUT, "w"))

# ---- 2. parcels ----
rows = json.load(open(os.path.join(D, "cases.json")))
pins = sorted({r["PIN"] for r in rows if r.get("PIN")})
LB = "https://maps.lacity.org/arcgis/rest/services/Core/Master_landbase/MapServer/2/query"
ain = {}
for i in range(0, len(pins), 150):
    chunk = pins[i:i + 150]
    w = "PIN IN (" + ",".join("'" + p.replace("'", "''") + "'" for p in chunk) + ")"
    r = post(LB, {"where": w, "outFields": "PIN,BPP", "returnGeometry": "false", "f": "json"})
    for f in r.get("features", []):
        a = f["attributes"]
        if a.get("BPP"): ain[a["PIN"]] = a["BPP"]
print(len(pins), "pins ->", len(ain), "AINs")
json.dump(ain, open(os.path.join(D, "ain.json"), "w"))
ains = sorted(set(ain.values()))
roll = {}
F = "AIN,UseType,UseCode,YearBuilt,EffectiveYearBuilt,SQFTmain,Units,Bedrooms,Bathrooms,RecordingDate,SitusHouseNo,SitusStreet,SitusUnit,SitusZIP5,SitusCity,CENTER_LAT,CENTER_LON,Roll_LandValue,Roll_ImpValue,Roll_LandBaseYear"
for i in range(0, len(ains), 200):
    chunk = ains[i:i + 200]
    r = post(ROLL, {"where": "AIN IN (" + ",".join(f"'{a}'" for a in chunk) + ")", "outFields": F, "returnGeometry": "false", "f": "json"})
    for f in r.get("features", []):
        roll[f["attributes"]["AIN"]] = f["attributes"]
print(len(ains), "AINs ->", len(roll), "roll rows")
json.dump(roll, open(os.path.join(D, "roll.json"), "w"))

# ---- 3. one record per case ----
rows = json.load(open(os.path.join(D, "cases.json")))
ain = json.load(open(os.path.join(D, "ain.json")))
roll = json.load(open(os.path.join(D, "roll.json")))
LB = "https://maps.lacity.org/arcgis/rest/services/Core/Master_landbase/MapServer/2/query"


def title(s):
    s = " ".join((s or "").split()).title()
    s = re.sub(r"(\d)(St|Nd|Rd|Th)\b", lambda m: m.group(1) + m.group(2).lower(), s)
    return re.sub(r"\b(N|S|E|W)\b", lambda m: m.group(1).upper(), s)


def addr_range(addrs):
    by = collections.defaultdict(list)
    for a in addrs:
        a = re.sub(r"\s+\d+[/-]\d+(?=\s)", "", a)
        m = re.match(r"^(\d+)\s+(.*)$", a.strip())
        if m: by[m.group(2)].append(int(m.group(1)))
    if not by: return title(addrs[0]) if addrs else ""
    st, nums = max(by.items(), key=lambda kv: len(kv[1]))
    lo, hi = min(nums), max(nums)
    return title(f"{lo}{'-' + str(hi) if hi != lo else ''} {st}")


cases = collections.defaultdict(list)
def base_case(cn):                                   # fold modifications (-M1, -1A, -A2 ...) into the original case
    return re.sub(r"(-SL(?:-[A-Z]*HCA|-CN|-[A-Z]{2,4}HCA)?)(?:-(?:M\d+|\d+A|A\d+|\d+))+$", lambda m: m.group(1), cn)
for r in rows:
    cases[base_case(r["CASE_NUM"])].append(r)
out, missing_xy = {}, []
for cn, rs in cases.items():
    pins = sorted({r["PIN"] for r in rs if r.get("PIN")})
    ains = sorted({ain[p] for p in pins if p in ain})
    rr = [roll[a] for a in ains if a in roll]
    m = re.match(r"^(AA|TT|VTT|PMLA|PM)-(\d{4})-", cn)
    filed = int(m.group(2)) if m and m.group(1) == "AA" else None
    kind = "Parcel map" if cn.startswith("AA") else "Tract map"
    new = [x for x in rr if x["UseType"] in ("SFR", "CND") and str(x.get("YearBuilt") or "0").isdigit() and int(x["YearBuilt"] or 0) >= max(2005, filed or 2005)]
    sfs = [int(x["SQFTmain"]) for x in new if x.get("SQFTmain")]
    yrs = sorted(int(x["YearBuilt"]) for x in new)
    built = len(new) >= 2
    addrs = [r["ADDRESS"] for r in rs if r.get("ADDRESS")]
    lat = statistics.mean(x["CENTER_LAT"] for x in rr if x.get("CENTER_LAT")) if any(x.get("CENTER_LAT") for x in rr) else None
    lng = statistics.mean(x["CENTER_LON"] for x in rr if x.get("CENTER_LON")) if any(x.get("CENTER_LON") for x in rr) else None
    rec = {"case": cn, "kind": kind, "filed": filed, "address": addr_range(addrs) if addrs else "", "community": title(rs[0].get("COMMUNITY") or ""),
           "zip": str(rs[0].get("ZIP") or ""), "lots": len(pins), "ains": ains, "status": "built" if built else "not built",
           "homes": len(new) if built else None, "avgSf": round(statistics.mean(sfs)) if built and sfs else None,
           "minSf": min(sfs) if built and sfs else None, "maxSf": max(sfs) if built and sfs else None,
           "completed": (str(yrs[0]) if yrs[0] == yrs[-1] else f"{yrs[0]}-{yrs[-1]}") if built else None,
           "lat": round(lat, 6) if lat else None, "lng": round(lng, 6) if lng else None}
    if lat is None: missing_xy.append(cn)
    out[cn] = rec
# locate cases with no roll rows from the City landbase parcels (centroid in WGS84)
for cn in missing_xy:
    pins = sorted({r["PIN"] for r in cases[cn] if r.get("PIN")})[:50]
    if not pins: continue
    r = post(LB, {"where": "PIN IN (" + ",".join("'" + p + "'" for p in pins) + ")", "outFields": "PIN", "returnGeometry": "true", "outSR": 4326, "f": "json"})
    pts = [pt for f in r.get("features", []) for ring in f["geometry"].get("rings", [])[:1] for pt in ring]
    if pts:
        out[cn]["lng"] = round(sum(p[0] for p in pts) / len(pts), 6); out[cn]["lat"] = round(sum(p[1] for p in pts) / len(pts), 6)
out = {k: v for k, v in out.items() if v["lat"]}
for v in out.values():
    v.pop("ains")
n_loc = sum(1 for v in out.values() if v["lat"])
st = collections.Counter(v["status"] for v in out.values())
print(len(out), "cases;", n_loc, "located;", dict(st), "; built homes:", sum(v["homes"] or 0 for v in out.values()))
json.dump(out, open(os.path.join(REPO, "data", "slo.json"), "w"), indent=1, ensure_ascii=True)
