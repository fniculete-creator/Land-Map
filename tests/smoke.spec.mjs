// Headless smoke test for the Land-Map app against the demo tileset.
// Usage: node tests/smoke.spec.mjs [baseUrl]
//   1. serve the repo:  python3 scripts/pipeline/serve.py 8123
//   2. run:             node tests/smoke.spec.mjs http://localhost:8123
// Requires playwright-core (npm i playwright-core) and a chromium binary
// (CHROMIUM_PATH env var, default /opt/pw-browsers/chromium).

import { chromium } from "playwright-core";

const BASE = process.argv[2] || "http://localhost:8123";
const EXECUTABLE = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium";

// Basemap tile hosts are unreachable in sandboxes — those errors are expected.
const IGNORABLE = /tile\.openstreetmap\.org|arcgisonline\.com|ERR_TUNNEL_CONNECTION_FAILED|Failed to load resource|AJAXError|GPU stall/;

function assert(cond, label) {
  if (!cond) throw new Error("FAILED: " + label);
  console.log("ok - " + label);
}

const browser = await chromium.launch({ executablePath: EXECUTABLE, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => {
  if (m.type() === "error" && !IGNORABLE.test(m.text())) errors.push("console: " + m.text());
});

await page.goto(BASE + "/index.html", { waitUntil: "load", timeout: 30000 });

// Wait for the map to be idle with rendered parcel features.
await page.waitForFunction(() => {
  const m = window.LandMap && window.LandMap.map;
  return m && m.isStyleLoaded() && m.queryRenderedFeatures({ layers: ["parcels-fill"] }).length > 0;
}, { timeout: 30000 });
assert(true, "map loaded and parcel polygons rendered");

const counts = () => page.evaluate(() => {
  const m = window.LandMap.map;
  const dedupe = (layer) => new Set(
    m.queryRenderedFeatures({ layers: [layer] }).map((f) => f.properties.ain)
  ).size;
  return { parcels: dedupe("parcels-fill"), centroids: dedupe("centroids") };
});

// SB 1123 preset is ON by default — only qualifiers render at first.
const defaultOn = await page.evaluate(() =>
  document.getElementById("sb1123-btn").classList.contains("active"));
assert(defaultOn, "SB 1123 preset is active on first load");
const presetStart = await counts();
assert(presetStart.parcels > 0, `default view shows candidates (${presetStart.parcels})`);

// Toggle it off to establish the all-parcels baseline.
await page.click("#sb1123-btn");
await page.waitForTimeout(1500);
const baseline = await counts();
assert(baseline.parcels > presetStart.parcels, `all parcels exceed candidates (${baseline.parcels} > ${presetStart.parcels})`);
assert(baseline.parcels > 100, `baseline parcel count is substantial (${baseline.parcels})`);

// Demo banner should be visible (synthetic tileset watermark).
await page.waitForSelector("#demo-banner:not(.hidden)", { timeout: 10000 });
assert(true, "synthetic-data demo banner shown");

// Click a parcel -> popup with APN + assessor link. Click the screen position
// of an actually-rendered polygon so the hit is guaranteed.
const pt = await page.evaluate(() => {
  const m = window.LandMap.map;
  const feats = m.queryRenderedFeatures({ layers: ["parcels-fill"] });
  if (!feats.length) return null;
  const f = feats[Math.floor(feats.length / 2)];
  const ring = f.geometry.type === "MultiPolygon"
    ? f.geometry.coordinates[0][0] : f.geometry.coordinates[0];
  const [sx, sy] = ring
    .reduce((a, c) => [a[0] + c[0], a[1] + c[1]], [0, 0])
    .map((v) => v / ring.length);
  const p = m.project([sx, sy]);
  const rect = m.getCanvas().getBoundingClientRect();
  return { x: rect.left + p.x, y: rect.top + p.y };
});
assert(pt, "found a rendered parcel to click");
await page.mouse.click(pt.x, pt.y);
await page.waitForSelector(".maplibregl-popup .popup-title", { timeout: 10000 });
const popup = await page.evaluate(() => ({
  title: document.querySelector(".maplibregl-popup .popup-title")?.textContent || "",
  apnRow: document.querySelector(".maplibregl-popup .popup-table")?.textContent || "",
  assessorHref: document.querySelector('.maplibregl-popup a[href*="portal.assessor.lacounty.gov/parceldetail/"]')?.href || "",
}));
assert(/^(\d+ .+|APN \d+)/.test(popup.title), `popup titled by address or APN fallback (${popup.title})`);
assert(/APN\d+/.test(popup.apnRow.replace(/\s/g, "")), "popup table includes APN");
assert(popup.assessorHref.includes("portal.assessor.lacounty.gov/parceldetail/"), "popup links to assessor portal");
const svHref = await page.evaluate(() =>
  document.querySelector('.maplibregl-popup a[href*="google.com/maps"]')?.href || "");
assert(svHref.includes("layer=c&cbll="), "popup links to Google Street View");

// Candidates stat + list should reflect only qualifying (colored) parcels.
const candStat = await page.evaluate(() => Number(document.getElementById("stat-candidates").textContent.replace(/,/g, "")));
assert(candStat > 0 && candStat < baseline.parcels, `candidates stat is a strict subset (${candStat}/${baseline.parcels})`);
const listRows = await page.evaluate(() => document.querySelectorAll("#site-list .site-item").length);
assert(listRows > 0, `candidates list is populated (${listRows} rows)`);

// SB 1123 preset must show only qualifying parcels.
await page.click("#sb1123-btn");
await page.waitForTimeout(1200);
const afterPreset = await counts();
assert(afterPreset.parcels < baseline.parcels, `SB preset reduced parcels ${baseline.parcels} -> ${afterPreset.parcels}`);
assert(afterPreset.parcels > 0, `SB preset still shows candidates (${afterPreset.parcels})`);
assert(afterPreset.parcels === candStat, `SB preset count matches candidates stat (${afterPreset.parcels})`);
const hash = await page.evaluate(() => location.hash);
assert(hash.includes("sb=1"), `filter state serialized to URL hash (${hash})`);

// Range filter lives in the Lot size dropdown: open it, set a min.
await page.click('.dropdown[data-dd="lot"] [data-dd-btn]');
await page.fill("#lsf-min", "6000");
await page.dispatchEvent("#lsf-min", "change");
await page.waitForTimeout(1200);
const afterRange = await counts();
assert(afterRange.parcels < afterPreset.parcels, `lot-size min reduced parcels ${afterPreset.parcels} -> ${afterRange.parcels}`);

// Reset restores everything.
await page.click("#reset-btn");
await page.waitForTimeout(1200);
const afterReset = await counts();
assert(afterReset.parcels === baseline.parcels, `reset restores baseline (${afterReset.parcels})`);

// Tier filter (in the Tier dropdown): fixture parcels are all Tier A.
await page.click('.dropdown[data-dd="tier"] [data-dd-btn]');
await page.check("#tier-B");
await page.waitForTimeout(1200);
const tierB = await counts();
assert(tierB.parcels === 0, `tier B only hides all fixture parcels (${tierB.parcels})`);
await page.check("#tier-A");
await page.waitForTimeout(1200);
const tierAB = await counts();
assert(tierAB.parcels === baseline.parcels, `tiers A+B restore baseline (${tierAB.parcels})`);
const tierHash = await page.evaluate(() => location.hash);
assert(/t=/.test(tierHash), `tier filter serialized to hash (${tierHash})`);
await page.click("#reset-btn");
await page.waitForTimeout(800);

// Improvements filter: Vacant and SFR Home are each strict subsets.
await page.click('.dropdown[data-dd="improvements"] [data-dd-btn]');
await page.check('input[name="imp"][value="vacant"]');
await page.waitForTimeout(1200);
const impVacant = await counts();
assert(impVacant.parcels > 0 && impVacant.parcels < baseline.parcels,
  `Improvements=Vacant is a strict subset (${impVacant.parcels})`);
await page.check('input[name="imp"][value="sfr"]');
await page.waitForTimeout(1200);
const impSfr = await counts();
assert(impSfr.parcels > 0 && impSfr.parcels < baseline.parcels,
  `Improvements=SFR Home is a strict subset (${impSfr.parcels})`);
await page.click("#reset-btn");
await page.waitForTimeout(800);

// Deal status: assign one parcel "Submitted", filter to it, expect exactly 1.
const statusAin = await page.evaluate(() => {
  const f = window.LandMap.map.queryRenderedFeatures({ layers: ["parcels-fill"] })[0];
  window.LandMap.setStatus(f.properties.ain, "submitted");
  return f.properties.ain;
});
await page.click('.dropdown[data-dd="status"] [data-dd-btn]');
await page.check('input[name="dstatus"][value="submitted"]');
await page.waitForTimeout(1200);
const statusOnly = await counts();
assert(statusOnly.parcels === 1, `Status=Submitted shows exactly the tagged parcel (${statusOnly.parcels})`);
await page.evaluate((ain) => window.LandMap.setStatus(ain, ""), statusAin);
await page.click("#reset-btn");
await page.waitForTimeout(800);

// Zoom out to centroid mode and confirm dots render.
await page.evaluate(() => window.LandMap.map.jumpTo({ zoom: 11 }));
await page.waitForFunction(() => {
  const m = window.LandMap.map;
  return m.queryRenderedFeatures({ layers: ["centroids"] }).length > 0;
}, { timeout: 15000 });
assert(true, "centroid dots render at low zoom");

if (errors.length) {
  console.error("Unexpected page errors:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("\nALL SMOKE TESTS PASSED");
await browser.close();
