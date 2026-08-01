#!/usr/bin/env python3
"""Download source layers from ArcGIS REST FeatureServers into data/raw/*.ndjson.

Resumable: progress is tracked in a .state sidecar per source; re-running
continues where it left off. Run this OUTSIDE restricted networks (GIS hosts
are blocked in some sandboxes) — see scripts/pipeline/README.md.

Usage:
  python3 01_download.py                    # all sources, full extent
  python3 01_download.py --source parcels   # one source
  python3 01_download.py --subset venice    # bbox preset from sources.json
  python3 01_download.py --bbox -118.5,33.9,-118.3,34.1
"""
import argparse
import json
import os
import sys
import time

import requests

from common import load_sources, ensure_dirs, raw_path, OVERLAY_SOURCES

PAGE_SIZE = 2000
MAX_RETRIES = 5


def state_path(source_key):
    return raw_path(source_key) + ".state"


def load_state(source_key):
    try:
        with open(state_path(source_key)) as f:
            state = json.load(f)
        state.setdefault("bbox_i", 0)
        return state
    except (OSError, ValueError):
        return {"offset": 0, "done": False, "expected_count": None, "bbox_i": 0}


def save_state(source_key, state):
    with open(state_path(source_key), "w") as f:
        json.dump(state, f)


def request_json(url, params):
    """GET with retries/backoff. ArcGIS returns 200 with an 'error' body on failure."""
    delay = 2
    for attempt in range(MAX_RETRIES):
        try:
            r = requests.get(url, params=params, timeout=120)
            r.raise_for_status()
            body = r.json()
            if "error" in body:
                raise RuntimeError(f"ArcGIS error: {body['error']}")
            return body
        except Exception as e:
            if attempt == MAX_RETRIES - 1:
                raise
            print(f"    retry {attempt + 1}/{MAX_RETRIES} after error: {e}", file=sys.stderr)
            time.sleep(delay)
            delay *= 2
    raise RuntimeError("unreachable")


def geometry_params(bbox):
    if not bbox:
        return {}
    return {
        "geometry": ",".join(str(v) for v in bbox),
        "geometryType": "esriGeometryEnvelope",
        "inSR": "4326",
        "spatialRel": "esriSpatialRelIntersects",
    }


def get_count(url, where, bbox):
    params = {"where": where, "returnCountOnly": "true", "f": "json"}
    params.update(geometry_params(bbox))
    return request_json(f"{url}/query", params)["count"]


def download_geojson_url(key, cfg):
    """Single-file GeoJSON source (e.g. an opendata mirror of a blocked host)."""
    out = raw_path(key)
    state = load_state(key)
    if state.get("done"):
        print(f"  {key}: already complete, skipping")
        return
    print(f"  {key}: downloading GeoJSON from {cfg['download_url'][:80]}…")
    r = requests.get(cfg["download_url"], timeout=600)
    r.raise_for_status()
    body = r.json()
    feats = body.get("features", [])
    with open(out, "w") as fh:
        for feat in feats:
            fh.write(json.dumps(feat, separators=(",", ":")) + "\n")
    state.update({"done": True, "offset": len(feats), "total_written": len(feats)})
    save_state(key, state)
    print(f"  {key}: done, {len(feats)} features -> {out}")


def download_oid_paged(key, cfg):
    """OBJECTID-range paging: WHERE OBJECTID > last ORDER BY OBJECTID.
    Stays fast at any depth, unlike resultOffset which degrades badly past
    ~1M rows on hosted feature services. Used for large attributes-only
    pulls (cfg["oid_paging"]). Resumable via last_oid in the state file."""
    url = cfg["url"].rstrip("/")
    where = cfg.get("where", "1=1")
    out = raw_path(key)
    state = load_state(key)
    if state.get("done"):
        print(f"  {key}: already complete ({state.get('total_written', 0)} features), skipping")
        return

    if state.get("expected_count") is None:
        state["expected_count"] = get_count(url, where, None)
        save_state(key, state)

    out_fields = sorted(set(cfg.get("fields", {}).values()) | {"OBJECTID"})
    last_oid = state.get("last_oid", 0)
    total = state.get("total_written", 0)
    print(f"  {key}: {state['expected_count']} expected, OID paging from OBJECTID>{last_oid}")
    with open(out, "w" if total == 0 else "a") as fh:
        while True:
            params = {
                "where": f"({where}) AND OBJECTID > {last_oid}",
                "outFields": ",".join(out_fields),
                "f": "json",
                "returnGeometry": "false",
                "resultRecordCount": PAGE_SIZE,
                "orderByFields": "OBJECTID",
            }
            body = request_json(f"{url}/query", params)
            feats = body.get("features", [])
            if not feats:
                break
            for feat in feats:
                attrs = feat.get("attributes", {})
                fh.write(json.dumps({"type": "Feature", "geometry": None,
                                     "properties": attrs}, separators=(",", ":")) + "\n")
            last_oid = feats[-1]["attributes"]["OBJECTID"]
            total += len(feats)
            state.update({"last_oid": last_oid, "total_written": total, "offset": total})
            save_state(key, state)
            print(f"    {total}/{state['expected_count']}", end="\r", flush=True)
            if len(feats) < PAGE_SIZE:
                break
    print()
    state["done"] = True
    save_state(key, state)
    print(f"  {key}: done, {total} features -> {out}")


