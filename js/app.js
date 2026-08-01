import * as maplibregl from "../vendor/maplibre-gl/maplibre-gl.mjs";
import { CONFIG } from "./config.js";
import {
  emptyState, sb1123State, buildFilter, buildCentroidFilter,
  stateToHash, stateFromHash,
} from "./filters.js";

/* global pmtiles */

const COLORS = {
  eligible: "#10b981",
  eligibleLine: "#047857",
  neutralLine: "#c3cbd3",
  highlight: "#2563eb",
};

const TIER_NAMES = { A: "Westside", B: "South Valley", C: "Central/North Valley" };
const STATUS_LABELS = {
  submitted: "Submitted", approved: "Approved",
  completed: "Completed", forsale: "For Sale",
};

// Team-assigned deal statuses, keyed by AIN. Browser-local for now; syncing
// across the team needs a small backend (roadmap).
const STATUS_KEY = "land-map-status-v1";
let dealStatuses = {};
try { dealStatuses = JSON.parse(localStorage.getItem(STATUS_KEY)) || {}; } catch (e) { /* fresh */ }

function saveStatuses() {
  try { localStorage.setItem(STATUS_KEY, JSON.stringify(dealStatuses)); } catch (e) { /* private mode */ }
}

function statusAinsFor(status) {
  return Object.keys(dealStatuses).filter((ain) => dealStatuses[ain] === status);
}

let map;
// SB 1123 candidates are the product: start with the preset on, so searching
// a city immediately shows what qualifies there. A shared URL hash wins.
let state = location.hash.length > 1 ? stateFromHash(location.hash) : sb1123State(CONFIG);
let selectedAin = null;

// "4108 WHITSETT AVE" -> "4108 Whitsett Ave"
function fmtAddr(a) {
  if (!a) return "";
  return a.toLowerCase().replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
}

function displayName(p) {
  return fmtAddr(p.a) || "APN " + p.ain;
}

/* ---------------- map setup ---------------- */

const protocol = new pmtiles.Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);

const tilesUrl = new URL(CONFIG.PMTILES_URL, location.href).href;
const archive = new pmtiles.PMTiles(tilesUrl);
protocol.add(archive);

function baseStyle() {
  return {
    version: 8,
    sources: {
      streets: {
        type: "raster", tiles: CONFIG.BASEMAPS.streets.tiles, tileSize: 256,
        attribution: CONFIG.BASEMAPS.streets.attribution,
      },
      satellite: {
        type: "raster", tiles: CONFIG.BASEMAPS.satellite.tiles, tileSize: 256,
        attribution: CONFIG.BASEMAPS.satellite.attribution,
      },
      parcels: { type: "vector", url: "pmtiles://" + tilesUrl },
    },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": "#eef1f4" } },
      { id: "basemap-streets", type: "raster", source: "streets" },
      { id: "basemap-satellite", type: "raster", source: "satellite",
        layout: { visibility: "none" } },
      // Synthetic street grid — present only in fixture/demo tilesets; the
      // deployed app gets real streets from the raster basemap instead.
      {
        id: "demo-streets", type: "line", source: "parcels", "source-layer": "streets",
        paint: {
          "line-color": "#ffffff",
          "line-width": ["interpolate", ["linear"], ["zoom"],
            12, ["case", ["==", ["get", "cls"], "major"], 2, 1],
            16, ["case", ["==", ["get", "cls"], "major"], 14, 8]],
        },
      },
      {
        id: "centroids", type: "circle", source: "parcels", "source-layer": "centroids",
        maxzoom: 13,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"],
            8, ["case", ["==", ["get", "e"], 1], 2, 1],
            12, ["case", ["==", ["get", "e"], 1], 4.5, 2]],
          "circle-color": ["case", ["==", ["get", "e"], 1], COLORS.eligible, "#aeb7bf"],
          "circle-opacity": ["case", ["==", ["get", "e"], 1], 0.95, 0.45],
        },
      },
      {
        id: "parcels-fill", type: "fill", source: "parcels", "source-layer": "parcels",
        minzoom: 13,
        paint: {
          // Only qualifying parcels get color; everything else stays neutral.
          "fill-color": ["case", ["==", ["get", "e"], 1], COLORS.eligible, "#64748b"],
          "fill-opacity": ["case", ["==", ["get", "e"], 1], 0.55, 0.05],
        },
      },
      {
        id: "parcels-line", type: "line", source: "parcels", "source-layer": "parcels",
        minzoom: 13,
        paint: {
          "line-color": ["case", ["==", ["get", "e"], 1], COLORS.eligibleLine, COLORS.neutralLine],
          "line-width": ["case", ["==", ["get", "e"], 1], 1.4, 0.5],
        },
      },
      {
        id: "parcels-selected", type: "line", source: "parcels", "source-layer": "parcels",
        minzoom: 13,
        filter: ["==", ["get", "ain"], "___none___"],
        paint: { "line-color": COLORS.highlight, "line-width": 3 },
      },
    ],
  };
}

