// aci-metsa-proxy — BEM-lähteet
//  1) Suomen metsäkeskus, avoin metsätieto (WFS 2.0, GeoServer): metsänkäyttöilmoitukset
//  2) Sentinel-2 L2A (Earth Search / AWS Open Data): STAC-haku + COG-range-välitys
// Kiinteät upstreamit, ei avoin proxy.

const WFS = {
  mki: "https://avoin.metsakeskus.fi/rajapinnat/v1/forestusedeclaration/ows",
};
const S2_STAC = "https://earth-search.aws.element84.com/v1/search";
const S2_COG = "https://sentinel-cogs.s3.us-west-2.amazonaws.com";
const COG_KEY = /^sentinel-s2-l2a-cogs\/[\w\/.-]+\.tif$/;
const MAX_COUNT = 1000;
const CORS = { "Access-Control-Allow-Origin": "*" };
const USAGE = {
  wfs: "?caps | ?describe[&typeName=] | ?typeName=X[&bbox=x1,y1,x2,y2][&cql=][&count=][&start=][&sortBy=][&hits]  (EPSG:3067)",
  s2search: "?s2search&bbox=minLon,minLat,maxLon,maxLat[&datetime=2023-06-01/2023-08-31][&cloud=30][&limit=50]  (WGS84)",
  cog: "?cog=sentinel-s2-l2a-cogs/…/B04.tif  (Range-otsake välitetään, HEAD tuettu)",
};

export default {
  async fetch(req, env, ctx) {
    const p = new URL(req.url).searchParams;
    if (p.has("cog")) return cog(req, p.get("cog"));
    if (p.has("s2search")) return s2search(p);
    return wfs(req, p, ctx);
  },
};

// ---------- Sentinel-2 ----------

async function s2search(p) {
  const bbox = (p.get("bbox") || "").split(",").map(Number);
  if (bbox.length !== 4 || bbox.some(Number.isNaN)) return err(400, USAGE.s2search);
  const body = {
    collections: ["sentinel-2-l2a"],
    bbox,
    limit: Math.min(Math.max(parseInt(p.get("limit") || "50", 10) || 50, 1), 100),
    query: { "eo:cloud_cover": { lt: Number(p.get("cloud") || "30") } },
    sortby: [{ field: "properties.datetime", direction: "asc" }],
  };
  if (p.get("datetime")) body.datetime = p.get("datetime");

  const r = await fetch(S2_STAC, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "aci-metsa-proxy (aethercontinuity.org)" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) return err(r.status, text.slice(0, 800));
  const j = JSON.parse(text);
  const items = (j.features || []).map((f) => ({
    id: f.id,
    datetime: f.properties.datetime,
    cloud: f.properties["eo:cloud_cover"],
    tile: f.properties["grid:code"] || f.properties["s2:mgrs_tile"] || null,
    red: f.assets.red?.href || null,
    nir: f.assets.nir?.href || null,
    scl: f.assets.scl?.href || null,
  }));
  return json({ matched: j.numberMatched ?? j.context?.matched ?? null, n: items.length, items }, 3600);
}

async function cog(req, key) {
  if (!COG_KEY.test(key || "") || key.includes("..")) return err(400, USAGE.cog);
  const method = req.method === "HEAD" ? "HEAD" : "GET";
  const h = {};
  const range = req.headers.get("Range");
  if (range) h.Range = range;
  const r = await fetch(`${S2_COG}/${key}`, { method, headers: h });
  const out = new Headers(CORS);
  for (const k of ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified"]) {
    const v = r.headers.get(k);
    if (v) out.set(k, v);
  }
  out.set("Cache-Control", "no-store");
  return new Response(method === "HEAD" ? null : r.body, { status: r.status, headers: out });
}

// ---------- Metsäkeskus WFS ----------

async function wfs(req, p, ctx) {
  const src = p.get("src") || "mki";
  const base = WFS[src];
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
      return err(400, "GeoServer: bbox ja cql eivät käy yhdessä — käytä BBOX(GEOMETRY,…) cql:n sisällä");
    if (p.get("bbox")) q.set("bbox", `${p.get("bbox")},EPSG:3067`);
    if (p.get("cql")) q.set("cql_filter", p.get("cql"));
    if (p.get("sortBy")) q.set("sortBy", p.get("sortBy"));
    if (p.has("hits")) {
      q.set("resultType", "hits");
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
  if (/ExceptionReport|ServiceExceptionReport/.test(body.slice(0, 2000)) && !meta)
    return err(502, `upstream exception: ${body.slice(0, 800)}`, target);
  if (!res.ok) return err(res.status, body.slice(0, 800), target);

  const out = new Response(body, {
    status: 200,
    headers: { ...CORS, "Content-Type": ctype, "Cache-Control": `public, max-age=${ttl}` },
  });
  ctx.waitUntil(cache.put(key, out.clone()));
  return withHeaders(out, { "X-Cache": "MISS", "X-Upstream-URL": target });
}

// ---------- apu ----------

function json(obj, ttl) {
  return new Response(JSON.stringify(obj), {
    headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": `public, max-age=${ttl}` },
  });
}

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
