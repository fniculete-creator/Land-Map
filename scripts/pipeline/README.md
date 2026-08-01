# Land-Map data pipeline

Turns LA County/City open GIS data into the single `land-map.pmtiles` file the
app reads. Five scripts, run in order; every source URL, field name, and
threshold lives in `sources.json` so schema drift never requires code changes.

```
00_fixture.py   synthetic demo data (no network needed)     ─┐
01_download.py  real data from ArcGIS FeatureServers        ─┴─> data/raw/*.ndjson
02_enrich.py    flags + computed width -> data/enriched/*.ndjson
03_tiles.sh     tippecanoe -> data/tiles/land-map.pmtiles
04_validate.py  sanity checks + spot-check URLs (gates publishing)
serve.py        dev server with the Range support PMTiles needs
```

## Prerequisites

```bash
pip3 install -r requirements.txt      # shapely>=2, pyproj, requests
sudo apt-get install -y tippecanoe    # Ubuntu 24.04+ has v2.17+, which writes PMTiles directly
# or: git clone https://github.com/felt/tippecanoe && cd tippecanoe && make -j && sudo make install
```

> **Network note:** the GIS hosts (geohub.lacity.org, `services*.arcgis.com`,
> LA County eGIS) are blocked from some sandboxed/CI environments. Run
> `01_download.py` from a normal machine; steps 02–04 run anywhere.

## Step 0 — verify source URLs (one-time, ~10 minutes)

The FeatureServer URLs in `sources.json` are best-guess and **must be verified
once** — ArcGIS Hub item URLs change and can't be confirmed from inside a
sandbox. For each entry:

1. Search the dataset name (given in each entry's `"name"`) on
   [geohub.lacity.org](https://geohub.lacity.org) or
   [egis-lacounty.hub.arcgis.com](https://egis-lacounty.hub.arcgis.com).
2. On the dataset page choose **I want to use this → View API Resources** and
   copy the URL ending in `/FeatureServer/0` (or `/MapServer/N`).
3. Paste it into the entry's `"url"`.
4. Open `<url>?f=json` in a browser and confirm the field names in `"fields"`
   exist (fix the right-hand values if the source schema differs).

Datasets to find:

| key | dataset | critical fields |
|---|---|---|
| `parcels` | LA County **Assessor Parcels** (county-wide, ~2.4M) | AIN, UseCode, UseType, Units, Roll_ImpValue |
| `city_boundary` | LA **City Boundary** | (geometry only) |
| `zoning` | LA City **Zoning** | ZONE_CMPLT |
| `hillside` | **Hillside** Ordinance area | (geometry only) |
| `coastal` | **Coastal Zone** | (geometry only) |
| `vhfhsz` | **Fire Hazard Severity Zones** (city or CAL FIRE FRAP) | hazard class field + update `hazard_class_map` |

## Step 1 — download

```bash
python3 01_download.py --subset venice          # quick first run (~minutes)
python3 01_download.py --subset target_region   # W/S Valley + Westside (see below)
python3 01_download.py                          # full county parcels (~1–2 h, ~3–5 GB)
```

**`target_region`** is the recommended starting preset: three boxes covering
the west & south San Fernando Valley (West Hills, Woodland Hills, Tarzana,
Encino, Sherman Oaks, Studio City), the central Valley (Canoga Park,
Chatsworth, Granada Hills, North Hills, Panorama City, Sylmar, Pacoima,
Reseda, Northridge, Van Nuys, North Hollywood), and the Westside (Santa
Monica, Venice, Mar Vista, Palms, Westwood, Brentwood, Century City, West
Hollywood/Fairfax, east to Mid-City). Roughly 300–400k parcels — expect
~45–60 minutes. Multi-box presets download sequentially and are resumable
across boxes; overlapping-box duplicates are deduped by AIN in step 2.

> The Westside box includes **Santa Monica, West Hollywood, Beverly Hills,
> and Culver City — separate cities outside LA City zoning**. To keep their
> parcels (size/width/vacancy filters still work; zoning-based filters won't
> match them), run step 2 with `--keep-outside-city`. Omit the flag to clip
> strictly to LA City.

- Resumable: re-running continues from the last saved offset (`.state` files
  in `data/raw/`). Delete the `.ndjson` + `.state` pair to restart a source.
- `--situs-where` pre-filters parcels to LA-City situs addresses to cut the
  download ~3×. The spatial clip against the city boundary in step 2 is still
  what decides membership (situs city is unreliable, especially on vacant
  land — exactly the parcels this tool targets).
- Overlays always download at full extent (they're small).

## Step 2 — enrich

```bash
python3 02_enrich.py                     # clip to LA City boundary
python3 02_enrich.py --keep-outside-city # keep Santa Monica / WeHo / etc. too
```

Streams parcels one at a time (constant memory), and per parcel:

- clips to the city boundary (representative-point test),
- assigns zoning / hillside / coastal / fire-severity flags by point-in-polygon
  against STRtree indexes,
- computes **lot width** = short side of the minimum rotated rectangle in
  EPSG:2229 feet (approximates frontage; irregular and flag lots need manual
  verification),
- derives **vacant** (use code list in `sources.json`, or 0 units + improvements
  < `improvement_value_max`),
- derives **sb1123_eligible** = vacant ∧ no High/VH fire ∧ (SF-zone ≤ 1.5 ac ∨
  MF-zone ≤ 5 ac). Coastal/hillside flag as warnings instead of disqualifying.

Outputs `parcels.ndjson` + `centroids.ndjson` (short-key tile schema: `ain z zc
zf uc u lsf w iv v f c h e`) and `stats.json`.

## Steps 3–4 — tile and validate

```bash
./03_tiles.sh                 # -> data/tiles/land-map.pmtiles
python3 04_validate.py        # nonzero exit on hard failures
```

Tiling strategy: parcel polygons at z13–15 (the app overzooms above 15),
centroid dots at z8–12 for the citywide view. Validation compares counts
against the server's `returnCountOnly`, checks distribution sanity (median SF
lot width, % vacant, % zoned), and prints sample AINs with assessor-portal
URLs — spot-check a handful against ZIMAS before publishing.

## Publish

1. Upload `data/tiles/land-map.pmtiles` to Range-capable static storage
   (Cloudflare R2 free tier recommended; enable CORS for your site's origin).
2. Set `PMTILES_URL` in `js/config.js` to its URL, and `START_CENTER`/`START_ZOOM`
   to `[-118.41, 34.02]` / `10`.
3. Deploy the repo's static files anywhere (GitHub Pages works — the big
   tileset lives on R2, not in git).

## Demo fixture

`00_fixture.py` generates ~8k synthetic parcels over Venice with realistic
width/zoning/vacancy distributions plus synthetic coastal/hillside/fire
overlays, in exactly the schema `01_download.py` produces — so it exercises
02→04 and the frontend unmodified. The tileset metadata carries
`synthetic=true`, which the app surfaces as a banner. Used for the committed
demo tileset and the Playwright smoke test.
