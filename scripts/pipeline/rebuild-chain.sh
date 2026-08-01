#!/usr/bin/env bash
# Full rebuild after enrichment changes: enrich -> validate -> tile -> extract
# the seven <100MiB geographic chunks the app serves. Designed to run
# detached (nohup); progress and errors land in data/rebuild-excl.log.
set -euo pipefail
cd "$(dirname "$0")/../.."

PM="${PMTILES_BIN:-pmtiles}"

echo "=== enrich start $(date -u) ==="
python3 scripts/pipeline/02_enrich.py --keep-outside-city
echo "=== validate $(date -u) ==="
python3 scripts/pipeline/04_validate.py || echo "validate warned (non-fatal)"
echo "=== tiles start $(date -u) ==="
./scripts/pipeline/03_tiles.sh data/tiles/land-map-full.pmtiles
echo "=== extract start $(date -u) ==="
for spec in \
  "west:-118.68,33.95,-118.32,34.34" \
  "eastbasin-n:-118.32,34.10,-117.98,34.34" \
  "eastbasin-s:-118.32,33.95,-117.98,34.10" \
  "sgv:-117.98,33.95,-117.63,34.34" \
  "south:-118.75,33.25,-117.63,33.95" \
  "north:-118.90,34.34,-117.60,35.05" \
  "coast:-121.00,33.90,-118.60,35.15"; do
  name="${spec%%:*}"; bbox="${spec#*:}"
  rm -f "data/real/land-tiles-$name.pmtiles"  # extract refuses to overwrite
  "$PM" extract data/tiles/land-map-full.pmtiles \
    "data/real/land-tiles-$name.pmtiles" --bbox="$bbox" | tail -1
done
ls -l data/real/*.pmtiles | awk '{printf "%.1f MiB  %s\n", $5/1048576, $9}'
echo "=== CHAIN DONE $(date -u) ==="
