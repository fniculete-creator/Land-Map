"""Build data/ed1.json: every City of LA Executive Directive 1 (ED 1, Mayor Bass's 100% affordable housing streamlining directive)
case on file with LA City Planning, one record per case, keyed by case number.

usage: python scripts/ed1/build_ed1.py [--work DIR] [--refresh]
Source: City Planning has no published ED 1 project list (its ED 1 page links only guidelines and filing instructions; the one
public ArcGIS layer, ED1projects on services5.arcgis.com, stopped at 323 rows in 03/2023). Every ED 1 case carries an ED1 or RED1
(revised ED 1) suffix in its case number, so: (1) ZIMAS case table zim4s.search_case, CASE_NUM like ED1 -> case, PIN, address,
community, ZIP and State Plane XY per parcel; preliminary reviews (PAR-) are dropped, they precede the filed case. (2) PDIS case
page (planning.lacity.gov/pdiscaseinfo/search/casenumber/{case}) per case -> filing date, action and action date, primary address,
project description; status is the action (Approved, Withdrawn, Terminated and the like), blank action = Pending; approved =
the action date when the action is an approval (Approved, Approved With Conditions, Authorized, Cleared, Review Completed).
(3) units parsed from the project description, else the requested entitlement: the largest "N units" figure, "N+1 units" read
as N affordable plus a manager unit; affordableUnits = units less any manager units the text names (the projects are 100%
affordable), or the income-level breakdown when it accounts for all but the manager units. (4) PIN -> APN (BPP) on the City
Master_landbase layer 2. (5) location: mean of the case's ZIMAS XY (EPSG:2229, converted here; within about 20 m of the roll
parcel centers), else the 2026 LA County assessor roll CENTER_LAT/CENTER_LON by AIN. sameSite lists other ED 1 cases on any of
the same APNs (Redevelopment Plan compliance companions, ED 1 to revised ED 1 refilings) so a map or unit total can count each
site once. PDIS results for final cases are cached in _work/pdis.json; --refresh refetches every case. Not included: PAR-
preliminary reviews and the 2026 Affordable Housing Streamlining Ordinance cases (AHS suffix).
Built 10/24/2026 (684 cases: 606 approved or cleared, 35 pending, 43 withdrawn, terminated or closed; 46,731 units)."""
import argparse, collections, concurrent.futures as cf, html, json, math, os, re, statistics, time, urllib.parse, urllib.request


def ordinals(a):                                    # "22Nd St" -> "22nd St"
    return re.sub(r"(\d)(St|Nd|Rd|Th)\b", lambda m: m.group(1) + m.group(2).lower(), a)
ap = argparse.ArgumentParser(); ap.add_argument("--work", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "_work"))
ap.add_argument("--refresh", action="store_true")
A = ap.parse_args(); os.makedirs(A.work, exist_ok=True); D = A.work
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ZIMAS = "https://zimas.lacity.org/arcgis/rest/services/zm4/landbase/MapServer/dynamicLayer/query"
PDIS = "https://planning.lacity.gov/pdiscaseinfo/search/casenumber/"
LANDBASE = "https://maps.lacity.org/arcgis/rest/services/Core/Master_landbase/MapServer/2/query"
ROLL = "https://services.arcgis.com/RmCCgQtiZLDCtblq/ArcGIS/rest/services/Assessor%20Parcel%20Data%20Roll%202026/FeatureServer/0/query"
UA = {"User-Agent": "Mozilla/5.0"}


def fetch(url, params=None, tries=5, raw=False):
    err = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, data=urllib.parse.urlencode(params).encode() if params else None, headers=UA)
            body = urllib.request.urlopen(req, timeout=120).read()
            return body.decode("utf-8", "replace") if raw else json.loads(body)
        except Exception as e:
            err = e; time.sleep(3 + 3 * i)
    raise err


# ---- 1. ZIMAS case rows ----
layer = json.dumps({"id": 0, "source": {"type": "dataLayer", "dataSource": {"type": "table", "workspaceId": "w2", "dataSourceName": "zim4s.search_case"}}})
p0 = {"layer": layer, "where": "CASE_NUM LIKE '%ED1%'", "outFields": "CASE_NUM,PIN,ADDRESS,COMMUNITY,ZIP,XCoord,YCoord",
      "returnGeometry": "false", "f": "json", "orderByFields": "CASE_NUM,PIN,ADDRESS"}
rows, off = [], 0
while True:
    r = fetch(ZIMAS, dict(p0, resultOffset=off, resultRecordCount=1000))
    fs = [f["attributes"] for f in r.get("features", [])]
    rows += fs; off += len(fs)
    if len(fs) < 1000 and not r.get("exceededTransferLimit") or not fs:
        break
