// Land-Map configuration.
export const CONFIG = {
  // Real parcels: ALL of LA County + Ventura + Santa Barbara (2.8M parcels),
  // split into geographic chunks so each file stays under GitHub/Vercel
  // per-file limits. Each chunk loads as its own tile source; the map treats
  // them as one seamless dataset. First entry doubles as the demo-detection
  // archive.
  PMTILES_URLS: [
    "data/real/land-tiles-west.pmtiles",        // Valley + Westside (original region)
    "data/real/land-tiles-eastbasin-n.pmtiles", // Silver Lake, Hollywood, Glendale, Pasadena
    "data/real/land-tiles-eastbasin-s.pmtiles", // DTLA, Koreatown, East & South-Central LA
    "data/real/land-tiles-sgv.pmtiles",         // San Gabriel Valley east
    "data/real/land-tiles-south.pmtiles",       // South Bay, Long Beach, SE cities, Catalina
    "data/real/land-tiles-north.pmtiles",       // Santa Clarita + Antelope Valley
    "data/real/land-tiles-coast.pmtiles",       // Ventura + Santa Barbara counties
  ],

  // Where the map opens.
  START_CENTER: [-118.47, 34.09],
  START_ZOOM: 11,

  // Team logo image (the exact Marcus & Millichap LAAA Team lockup).
  // Either commit the file to assets/ and set "assets/laaa-logo.png", or
  // paste the image URL from laaa.com (right-click the logo -> Copy image
  // address). Empty -> the styled text lockup renders instead.
  LOGO_URL: "assets/laaa-logo.png",   // official lockup from www.laaa.com/logos/laaa-white.png

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
    "Silver Lake": [-118.29, 34.07, -118.25, 34.11],
    "Echo Park": [-118.27, 34.06, -118.23, 34.10],
    "Los Feliz": [-118.31, 34.09, -118.27, 34.13],
    "Hollywood": [-118.36, 34.08, -118.30, 34.11],
    "East Hollywood": [-118.31, 34.08, -118.28, 34.10],
    "Koreatown": [-118.32, 34.05, -118.28, 34.08],
    "Downtown LA": [-118.28, 34.02, -118.22, 34.07],
    "Highland Park": [-118.22, 34.10, -118.17, 34.13],
    "Eagle Rock": [-118.23, 34.13, -118.19, 34.16],
    "Glendale": [-118.29, 34.12, -118.21, 34.21],
    "Burbank": [-118.37, 34.15, -118.28, 34.22],
    "Pasadena": [-118.19, 34.12, -118.06, 34.20],
    "Inglewood": [-118.38, 33.93, -118.31, 33.98],
    "Torrance": [-118.39, 33.78, -118.30, 33.89],
    "Redondo Beach": [-118.40, 33.81, -118.35, 33.87],
    "Manhattan Beach": [-118.42, 33.87, -118.38, 33.91],
    "Long Beach": [-118.25, 33.73, -118.08, 33.88],
    "Santa Clarita": [-118.62, 34.36, -118.40, 34.46],
    "Palmdale": [-118.20, 34.53, -117.98, 34.63],
    "Lancaster": [-118.25, 34.65, -118.05, 34.75],
    "Simi Valley": [-118.83, 34.24, -118.63, 34.31],
    "Thousand Oaks": [-118.94, 34.14, -118.80, 34.23],
    "Camarillo": [-119.10, 34.20, -118.97, 34.26],
    "Oxnard": [-119.25, 34.15, -119.12, 34.25],
    "Ventura": [-119.31, 34.24, -119.20, 34.31],
    "Santa Barbara": [-119.77, 34.39, -119.64, 34.46],
    "Goleta": [-119.90, 34.40, -119.78, 34.47],
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
