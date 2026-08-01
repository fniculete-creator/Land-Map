// Land-Map configuration.
// Swap PMTILES_URL for the full-city tileset once you've built and hosted it
// (see scripts/pipeline/README.md) — everything else stays the same.
export const CONFIG = {
  PMTILES_URL: "data/demo/demo.pmtiles",

  // Where the map opens. Demo data covers Venice; the full-city build should
  // use [-118.41, 34.02] zoom 10.
  START_CENTER: [-118.457, 33.993],
  START_ZOOM: 13,

  // Raster basemaps. These load from public tile servers — fine in a normal
  // browser, blocked in restricted sandboxes (the app works without them).
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

  // SB 1123 / SB 684 lot-size caps (sqft): 1.5 ac SF, 5 ac MF.
  SB_SF_MAX_SQFT: 65340,
  SB_MF_MAX_SQFT: 217800,
};
