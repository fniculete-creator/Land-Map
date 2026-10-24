// Filter state -> MapLibre filter expressions.
// State shape:
//   ranges: { w: [min,max|null], lsf: [...] }        (null = unbounded)
//   zoneFamilies: Set of 0/1/2 (empty = all)
//   zoneClasses: array of exact zone-class strings (overrides families if set)
//   tiers: Set of "A"/"B"/"C" (empty = all)
//   imp: "any" | "vacant" | "sfr"                    (improvements on the lot)
//   dealStatus: "any" | "submitted" | "approved" | "completed" | "forsale"
//     (team-assigned statuses; the matching AIN list is passed to buildFilter)
//   om: true = On Market mode — only parcels with a live listing
//     (data/listings.json; the matching AIN list is passed to buildFilter)
//   omRange: [min,max|null] $/SF of land (list price ÷ lot sf)
export function emptyState() {
  return {
    ranges: { w: [null, null], lsf: [null, null] },
    zoneFamilies: new Set(),
    zoneClasses: [],
    tiers: new Set(),
    imp: "any",
    dealStatus: "any",
    om: false,
    omRange: [null, null],
    sold: false,  // Sold: vacant lots with a closed sale since 01/01/2024 (data/sold_land.json)
    oz: false,   // Opportunity Zone 2.0: only parcels in a Recommended tract
    ovl: new Set(),  // other overlays (Overlay dropdown): "oz" 2018 OZ, "hr" High Resource, "qct" QCT/DDA
    // Program (one at a time): SB 1123 parcels by default; slo / comps switch views.
    slo: false,  // Small Lot Ordinance cases view (data/slo.json)
    sloStatus: "any",   // "any" | "built" | "not built"
    comps: false,       // sale comps view (data/comps_small_lot.json)
    comp: { since: 2025, first: false, p: [null, null], ppsf: [null, null], sf: [null, null] },
    areas: [],   // selected search areas (NEIGHBORHOODS names) — chips
  };
}

// Overlay areas as one MultiPolygon each (set by app.js once a layer's file
// loads; absent until then, so its clause degrades to a no-op). Keys: oz2
// (Recommended OZ 2.0 tracts), oz, hr, qct.
const OVERLAY_GEOMS = {};
export function setOverlayGeometry(key, geom) {
  OVERLAY_GEOMS[key] = geom;
}
export function activeOverlays(state) {
  return [...(state.oz ? ["oz2"] : []), ...(state.ovl ? [...state.ovl] : [])];
}

export function sb1123State(cfg) {
  // The 'e' attribute already encodes vacant + fire/coastal/hillside
  // exclusions + zone-family acreage caps, computed in the pipeline.
  const s = emptyState();
  s.sbPreset = true;
  return s;
}

// SFR home = single-family use code (010x) with a structure on it.
// The 4th character distinguishes true SFRs (digits) from condo/PUD unit
// records (letters), which each carry the whole lot's polygon and would
// otherwise flood the results with duplicate "big lots".
const SFR_CLAUSE = ["all",
  ["==", ["get", "v"], 0],
  ["==", ["slice", ["get", "uc"], 0, 3], "010"],
  ["!", ["in", ["slice", ["get", "uc"], 3, 4],
    ["literal", ["C", "D", "E", "F", "G", "H", "I", "J"]]]],
];

// Hard exclusions: parcels in a fire hazard zone (f 1/2), the coastal
// commission zone (c 1), or publicly/institutionally owned (pb 1 — city,
// county, schools, churches, non-profits) are not buildable/acquirable
// opportunities and never load as matches, regardless of filters. Absent
// attributes pass, so older tiles degrade gracefully.
const EXCLUSIONS_CLAUSE = ["all",
  ["!", ["in", ["get", "f"], ["literal", [1, 2]]]],
  ["!=", ["get", "c"], 1],
  ["!=", ["get", "pb"], 1],
];

