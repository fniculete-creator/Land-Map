// Filter state -> MapLibre filter expressions.
// State shape:
//   ranges: { w: [min,max|null], lsf: [...] }        (null = unbounded)
//   zoneFamilies: Set of 0/1/2 (empty = all)
//   zoneClasses: array of exact zone-class strings (overrides families if set)
//   tiers: Set of "A"/"B"/"C" (empty = all)
//   imp: "any" | "vacant" | "sfr"                    (improvements on the lot)
//   dealStatus: "any" | "submitted" | "approved" | "completed" | "forsale"
//     (team-assigned statuses; the matching AIN list is passed to buildFilter)
export function emptyState() {
  return {
    ranges: { w: [null, null], lsf: [null, null] },
    zoneFamilies: new Set(),
    zoneClasses: [],
    tiers: new Set(),
    imp: "any",
    dealStatus: "any",
  };
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

// The working universe: SFR homes + vacant lots. Everything the team hunts
// starts from this set; filters narrow it. Other parcels (commercial,
// condos, apartments…) render only as faint context.
export const UNIVERSE_CLAUSE = ["any", SFR_CLAUSE, ["==", ["get", "v"], 1]];

export function buildFilter(state, cfg, statusAins) {
  // A status search is a pipeline view: it must surface those parcels even
  // when they fall outside the SFR+vacant universe (e.g. an approved project
  // already under construction), so the universe clause is dropped.
  const clauses = state.dealStatus === "any" ? ["all", UNIVERSE_CLAUSE] : ["all"];

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

  if (state.sbPreset && state.dealStatus === "any") {
    clauses.push(["==", ["get", "e"], 1]);
  }

  return clauses;
}

// Centroids now carry the full filterable attribute set (zc/zf/uc/w/…), so
// the dot view honors exactly the same filters as the polygon view.
export function buildCentroidFilter(state, cfg, statusAins) {
  return buildFilter(state, cfg, statusAins);
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
  if (state.sbPreset) p.set("sb", "1");
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
  if (p.get("sb") === "1") state.sbPreset = true;
  return state;
}