pat = re.compile(r"-R?ED1(-|$)")
rows = [x for x in rows if pat.search(x.get("CASE_NUM") or "")]
by_case = collections.defaultdict(list)
for x in rows:
    by_case[x["CASE_NUM"].strip()].append(x)
par = sorted(c for c in by_case if c.startswith("PAR-"))
cases = sorted(c for c in by_case if not c.startswith("PAR-"))
print(len(rows), "ZIMAS rows;", len(by_case), "ED1 cases;", len(par), "PAR preliminary reviews dropped;", len(cases), "cases kept")
json.dump(rows, open(os.path.join(D, "zimas_rows.json"), "w"))

# ---- 2. PDIS case pages ----
PC = os.path.join(D, "pdis.json")
pdis = json.load(open(PC)) if os.path.exists(PC) and not A.refresh else {}
FINAL = re.compile(r"APPROV|DENI|WITHDR|TERMIN|CLOSURE|CLOSED|DISMISS|EXPIRED|AUTHORIZ|CLEARED|COMPLETED", re.I)
APPROVAL = re.compile(r"^(?:APPROVED|APPROVED WITH CONDITIONS|AUTHORIZED|CLEARED|REVIEW COMPLETED)$", re.I)


def clean(s):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s))).strip()


def parse_pdis(case):
    t = fetch(PDIS + urllib.parse.quote(case), raw=True)
    rec = {}
    for k, v in re.findall(r'<div class="title">(.*?)</div>\s*<div class="data">(.*?)</div>', t, re.S):
        k = clean(k).rstrip(":").strip()
        if k not in rec:
            rec[k] = clean(v)
    m = re.search(r"<strong>Primary Address</strong>.*?<tbody>(.*?)</tbody>", t, re.S)
    if m:
        tds = [clean(x) for x in re.findall(r"<td>(.*?)</td>", m.group(1), re.S)]
        if tds: rec["_addr"] = tds[0]; rec["_cnc"] = tds[1] if len(tds) > 1 else ""; rec["_cd"] = tds[2] if len(tds) > 2 else ""
    rec["_found"] = "Case Filed On" in rec
    return case, rec


def action_of(rec):
    return next((v for k, v in rec.items() if k.endswith(" Action")), "")


todo = [c for c in cases if c not in pdis or not pdis[c].get("_found") or not FINAL.search(action_of(pdis[c]))]
print(len(todo), "PDIS pages to fetch")
with cf.ThreadPoolExecutor(4) as ex:
    for i, (c, rec) in enumerate(ex.map(parse_pdis, todo)):
        pdis[c] = rec
        if i % 100 == 99:
            print(" ", i + 1); json.dump(pdis, open(PC, "w"))
json.dump(pdis, open(PC, "w"))

# ---- 3. PIN -> APN ----
pins = sorted({x["PIN"] for x in rows if x.get("PIN") and x["CASE_NUM"].strip() in set(cases)})
bpp = {}
for i in range(0, len(pins), 100):
    chunk = pins[i:i + 100]
    r = fetch(LANDBASE, {"where": "PIN IN (" + ",".join("'" + p.replace("'", "''") + "'" for p in chunk) + ")", "outFields": "PIN,BPP",
                         "returnGeometry": "false", "f": "json"})
    for f in r.get("features", []):
        a = f["attributes"]
        if a.get("BPP") and a["BPP"].strip().isdigit(): bpp[a["PIN"]] = a["BPP"].strip()
print(len(bpp), "of", len(pins), "PINs matched to an APN")

# ---- 4. coordinates: EPSG:2229 (NAD83 California zone 5, US ft) inverse Lambert conformal conic ----
_a, _f = 6378137.0, 1 / 298.257222101; _e = math.sqrt(2 * _f - _f * _f); _ft = 1200 / 3937
_p1, _p2, _p0, _l0 = map(math.radians, (34 + 2 / 60, 35 + 28 / 60, 33.5, -118.0))
_m = lambda p: math.cos(p) / math.sqrt(1 - (_e * math.sin(p)) ** 2)
_t = lambda p: math.tan(math.pi / 4 - p / 2) / ((1 - _e * math.sin(p)) / (1 + _e * math.sin(p))) ** (_e / 2)
_n = (math.log(_m(_p1)) - math.log(_m(_p2))) / (math.log(_t(_p1)) - math.log(_t(_p2)))
_F = _m(_p1) / (_n * _t(_p1) ** _n); _r0 = _a * _F * _t(_p0) ** _n