// The working universe: SFR homes + vacant lots, minus the hard exclusions.
// Everything the team hunts starts from this set; filters narrow it. Other
// parcels (commercial, condos, apartments…) render only as faint context.
// Lots over 1.5 ac (the SB 1123 cap) are out per Filip (2026-08-10) — a tied
// double-lot assemblage is a curated exception, tracked via the Status
// overlay (which bypasses this clause), never auto-matched. The cap also
// drops park/conservancy mega-parcels whose tile records predate the fire
// attributes and would otherwise read as giant vacant lots.
export const UNIVERSE_CLAUSE = ["all",
  ["any", SFR_CLAUSE, ["==", ["get", "v"], 1]],
  ["<=", ["get", "lsf"], 65340],
  EXCLUSIONS_CLAUSE,
];

export function buildFilter(state, cfg, statusAins, omAins, soldAins) {
  // A status search is a pipeline view: it must surface those parcels even
  // when they fall outside the SFR+vacant universe (e.g. an approved project
  // already under construction), so the universe clause is dropped. On Market
  // drops it too — a listed deal in a fire zone must stay visible (its
  // badges explain the exclusion) rather than silently vanish.
  const clauses = state.dealStatus === "any" && !state.om
    ? ["all", UNIVERSE_CLAUSE] : ["all"];

  for (const [key, [min, max]] of Object.entries(state.ranges)) {
    if (min !== null) clauses.push([">=", ["get", key], min]);
    if (max !== null) clauses.push(["<=", ["get", key], max]);
  }

  if (state.zoneClasses.length > 0) {
    clauses.push(["in", ["get", "zc"], ["literal", state.zoneClasses]]);
  } else if (state.zoneFamilies.size > 0) {
    clauses.push(["in", ["get", "zf"], ["literal", [...state.zoneFamilies]]]);
  }

  if (state.tiers.size > 0) {
    clauses.push(["in", ["get", "t"], ["literal", [...state.tiers]]]);
  }


  if (state.imp === "vacant") clauses.push(["==", ["get", "v"], 1]);
  else if (state.imp === "sfr") clauses.push(SFR_CLAUSE);

  if (state.dealStatus !== "any") {
    clauses.push(["in", ["get", "ain"], ["literal", statusAins || []]]);
  }

  // On Market: only parcels with a listing whose $/SF passes the range
  // (the AIN list arrives pre-filtered by ppsf — tiles carry no prices).
  if (state.om) {
    clauses.push(["in", ["get", "ain"], ["literal", omAins || []]]);
  }

  // Sold: only parcels with a closed sale (AIN list from data/sold_land.json).
  if (state.sold) {
    clauses.push(["in", ["get", "ain"], ["literal", soldAins || []]]);
  }

  if (state.sbPreset && state.dealStatus === "any") {
    clauses.push(["==", ["get", "e"], 1]);
  }

  return clauses;
}

// Selected search areas as a MultiPolygon of their boxes (for the map's
// "within" expression and for JS point-in-box checks).
export function areaBoxes(state, cfg) {
  if (!state.areas || !state.areas.length) return [];
  return state.areas
    .map((name) => (cfg.NEIGHBORHOODS || {})[name])
    .filter(Boolean);
}

// Centroids now carry the full filterable attribute set (zc/zf/uc/w/…), so
// the dot view honors exactly the same filters as the polygon view. Area
// chips apply here via "within" (points only — the style spec doesn't
// support "within" for polygon features; the polygon-view list is scoped
// in JS instead).
export function buildCentroidFilter(state, cfg, statusAins, omAins, soldAins) {
  const clauses = buildFilter(state, cfg, statusAins, omAins, soldAins);
  const boxes = areaBoxes(state, cfg);
  if (boxes.length) {
    clauses.push(["within", {
      type: "MultiPolygon",
      coordinates: boxes.map(([w, s, e, n]) => [[[w, s], [e, s], [e, n], [w, n], [w, s]]]),
    }]);
  }
  // Checked overlays stack: a parcel must sit inside every one.
  for (const k of activeOverlays(state)) {
    if (OVERLAY_GEOMS[k]) clauses.push(["within", OVERLAY_GEOMS[k]]);
  }
  return clauses;
}

