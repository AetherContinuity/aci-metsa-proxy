// aci-metsa-proxy — BEM-lähteet, v2
//  WFS (kiinteät upstreamit, src=):
//    mki   Metsäkeskus, metsänkäyttöilmoitukset (GeoServer)
//    ruoka Ruokavirasto INSPIRE (GeoServer): perus- ja kasvulohkot, CC BY 4.0
//    ryhti SYKE Ryhti rakennukset (valmiit + hankerakennukset), GeoServer, CC BY 4.0
//          valmistumisvuosi, kayttotarkoitus, rakentamisluvan paatospaiva
//    (mmlbu poistettu 2.1: MML:n INSPIRE-WFS bu_mtk palautti HTTP 520;
//     rakennustiedot siirtyivat Ryhtiin, MML:n maastotiedot OGC API vaatii API-avaimen)
//  Sentinel-2 L2A (Earth Search / AWS Open Data): STAC-haku + COG-range-välitys
//
//  ?caps&src=            GetCapabilities
//  ?describe&src=[&typeName=]
//  ?typeName=X&src=[&bbox=x1,y1,x2,y2][&cql=][&count=][&start=][&sortBy=][&hits][&fmt=gml][&props=A,B,C]
//      props = GeoServer propertyName: vain luetellut kentat, ei geometriaa -> pienempi vastaus (2.2)
//      bbox EPSG:3067; cql vain GeoServer-lähteille (mki, ruoka)
//  ?s2search&bbox=lon,lat,lon,lat[&datetime=2023-06-01/2023-08-31][&cloud=30][&limit=50]
//  ?cog=sentinel-s2-l2a-cogs/…/B04.tif   (Range välitetään, HEAD tuettu)
//  /version
// Tuntemattomat polut → 404. Välimuisti: wrangler.toml [cache] + Cache-Control
// (caches.default ei toimi workers.dev-osoitteissa).

const VERSION = 'metsa-v2.2-2026-09-21';

const WFS = {
  mki:   { url: 'https://avoin.metsakeskus.fi/rajapinnat/v1/forestusedeclaration/ows', geoserver: true },
  ruoka: { url: 'https://inspire.ruokavirasto-awsa.com/geoserver/wfs', geoserver: true },
  ryhti: { url: 'https://paikkatiedot.ymparisto.fi/geoserver/ryhti_building/wfs', geoserver: true },
  ryhtilupa: { url: 'https://paikkatiedot.ymparisto.fi/geoserver/ryhti_permit/wfs', geoserver: true },
};
const S2_STAC = 'https://earth-search.aws.element84.com/v1/search';
const S2_COG = 'https://sentinel-cogs.s3.us-west-2.amazonaws.com';
const COG_KEY = /^sentinel-s2-l2a-cogs\/[\w\/.-]+\.tif$/;
const S2_ASSETS = ['blue', 'green', 'red', 'rededge1', 'nir', 'nir08', 'swir16', 'swir22', 'scl'];
const MAX_COUNT = 1000;
const UA = 'aci-metsa-proxy (aethercontinuity.org)';
const CORS = { 'Access-Control-Allow-Origin': '*' };

export default {
  async fetch(req) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: { ...CORS, 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': 'Range' } });
    const u = new URL(req.url);
    const path = u.pathname.replace(/\/+$/, '') || '/';
    const p = u.searchParams;
    try {
      if (path === '/version') return json({ version: VERSION }, 200, 0);
      if (path !== '/') return json({ error: `unknown path: ${path}`, version: VERSION }, 404, 0);
      if (p.has('cog')) return await cog(req, p.get('cog'));
      if (p.has('s2search')) return await s2search(p);
      if (p.has('caps') || p.has('describe') || p.get('typeName')) return await wfs(p);
      return json({ error: 'usage: ?caps|?describe|?typeName=|?s2search|?cog= (src=mki|ruoka|ryhti|ryhtilupa)', version: VERSION }, 400, 0);
    } catch (e) {
      return json({ error: e.message }, 500, 0);
    }
  },
};

// ---------- apu ----------
function json(obj, status = 200, ttl = 0) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': ttl ? `public, max-age=${ttl}` : 'no-store' },
  });
}

function normDatetime(dt) {
  if (!dt) return null;
  const m = dt.match(/^(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/);
  if (m) return `${m[1]}T00:00:00Z/${m[2]}T23:59:59Z`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dt)) return `${dt}T00:00:00Z/${dt}T23:59:59Z`;
  return dt;
}

