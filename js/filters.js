// Filter state -> MapLibre filter expressions.
// State shape:
//   ranges: { w: [min,max|null], lsf: [...], u: [...] }   (null = unbounded)
//   zoneFamilies: Set of 0/1/2 (empty = all)
//   zoneClasses: array of exact zone-class strings (overrides families if set)
//   tri: { v, f, c, h } each "any" | "only" | "exclude"
export function emptyState() {
  return {
    ranges: { w: [null, null], lsf: [null, null], u: [null, null] },
    zoneFamilies: new Set(),
    zoneClasses: [],
    tri: { v: "any", f: "any", c: "any", h: "any" },
  };
}

export function sb1123State(cfg) {
  const s = emptyState();
  s.tri.v = "only";
  s.tri.f = "exclude";
  // Zone-family-aware acreage caps live in buildFilter's special-case below.
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

  for (const [key, mode] of Object.entries(state.tri)) {
    if (mode === "any") continue;
    if (key === "f") {
      // fire is 0/1/2: "only" = in a hazard zone, "exclude" = outside both.
      clauses.push(mode === "only" ? [">=", ["get", "f"], 1] : ["==", ["get", "f"], 0]);
    } else {
      clauses.push(["==", ["get", key], mode === "only" ? 1 : 0]);
    }
  }

  if (state.sbPreset) {
    clauses.push([
      "any",
      ["all", ["==", ["get", "zf"], 1], ["<=", ["get", "lsf"], cfg.SB_SF_MAX_SQFT]],
      ["all", ["==", ["get", "zf"], 2], ["<=", ["get", "lsf"], cfg.SB_MF_MAX_SQFT]],
    ]);
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
  for (const key of ["v", "f", "c", "h"]) {
    const v = p.get(key);
    if (v === "1") state.tri[key] = "only";
    else if (v === "0") state.tri[key] = "exclude";
  }
  if (p.get("sb") === "1") state.sbPreset = true;
  return state;
}
