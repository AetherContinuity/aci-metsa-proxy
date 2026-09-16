// aci-metsa-proxy — Suomen metsäkeskus, avoin metsätieto (WFS 2.0, GeoServer)
// Ensimmäinen lähde: metsänkäyttöilmoitukset. Kiinteä upstream-lista, ei avoin proxy.

const UPSTREAM = {
  mki: "https://avoin.metsakeskus.fi/rajapinnat/v1/forestusedeclaration/ows",
};
const MAX_COUNT = 1000;
const CORS = { "Access-Control-Allow-Origin": "*" };
const USAGE =
  "routes: ?caps | ?describe[&typeName=] | ?typeName=X[&bbox=x1,y1,x2,y2][&cql=][&count=][&start=][&sortBy=][&hits]  (src=mki, EPSG:3067)";

export default {
  async fetch(req, env, ctx) {
    const p = new URL(req.url).searchParams;
    const src = p.get("src") || "mki";
    const base = UPSTREAM[src];
    if (!base) return err(400, `unknown src: ${src}`);

    const q = new URLSearchParams({ service: "WFS", version: "2.0.0" });
    let ttl, meta = false;

    if (p.has("caps")) {
      q.set("request", "GetCapabilities");
      ttl = 86400; meta = true;
    } else if (p.has("describe")) {
      q.set("request", "DescribeFeatureType");
      if (p.get("typeName")) q.set("typeNames", p.get("typeName"));
      ttl = 86400; meta = true;
    } else if (p.get("typeName")) {
      q.set("request", "GetFeature");
      q.set("typeNames", p.get("typeName"));
      q.set("srsName", "EPSG:3067");
      if (p.get("bbox") && p.get("cql"))
        return err(400, "GeoServer: bbox ja cql eivät käy yhdessä — käytä BBOX(geom,…) cql:n sisällä");
      if (p.get("bbox")) q.set("bbox", `${p.get("bbox")},EPSG:3067`);
      if (p.get("cql")) q.set("cql_filter", p.get("cql"));
      if (p.get("sortBy")) q.set("sortBy", p.get("sortBy"));
      if (p.has("hits")) {
        q.set("resultType", "hits"); // XML, numberMatched
      } else {
        q.set("outputFormat", "application/json");
        const n = Math.min(Math.max(parseInt(p.get("count") || "100", 10) || 100, 1), MAX_COUNT);
        q.set("count", String(n));
        q.set("startIndex", String(Math.max(parseInt(p.get("start") || "0", 10) || 0, 0)));
      }
      ttl = 3600;
    } else {
      return err(400, USAGE);
    }

    const target = `${base}?${q}`;
    const cache = caches.default;
    const key = new Request(target);
    const hit = await cache.match(key);
    if (hit) return withHeaders(hit, { "X-Cache": "HIT", "X-Upstream-URL": target });

    let res;
    for (let i = 0; i < 3; i++) {
      res = await fetch(target, { headers: { "User-Agent": "aci-metsa-proxy (aethercontinuity.org)" } });
      if (res.status !== 429 && res.status < 500) break;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }

    const body = await res.text();
    const ctype = res.headers.get("content-type") || "text/plain";

    // Ansa: GeoServer palauttaa virheet usein HTTP 200 + ows:ExceptionReport
    if (/ExceptionReport|ServiceExceptionReport/.test(body.slice(0, 2000)) && !meta)
      return err(502, `upstream exception: ${body.slice(0, 800)}`, target);
    if (!res.ok) return err(res.status, body.slice(0, 800), target);

    const out = new Response(body, {
      status: 200,
      headers: { ...CORS, "Content-Type": ctype, "Cache-Control": `public, max-age=${ttl}` },
    });
    ctx.waitUntil(cache.put(key, out.clone()));
    return withHeaders(out, { "X-Cache": "MISS", "X-Upstream-URL": target });
  },
};

function err(status, msg, target) {
  const h = { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (target) h["X-Upstream-URL"] = target;
  return new Response(JSON.stringify({ error: msg }), { status, headers: h });
}

function withHeaders(res, extra) {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(extra)) r.headers.set(k, v);
  return r;
}
