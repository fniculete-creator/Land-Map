// One-off verification of the On Market filter (run with the dev server up):
//   CHROMIUM_PATH=... node tests/onmarket.verify.mjs http://localhost:8123
// Anchors on the real 6540 Shoup Ave listing in data/listings.json
// (price 2,000,000 / 20,910 sf lot = $96/sf land).
import { chromium } from "playwright-core";

const BASE = process.argv[2] || "http://localhost:8123";
const EXECUTABLE = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium";
const AIN = "2139012035";

let failures = 0;
function assert(cond, label) {
  console.log((cond ? "ok - " : "FAIL - ") + label);
  if (!cond) failures++;
}

const browser = await chromium.launch({ executablePath: EXECUTABLE, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => { console.log("PAGE ERROR:", e.message); failures++; });
await page.goto(BASE + "/index.html", { waitUntil: "load", timeout: 30000 });
await page.waitForFunction(() => window.LandMap && window.LandMap.map, { timeout: 20000 });
await page.waitForFunction(() => window.LandMap.map.isStyleLoaded(), { timeout: 20000 });

// $/SF pill hidden until On Market is active.
assert(await page.$eval("#ppsf-dd", (el) => el.classList.contains("hidden")),
  "$/SF pill hidden by default");

// Toggle On Market.
await page.click("#onmarket-btn");
await page.waitForTimeout(1200);
assert(await page.$eval("#onmarket-btn", (el) => el.classList.contains("active")),
  "On Market pill activates");
assert(await page.$eval("#ppsf-dd", (el) => !el.classList.contains("hidden")),
  "$/SF pill appears when active");
assert(await page.evaluate(() => window.LandMap.state.om === true), "state.om true");
assert(await page.evaluate(() => window.LandMap.state.dealStatus === "any"),
  "status search cleared (mutually exclusive)");

// List becomes the citywide deal sheet with price + $/SF. (The activation
// zoom animates and the list refreshes on idle — wait for the row.)
await page.waitForFunction(
  () => document.querySelectorAll("#site-list .site-item").length > 0,
  { timeout: 20000 });
// The sheet caps at the 80 cheapest deals in view, so isolate the Shoup
// anchor ($96/sf) with the $/SF range before asserting on its row.
await page.click("#ppsf-dd [data-dd-btn]");
await page.fill("#ppsf-min", "90");
await page.fill("#ppsf-max", "100");
await page.$eval("#ppsf-max", (el) => el.dispatchEvent(new Event("change")));
await page.waitForFunction(
  () => [...document.querySelectorAll("#site-list .site-item")]
    .some((el) => el.textContent.includes("6540 Shoup Ave")),
  { timeout: 20000 }).catch(() => {});
const row = await page.evaluate(() => {
  const items = [...document.querySelectorAll("#site-list .site-item")];
  const li = items.find((el) => el.textContent.includes("6540 Shoup Ave"));
  return li ? li.textContent : "";
});
assert(row.includes("6540 Shoup Ave"), `deal row listed (${row.trim().slice(0, 60)})`);
assert(row.includes("2,000,000"), "deal row shows list price");
assert(row.includes("96") && row.includes("/sf land"), "deal row shows $96/sf land");
assert(await page.$eval("#list-title", (el) => el.textContent === "On-market deals"),
  "list titled 'On-market deals'");

// Marker renders on the map (om-markers layer).
const marker = await page.evaluate(() => {
  const feats = window.LandMap.map.queryRenderedFeatures({ layers: ["om-markers"] });
  return feats.map((f) => f.properties.ain);
});
assert(marker.includes(AIN), "orange listing marker renders");

// $/SF range excludes the deal, then re-includes it. (The sheet holds real
// deals besides the fixture, so assert on the Shoup row, not the row count.)
await page.fill("#ppsf-min", "");
await page.fill("#ppsf-max", "90");
await page.$eval("#ppsf-max", (el) => el.dispatchEvent(new Event("change")));
const excluded = await page.waitForFunction(
  () => ![...document.querySelectorAll("#site-list .site-item")]
    .some((el) => el.textContent.includes("6540 Shoup Ave")),
  { timeout: 20000 }).then(() => true).catch(() => false);
assert(excluded, "max $90/sf excludes the $96/sf deal");

// Below the cheapest real deal (rounded $20/sf) the sheet empties entirely.
await page.fill("#ppsf-max", "19");
await page.$eval("#ppsf-max", (el) => el.dispatchEvent(new Event("change")));
const emptied = await page.waitForFunction(
  () => document.querySelectorAll("#site-list .site-item").length === 0,
  { timeout: 20000 }).then(() => true).catch(() => false);
assert(emptied, "max $19/sf empties the deal sheet");
const emptyMsg = await page.$eval("#empty-sites", (el) => el.textContent);
assert(/\$\/SF range/.test(emptyMsg), "empty state explains the $/SF range");

await page.fill("#ppsf-min", "90");
await page.fill("#ppsf-max", "100");
await page.$eval("#ppsf-max", (el) => el.dispatchEvent(new Event("change")));
const included = await page.waitForFunction(
  () => [...document.querySelectorAll("#site-list .site-item")]
    .some((el) => el.textContent.includes("6540 Shoup Ave")),
  { timeout: 20000 }).then(() => true).catch(() => false);
assert(included, "range 90-100 re-includes the deal");

// SB preset toggling preserves On Market.
await page.click("#sb1123-btn");
await page.waitForTimeout(800);
assert(await page.evaluate(() => window.LandMap.state.om === true
  && window.LandMap.state.sbPreset === true), "SB preset keeps On Market on");
await page.click("#sb1123-btn");
await page.waitForTimeout(500);

// Detail panel shows the listing section.
await page.evaluate((ain) => {
  const feats = window.LandMap.map.queryRenderedFeatures({ layers: ["om-markers"] });
  const f = feats.find((x) => x.properties.ain === ain);
  window.LandMap.map.fire("click", { lngLat: { lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }, point: window.LandMap.map.project(f.geometry.coordinates), features: [f] });
}, AIN).catch(() => {});
// Simpler: open via the list row (the Shoup fixture row specifically).
await page.evaluate(() => {
  [...document.querySelectorAll("#site-list .site-item")]
    .find((el) => el.textContent.includes("6540 Shoup Ave"))?.click();
});
await page.waitForTimeout(1000);
const panelText = await page.$eval("#detail-panel", (el) => el.textContent);
assert(panelText.includes("On market"), "detail panel has On market section");
assert(panelText.includes("2,000,000"), "detail panel shows list price");
// "View listing" only renders when the record carries a url; MLS exports
// don't, so assert the link exactly when the data has one.
const anchorHasUrl = await page.evaluate(async () => {
  const r = await fetch("data/listings.json").then((x) => x.json());
  return Boolean(r["2139012035"]?.url);
});
assert(panelText.includes("View listing") === anchorHasUrl,
  `detail panel links to the listing only when url present (url=${anchorHasUrl})`);

// URL hash round-trips om + range.
const hash = await page.evaluate(async () => {
  const m = await import("./js/filters.js");
  return m.stateToHash(window.LandMap.state);
});
assert(hash.includes("om=1") && hash.includes("ppsf=90..100"), `hash carries om state (${hash})`);

await browser.close();
console.log(failures ? `\n${failures} FAILURES` : "\nALL ON-MARKET CHECKS PASSED");
process.exit(failures ? 1 : 0);
