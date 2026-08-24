# On Market listings importer

Turns raw MLS CSV exports into screened, parcel-matched records in
`data/listings.json`, which is what the orange **On Market** pill on the map
reads.

```bash
python scripts/listings/import_listings.py --source "<folder with the MLS CSVs>"
```

Then review the audit CSV it writes next to the exports, and push:

```bash
git add data/listings.json && git commit -m "listings: import" && git push
```

## What it does per row

1. **Parse** every `.csv` under `--source` (its own audit files are skipped).
   The SFR sheets and the Land sheets have different columns; both are handled.
2. **Dedupe** by MLS number against the listings already in `data/listings.json`.
   Nothing is re-screened, so reruns are cheap.
3. **Geocode** the address with the Census geocoder (free, no key), cached in
   `.geocache.json`.
4. **Match a parcel** against the LA / Ventura / Santa Barbara county assessor
   layers, in three tiers, most trustworthy first:
   - point-in-polygon on the geocoded point;
   - a situs-address lookup near the point, requiring the house number and
     street to agree;
   - the genuinely nearest parcel centroid within 120 m, recorded in the audit
     as `nearest-NNm` so it can be spot-checked. Vacant land often carries no
     situs address at all, which is why this tier exists.
5. **Screen** it (below).
6. **Merge**. Additive only: an existing record is never overwritten or removed,
   so listings that go off market stay until pulled by hand.

## The screen

Standing rules (Filip, 2026-08-04):

- no parcels carrying existing 2+ unit improvements (assessor use code 02xx-05xx)
- no unit-number listings
- SFR under $20/SF of land is held out as a suspected mobile home; import them
  anyway with `--include-suspect`

Plus, matching `sb1123_eligible()` in `scripts/pipeline/02_enrich.py`:

- High or Very High fire hazard, the coastal zone and hillside all disqualify
- publicly and institutionally owned parcels are dropped
- inside LA City, zoning must be a single-family or multifamily family, and sets
  the lot cap (1.5 ac SB 1123 / 5 ac SB 684); outside LA City there is no zoning
  layer, so the flat 1.5 ac cap applies
- a parcel more than 3x the MLS lot size is a shared parcel (condo trap)

Overlays are tested at the **parcel centroid**, not the geocode. Census
geocodes land in the street, where there is no zoning polygon at all, which
reads back as "not residentially zoned" for perfectly good lots.

## Options

| flag | effect |
|---|---|
| `--since YYYY-MM-DD` | only import listings that came on market on or after this date |
| `--include-suspect` | import the sub-$20/SF SFR rows instead of holding them out |
| `--dry-run` | screen and report, write nothing but the audit |
| `--workers N` | concurrent screeners, default 6 |

`--since` uses a `List Date` / `On Market Date` column when the export has one,
and otherwise derives the date from `DOM`. Adding the list date column to the
MLS export makes it exact.

## Accuracy

Re-deriving the curated August set from the same CSVs:

| set | AIN matches curated | screen agrees |
|---|---|---|
| LA (223 records) | 210 | 218 |
| Ventura / Santa Barbara (247 records) | 201 | 230 |

Most differences are an adjacent parcel on vacant land with no situs address.
Every one is labelled in the audit CSV by how it was matched, so
`nearest-NNm` rows are the ones worth a look.
