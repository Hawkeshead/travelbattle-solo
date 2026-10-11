/* =========================================================
   THE ASSET LOADER: everything ready before it is needed

   Art and sound used to be fetched the first time they were used, so an
   animation could run and finish before its frames or sound arrived. Now,
   from the moment the page opens (the title intro), this works through
   assets-manifest.json (written by tools/check-assets.mjs on every deploy):
   tier 1 (anything a battle needs) and then tier 2 (soon), a few files at a
   time. Each image is downloaded AND decoded (img.decode()), so it is ready
   to draw on its first frame; each effect sound is decoded into a Web Audio
   buffer (AudioManager.preloadEffects); music and ambience are only warmed.
   Tier 3 (legacy) is never preloaded.

   What it fetches it also puts in the service worker's cache for this build
   ('fc-<commit>', sw.js), so the next visit opens from the phone.

   - A thin brass line under the title shows the progress and hides when
     done. The menus stay usable throughout.
   - gateBattle: a battle that starts before tier 1 is ready waits for it
     under "Preparing the field…". Tier 2 never blocks. Once tier 1 is ready
     (and whenever the loader is not running at all: headless, the simulator,
     a page without the manifest) a battle starts at once, synchronously,
     exactly as before.
   - ready(url) / whenReady(urls, ms): for animations that want their frames
     (render-figures): has this decoded yet, and wait for these up to ms.
     imageFor(url): the decoded Image itself, for drawing.
========================================================= */
import { BUILD } from './build-info.js';
import { AudioManager } from './audio-manager.js';

const CONCURRENCY = 4;
const IMG = /\.(webp|png|jpe?g|gif|svg)$/i, EFFECT = /^audio\/(effects|ui)\/.*\.(wav|mp3|m4a|ogg)$/i;
const decoded = new Map();     // url -> Image (decoded) or true (other files)
const waiters = new Map();     // url -> [resolve]
let status = 'idle';           // idle | loading | done
let tier1Done = false, tier1Waiters = [];
let total = 0, doneCount = 0, tier1Total = 0, tier1Count = 0;
let cache = null;
export const CACHE_NAME = 'fc-' + (BUILD.commit || 'dev');

export const ready = url => decoded.has(url);
export const imageFor = url => { const v = decoded.get(url); return v && v !== true ? v : null; };
export const tier1Ready = () => tier1Done || status === 'idle';
export function whenTier1(){ return tier1Ready() ? Promise.resolve() : new Promise(r => tier1Waiters.push(r)); }
/* Resolves when every url is ready, or after ms, whichever is first. */
export function whenReady(urls, ms = 300){
  const left = urls.filter(u => !decoded.has(u));
  if(!left.length || status === 'idle') return Promise.resolve(true);
  return Promise.race([
    Promise.all(left.map(u => new Promise(r => (waiters.get(u) || waiters.set(u, []).get(u)).push(r)))).then(() => true),
    new Promise(r => setTimeout(() => r(false), ms)),
  ]);
}
function mark(url, value){
  decoded.set(url, value);
  const w = waiters.get(url); if(w){ waiters.delete(url); w.forEach(r => r()); }
}

/* One file, downloaded and decoded. An image is asked for by its own URL, so
   the browser shares the download with the game's own request for it (the
   board tiles, the dice) rather than fetching it twice. While no service
   worker controls the page yet (the first visit's first seconds), what is
   loaded is also put into this build's cache by hand; after that the worker
   keeps everything that passes through it. A failure is passed over: the game
   then fetches that file on demand, as it always did. */