def sp5_to_ll(X, Y):
    x, y = X * _ft - 2000000.0, Y * _ft - 500000.0
    rho = math.copysign(math.hypot(x, _r0 - y), _n); t = (rho / (_a * _F)) ** (1 / _n)
    lon = math.atan2(x, _r0 - y) / _n + _l0; lat = math.pi / 2 - 2 * math.atan(t)
    for _ in range(10):
        lat = math.pi / 2 - 2 * math.atan(t * ((1 - _e * math.sin(lat)) / (1 + _e * math.sin(lat))) ** (_e / 2))
    return math.degrees(lat), math.degrees(lon)


need_roll = [c for c in cases if not any(x.get("XCoord") and x.get("YCoord") for x in by_case[c])]
ains = sorted({bpp[x["PIN"]] for c in need_roll for x in by_case[c] if x.get("PIN") in bpp})
roll = {}
for i in range(0, len(ains), 100):
    r = fetch(ROLL, {"where": "AIN IN (" + ",".join("'" + a + "'" for a in ains[i:i + 100]) + ")", "outFields": "AIN,CENTER_LAT,CENTER_LON",
                     "returnGeometry": "false", "f": "json"})
    for f in r.get("features", []):
        a = f["attributes"]
        if a.get("CENTER_LAT"): roll[a["AIN"]] = (a["CENTER_LAT"], a["CENTER_LON"])
print(len(need_roll), "cases without ZIMAS XY;", len(roll), "of", len(ains), "of their AINs found on the 2026 roll")

# ---- 5. units ----
NUM = r"(\d{1,3}(?:,\d{3})*|\d+)"
WORDS = {"one": 1, "two": 2, "three": 3, "a": 1}
U_PLUS = re.compile(NUM + r"\s*\+\s*(\d)\s*(?:-|\s)*(?:[a-z'()/%-]+\s+){0,4}?(?:units?|du|dwelling units?)\b", re.I)
U_ANY = re.compile(NUM + r"(?:\s*\(\d+\))?\s*(?:-|\s)*(?:(?:new|total|dwelling|residential|affordable|apartment|housing|rental|multi-?family|"
                   r"restricted|permanent|supportive|psh|senior|family|income|deed|deed-restricted|100%|story|guest\s?rooms?|efficiency|"
                   r"studio|micro|one|two|three|bedroom|bd|br|low|very|extremely|moderate|of|the|and|including|which|are|with)\s*(?:-|\s)*){0,5}"
                   r"(?:units?\b|du(?:'?s)?\b|d\.\s?u\.?|dwellings?\b|apart\w*\b)", re.I)
U_TOTAL = re.compile(r"total of\s+" + NUM + r"\b", re.I)
MGR = re.compile(r"(\d+|one|two|three|a)\s*(?:\(\d\)\s*)?(?:on-?site\s+|unrestricted\s+|market[- ]rate\s+|resident\s+)?manager", re.I)
INC = re.compile(NUM + r"\s*(?:-|\s)*(?:units?\s+(?:for|at|of)\s+)?(?:acutely low|extremely low|very low|low|moderate|ali|eli|vli|li|mi|ami)\b", re.I)
EXIST = re.compile(r"(?:existing|\(e\)|demo\w*|remov\w*)(?:(?!\bfor\b|construct|\bnew\b|\bbuild|\(n\)|\bto\b)[^.;]){0,25}$", re.I)


def toint(s):
    return int(s.replace(",", ""))


def parse_units(text, ctx):
    if not text: return None, None
    cands, plus_mgr = [], 0
    for m in U_PLUS.finditer(text):
        a, b = toint(m.group(1)), int(m.group(2))
        if b <= 3 and 0 < a < 3000: cands.append((a + b, b))
    for m in U_ANY.finditer(text):
        n = toint(m.group(1))
        pre = text[max(0, m.start() - 45):m.start()]
        if 1 < n < 3000 and not EXIST.search(pre) and not re.search(r"\d\s*\+\s*$", pre): cands.append((n, 0))
    for m in U_TOTAL.finditer(text):
        n = toint(m.group(1))
        if 1 < n < 3000: cands.append((n, 0))
    if not cands: return None, None
    units, plus_mgr = max(cands)
    mg = sum(WORDS.get(m.group(1).lower(), None) or (int(m.group(1)) if m.group(1).isdigit() and int(m.group(1)) <= 5 else 0)
             for m in MGR.finditer(ctx))
    mg = max(mg, plus_mgr)
    src = text if INC.search(text) else ctx
    inc = sum(toint(m.group(1)) for m in INC.finditer(src) if toint(m.group(1)) < 3000)
    if inc and 0 <= units - inc <= max(mg, 3): aff = inc
    else: aff = max(units - min(mg, 5), 0)
    return units, aff


