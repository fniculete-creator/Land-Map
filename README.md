# Land-Map — Ideal Land Site Targeting

An interactive map tool for finding and comparing candidate land sites against
*your* definition of "ideal". Drop pins or draw parcel boundaries, define
weighted criteria (price, access, utilities, flood risk, …), rate each site,
and Land-Map ranks them with color-coded scores so the best site stands out.

## Features

- **Interactive map** — Streets, satellite, and topographic base layers
  (OpenStreetMap, Esri World Imagery, OpenTopoMap).
- **Add sites two ways** — drop a marker for a quick candidate, or draw the
  actual parcel boundary as a polygon/rectangle. Drawn parcels get their
  **acreage computed automatically** from the geodesic area.
- **Customizable scoring criteria** — starts with 8 sensible defaults
  (price value, road access, utilities, terrain, flood risk, zoning,
  proximity, views). Rename, remove, add your own, and set a 0–10 weight
  for each.
- **Rate & rank** — rate every site 1–5 stars per criterion. Sites get a
  weighted score out of 100 and are ranked in the sidebar; markers and
  parcels are colored red → amber → green by score.
- **Site details** — price, acreage, automatic $/acre, and free-form notes
  (listing links, seller contacts, impressions).
- **Location search** — jump to any town/region via OpenStreetMap's
  Nominatim geocoder.
- **Persistence** — everything auto-saves to your browser (localStorage),
  with JSON export/import for backup and sharing.

## Getting started

No build step, no dependencies to install — it's a static site.

```bash
# from the repo root, serve it locally (any static server works):
python3 -m http.server 8000
# then open http://localhost:8000
```

Or simply open `index.html` directly in a browser.

### Workflow

1. **Search** for the area you're hunting in.
2. **Tune your criteria** in the *Criteria* tab — weight what matters most
   to you (e.g. flood risk 9, views 2).
3. **Add candidate sites** with the draw tools in the map's top-left corner.
4. Click a site to open its detail panel: set the **price**, confirm the
   **acreage**, and **rate it** against each criterion as you learn more
   (from listings, county GIS, site visits…).
5. Watch the **ranking** in the *Sites* tab — the highest scoring site is
   your best match. Unrated criteria are simply excluded, so partial
   information never unfairly sinks a site.
6. **Export** your data from the *Data* tab to back it up or share it.

## Scoring model

Each site's score is a normalized weighted average:

```
score = 100 × Σ(weight_c × rating_c) / Σ(weight_c × 5)
```

summed over criteria the site has been rated on. Criteria with weight 0 or
no rating are ignored.

## Tech

Plain HTML/CSS/JavaScript with [Leaflet](https://leafletjs.com/) and
[Leaflet.draw](https://github.com/Leaflet/Leaflet.draw) from CDNs. No
framework, no build tooling.

## Ideas for later

- Auto-scored criteria from open data (slope from elevation APIs, distance
  to roads/POIs via Overpass, FEMA flood zones).
- Shareable read-only links.
- Side-by-side site comparison table.
