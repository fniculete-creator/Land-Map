// One-off verification of the On Market filter (run with the dev server up):
//   CHROMIUM_PATH=... node tests/onmarket.verify.mjs http://localhost:8123
// Expects data/listings.json to contain the 6540 Shoup Ave test listing
// (price 1,500,000 / 10,000 sf lot = $150/sf land).
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
const row = await page.evaluate(() => {
  const li = document.querySelector("#site-list .site-item");
  return li ? li.textContent : "";
});
assert(row.includes("6540 Shoup Ave"), `deal row listed (${row.trim().slice(0, 60)})`);
assert(row.includes("1,500,000"), "deal row shows list price");
assert(row.includes("150") && row.includes("/sf land"), "deal row shows $150/sf land");
assert(await page.$eval("#list-title", (el) => el.textContent === "On-market deals"),
  "list titled 'On-market deals'");

// Marker renders on the map (om-markers layer).
const marker = await page.evaluate(() => {
  const feats = window.LandMap.map.queryRenderedFeatures({ layers: ["om-markers"] });
  return feats.map((f) => f.properties.ain);
});
assert(marker.includes(AIN), "orange listing marker renders");

// $/SF range excludes the deal, then re-includes it.
await page.click("#ppsf-dd [data-dd-btn]");
await page.fill("#ppsf-max", "100");
await page.$eval("#ppsf-max", (el) => el.dispatchEvent(new Event("change")));
const excluded = await page.waitForFunction(
  () => document.querySelectorAll("#site-list .site-item").length === 0,
  { timeout: 20000 }).then(() => true).catch(() => false);
assert(excluded, "max $100/sf excludes the $150/sf deal");
const emptyMsg = await page.$eval("#empty-sites", (el) => el.textContent);
assert(/\$\/SF range/.test(emptyMsg), "empty state explains the $/SF range");

await page.fill("#ppsf-max", "200");
await page.$eval("#ppsf-max", (el) => el.dispatchEvent(new Event("change")));
const included = await page.waitForFunction(
  () => document.querySelectorAll("#site-list .site-item").length === 1,
  { timeout: 20000 }).then(() => true).catch(() => false);
assert(included, "max $200/sf re-includes the deal");

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
// Simpler: open via the list row.
await page.click("#site-list .site-item");
await page.waitForTimeout(1000);
const panelText = await page.$eval("#detail-panel", (el) => el.textContent);
assert(panelText.includes("On market"), "detail panel has On market section");
assert(panelText.includes("1,500,000"), "detail panel shows list price");
assert(panelText.includes("View listing"), "detail panel links to the listing");

// URL hash round-trips om + range.
const hash = await page.evaluate(async () => {
  const m = await import("./js/filters.js");
  return m.stateToHash(window.LandMap.state);
});
assert(hash.includes("om=1") && hash.includes("ppsf=..200"), `hash carries om state (${hash})`);

await browser.close();
console.log(failures ? `\n${failures} FAILURES` : "\nALL ON-MARKET CHECKS PASSED");
process.exit(failures ? 1 : 0);
