// Filter state -> MapLibre filter expressions.
// State shape:
//   ranges: { w: [min,max|null], lsf: [...], u: [...] }   (null = unbounded)
//   zoneFamilies: Set of 0/1/2 (empty = all)
//   zoneClasses: array of exact zone-class strings (overrides families if set)
//   tri: { v } "any" | "only" | "exclude"  (vacancy; fire/coastal/hillside
//   are hard exclusions inside the eligibility flag, not filters)
export function emptyState() {
  return {
    ranges: { w: [null, null], lsf: [null, null], u: [null, null] },
    zoneFamilies: new Set(),
    zoneClasses: [],
    tiers: new Set(),
    tri: { v: "any" },
  };
}

export function sb1123State(cfg) {
  // The 'e' attribute already encodes vacant + fire/coastal/hillside
  // exclusions + zone-family acreage caps, computed in the pipeline.
  const s = emptyState();
  s.sbPreset = true;
  return s;
}

export function buildFilter(state, cfg) {
  const clauses = ["all"];

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

  for (const [key, mode] of Object.entries(state.tri)) {
    if (mode === "any") continue;
    clauses.push(["==", ["get", key], mode === "only" ? 1 : 0]);
  }

  if (state.sbPreset) {
    clauses.push(["==", ["get", "e"], 1]);
  }

  return clauses.length > 1 ? clauses : null;
}

// Centroids only carry ain/e/v/lsf, so give them a reduced filter that never
// references missing attributes (missing -> expression false -> all dots vanish).
export function buildCentroidFilter(state, cfg) {
  const clauses = ["all"];
  const [lmin, lmax] = state.ranges.lsf;
  if (lmin !== null) clauses.push([">=", ["get", "lsf"], lmin]);
  if (lmax !== null) clauses.push(["<=", ["get", "lsf"], lmax]);
  if (state.tri.v !== "any") clauses.push(["==", ["get", "v"], state.tri.v === "only" ? 1 : 0]);
  if (state.tiers.size > 0) clauses.push(["in", ["get", "t"], ["literal", [...state.tiers]]]);
  if (state.sbPreset) clauses.push(["==", ["get", "e"], 1]);
  return clauses.length > 1 ? clauses : null;
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
  for (const [key, mode] of Object.entries(state.tri)) {
    if (mode !== "any") p.set(key, mode === "only" ? "1" : "0");
  }
  if (state.sbPreset) p.set("sb", "1");
  const s = p.toString();
  return s ? "#" + s : "";
}

export function stateFromHash(hash) {
  const state = emptyState();
  if (!hash || hash.length < 2) return state;
  const p = new URLSearchParams(hash.slice(1));
  for (const key of ["w", "lsf", "u"]) {
    const v = p.get(key);
    if (v && v.includes("..")) {
      const [a, b] = v.split("..");
      state.ranges[key] = [a === "" ? null : +a, b === "" ? null : +b];
    }
  }
  if (p.get("zc")) state.zoneClasses = p.get("zc").split(",").filter(Boolean);
  else if (p.get("zf")) state.zoneFamilies = new Set(p.get("zf").split(",").map(Number));
  if (p.get("t")) state.tiers = new Set(p.get("t").split(",").filter(Boolean));
  for (const key of ["v"]) {
    const v = p.get(key);
    if (v === "1") state.tri[key] = "only";
    else if (v === "0") state.tri[key] = "exclude";
  }
  if (p.get("sb") === "1") state.sbPreset = true;
  return state;
}
