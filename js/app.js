import * as maplibregl from "../vendor/maplibre-gl/maplibre-gl.mjs";
import { CONFIG } from "./config.js";
import {
  emptyState, sb1123State, buildFilter, buildCentroidFilter, areaBoxes,
  stateToHash, stateFromHash, setOzGeometry,
} from "./filters.js";

/* global pmtiles */

const COLORS = {
  eligible: "#10b981",
  eligibleLine: "#047857",
  neutralLine: "#c3cbd3",
  highlight: "#2563eb",
  vacant: "#f59e0b",
  vacantLine: "#b45309",
  sfr: "#3b82f6",
  sfrLine: "#1d4ed8",
};

// Universe rendering: one uniform blue for every highlighted parcel
// (SFR homes and vacant lots alike); filters narrow which blues remain.
const UNIVERSE_COLOR = COLORS.sfr;
const UNIVERSE_LINE_COLOR = COLORS.sfrLine;

// Any filter beyond the untouched default (the SB preset is tracked apart).
function hasUserFilters(s) {
  return Object.values(s.ranges).some(([a, b]) => a !== null || b !== null)
    || s.zoneClasses.length > 0 || s.zoneFamilies.size > 0
    || s.tiers.size > 0 || s.imp !== "any" || s.dealStatus !== "any"
    || s.om || (s.areas && s.areas.length > 0);
}

const TIER_NAMES = { A: "Westside", B: "South Valley", C: "Central/North Valley" };
const STATUS_LABELS = {
  submitted: "Submitted", approved: "Approved",
  completed: "Completed", forsale: "For Sale",
};
const STATUS_COLORS = {
  submitted: "#2563eb", approved: "#7c3aed",
  completed: "#0f766e", forsale: "#d97706",
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
// Default view: the approved SB projects, with Status=Approved selected —
// the team opens to what's already been entitled. A shared URL hash wins.
function defaultState() {
  const s = emptyState();
  s.dealStatus = "approved";
  return s;
}
let state = location.hash.length > 1 ? stateFromHash(location.hash) : defaultState();
let selectedAin = null;
let demoMode = false;
let demoBounds = null;

// "4108 WHITSETT AVE" -> "4108 Whitsett Ave"
function fmtAddr(a) {
  if (!a) return "";
  return a.toLowerCase().replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
}

// County APN display formats: LA 10-digit -> 5442-023-013,
// Ventura (V prefix) -> 060-0-123-456, Santa Barbara (S prefix) -> 123-456-789.
function fmtApn(p) {
  const ain = p.ain || "";
  const raw = ain.replace(/^[VS]/, "");
  if (!/^\d+$/.test(raw)) return ain;
  if (ain[0] === "V" && raw.length === 10) {
    return `${raw.slice(0, 3)}-${raw.slice(3, 4)}-${raw.slice(4, 7)}-${raw.slice(7)}`;
  }
  if (ain[0] === "S" && raw.length === 9) {
    return `${raw.slice(0, 3)}-${raw.slice(3, 6)}-${raw.slice(6)}`;
  }
  if (raw.length === 10) return `${raw.slice(0, 4)}-${raw.slice(4, 7)}-${raw.slice(7)}`;
  return raw;
}

// Split a situs address into street + city lines:
// "12009 HOFFMAN ST STUDIO CITY CA 91604" ->
//   { street: "12009 Hoffman St", cityName: "Studio City",
//     cityLine: "Studio City, CA 91604" }
const STREET_SUFFIXES = new Set([
  "AVE", "AVENUE", "ST", "STREET", "BLVD", "BOULEVARD", "DR", "DRIVE",
  "RD", "ROAD", "PL", "PLACE", "CT", "COURT", "LN", "LANE", "WAY", "TER",
  "TERRACE", "CIR", "CIRCLE", "HWY", "HIGHWAY", "PKWY", "TRL", "WALK",
  "ALY", "GLEN", "VIS", "VISTA", "PLZ", "PASEO", "CYN", "CANYON", "MALL",
]);
const UNIT_WORDS = new Set(["APT", "UNIT", "STE", "SPC", "NO", "TRLR", "BLDG", "FL", "RM"]);

// The assessor's situs city is "LOS ANGELES" for every LA-city parcel; the
// team thinks in communities. ZIP → community for the neighborhoods we work.
const LA_COMMUNITY_BY_ZIP = {
  // San Fernando Valley
  "91303": "Canoga Park", "91304": "Canoga Park", "91306": "Winnetka",
  "91307": "West Hills", "91311": "Chatsworth", "91316": "Encino",
  "91324": "Northridge", "91325": "Northridge", "91326": "Porter Ranch",
  "91330": "Northridge", "91331": "Pacoima", "91335": "Reseda",
  "91342": "Sylmar", "91343": "North Hills", "91344": "Granada Hills",
  "91345": "Mission Hills", "91352": "Sun Valley", "91356": "Tarzana",
  "91364": "Woodland Hills", "91367": "Woodland Hills", "91401": "Van Nuys",
  "91402": "Panorama City", "91403": "Sherman Oaks", "91405": "Van Nuys",
  "91406": "Lake Balboa", "91411": "Van Nuys", "91423": "Sherman Oaks",
  "91436": "Encino", "91601": "North Hollywood", "91602": "Toluca Lake",
  "91604": "Studio City", "91605": "North Hollywood", "91606": "North Hollywood",
  "91607": "Valley Village", "91040": "Sunland", "91042": "Tujunga",
  // Westside + central
  "90024": "Westwood", "90025": "West LA", "90034": "Palms",
  "90045": "Westchester", "90049": "Brentwood", "90064": "West LA",
  "90066": "Mar Vista", "90077": "Bel Air", "90272": "Pacific Palisades",
  "90291": "Venice", "90292": "Marina del Rey", "90026": "Echo Park",
  "90027": "Los Feliz", "90028": "Hollywood", "90038": "Hollywood",
  "90039": "Silver Lake", "90041": "Eagle Rock", "90042": "Highland Park",
  "90046": "Hollywood", "90065": "Glassell Park", "90068": "Hollywood Hills",
  "90016": "West Adams", "90018": "Jefferson Park", "90019": "Mid-City",
  "90008": "Baldwin Hills", "90043": "View Park", "90731": "San Pedro",
  "90732": "San Pedro", "90744": "Wilmington", "90247": "Harbor Gateway",
  "90501": "Torrance", "90710": "Harbor City", "90717": "Lomita",
};

function communityFor(cityName, zip) {
  if (cityName && cityName.toLowerCase() !== "los angeles") return cityName;
  return LA_COMMUNITY_BY_ZIP[zip] || cityName;
}

function splitAddr(a) {
  const empty = { street: "", cityName: "", cityLine: "" };
  if (!a) return empty;
  // Santa Barbara pre-joins "street, city line" — but only treat a comma as
  // that split when the tail really is a city line (mentions CA); legal
  // descriptions ("Tr 8939, Lot 2…") also contain commas.
  if (a.includes(", ") && /\bCA\b/i.test(a.slice(a.indexOf(", ") + 2))) {
    const [s, ...rest] = a.split(", ");
    const cityLine = fmtAddr(rest.join(", ")).replace(/\bCa\b/, "CA");
    return { street: fmtAddr(s), cityName: cityLine.replace(/,?\s*CA.*$/, ""), cityLine };
  }
  const toks = a.trim().toUpperCase().split(/\s+/);
  let zip = "", ca = -1;
  const lastTok = toks[toks.length - 1];
  if (/^\d{5}(-\d{4})?$/.test(lastTok) && toks[toks.length - 2] === "CA") {
    zip = lastTok;
    ca = toks.length - 2;
  } else if (lastTok === "CA") {
    ca = toks.length - 1;
  }
  if (ca < 0) return { street: fmtAddr(a), cityName: "", cityLine: "" };
  let si = -1;
  for (let i = ca - 1; i >= 0; i--) {
    if (STREET_SUFFIXES.has(toks[i])) { si = i; break; }
  }
  if (si < 0) {
    return { street: fmtAddr(toks.slice(0, ca).join(" ")), cityName: "",
      cityLine: "CA" + (zip ? " " + zip : "") };
  }
  let end = si + 1;
  // Numbered avenues ("N Avenue 52") and unit designators stay on line 1.
  if (end < ca && /^\d+$/.test(toks[end])) end++;
  while (end < ca) {
    const t = toks[end];
    if (t.startsWith("#")) { end++; continue; }
    if (UNIT_WORDS.has(t)) { end += 2; continue; }
    break;
  }
  end = Math.min(end, ca);
  const street = fmtAddr(toks.slice(0, end).join(" "));
  const cityName = communityFor(fmtAddr(toks.slice(end, ca).join(" ")), zip);
  const cityLine = (cityName ? cityName + ", " : "") + "CA" + (zip ? " " + zip : "");
  return { street, cityName, cityLine };
}

function displayName(p) {
  return splitAddr(p.a).street || "APN " + fmtApn(p);
}

// Assessor link: per-parcel URL when the source provides one (Santa Barbara),
// the LA County portal for LA parcels, none otherwise (Ventura has no clean
// per-parcel deep link).
function assessorUrl(p) {
  if (p.au) return p.au;
  if (!p.co || p.co === "LA") return CONFIG.ASSESSOR_URL(p.ain);
  return "";
}

const COUNTY_NAMES = { LA: "Los Angeles Co.", VC: "Ventura Co.", SB: "Santa Barbara Co." };

/* ---------------- map setup ---------------- */

const protocol = new pmtiles.Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);