def download_source(key, cfg, bboxes, use_situs_where):
    """bboxes: list of bbox-or-None; each is paged fully in turn. Progress is
    resumable across both pages (offset) and boxes (bbox_i). Where boxes
    overlap, duplicate parcels are written — 02_enrich.py dedupes by AIN.
    cfg["attributes_only"]: skip geometry (f=json, returnGeometry=false) —
    features are written with null geometry."""
    if cfg.get("download_url"):
        download_geojson_url(key, cfg)
        return
    if cfg.get("oid_paging"):
        download_oid_paged(key, cfg)
        return

    url = cfg["url"].rstrip("/")
    where = cfg.get("where", "1=1")
    attrs_only = bool(cfg.get("attributes_only"))
    if key == "parcels" and use_situs_where and cfg.get("situs_city_where"):
        where = cfg["situs_city_where"]

    out = raw_path(key)
    state = load_state(key)
    if state.get("done"):
        print(f"  {key}: already complete ({state.get('total_written', state['offset'])} features), skipping")
        return

    out_fields = sorted(set(cfg.get("fields", {}).values())) or ["*"]
    # Layers differ in their ID field name (OBJECTID, FID, OBJECTID_1…);
    # ordering by the wrong one is a hard 400 on some services.
    oid_field = "OBJECTID"
    try:
        meta = request_json(url, {"f": "json"})
        oid_field = meta.get("objectIdField") or "OBJECTID"
    except Exception:
        pass
    fresh = state["bbox_i"] == 0 and state["offset"] == 0
    total_written = state.get("total_written", 0)
    with open(out, "w" if fresh else "a") as fh:
        for bbox_i in range(state["bbox_i"], len(bboxes)):
            bbox = bboxes[bbox_i]
            if bbox_i != state["bbox_i"]:
                state.update({"bbox_i": bbox_i, "offset": 0, "expected_count": None})
            if state["expected_count"] is None:
                state["expected_count"] = get_count(url, where, bbox)
                save_state(key, state)
            print(f"  {key} [box {bbox_i + 1}/{len(bboxes)}]: {state['expected_count']} features expected, "
                  f"resuming at offset {state['offset']}")
            while True:
                params = {
                    "where": where,
                    "outFields": ",".join(out_fields),
                    "f": "json" if attrs_only else "geojson",
                    "outSR": "4326",
                    "resultOffset": state["offset"],
                    "resultRecordCount": PAGE_SIZE,
                    "orderByFields": oid_field,
                }
                if attrs_only:
                    params["returnGeometry"] = "false"
                params.update(geometry_params(bbox))
                body = request_json(f"{url}/query", params)
                feats = body.get("features", [])
                for feat in feats:
                    if attrs_only:
                        feat = {"type": "Feature", "geometry": None,
                                "properties": feat.get("attributes", {})}
                    fh.write(json.dumps(feat, separators=(",", ":")) + "\n")
                state["offset"] += len(feats)
                total_written += len(feats)
                state["total_written"] = total_written
                save_state(key, state)
                print(f"    {state['offset']}/{state['expected_count']}", end="\r", flush=True)
                more = (body.get("properties", {}) or {}).get("exceededTransferLimit") \
                    or body.get("exceededTransferLimit") or len(feats) == PAGE_SIZE
                if not feats or not more:
                    break
            print()
    state["done"] = True
    save_state(key, state)
    print(f"  {key}: done, {total_written} features -> {out}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", help="download only this source key")
    ap.add_argument("--subset", help="bbox preset name from sources.json subsets")
    ap.add_argument("--bbox", help="minLon,minLat,maxLon,maxLat (WGS84)")
    ap.add_argument("--situs-where", action="store_true",
                    help="pre-filter parcels by situs city (faster download; spatial clip in 02 is still authoritative)")
    args = ap.parse_args()

    sources = load_sources()
    ensure_dirs()

    bboxes = [None]
    if args.subset:
        preset = sources["subsets"][args.subset]
        # A preset is one bbox [w,s,e,n] or a list of bboxes.
        bboxes = preset if isinstance(preset[0], list) else [preset]
    elif args.bbox:
        bboxes = [[float(v) for v in args.bbox.split(",")]]

    parcel_layers = sources.get("parcel_layers", ["parcels"])
    keys = [args.source] if args.source else parcel_layers + ["parcels_usecode"] + OVERLAY_SOURCES
    print(f"Downloading {keys} (boxes={bboxes})")
    for key in keys:
        cfg = sources.get(key)
        if not cfg:
            continue
        if not cfg.get("url") and not cfg.get("download_url"):
            print(f"  {key}: no URL configured in sources.json — fix it and re-run", file=sys.stderr)
            continue
        # Parcel-scoped sources follow the subset boxes. Overlays default to
        # full extent (so flags are right at bbox edges) unless the source
        # config pins its own bbox (statewide layers).
        if key in parcel_layers or key == "parcels_usecode":
            src_bboxes = bboxes
        elif cfg.get("bbox"):
            src_bboxes = [cfg["bbox"]]
        else:
            src_bboxes = [None]
        download_source(key, cfg, src_bboxes, args.situs_where)


if __name__ == "__main__":
    main()