const FILTERED_LAYERS = ["parcels-fill", "parcels-line"];

function applyFilters() {
  const statusAins = state.dealStatus === "any" ? [] : statusAinsFor(state.dealStatus);
  const f = buildFilter(state, CONFIG, statusAins);
  for (const id of FILTERED_LAYERS) map.setFilter(id, f);
  const selBase = ["==", ["get", "ain"], selectedAin ?? "___none___"];
  map.setFilter("parcels-selected", f ? ["all", f, selBase] : selBase);
  map.setFilter("centroids", buildCentroidFilter(state, CONFIG, statusAins));
  history.replaceState(null, "", location.pathname + location.search + (stateToHash(state) || "#"));
  scheduleCount();
}

/* ---------------- stats + candidates list ---------------- */

let countTimer = null;
function scheduleCount() {
  clearTimeout(countTimer);
  countTimer = setTimeout(updateCount, 250);
}

function median(sorted) {
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
}

function fmt(n) { return Number(n).toLocaleString(); }

function updateCount() {
  if (!map || !map.isStyleLoaded()) return;
  const zoom = map.getZoom();
  const layer = zoom >= 13 ? "parcels-fill" : "centroids";
  const feats = map.queryRenderedFeatures({ layers: [layer] });

  const byAin = new Map();
  for (const f of feats) {
    if (!byAin.has(f.properties.ain)) byAin.set(f.properties.ain, f);
  }
  document.getElementById("result-count").textContent = byAin.size.toLocaleString();
  document.getElementById("result-label").textContent =
    zoom >= 13 ? "parcels in view" : "parcel dots in view";

  const candidates = [...byAin.values()].filter((f) => f.properties.e === 1);
  document.getElementById("stat-candidates").textContent = candidates.length.toLocaleString();

  const lots = candidates.map((f) => f.properties.lsf).sort((a, b) => a - b);
  const widths = candidates.map((f) => f.properties.w).filter((w) => w != null).sort((a, b) => a - b);
  const medLot = median(lots);
  const medW = median(widths);
  document.getElementById("stat-medlot").textContent = medLot === null ? "–" : fmt(medLot);
  document.getElementById("stat-medwidth").textContent = medW === null ? "–" : fmt(medW);

  renderList(candidates, zoom >= 13);
}

function featureCenter(f) {
  const g = f.geometry;
  if (g.type === "Point") return g.coordinates;
  const ring = g.type === "MultiPolygon" ? g.coordinates[0][0] : g.coordinates[0];
  const [sx, sy] = ring.reduce((a, c) => [a[0] + c[0], a[1] + c[1]], [0, 0]);
  return [sx / ring.length, sy / ring.length];
}

