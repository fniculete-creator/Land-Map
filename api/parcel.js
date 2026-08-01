// Vercel serverless function: owner / last-sale lookup by APN.
//
// Proxies the LightBox API (the data platform behind LandVision) so the API
// key stays server-side. Configure in Vercel -> Project -> Settings ->
// Environment Variables:
//   LIGHTBOX_API_KEY   your LightBox developer API key (required)
//   LIGHTBOX_BASE      optional, default https://api.lightboxre.com/v1
//   LIGHTBOX_PATH      optional endpoint template, default
//                      /assessments/us/fips/06037/apn/{apn}
//
// LightBox subscriptions differ; if your account uses a different endpoint
// shape, adjust LIGHTBOX_PATH (the {apn} placeholder is substituted) and the
// field mapping in normalize() below to match your product's response.
// Docs: https://developer.lightboxre.com
//
// Response shape consumed by the app (js/app.js fillOwnerInfo):
//   { owner, mailingAddress, lastSaleDate, lastSalePrice }

const BASE = process.env.LIGHTBOX_BASE || "https://api.lightboxre.com/v1";
const PATH = process.env.LIGHTBOX_PATH || "/assessments/us/fips/06037/apn/{apn}";

function firstOf(obj, paths) {
  for (const path of paths) {
    let cur = obj;
    for (const seg of path.split(".")) {
      cur = cur && typeof cur === "object" ? cur[seg] : undefined;
    }
    if (cur !== undefined && cur !== null && cur !== "") return cur;
  }
  return undefined;
}

function normalize(raw) {
  // LightBox responses are typically { assessments: [ {...} ] } or a bare
  // object; take the first record found.
  const rec = firstOf(raw, ["assessments.0", "parcels.0", "results.0"]) || raw;
  const ownerRec = firstOf(rec, ["owner", "ownership", "primaryOwner"]) || {};
  const owner = firstOf(rec, [
    "owner.names.0.fullName", "owner.fullName", "ownerName",
    "ownership.owner1.fullName",
  ]) || firstOf(ownerRec, ["name", "fullName"]);
  const mail = firstOf(rec, ["owner.mailingAddress", "mailingAddress", "ownership.mailingAddress"]) || {};
  const mailingAddress = typeof mail === "string" ? mail : [
    firstOf(mail, ["streetAddress", "line1", "address"]),
    [firstOf(mail, ["locality", "city"]), firstOf(mail, ["regionCode", "state"]),
     firstOf(mail, ["postalCode", "zip"])].filter(Boolean).join(", "),
  ].filter(Boolean).join(", ");
  return {
    owner: owner || undefined,
    mailingAddress: mailingAddress || undefined,
    lastSaleDate: firstOf(rec, [
      "lastSale.date", "saleDate", "lastMarketSale.date", "transfer.date",
    ]),
    lastSalePrice: firstOf(rec, [
      "lastSale.price", "salePrice", "lastMarketSale.price", "transfer.price",
    ]),
  };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=86400");

  const key = process.env.LIGHTBOX_API_KEY;
  if (!key) {
    return res.status(501).json({ error: "not_configured",
      hint: "Set LIGHTBOX_API_KEY in Vercel environment variables." });
  }
  const apn = (req.query.apn || "").replace(/[^0-9A-Za-z-]/g, "");
  if (!apn) return res.status(400).json({ error: "apn_required" });

  try {
    const url = BASE + PATH.replace("{apn}", encodeURIComponent(apn));
    const upstream = await fetch(url, { headers: { "x-api-key": key } });
    if (!upstream.ok) {
      return res.status(502).json({ error: "upstream_" + upstream.status });
    }
    const raw = await upstream.json();
    return res.status(200).json(normalize(raw));
  } catch (e) {
    return res.status(502).json({ error: "upstream_unreachable" });
  }
};
