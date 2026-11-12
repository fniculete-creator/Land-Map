#!/usr/bin/env python
"""Find new SB 1123 / SB 684 filings and status changes for data/projects.json.

Runs on Filip's PC (the cloud routine cannot reach planning.lacity.gov).
Three sources, because none is complete on its own:
  1. City Planning's AGOL layer New_PCTS_Case_Filings (lags 1 to 3 weeks).
  2. A PDIS probe of case numbers: tract numbers (VTT/TT) are reserved early and
     filed in gaps, so the whole recent range is probed; AA parcel-map numbers
     run in filing order, so the window above the highest known one is probed.
     A hit redirects /search/case/{short} to /Search/casenumber/{full}.
  3. A recheck of every pending case's PDIS page (action, action date, hold).

Writes a JSON report (new filings with their PDIS facts, status changes).
With --apply it writes the status changes into data/projects.json
(status, rawStatus, decided only). New filings still need a parcel match and a
record, built by the scheduled chat per scripts/sweep/README.md.

Usage: python scripts/sweep/sweep_sb1123.py --report out.json [--apply] [--no-probe]
"""
import argparse
import concurrent.futures as cf
import datetime as dt
import html
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
PROJECTS = REPO / "data" / "projects.json"
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
PDIS_SHORT = "https://planning.lacity.gov/pdiscaseinfo/search/case/{}"
PDIS_FULL = "https://planning.lacity.gov/pdiscaseinfo/Search/casenumber/{}"
AGOL = ("https://services1.arcgis.com/tzwalEyxl2rpamKs/arcgis/rest/services/"
        "New_PCTS_Case_Filings/FeatureServer/0/query")
CLOSED_WORDS = ("DENIED", "DISAPPROVED", "WITHDRAWN", "TERMINATED", "CLOSURE", "CLOSED", "EXPIRED", "DISMISSED")
WORKERS = 5


def get(url, data=None, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers=UA)
            with urllib.request.urlopen(req, timeout=40) as r:
                return r.geturl(), r.read().decode("utf-8", "ignore")
        except Exception as e:  # noqa: BLE001
            if i == tries - 1:
                raise
            time.sleep(2 + 3 * i)


def short_id(case):
    """VTT-85421-SH-VHCA -> VTT-85421; AA-2026-4732-VPM-SH-HCA -> AA-2026-4732."""
    m = re.match(r"^(AA-\d{4}-\d+|[A-Z]+-\d+)", case.strip().upper())
    return m.group(1) if m else case.strip().upper()


def page_lines(raw):
    t = re.sub(r"(?s)<script.*?</script>|<style.*?</style>", "", raw)
    t = html.unescape(re.sub(r"<[^>]+>", "\n", t))
    return [l.strip() for l in t.splitlines() if l.strip()]


def after(lines, label):
    for k, l in enumerate(lines):
        if l == label and k + 1 < len(lines):
            return lines[k + 1]
    return ""


def parse_pdis(final_url, raw):
    """Facts from a PDIS case page, or None when the page is not a case."""
    if "/casenumber/" not in final_url.lower():
        return None
    L = page_lines(raw)
    case = after(L, "Case Number:")
    if not re.match(r"^[A-Z]+-", case):
        case = urllib.parse.unquote(final_url.rsplit("/", 1)[-1]).upper()
    action, action_date = "", ""
    for k, l in enumerate(L):
        if l == "Action:":
            nxt = L[k + 1] if k + 1 < len(L) else ""
            nxt2 = L[k + 2] if k + 2 < len(L) else ""
            action = "" if nxt2 == "Action Date:" else nxt
            break
    action_date = after(L, "Action Date:")
    pa = None
    if "Primary Address" in L:
        i = L.index("Primary Address")
        # Address / CNC / CD headers, then the values
        vals = L[i + 4:i + 7]
        if len(vals) == 3:
            pa = {"address": vals[0], "cnc": vals[1], "cd": vals[2]}
    pin = ""
    m = re.search(r"zimas\.lacity\.org/?\?pin=([^\"'&<>]+)", raw, re.I)
    if m:
        pin = urllib.parse.unquote(m.group(1)).strip()
    ent = []
    if "Requested Entitlement:" in L:
        i = L.index("Requested Entitlement:") + 1
        while i < len(L) and not L[i].endswith(":"):
            ent.append(L[i]); i += 1
    return {
        "case": case,
        "url": final_url,
        "filed": after(L, "Case Filed On:"),
        "assigned": after(L, "Assigned Date:"),
        "staff": after(L, "Staff Assigned:"),
        "action": "" if action.upper() in ("N/A", "") else action,
        "actionDate": "" if action_date.upper() == "N/A" else action_date,
        "hold": after(L, "Case on Hold?:"),
        "primaryAddress": pa,
        "description": after(L, "Project Description:"),
        "entitlements": ent,
        "applicant": after(L, "Applicant:"),
        "representative": "" if after(L, "Representative:") == "View Related Cases" else after(L, "Representative:"),
        "zimasPin": pin,
    }


