import * as maplibregl from "../vendor/maplibre-gl/maplibre-gl.mjs";
import { CONFIG } from "./config.js";
import {
  emptyState, sb1123State, buildFilter, buildCentroidFilter,
  stateToHash, stateFromHash,
} from "./filters.js";

/* global pmtiles */

const COLORS = {
  eligible: "#1f9d55",
  vacant: "#d97706",
  neutral: "#64748b",
  warn: "#dc2626",
  highlight: "#2563eb",
};

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
      { id: "bg", type: "background", paint: { "background-color": "#e8ecef" } },
      { id: "basemap-streets", type: "raster", source: "streets" },
      { id: "basemap-satellite", type: "raster", source: "satellite",
        layout: { visibility: "none" } },
      {
        id: "centroids", type: "circle", source: "parcels", "source-layer": "centroids",
        maxzoom: 13,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 1.2, 12, 3.5],
          "circle-color": ["case",
            ["==", ["get", "e"], 1], COLORS.eligible,
            ["==", ["get", "v"], 1], COLORS.vacant,
            COLORS.neutral],
          "circle-opacity": ["case", ["==", ["get", "e"], 1], 0.95, 0.55],
        },
      },
      {
        id: "parcels-fill", type: "fill", source: "parcels", "source-layer": "parcels",
        minzoom: 13,
        paint: {
          "fill-color": ["case",
            ["==", ["get", "e"], 1], COLORS.eligible,
            ["==", ["get", "v"], 1], COLORS.vacant,
            COLORS.neutral],
          "fill-opacity": ["case", ["==", ["get", "e"], 1], 0.55, 0.35],
        },
      },
      {
        id: "parcels-line", type: "line", source: "parcels", "source-layer": "parcels",
        minzoom: 13,
        paint: { "line-color": "#ffffff", "line-width": 0.6, "line-opacity": 0.7 },
      },
      {
        id: "parcels-warn", type: "line", source: "parcels", "source-layer": "parcels",
        minzoom: 13,
        filter: ["any", ["==", ["get", "c"], 1], ["==", ["get", "h"], 1], [">=", ["get", "f"], 1]],
        paint: { "line-color": COLORS.warn, "line-width": 1.4, "line-dasharray": [2, 1.5] },
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
  // Warn + selected layers combine their own condition with the active filter.
  const warnBase = ["any", ["==", ["get", "c"], 1], ["==", ["get", "h"], 1], [">=", ["get", "f"], 1]];
  map.setFilter("parcels-warn", f ? ["all", f, warnBase] : warnBase);
  const selBase = ["==", ["get", "ain"], selectedAin ?? "___none___"];
  map.setFilter("parcels-selected", f ? ["all", f, selBase] : selBase);
  map.setFilter("centroids", buildCentroidFilter(state, CONFIG));
  history.replaceState(null, "", location.pathname + location.search + (stateToHash(state) || "#"));
  scheduleCount();
}

/* ---------------- results count ---------------- */

let countTimer = null;
function scheduleCount() {
  clearTimeout(countTimer);
  countTimer = setTimeout(updateCount, 250);
}

function updateCount() {
  if (!map || !map.isStyleLoaded()) return;
  const zoom = map.getZoom();
  const layer = zoom >= 13 ? "parcels-fill" : "centroids";
  const feats = map.queryRenderedFeatures({ layers: [layer] });
  const ains = new Set();
  for (const f of feats) ains.add(f.properties.ain);
  document.getElementById("result-count").textContent = ains.size.toLocaleString();
  document.getElementById("result-label").textContent =
    (zoom >= 13 ? "parcels" : "parcel dots") + " in view";
}

/* ---------------- popup ---------------- */

function fmt(n) { return Number(n).toLocaleString(); }

function popupHtml(p) {
  const acres = (p.lsf / 43560).toFixed(2);
  const badges = [];
  if (p.e === 1) badges.push('<span class="badge badge-ok">SB 1123 candidate</span>');
  if (p.v === 1) badges.push('<span class="badge badge-vacant">Vacant</span>');
  if (p.f === 2) badges.push('<span class="badge badge-warn">Very High fire — SB excluded</span>');
  else if (p.f === 1) badges.push('<span class="badge badge-warn">High fire — SB excluded</span>');
  if (p.c === 1) badges.push('<span class="badge badge-warn">Coastal — CDP required, no ministerial path</span>');
  if (p.h === 1) badges.push('<span class="badge badge-warn">Hillside — extra constraints</span>');
  return `
    <div class="popup">
      <div class="popup-title">APN ${p.ain}</div>
      <div class="popup-badges">${badges.join(" ")}</div>
      <table class="popup-table">
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
      </div>
    </div>`;
}

