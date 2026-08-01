// Land-Map configuration.
// Swap PMTILES_URL for the full-city tileset once you've built and hosted it
// (see scripts/pipeline/README.md) — everything else stays the same.
export const CONFIG = {
  PMTILES_URL: "data/demo/demo.pmtiles",

  // Where the map opens. Demo data covers Venice; the full-city build should
  // use [-118.41, 34.02] zoom 10.
  START_CENTER: [-118.457, 33.993],
  START_ZOOM: 13,

  // --- Optional API keys (paste yours; both restrictable by domain) ---
  // Mapbox public token (pk....) -> the app uses Mapbox cartography (same
  // family as comps.laaa.com). Create a URL-restricted token in your Mapbox
  // account. Leave empty to use the free OpenFreeMap basemap.
  MAPBOX_TOKEN: "",
  MAPBOX_STYLE: "mapbox://styles/mapbox/light-v11",

  // Google Maps API key with "Maps Embed API" enabled (free, unlimited) ->
  // clicking a parcel embeds live Street View in its popup. Restrict the key
  // to your site's domains. Leave empty for a plain Street View link.
  GOOGLE_MAPS_KEY: "",

  // Vector basemap style (clean light-gray cartography, no API key).
  // Fetched at startup; on failure the app falls back to the raster
  // basemaps below, then to a plain background. Self-hosting option:
  // download a Protomaps basemap extract and serve it like the parcel
  // tileset, then point this at your own style JSON.
  BASEMAP_STYLE_URL: "https://tiles.openfreemap.org/styles/positron",

  // Raster basemaps (fallback + satellite). These load from public tile
  // servers — fine in a normal browser, blocked in restricted sandboxes
  // (the app works without them).
  BASEMAPS: {
    streets: {
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      attribution: "© OpenStreetMap contributors",
    },
    satellite: {
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
      attribution: "Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics",
    },
  },

  ASSESSOR_URL: (ain) => `https://portal.assessor.lacounty.gov/parceldetail/${ain}`,
  ZIMAS_URL: "https://zimas.lacity.org/",
  // Free Street View deep link (opens Google Maps in a new tab; no API key).
  STREETVIEW_URL: (lat, lng) => `https://www.google.com/maps?layer=c&cbll=${lat},${lng}`,

  // SB 1123 / SB 684 lot-size caps (sqft): 1.5 ac SF, 5 ac MF.
  SB_SF_MAX_SQFT: 65340,
  SB_MF_MAX_SQFT: 217800,
};
