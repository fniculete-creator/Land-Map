// Screen matched parcels for SB 1123 qualification and build listings.json.
import fs from "fs";
import path from "path";

const SCRATCH = process.argv[2];
const recs = JSON.parse(fs.readFileSync(path.join(SCRATCH, "recs.json"), "utf8"));
const matches = JSON.parse(fs.readFileSync(path.join(SCRATCH, "matches.json"), "utf8"));

const SF_CAP = 65340;    // 1.5 ac
const MF_CAP = 217800;   // 5 ac
const LIST_DATE_BASE = new Date("2026-08-04");

const STOP = new Set(["N","S","E","W","AVE","AVENUE","ST","STREET","BLVD","DR","DRIVE","RD","ROAD",
  "PL","PLACE","CT","LN","LANE","WAY","TER","CIR","HWY","TRL","PKWY"]);
const streetName = (a) => String(a || "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ")
  .split(/\s+/).filter((t) => t && !STOP.has(t) && !/^\d+$/.test(t)).join(" ");

const out = {};
const audit = [];
let dupes = 0;
for (const r of recs) {
  const m = matches[String(r.i)];
  const row = { ...r, ain: "", result: "", detail: "" };
  if (!m) {
    row.result = "NOT LOCATED";
    row.detail = "address did not geocode (no house number or outside coverage)";
    audit.push(row); continue;
  }
  row.ain = m.ain;
  // Guard low-confidence matches: parcel street must agree when it has one.
  if ((m.how === "near" || m.how === "direct") && m.a) {
    const pn = streetName(m.a), ln = streetName(r.addr);
    if (pn && ln && !pn.includes(ln) && !ln.includes(pn)) {
      row.result = "NOT LOCATED";
      row.detail = `ambiguous match (nearest parcel is ${m.a})`;
      audit.push(row); continue;
    }
  }
  const reasons = [];
  if (m.f === 1 || m.f === 2) reasons.push(m.f === 2 ? "Very High fire hazard" : "High fire hazard");
  if (m.c === 1) reasons.push("coastal zone");
  if (m.h === 1) reasons.push("hillside");
  if (m.pb === 1) reasons.push("public/institutional owner");
  if (m.zf === 1 && m.lsf > SF_CAP) reasons.push(`SF zone over 1.5 ac (${m.lsf.toLocaleString()} sf)`);
  if (m.zf === 2 && m.lsf > MF_CAP) reasons.push(`MF zone over 5 ac (${m.lsf.toLocaleString()} sf)`);
  if (m.zf !== 1 && m.zf !== 2) reasons.push(`not residentially zoned (${m.zc || "?"})`);
  if (reasons.length) {
    row.result = "EXCLUDED";
    row.detail = reasons.join("; ");
    audit.push(row); continue;
  }
  if (out[m.ain]) {
    dupes++;
    row.result = "DUPLICATE";
    row.detail = `same parcel as MLS ${out[m.ain].mls}`;
    audit.push(row); continue;
  }
  const listDate = new Date(LIST_DATE_BASE - r.dom * 86400000).toISOString().slice(0, 10);
  out[m.ain] = {
    address: `${r.addr.toUpperCase()} ${r.city.toUpperCase()} CA`,
    price: r.price,
    type: r.type,
    lotSqft: m.lsf,
    lng: +( m.clng ?? m.glng).toFixed(6),
    lat: +( m.clat ?? m.glat).toFixed(6),
    mls: r.mls,
    listDate,
    tier: m.t || "",
  };
  row.result = "ADDED";
  row.detail = `$${r.price.toLocaleString()} / ${m.lsf.toLocaleString()} sf = $${Math.round(r.price / m.lsf)}/sf land` +
    (m.e === 1 ? " · SB1123 candidate (vacant)" : "");
  audit.push(row);
}

fs.writeFileSync("data/listings.json", JSON.stringify(out, null, 1) + "\n");
const cols = ["sheet", "mls", "addr", "city", "ain", "price", "type", "result", "detail"];
const esc = (v) => (/[",\n]/.test(String(v ?? ""))) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v ?? "");
fs.writeFileSync(path.join(SCRATCH, "screening.csv"),
  cols.join(",") + "\n" + audit.map((r) => cols.map((c) => esc(r[c])).join(",")).join("\n"));

const counts = {};
for (const r of audit) counts[r.result] = (counts[r.result] || 0) + 1;
console.log("results:", JSON.stringify(counts));
console.log("listings.json entries:", Object.keys(out).length);
const excl = {};
for (const r of audit) if (r.result === "EXCLUDED") {
  const key = r.detail.split(";")[0].split("(")[0].trim();
  excl[key] = (excl[key] || 0) + 1;
}
console.log("exclusion breakdown:", JSON.stringify(excl));
