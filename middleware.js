// Vercel Edge Middleware: team Basic auth for the whole site.
// Required before any LightBox/LandVision-derived owner data may display
// (LightBox Order Form Q-67561: internal business use only - no public,
// unauthenticated surface). Password comes from the SITE_PASSWORD env var;
// if it is unset the site FAILS CLOSED rather than silently going public.
export const config = { matcher: "/:path*" };

export default function middleware(req) {
  const expected = process.env.SITE_PASSWORD;
  const auth = req.headers.get("authorization") || "";
  if (expected && auth.startsWith("Basic ")) {
    try {
      const pass = atob(auth.slice(6)).split(":").slice(1).join(":");
      if (pass === expected) return; // any username, team password
    } catch (e) { /* malformed header -> challenge */ }
  }
  return new Response("LAAA Team access - authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="LAAA Land"' },
  });
}
