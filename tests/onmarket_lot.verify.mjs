// On Market deal sheet and markers follow Lot Size and Improvements (run with the dev server up):
//   CHROMIUM_PATH=... node tests/onmarket_lot.verify.mjs http://localhost:8123
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

const t0 = Date.now();
await page.click("#onmarket-btn");
await page.waitForFunction(() => document.querySelector("#site-list .site-item .site-sub, #site-list .site-item")
  && document.getElementById("list-count").textContent.includes("Top"), { timeout: 40000 });
console.log(`  On Market list ready in ${Date.now() - t0} ms`);

// The lot figures in the rows, e.g. "39,795 SF Lot".
const lots = () => page.evaluate(() => [...document.querySelectorAll("#site-list .site-item")]
  .map((el) => (el.textContent.match(/([\d,]+) SF Lot/) || [])[1])
  .filter(Boolean).map((s) => Number(s.replace(/,/g, ""))));
const markerAins = () => page.evaluate(() => {
  const f = window.LandMap.map.getFilter("om-markers");
  return f[2][1].length;
});
const total = await markerAins();
assert((await lots()).some((n) => n < 10000), `before the filter the sheet has lots under 10,000 SF (${total} deals)`);

// Typed, with no Enter and no leaving the box.
await page.click("#lsf-dd [data-dd-btn], [data-dd-btn]:has-text('Lot Size')");
await page.click("#lsf-min");
const t1 = Date.now();
await page.keyboard.type("10000");
const ok = await page.waitForFunction(() => {
  const rows = [...document.querySelectorAll("#site-list .site-item")]
    .map((el) => (el.textContent.match(/([\d,]+) SF Lot/) || [])[1]).filter(Boolean)
    .map((s) => Number(s.replace(/,/g, "")));
  return rows.length && rows.every((n) => n >= 10000);
}, { timeout: 30000 }).then(() => true).catch(() => false);
console.log(`  list updated ${Date.now() - t1} ms after typing`);
assert(ok, "typing a 10,000 SF minimum drops every smaller lot from the sheet");
const atMin = await markerAins();
assert(atMin > 0 && atMin < total, `markers narrow too (${total} -> ${atMin})`);

await page.fill("#lsf-max", "12000");
await page.keyboard.press("Enter");
await page.waitForFunction(() => {
  const rows = [...document.querySelectorAll("#site-list .site-item")]
    .map((el) => (el.textContent.match(/([\d,]+) SF Lot/) || [])[1]).filter(Boolean)
    .map((s) => Number(s.replace(/,/g, "")));
  return rows.length && rows.every((n) => n >= 10000 && n <= 12000);
}, { timeout: 30000 }).catch(() => {});
const band = await lots();
assert(band.length && band.every((n) => n >= 10000 && n <= 12000), `a min and max hold together (${band.length} rows)`);

// Clearing restores everything.
await page.fill("#lsf-min", "");
await page.fill("#lsf-max", "");
await page.keyboard.press("Enter");
await page.waitForFunction((t) => {
  const f = window.LandMap.map.getFilter("om-markers");
  return f[2][1].length === t;
}, total, { timeout: 15000 }).catch(() => {});
assert(await markerAins() === total, "clearing the lot range restores every deal");

// Improvements: Vacant is the Land listings only.
await page.evaluate(() => {
  const rb = document.querySelector('input[type=radio][value="vacant"]');
  rb.checked = true;
  rb.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.waitForTimeout(800);
const land = await page.evaluate(async () => Object.values(await fetch("data/listings.json").then((r) => r.json()))
  .filter((l) => l.type === "Land").length);
const vacant = await markerAins();
assert(vacant > 0 && vacant <= land, `Vacant keeps only Land listings (${vacant} of ${land} Land)`);

await browser.close();
console.log(failures ? `\n${failures} FAILURES` : "\nALL ON-MARKET LOT CHECKS PASSED");
process.exit(failures ? 1 : 0);