// One or more PMTiles archives. County-scale coverage is split into
// <100MB geographic chunks (GitHub/Vercel file limits); each archive becomes
// its own vector source carrying a full copy of the parcel layer stack.
const tilesUrls = (CONFIG.PMTILES_URLS && CONFIG.PMTILES_URLS.length
  ? CONFIG.PMTILES_URLS : [CONFIG.PMTILES_URL])
  .map((u) => new URL(u, location.href).href);
const archives = tilesUrls.map((u) => {
  const a = new pmtiles.PMTiles(u);
  protocol.add(a);
  return a;
});
const archive = archives[0];
const SRC_COUNT = tilesUrls.length;

// Layer ids: source 0 keeps the plain name ("parcels-fill"); further sources
// get a suffix ("parcels-fill@1"). lids() lists every instance of a layer.
function lid(base, i) { return i === 0 ? base : `${base}@${i}`; }
function lids(base) {
  return Array.from({ length: SRC_COUNT }, (_, i) => lid(base, i));
}

// The full parcel layer stack for one source, ordered bottom → top.
function parcelLayers(i) {
  const layers = [
    {
      id: "centroids", type: "circle", "source-layer": "centroids",
      maxzoom: 14,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 1.5, 12, 3],
        "circle-color": UNIVERSE_COLOR,
        "circle-opacity": 0.9,
      },
    },
    {
      // Non-universe parcels (commercial, condos, apartments, excluded
      // lots…): one flat light gray. Opaque on purpose — condo lots stack
      // one duplicate polygon per unit, and translucent fills would
      // accumulate into random darker shades (satellite mode drops the
      // opacity so imagery shows through).
      id: "parcels-context", type: "fill", "source-layer": "parcels",
      minzoom: 14,
      paint: { "fill-color": "#e4e8ec", "fill-opacity": 1 },
    },
    {
      id: "parcels-context-line", type: "line", "source-layer": "parcels",
      minzoom: 14,
      paint: { "line-color": COLORS.neutralLine, "line-width": 0.5 },
    },
    {
      id: "parcels-fill", type: "fill", "source-layer": "parcels",
      minzoom: 14,
      paint: {
        "fill-color": UNIVERSE_COLOR,
        "fill-opacity": 0.45,
      },
    },
    {
      id: "parcels-line", type: "line", "source-layer": "parcels",
      minzoom: 14,
      paint: {
        "line-color": UNIVERSE_LINE_COLOR,
        "line-width": 1.0,
      },
    },
    {
      // LA City Planning SB 684/1123 cases: approved green, pending yellow.
      // Always visible regardless of filters.
      id: "parcels-projects", type: "fill", "source-layer": "parcels",
      minzoom: 14,
      filter: ["==", ["get", "ain"], "___none___"],
      paint: { "fill-color": "#facc15", "fill-opacity": 0.7 },
    },
    {
      // Deal-status outlines: always visible regardless of filters, so the
      // team's tracked pipeline never disappears from the map.
      id: "parcels-status", type: "line", "source-layer": "parcels",
      minzoom: 14,
      filter: ["==", ["get", "ain"], "___none___"],
      paint: { "line-color": "#2563eb", "line-width": 2.5 },
    },
    {
      id: "parcels-selected", type: "line", "source-layer": "parcels",
      minzoom: 14,
      filter: ["==", ["get", "ain"], "___none___"],
      paint: { "line-color": COLORS.highlight, "line-width": 3 },
    },
  ];
  return layers.map((l) => ({ ...l, id: lid(l.id, i), source: "parcels" + i }));
}

function baseStyle() {
  const sources = {
    streets: {
      type: "raster", tiles: CONFIG.BASEMAPS.streets.tiles, tileSize: 256,
      attribution: CONFIG.BASEMAPS.streets.attribution,
    },
    satellite: {
      type: "raster", tiles: CONFIG.BASEMAPS.satellite.tiles, tileSize: 256,
      attribution: CONFIG.BASEMAPS.satellite.attribution,
    },
  };
  tilesUrls.forEach((u, i) => {
    sources["parcels" + i] = { type: "vector", url: "pmtiles://" + u };
  });
  // Planning-project markers come from projects.json coordinates, NOT the
  // tileset: low-zoom tiles drop most centroids to stay under the tile
  // budget, so specific project parcels would vanish from the dot view.
  sources["sb-projects"] = { type: "geojson", data: projectsGeojson() };
  sources["om-listings"] = { type: "geojson", data: listingsGeojson() };
  // OZ 2.0 tracts start empty; ensureOzLoaded() fills the source on first
  // toggle. Registered at style time — a geojson source added mid-session
  // can wedge isStyleLoaded() at false, starving the count/list refresh.
  sources["oz2"] = { type: "geojson", data: { type: "FeatureCollection", features: [] } };
  return {
    version: 8,
    sources,
    layers: [
      { id: "bg", type: "background", paint: { "background-color": "#eef1f4" } },
      { id: "basemap-streets", type: "raster", source: "streets" },
      { id: "basemap-satellite", type: "raster", source: "satellite",
        layout: { visibility: "none" } },
      // Synthetic street grid — present only in fixture/demo tilesets; the
      // deployed app gets real streets from the raster basemap instead.
      {
        id: "demo-streets", type: "line", source: "parcels0", "source-layer": "streets",
        paint: {
          "line-color": "#ffffff",
          "line-width": ["interpolate", ["linear"], ["zoom"],
            12, ["case", ["==", ["get", "cls"], "major"], 2, 1],
            16, ["case", ["==", ["get", "cls"], "major"], 14, 8]],
        },
      },
      ...tilesUrls.flatMap((_, i) => parcelLayers(i)),
      {
        id: "oz2-tint", type: "fill", source: "oz2",
        layout: { visibility: "none" },
        paint: { "fill-color": "#7c5cbf", "fill-opacity": 0.10 },
      },
      {
        id: "oz2-line", type: "line", source: "oz2",
        layout: { visibility: "none" },
        paint: { "line-color": "#7c5cbf", "line-opacity": 0.55, "line-width": 1.2,
          "line-dasharray": [3, 2] },
      },
      {
        id: "projects-markers", type: "circle", source: "sb-projects",
        maxzoom: 14,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 3, 12, 6],
          "circle-color": ["match", ["get", "status"],
            "approved", "#10b981", "#facc15"],
          "circle-stroke-color": "#fff",
          "circle-stroke-width": 1,
        },
      },
      {
        // On-market listing markers (data/listings.json). Hidden until the
        // On Market filter is active; drawn at every zoom so deals never
        // vanish from the dot view. Orange = the For Sale accent.
        id: "om-markers", type: "circle", source: "om-listings",
        filter: ["==", ["get", "ain"], "___none___"],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 5, 13, 8],
          "circle-color": "#d97706",
          "circle-stroke-color": "#fff",
          "circle-stroke-width": 1.5,
        },
      },
    ],
  };
}

function projectsGeojson() {
  return {
    type: "FeatureCollection",
    features: Object.entries(sbProjects)
      .filter(([, pr]) => pr.lng != null)
      .map(([ain, pr]) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [pr.lng, pr.lat] },
        properties: { ain, status: pr.status, tier: pr.tier || "" },
      })),
  };
}

// Does this planning case pass the current Status + Tier selection?
// (Status searches bypass the tile-attribute filters, so the tier scope
// must be applied to the project records themselves.)
function projInScope(pr) {
  const statusOk =
    state.dealStatus === "approved" ? pr.status === "approved"
      : state.dealStatus === "submitted" ? pr.status !== "approved" : true;
  const tierOk = state.tiers.size === 0 || state.tiers.has(pr.tier || "");
  return statusOk && tierOk && inSelectedAreas(pr.lng, pr.lat);
}

