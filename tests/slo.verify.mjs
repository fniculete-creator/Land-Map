// One-off verification of the SLO (Small Lot Ordinance) overlay (run with the dev server up):
//   CHROMIUM_PATH=... node tests/slo.verify.mjs http://localhost:8123
// Anchors on data/slo.json: AA-2015-4272-PMLA-SL, 1952-1954 S Manning Ave, 4 homes built 2018.
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

const vis = () => page.evaluate(() => window.LandMap.map.getLayoutProperty("slo-markers", "visibility"));
assert(await page.$eval("#slo-btn", (el) => !el.classList.contains("active")), "SLO pill inactive by default");
assert((await vis()) === "none", "SLO markers hidden by default");

await page.click("#slo-btn");
assert(await page.$eval("#slo-btn", (el) => el.classList.contains("active")), "SLO pill activates");
assert((await vis()) === "visible", "SLO markers visible when on");
assert(await page.$eval(".lg-slo-row", (el) => !el.classList.contains("hidden")), "SLO legend rows shown");

const n = await page.evaluate(() => window.LandMap.map.getSource("slo").serialize().data.features.length);
assert(n > 700, `SLO source carries ${n} cases`);

// fly to the Manning anchor and click its marker
await page.evaluate(() => window.LandMap.map.jumpTo({ center: [-118.42876, 34.050278], zoom: 16 }));
await page.waitForFunction(() => window.LandMap.map.loaded(), { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(1500);
const pt = await page.evaluate(() => {
  const m = window.LandMap.map; const p = m.project([-118.42876, 34.050278]);
  const r = m.getContainer().getBoundingClientRect(); return { x: r.left + p.x, y: r.top + p.y };
});
await page.mouse.click(pt.x, pt.y);
await page.waitForTimeout(800);
const panel = await page.$eval("#detail-panel", (el) => (el.classList.contains("hidden") ? "" : el.innerText));
assert(/AA-2015-4272-PMLA-SL/.test(panel), "clicking the Manning marker opens its SLO case");
assert(/Homes built\s*4/.test(panel), "panel shows 4 homes built");

await page.click("#slo-btn");
assert((await vis()) === "none", "SLO markers hide again");
await page.screenshot({ path: process.env.SHOT || "slo.png" });
await browser.close();
console.log(failures ? `${failures} failure(s)` : "all passed");
process.exit(failures ? 1 : 0);