function renderList(candidates, detailed) {
  const list = document.getElementById("site-list");
  const empty = document.getElementById("empty-sites");
  const MAX = 80;

  candidates.sort((a, b) => (b.properties.lsf || 0) - (a.properties.lsf || 0));
  const shown = candidates.slice(0, MAX);

  document.getElementById("list-count").textContent =
    candidates.length > MAX ? `top ${MAX} of ${fmt(candidates.length)}` : "";

  list.innerHTML = "";
  empty.style.display = shown.length ? "none" : "block";

  for (const f of shown) {
    const p = f.properties;
    const li = document.createElement("li");
    li.className = "site-item" + (p.ain === selectedAin ? " selected" : "");

    const dot = document.createElement("span");
    dot.className = "site-dot";

    const info = document.createElement("div");
    info.className = "site-info";
    const name = document.createElement("div");
    name.className = "site-name";
    name.textContent = displayName(p);
    const meta = document.createElement("div");
    meta.className = "site-meta";
    const bits = [];
    if (p.a) bits.push("APN " + p.ain);
    else bits.push("no address");
    if (detailed && p.zc) bits.push(p.zc);
    bits.push(fmt(p.lsf) + " sf");
    if (detailed && p.w) bits.push("≈" + p.w + " ft");
    if (dealStatuses[p.ain]) bits.push(STATUS_LABELS[dealStatuses[p.ain]]);
    meta.textContent = bits.join(" · ");
    info.appendChild(name);
    info.appendChild(meta);

    const tier = document.createElement("span");
    tier.className = "site-tier";
    tier.textContent = p.t || "";

    const center = featureCenter(f);
    li.addEventListener("click", () => {
      map.easeTo({ center, zoom: Math.max(map.getZoom(), 15) });
      showDetail(p, { lat: center[1], lng: center[0] });
    });

    li.appendChild(dot);
    li.appendChild(info);
    li.appendChild(tier);
    list.appendChild(li);
  }
}

/* ---------------- parcel detail panel ---------------- */

function kvRow(key, value) {
  return `<div class="kv"><span class="kv-key">${key}</span><span class="kv-val">${value}</span></div>`;
}

function detailHtml(p, lngLat) {
  const acres = (p.lsf / 43560).toFixed(2);
  const lat = lngLat ? lngLat.lat.toFixed(6) : null;
  const lng = lngLat ? lngLat.lng.toFixed(6) : null;

  const svEmbed = CONFIG.GOOGLE_MAPS_KEY && lat
    ? `<iframe class="dp-sv" loading="lazy" referrerpolicy="no-referrer-when-downgrade"
         src="https://www.google.com/maps/embed/v1/streetview?key=${CONFIG.GOOGLE_MAPS_KEY}&location=${lat},${lng}&fov=80"
         allowfullscreen></iframe>`
    : "";

  const badges = [];
  if (p.e === 1) badges.push('<span class="badge badge-ok">SB 1123 candidate</span>');
  if (p.v === 1) badges.push('<span class="badge badge-vacant">Vacant</span>');
  if (p.f === 2) badges.push('<span class="badge badge-warn">Very High fire — excluded</span>');
  else if (p.f === 1) badges.push('<span class="badge badge-warn">High fire — excluded</span>');
  if (p.c === 1) badges.push('<span class="badge badge-warn">Coastal zone — excluded</span>');
  if (p.h === 1) badges.push('<span class="badge badge-warn">Hillside — excluded</span>');

  return `
    <div class="dp-head">
      <div>
        <div class="dp-addr">${displayName(p)}</div>
        <div class="dp-sub">APN ${p.ain}${p.t ? " · Tier " + p.t + " — " + (TIER_NAMES[p.t] || "") : ""}</div>
      </div>
      <button id="dp-close" title="Close">×</button>
    </div>
    <div class="dp-badges">${badges.join(" ")}</div>
    ${svEmbed}
    <div class="dp-tiles">
      <div class="dp-tile"><b>${fmt(p.lsf)}</b><span>Lot sf · ${acres} ac</span></div>
      <div class="dp-tile dp-tile-navy"><b>≈ ${p.w} ft</b><span>Width · computed</span></div>
    </div>
    <section class="dp-section">
      <h4>Parcel</h4>
      ${kvRow("Zoning", `${p.z || "?"} <span class="muted">(${p.zc || "?"})</span>`)}
      ${kvRow("Use code", p.uc || "?")}
      ${kvRow("Units", p.u)}
      ${kvRow("Improvements", "$" + fmt(p.iv))}
    </section>
    <section class="dp-section">
      <h4>Owner information</h4>
      <div id="dp-owner"><div class="dp-loading">Looking up owner…</div></div>
    </section>
    <section class="dp-section">
      <h4>Status</h4>
      <select id="dp-status">
        <option value="">None</option>
        ${Object.entries(STATUS_LABELS).map(([val, label]) =>
          `<option value="${val}"${dealStatuses[p.ain] === val ? " selected" : ""}>${label}</option>`).join("")}
      </select>
    </section>
    <div class="dp-links">
      <a href="${CONFIG.ASSESSOR_URL(p.ain)}" target="_blank" rel="noopener">Assessor ↗</a>
      <a href="${CONFIG.ZIMAS_URL}" target="_blank" rel="noopener">ZIMAS ↗</a>
      ${lat ? `<a href="${CONFIG.STREETVIEW_URL(lat, lng)}" target="_blank" rel="noopener">Street View ↗</a>` : ""}
    </div>`;
}

