# Land (LAAA Team) — LA Development Site Targeting

An interactive parcel map for finding development sites in Los Angeles,
styled after the team's comps tool and intended to live at **land.laaa.com**.
Every parcel renders in neutral gray; **only qualifying SB 1123 / SB 684
candidates are colored** — vacant lots within the acreage caps, with fire
hazard, coastal zone, and hillside parcels excluded automatically. Filter by
lot width, lot size, units, zoning, and market tier (A Westside / B South
Valley / C Central & North Valley); click any parcel for details and a direct
link to its LA County Assessor page (ownership info).

Static architecture: all ~780k city parcels are preprocessed into a single
[PMTiles](https://protomaps.com/docs/pmtiles) vector-tile file with every
filter attribute baked in. Filtering happens entirely in the browser — no
backend, no tile server, hostable anywhere static files can live.

## Quick start (demo data)

The repo ships with a **synthetic demo tileset** (`data/demo/demo.pmtiles`,
~8k generated parcels over the Venice area) so the app runs out of the box:

```bash
python3 scripts/pipeline/serve.py 8000
# open http://localhost:8000
```

> The dev server matters: PMTiles requires HTTP **Range** support, which
> `python3 -m http.server` does not provide. `npx http-server` also works.

A yellow banner reminds you the demo parcels are synthetic. To target real
sites, build the real tileset:

## Building the full LA City tileset

See **[scripts/pipeline/README.md](scripts/pipeline/README.md)** for the full
guide. Summary:

```bash
pip3 install -r scripts/pipeline/requirements.txt
sudo apt-get install -y tippecanoe          # or build from felt/tippecanoe

cd scripts/pipeline
# 1. verify the FeatureServer URLs in sources.json (see pipeline README)
python3 01_download.py --subset venice      # fast first run, or omit for full city
python3 02_enrich.py
./03_tiles.sh
python3 04_validate.py
```

Then point `PMTILES_URL` in `js/config.js` at the produced
`data/tiles/land-map.pmtiles`.

**Hosting the full tileset:** the citywide file will be roughly 150–400 MB —
too big for this repo / GitHub Pages. Host it on any static storage with HTTP
Range support and CORS: Cloudflare R2 (recommended — free tier, zero egress
fees), S3 + CloudFront, etc. The app fetches byte ranges directly; no server
code needed.

## Using the app

- **SB 1123 candidates button** — shows only qualifying parcels: vacant,
  single-family zone ≤ 1.5 ac or multifamily zone ≤ 5 ac. Fire hazard
  (High/Very High), coastal zone, and hillside parcels never qualify and are
  excluded from candidates automatically (their popups say why).
- **Filter pills** — min/max lot width, lot size, and units; zoning by family
  (single-family / multifamily / other) or exact zone classes; market tier
  (A/B/C); vacancy status.
- **Colors** — green = qualifying candidate; every other parcel stays
  neutral gray. Zoomed out (< z13), parcels display as dots.
- **Left panel** — stat tiles (parcels in view, candidates, median lot size
  and width) plus a ranked candidates list; click a row to zoom to the lot.
- **Parcel popup** — tier, zoning, use code, units, lot size, computed width,
  improvement value, and links to the **Assessor portal** (ownership — CA law
  keeps owner names out of bulk open data, so it's one click away per parcel)
  and **ZIMAS**.
- **Share a search** — filter state lives in the URL hash; copy the link.
- **Satellite toggle** — top-right button.

## Hosting at land.laaa.com

The app is static files — deploy the repo (minus `data/raw|enriched|tiles`)
to any web server or CDN behind land.laaa.com. Requirements: serve
`.pmtiles` with HTTP **Range** support (nginx/Apache/S3/R2 all do) and, if
the tileset lives on another host, CORS for the site origin. Point
`PMTILES_URL` in `js/config.js` at the tileset and it's live.

## Data & caveats

| Attribute | Source | Notes |
|---|---|---|
| Parcel geometry, AIN, use code, units, improvement value | LA County Assessor parcel layer | |
| Zoning | LA City GeoHub Zoning layer | assigned by parcel representative point |
| Hillside / Coastal / Fire severity | LA City GeoHub overlay layers | point-in-polygon flags |
| Lot width | **computed** | short side of the minimum rotated rectangle — an approximation of frontage; verify irregular/flag lots manually |
| Vacant | **derived** | vacant use code, or 0 units + improvements below a configurable threshold |
| SB 1123/684 eligible | **derived** | screening heuristic from the above |

**This tool is a screening aid, not legal or zoning advice.** SB 1123/684
eligibility involves criteria that cannot be fully determined from parcel
data (urban-infill context, protected-species habitat, wetlands, easements,
protected housing history…). Verify every candidate in
[ZIMAS](https://zimas.lacity.org/) and with land-use counsel before acting.

## Development

```bash
python3 scripts/pipeline/serve.py 8123        # serve the app
npm i playwright-core                          # once
node tests/smoke.spec.mjs http://localhost:8123
```

The smoke test drives the real app headlessly: rendering, SB preset,
filtering, popup, assessor links, URL-hash state.

## Roadmap (v2 ideas)

- **On-market cross-reference** — CSV import of listings (Redfin/MLS export)
  matched to parcels by APN/address. The hook already exists:
  `LandMap.addOverlayPoints(geojson)`.
- Exact citywide filter counts + CSV export of matching parcels.
- Scheduled data refresh (GitHub Actions cron → R2) and email notifications
  for new parcels matching saved searches.
- Owner-data import (licensed assessor roll / third-party) for mail-merge.
