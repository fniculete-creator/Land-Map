"""Add completion and sale status to data/ed1.json (run after build_ed1.py, which rewrites the file).

usage: python scripts/ed1/build_ed1_status.py [--work DIR]
Completed: LADBS Certificate of Occupancy records (data.lacity.org 3f9m-afei) for a new building (permit type Bldg-New) on the
case's APN, issued on or after the case's filing date -> "cofo": {"d": "MM/DD/YYYY", "permit": PCIS number, "desc": work
description}. Sold: the Assessor portal ownership history for the APN (public) -> sales for consideration recorded after the
case was filed: "sales": [{"d", "p", "parcels"}], and "sold": the latest sale after the CofO (type "Completed building"), else after the approval (type "Entitled site").
A multi-parcel deed carries the combined price for the whole site. Also adds applicant / applicantCompany / rep / repCompany / staff from the City case pages that build_ed1.py caches,
"purchased" (the latest sale for consideration on or before filing), and units from data/permits.json when the case text had none
(run scripts/permits/build_permits.py first). Built 10/24/2026."""
import argparse, concurrent.futures as cf, datetime, json, os, threading, time, urllib.parse, urllib.request

ap = argparse.ArgumentParser()
HERE = os.path.dirname(os.path.abspath(__file__))
ap.add_argument("--work", default=os.path.join(HERE, "_work"))
A = ap.parse_args(); os.makedirs(A.work, exist_ok=True)
REPO = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(REPO, "data", "ed1.json")
COFO = "https://data.lacity.org/resource/3f9m-afei.json"
HIST = "https://portal.assessor.lacounty.gov/api/parcel_ownershiphistory?ain="


def get(url, tries=5):
    err = None
    for i in range(tries):
        try:
            return json.load(urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=90))
        except Exception as e:
            err = e; time.sleep(3 * (i + 1))
    raise err


def npar(s):                                           # "NumberOfParcels": "1", "3", "2+"
    digits = "".join(ch for ch in str(s.get("NumberOfParcels") or "1") if ch.isdigit())
    return int(digits) if digits else 1


def mdy(s):
    return datetime.datetime.strptime(s, "%m/%d/%Y").date() if s else None


ed1 = json.load(open(OUT, encoding="utf-8"))
apns = sorted({c["apn"] for c in ed1.values() if c.get("apn")})
print(len(apns), "ED 1 APNs")

# ---- Certificates of Occupancy for new buildings on those APNs ----
cofos = {}
for i in range(0, len(apns), 40):
    ors = " OR ".join(f"(assessor_book='{a[:4]}' AND assessor_page='{a[5:8]}' AND assessor_parcel='{a[9:12]}')" for a in apns[i:i + 40])
    q = {"$where": f"permit_type='Bldg-New' AND ({ors})", "$limit": 5000,
         "$select": "assessor_book,assessor_page,assessor_parcel,cofo_issue_date,pcis_permit,work_description,permit_sub_type"}
    for r in get(COFO + "?" + urllib.parse.urlencode(q)):
        if not r.get("cofo_issue_date"): continue
        a = f"{r['assessor_book']}-{r['assessor_page']}-{r['assessor_parcel']}"
        cofos.setdefault(a, []).append(r)
print(len(cofos), "APNs with a new-building CofO")

# ---- sale history per APN (cached) ----
CACHE = os.path.join(A.work, "ed1_history.json")
hist = json.load(open(CACHE)) if os.path.exists(CACHE) else {}
lock = threading.Lock()


def one(a):
    try:
        h = get(HIST + a.replace("-", ""), tries=2).get("Parcel_OwnershipHistory") or []
    except Exception:
        h = []                                         # cached as empty so reruns do not retry dead parcels
    with lock:
        hist[a] = h


with cf.ThreadPoolExecutor(6) as ex:
    list(ex.map(one, [a for a in apns if a not in hist]))
json.dump(hist, open(CACHE, "w"))