function ownerFallbackHtml(p) {
  return `
    <p class="dp-note">Owner name, mailing address, and sale history aren't in
    open data. Connect LandVision/LightBox (see README) for automatic lookups,
    or check the assessor record:</p>
    <a class="dp-owner-link" href="${CONFIG.ASSESSOR_URL(p.ain)}" target="_blank" rel="noopener">
      Owner record on Assessor portal ↗</a>`;
}

async function fillOwnerInfo(p) {
  const el = document.getElementById("dp-owner");
  if (!el) return;
  if (!CONFIG.OWNER_API) { el.innerHTML = ownerFallbackHtml(p); return; }
  try {
    const resp = await fetch(`${CONFIG.OWNER_API}?apn=${encodeURIComponent(p.ain)}`);
    if (!resp.ok) throw new Error("owner api " + resp.status);
    const d = await resp.json();
    if (document.getElementById("dp-owner") !== el) return; // panel changed
    const rows = [];
    if (d.owner) rows.push(kvRow("Owner of record", d.owner));
    if (d.mailingAddress) rows.push(kvRow("Mailing address", d.mailingAddress));
    if (d.lastSaleDate || d.lastSalePrice) {
      rows.push(kvRow(d.lastSaleDate || "Last sale",
        d.lastSalePrice ? "$" + fmt(d.lastSalePrice) : "–"));
    }
    if (!rows.length) throw new Error("empty");
    const ocLink = d.owner && /\b(LLC|L\.P\.|LP|INC|CORP|TRUST)\b/i.test(d.owner)
      ? `<a class="dp-owner-link" href="https://opencorporates.com/companies/us_ca?q=${encodeURIComponent(d.owner)}" target="_blank" rel="noopener">OpenCorporates ↗</a>`
      : "";
    el.innerHTML = rows.join("") + ocLink;
  } catch (e) {
    if (document.getElementById("dp-owner") === el) el.innerHTML = ownerFallbackHtml(p);
  }
}

function showDetail(p, lngLat) {
  selectedAin = p.ain;
  applyFilters();
  const panel = document.getElementById("detail-panel");
  panel.innerHTML = detailHtml(p, lngLat);
  panel.classList.remove("hidden");
  document.getElementById("dp-close").addEventListener("click", closeDetail);
  document.getElementById("dp-status").addEventListener("change", (e) => {
    LandMap.setStatus(p.ain, e.target.value);
  });
  fillOwnerInfo(p);
}

function closeDetail() {
  document.getElementById("detail-panel").classList.add("hidden");
  selectedAin = null;
  applyFilters();
}

/* ---------------- UI wiring ---------------- */

function setPillVal(id, text) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.closest(".pill").classList.toggle("has-value", !!text);
}

