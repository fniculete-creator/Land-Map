// One-off verification of the OZ 2.0 filter (run with the dev server up):
//   CHROMIUM_PATH=... node tests/oz.verify.mjs http://localhost:8123
// Anchors on data/oz2.json (210 Recommended tracts, LA/VC/SB extent).
import { chromium } from "playwright-core";

const BASE = process.argv[2] || "http://localhost:8123";
const EXECUTABLE = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium";

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

assert(await page.$eval("#oz-btn", (el) => !el.classList.contains("active")),
  "OZ pill inactive by default");

// The app boots into Status=Approved (no universe count) — clear to the
// plain universe view before measuring.
await page.click("#reset-btn");
await page.waitForFunction(() => {
  const n = Number(document.getElementById("result-count").textContent.replace(/,/g, ""));
  return Number.isFinite(n) && n > 0;
}, { timeout: 20000 });
const before = await page.evaluate(() =>
  Number(document.getElementById("result-count").textContent.replace(/,/g, "")));

await page.click("#oz-btn");
// The pill class syncs after the tract data fetch resolves — wait on it.
const activated = await page.waitForFunction(
  () => document.getElementById("oz-btn").classList.contains("active"),
  { timeout: 20000 }).then(() => true).catch(() => false);
assert(activated, "OZ pill activates");
await page.waitForFunction(() => window.LandMap.map.getLayer("oz2-tint")
  && window.LandMap.map.getLayoutProperty("oz2-tint", "visibility") === "visible",
  { timeout: 20000 }).catch(() => {});
assert(await page.evaluate(() =>
  window.LandMap.map.getLayoutProperty("oz2-tint", "visibility") === "visible"),
  "OZ tract tint layer visible");

// The start view (Valley) is mostly outside OZ tracts, so the universe count
// must shrink — and never grow. The within re-evaluation over the big tile
// sources takes several seconds; wait for the refreshed count, not a timer.
const narrowed = await page.waitForFunction((prev) => {
  const t = document.getElementById("result-count").textContent.replace(/,/g, "");
  const n = Number(t);
  return Number.isFinite(n) && t !== "" && n > 0 && n < prev;
}, before, { timeout: 45000 }).then(() => true).catch(() => false);
const after = await page.evaluate(() =>
  Number(document.getElementById("result-count").textContent.replace(/,/g, "")));
assert(narrowed, `OZ narrows the universe (${before} -> ${after})`);

const hash = await page.evaluate(async () => {
  const m = await import("./js/filters.js");
  return m.stateToHash(window.LandMap.state);
});
assert(hash.includes("oz=1"), `hash carries oz state (${hash})`);

// SB preset toggle keeps the OZ scope.
await page.click("#sb1123-btn");
await page.waitForTimeout(600);
assert(await page.evaluate(() => window.LandMap.state.oz === true
  && window.LandMap.state.sbPreset === true), "SB preset keeps OZ on");
await page.click("#sb1123-btn");
await page.waitForTimeout(400);

// Toggle off restores everything.
await page.click("#oz-btn");
await page.waitForFunction(() => window.LandMap.state.oz === false, { timeout: 20000 });
assert(await page.evaluate(() =>
  window.LandMap.map.getLayoutProperty("oz2-tint", "visibility") === "none"),
  "tint hidden after toggle off");

await browser.close();
console.log(failures ? `\n${failures} FAILURES` : "\nALL OZ CHECKS PASSED");
process.exit(failures ? 1 : 0);
