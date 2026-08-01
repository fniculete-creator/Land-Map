// Land-Map configuration.
// Swap PMTILES_URL for the full-city tileset once you've built and hosted it
// (see scripts/pipeline/README.md) — everything else stays the same.
export const CONFIG = {
  // Real parcels, target region (Valley + Westside). The full tri-county
  // tileset (~400 MB) needs external hosting (Cloudflare R2 / Vercel Blob) —
  // point this at its URL once uploaded to unlock all three counties.
  PMTILES_URL: "data/real/land-map-region.pmtiles",

  // Where the map opens.
  START_CENTER: [-118.47, 34.09],
  START_ZOOM: 11,

  // Team logo image (the exact Marcus & Millichap LAAA Team lockup).
  // Either commit the file to assets/ and set "assets/laaa-logo.png", or
  // paste the image URL from laaa.com (right-click the logo -> Copy image
  // address). Empty -> the styled text lockup renders instead.
  LOGO_URL: "assets/laaa-logo.png",

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

  // Instant local neighborhood search (no geocoder round-trip). Names feed
  // the search box autocomplete; anything not matched falls back to
  // OpenStreetMap's Nominatim geocoder.
  NEIGHBORHOODS: {
    "Encino": [-118.53, 34.14, -118.46, 34.18],
    "Tarzana": [-118.57, 34.14, -118.52, 34.18],
    "Woodland Hills": [-118.65, 34.13, -118.57, 34.19],
    "West Hills": [-118.67, 34.17, -118.60, 34.24],
    "Canoga Park": [-118.62, 34.19, -118.575, 34.24],
    "Winnetka": [-118.585, 34.19, -118.555, 34.24],
    "Reseda": [-118.555, 34.18, -118.51, 34.24],
    "Northridge": [-118.57, 34.21, -118.50, 34.28],
    "Chatsworth": [-118.64, 34.23, -118.57, 34.28],
    "Granada Hills": [-118.54, 34.26, -118.46, 34.30],
    "North Hills": [-118.50, 34.22, -118.45, 34.26],
    "Panorama City": [-118.46, 34.21, -118.43, 34.24],
    "Van Nuys": [-118.48, 34.17, -118.43, 34.22],
    "Sherman Oaks": [-118.47, 34.14, -118.42, 34.18],
    "Studio City": [-118.42, 34.13, -118.36, 34.17],
    "North Hollywood": [-118.41, 34.16, -118.35, 34.22],
    "Sylmar": [-118.47, 34.28, -118.41, 34.33],
    "Pacoima": [-118.44, 34.24, -118.39, 34.29],
    "Venice": [-118.48, 33.97, -118.44, 34.01],
    "Mar Vista": [-118.46, 33.99, -118.41, 34.03],
    "Palms": [-118.42, 34.01, -118.38, 34.04],
    "Westwood": [-118.46, 34.05, -118.42, 34.08],
    "Brentwood": [-118.52, 34.05, -118.46, 34.09],
    "Santa Monica": [-118.52, 33.99, -118.44, 34.05],
    "West Hollywood": [-118.40, 34.07, -118.34, 34.10],
    "Century City": [-118.42, 34.05, -118.40, 34.07],
    "Culver City": [-118.43, 33.99, -118.37, 34.03],
    "Pacific Palisades": [-118.58, 34.02, -118.50, 34.09],
  },

  ASSESSOR_URL: (ain) => `https://portal.assessor.lacounty.gov/parceldetail/${ain}`,
  ZIMAS_URL: "https://zimas.lacity.org/",
  // Free Street View deep link (opens Google Maps in a new tab; no API key).
  STREETVIEW_URL: (lat, lng) => `https://www.google.com/maps?layer=c&cbll=${lat},${lng}`,

  // Owner/last-sale data endpoint. Default is the bundled Vercel serverless
  // function (api/parcel.js) which proxies the LightBox (LandVision) API
  // using the LIGHTBOX_API_KEY environment variable set in Vercel. Empty
  // string disables the lookup (panel shows assessor-portal fallback).
  OWNER_API: "/api/parcel",

  // SB 1123 / SB 684 lot-size caps (sqft): 1.5 ac SF, 5 ac MF.
  SB_SF_MAX_SQFT: 65340,
  SB_MF_MAX_SQFT: 217800,
};
