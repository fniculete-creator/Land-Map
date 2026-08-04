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
- **On Market** — orange toggle showing only SFR/land deals currently listed
  for sale (team-curated `data/listings.json`, keyed by AIN). Activating it
  reveals a **$/SF Land** range filter — list price ÷ lot SF — and the side
  panel becomes a citywide price sheet sorted cheapest land first. Combine
  with the SB 1123 button to see which listed deals qualify for subdivision.
  Listing parcels get orange markers at every zoom; their detail panels show
  price, $/SF, and a link to the listing. Format: see
  `data/listings.sample.json` (`price` + `lotSqft` drive the $/SF math;
  `lng`/`lat` place the marker; `url`, `listDate`, `broker`, `tier` optional).
- **Share a search** — filter state lives in the URL hash; copy the link.
- **Satellite toggle** — top-right button.

## Optional API keys

All keys are optional — the app is fully functional without them. On Vercel,
set them as **environment variables** (Project → Settings → Environment
Variables) and redeploy; `api/config.js` serves the public ones to the app
at runtime, so no tokens live in the repo (GitHub push protection blocks
committed tokens anyway):

| Env var | Purpose |
|---|---|
| `MAPBOX_PUBLIC_TOKEN` | `pk.…` public token → Mapbox basemap cartography |
| `GOOGLE_MAPS_KEY` | Maps Embed API key → embedded Street View in the parcel panel |
| `LIGHTBOX_API_KEY` | LightBox/LandVision API → owner info in the parcel panel (server-side only, never exposed) |

For non-Vercel hosting you can instead paste the two public keys directly
into `js/config.js` (`MAPBOX_TOKEN`, `GOOGLE_MAPS_KEY`).

- **`MAPBOX_TOKEN`** — a Mapbox public token (`pk.…`) switches the basemap
  to Mapbox cartography (`MAPBOX_STYLE`, default `light-v11` — the same
  family as comps.laaa.com). MapLibre loads the Mapbox style directly;
  billing is per tile request with a generous free tier. Create the token
  at account.mapbox.com and **restrict it to your site's URLs**.
- **`GOOGLE_MAPS_KEY`** — a Google Maps API key with the **Maps Embed API**
  enabled embeds live Street View inside each parcel popup. The Embed API
  is free of charge with unlimited usage. Create the key in Google Cloud
  Console, enable only "Maps Embed API", and **restrict it to your site's
  domains** (HTTP referrers). Without a key, popups keep the plain Street
  View link.

Basemap fallback order: Mapbox (if token) → OpenFreeMap (free) → OSM
raster → plain background.

### Owner data via LandVision / LightBox

The parcel detail panel's **Owner information** section (owner of record,
mailing address, last sale) is fed by `api/parcel.js`, a Vercel serverless
function that proxies the LightBox API — the data platform behind
LandVision — keeping your API key server-side. Setup:

1. Get a LightBox API key (developer.lightboxre.com; ask your LandVision
   rep to enable API access on your account).
2. In Vercel: Project → Settings → Environment Variables → add
   `LIGHTBOX_API_KEY`. Redeploy.
3. If your subscription's endpoint shape differs, adjust `LIGHTBOX_PATH`
   (env var) and the field mapping in `api/parcel.js` — both documented in
   the file.

Without the key the panel falls back to a one-click link to the parcel's
LA County Assessor page, where ownership is public record.

## Deploying to Vercel (fastest path to a URL)

The repo is a zero-build static site — Vercel serves it as-is:

1. Go to [vercel.com/new](https://vercel.com/new) and import the
   `Land-Map` GitHub repo (framework preset: **Other**; no build command;
   output directory: repo root).
2. Deploy — you get `https://<project>.vercel.app` in about a minute,
   running on the bundled demo tileset.
3. For **land.laaa.com**: Vercel project → Settings → Domains → add
   `land.laaa.com`, then create the CNAME it shows you at your DNS host.

Vercel's CDN serves static files with the HTTP Range support PMTiles
needs, and `vercel.json` adds CORS/caching headers for tilesets. Note the
~100 MB static-file limit: the demo tileset is fine, but host the full
region/city tileset on Cloudflare R2 (or Vercel Blob) and point
`PMTILES_URL` in `js/config.js` at it.

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