n_c = n_s = 0
for c in ed1.values():
    c.pop("cofo", None); c.pop("sales", None); c.pop("sold", None)
    a, filed = c.get("apn"), mdy(c.get("filed"))
    if not a: continue
    rs = [r for r in cofos.get(a, []) if not filed or r["cofo_issue_date"][:10] >= filed.isoformat()]
    if rs:
        r = max(rs, key=lambda r: r["cofo_issue_date"])
        d = datetime.date.fromisoformat(r["cofo_issue_date"][:10])
        c["cofo"] = {"d": d.strftime("%m/%d/%Y"), "permit": r.get("pcis_permit"), "desc": (r.get("work_description") or "").strip()}
        n_c += 1
    sales = []
    for s in hist.get(a, []):
        if not (s.get("DocumentTypeDesc") or "").startswith("Sale for Consideration"): continue
        try:
            p = int(float(s.get("DTTSalePrice") or 0)); d = datetime.datetime.strptime(s["RecordingDate"], "%m/%d/%Y").date()
        except Exception:
            continue
        if p > 0 and filed and d > filed:
            sales.append({"d": d.strftime("%m/%d/%Y"), "p": p, "parcels": npar(s)})
    if sales:
        sales.sort(key=lambda x: mdy(x["d"]), reverse=True)
        c["sales"] = sales
        # Sold: the latest sale after the CofO (a finished building); else after the approval (an entitled site)
        if c.get("cofo"):
            after = [s for s in sales if mdy(s["d"]) >= mdy(c["cofo"]["d"])]
            if after:
                c["sold"] = {**after[0], "type": "Completed building"}; n_s += 1
        if not c.get("sold") and c.get("approved"):
            after = [s for s in sales if mdy(s["d"]) >= mdy(c["approved"])]
            if after:
                c["sold"] = {**after[0], "type": "Entitled site"}
# ---- people, purchase, permit units (City case pages cached by build_ed1.py; data/permits.json) ----
import re
pdis = json.load(open(os.path.join(A.work, "pdis.json"), encoding="utf-8")) if os.path.exists(os.path.join(A.work, "pdis.json")) else {}
permits = json.load(open(os.path.join(REPO, "data", "permits.json"), encoding="utf-8")) if os.path.exists(os.path.join(REPO, "data", "permits.json")) else {}


def person(v):                                         # "Simon Aftalion [Company: Passo Saltair, LP]" -> (name, company)
    m = re.match(r"\s*(.*?)\s*(?:\[Company:\s*(.*?)\])?\s*$", v or "")
    return (m.group(1) or None, (m.group(2) or None)) if m else (None, None)


for k, c in ed1.items():
    # units start from the City case text each run (build_ed1.py's figure), then the fills below
    if "unitsCase" not in c:
        c["unitsCase"], c["affordableCase"] = c.get("units"), c.get("affordableUnits")
    c["units"], c["affordableUnits"] = c["unitsCase"], c["affordableCase"]
    for f in ("applicant", "applicantCompany", "rep", "repCompany", "staff", "purchased", "unitsSource"):
        c.pop(f, None)
    pg = pdis.get(k) or {}
    c["applicant"], c["applicantCompany"] = person(pg.get("Applicant"))
    c["rep"], c["repCompany"] = person(pg.get("Representative"))
    c["staff"] = (pg.get("Staff Assigned") or "").title() or None
    a, filed = c.get("apn"), mdy(c.get("filed"))
    if a and filed:
        before = []
        for s_ in hist.get(a, []):
            if not (s_.get("DocumentTypeDesc") or "").startswith("Sale for Consideration"): continue
            try:
                d = datetime.datetime.strptime(s_["RecordingDate"], "%m/%d/%Y").date(); pr = int(float(s_.get("DTTSalePrice") or 0))
            except Exception:
                continue
            if d <= filed: before.append((d, pr, npar(s_)))
        if before:
            d, pr, n = max(before)
            c["purchased"] = {"d": d.strftime("%m/%d/%Y"), "p": pr or None, "parcels": n}
    pm = permits.get((a or "").replace("-", ""), [])
    if c.get("units") is None and pm and pm[0].get("du"):
        c["units"] = c["affordableUnits"] = pm[0]["du"]; c["unitsSource"] = "LADBS Permit"
    elif c.get("units") is not None:
        c["unitsSource"] = "Planning Case"
    if not c.get("cofo"):
        done = [q for q in pm if q.get("cofo") and (not filed or mdy(q["cofo"]) >= filed)]
        if done:
            q = max(done, key=lambda q: mdy(q["cofo"]))
            c["cofo"] = {"d": q["cofo"], "permit": q["n"], "desc": q.get("desc", "")}