// ---------- Sentinel-2 ----------
async function s2search(p) {
  const bbox = (p.get('bbox') || '').split(',').map(Number);
  if (bbox.length !== 4 || bbox.some(Number.isNaN)) return json({ error: 's2search: bbox=minLon,minLat,maxLon,maxLat' }, 400, 0);
  const body = {
    collections: ['sentinel-2-l2a'],
    bbox,
    limit: Math.min(Math.max(parseInt(p.get('limit') || '50', 10) || 50, 1), 100),
    query: { 'eo:cloud_cover': { lt: Number(p.get('cloud') || '30') } },
    sortby: [{ field: 'properties.datetime', direction: 'asc' }],
  };
  const dt = normDatetime(p.get('datetime'));
  if (dt) body.datetime = dt;
  const r = await fetch(S2_STAC, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA }, body: JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) return json({ error: `STAC HTTP ${r.status}`, detail: text.slice(0, 800) }, 502, 0);
  const j = JSON.parse(text);
  const items = (j.features || []).map((f) => {
    const o = {
      id: f.id,
      datetime: f.properties.datetime,
      cloud: f.properties['eo:cloud_cover'],
      tile: f.properties['grid:code'] || f.properties['s2:mgrs_tile'] || null,
      baseline: f.properties['s2:processing_baseline'] || null,
    };
    for (const a of S2_ASSETS) o[a] = f.assets[a]?.href || null;
    return o;
  });
  return json({ matched: j.numberMatched ?? j.context?.matched ?? null, n: items.length, items }, 200, 3600);
}

async function cog(req, key) {
  if (!COG_KEY.test(key || '') || key.includes('..')) return json({ error: 'cog: invalid key' }, 400, 0);
  const method = req.method === 'HEAD' ? 'HEAD' : 'GET';
  const h = { 'User-Agent': UA };
  const range = req.headers.get('Range');
  if (range) h.Range = range;
  const r = await fetch(`${S2_COG}/${key}`, { method, headers: h });
  const out = new Headers(CORS);
  for (const k of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag', 'Last-Modified']) {
    const v = r.headers.get(k);
    if (v) out.set(k, v);
  }
  out.set('Cache-Control', 'no-store');
  return new Response(method === 'HEAD' ? null : r.body, { status: r.status, headers: out });
}

// ---------- WFS ----------
async function wfs(p) {
  const src = p.get('src') || 'mki';
  const S = WFS[src];
  if (!S) return json({ error: `unknown src: ${src}`, allowed: Object.keys(WFS) }, 400, 0);

  const q = new URLSearchParams({ service: 'WFS', version: '2.0.0' });
  let ttl, meta = false;
  if (p.has('caps')) {
    q.set('request', 'GetCapabilities'); ttl = 86400; meta = true;
  } else if (p.has('describe')) {
    q.set('request', 'DescribeFeatureType');
    if (p.get('typeName')) q.set('typeNames', p.get('typeName'));
    ttl = 86400; meta = true;
  } else {
    q.set('request', 'GetFeature');
    q.set('typeNames', p.get('typeName'));
    q.set('srsName', 'EPSG:3067');
    if (p.get('cql') && !S.geoserver) return json({ error: `cql ei tuettu lähteelle ${src}` }, 400, 0);
    if (p.get('bbox') && p.get('cql')) return json({ error: 'GeoServer: bbox ja cql eivät käy yhdessä — käytä BBOX(geom,…) cql:n sisällä' }, 400, 0);
    if (p.get('bbox')) q.set('bbox', `${p.get('bbox')},EPSG:3067`);
    if (p.get('cql')) q.set('cql_filter', p.get('cql'));
    if (p.get('sortBy')) q.set('sortBy', p.get('sortBy'));
    if (p.get('props')) {
      if (!/^[A-Za-z0-9_,:]+$/.test(p.get('props'))) return json({ error: 'props: vain kenttanimet pilkulla erotettuina' }, 400, 0);
      q.set('propertyName', p.get('props'));
    }
    if (p.has('hits')) {
      q.set('resultType', 'hits');
    } else {
      if (p.get('fmt') !== 'gml') q.set('outputFormat', 'application/json');
      const n = Math.min(Math.max(parseInt(p.get('count') || '100', 10) || 100, 1), MAX_COUNT);
      q.set('count', String(n));
      q.set('startIndex', String(Math.max(parseInt(p.get('start') || '0', 10) || 0, 0)));
    }
    ttl = 3600;
  }

  const target = `${S.url}?${q}`;
  let res;
  for (let i = 0; i < 3; i++) {
    res = await fetch(target, { headers: { 'User-Agent': UA } });
    if (res.status !== 429 && res.status < 500) break;
    await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
  }
  const body = await res.text();
  const ctype = res.headers.get('content-type') || 'text/plain';
  // GeoServer palauttaa virheet usein HTTP 200 + ExceptionReport
  if (/ExceptionReport|ServiceExceptionReport/.test(body.slice(0, 2000)) && !meta)
    return new Response(JSON.stringify({ error: 'upstream exception', detail: body.slice(0, 800) }), {
      status: 502, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Upstream-URL': target },
    });
  if (!res.ok)
    return new Response(JSON.stringify({ error: `HTTP ${res.status}`, detail: body.slice(0, 800) }), {
      status: res.status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Upstream-URL': target },
    });
  return new Response(body, {
    headers: { ...CORS, 'Content-Type': ctype, 'Cache-Control': `public, max-age=${ttl}`, 'X-Upstream-URL': target },
  });
}
