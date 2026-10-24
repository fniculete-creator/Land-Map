// Verification of the program bar and the Comps (Small Lot) program (run with the dev server up):
//   CHROMIUM_PATH=... node tests/comps.verify.mjs http://localhost:8123
// Anchors on data/comps_small_lot.json: Venice (90291) has small lot sales since 01/01/2025.
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
await page.waitForFunction(() => window.LandMap && window.LandMap.map && window.LandMap.map.isStyleLoaded(), { timeout: 30000 });

const active = () => page.$$eval(".prog-tab.active", (els) => els.map((e) => e.dataset.prog));
assert(JSON.stringify(await active()) === '["sb1123"]', "SB 1123 is the only active program at start");
assert(await page.$eval('.fgroup[data-prog="sb1123"]', (el) => !el.classList.contains("hidden")), "SB 1123 filters shown");
assert(await page.$eval("#market-seg", (el) => el === el.parentElement.firstElementChild), "On Market / Sold switch leads the SB 1123 filters");

await page.click("#comps-btn");
assert(JSON.stringify(await active()) === '["comps"]', "Comps replaces SB 1123 (one program at a time)");
assert(await page.$eval('.fgroup[data-prog="sb1123"]', (el) => el.classList.contains("hidden")), "SB 1123 filters hidden in Comps");
assert(await page.$eval('.fgroup[data-prog="comps"]', (el) => !el.classList.contains("hidden")), "Comps filters shown");
assert(await page.evaluate(() => window.LandMap.map.getLayoutProperty("comps-markers", "visibility")) === "visible", "comp markers visible");

await page.evaluate(() => window.LandMap.map.jumpTo({ center: [-118.465, 33.99], zoom: 14 }));
await page.waitForFunction(() => document.querySelectorAll("#site-list .site-item").length > 0, { timeout: 20000 }).catch(() => {});
const rows = await page.$$eval("#site-list .site-item", (els) => els.map((e) => e.innerText));
assert(rows.length > 0, `Venice lists small lot sales (${rows.length})`);
assert(rows.length && /\$[\d,]+/.test(rows[0]) && /\/sf/.test(rows[0]), "row shows price and $/SF");
const title = await page.$eval("#list-title", (e) => e.textContent);
assert(title === "Small lot sales in view", `list title (${title})`);
const n0 = rows.length;

await page.click('[data-dd="csince"] [data-dd-btn]');
await page.click('input[name="csince"][value="0"]');
await page.waitForTimeout(800);
const n1 = await page.$$eval("#site-list .site-item", (els) => els.length);
assert(n1 >= n0, `Any date widens the list (${n0} -> ${n1})`);

await page.click("#site-list .site-item");
await page.waitForTimeout(600);
const panel = await page.$eval("#detail-panel", (el) => (el.classList.contains("hidden") ? "" : el.innerText));
assert(/Sold \d\d\/\d\d\/\d{4}/i.test(panel) && /Per SF of home/i.test(panel) && /Sales/i.test(panel), "comp detail panel shows the sale");

await page.click("#prog-sb1123");
assert(await page.evaluate(() => window.LandMap.map.getLayoutProperty("comps-markers", "visibility")) === "none", "comp markers hide on SB 1123");
await page.screenshot({ path: process.env.SHOT || "comps.png" });
await browser.close();
console.log(failures ? `${failures} failure(s)` : "all passed");
process.exit(failures ? 1 : 0);
