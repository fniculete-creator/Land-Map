// One-off verification: Articles section + export checkboxes + Excel export.
//   CHROMIUM_PATH=... node tests/panel.verify.mjs http://localhost:8123
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

// --- Sherman Way: 10 homes + Articles section -------------------------------
// Default view is Status=Approved, which lists the approved cases citywide.
await page.waitForFunction(() =>
  [...document.querySelectorAll("#site-list .site-item")].some(
    (li) => li.textContent.includes("22112 W Sherman Way")), { timeout: 20000 });
const shermanRow = await page.evaluate(() => {
  const li = [...document.querySelectorAll("#site-list .site-item")]
    .find((x) => x.textContent.includes("22112 W Sherman Way"));
  return li.textContent;
});
assert(shermanRow.includes("10 homes"), `Sherman Way row shows 10 homes (${shermanRow.trim().slice(0, 70)})`);

await page.evaluate(() => {
  [...document.querySelectorAll("#site-list .site-item")]
    .find((x) => x.textContent.includes("22112 W Sherman Way")).click();
});
await page.waitForSelector("#detail-panel:not(.hidden)", { timeout: 15000 });
const panel = await page.$eval("#detail-panel", (el) => el.innerHTML);
assert(panel.includes("Homes") && panel.includes(">10<"), "detail panel shows Homes: 10");
assert(panel.includes("Articles"), "detail panel has Articles section");
assert(panel.includes("la.urbanize.city"), "Articles links to Urbanize LA");
assert(panel.includes("Urbanize LA · 2025-08-03"), "article shows source + date");

// --- Checkboxes + Excel export ----------------------------------------------
const boxes = await page.evaluate(() =>
  document.querySelectorAll("#site-list .site-check").length);
assert(boxes > 0, `every row has a checkbox (${boxes})`);

await page.evaluate(() => {
  const cbs = document.querySelectorAll("#site-list .site-check");
  cbs[0].click();
  cbs[1].click();
});
await page.waitForFunction(
  () => document.getElementById("export-btn").textContent === "Excel (2)",
  { timeout: 10000 });
assert(true, "export button shows Excel (2) after checking two rows");
assert(await page.$eval("#list-count", (el) => el.textContent.includes("2 checked")),
  "list header shows '2 checked'");

// Checked rows survive a list re-render (pan the map).
await page.evaluate(() => window.LandMap.map.panBy([120, 0], { duration: 0 }));
await page.waitForTimeout(1500);
const stillChecked = await page.evaluate(() =>
  [...document.querySelectorAll("#site-list .site-check")].filter((c) => c.checked).length);
assert(stillChecked >= 1, `checks survive re-render (${stillChecked} still visible-checked)`);

// Excel download: 2 selected rows only, LAAA navy header present.
const [download] = await Promise.all([
  page.waitForEvent("download", { timeout: 15000 }),
  page.click("#export-btn"),
]);
assert(download.suggestedFilename() === "land-sites.xls", "downloads land-sites.xls");
const path = await download.path();
const fs = await import("fs");
const xls = fs.readFileSync(path, "utf8");
assert(xls.includes("#1B3A5C") && xls.includes("#C9A45C"), "Excel has LAAA navy/gold header");
assert((xls.match(/<tr>/g) || []).length === 3, "Excel has header + exactly 2 checked rows");
assert(xls.includes("List Price") && xls.includes("$/SF Land"), "Excel carries listing columns");

// Clear link empties the selection.
await page.click("#clear-checks");
await page.waitForFunction(
  () => document.getElementById("export-btn").textContent === "Excel",
  { timeout: 10000 });
assert(true, "clear resets the export button");

await browser.close();
console.log(failures ? `\n${failures} FAILURES` : "\nALL PANEL CHECKS PASSED");
process.exit(failures ? 1 : 0);
