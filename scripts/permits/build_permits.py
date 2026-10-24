"""Build data/permits.json: LADBS new-building permits on the ED 1 and SB 1123 project parcels, keyed by AIN (10 digits).

usage: python scripts/permits/build_permits.py
Source: data.lacity.org Building and Safety permits, issued (pi9x-tg5x) and submitted (gwh9-jnip), 2020 to present, permit
type Bldg-New, matched on the parcel APN. Each permit: {n: permit number, sub: permit sub type, sub_d: submitted, iss: issued,
cofo: CofO date, du: dwelling units added, sf: square footage, status, desc} (dates MM/DD/YYYY). The app links each project to
its LADBS permit page and reads units and the CofO from here. Built 10/24/2026."""
import json, os, time, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
SETS = {"issued": "https://data.lacity.org/resource/pi9x-tg5x.json", "submitted": "https://data.lacity.org/resource/gwh9-jnip.json"}


def get(url, tries=5):
    err = None
    for i in range(tries):
        try:
            return json.load(urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=120))
        except Exception as e:
            err = e; time.sleep(3 * (i + 1))
    raise err


def mdy(s):
    return f"{s[5:7]}/{s[8:10]}/{s[:4]}" if s else None


ains = set()
for c in json.load(open(os.path.join(REPO, "data", "ed1.json"), encoding="utf-8")).values():
    if c.get("apn"): ains.add(c["apn"].replace("-", ""))
ains |= {a for a in json.load(open(os.path.join(REPO, "data", "projects.json"), encoding="utf-8")) if a.isdigit() and len(a) == 10}
ains = sorted(ains)
print(len(ains), "parcels")

out = {}
for kind, url in SETS.items():
    for i in range(0, len(ains), 80):
        inlist = ",".join(f"'{a}'" for a in ains[i:i + 80])
        q = {"$where": f"permit_type='Bldg-New' AND apn in ({inlist})", "$limit": 5000}
        for r in get(url + "?" + urllib.parse.urlencode(q)):
            rec = out.setdefault(r["apn"], {}).setdefault(r["permit_nbr"], {"n": r["permit_nbr"]})
            rec.update({k: v for k, v in {
                "sub": r.get("permit_sub_type"), "sub_d": mdy(r.get("submitted_date")), "iss": mdy(r.get("issue_date")),
                "cofo": mdy(r.get("cofo_date")), "du": int(float(r["du_changed"])) if r.get("du_changed") not in (None, "") else None,
                "sf": int(float(r["square_footage"])) if r.get("square_footage") not in (None, "") else None,
                "status": r.get("status_desc"), "desc": (r.get("work_desc") or "").strip()[:240]}.items() if v is not None})
res = {a: sorted(v.values(), key=lambda p: (p.get("du") or 0, p.get("sf") or 0), reverse=True) for a, v in out.items()}
json.dump(res, open(os.path.join(REPO, "data", "permits.json"), "w", encoding="utf-8"), separators=(",", ":"))
print(len(res), "parcels with a new-building permit;", sum(len(v) for v in res.values()), "permits;",
      sum(1 for v in res.values() if any(p.get("cofo") for p in v)), "with a CofO")