function listingsGeojson() {
  return {
    type: "FeatureCollection",
    features: Object.entries(omListings)
      .filter(([, l]) => l.lng != null)
      .map(([ain, l]) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [l.lng, l.lat] },
        properties: { ain, type: l.type || "" },
      })),
  };
}

// Is a lng/lat inside the selected search areas (no areas = everywhere)?
function inSelectedAreas(lng, lat) {
  const boxes = areaBoxes(state, CONFIG);
  if (!boxes.length) return true;
  if (lng == null) return false;
  return boxes.some(([w, s, e, n]) => lng >= w && lng <= e && lat >= s && lat <= n);
}

// ---- Opportunity Zone 2.0 (Recommended tracts, data/oz2.json) ----
// Loaded lazily on first toggle. ozTracts is an array of
// { props, bbox, rings } where rings = each polygon's ring list (outer +
// holes) for the even-odd point-in-polygon test the polygon views need
// ("within" covers only the centroid dot layers).
let ozTracts = null;
let ozLoadPromise = null;

function ensureOzLoaded() {
  if (ozLoadPromise) return ozLoadPromise;
  ozLoadPromise = fetch("data/oz2.json")
    .then((r) => r.json())
    .then((fc) => {
      const tracts = [];
      const multi = [];   // MultiPolygon coordinates for the "within" clause
      for (const f of fc.features) {
        const polys = f.geometry.type === "Polygon"
          ? [f.geometry.coordinates] : f.geometry.coordinates;
        for (const rings of polys) {
          multi.push(rings);
          let w = 180, s = 90, e = -180, n = -90;
          for (const [x, y] of rings[0]) {
            if (x < w) w = x; if (x > e) e = x;
            if (y < s) s = y; if (y > n) n = y;
          }
          tracts.push({ props: f.properties, bbox: [w, s, e, n], rings });
        }
      }
      ozTracts = tracts;
      setOzGeometry({ type: "MultiPolygon", coordinates: multi });
      map.getSource("oz2").setData(fc);
    });
  return ozLoadPromise;
}