function rangeSummary([min, max], unit) {
  if (min === null && max === null) return "";
  if (min !== null && max !== null) return `${fmt(min)}–${fmt(max)}`;
  if (min !== null) return `${fmt(min)}+`;
  return `≤${fmt(max)}`;
}

function syncControlsFromState() {
  const r = state.ranges;
  const setVal = (id, v) => { document.getElementById(id).value = v === null ? "" : v; };
  setVal("w-min", r.w[0]); setVal("w-max", r.w[1]);
  setVal("lsf-min", r.lsf[0]); setVal("lsf-max", r.lsf[1]);
  setPillVal("pv-width", rangeSummary(r.w));
  setPillVal("pv-lot", rangeSummary(r.lsf));

  document.querySelectorAll(".zone-family").forEach((cb) => {
    cb.checked = state.zoneFamilies.has(Number(cb.value));
  });
  document.getElementById("zone-text").value = state.zoneClasses.join(",");
  const zoneCount = state.zoneClasses.length || state.zoneFamilies.size;
  setPillVal("pv-zoning", zoneCount ? String(zoneCount) : "");

  document.querySelectorAll(".tier-cb").forEach((cb) => {
    cb.checked = state.tiers.has(cb.value);
  });
  setPillVal("pv-tier", state.tiers.size ? [...state.tiers].sort().join("") : "");

  document.querySelectorAll('input[name="dstatus"]').forEach((rb) => {
    rb.checked = rb.value === state.dealStatus;
  });
  setPillVal("pv-status", state.dealStatus === "any" ? "" : STATUS_LABELS[state.dealStatus]);

  document.querySelectorAll('input[name="imp"]').forEach((rb) => {
    rb.checked = rb.value === state.imp;
  });
  setPillVal("pv-imp",
    state.imp === "vacant" ? "Vacant" : state.imp === "sfr" ? "SFR" : "");

  document.getElementById("sb1123-btn").classList.toggle("active", !!state.sbPreset);
  document.getElementById("sb1123-explainer").classList.toggle("hidden", !state.sbPreset);
}

function bindControls() {
  // dropdown open/close
  document.querySelectorAll(".dropdown [data-dd-btn]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const dd = btn.closest(".dropdown");
      const wasOpen = dd.classList.contains("open");
      document.querySelectorAll(".dropdown.open").forEach((d) => d.classList.remove("open"));
      if (!wasOpen) dd.classList.add("open");
    });
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".dd-panel")) {
      document.querySelectorAll(".dropdown.open").forEach((d) => d.classList.remove("open"));
    }
  });

  const onRangeChange = () => {
    const parse = (id) => {
      const v = document.getElementById(id).value.trim();
      return v === "" ? null : Number(v);
    };
    state.ranges.w = [parse("w-min"), parse("w-max")];
    state.ranges.lsf = [parse("lsf-min"), parse("lsf-max")];
    syncControlsFromState();
    applyFilters();
  };
  for (const id of ["w-min", "w-max", "lsf-min", "lsf-max"]) {
    document.getElementById(id).addEventListener("change", onRangeChange);
  }

  document.querySelectorAll(".zone-family").forEach((cb) => {
    cb.addEventListener("change", () => {
      const v = Number(cb.value);
      if (cb.checked) state.zoneFamilies.add(v); else state.zoneFamilies.delete(v);
      syncControlsFromState();
      applyFilters();
    });
  });

  document.getElementById("zone-text").addEventListener("change", (e) => {
    state.zoneClasses = e.target.value.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    syncControlsFromState();
    applyFilters();
  });

  document.querySelectorAll(".tier-cb").forEach((cb) => {
    cb.addEventListener("change", () => {
      if (cb.checked) state.tiers.add(cb.value); else state.tiers.delete(cb.value);
      syncControlsFromState();
      applyFilters();
    });
  });

  document.querySelectorAll('input[name="dstatus"]').forEach((rb) => {
    rb.addEventListener("change", () => {
      if (rb.checked) state.dealStatus = rb.value;
      syncControlsFromState();
      applyFilters();
    });
  });

  document.querySelectorAll('input[name="imp"]').forEach((rb) => {
    rb.addEventListener("change", () => {
      if (rb.checked) state.imp = rb.value;
      syncControlsFromState();
      applyFilters();
    });
  });

  document.getElementById("sb1123-btn").addEventListener("click", () => {
    state = state.sbPreset ? emptyState() : sb1123State(CONFIG);
    syncControlsFromState();
    applyFilters();
  });

  document.getElementById("reset-btn").addEventListener("click", () => {
    state = emptyState();
    selectedAin = null;
    syncControlsFromState();
    applyFilters();
  });

  document.getElementById("sat-btn").addEventListener("click", () => {
    const btn = document.getElementById("sat-btn");
    if (!map.getLayer("basemap-satellite")) return;
    const sat = map.getLayoutProperty("basemap-satellite", "visibility") === "visible";
    // The satellite raster sits above every basemap layer, so toggling its
    // visibility alone covers/uncovers whichever basemap is active.
    map.setLayoutProperty("basemap-satellite", "visibility", sat ? "none" : "visible");
    btn.classList.toggle("active", !sat);
  });

  bindSearch();
}