const controlled = () => typeof navigator !== 'undefined' && navigator.serviceWorker && navigator.serviceWorker.controller;
async function keep(url, res){
  if(!cache || controlled()) return;
  try {
    if(await cache.match(url)) return;
    const r = res || await fetch(url);
    if(r.ok && r.status === 200) await cache.put(url, r);
  } catch { cache = null; }   // out of room: stop caching, keep loading
}
async function loadOne(f){
  const url = f.path;
  try {
    if(IMG.test(url)){
      const img = new Image();
      img.src = url;
      await img.decode();
      mark(url, img);
      await keep(url);
    } else if(EFFECT.test(url) && AudioManager.loadEffect){
      // Fetched and decoded into a Web Audio buffer, ready to play at once.
      await AudioManager.loadEffect(url).catch(() => {});
      mark(url, true);
      await keep(url);
    } else {
      const res = await fetch(url);
      if(!res.ok) throw new Error(res.status);
      const copy = res.clone();
      await res.arrayBuffer();
      mark(url, true);
      await keep(url, copy);
    }
  } catch {
    const w = waiters.get(url); if(w){ waiters.delete(url); w.forEach(r => r()); }
  }
  doneCount++;
  if(f.tier === 1) tier1Count++;
  progress();
}
async function runTier(list){
  let i = 0;
  const worker = async () => { while(i < list.length) await loadOne(list[i++]); };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

/* Starts the loading (boot.js, at once). Safe to call more than once. */
export async function startAssetLoading(){
  if(status !== 'idle' || typeof document === 'undefined' || typeof fetch !== 'function') return;
  if(typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent || '')) return;
  let m;
  try { const r = await fetch('assets-manifest.json', { cache: 'no-cache' }); if(!r.ok) return; m = await r.json(); }
  catch { return; }
  status = 'loading';
  try { if(typeof caches !== 'undefined') cache = await caches.open(CACHE_NAME); } catch { cache = null; }
  const t1 = m.files.filter(f => f.tier === 1), t2 = m.files.filter(f => f.tier === 2);
  total = t1.length + t2.length; tier1Total = t1.length;
  const t0 = performance.now();
  showProgress();
  await runTier(t1);
  tier1Done = true;
  loaderStats.tier1Ms = Math.round(performance.now() - t0);
  tier1Waiters.forEach(r => r()); tier1Waiters = [];
  await runTier(t2);
  loaderStats.allMs = Math.round(performance.now() - t0);
  status = 'done';
  progress();
}
export const loaderStats = { tier1Ms: null, allMs: null, get done(){ return doneCount; }, get total(){ return total; } };

/* ---------- the progress line and the battle gate ---------- */
let bar = null, gateEl = null;
function showProgress(){
  if(bar) return;
  const style = document.createElement('style');
  style.textContent = `
#assetProgress{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(2px + env(safe-area-inset-bottom,0px));width:min(240px,40vw);height:2px;z-index:31;
  background:rgba(20,14,6,.45);border-radius:1px;overflow:hidden;pointer-events:none;transition:opacity .6s;}
#assetProgress i{display:block;height:100%;width:0;background:linear-gradient(90deg,#9a7a36,#e2c47a);transition:width .3s;}
html.title-away #assetProgress{opacity:0;}
#assetProgress.done{opacity:0;}
#assetGate{position:fixed;inset:0;z-index:95;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;
  background:rgba(18,12,6,.55);color:#f2e3c0;font:italic 600 19px 'Cormorant Garamond',Georgia,serif;text-shadow:0 1px 3px rgba(0,0,0,.7);}
#assetGate .g-line{width:min(240px,50vw);height:2px;background:rgba(255,255,255,.15);border-radius:1px;overflow:hidden;}
#assetGate .g-line i{display:block;height:100%;width:0;background:linear-gradient(90deg,#9a7a36,#e2c47a);transition:width .3s;}`;
  document.head.appendChild(style);
  bar = document.createElement('div');
  bar.id = 'assetProgress';
  bar.innerHTML = '<i></i>';
  document.body.appendChild(bar);
}
function progress(){
  const share = total ? doneCount / total : 1;
  if(bar){ bar.firstChild.style.width = (share * 100).toFixed(1) + '%'; if(status === 'done') bar.classList.add('done'); }
  if(gateEl){ gateEl.querySelector('i').style.width = (tier1Total ? tier1Count / tier1Total * 100 : 100).toFixed(1) + '%'; }
}
/* A battle's starting point calls this first: true means go on now; false
   means it has been put off and `run` will be called once tier 1 is ready. */
let pendingRun = null;
export function gateBattle(run){
  if(tier1Ready()) return true;
  const first = !pendingRun;
  pendingRun = run;   // a second tap while waiting replaces the first, never doubles it
  if(!gateEl){
    gateEl = document.createElement('div');
    gateEl.id = 'assetGate';
    gateEl.innerHTML = '<div>Preparing the field…</div><div class="g-line"><i></i></div>';
    document.body.appendChild(gateEl);
    progress();
  }
  if(first) whenTier1().then(() => {
    if(gateEl){ gateEl.remove(); gateEl = null; }
    const r = pendingRun; pendingRun = null;
    if(r) r();
  });
  return false;
}