def fetch_short(sid):
    try:
        url, raw = get(PDIS_SHORT.format(sid))
    except Exception as e:  # noqa: BLE001
        return sid, {"error": str(e)}
    return sid, parse_pdis(url, raw)


def fetch_full(case):
    try:
        url, raw = get(PDIS_FULL.format(case))
        info = parse_pdis(url, raw)
        if info is None:  # suffix renamed by the city: look up by short number
            return fetch_short(short_id(case))[1]
        return info
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)}


def is_sb1123(info):
    if not info or "error" in info:
        return False
    case = info["case"].upper()
    if re.search(r"-SH(-|$)", case):
        return True
    txt = " ".join(info["entitlements"] + [info["description"]]).upper()
    return "STARTER HOUSE" in txt or "SB 684" in txt or "SB 1123" in txt or "SB684" in txt or "SB1123" in txt


def agol_cases():
    data = urllib.parse.urlencode({
        "where": "USER_CaseNumber LIKE '%-SH%'",
        "outFields": "USER_CaseNumber,USER_AppDate,USER_Address,USER_ProjectDescription",
        "returnGeometry": "false", "f": "json"}).encode()
    _, raw = get(AGOL, data=data)
    js = json.loads(raw)
    if "error" in js:
        raise RuntimeError(js["error"])
    return [f["attributes"] for f in js.get("features", [])]


def probe_ids(projects):
    nums_tract, nums_93, aa = [], [], {}
    for r in projects.values():
        s = short_id(r["case"])
        m = re.match(r"^(VTT|TT)-(\d+)$", s)
        if m:
            n = int(m.group(2))
            (nums_93 if n >= 90000 else nums_tract).append(n)
        m = re.match(r"^AA-(\d{4})-(\d+)$", s)
        if m:
            aa.setdefault(int(m.group(1)), []).append(int(m.group(2)))
    ids = []
    hi = max(nums_tract)
    for n in range(hi - 350, hi + 301):
        ids += [f"VTT-{n}", f"TT-{n}"]
    hi93 = max(nums_93) if nums_93 else 93250
    for n in range(93200, hi93 + 151):
        ids.append(f"VTT-{n}")
    year = dt.date.today().year
    hi_aa = max(aa.get(year, [0]))
    lo = max(1, hi_aa - 400)
    for n in range(lo, hi_aa + 2001):
        ids.append(f"AA-{year}-{n}")
    if dt.date.today().month <= 2:  # late filings carry the prior year's numbers
        hi_prev = max(aa.get(year - 1, [7000]))
        for n in range(hi_prev - 200, hi_prev + 1200):
            ids.append(f"AA-{year - 1}-{n}")
    return ids


def to_iso(mdy):
    try:
        return dt.datetime.strptime(mdy, "%m/%d/%Y").date().isoformat()
    except ValueError:
        return None