function bindSearch() {
  const input = document.getElementById("search-input");
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const q = input.value.trim();
    if (!q) return;
    const url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" +
      encodeURIComponent(q + ", Los Angeles County, CA");
    fetch(url, { headers: { Accept: "application/json" } })
      .then((r) => r.json())
      .then((results) => {
        if (!results.length) throw new Error("no results");
        const r = results[0];
        if (r.boundingbox) {
          const bb = r.boundingbox.map(Number);
          map.fitBounds([[bb[2], bb[0]], [bb[3], bb[1]]]);
        } else {
          map.easeTo({ center: [Number(r.lon), Number(r.lat)], zoom: 13 });
        }
      })
      .catch(() => { input.value = ""; input.placeholder = `No results for "${q}"`; });
  });
}

/* ---------------- v2 hook: overlay points (e.g. comps / listings) ---------------- */

const LandMap = {
  setStatus(ain, value) {
    if (value) dealStatuses[ain] = value;
    else delete dealStatuses[ain];
    saveStatuses();
    applyFilters();
  },
  addOverlayPoints(geojson, options = {}) {
    const id = options.id || "overlay-points";
    if (map.getSource(id)) { map.getSource(id).setData(geojson); return; }
    map.addSource(id, { type: "geojson", data: geojson });
    map.addLayer({
      id, type: "circle", source: id,
      paint: {
        "circle-radius": 6, "circle-color": options.color || "#7c3aed",
        "circle-stroke-color": "#fff", "circle-stroke-width": 1.5,
      },
    });
  },
  get map() { return map; },
  get state() { return state; },
};
window.LandMap = LandMap;

/* ---------------- boot ---------------- */

async function isSynthetic() {
  try {
    const meta = await archive.getMetadata();
    return ((meta && meta.description) || "").includes("synthetic=true");
  } catch (e) {
    return false;
  }
}

// Synthetic demo parcels are a fictional grid — drawing them over a real
// basemap misaligns badly. Demo mode gets a self-contained plain map
// (background + the tileset's own street grid); real data gets the real
// basemap and no synthetic streets.
function demoStyle() {
  const style = baseStyle();
  style.layers = style.layers.filter(
    (l) => l.id !== "basemap-streets" && l.id !== "basemap-satellite");
  return style;
}

// MapLibre can consume Mapbox styles given a token: rewrite mapbox:// URLs
// (tilesets, sprites, glyphs) to their api.mapbox.com equivalents.
function mapboxTransform(url) {
  if (!url.startsWith("mapbox://")) return undefined;
  const token = "access_token=" + CONFIG.MAPBOX_TOKEN;
  if (url.startsWith("mapbox://sprites/")) {
    const path = url.slice("mapbox://sprites/".length)
      .replace(/(@\dx)?\.(json|png)$/, "/sprite$1.$2");
    return { url: `https://api.mapbox.com/styles/v1/${path}?${token}` };
  }
  if (url.startsWith("mapbox://fonts/")) {
    return { url: `https://api.mapbox.com/fonts/v1/${url.slice("mapbox://fonts/".length)}?${token}` };
  }
  // vector/raster tileset reference, e.g. mapbox://mapbox.mapbox-streets-v8
  return { url: `https://api.mapbox.com/v4/${url.slice("mapbox://".length)}.json?secure&${token}` };
}