# ---- units still missing: (1) a stronger read of the case text, (2) the other ED 1 case on the site, (3) the LADBS permit
# named in the text or filed at the address (data.lacity.org issued + submitted permits) ----
UNIT_RE = re.compile(r"(\d[\d,]*)\)?\s*(?:total\s+|new\s+|residential\s+|dwelling\s+|affordable\s+|apartment\s+|housing\s+|rental\s+|"
                     r"supportive\s+|permanent\s+|income[- ]restricted\s+|restricted\s+|senior\s+|family\s+|shared\s+|housing\s+|"
                     r"\(?(?:vl|l|m|eli|vli|li|mod)[;,/ ]*(?:l|m|vl)?[;,/ ]*(?:m)?\)?\s*)*(?:units?|apartments|apts?|du|rdu)\b", re.I)
MGR_RE = re.compile(r"(\d+)\s+affordable\b.*?\band\s+(\d+)\s+manager", re.I)
BED_RE = re.compile(r"(\d[\d,]*)\s*beds\b|beds?\s*(?:total)?\s*[:=]?\s*(\d[\d,]*)", re.I)
for k, c in ed1.items():
    if c.get("units") is not None: continue
    pg = pdis.get(k) or {}
    nums = [int(m.group(1).replace(",", "")) for txt in (pg.get("Project Description"), pg.get("Requested Entitlement"))
            for m in UNIT_RE.finditer(txt or "") if 1 < int(m.group(1).replace(",", "")) < 3000]
    m = MGR_RE.search(pg.get("Project Description") or "")
    if m:
        c["units"], c["affordableUnits"], c["unitsSource"] = int(m.group(1)) + int(m.group(2)), int(m.group(1)), "Planning Case"
    elif nums:
        c["units"] = c["affordableUnits"] = max(nums); c["unitsSource"] = "Planning Case"
    else:
        b = [int((x or y).replace(",", "")) for x, y in BED_RE.findall(pg.get("Project Description") or "")]
        if b:
            c["units"] = c["affordableUnits"] = max(b); c["unitsSource"] = "Shelter Beds (Planning Case)"
for k, c in ed1.items():
    if c.get("units") is not None: continue
    sib = [ed1[o]["units"] for o in (c.get("sameSite") or []) if o in ed1 and ed1[o].get("units")]
    if sib:
        c["units"] = c["affordableUnits"] = max(sib); c["unitsSource"] = "Other ED 1 Case on the Site"
PERMIT_SETS = ["https://data.lacity.org/resource/pi9x-tg5x.json", "https://data.lacity.org/resource/gwh9-jnip.json"]


def permit_du(where, floor=2):
    best = None
    for url in PERMIT_SETS:
        for r in get(url + "?" + urllib.parse.urlencode({"$where": where, "$limit": 200})):
            du = int(float(r.get("du_changed") or 0))
            if du >= floor and (not best or du > best[0]): best = (du, r["permit_nbr"])
    return best


for k, c in ed1.items():
    if c.get("units") is not None: continue
    txt = (pdis.get(k) or {}).get("Project Description") or ""
    found = None
    for pn in re.findall(r"\b\d{5}-\d{5}-\d{5}\b", txt):
        found = found or permit_du(f"permit_nbr='{pn}'")
    if not found and c.get("address"):
        m = re.match(r"(\d+)(?:-\d+)?\s+(?:[NSEW]\s+)?(.+?)\s+(?:St|Ave|Blvd|Dr|Pl|Way|Rd|Ter|Ct|Ln|Pkwy)\b", c["address"])
        if m:
            found = permit_du(f"starts_with(primary_address, '{m.group(1)} ') AND upper(primary_address) like '%{m.group(2).upper().replace(chr(39), '')}%'", floor=5)
    if found:
        c["units"] = c["affordableUnits"] = found[0]; c["unitsSource"] = f"LADBS Permit {found[1]}"
    elif c.get("address") and re.search(r"\s1-(\d+)$", c["address"]):            # "3340 S Shelby Dr 1-86": the unit range
        c["units"] = c["affordableUnits"] = int(re.search(r"\s1-(\d+)$", c["address"]).group(1)); c["unitsSource"] = "Address Unit Range"
print(sum(1 for c in ed1.values() if c.get("units") is None), "cases still without units")
json.dump(ed1, open(OUT, "w", encoding="utf-8"), indent=1, ensure_ascii=True)
print(sum(1 for c in ed1.values() if c.get("cofo")), "cases completed (CofO);", sum(1 for c in ed1.values() if c.get("sales")), "cases with a sale after filing;", n_s, "sold after the CofO")
