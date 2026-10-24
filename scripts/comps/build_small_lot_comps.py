"""Build data/comps_small_lot.json: sale comps of finished small lot homes in the City of LA, for SB 1123 underwriting.

usage: python scripts/comps/build_small_lot_comps.py [--work DIR] [--slo-work DIR]
Homes: (a) every 2026 LA County assessor roll parcel in the City of LA with a small lot use code (01S*) built 2005 or later, plus
(b) the new homes in built Small Lot Ordinance cases (scripts/slo/build_slo.py working files: cases.json, ain.json, roll.json).
Sales: the Assessor portal's ownership history per AIN (public, free), kept when it is a "Sale for Consideration" of one parcel
with a transfer-tax price of $150,000 or more, recorded no earlier than the year before the home was built. The earliest kept sale
after construction, within 2 years of the build year, is flagged as the new-construction sale; prices under $200/SF are dropped. Prices are the County's DTT-derived figures, not MLS.
Built 10/24/2026."""
import argparse, collections, concurrent.futures as cf, datetime, json, os, re, threading, time, urllib.parse, urllib.request

ap = argparse.ArgumentParser()
HERE = os.path.dirname(os.path.abspath(__file__))
ap.add_argument("--work", default=os.path.join(HERE, "_work"))
ap.add_argument("--slo-work", default=os.path.join(os.path.dirname(HERE), "slo", "_work"))
A = ap.parse_args(); os.makedirs(A.work, exist_ok=True)
REPO = os.path.dirname(os.path.dirname(HERE))
ROLL = "https://services.arcgis.com/RmCCgQtiZLDCtblq/ArcGIS/rest/services/Assessor%20Parcel%20Data%20Roll%202026/FeatureServer/0/query"
HIST = "https://portal.assessor.lacounty.gov/api/parcel_ownershiphistory?ain="
F = "AIN,UseCode,YearBuilt,SQFTmain,Bedrooms,Bathrooms,SitusHouseNo,SitusFraction,SitusDirection,SitusStreet,SitusUnit,SitusZIP5,CENTER_LAT,CENTER_LON"


def fetch(url, data=None, tries=5):
    err = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, data=urllib.parse.urlencode(data).encode() if data else None,
                                         headers={"User-Agent": "Mozilla/5.0"})
            return json.load(urllib.request.urlopen(req, timeout=60))
        except Exception as e:
            err = e; time.sleep(3 * (i + 1))
    raise err


# ---- 1. homes ----
homes = {}
w = "UseCode LIKE '01S%' AND YearBuilt>='2005' AND TaxRateArea_CITY='LOS ANGELES'"
off = 0
while True:
    r = fetch(ROLL, {"where": w, "outFields": F, "orderByFields": "AIN", "resultOffset": off, "resultRecordCount": 2000,
                     "returnGeometry": "false", "f": "json"})
    fs = [f["attributes"] for f in r.get("features", [])]
    for a in fs: homes[a["AIN"]] = a
    off += len(fs)
    if not fs or (len(fs) < 2000 and not r.get("exceededTransferLimit")): break
print(len(homes), "small lot use-code homes")
case_of = {}
cases = json.load(open(os.path.join(A.slo_work, "cases.json")))
ain = json.load(open(os.path.join(A.slo_work, "ain.json")))
for r in cases:
    a = ain.get(r.get("PIN"))
    if a: case_of.setdefault(a, re.sub(r"(-SL(?:-[A-Z]*HCA|-CN|-[A-Z]{2,4}HCA)?)(?:-(?:M\d+|\d+A|A\d+|\d+))+$",
                                       lambda m: m.group(1), r["CASE_NUM"]))
extra = [a for a in case_of if a not in homes]
for i in range(0, len(extra), 200):
    chunk = extra[i:i + 200]
    r = fetch(ROLL, {"where": "AIN IN (" + ",".join(f"'{a}'" for a in chunk) + ") AND YearBuilt>='2005' AND UseType IN ('SFR','CND')",
                     "outFields": F, "returnGeometry": "false", "f": "json"})
    for f in r.get("features", []): homes[f["attributes"]["AIN"]] = f["attributes"]
print(len(homes), "homes with the SLO case homes added")

# ---- 2. sale history per AIN (cached) ----
CACHE = os.path.join(A.work, "history.json")
hist = json.load(open(CACHE)) if os.path.exists(CACHE) else {}
lock = threading.Lock()
todo = [a for a in homes if a not in hist]


def one(a):
    try:
        h = fetch(HIST + a).get("Parcel_OwnershipHistory") or []
    except Exception:
        return
    with lock:
        hist[a] = h


