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

let map;
let state = stateFromHash(location.hash);
let selectedAin = null;

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
  const f = buildFilter(state, CONFIG);
  for (const id of FILTERED_LAYERS) map.setFilter(id, f);
  const selBase = ["==", ["get", "ain"], selectedAin ?? "___none___"];
  map.setFilter("parcels-selected", f ? ["all", f, selBase] : selBase);
  map.setFilter("centroids", buildCentroidFilter(state, CONFIG));
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
    name.textContent = "APN " + p.ain;
    const meta = document.createElement("div");
    meta.className = "site-meta";
    const bits = [];
    if (detailed && p.zc) bits.push(p.zc);
    bits.push(fmt(p.lsf) + " sf");
    if (detailed && p.w) bits.push("≈" + p.w + " ft wide");
    meta.textContent = bits.join(" · ");
    info.appendChild(name);
    info.appendChild(meta);

    const tier = document.createElement("span");
    tier.className = "site-tier";
    tier.textContent = p.t || "";

    const center = featureCenter(f);
    li.addEventListener("click", () => {
      selectedAin = p.ain;
      applyFilters();
      map.easeTo({ center, zoom: Math.max(map.getZoom(), 15) });
    });

    li.appendChild(dot);
    li.appendChild(info);
    li.appendChild(tier);
    list.appendChild(li);
  }
}

/* ---------------- popup ---------------- */

function popupHtml(p, lngLat) {
  const acres = (p.lsf / 43560).toFixed(2);
  const svLink = lngLat
    ? `<a href="${CONFIG.STREETVIEW_URL(lngLat.lat.toFixed(6), lngLat.lng.toFixed(6))}" target="_blank" rel="noopener">Street View ↗</a>`
    : "";
  const badges = [];
  if (p.e === 1) badges.push('<span class="badge badge-ok">SB 1123 candidate</span>');
  if (p.v === 1) badges.push('<span class="badge badge-vacant">Vacant</span>');
  if (p.f === 2) badges.push('<span class="badge badge-warn">Very High fire — excluded</span>');
  else if (p.f === 1) badges.push('<span class="badge badge-warn">High fire — excluded</span>');
  if (p.c === 1) badges.push('<span class="badge badge-warn">Coastal zone — excluded</span>');
  if (p.h === 1) badges.push('<span class="badge badge-warn">Hillside — excluded</span>');
  return `
    <div class="popup">
      <div class="popup-title">APN ${p.ain}</div>
      <div class="popup-badges">${badges.join(" ")}</div>
      <table class="popup-table">
        <tr><td>Tier</td><td>${p.t ? p.t + " — " + (TIER_NAMES[p.t] || "") : "–"}</td></tr>
        <tr><td>Zoning</td><td>${p.z || "?"} <span class="muted">(${p.zc || "?"})</span></td></tr>
        <tr><td>Use code</td><td>${p.uc || "?"}</td></tr>
        <tr><td>Units</td><td>${p.u}</td></tr>
        <tr><td>Lot</td><td>${fmt(p.lsf)} sqft (${acres} ac)</td></tr>
        <tr><td>Width</td><td>≈ ${p.w} ft <span class="muted">(computed, approx.)</span></td></tr>
        <tr><td>Improvements</td><td>$${fmt(p.iv)}</td></tr>
      </table>
      <div class="popup-links">
        <a href="${CONFIG.ASSESSOR_URL(p.ain)}" target="_blank" rel="noopener">Assessor / owner info ↗</a>
        <a href="${CONFIG.ZIMAS_URL}" target="_blank" rel="noopener">ZIMAS ↗</a>
        ${svLink}
      </div>
    </div>`;
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
  setVal("u-min", r.u[0]); setVal("u-max", r.u[1]);
  setPillVal("pv-width", rangeSummary(r.w));
  setPillVal("pv-lot", rangeSummary(r.lsf));
  setPillVal("pv-units", rangeSummary(r.u));

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

  document.querySelectorAll('input[name="vac"]').forEach((rb) => {
    rb.checked = rb.value === state.tri.v;
  });
  setPillVal("pv-status",
    state.tri.v === "only" ? "vacant" : state.tri.v === "exclude" ? "built" : "");

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
    state.ranges.u = [parse("u-min"), parse("u-max")];
    syncControlsFromState();
    applyFilters();
  };
  for (const id of ["w-min", "w-max", "lsf-min", "lsf-max", "u-min", "u-max"]) {
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

  document.querySelectorAll('input[name="vac"]').forEach((rb) => {
    rb.addEventListener("change", () => {
      if (rb.checked) state.tri.v = rb.value;
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

async function showDemoBannerIfSynthetic() {
  try {
    const meta = await archive.getMetadata();
    const desc = (meta && meta.description) || "";
    if (desc.includes("synthetic=true")) {
      document.getElementById("demo-banner").classList.remove("hidden");
    }
  } catch (e) { /* metadata is optional */ }
}

// Prefer the key-free vector basemap (clean gray cartography); fall back to
// the raster style — and ultimately a plain background — when unreachable.
async function buildStyle() {
  const fallback = baseStyle();
  if (!CONFIG.BASEMAP_STYLE_URL) return fallback;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const resp = await fetch(CONFIG.BASEMAP_STYLE_URL, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!resp.ok) throw new Error("style fetch " + resp.status);
    const base = await resp.json();
    base.sources = {
      ...base.sources,
      satellite: fallback.sources.satellite,
      parcels: fallback.sources.parcels,
    };
    const overlayIds = new Set([
      "basemap-satellite", "demo-streets", "centroids",
      "parcels-fill", "parcels-line", "parcels-selected",
    ]);
    base.layers = [...base.layers, ...fallback.layers.filter((l) => overlayIds.has(l.id))];
    return base;
  } catch (e) {
    return fallback;
  }
}

async function boot() {
  map = new maplibregl.Map({
    container: "map",
    style: await buildStyle(),
    center: CONFIG.START_CENTER,
    zoom: CONFIG.START_ZOOM,
    maxZoom: 20,
    attributionControl: { compact: true },
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
    showDemoBannerIfSynthetic();
  }
  map.on("load", init);
  map.on("styledata", init);

  map.on("idle", scheduleCount);
  map.on("moveend", scheduleCount);
  map.on("sourcedata", scheduleCount);

  map.on("click", "parcels-fill", (e) => {
    const p = e.features[0].properties;
    selectedAin = p.ain;
    applyFilters();
    new maplibregl.Popup({ maxWidth: "320px" })
      .setLngLat(e.lngLat)
      .setHTML(popupHtml(p, e.lngLat))
      .addTo(map);
  });
  map.on("click", "centroids", (e) => {
    map.easeTo({ center: e.lngLat, zoom: 14 });
  });
  map.on("mouseenter", "parcels-fill", () => { map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", "parcels-fill", () => { map.getCanvas().style.cursor = ""; });

  bindControls();
}
boot();