def mdy(s):
    s = (s or "").strip()
    return s if re.fullmatch(r"\d\d/\d\d/\d{4}", s) else None


def title_status(a):
    a = (a or "").strip().strip('"')
    if not a or a.upper() in ("N/A", "NA"): return "Pending"
    return ordinals(re.sub(r"\s+", " ", a).title())


out, miss_xy, roll_xy = {}, [], 0
for c in cases:
    zr = by_case[c]; p = pdis.get(c, {})
    act_key = next((k for k in p if k.endswith(" Action")), None)
    action = p.get(act_key, "") if act_key else ""
    act_date = mdy(p.get(act_key + " Date", "")) if act_key else None
    status = title_status(action)
    desc = p.get("Project Description", ""); ent = p.get("Requested Entitlement", "")
    units, aff = parse_units(desc, desc + " " + ent)
    if units is None: units, aff = parse_units(ent, desc + " " + ent)
    xy = [sp5_to_ll(x["XCoord"], x["YCoord"]) for x in zr if x.get("XCoord") and x.get("YCoord")]
    if not xy:
        xy = [roll[bpp[x["PIN"]]] for x in zr if x.get("PIN") in bpp and bpp[x["PIN"]] in roll]
        if xy: roll_xy += 1
    lat = round(statistics.mean(v[0] for v in xy), 6) if xy else None
    lng = round(statistics.mean(v[1] for v in xy), 6) if xy else None
    if lat is None: miss_xy.append(c)
    apns = []
    for x in zr:
        b = bpp.get(x.get("PIN"))
        if b:
            b = f"{b[:4]}-{b[4:7]}-{b[7:]}"
            if b not in apns: apns.append(b)
    zips = collections.Counter(str(x["ZIP"]) for x in zr if x.get("ZIP"))
    comm = collections.Counter(x["COMMUNITY"].strip() for x in zr if (x.get("COMMUNITY") or "").strip())
    addr = p.get("_addr") or sorted({x["ADDRESS"].strip() for x in zr if x.get("ADDRESS")})[0]
    out[c] = {"case": c, "address": ordinals(re.sub(r"\s+", " ", addr).strip().title()), "community": comm.most_common(1)[0][0] if comm else None,
              "zip": zips.most_common(1)[0][0] if zips else None, "apn": ", ".join(apns) or None, "units": units, "affordableUnits": aff,
              "status": status, "filed": mdy(p.get("Case Filed On")),
              "approved": act_date if APPROVAL.match(action.strip().strip('"')) else None,
              "lat": lat, "lng": lng, "source": PDIS + c}

site = collections.defaultdict(set)
for c, v in out.items():
    for a in (v["apn"] or "").split(", "):
        if a: site[a].add(c)
for c, v in out.items():
    v["sameSite"] = sorted({o for a in (v["apn"] or "").split(", ") if a for o in site[a]} - {c}) or None
json.dump(out, open(os.path.join(REPO, "data", "ed1.json"), "w"), indent=1, ensure_ascii=True)
st = collections.Counter(v["status"] for v in out.values())
print(len(out), "cases written to data/ed1.json")
print("status:", st.most_common())
print("units:", sum(v["units"] or 0 for v in out.values()), "total;", sum(v["affordableUnits"] or 0 for v in out.values()), "affordable;",
      sum(1 for v in out.values() if v["units"] is None), "cases with no unit count")
seen, dedup = set(), 0
for c in sorted(out, key=lambda k: -(out[k]["units"] or 0)):
    if c in seen or out[c]["status"] in ("Withdrawn", "Terminated", "Administrative Closure"): continue
    grp = {c} | set(out[c]["sameSite"] or []); seen |= grp; dedup += out[c]["units"] or 0
print("units, one case per site (largest), active or approved cases only:", dedup)
print("location:", len(out) - len(miss_xy), "located (", len(out) - len(miss_xy) - roll_xy, "ZIMAS XY,", roll_xy, "assessor roll );", len(miss_xy), "missing", miss_xy[:10])
print("missing:", {k: sum(1 for v in out.values() if v[k] in (None, "")) for k in ("address", "community", "zip", "apn", "filed")},
      "PDIS not found:", [c for c in cases if not pdis.get(c, {}).get("_found")][:20])
