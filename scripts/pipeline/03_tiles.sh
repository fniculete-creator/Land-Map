#!/usr/bin/env bash
# Tile enriched parcels into a single PMTiles archive with two layers:
#   parcels   — polygons, z13–15 (client overzooms above 15)
#   centroids — points,   z8–12  (citywide dot view, colored by eligibility)
#
# Usage: ./03_tiles.sh [output.pmtiles]   (default data/tiles/land-map.pmtiles)
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$(dirname "$DIR")")"
ENRICHED="$REPO/data/enriched"
OUT="${1:-$REPO/data/tiles/land-map.pmtiles}"

command -v tippecanoe >/dev/null || {
  echo "tippecanoe not found. Install: sudo apt-get install -y tippecanoe" >&2
  echo "or build from source: git clone https://github.com/felt/tippecanoe && cd tippecanoe && make -j && sudo make install" >&2
  exit 1
}

[ -s "$ENRICHED/parcels.ndjson" ] || { echo "missing $ENRICHED/parcels.ndjson — run 02_enrich.py first" >&2; exit 1; }

mkdir -p "$(dirname "$OUT")"

# Attach synthetic watermark from stats.json to the tileset metadata if present.
SYNTHETIC=$(python3 -c "
import json,sys
try:
    print('true' if json.load(open('$ENRICHED/stats.json')).get('synthetic') else 'false')
except Exception:
    print('false')
")

# Fixture builds include a synthetic street grid so the demo reads as a map.
STREETS_LAYER=()
if [ -s "$REPO/data/raw/streets.ndjson" ]; then
  STREETS_LAYER=(-L "streets:$REPO/data/raw/streets.ndjson")
fi

tippecanoe -o "$OUT" --force --quiet \
  -L parcels:"$ENRICHED/parcels.ndjson" \
  -L centroids:"$ENRICHED/centroids.ndjson" \
  "${STREETS_LAYER[@]}" \
  --minimum-zoom=8 --maximum-zoom=15 \
  -j '{"parcels":["any",[">=","$zoom",13]],"centroids":["any",["<=","$zoom",12]]}' \
  --coalesce-densest-as-needed \
  --detect-shared-borders \
  --simplify-only-low-zooms \
  --maximum-tile-bytes=500000 \
  --attribution 'LA County Assessor / LA City GeoHub' \
  --name "Land-Map LA parcels" \
  --description "synthetic=$SYNTHETIC"

ls -lh "$OUT"
echo "tiles: wrote $OUT (synthetic=$SYNTHETIC)"