async function fetchMergedStyle(styleUrl, fallback) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  const resp = await fetch(styleUrl, { signal: ctrl.signal });
  clearTimeout(timer);
  if (!resp.ok) throw new Error("style fetch " + resp.status);
  const base = await resp.json();
  base.sources = {
    ...base.sources,
    satellite: fallback.sources.satellite,
    parcels: fallback.sources.parcels,
  };
  const overlayIds = new Set([
    "basemap-satellite", "centroids",
    "parcels-fill", "parcels-line", "parcels-selected",
  ]);
  base.layers = [...base.layers, ...fallback.layers.filter((l) => overlayIds.has(l.id))];
  return base;
}

// Basemap preference: Mapbox (with token) -> free OpenFreeMap vector style
// -> raster OSM -> plain background. Never breaks the app.
async function buildStyle() {
  const fallback = baseStyle();
  if (CONFIG.MAPBOX_TOKEN) {
    try {
      const m = CONFIG.MAPBOX_STYLE.replace("mapbox://styles/", "");
      return await fetchMergedStyle(
        `https://api.mapbox.com/styles/v1/${m}?access_token=${CONFIG.MAPBOX_TOKEN}`, fallback);
    } catch (e) { /* fall through */ }
  }
  if (CONFIG.BASEMAP_STYLE_URL) {
    try {
      return await fetchMergedStyle(CONFIG.BASEMAP_STYLE_URL, fallback);
    } catch (e) { /* fall through */ }
  }
  return fallback;
}

function initBrandLogo() {
  if (!CONFIG.LOGO_URL) return;
  const img = document.getElementById("brand-logo");
  const textLockup = document.getElementById("brand-mm");
  img.addEventListener("load", () => {
    img.classList.remove("hidden");
    textLockup.classList.add("hidden");
  });
  // Missing/unreachable logo file -> keep the styled text lockup.
  img.addEventListener("error", () => {
    img.classList.add("hidden");
    textLockup.classList.remove("hidden");
  });
  img.src = CONFIG.LOGO_URL;
}

async function boot() {
  initBrandLogo();
  const synthetic = await isSynthetic();
  if (synthetic) {
    document.getElementById("demo-banner").classList.remove("hidden");
    document.getElementById("sat-btn").style.display = "none";
  }
  map = new maplibregl.Map({
    container: "map",
    style: synthetic ? demoStyle() : await buildStyle(),
    center: CONFIG.START_CENTER,
    zoom: CONFIG.START_ZOOM,
    maxZoom: 20,
    attributionControl: { compact: true },
    transformRequest: mapboxTransform,
  });
  map.addControl(new maplibregl.NavigationControl(), "top-right");

  // Init on whichever fires first: 'load' normally, or 'styledata' when
  // unreachable basemap tile servers keep the map from ever reaching 'load'.
  let inited = false;
  function init() {
    if (inited) return;
    inited = true;
    syncControlsFromState();
    applyFilters();
  }
  map.on("load", init);
  map.on("styledata", init);

  map.on("idle", scheduleCount);
  map.on("moveend", scheduleCount);
  map.on("sourcedata", scheduleCount);

  map.on("click", "parcels-fill", (e) => {
    showDetail(e.features[0].properties, e.lngLat);
  });
  map.on("click", "centroids", (e) => {
    map.easeTo({ center: e.lngLat, zoom: 14 });
  });
  map.on("mouseenter", "parcels-fill", () => { map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", "parcels-fill", () => { map.getCanvas().style.cursor = ""; });

  bindControls();
}
boot();
