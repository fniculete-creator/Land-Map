// Vercel serverless function: public runtime config for the app.
//
// Lets API keys live as Vercel environment variables instead of in the repo
// (GitHub push protection blocks committed tokens). Set in Vercel ->
// Project -> Settings -> Environment Variables:
//   MAPBOX_PUBLIC_TOKEN   pk.… public token -> Mapbox basemap
//   GOOGLE_MAPS_KEY       Maps Embed API key -> embedded Street View
//
// Only PUBLIC, client-safe values belong here — everything returned is
// visible in the browser. Server-only secrets (LIGHTBOX_API_KEY) stay in
// their own functions and are never exposed.

module.exports = (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=300");
  res.status(200).json({
    mapboxToken: process.env.MAPBOX_PUBLIC_TOKEN || "",
    googleMapsKey: process.env.GOOGLE_MAPS_KEY || "",
  });
};
