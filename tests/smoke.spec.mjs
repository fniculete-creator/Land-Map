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

const baseline = await counts();
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
  assessorHref: document.querySelector('.maplibregl-popup a[href*="portal.assessor.lacounty.gov/parceldetail/"]')?.href || "",
}));
assert(/^APN \d+/.test(popup.title), `popup shows APN (${popup.title})`);
assert(popup.assessorHref.includes("portal.assessor.lacounty.gov/parceldetail/"), "popup links to assessor portal");

// SB 1123 preset must strictly reduce the visible parcel count.
await page.click("#sb1123-btn");
await page.waitForTimeout(1200);
const afterPreset = await counts();
assert(afterPreset.parcels < baseline.parcels, `SB preset reduced parcels ${baseline.parcels} -> ${afterPreset.parcels}`);
assert(afterPreset.parcels > 0, `SB preset still shows candidates (${afterPreset.parcels})`);
const hash = await page.evaluate(() => location.hash);
assert(hash.includes("sb=1"), `filter state serialized to URL hash (${hash})`);

// Range filter: min lot size high enough to cut the SB set further.
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
