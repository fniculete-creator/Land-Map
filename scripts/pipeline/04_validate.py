#!/usr/bin/env python3
"""Validate the enriched dataset before publishing tiles.

Checks counts against the download state (full runs) or fixture meta, sanity
of distributions, and prints sample AINs with assessor/ZIMAS URLs for manual
spot-checking. Exits nonzero on hard failures so it can gate deployment.
"""
import json
import os
import random
import sys

from common import raw_path, read_ndjson, ENRICHED_DIR

HARD_FAIL_COUNT_MISMATCH = 0.005  # 0.5%
HARD_FAIL_INVALID_GEOM = 0.01     # 1%


def main():
    failures = []
    warnings = []

    stats_file = os.path.join(ENRICHED_DIR, "stats.json")
    if not os.path.exists(stats_file):
        print("missing stats.json — run 02_enrich.py first", file=sys.stderr)
        sys.exit(1)
    with open(stats_file) as f:
        stats = json.load(f)

    total = stats["total_read"]
    written = stats["written"]
    print(f"read {total}, wrote {written} "
          f"(outside city: {stats['outside_city']}, invalid geom: {stats['invalid_geometry']})")

    # Expected-count check: download .state (real runs) or fixture .meta.
    expected = None
    state_file = raw_path("parcels") + ".state"
    meta_file = raw_path("parcels") + ".meta"
    if os.path.exists(state_file):
        with open(state_file) as f:
            expected = json.load(f).get("expected_count")
    elif os.path.exists(meta_file):
        with open(meta_file) as f:
            expected = json.load(f).get("count")
    if expected:
        drift = abs(total - expected) / expected
        print(f"expected {expected} raw parcels, read {total} (drift {drift:.2%})")
        if drift > HARD_FAIL_COUNT_MISMATCH:
            failures.append(f"raw count drift {drift:.2%} > {HARD_FAIL_COUNT_MISMATCH:.1%}")

    if total and stats["invalid_geometry"] / total > HARD_FAIL_INVALID_GEOM:
        failures.append(f"invalid geometry rate {stats['invalid_geometry'] / total:.2%} > {HARD_FAIL_INVALID_GEOM:.0%}")

    # Distribution sanity.
    def pct(k):
        return 100.0 * stats[k] / written if written else 0.0

    print(f"vacant {pct('vacant'):.1f}% | eligible {pct('eligible'):.1f}% | "
          f"fire High {pct('fire1'):.1f}% / VH {pct('fire2'):.1f}% | "
          f"coastal {pct('coastal'):.1f}% | hillside {pct('hillside'):.1f}% | "
          f"no zone {pct('no_zone'):.1f}%")
    med = stats.get("sf_width_median")
    print(f"median SF-zone lot width: {med} ft")
    if med is not None and not (25 <= med <= 80):
        warnings.append(f"median SF lot width {med} ft outside expected 25-80 ft range")
    if pct("no_zone") > 10:
        warnings.append(f"{pct('no_zone'):.1f}% of parcels have no zoning — check the zoning layer / URL")
    if stats["eligible"] == 0:
        warnings.append("0 SB 1123-eligible parcels — check vacancy config and zone parsing")

    # Sample spot-checks.
    enriched = os.path.join(ENRICHED_DIR, "parcels.ndjson")
    rng = random.Random(7)
    sample = []
    for i, feat in enumerate(read_ndjson(enriched)):
        if len(sample) < 5:
            sample.append(feat)
        elif rng.random() < 5.0 / (i + 1):
            sample[rng.randrange(5)] = feat
    print("\nspot-check these against the assessor portal / ZIMAS:")
    for feat in sample:
        p = feat["properties"]
        print(f"  AIN {p['ain']}: zone={p['z'] or '?'} lot={p['lsf']}sqft w={p['w']}ft "
              f"units={p['u']} vacant={p['v']} fire={p['f']} coastal={p['c']} hillside={p['h']} sb1123={p['e']}")
        print(f"    https://portal.assessor.lacounty.gov/parceldetail/{p['ain']}")

    for w in warnings:
        print(f"WARNING: {w}")
    for f_ in failures:
        print(f"FAILURE: {f_}", file=sys.stderr)
    if stats.get("synthetic"):
        print("\nNOTE: this dataset is SYNTHETIC fixture data (demo/testing only).")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