function ringContains(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// The Recommended tract containing lng/lat, or null. Even-odd across the
// polygon's rings, so holes subtract.
function ozTractAt(lng, lat) {
  if (!ozTracts || lng == null) return null;
  for (const t of ozTracts) {
    const [w, s, e, n] = t.bbox;
    if (lng < w || lng > e || lat < s || lat > n) continue;
    let hits = 0;
    for (const ring of t.rings) if (ringContains(ring, lng, lat)) hits++;
    if (hits % 2 === 1) return t.props;
  }
  return null;
}

// Listings whose land $/SF passes the current range AND sit inside the
// selected search areas. A listing without a computable ppsf (no lot sf)
// passes only an unbounded range — it can't be price-screened, but
// shouldn't disappear from a plain On Market view.
function omAinsFor() {
  const [min, max] = state.omRange;
  return Object.keys(omListings).filter((ain) => {
    const l = omListings[ain];
    const okPrice = l.ppsf == null
      ? min === null && max === null
      : (min === null || l.ppsf >= min) && (max === null || l.ppsf <= max);
    const okTier = state.tiers.size === 0 || state.tiers.has(l.tier || "");
    return okPrice && okTier && inSelectedAreas(l.lng, l.lat);
  });
}

const FILTERED_LAYERS = [...lids("parcels-fill"), ...lids("parcels-line")];

// The address bar stays clean while browsing; filters + map position are
// encoded only when the user asks for a shareable link.
function shareUrl() {
  const filters = stateToHash(state).slice(1);
  let m = "";
  if (map) {
    const c = map.getCenter();
    m = `m=${c.lng.toFixed(5)},${c.lat.toFixed(5)},${map.getZoom().toFixed(2)}`;
  }
  const full = [filters, m].filter(Boolean).join("&");
  return location.origin + location.pathname + location.search + (full ? "#" + full : "");
}

function applyStatusOutlines() {
  const tagged = Object.keys(dealStatuses);
  if (!tagged.length) {
    for (const id of lids("parcels-status")) {
      map.setFilter(id, ["==", ["get", "ain"], "___none___"]);
    }
    return;
  }
  const match = ["match", ["get", "ain"]];
  for (const [ain, st] of Object.entries(dealStatuses)) {
    match.push(ain, STATUS_COLORS[st] || "#2563eb");
  }
  match.push("#2563eb");
  for (const id of lids("parcels-status")) {
    map.setPaintProperty(id, "line-color", match);
    map.setFilter(id, ["in", ["get", "ain"], ["literal", tagged]]);
  }
}

function applyFilters() {
  // Status matches team-tagged parcels AND LA City Planning case statuses:
  // Approved = approved cases; Submitted = pending (and terminated/withdrawn,
  // which display as submitted); Completed / For Sale are team tags only.
  let statusAins = [];
  if (state.dealStatus !== "any") {
    statusAins = statusAinsFor(state.dealStatus);
    for (const [ain, pr] of Object.entries(sbProjects)) {
      if (state.dealStatus === "approved" && pr.status === "approved") statusAins.push(ain);
      else if (state.dealStatus === "submitted" && pr.status !== "approved") statusAins.push(ain);
    }
  }
  const omAins = state.om ? omAinsFor() : [];
  const f = buildFilter(state, CONFIG, statusAins, omAins);
  for (const id of FILTERED_LAYERS) map.setFilter(id, f);
  const selBase = ["==", ["get", "ain"], selectedAin ?? "___none___"];
  for (const id of lids("parcels-selected")) {
    map.setFilter(id, f ? ["all", f, selBase] : selBase);
  }
  const cf = buildCentroidFilter(state, CONFIG, statusAins, omAins);
  for (const id of lids("centroids")) map.setFilter(id, cf);

  if (map.getLayer("om-markers")) {
    map.setFilter("om-markers", state.om
      ? ["in", ["get", "ain"], ["literal", omAins]]
      : ["==", ["get", "ain"], "___none___"]);
  }

  applyStatusOutlines();
  applyProjectScope();
  document.getElementById("list-title").textContent =
    state.om ? "On-market deals" :
    state.sbPreset ? "Candidates in view" : "Matches in view";
  scheduleCount();
}

// Status searches scope the project overlays too: Approved shows only
// approved cases (green), Submitted only pending ones (yellow); any other
// status shows every case.
function applyProjectScope() {
  const ains = Object.entries(sbProjects)
    .filter(([, pr]) => projInScope(pr)).map(([ain]) => ain);
  if (map.getLayer("projects-markers")) {
    map.setFilter("projects-markers", ["in", ["get", "ain"], ["literal", ains]]);
  }
  for (const id of lids("parcels-projects")) {
    if (map.getLayer(id)) {
      map.setFilter(id, ["in", ["get", "ain"], ["literal", ains]]);
    }
  }
}

// Turning On Market on brings every passing listing into view.
function zoomToOmResults() {
  const pts = omAinsFor()
    .map((ain) => omListings[ain])
    .filter((l) => l.lng != null);
  if (!pts.length) return;
  const b = new maplibregl.LngLatBounds();
  for (const l of pts) b.extend([l.lng, l.lat]);
  map.fitBounds(b, { padding: 80, maxZoom: 14 });
}

// Picking Submitted/Approved brings the matching planning cases into view —
// they're scattered citywide and rarely near wherever the map happens to be.
function zoomToStatusResults() {
  if (state.dealStatus !== "approved" && state.dealStatus !== "submitted") return;
  const pts = Object.values(sbProjects)
    .filter(projInScope)
    .filter((pr) => pr.lng != null);
  if (!pts.length) return;
  const b = new maplibregl.LngLatBounds();
  for (const pr of pts) b.extend([pr.lng, pr.lat]);
  map.fitBounds(b, { padding: 80, maxZoom: 14 });
}

/* ---------------- stats + candidates list ---------------- */

let countTimer = null;
let lastCandidates = [];
// The export cart (comps-style). Keyed by AIN with the property snapshot as
// the value, so a carted site survives panning away; insertion order =
// export order. Persisted in this browser so a cart built across searches
// (or days) isn't lost on reload.
const CART_KEY = "land-map-cart-v1";
const exportChecks = new Map();
try {
  for (const [ain, p] of JSON.parse(localStorage.getItem(CART_KEY)) || []) {
    exportChecks.set(ain, p);
  }
} catch (e) { /* fresh cart */ }

function saveCart() {
  try { localStorage.setItem(CART_KEY, JSON.stringify([...exportChecks.entries()])); } catch (e) { /* private mode */ }
}

function updateCartBadge() {
  const badge = document.getElementById("cart-count");
  if (!badge) return;
  badge.textContent = exportChecks.size || "";
  document.getElementById("cart-btn").classList.toggle("has-items", exportChecks.size > 0);
}

function cartToggle(p) {
  if (exportChecks.has(p.ain)) exportChecks.delete(p.ain);
  else exportChecks.set(p.ain, p);
  saveCart();
  updateCartBadge();
  renderCartPanel();
  scheduleCount();
}
function scheduleCount() {
  clearTimeout(countTimer);
  countTimer = setTimeout(updateCount, 250);
}

function median(sorted) {
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
}

function fmt(n) { return Number(n).toLocaleString(); }

function updateCount() {
  if (!map) return;
  // A filter change briefly marks the style dirty; dropping the update here
  // would freeze the list on stale results, so re-arm instead.
  if (!map.isStyleLoaded()) { scheduleCount(); return; }
  const zoom = map.getZoom();
  const layers = zoom >= 14 ? lids("parcels-fill") : lids("centroids");
  const feats = map.queryRenderedFeatures({ layers });

  const byAin = new Map();
  for (const f of feats) {
    if (!byAin.has(f.properties.ain)) byAin.set(f.properties.ain, f);
  }

  // Area chips scope everything. The centroid layers filter geometrically on
  // the map; polygon layers can't ("within" is points-only), so the
  // polygon-zoom stats and list are scoped here instead.
  const boxes = areaBoxes(state, CONFIG);
  const inBoxes = (f) => {
    if (!f.geometry) return false;
    const [x, y] = featureCenter(f);
    return boxes.some(([w, s, e, n]) => x >= w && x <= e && y >= s && y <= n);
  };
  let inView = [...byAin.values()];
  if (boxes.length) inView = inView.filter(inBoxes);
  // OZ 2.0 scopes the polygon views in JS the same way area chips do
  // (the centroid layers already filter via "within" on the map).
  if (state.oz && ozTracts) {
    inView = inView.filter((f) => {
      if (!f.geometry) return false;
      const [x, y] = featureCenter(f);
      return ozTractAt(x, y) !== null;
    });
  }

  document.getElementById("result-count").textContent = inView.length.toLocaleString();
  document.getElementById("result-label").textContent =
    zoom >= 14 ? "parcels in view" : "parcel dots in view";

  const candidates = inView.filter((f) => f.properties.e === 1);
  document.getElementById("stat-candidates").textContent = candidates.length.toLocaleString();

  // The list is always the current matches (rendered features pass the
  // universe + filters). With the SB preset on, matches ARE the candidates.
  let listSource = inView;
  // On Market lists the passing deals in the CURRENT VIEW — with 400+ deals
  // across three counties, a dataset-wide sheet buries what the user is
  // looking at (Ventura rows while panning the Valley). Pan or zoom out to
  // see more; the activation zoom starts fitted to everything.
  if (state.om) {
    const vb = map.getBounds();
    let omFeats = omAinsFor()
      .filter((ain) => {
        const l = omListings[ain];
        return l.lng != null && vb.contains([l.lng, l.lat]);
      })
      .map((ain) => {
        const l = omListings[ain];
        return byAin.get(ain) || {
          properties: { ain, a: l.address || "", lsf: l.lotSqft ?? null,
            w: null, t: l.tier || "", e: 0, v: null },
          geometry: { type: "Point", coordinates: [l.lng, l.lat] },
        };
      });
    if (boxes.length) omFeats = omFeats.filter(inBoxes);
    listSource = omFeats;
  }
  // A planning-status search lists ALL matching cases citywide, not just the
  // viewport — the projects are scattered and the panel would look empty.
  if (state.dealStatus === "approved" || state.dealStatus === "submitted") {
    let projFeats = Object.entries(sbProjects)
      .filter(([, pr]) => projInScope(pr))
      .map(([ain, pr]) => ({
        properties: { ain, a: pr.address || "", lsf: pr.lotSqft ?? null,
          w: null, t: pr.tier || "", e: 0, v: pr.vacant ?? null },
        geometry: pr.lng != null
          ? { type: "Point", coordinates: [pr.lng, pr.lat] } : null,
      }));
    if (boxes.length) projFeats = projFeats.filter(inBoxes);
    const projAins = new Set(projFeats.map((f) => f.properties.ain));
    listSource = projFeats.concat(listSource.filter((f) => !projAins.has(f.properties.ain)));
  }
  lastCandidates = listSource;

  const lots = listSource.map((f) => f.properties.lsf).sort((a, b) => a - b);
  const widths = listSource.map((f) => f.properties.w).filter((w) => w != null).sort((a, b) => a - b);
  const medLot = median(lots);
  const medW = median(widths);
  document.getElementById("stat-medlot").textContent = medLot === null ? "–" : fmt(medLot);
  document.getElementById("stat-medwidth").textContent = medW === null ? "–" : fmt(medW);

  renderList(listSource, zoom >= 14);
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

  // On Market reads as a price sheet: cheapest land $/SF first.
  if (state.om) {
    candidates.sort((a, b) =>
      (omListings[a.properties.ain]?.ppsf ?? Infinity)
      - (omListings[b.properties.ain]?.ppsf ?? Infinity));
  } else {
    candidates.sort((a, b) => (b.properties.lsf || 0) - (a.properties.lsf || 0));
  }
  const shown = candidates.slice(0, MAX);

  const topline = candidates.length > MAX ? `top ${MAX} of ${fmt(candidates.length)}` : "";
  const sel = exportChecks.size;
  document.getElementById("list-count").innerHTML = [
    topline,
    sel ? `<b>${sel} in cart</b> <button id="clear-checks" title="Empty the cart">clear</button>` : "",
  ].filter(Boolean).join(" · ");
  document.getElementById("export-btn").textContent = sel ? `Excel (${sel})` : "Excel";
  updateCartBadge();

  list.innerHTML = "";
  empty.style.display = shown.length ? "none" : "block";
  if (!shown.length) {
    empty.innerHTML = state.om && !Object.keys(omListings).length
      ? `No on-market deals loaded yet. Deals live in
         <code>data/listings.json</code> — add them and reload.`
      : state.om
        ? "No on-market deals match the $/SF range. Widen or clear it."
        : demoMode
          ? `Demo mode: the synthetic dataset covers only a small Venice-area test
             grid (all Tier A) — real LA parcels aren't loaded yet.
             <button id="goto-demo">Go to demo area</button>`
          : "No qualifying parcels in view. Zoom or pan the map, or relax filters.";
  }

  for (const f of shown) {
    const p = f.properties;
    const li = document.createElement("li");
    li.className = "site-item" + (p.ain === selectedAin ? " selected" : "");

    // Comps-style export checkbox; clicks must not trigger the row's zoom.
    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "site-check";
    check.title = "Check to include in the Excel export";
    check.checked = exportChecks.has(p.ain);
    check.addEventListener("click", (e) => e.stopPropagation());
    check.addEventListener("change", () => cartToggle(p));

    const dot = document.createElement("span");
    dot.className = "site-dot";
    const proj = sbProjects[p.ain];
    const listing = state.om ? omListings[p.ain] : null;
    dot.style.background = listing ? "#d97706"
      : proj ? (proj.status === "approved" ? "#10b981" : "#facc15")
      : COLORS.sfr;

    const info = document.createElement("div");
    info.className = "site-info";
    const name = document.createElement("div");
    name.className = "site-name";
    const nameText = document.createElement("span");
    nameText.className = "site-name-text";
    nameText.textContent = displayName(p);
    name.appendChild(nameText);
    if (proj) {
      const badge = document.createElement("span");
      badge.className = "site-badge " + (proj.status === "approved" ? "badge-appr" : "badge-sub");
      badge.textContent = proj.status === "approved" ? "Approved" : "Submitted";
      name.appendChild(badge);
    }
    if (p.e === 1) {
      const sb = document.createElement("span");
      sb.className = "site-badge badge-sb";
      sb.textContent = "SB 1123";
      name.appendChild(sb);
    }
    // Rows stay minimal: address + property type on the left, lot size
    // (+ proposed homes for SB cases) on the right. The rest lives in the
    // detail panel.
    info.appendChild(name);
    // Meta line: community · zoning · type (+ lot sf for listings, whose
    // right column carries price instead of lot size).
    const metaParts = [
      splitAddr(p.a).cityName,
      p.zc,
      listing ? listing.type
        : p.v === 1 ? "Vacant Lot" : p.v === 0 ? "Single Family" : null,
      listing && p.lsf != null ? fmt(p.lsf) + " sf lot" : null,
    ].filter(Boolean);
    if (metaParts.length) {
      const meta = document.createElement("div");
      meta.className = "site-meta";
      meta.textContent = metaParts.join(" · ");
      info.appendChild(meta);
    }

    const tier = document.createElement("span");
    tier.className = "site-right";
    const lotB = document.createElement("b");
    if (listing) {
      lotB.textContent = "$" + fmt(listing.price);
      tier.appendChild(lotB);
      if (listing.ppsf != null) {
        const psf = document.createElement("span");
        psf.textContent = "$" + fmt(listing.ppsf) + "/sf land";
        tier.appendChild(psf);
      }
    } else {
      lotB.textContent = p.lsf != null ? fmt(p.lsf) + " sf" : "";
      tier.appendChild(lotB);
    }
    if (proj && proj.units) {
      const homes = document.createElement("span");
      homes.textContent = proj.units + " homes";
      tier.appendChild(homes);
    }

    const center = f.geometry ? featureCenter(f) : null;
    li.addEventListener("click", () => {
      if (!center) return;
      map.easeTo({ center, zoom: Math.max(map.getZoom(), 15) });
      showDetail(p, { lat: center[1], lng: center[0] });
    });

    li.appendChild(check);
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

  // Aerial (satellite) embed of the parcel; Street View stays as a link below.
  const aerialEmbed = CONFIG.GOOGLE_MAPS_KEY && lat
    ? `<iframe class="dp-sv" loading="lazy" referrerpolicy="no-referrer-when-downgrade"
         src="https://www.google.com/maps/embed/v1/view?key=${CONFIG.GOOGLE_MAPS_KEY}&center=${lat},${lng}&zoom=19&maptype=satellite"
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
        ${splitAddr(p.a).cityLine ? `<div class="dp-city">${splitAddr(p.a).cityLine}</div>` : ""}
        <div class="dp-sub">APN ${fmtApn(p)}${p.t ? " · Tier " + p.t + " — " + (TIER_NAMES[p.t] || "") : ""}${p.co && p.co !== "LA" ? " · " + (COUNTY_NAMES[p.co] || p.co) : ""}</div>
      </div>
      <button id="dp-close" title="Close">×</button>
    </div>
    <div class="dp-badges">${badges.join(" ")}</div>
    ${aerialEmbed}
    <div class="dp-tiles">
      <div class="dp-tile"><b>${p.lsf != null ? fmt(p.lsf) : "–"}</b><span>Lot sf${p.lsf != null ? " · " + acres + " ac" : ""}</span></div>
      <div class="dp-tile dp-tile-navy"><b>${p.w != null ? "≈ " + p.w + " ft" : "–"}</b><span>Width · computed</span></div>
    </div>
    <section class="dp-section">
      <h4>Parcel</h4>
      ${kvRow("Zoning", `${p.z || "?"} <span class="muted">(${p.zc || "?"})</span>`)}
      ${kvRow("Use code", p.uc || "–")}
      ${kvRow("Units", p.u >= 0 ? p.u : "–")}
      ${kvRow("Improvements", p.iv != null ? "$" + fmt(p.iv) : "–")}
      ${p.ls ? kvRow("Last sale", p.ls) : ""}
      ${(() => {
        const t = lngLat && ozTracts ? ozTractAt(lngLat.lng, lngLat.lat) : null;
        return t ? kvRow("Opportunity Zone 2.0", `Recommended tract ${t.Geoid || ""}`) : "";
      })()}
    </section>
    ${listingSectionHtml(p)}
    ${projectSectionHtml(p)}
    ${articlesSectionHtml(p)}
    <section class="dp-section">
      <h4>Owner information</h4>
      <div id="dp-owner"><div class="dp-loading">Looking up owner…</div></div>
    </section>
    <div class="dp-links">
      ${assessorUrl(p) ? `<a href="${assessorUrl(p)}" target="_blank" rel="noopener">Assessor ↗</a>` : ""}
      ${(!p.co || p.co === "LA") ? `<a href="${CONFIG.ZIMAS_URL}" target="_blank" rel="noopener">ZIMAS ↗</a>` : ""}
      ${lat ? `<a href="${CONFIG.STREETVIEW_URL(lat, lng)}" target="_blank" rel="noopener">Street View ↗</a>` : ""}
    </div>
    <button id="dp-cart-btn" class="dp-cart-btn${exportChecks.has(p.ain) ? " in-cart" : ""}">
      ${exportChecks.has(p.ain) ? "✓ In cart — remove" : "🛒 Add to cart"}
    </button>`;
}

// Live listing details (any parcel in data/listings.json shows these,
// whether or not the On Market filter is active).
function listingSectionHtml(p) {
  const l = omListings[p.ain];
  if (!l) return "";
  return `
    <section class="dp-section">
      <h4>On market <span class="badge badge-om">For Sale</span></h4>
      ${kvRow("List price", "$" + fmt(l.price))}
      ${l.ppsf != null ? kvRow("$/SF land", "$" + fmt(l.ppsf)) : ""}
      ${l.type ? kvRow("Type", l.type) : ""}
      ${l.mls ? kvRow("MLS", l.mls) : ""}
      ${l.listDate ? kvRow("Listed", l.listDate) : ""}
      ${l.broker ? kvRow("Brokerage", l.broker) : ""}
      ${l.url ? `<div class="dp-links" style="padding:8px 0 0">
        <a href="${l.url}" target="_blank" rel="noopener">View listing ↗</a></div>` : ""}
    </section>`;
}

// Press coverage (Urbanize LA / YIMBY / The Real Deal…) attached to a
// project or listing record via its "articles" array.
function articlesSectionHtml(p) {
  const arts = [
    ...((sbProjects[p.ain] || {}).articles || []),
    ...((omListings[p.ain] || {}).articles || []),
  ];
  if (!arts.length) return "";
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
  const rows = arts.map((a) => `
    <a class="dp-article" href="${esc(a.url)}" target="_blank" rel="noopener">
      <span class="dp-article-src">${esc(a.source || "Press")}${a.date ? " · " + esc(a.date) : ""}</span>
      <span class="dp-article-title">${esc(a.title || a.url)} ↗</span>
    </a>`).join("");
  return `
    <section class="dp-section">
      <h4>Articles</h4>
      ${rows}
    </section>`;
}

function projectSectionHtml(p) {
  const pr = sbProjects[p.ain];
  if (!pr) return "";
  const badge = pr.status === "approved"
    ? '<span class="badge" style="background:#059669">Approved</span>'
    : '<span class="badge" style="background:#ca8a04">Submitted</span>';
  const closedNote = pr.status === "closed"
    ? `<p class="dp-note dp-warn">Case ${pr.rawStatus.toLowerCase()}${pr.decided ? " on " + pr.decided : ""} — was submitted ${pr.filed || ""}.</p>`
    : "";
  return `
    <section class="dp-section">
      <h4>SB 684 / 1123 project ${badge}</h4>
      ${closedNote}
      ${kvRow("Case", pr.case)}
      ${kvRow("Bill", pr.bill || "–")}
      ${kvRow("Submitted", pr.filed || "–")}
      ${pr.status === "approved" && pr.decided ? kvRow("Approved", pr.decided) : ""}
      ${kvRow("Homes", pr.units ?? "–")}
      ${pr.entity ? kvRow("Owner entity", pr.entity) : ""}
      ${pr.rep ? kvRow("Representative", `${pr.rep}${pr.repCompany ? " · " + pr.repCompany : ""}`) : ""}
      ${pr.phone && pr.phone !== "n/a" ? kvRow("Contact", pr.phone) : ""}
      ${pr.desc ? `<p class="dp-note">${pr.desc}</p>` : ""}
    </section>`;
}

function ownerFallbackHtml(p) {
  const url = assessorUrl(p);
  const link = url
    ? `<a class="dp-owner-link" href="${url}" target="_blank" rel="noopener">
         Owner record on Assessor portal ↗</a>`
    : "";
  return `
    <p class="dp-note">Owner name, mailing address, and sale history aren't in
    open data. Connect LandVision/LightBox (see README) for automatic
    lookups${url ? ", or check the assessor record:" : "."}</p>${link}`;
}

// OpenCorporates entity-search link for LLC/corp/trust owner names.
function ownerOcLink(name) {
  return name && /\b(LLC|L\.P\.|LP|INC|CORP|TRUST)\b/i.test(name)
    ? `<a class="dp-owner-link" href="https://opencorporates.com/companies/us_ca?q=${encodeURIComponent(name)}" target="_blank" rel="noopener">OpenCorporates ↗</a>`
    : "";
}

async function fillOwnerInfo(p) {
  const el = document.getElementById("dp-owner");
  if (!el) return;
  // Team-curated assessor data on the listing/project record wins: verified
  // by an agent, and no per-view API spend.
  const rec = omListings[p.ain] || sbProjects[p.ain] || {};
  if (rec.ownerName || rec.lastSalePrice) {
    const rows = [];
    if (rec.ownerName) rows.push(kvRow("Owner (Assessor)", rec.ownerName));
    if (rec.ownerAddress) rows.push(kvRow("Owner address", rec.ownerAddress));
    if (rec.lastSaleDate || rec.lastSalePrice) {
      rows.push(kvRow("Last market sale",
        [rec.lastSaleDate, rec.lastSalePrice ? "$" + fmt(rec.lastSalePrice) : ""]
          .filter(Boolean).join(" · ")));
    }
    el.innerHTML = rows.join("") + ownerOcLink(rec.ownerName);
    return;
  }
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
    el.innerHTML = rows.join("") + ownerOcLink(d.owner);
  } catch (e) {
    if (document.getElementById("dp-owner") === el) el.innerHTML = ownerFallbackHtml(p);
  }
}

/* ---------------- export cart panel ---------------- */

function renderCartPanel() {
  const panel = document.getElementById("cart-panel");
  if (!panel || panel.classList.contains("hidden")) return;
  const items = [...exportChecks.values()];
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
  panel.innerHTML = items.length ? `
    <div class="cart-head">${items.length} propert${items.length === 1 ? "y" : "ies"}</div>
    <ul class="cart-list">
      ${items.map((p) => `
        <li data-ain="${esc(p.ain)}">
          <span class="cart-item-name">${esc(displayName(p))}</span>
          <span class="cart-item-city">${esc(splitAddr(p.a).cityName)}</span>
          <button class="cart-remove" title="Remove">×</button>
        </li>`).join("")}
    </ul>
    <div class="cart-actions">
      <button id="cart-clear">Clear</button>
      <button id="cart-export">Export to Excel</button>
    </div>`
    : `<div class="cart-empty">Cart is empty. Check properties in the list,
       or use "Add to cart" in a parcel's panel.</div>`;
}

// Full parcel attributes for an AIN from whatever tiles are rendered.
function tilePropsFor(ain) {
  const layers = [...lids("parcels-fill"), ...lids("parcels-context")]
    .filter((id) => map.getLayer(id));
  const f = map.queryRenderedFeatures({ layers })
    .find((x) => x.properties.ain === ain);
  return f ? f.properties : null;
}

function showDetail(p, lngLat) {
  selectedAin = p.ain;
  applyFilters();
  const panel = document.getElementById("detail-panel");
  panel.innerHTML = detailHtml(p, lngLat);
  panel.classList.remove("hidden");
  document.getElementById("dp-close").addEventListener("click", closeDetail);
  document.getElementById("dp-cart-btn").addEventListener("click", () => {
    cartToggle(p);
    const btn = document.getElementById("dp-cart-btn");
    const now = exportChecks.has(p.ain);
    btn.textContent = now ? "✓ In cart — remove" : "🛒 Add to cart";
    btn.classList.toggle("in-cart", now);
  });
  fillOwnerInfo(p);

  // Rows opened from the citywide lists (projects, listings) carry only the
  // record stub, not the tile attributes (zoning, units, improvements, lot).
  // Once the flown-to parcel's tiles render, merge them in and re-paint.
  if (p.zc == null || p.iv == null) {
    let tries = 0;
    const arm = () => map.once("idle", () => {
      if (selectedAin !== p.ain) return;
      const tp = tilePropsFor(p.ain);
      if (tp) showDetail({ ...p, ...tp }, lngLat);
      else if (++tries < 3) arm();
    });
    arm();
  }
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

  const setValOm = (id, v) => { document.getElementById(id).value = v === null ? "" : v; };
  setValOm("ppsf-min", state.omRange[0]);
  setValOm("ppsf-max", state.omRange[1]);
  setPillVal("pv-ppsf", rangeSummary(state.omRange));
  document.getElementById("onmarket-btn").classList.toggle("active", !!state.om);
  document.getElementById("ppsf-dd").classList.toggle("hidden", !state.om);

  document.getElementById("oz-btn").classList.toggle("active", !!state.oz);
  for (const id of ["oz2-tint", "oz2-line"]) {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, "visibility", state.oz ? "visible" : "none");
    }
  }

  renderAreaChips();
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
      // Status searches and On Market are citywide views — re-fit the map
      // to the results that survive the new tier scope.
      zoomToStatusResults();
      if (state.om) zoomToOmResults();
    });
  });

  document.querySelectorAll('input[name="dstatus"]').forEach((rb) => {
    rb.addEventListener("change", () => {
      if (rb.checked) state.dealStatus = rb.value;
      // A status search shows pipeline parcels, which are rarely SB-vacant
      // candidates — the preset would contradict it. Same for On Market
      // (both pin to disjoint AIN lists).
      if (state.dealStatus !== "any") { state.sbPreset = false; state.om = false; }
      syncControlsFromState();
      applyFilters();
      zoomToStatusResults();
    });
  });

  document.querySelectorAll('input[name="imp"]').forEach((rb) => {
    rb.addEventListener("change", () => {
      if (rb.checked) state.imp = rb.value;
      // "SFR Home" contradicts the SB preset (which requires vacant lots) —
      // never let them silently AND into an always-empty result.
      if (state.imp === "sfr" && state.sbPreset) state.sbPreset = false;
      syncControlsFromState();
      applyFilters();
    });
  });

  document.getElementById("sb1123-btn").addEventListener("click", () => {
    // Search scope, On Market AND the OZ scope survive preset toggling —
    // narrowing the live deals to SB candidates is the whole point of
    // combining them.
    const { areas, om, omRange, oz } = state;
    state = state.sbPreset ? emptyState() : sb1123State(CONFIG);
    state.areas = areas;
    state.om = om;
    state.omRange = omRange;
    state.oz = oz;
    syncControlsFromState();
    applyFilters();
  });

  document.getElementById("oz-btn").addEventListener("click", async () => {
    state.oz = !state.oz;
    if (state.oz) await ensureOzLoaded();
    syncControlsFromState();
    applyFilters();
  });

  document.getElementById("onmarket-btn").addEventListener("click", () => {
    state.om = !state.om;
    // A status search and On Market both pin the map to their own AIN lists —
    // ANDing them is almost always empty, so they're mutually exclusive.
    if (state.om) state.dealStatus = "any";
    syncControlsFromState();
    applyFilters();
    if (state.om) zoomToOmResults();
  });

  const onPpsfChange = () => {
    const parse = (id) => {
      const v = document.getElementById(id).value.trim();
      return v === "" ? null : Number(v);
    };
    state.omRange = [parse("ppsf-min"), parse("ppsf-max")];
    syncControlsFromState();
    applyFilters();
  };
  for (const id of ["ppsf-min", "ppsf-max"]) {
    document.getElementById(id).addEventListener("change", onPpsfChange);
  }

  document.getElementById("reset-btn").addEventListener("click", () => {
    // Clear resets filters; selected search areas keep their own × chips.
    const areas = state.areas;
    state = emptyState();
    state.areas = areas;
    selectedAin = null;
    syncControlsFromState();
    applyFilters();
  });

  document.getElementById("sat-btn").addEventListener("click", () => {
    const btn = document.getElementById("sat-btn");
    if (!map.getLayer("basemap-satellite")) return;
    const sat = map.getLayoutProperty("basemap-satellite", "visibility") === "visible";
    // Opaque gray ghosts would blank out the imagery — fade them on satellite.
    for (const id of lids("parcels-context")) {
      if (map.getLayer(id)) map.setPaintProperty(id, "fill-opacity", sat ? 1 : 0.08);
    }
    // The satellite raster sits above every basemap layer, so toggling its
    // visibility alone covers/uncovers whichever basemap is active.
    map.setLayoutProperty("basemap-satellite", "visibility", sat ? "none" : "visible");
    btn.classList.toggle("active", !sat);
  });

  document.getElementById("export-btn").addEventListener("click", () => LandMap.exportExcel());

  // "clear" link inside the list-count line (re-rendered on every count).
  document.getElementById("list-count").addEventListener("click", (e) => {
    if (e.target.id === "clear-checks") LandMap.clearChecks();
  });

  // Cart button + panel (topbar).
  document.getElementById("cart-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    const panel = document.getElementById("cart-panel");
    panel.classList.toggle("hidden");
    renderCartPanel();
  });
  document.getElementById("cart-panel").addEventListener("click", (e) => {
    e.stopPropagation();
    if (e.target.id === "cart-clear") LandMap.clearChecks();
    else if (e.target.id === "cart-export") LandMap.exportExcel();
    else if (e.target.classList.contains("cart-remove")) {
      const ain = e.target.closest("li").dataset.ain;
      exportChecks.delete(ain);
      saveCart();
      updateCartBadge();
      renderCartPanel();
      scheduleCount();
    } else if (e.target.closest("li")) {
      // Clicking a cart row flies to the property.
      const ain = e.target.closest("li").dataset.ain;
      const p = exportChecks.get(ain);
      const l = omListings[ain] || sbProjects[ain] || {};
      if (l.lng != null) {
        map.easeTo({ center: [l.lng, l.lat], zoom: 16 });
        showDetail(p, { lng: l.lng, lat: l.lat });
      }
    }
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#cart-panel") && !e.target.closest("#cart-btn")) {
      document.getElementById("cart-panel").classList.add("hidden");
    }
  });

  document.getElementById("empty-sites").addEventListener("click", (e) => {
    if (e.target.id === "goto-demo" && demoBounds) {
      map.fitBounds(demoBounds, { padding: 40 });
    }
  });

  document.getElementById("copy-link-btn").addEventListener("click", async () => {
    const btn = document.getElementById("copy-link-btn");
    try {
      await navigator.clipboard.writeText(shareUrl());
      btn.textContent = "Copied!";
    } catch (e) {
      btn.textContent = "Copy failed";
    }
    setTimeout(() => { btn.textContent = "Link"; }, 1500);
  });

  bindSearch();
}