with cf.ThreadPoolExecutor(6) as ex:
    for i, _ in enumerate(ex.map(one, todo), 1):
        if i % 250 == 0:
            with lock: json.dump(hist, open(CACHE, "w"))
            print(i, "/", len(todo), "histories")
json.dump(hist, open(CACHE, "w"))
print(len(hist), "histories cached;", sum(1 for a in homes if a not in hist), "missing")


# ---- 3. comps ----
def addr(h):
    parts = [str(h.get("SitusHouseNo") or "").strip(), (h.get("SitusFraction") or "").strip(), (h.get("SitusDirection") or "").strip(),
             " ".join((h.get("SitusStreet") or "").split()).title()]
    s = " ".join(p for p in parts if p and p != "0")
    s = re.sub(r"(\d)(St|Nd|Rd|Th)\b", lambda m: m.group(1) + m.group(2).lower(), s)
    u = (h.get("SitusUnit") or "").strip()
    return s + (f" #{u}" if u else "")


# homes with no street address or ZIP on the roll: take them from the Assessor parcel page (cached)
DCACHE = os.path.join(A.work, "detail.json")
det = json.load(open(DCACHE)) if os.path.exists(DCACHE) else {}
for a, h in homes.items():
    if (str(h.get("SitusHouseNo") or "").strip() in ("", "0") or not str(h.get("SitusZIP5") or "").strip()) and a in hist:
        if a not in det:
            try: det[a] = fetch("https://portal.assessor.lacounty.gov/api/parceldetail?ain=" + a).get("Parcel") or {}
            except Exception: det[a] = {}
        d = det[a]
        if d.get("SitusStreet"):
            h["SitusHouseNo"], h["SitusFraction"], h["SitusDirection"], h["SitusUnit"] = "", "", "", ""
            h["SitusStreet"] = d["SitusStreet"]
        if (d.get("SitusZipCode") or "").strip(): h["SitusZIP5"] = d["SitusZipCode"][:5]
        h["_lot"] = (re.search(r"\bLOT (\w+)", d.get("LegalDescription") or "") or [None, None])[1]
json.dump(det, open(DCACHE, "w"))

out = []
for a, h in homes.items():
    yb = int(h["YearBuilt"]) if str(h.get("YearBuilt") or "").isdigit() else None
    sf = int(h["SQFTmain"]) if h.get("SQFTmain") else None
    sales = []
    for s in hist.get(a, []):
        if not (s.get("DocumentTypeDesc") or "").startswith("Sale for Consideration"): continue
        if str(s.get("NumberOfParcels") or "1").strip() not in ("1", "0", ""): continue
        try:
            price = int(float(s.get("DTTSalePrice") or 0)); d = datetime.datetime.strptime(s["RecordingDate"], "%m/%d/%Y").date()
        except Exception:
            continue
        if price < 150000 or (yb and d.year < yb - 1): continue
        if sf and price / sf < 200: continue                 # partial-interest or non-market price
        sales.append((d, price))
    sales.sort()
    for i, (d, price) in enumerate(sales):
        out.append({"ain": a, "a": addr(h), "z": str(h.get("SitusZIP5") or "")[:5], "d": d.isoformat(), "p": price,
                    "sf": sf, "ppsf": round(price / sf) if sf else None, "bd": h.get("Bedrooms") or None, "ba": h.get("Bathrooms") or None,
                    "yb": yb, "n": 1 if i == 0 and (not yb or d.year <= yb + 2) else 0, "c": case_of.get(a),
                    "lat": round(h["CENTER_LAT"], 6) if h.get("CENTER_LAT") else None,
                    "lng": round(h["CENTER_LON"], 6) if h.get("CENTER_LON") else None})
# still no address (new lots the County has not addressed yet): the SLO case address plus the lot number
slo = json.load(open(os.path.join(REPO, "data", "slo.json")))
for o in out:
    sc = slo.get(o["c"] or "")
    if not o["a"].strip() and sc:
        lot = homes[o["ain"]].get("_lot")
        o["a"] = sc["address"] + (f", Lot {lot}" if lot else "")
    if not o["z"].strip() and sc:
        o["z"] = sc["zip"]
out = [o for o in out if o["lat"]]
out.sort(key=lambda o: o["d"], reverse=True)
print(len(out), "sales on", len({o["ain"] for o in out}), "homes;", sum(o["n"] for o in out), "new-construction sales;",
      "since 2025:", sum(1 for o in out if o["d"] >= "2025-01-01"))
json.dump(out, open(os.path.join(REPO, "data", "comps_small_lot.json"), "w"), separators=(",", ":"))
