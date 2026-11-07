// Every filter on every program tab, driven through its real control and checked against
// the data files (run with the dev server up):
//   CHROMIUM_PATH=... node tests/filters.verify.mjs http://localhost:8123
import { chromium } from "playwright-core";

const BASE = process.argv[2] || "http://localhost:8123";
const EXECUTABLE = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium";

let failures = 0;
function check(cond, label) {
  console.log((cond ? "ok - " : "FAIL - ") + label);
  if (!cond) failures++;
}

const browser = await chromium.launch({ executablePath: EXECUTABLE, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => { console.log("PAGE ERROR:", e.message); failures++; });
await page.goto(BASE + "/index.html", { waitUntil: "load", timeout: 30000 });
await page.waitForFunction(() => window.LandMap && window.LandMap.map, { timeout: 20000 });
await page.waitForFunction(() => window.LandMap.map.isStyleLoaded(), { timeout: 20000 });

const load = (f) => page.evaluate((u) => fetch(u).then((r) => r.json()), "data/" + f);
const [listings, projects, slo, ed1, compsRaw] = await Promise.all(
  ["listings.json", "projects.json", "slo.json", "ed1.json", "comps_small_lot.json"].map(load));
const L = Object.values(listings);
const comps = Array.isArray(compsRaw) ? compsRaw : Object.values(compsRaw);

// The view stays fixed so the list counts can be compared with the data.
const VIEW = { center: [-118.45, 34.1], zoom: 9.2 };
const settle = async (ms = 1400) => {
  await page.waitForTimeout(ms);
  await page.waitForFunction(() => window.LandMap.map.isStyleLoaded(), { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(500);
};
const jump = async (v = VIEW) => {
  await page.evaluate((x) => window.LandMap.map.jumpTo(x), v);
  await settle();
};
const bounds = () => page.evaluate(() => {
  const b = window.LandMap.map.getBounds();
  return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
});
const inB = ([w, s, e, n], x) => x.lng != null && x.lng >= w && x.lng <= e && x.lat >= s && x.lat <= n;

// Real controls: the value goes in the box, then the events a person's typing fires.
const setBox = (id, v) => page.evaluate(([i, val]) => {
  const el = document.getElementById(i);
  el.value = val;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}, [id, String(v ?? "")]);
const setRange = async (id, lo, hi) => { await setBox(id + "-min", lo); await setBox(id + "-max", hi); await settle(); };
const pick = async (name, value) => {
  await page.evaluate(([n, v]) => document.querySelector(`input[name="${n}"][value="${v}"]`).click(), [name, value]);
  await settle();
};
const tick = async (sel) => { await page.evaluate((s) => document.querySelector(s).click(), sel); await settle(); };
const click = async (id) => { await page.evaluate((i) => document.getElementById(i).click(), id); await settle(); };
const tab = async (p) => { await page.evaluate((x) => document.querySelector(`.prog-tab[data-prog="${x}"]`).click(), p); await settle(); };

const rows = () => page.evaluate(() => [...document.querySelectorAll("#site-list .site-item")].map((e) => e.textContent));
const shownCount = () => page.evaluate(() => {
  const m = document.getElementById("list-count").textContent.match(/of ([\d,]+)/);
  return m ? Number(m[1].replace(/,/g, "")) : document.querySelectorAll("#site-list .site-item").length;
});
const tile = () => page.evaluate(() => Number(document.getElementById("result-count").textContent.replace(/,/g, "")));
const markers = (id) => page.evaluate((i) => {
  const f = window.LandMap.map.getFilter(i);
  return f && f[0] === "in" ? f[2][1] : [];
}, id);
const rendered = (layer) => page.evaluate((l) => window.LandMap.map.queryRenderedFeatures({ layers: [l] }).length, layer);

// ---- SB 1123: On Market ----------------------------------------------------
console.log("\n# On Market");
await click("onmarket-btn");
await jump();
let box = await bounds();
const omExpect = (fn) => L.filter((l) => inB(box, l) && fn(l)).length;
const omCheck = async (label, fn) => {
  await jump();
  box = await bounds();
  const got = await shownCount();
  const want = omExpect(fn);
  check(got === want, `${label}: list ${got}, data ${want}`);
  const markerWant = L.filter(fn).length;
  const m = (await markers("om-markers")).length;
  check(m === markerWant, `${label}: markers ${m}, data ${markerWant}`);
};
await omCheck("no filter", () => true);
check(await tile() === omExpect(() => true), `count tile matches deals in view (${await tile()})`);
console.log(`  width known on ${L.filter((l) => l.w != null).length} of ${L.length} listings`);

const before = await shownCount();
const t0 = Date.now();
await setBox("ppsf-min", 100);
await setBox("ppsf-max", 300);
await page.waitForFunction((n) => {
  const m = document.getElementById("list-count").textContent.match(/of ([\d,]+)/);
  return m && Number(m[1].replace(/,/g, "")) !== n;
}, before, { timeout: 15000 }).catch(() => {});
const lag = Date.now() - t0;
check(lag < 5000, `list follows a filter within 5 seconds (${lag} ms)`);
await settle();
const ppsf = (l) => (l.price > 0 && l.lotSqft > 0 ? Math.round(l.price / l.lotSqft) : null);
await omCheck("$/SF 100 to 300", (l) => ppsf(l) != null && ppsf(l) >= 100 && ppsf(l) <= 300);
await setRange("ppsf", "", "");

await setRange("lsf", 10000, 15000);
await omCheck("Lot 10,000 to 15,000", (l) => l.lotSqft >= 10000 && l.lotSqft <= 15000);
await setRange("lsf", "", "");

const hasW = L.some((l) => l.w != null);
check(hasW, "listings carry a lot width");
await setRange("w", 50, 80);
await omCheck("Width 50 to 80", (l) => l.w != null && l.w >= 50 && l.w <= 80);
await setRange("w", "", "");

for (const t of ["A", "B", "C"]) {
  await tick(`#tier-${t}`);
  await omCheck(`Tier ${t}`, (l) => l.tier === t);
  await tick(`#tier-${t}`);
}
await pick("imp", "vacant");
await omCheck("Improvements Vacant", (l) => l.type === "Land");
await pick("imp", "sfr");
await omCheck("Improvements SFR", (l) => l.type === "SFR");
await pick("imp", "any");

for (const k of ["oz2", "oz", "hr", "qct"]) {
  await tick(`.ovl-cb[value="${k}"]`);
  await settle(2500);
  const m = (await markers("om-markers")).length;
  check(m > 0 && m < L.length, `Overlay ${k} narrows the markers (${L.length} to ${m})`);
  const list = await shownCount();
  check(list > 0 && list <= m, `Overlay ${k} narrows the list (${list})`);
  await tick(`.ovl-cb[value="${k}"]`);
}
await setRange("lsf", 8000, "");
await pick("imp", "sfr");
await omCheck("Lot and SFR together", (l) => l.type === "SFR" && l.lotSqft >= 8000);
await click("reset-btn");
check((await page.evaluate(() => window.LandMap.state.om)) === false, "Clear turns On Market off");
check((await markers("om-markers")).length === 0, "Clear empties the markers");

// ---- SB 1123: Sold ---------------------------------------------------------
console.log("\n# Sold");
const soldRaw = Object.values(await load("sold_land.json"));
const soldData = soldRaw.filter((l) => l.ok);
const located = soldData.filter((l) => l.lng != null);
check(soldData.length > 0 && located.length === soldData.length, `screened sold lots all located (${located.length} of ${soldRaw.length} on file)`);
check(soldData.every((l) => l.lsf <= 65340), "no sold lot over the 1.5 ac cap");
await click("sold-btn");
const soldCheck = async (label, fn) => {
  await jump();
  box = await bounds();
  const got = await shownCount();
  const want = located.filter((l) => inB(box, l) && fn(l)).length;
  check(got === want, `${label}: list ${got}, data ${want}`);
  const m = (await markers("sold-markers")).length;
  const mw = soldData.filter(fn).length;
  check(m === mw, `${label}: markers ${m}, data ${mw}`);
  return got;
};
const soldAll = await soldCheck("no filter", () => true);
check(soldAll > 200, `citywide Sold lists the lots, not just what the map draws (${soldAll})`);
await setRange("lsf", 10000, 20000);
await soldCheck("Lot 10,000 to 20,000", (l) => l.lsf >= 10000 && l.lsf <= 20000);
await setRange("lsf", "", "");
await setRange("w", 50, 80);
await soldCheck("Width 50 to 80", (l) => l.w >= 50 && l.w <= 80);
await setRange("w", "", "");
for (const t of ["A", "B", "C"]) {
  await tick(`#tier-${t}`);
  await soldCheck(`Tier ${t}`, (l) => l.t === t);
  await tick(`#tier-${t}`);
}
await pick("imp", "vacant");
await soldCheck("Vacant", (l) => l.v !== 0);
await pick("imp", "sfr");
await soldCheck("SFR", (l) => l.v === 0);
await pick("imp", "any");
await tick('.ovl-cb[value="qct"]');
await settle(2500);
const soldQ = await shownCount();
check(soldQ > 0 && soldQ < soldAll, `Overlay QCT narrows (${soldQ} of ${soldAll})`);
await tick('.ovl-cb[value="qct"]');
await click("sold-btn");
check((await markers("sold-markers")).length === 0, "turning Sold off removes its markers");

// ---- SB 1123: default parcels ----------------------------------------------
console.log("\n# Parcels with no market switch");
await click("reset-btn");
await jump({ center: [-118.49, 34.2], zoom: 15 });
await setRange("lsf", 6000, 7000);
const lotRows = await page.evaluate(() => window.LandMap.map.queryRenderedFeatures({ layers: ["parcels-fill"] }).map((f) => f.properties.lsf));
check(lotRows.length > 0 && lotRows.every((n) => n >= 6000 && n <= 7000), `Lot 6,000 to 7,000 on parcels (${lotRows.length})`);
await setRange("lsf", "", "");
await setRange("w", 50, 60);
const wRows = await page.evaluate(() => window.LandMap.map.queryRenderedFeatures({ layers: ["parcels-fill"] }).map((f) => f.properties.w));
check(wRows.length > 0 && wRows.every((n) => n >= 50 && n <= 60), `Width 50 to 60 on parcels (${wRows.length})`);
await setRange("w", "", "");
await pick("imp", "vacant");
const vac = await page.evaluate(() => window.LandMap.map.queryRenderedFeatures({ layers: ["parcels-fill"] }).map((f) => f.properties.v));
check(vac.every((v) => v === 1), `Vacant on parcels (${vac.length})`);
await pick("imp", "any");
await tick("#tier-C");
await page.evaluate((v) => window.LandMap.map.jumpTo(v), { center: [-118.49, 34.2], zoom: 15 });
await settle();
const tc = await page.evaluate(() => window.LandMap.map.queryRenderedFeatures({ layers: ["parcels-fill"] }).map((f) => f.properties.t));
check(tc.length > 0 && tc.every((t) => t === "C"), `Tier C on parcels (${tc.length})`);
await tick("#tier-C");

// ---- SB 1123: Status -------------------------------------------------------
console.log("\n# Status");
const P = Object.values(projects);
const statusCheck = async (label, fn) => {
  const got = (await markers("projects-markers")).length;
  const want = Object.values(projects).filter(fn).length;
  check(got === want, `${label}: project markers ${got}, data ${want}`);
};
await click("reset-btn");
await jump();
await pick("dstatus", "approved");
await statusCheck("Approved", (p) => p.status === "approved");
await pick("dstatus", "submitted");
await statusCheck("Submitted", (p) => p.status !== "approved");
await setRange("lsf", 10000, "");
await statusCheck("Submitted, Lot 10,000+", (p) => p.status !== "approved" && p.lotSqft >= 10000);
const stRows = await rows();
const stLots = stRows.map((t) => (t.match(/([\d,]+) SF/) || [])[1]).filter(Boolean).map((s) => Number(s.replace(/,/g, "")));
check(stLots.length > 0 && stLots.every((n) => n >= 10000), `Submitted, Lot 10,000+: list rows hold (${stLots.length})`);
await setRange("lsf", "", "");
await tick("#tier-A");
await statusCheck("Submitted, Tier A", (p) => p.status !== "approved" && p.tier === "A");
await tick("#tier-A");
await tick('.ovl-cb[value="qct"]');
await settle(2500);
const stOv = (await markers("projects-markers")).length;
const stAll = P.filter((p) => p.status !== "approved").length;
check(stOv < stAll, `Submitted, Overlay QCT narrows the projects (${stOv} of ${stAll})`);
await tick('.ovl-cb[value="qct"]');
await click("reset-btn");

// ---- SLO -------------------------------------------------------------------
console.log("\n# SLO");
await tab("slo");
await jump();
box = await bounds();
const S = Object.values(slo);
for (const [btn, want] of [["any", S], ["built", S.filter((c) => c.status === "built")], ["not built", S.filter((c) => c.status === "not built")]]) {
  await page.evaluate((b) => document.querySelector(`[data-slo-status="${b}"]`).click(), btn);
  await settle();
  const w = want.filter((c) => inB(box, c)).length;
  const got = await tile();
  check(got === w, `SLO ${btn}: tile ${got}, data ${w}`);
  check(await rendered("slo-markers") > 0, `SLO ${btn}: markers draw`);
}
await page.evaluate(() => document.querySelector('[data-slo-status="any"]').click());

// ---- ED 1 ------------------------------------------------------------------
console.log("\n# ED 1");
await tab("ed1");
await jump();
box = await bounds();
const E = Object.values(ed1);
const ed1Check = async (label, fn) => {
  const want = E.filter((c) => inB(box, c) && fn(c)).length;
  const got = await tile();
  check(got === want, `${label}: tile ${got}, data ${want}`);
};
await ed1Check("All Cases", () => true);
for (const b of ["approved", "pending", "closed"]) {
  await page.evaluate((x) => document.querySelector(`[data-ed1-status="${x}"]`).click(), b);
  await settle();
  const t = await tile();
  check(t > 0 && t < E.length, `ED 1 ${b} narrows (${t})`);
}
await page.evaluate(() => document.querySelector('[data-ed1-status="any"]').click());
await setRange("eunits", 100, 200);
await ed1Check("Units 100 to 200", (c) => c.units >= 100 && c.units <= 200);
await setRange("eunits", "", "");
await click("ed1-land-btn");
await ed1Check("Sold", (c) => !!c.landSold);
await click("ed1-land-btn");
await click("ed1-done-btn");
await ed1Check("Completed", (c) => !!c.cofo);
await click("ed1-done-btn");
await click("ed1-sold-btn");
await ed1Check("Completed & Sold", (c) => !!c.sold);
await click("ed1-clear");
await ed1Check("Clear", () => true);

// ---- Finished Comps --------------------------------------------------------
console.log("\n# Finished Comps");
await tab("comps");
await settle(2500);
await jump();
box = await bounds();
const inR = (v, lo, hi) => v != null && v >= lo && v <= hi;
const since = (y) => (c) => !y || c.d >= `${y}-01-01`;
const compCheck = async (label, fn) => {
  const want = comps.filter((c) => inB(box, c) && fn(c)).length;
  const got = await tile();
  check(got === want, `${label}: tile ${got}, data ${want}`);
};
await compCheck("Default (2025+)", since(2025));
for (const y of [2024, 2023, 2020, 0]) {
  await pick("csince", String(y));
  await compCheck(`Sold Since ${y || "any"}`, since(y));
}
await setRange("cprice", 1000000, 1500000);
await compCheck("Price $1M to $1.5M", (c) => inR(c.p, 1000000, 1500000));
await setRange("cprice", "", "");
await setRange("cppsf", 600, 800);
await compCheck("$/SF 600 to 800", (c) => inR(c.ppsf, 600, 800));
await setRange("cppsf", "", "");
await setRange("csf", 1500, 2000);
await compCheck("Home Size 1,500 to 2,000", (c) => inR(c.sf, 1500, 2000));
await setRange("csf", "", "");
await setRange("cyb", 2015, 2020);
await compCheck("Year Built 2015 to 2020", (c) => inR(c.yb, 2015, 2020));
await click("comps-clear");
await compCheck("Clear back to 2025+", since(2025));

await browser.close();
console.log(failures ? `\n${failures} FAILURES` : "\nALL FILTER CHECKS PASSED");
process.exit(failures ? 1 : 0);