// Selected-area chips inside the search field, comps-style: each shows
// "Venice ×"; removing one re-scopes the results and view.
function renderAreaChips() {
  const wrap = document.getElementById("search-chips");
  const input = document.getElementById("search-input");
  if (!wrap || !input) return;
  wrap.innerHTML = "";
  for (const name of state.areas || []) {
    const chip = document.createElement("span");
    chip.className = "area-chip";
    chip.appendChild(document.createTextNode(name));
    const x = document.createElement("button");
    x.textContent = "×";
    x.title = "Remove " + name;
    x.addEventListener("click", () => {
      state.areas = state.areas.filter((n) => n !== name);
      syncControlsFromState();
      applyFilters();
      zoomToAreas();
    });
    chip.appendChild(x);
    wrap.appendChild(chip);
  }
  input.placeholder = (state.areas || []).length
    ? "Add another area, or search an address…"
    : "Search a neighborhood, city, or ZIP…";
}

// Fit the map to the union of the selected areas.
function zoomToAreas() {
  const boxes = areaBoxes(state, CONFIG);
  if (!boxes.length) return;
  const b = new maplibregl.LngLatBounds();
  for (const [w, s, e, n] of boxes) {
    b.extend([w, s]);
    b.extend([e, n]);
  }
  map.fitBounds(b, { padding: 40 });
}

