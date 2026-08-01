// Headless smoke test against the REAL region tileset and the universe-first
// model (default view = SFR homes + vacant lots; filters narrow it).
// Usage: python3 scripts/pipeline/serve.py 8123 & node tests/smoke.spec.mjs http://localhost:8123
// Requires playwright-core and a chromium binary (CHROMIUM_PATH, default /opt/pw-browsers/chromium).

import { chromium } from "playwright-core";

const BASE = process.argv[2] || "http://localhost:8123";
const EXECUTABLE = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium";
const SHOUP_AIN = "2139012035"; // 6540 Shoup Ave — known SFR reference parcel

const IGNORABLE = /tile\.openstreetmap\.org|arcgisonline\.com|api\.mapbox\.com|openfreemap|ERR_TUNNEL_CONNECTION_FAILED|Failed to load resource|AJAXError|GPU stall/;

function assert(cond, label) {
  if (!cond) throw new Error("FAILED: " + label);
  console.log("ok - " + label);
}

const browser = await chromium.launch({ executablePath: EXECUTABLE, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => {
  if (m.type() === "error" && !IGNORABLE.test(m.text())) errors.push("console: " + m.text());
});

await page.goto(BASE + "/index.html", { waitUntil: "load", timeout: 30000 });
await page.waitForFunction(() => {
  const m = window.LandMap && window.LandMap.map;
  return m && m.isStyleLoaded();
}, { timeout: 30000 });
await page.waitForTimeout(4000);

// Default = universe view, no preset.
assert(!(await page.evaluate(() => document.getElementById("sb1123-btn").classList.contains("active"))),
  "SB preset is OFF by default (universe view)");
assert((await page.evaluate(() => document.getElementById("list-title").textContent)) === "Matches in view",
  "list titled 'Matches in view' by default");

// Counts span every tile source (the county is split into chunk archives).
const counts = () => page.evaluate(() => {
  const m = window.LandMap.map;
  const lids = window.LandMap.lids || ((b) => [b]);
  const layers = lids(m.getZoom() >= 14 ? "parcels-fill" : "centroids");
  return new Set(m.queryRenderedFeatures({ layers }).map((f) => f.properties.ain)).size;
});

const baseline = await counts();
assert(baseline > 500, `universe dots render at start view (${baseline})`);

// SB preset narrows to candidates.
await page.click("#sb1123-btn");
await page.waitForTimeout(2000);
const sbCount = await counts();
assert(sbCount > 0 && sbCount < baseline, `SB preset narrows universe (${baseline} -> ${sbCount})`);
assert((await page.evaluate(() => document.getElementById("list-title").textContent)) === "Candidates in view",
  "list titled 'Candidates in view' under SB preset");
await page.click("#reset-btn");
await page.waitForTimeout(1500);

// Improvements=Vacant narrows; SFR excludes vacant.
await page.click('.dropdown[data-dd="improvements"] [data-dd-btn]');
await page.check('input[name="imp"][value="vacant"]');
await page.waitForTimeout(2000);
const vacantCount = await counts();
assert(vacantCount > 0 && vacantCount < baseline, `Vacant narrows universe (${vacantCount})`);
await page.click("#reset-btn");
await page.waitForTimeout(1200);

// Reference parcel: 6540 Shoup Ave must be present, filterable, clickable.
await page.evaluate(() => window.LandMap.map.jumpTo({ center: [-118.614106, 34.189294], zoom: 15.2 }));
await page.waitForTimeout(4000);
const shoupPt = await page.evaluate((AIN) => {
  const m = window.LandMap.map;
  const f = m.queryRenderedFeatures({ layers: ["parcels-fill"] }).find((x) => x.properties.ain === AIN);
  if (!f) return null;
  const ring = f.geometry.type === "MultiPolygon" ? f.geometry.coordinates[0][0] : f.geometry.coordinates[0];
  const [sx, sy] = ring.reduce((a, c) => [a[0] + c[0], a[1] + c[1]], [0, 0]).map((v) => v / ring.length);
  const p = m.project([sx, sy]);
  const rect = m.getCanvas().getBoundingClientRect();
  return { x: rect.left + p.x, y: rect.top + p.y };
}, SHOUP_AIN);
assert(shoupPt, "6540 Shoup Ave renders in the universe at parcel zoom");
await page.mouse.click(shoupPt.x, shoupPt.y);
await page.waitForSelector("#detail-panel:not(.hidden) .dp-addr", { timeout: 8000 });
const panel = await page.evaluate(() => ({
  addr: document.querySelector("#detail-panel .dp-addr")?.textContent || "",
  assessor: !!document.querySelector('#detail-panel a[href*="portal.assessor.lacounty.gov"]'),
}));
assert(panel.addr.includes("6540 Shoup Ave"), `detail panel shows the parcel (${panel.addr})`);
assert(panel.assessor, "detail panel links to assessor portal");
await page.click("#dp-close");

// SFR filter keeps Shoup, drops condo unit records.
await page.click('.dropdown[data-dd="improvements"] [data-dd-btn]');
await page.check('input[name="imp"][value="sfr"]');
await page.waitForTimeout(2500);
const sfrCheck = await page.evaluate((AIN) => {
  const feats = window.LandMap.map.queryRenderedFeatures({ layers: ["parcels-fill"] });
  return {
    shoup: feats.some((f) => f.properties.ain === AIN),
    condos: feats.filter((f) => /UNIT|NO +\d/i.test(f.properties.a || "")).length,
  };
}, SHOUP_AIN);
assert(sfrCheck.shoup, "SFR filter keeps 6540 Shoup Ave");
assert(sfrCheck.condos === 0, `SFR filter excludes condo unit records (${sfrCheck.condos})`);

// Hard exclusions: in fire-hazard hills, no rendered universe match may be
// in a fire/coastal zone or publicly owned (context ghosts are fine).
await page.evaluate(() => window.LandMap.map.jumpTo({ center: [-118.588, 34.105], zoom: 14.6 }));
await page.waitForTimeout(4000);
const excl = await page.evaluate(() => {
  const feats = window.LandMap.map.queryRenderedFeatures({ layers: window.LandMap.lids("parcels-fill") });
  return {
    total: feats.length,
    bad: feats.filter((x) => [1, 2].includes(x.properties.f)
      || x.properties.c === 1 || x.properties.pb === 1).length,
  };
});
assert(excl.bad === 0, `no fire/coastal/public parcels among matches (${excl.bad}/${excl.total})`);

// Expanded coverage: parcels must render in the non-region chunks too.
await page.click("#reset-btn");
for (const [name, center] of [
  ["Silver Lake", [-118.27, 34.095]],
  ["Long Beach", [-118.19, 33.77]],
  ["Oxnard (Ventura Co.)", [-119.18, 34.20]],
]) {
  await page.evaluate((c) => window.LandMap.map.jumpTo({ center: c, zoom: 15 }), center);
  await page.waitForTimeout(4000);
  const n = await counts();
  assert(n > 50, `${name} parcels render (${n})`);
}

// CSV export covers matches with assessor URLs.
const csv = await page.evaluate(() => window.LandMap.exportCsv());
assert(csv.split("\n").length > 10 && csv.includes("assessor"), "CSV export has rows and header");

if (errors.length) {
  console.error("Unexpected page errors:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("\nALL SMOKE TESTS PASSED");
await browser.close();
