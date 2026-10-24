"""Build data/sold_land.json: closed sales of residential vacant land in the City of LA since 01/01/2024 (the SB 1123 Sold switch).

usage: python scripts/comps/build_land_sales.py [--work DIR] [--since 2024-01-01]
Parcels: 2026 LA County assessor roll, City of LA, residential vacant use codes (0xxV) with a recording since --since.
Sales: the Assessor portal ownership history per AIN (public), kept when it is a "Sale for Consideration" of one parcel
(multi-parcel assemblage deeds carry a combined price and are dropped) at $50,000 or more, recorded on or after --since.
Keyed by AIN: latest sale {d, p} plus earlier kept sales. Land $/SF is computed in the app from the tile lot size.
Built 10/24/2026."""
import argparse, concurrent.futures as cf, datetime, json, os, threading, time, urllib.parse, urllib.request

ap = argparse.ArgumentParser()
HERE = os.path.dirname(os.path.abspath(__file__))
ap.add_argument("--work", default=os.path.join(HERE, "_work"))
ap.add_argument("--since", default="2024-01-01")
A = ap.parse_args(); os.makedirs(A.work, exist_ok=True)
REPO = os.path.dirname(os.path.dirname(HERE))
ROLL = "https://services.arcgis.com/RmCCgQtiZLDCtblq/ArcGIS/rest/services/Assessor%20Parcel%20Data%20Roll%202026/FeatureServer/0/query"
HIST = "https://portal.assessor.lacounty.gov/api/parcel_ownershiphistory?ain="


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


w = f"TaxRateArea_CITY='LOS ANGELES' AND UseCode LIKE '0%V' AND RecordingDate >= DATE '{A.since}'"
ains, off = [], 0
while True:
    r = fetch(ROLL, {"where": w, "outFields": "AIN", "orderByFields": "AIN", "resultOffset": off, "resultRecordCount": 2000,
                     "returnGeometry": "false", "f": "json"})
    fs = [f["attributes"]["AIN"] for f in r.get("features", [])]
    ains += fs; off += len(fs)
    if not fs or (len(fs) < 2000 and not r.get("exceededTransferLimit")): break
print(len(ains), "vacant parcels recorded since", A.since)

CACHE = os.path.join(A.work, "land_history.json")
hist = json.load(open(CACHE)) if os.path.exists(CACHE) else {}
lock = threading.Lock()


def one(a):
    try:
        h = fetch(HIST + a).get("Parcel_OwnershipHistory") or []
    except Exception:
        return
    with lock:
        hist[a] = h


with cf.ThreadPoolExecutor(6) as ex:
    list(ex.map(one, [a for a in ains if a not in hist]))
json.dump(hist, open(CACHE, "w"))

since = datetime.date.fromisoformat(A.since)
out = {}
for a in ains:
    sales = []
    for s in hist.get(a, []):
        if not (s.get("DocumentTypeDesc") or "").startswith("Sale for Consideration"): continue
        if str(s.get("NumberOfParcels") or "1").strip() not in ("1", "0", ""): continue
        try:
            p = int(float(s.get("DTTSalePrice") or 0)); d = datetime.datetime.strptime(s["RecordingDate"], "%m/%d/%Y").date()
        except Exception:
            continue
        if p >= 50000 and d >= since: sales.append({"d": d.isoformat(), "p": p})
    if sales:
        sales.sort(key=lambda x: x["d"], reverse=True)
        out[a] = {**sales[0], "prior": sales[1:]}
print(len(out), "parcels with a kept sale;", sum(1 + len(v["prior"]) for v in out.values()), "sales")
json.dump(out, open(os.path.join(REPO, "data", "sold_land.json"), "w"), separators=(",", ":"))