// ---- URL-hash (de)serialization for shareable filter links ----
export function stateToHash(state) {
  const p = new URLSearchParams();
  for (const [key, [min, max]] of Object.entries(state.ranges)) {
    if (min !== null || max !== null) p.set(key, `${min ?? ""}..${max ?? ""}`);
  }
  if (state.zoneClasses.length) p.set("zc", state.zoneClasses.join(","));
  else if (state.zoneFamilies.size) p.set("zf", [...state.zoneFamilies].join(","));
  if (state.tiers.size) p.set("t", [...state.tiers].join(","));
  if (state.imp !== "any") p.set("imp", state.imp);
  if (state.dealStatus !== "any") p.set("ds", state.dealStatus);
  if (state.om) {
    p.set("om", "1");
    const [min, max] = state.omRange;
    if (min !== null || max !== null) p.set("ppsf", `${min ?? ""}..${max ?? ""}`);
  }
  if (state.sold) p.set("sd", "1");
  if (state.sbPreset) p.set("sb", "1");
  if (state.oz) p.set("oz", "1");
  if (state.ovl && state.ovl.size) p.set("ov", [...state.ovl].join(","));
  if (state.slo) p.set("slo", "1");
  if (state.slo && state.sloStatus !== "any") p.set("sls", state.sloStatus);
  if (state.comps) {
    const c = state.comp;
    p.set("comps", "1");
    if (c.since !== 2025) p.set("cy", String(c.since));
    if (c.first) p.set("cn", "1");
    for (const k of ["p", "ppsf", "sf"]) {
      if (c[k][0] !== null || c[k][1] !== null) p.set("c" + k, `${c[k][0] ?? ""}..${c[k][1] ?? ""}`);
    }
  }
  if (state.areas && state.areas.length) p.set("a", state.areas.join("|"));
  const s = p.toString();
  return s ? "#" + s : "";
}

export function stateFromHash(hash) {
  const state = emptyState();
  if (!hash || hash.length < 2) return state;
  const p = new URLSearchParams(hash.slice(1));
  for (const key of ["w", "lsf"]) {
    const v = p.get(key);
    if (v && v.includes("..")) {
      const [a, b] = v.split("..");
      state.ranges[key] = [a === "" ? null : +a, b === "" ? null : +b];
    }
  }
  if (p.get("zc")) state.zoneClasses = p.get("zc").split(",").filter(Boolean);
  else if (p.get("zf")) state.zoneFamilies = new Set(p.get("zf").split(",").map(Number));
  if (p.get("t")) state.tiers = new Set(p.get("t").split(",").filter(Boolean));
  if (["vacant", "sfr"].includes(p.get("imp"))) state.imp = p.get("imp");
  if (["submitted", "approved", "completed", "forsale"].includes(p.get("ds"))) {
    state.dealStatus = p.get("ds");
  }
  if (p.get("om") === "1") {
    state.om = true;
    const v = p.get("ppsf");
    if (v && v.includes("..")) {
      const [a, b] = v.split("..");
      state.omRange = [a === "" ? null : +a, b === "" ? null : +b];
    }
  }
  if (p.get("sd") === "1" && !state.om) state.sold = true;
  if (p.get("sb") === "1") state.sbPreset = true;
  if (p.get("oz") === "1") state.oz = true;
  if (p.get("ov")) state.ovl = new Set(p.get("ov").split(",").filter((k) => ["oz", "hr", "qct"].includes(k)));
  if (p.get("slo") === "1") state.slo = true;
  if (["built", "not built"].includes(p.get("sls"))) state.sloStatus = p.get("sls");
  if (p.get("comps") === "1") {
    state.comps = true;
    state.slo = false;
    if (p.get("cy") && Number.isFinite(+p.get("cy"))) state.comp.since = +p.get("cy");
    if (p.get("cn") === "1") state.comp.first = true;
    for (const k of ["p", "ppsf", "sf"]) {
      const v = p.get("c" + k);
      if (v && v.includes("..")) {
        const [a, b] = v.split("..");
        state.comp[k] = [a === "" ? null : +a, b === "" ? null : +b];
      }
    }
  }
  if (p.get("a")) state.areas = p.get("a").split("|").filter(Boolean);
  return state;
}