function bindSearch() {
  const input = document.getElementById("search-input");
  const datalist = document.getElementById("hood-list");
  const hoods = CONFIG.NEIGHBORHOODS || {};
  for (const name of Object.keys(hoods)) {
    const opt = document.createElement("option");
    opt.value = name;
    datalist.appendChild(opt);
  }

  function run() {
    const q = input.value.trim();
    if (!q) return;
    // Known areas become chips (multi-area scope); anything else geocodes
    // as a one-off navigation.
    const hood = Object.keys(hoods).find((n) => n.toLowerCase() === q.toLowerCase());
    if (hood) {
      if (!state.areas.includes(hood)) state.areas.push(hood);
      input.value = "";
      syncControlsFromState();
      applyFilters();
      zoomToAreas();
      return;
    }
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
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") run();
    // Backspace in an empty input removes the last chip, like comps.
    if (e.key === "Backspace" && input.value === "" && state.areas.length) {
      state.areas.pop();
      syncControlsFromState();
      applyFilters();
      zoomToAreas();
    }
  });
  input.addEventListener("change", run); // datalist pick
}

/* ---------------- v2 hook: overlay points (e.g. comps / listings) ---------------- */

const LandMap = {
  setStatus(ain, value) {
    if (value) dealStatuses[ain] = value;
    else delete dealStatuses[ain];
    saveStatuses();
    applyFilters();
  },
  // CSV of the candidates currently in view (what the list shows, uncapped).
  exportCsv() {
    const header = ["address", "apn", "tier", "zone_class", "zoning", "lot_sqft",
      "width_ft", "units", "use_code", "improvement_value", "vacant",
      "sb1123_candidate", "status", "list_price", "list_ppsf_land",
      "listing_url", "assessor_url"];
    const esc = (v) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const rows = lastCandidates.map((f) => {
      const p = f.properties;
      const l = omListings[p.ain] || {};
      return [fmtAddr(p.a), p.ain, p.t, p.zc, p.z, p.lsf, p.w, p.u, p.uc, p.iv,
        p.v, p.e, STATUS_LABELS[dealStatuses[p.ain]] || "",
        l.price ?? "", l.ppsf ?? "", l.url ?? "",
        assessorUrl(p)].map(esc).join(",");
    });
    return [header.join(","), ...rows].join("\n");
  },
  downloadCsv() {
    const blob = new Blob([LandMap.exportCsv()], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "land-candidates.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  },
  // Excel export, comps-style: the checked properties (in the order they
  // were checked), or everything currently listed when nothing is checked.
  // Client-side — a styled HTML table with an .xls name opens in Excel with
  // the LAAA navy/gold header intact; no backend or vendored library needed.
  exportExcel() {
    const rows = exportChecks.size
      ? [...exportChecks.values()]
      : lastCandidates.map((f) => f.properties);
    const esc = (v) => String(v ?? "").replace(/[&<>"]/g,
      (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
    const num = (v) => (v == null || v === "" ? "" : Number(v));
    const proj = (p) => sbProjects[p.ain] || {};
    const lst = (p) => omListings[p.ain] || {};
    const cols = [
      ["Address", (p) => splitAddr(p.a).street || "APN " + fmtApn(p)],
      ["City", (p) => splitAddr(p.a).cityName],
      ["APN", (p) => fmtApn(p)],
      ["Tier", (p) => p.t || ""],
      ["Zoning", (p) => p.zc || ""],
      ["Lot SF", (p) => num(p.lsf)],
      ["Width ft", (p) => num(p.w)],
      ["Vacant", (p) => (p.v === 1 ? "Yes" : p.v === 0 ? "No" : "")],
      ["SB 1123", (p) => (p.e === 1 ? "Candidate" : "")],
      ["Case", (p) => proj(p).case ?? ""],
      ["Status", (p) => STATUS_LABELS[dealStatuses[p.ain]]
        || (proj(p).status ? STATUS_LABELS[proj(p).status] || proj(p).status : "")],
      ["Submitted", (p) => proj(p).filed ?? ""],
      ["Approved", (p) => (proj(p).status === "approved" ? proj(p).decided ?? "" : "")],
      ["Homes", (p) => proj(p).units ?? ""],
      ["Owner", (p) => proj(p).owner || lst(p).ownerName || ""],
      ["Entity", (p) => proj(p).entity ?? ""],
      ["Applicant", (p) => [proj(p).rep, proj(p).repCompany].filter(Boolean).join(" - ")],
      ["Contact", (p) => proj(p).phone ?? ""],
      ["List Price", (p) => num(lst(p).price)],
      ["$/SF Land", (p) => num(lst(p).ppsf)],
      ["MLS", (p) => lst(p).mls ?? ""],
      ["Listing", (p) => lst(p).url ?? ""],
      ["Assessor", (p) => assessorUrl(p)],
      ["Notes", (p) => proj(p).desc ?? ""],
    ];
    const th = cols.map(([h]) =>
      `<th style="background:#1B3A5C;color:#fff;font-weight:700;padding:6px 10px;
        border-bottom:2.5px solid #C9A45C;white-space:nowrap">${esc(h)}</th>`).join("");
    const trs = rows.map((p) => "<tr>" + cols.map(([h, get]) => {
      const v = get(p);
      const link = (h === "Listing" || h === "Assessor") && v;
      const numeric = typeof v === "number";
      const wrap = h === "Notes" ? "max-width:520px;white-space:normal" : "white-space:nowrap";
      return `<td style="padding:4px 10px;border-bottom:1px solid #e4e8ec;${numeric ? "mso-number-format:'\\#\\,\\#\\#0';" : ""}${wrap}">`
        + (link ? `<a href="${esc(v)}">${esc(v)}</a>` : esc(v)) + "</td>";
    }).join("") + "</tr>").join("");
    const html = `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head>
      <meta charset="UTF-8"><!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets>
      <x:ExcelWorksheet><x:Name>LAAA Land Export</x:Name><x:WorksheetOptions><x:FrozenNoSplit/>
      </x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->
      </head><body><table>${"<thead><tr>" + th + "</tr></thead><tbody>" + trs + "</tbody>"}</table></body></html>`;
    const blob = new Blob(["﻿" + html], { type: "application/vnd.ms-excel" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "LAAA Land Export.xls";
    a.click();
    URL.revokeObjectURL(a.href);
  },
  clearChecks() {
    exportChecks.clear();
    saveCart();
    updateCartBadge();
    renderCartPanel();
    scheduleCount();
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
  // OZ 2.0 internals (used by tests/tools).
  ozTractAt,
  get ozLoaded() { return ozTracts !== null; },
  updateCount,
  // Layer-instance lists across all tile sources (used by tests/tools).
  lids,
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
  base.sources = { ...base.sources };
  for (const [k, v] of Object.entries(fallback.sources)) {
    if (k === "satellite" || k === "sb-projects" || k === "om-listings"
      || k === "oz2" || k.startsWith("parcels")) {
      base.sources[k] = v;
    }
  }
  const overlayIds = new Set([
    "basemap-satellite", "projects-markers", "om-markers", "oz2-tint", "oz2-line",
    ...["centroids", "parcels-fill", "parcels-line", "parcels-projects",
      "parcels-status", "parcels-selected"].flatMap(lids),
  ]);
  base.layers = [...base.layers, ...fallback.layers.filter((l) => overlayIds.has(l.id))];
  return base;
}

// Basemap preference: Mapbox raster tiles (with token) -> free OpenFreeMap
// vector style -> raster OSM -> plain background. Never breaks the app.
// Mapbox is consumed via its Static Tiles API (styled raster tiles) rather
// than the vector style JSON: identical cartography, and immune to
// Mapbox-proprietary style-spec features that MapLibre can't apply.
async function buildStyle() {
  const fallback = baseStyle();
  if (CONFIG.MAPBOX_TOKEN) {
    const stylePath = CONFIG.MAPBOX_STYLE.replace("mapbox://styles/", "");
    const style = baseStyle();
    style.sources.streets = {
      type: "raster",
      tiles: [`https://api.mapbox.com/styles/v1/${stylePath}/tiles/512/{z}/{x}/{y}@2x?access_token=${CONFIG.MAPBOX_TOKEN}`],
      tileSize: 512,
      attribution: '© <a href="https://www.mapbox.com/about/maps/">Mapbox</a> © OpenStreetMap',
    };
    return style;
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

// Runtime keys from Vercel env vars via api/config (keeps tokens out of the
// repo). Silently skipped in dev/preview where the endpoint doesn't exist.
async function loadRemoteConfig() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const resp = await fetch("api/config", { signal: ctrl.signal });
    clearTimeout(timer);
    if (!resp.ok) return;
    const c = await resp.json();
    if (c.mapboxToken) CONFIG.MAPBOX_TOKEN = c.mapboxToken;
    if (c.googleMapsKey) CONFIG.GOOGLE_MAPS_KEY = c.googleMapsKey;
  } catch (e) { /* offline/dev: config.js values apply */ }
}

// LA City Planning SB 684/1123 cases, keyed by AIN (data/projects.json,
// compiled from Planning's case reports). Approved = green, pending = yellow.
let sbProjects = {};

async function loadProjects() {
  try {
    const resp = await fetch("data/projects.json");
    if (resp.ok) sbProjects = await resp.json();
  } catch (e) { /* optional dataset */ }
}

// On-market SFR/Land deals, keyed by AIN (data/listings.json, team-curated).
// $/SF of land is precomputed once here; a missing lot size leaves it null.
let omListings = {};

async function loadListings() {
  try {
    const resp = await fetch("data/listings.json");
    if (!resp.ok) return;
    omListings = await resp.json();
    for (const l of Object.values(omListings)) {
      l.ppsf = l.price > 0 && l.lotSqft > 0 ? Math.round(l.price / l.lotSqft) : null;
    }
  } catch (e) { /* optional dataset */ }
}

function applyProjectLayers() {
  const ains = Object.keys(sbProjects);
  if (!ains.length || !map.getLayer("parcels-projects")) return;
  const colorMatch = ["match", ["get", "ain"]];
  for (const [ain, pr] of Object.entries(sbProjects)) {
    colorMatch.push(ain, pr.status === "approved" ? "#10b981" : "#facc15");
  }
  colorMatch.push("#facc15");
  for (const id of lids("parcels-projects")) {
    map.setFilter(id, ["in", ["get", "ain"], ["literal", ains]]);
    map.setPaintProperty(id, "fill-color", colorMatch);
  }
}

async function boot() {
  initBrandLogo();
  await loadRemoteConfig();
  await Promise.all([loadProjects(), loadListings()]);
  const synthetic = await isSynthetic();
  demoMode = synthetic;
  if (synthetic) {
    document.getElementById("demo-banner").classList.remove("hidden");
    document.getElementById("sat-btn").style.display = "none";
    archive.getHeader().then((h) => {
      demoBounds = [[h.minLon, h.minLat], [h.maxLon, h.maxLat]];
    }).catch(() => {});
  }
  // Restore map position from a shared link's m= hash param.
  let startCenter = CONFIG.START_CENTER;
  let startZoom = CONFIG.START_ZOOM;
  const mParam = new URLSearchParams(location.hash.slice(1)).get("m");
  // A shared link's hash is consumed once, then dropped from the address bar.
  if (location.hash.length > 1) {
    history.replaceState(null, "", location.pathname + location.search);
  }
  if (mParam) {
    const [lng, lat, z] = mParam.split(",").map(Number);
    if ([lng, lat, z].every(Number.isFinite)) {
      startCenter = [lng, lat];
      startZoom = z;
    }
  }

  map = new maplibregl.Map({
    container: "map",
    style: synthetic ? demoStyle() : await buildStyle(),
    center: startCenter,
    zoom: startZoom,
    maxZoom: 20,
    attributionControl: { compact: true },
    transformRequest: mapboxTransform,
  });
  map.addControl(new maplibregl.NavigationControl(), "top-left");

  // Init on whichever fires first: 'load' normally, or 'styledata' when
  // unreachable basemap tile servers keep the map from ever reaching 'load'.
  let inited = false;
  function init() {
    if (inited) return;
    inited = true;
    // A shared #oz=1 link needs the tract data before the first filter pass.
    if (state.oz) {
      ensureOzLoaded().then(() => { syncControlsFromState(); applyFilters(); });
    }
    syncControlsFromState();
    applyFilters();
  }
  map.on("load", init);
  map.on("styledata", init);
  map.once("styledata", applyProjectLayers);
  for (const id of lids("parcels-projects")) {
    map.on("click", id, (e) => showDetail(e.features[0].properties, e.lngLat));
  }
  // Project markers exist below parcel zoom; a click zooms in and opens the
  // case using the projects.json record (tiles may not carry this parcel).
  map.on("click", "projects-markers", (e) => {
    const ain = e.features[0].properties.ain;
    const pr = sbProjects[ain] || {};
    map.easeTo({ center: e.lngLat, zoom: 15 });
    showDetail({ ain, a: pr.address || "", lsf: pr.lotSqft, t: pr.tier || "" }, e.lngLat);
  });
  // Listing markers open the deal even from the low-zoom dot view.
  map.on("click", "om-markers", (e) => {
    const ain = e.features[0].properties.ain;
    const l = omListings[ain] || {};
    map.easeTo({ center: e.lngLat, zoom: 15 });
    showDetail({ ain, a: l.address || "", lsf: l.lotSqft, t: l.tier || "" }, e.lngLat);
  });
  map.on("mouseenter", "om-markers", () => { map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", "om-markers", () => { map.getCanvas().style.cursor = ""; });

  map.on("idle", scheduleCount);
  map.on("moveend", scheduleCount);
  map.on("sourcedata", scheduleCount);

  for (const id of lids("parcels-fill")) {
    map.on("click", id, (e) => showDetail(e.features[0].properties, e.lngLat));
    map.on("mouseenter", id, () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", id, () => { map.getCanvas().style.cursor = ""; });
  }
  for (const id of lids("parcels-context")) {
    map.on("click", id, (e) => {
      // Fires under the universe layer too; only act when no universe parcel
      // was hit at this point (that handler already opened the panel).
      const hit = map.queryRenderedFeatures(e.point, { layers: lids("parcels-fill") });
      if (!hit.length) showDetail(e.features[0].properties, e.lngLat);
    });
  }
  for (const id of lids("centroids")) {
    map.on("click", id, (e) => {
      map.easeTo({ center: e.lngLat, zoom: 14 });
    });
  }

  // Fresh open (no shared-link position): fit the default approved-projects
  // view so every green case is on screen.
  if (!mParam && state.dealStatus === "approved") zoomToStatusResults();

  bindControls();
}
boot();