/* ---------------- UI wiring ---------------- */

function syncControlsFromState() {
  const r = state.ranges;
  const setVal = (id, v) => { document.getElementById(id).value = v === null ? "" : v; };
  setVal("w-min", r.w[0]); setVal("w-max", r.w[1]);
  setVal("lsf-min", r.lsf[0]); setVal("lsf-max", r.lsf[1]);
  setVal("u-min", r.u[0]); setVal("u-max", r.u[1]);
  document.querySelectorAll(".zone-family").forEach((cb) => {
    cb.checked = state.zoneFamilies.has(Number(cb.value));
  });
  document.getElementById("zone-text").value = state.zoneClasses.join(",");
  document.querySelectorAll(".tri-row").forEach((row) => {
    const mode = state.tri[row.dataset.key];
    row.querySelector(".tri").dataset.state = mode;
  });
  document.getElementById("sb1123-btn").classList.toggle("active", !!state.sbPreset);
  document.getElementById("sb1123-explainer").classList.toggle("hidden", !state.sbPreset);
}

function readRange(idMin, idMax) {
  const parse = (id) => {
    const v = document.getElementById(id).value.trim();
    return v === "" ? null : Number(v);
  };
  return [parse(idMin), parse(idMax)];
}

function bindControls() {
  const onRangeChange = () => {
    state.ranges.w = readRange("w-min", "w-max");
    state.ranges.lsf = readRange("lsf-min", "lsf-max");
    state.ranges.u = readRange("u-min", "u-max");
    applyFilters();
  };
  for (const id of ["w-min", "w-max", "lsf-min", "lsf-max", "u-min", "u-max"]) {
    document.getElementById(id).addEventListener("change", onRangeChange);
  }

  document.querySelectorAll(".zone-family").forEach((cb) => {
    cb.addEventListener("change", () => {
      const v = Number(cb.value);
      if (cb.checked) state.zoneFamilies.add(v); else state.zoneFamilies.delete(v);
      applyFilters();
    });
  });

  document.getElementById("zone-text").addEventListener("change", (e) => {
    state.zoneClasses = e.target.value.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    applyFilters();
  });

  document.querySelectorAll(".tri-row").forEach((row) => {
    row.addEventListener("click", () => {
      const order = ["any", "only", "exclude"];
      const key = row.dataset.key;
      state.tri[key] = order[(order.indexOf(state.tri[key]) + 1) % 3];
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
}

function addBasemapToggle() {
  const ctl = document.createElement("div");
  ctl.className = "maplibregl-ctrl maplibregl-ctrl-group basemap-toggle";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "🛰";
  btn.title = "Toggle satellite";
  btn.addEventListener("click", () => {
    const sat = map.getLayoutProperty("basemap-satellite", "visibility") === "visible";
    map.setLayoutProperty("basemap-satellite", "visibility", sat ? "none" : "visible");
    map.setLayoutProperty("basemap-streets", "visibility", sat ? "visible" : "none");
    btn.textContent = sat ? "🛰" : "🗺";
  });
  ctl.appendChild(btn);
  map.addControl({ onAdd: () => ctl, onRemove: () => ctl.remove() }, "top-right");
}

/* ---------------- v2 hook: overlay points (e.g. on-market listings) ---------------- */

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

map = new maplibregl.Map({
  container: "map",
  style: baseStyle(),
  center: CONFIG.START_CENTER,
  zoom: CONFIG.START_ZOOM,
  maxZoom: 20,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl(), "top-right");

// Init on whichever fires first: 'load' normally, or the first 'idle' when
// unreachable basemap tile servers keep the map from ever reaching 'load'.
let inited = false;
function init() {
  if (inited) return;
  inited = true;
  addBasemapToggle();
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
    .setHTML(popupHtml(p))
    .addTo(map);
});
map.on("click", "centroids", (e) => {
  map.easeTo({ center: e.lngLat, zoom: 14 });
});
map.on("mouseenter", "parcels-fill", () => { map.getCanvas().style.cursor = "pointer"; });
map.on("mouseleave", "parcels-fill", () => { map.getCanvas().style.cursor = ""; });

bindControls();
