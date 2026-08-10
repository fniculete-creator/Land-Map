"""Shared helpers for the Land-Map data pipeline."""
import json
import os

PIPELINE_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_DIR = os.path.dirname(os.path.dirname(PIPELINE_DIR))
DATA_DIR = os.path.join(REPO_DIR, "data")
RAW_DIR = os.path.join(DATA_DIR, "raw")
ENRICHED_DIR = os.path.join(DATA_DIR, "enriched")
TILES_DIR = os.path.join(DATA_DIR, "tiles")

OVERLAY_SOURCES = ["city_boundary", "zoning", "hillside", "coastal", "vhfhsz", "vhfhsz_sra"]


def load_sources():
    with open(os.path.join(PIPELINE_DIR, "sources.json")) as f:
        return json.load(f)


def ensure_dirs():
    for d in (RAW_DIR, ENRICHED_DIR, TILES_DIR):
        os.makedirs(d, exist_ok=True)


def raw_path(source_key):
    return os.path.join(RAW_DIR, source_key + ".ndjson")


def read_ndjson(path):
    """Yield GeoJSON features from an NDJSON file, one per line."""
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                yield json.loads(line)


def write_feature(fh, feature):
    fh.write(json.dumps(feature, separators=(",", ":")) + "\n")
