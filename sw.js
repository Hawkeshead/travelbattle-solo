/* =========================================================
   THE SERVICE WORKER: the game's files kept on the phone

   Registered from js/boot.js as sw.js?v=<build commit>, so every deploy is a
   new worker with its own cache ('fc-<commit>'), and the old build's cache is
   deleted when the new one takes over.

   - Install: only the app shell (page, code, data), in small batches, plus
     any asset unchanged since the previous build copied across from its
     cache. The tier 1 and 2 assets are filled by the title-screen loader
     (js/asset-loader.js), tier 1 first; a quota error stops the filling and
     keeps what is cached.
   - Fetch: assets in the manifest come from the cache first (fetched and
     kept on a miss); the page, the code and the data go to the network first
     so an update arrives at once, falling back to the cache offline. Anything
     else (online play, telemetry, fonts, other sites) is left alone.
========================================================= */
const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE = 'fc-' + VERSION;
const BATCH = 6;

let assetSet = null;     // paths (relative to the site root) that are cache-first
const base = new URL('./', self.location.href);
const rel = url => url.href.startsWith(base.href) ? decodeURIComponent(url.pathname.slice(new URL(base).pathname.length)) : null;

async function manifest(){
  const r = await fetch(new URL('assets-manifest.json', base), { cache: 'no-cache' });
  if(!r.ok) throw new Error('no manifest');
  const m = await r.json();
  assetSet = new Set(m.files.map(f => f.path));
  return m;
}

async function cacheList(cache, paths){
  for(let i = 0; i < paths.length; i += BATCH){
    const part = paths.slice(i, i + BATCH);
    const results = await Promise.allSettled(part.map(async p => {
      const req = new Request(new URL(p, base), { cache: 'no-cache' });
      if(await cache.match(req)) return;
      const res = await fetch(req);
      if(res.ok) await cache.put(req, res);
    }));
    // Out of room: stop here and keep what is cached.
    if(results.some(r => r.status === 'rejected' && r.reason && r.reason.name === 'QuotaExceededError')) return false;
  }
  return true;
}

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    let m;
    try { m = await manifest(); } catch { return; }
    // Only the shell here (small and quick: iOS allows an install so long).
    await cacheList(cache, ['./', ...m.shell, 'assets-manifest.json']);
    /* Assets unchanged since the last build (same fingerprint) are copied
       across from its cache, so an update does not download the field again.
       The rest arrive through the title-screen loader (js/asset-loader.js),
       which puts what it fetches into this cache. */
    const want = new Map(m.files.filter(f => f.tier <= 2).map(f => [f.path, f.h]));
    for(const k of await caches.keys()){
      if(!k.startsWith('fc-') || k === CACHE) continue;
      const old = await caches.open(k);
      const om = await old.match(new URL('assets-manifest.json', base));
      if(!om) continue;
      let prev; try { prev = await om.json(); } catch { continue; }
      for(const f of prev.files || []){
        if(!want.has(f.path) || want.get(f.path) !== f.h) continue;
        const req = new Request(new URL(f.path, base));
        const hit = await old.match(req);
        if(hit) { try { await cache.put(req, hit); } catch { break; } }
      }
    }
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for(const k of await caches.keys()) if(k.startsWith('fc-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

/* The page, code and data are handed over marked "check every time": the
   server says they are fresh for ten minutes (GitHub Pages), and the browser
   would otherwise reuse them from its own cache without asking this worker,
   so an update could take that long to arrive. */
function revalidate(res){
  if(res.type === 'opaque' || res.status !== 200) return res;
  const h = new Headers(res.headers);
  h.set('Cache-Control', 'no-cache');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
const NETWORK_FIRST = p => p === '' || p === 'index.html' || p === 'assets-manifest.json' || /^(js|data)\//.test(p) || p.endsWith('.html');

self.addEventListener('fetch', event => {
  const req = event.request;
  if(req.method !== 'GET') return;
  const url = new URL(req.url);
  const p = rel(url);
  if(p == null) return;                         // another site: online play, telemetry, fonts
  if(url.search && !/^(js|data)\//.test(p)) return;   // ?units=, ?fps etc on the page go to the network as usual
  if(NETWORK_FIRST(p)){
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        // By URL: a navigation's own Request cannot be re-sent with options.
        const res = await fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' });
        if(res.ok) cache.put(new Request(new URL(p === '' ? './' : p, base)), res.clone()).catch(() => {});
        return revalidate(res);
      } catch {
        const hit = (await cache.match(req, { ignoreSearch: true })) || (await cache.match(new URL(p === '' ? './' : p, base)));
        return hit ? revalidate(hit) : Response.error();
      }
    })());
    return;
  }
  if(!assetSet && !/^(assets|audio)\//.test(p)) return;
  if(assetSet && !assetSet.has(p)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    if(hit) return hit;
    const res = await fetch(req);
    // Audio may be asked for in ranges; only whole files are kept.
    if(res.ok && res.status === 200) cache.put(req, res.clone()).catch(() => {});
    return res;
  })());
});

// The asset list survives a worker restart (it is not kept between wake-ups).
manifest().catch(() => {});