def raw_status(action):
    a = action.strip().upper()
    if a == "APPROVED WITH CONDITIONS":
        return "Approved with Conditions"
    return action.strip().title()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", required=True)
    ap.add_argument("--apply", action="store_true", help="write status changes into data/projects.json")
    ap.add_argument("--no-probe", action="store_true", help="skip the case-number probe (AGOL + recheck only)")
    a = ap.parse_args()

    projects = json.loads(PROJECTS.read_text(encoding="utf-8"))
    known = {short_id(r["case"]): ain for ain, r in projects.items()}
    # companion cases written into another record's desc ("Companion case VTT-85141-...") count as known
    for ain, r in projects.items():
        for m in re.finditer(r"\b(AA-\d{4}-\d+|V?TT-\d+)(?:-[A-Z]+)*", r.get("desc", "")):
            known.setdefault(short_id(m.group(0)), ain)
    report = {"ranAt": dt.datetime.now().isoformat(timespec="seconds"), "newFilings": [],
              "statusChanges": [], "errors": [], "agolCount": None, "probed": 0}

    # 1. AGOL
    candidates = set()
    try:
        rows = agol_cases()
        report["agolCount"] = len(rows)
        for r in rows:
            sid = short_id(r["USER_CaseNumber"])
            if sid not in known:
                candidates.add(sid)
    except Exception as e:  # noqa: BLE001
        report["errors"].append(f"AGOL: {e}")

    # 2. probe
    if not a.no_probe:
        ids = [i for i in probe_ids(projects) if i not in known]
        report["probed"] = len(ids)
        with cf.ThreadPoolExecutor(WORKERS) as ex:
            for sid, info in ex.map(fetch_short, ids):
                if info and "error" in info:
                    report["errors"].append(f"probe {sid}: {info['error']}")
                elif is_sb1123(info):
                    candidates.add(sid)

    for sid in sorted(candidates):
        _, info = fetch_short(sid)
        if info and "error" not in info and short_id(info["case"]) not in known:
            report["newFilings"].append(info)
        elif not info:
            report["errors"].append(f"{sid}: listed by AGOL but no PDIS case page")

    # 3. recheck pending
    pending = {ain: r for ain, r in projects.items() if r.get("status") == "submitted"}
    with cf.ThreadPoolExecutor(WORKERS) as ex:
        results = dict(zip(pending, ex.map(lambda r: fetch_full(r["case"]), pending.values())))
    for ain, info in results.items():
        r = projects[ain]
        if not info or "error" in info:
            report["errors"].append(f"recheck {r['case']}: {(info or {}).get('error', 'no case page')}")
            continue
        change = {}
        if info["case"] != r["case"]:
            change["case"] = info["case"]
        if info["action"]:
            act = info["action"].upper()
            status = "approved" if "APPROV" in act else ("closed" if any(w in act for w in CLOSED_WORDS) else None)
            if status:
                change.update(status=status, rawStatus=raw_status(info["action"]), decided=to_iso(info["actionDate"]))
        if "status" not in change:
            on_hold = info["hold"].strip().upper() == "ON HOLD"
            want = "Pending (On Hold)" if on_hold else "Pending"
            if r.get("rawStatus") != want:
                change["rawStatus"] = want
        if change:
            report["statusChanges"].append({"ain": ain, "address": r.get("address"), "case": r["case"],
                                            "before": {k: r.get(k) for k in change}, "after": change,
                                            "pdis": info})
            if a.apply:
                r.update(change)

    if a.apply and report["statusChanges"]:
        text = json.dumps(projects, indent=1, ensure_ascii=True)
        json.loads(text)
        PROJECTS.write_text(text, encoding="utf-8", newline="")
    report["applied"] = bool(a.apply and report["statusChanges"])
    Path(a.report).write_text(json.dumps(report, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"new filings: {len(report['newFilings'])}  status changes: {len(report['statusChanges'])}  "
          f"errors: {len(report['errors'])}  probed: {report['probed']}  agol: {report['agolCount']}")
    for f in report["newFilings"]:
        print(f"  NEW {f['case']}  {(f['primaryAddress'] or {}).get('address', '')}  filed {f['filed']}")
    for c in report["statusChanges"]:
        print(f"  CHANGE {c['case']}  {c['address']}  {c['before']} -> {c['after']}")


if __name__ == "__main__":
    sys.exit(main())
