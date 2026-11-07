/* =========================================================
   ISO LAB (prototype only, 7 Nov 2026)

   A Grognards battlefield as a 3D isometric map with animated sprite
   armies, for judging the look and the performance on a phone before any
   decision is made. Loads a real campaign battle through the game's own
   modules (js/operations.js setupOperation), so the armies stand where the
   game puts them; draws it with three.js r128. The game itself is untouched.
========================================================= */
import { COLS, ROWS, state } from '../js/data-core.js';
import { setupOperation } from '../js/operations.js';
import { setFastAnimationMode } from '../js/render-board.js';
import { buildWorld, WATER_Y } from '../js/board3d-world.js';
import { Army, SETTINGS, SIZES } from './iso-figures.js';
import { OrbitRig } from '../js/board3d-camera.js';

const THREE = globalThis.THREE;
const $ = id => document.getElementById(id);
const BATTLES = [
  ['waterloo-waterloo-britain', 'Waterloo'], ['waterloo-ligny-prussia', 'Ligny'], ['waterloo-hougoumont-britain', 'Hougoumont'],
  ['peninsula-talavera-britain', 'Talavera'], ['peninsula-bussaco-britain', 'Bussaco'], ['peninsula-salamanca-britain', 'Salamanca'], ['peninsula-coa-britain', 'The Côa'],
];

/* The game's preloads alone pass the default 250-entry resource buffer; keep every entry so the readout's download figures are whole. */
try { performance.setResourceTimingBufferSize(4000); } catch { /* an old browser */ }
const app = { quality: 'low', style: 'A', showGrid: true, showLabels: true, fps: 0, frames: 0, lastFpsAt: performance.now() };

function setupRenderer(){
  const canvas = $('iso');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: app.quality === 'high', powerPreference: 'high-performance' });
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.shadowMap.enabled = app.quality === 'high';
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  app.renderer = renderer;
  applyPixelRatio();
}
function applyPixelRatio(){
  app.renderer.setPixelRatio(app.quality === 'high' ? Math.min(2, window.devicePixelRatio || 1) : 1);
  resize();
}
function resize(){
  const c = $('iso'), w = c.clientWidth || window.innerWidth, h = c.clientHeight || window.innerHeight;
  app.renderer.setSize(w, h, false);
  if(app.rig) app.rig.resize(w, h);
}

function buildScene(){
  if(app.scene){ app.scene.traverse(o => { if(o.geometry) o.geometry.dispose(); }); }
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#1b1f17');
  const hemi = new THREE.HemisphereLight('#dfe8ff', '#4a4030', 0.55);
  const sun = new THREE.DirectionalLight('#ffe8c0', 0.95);
  // late afternoon, from the upper right (the terrain art's light)
  sun.position.set(COLS * 0.8, Math.max(COLS, ROWS) * 0.9, ROWS * 1.1);
  sun.target.position.set(COLS / 2, 0, ROWS / 2);
  if(app.quality === 'high'){
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const r = Math.max(COLS, ROWS) * 0.7;
    Object.assign(sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: 1, far: 80 });
    sun.shadow.bias = -0.0005;
  }
  scene.add(hemi, sun, sun.target);
  app.scene = scene;
  app.world = buildWorld(scene, app.quality);
  app.world.grid.visible = app.showGrid;
  for(const l of app.world.labels) l.visible = app.showLabels;
  app.army = new Army(scene, app.world.ground);
}

async function loadBattle(id){
  $('note').textContent = 'Setting up ' + id + '…';
  setFastAnimationMode(true);
  setupOperation(id, 'red');
  // reserves (reinforcements) stay off the field; the lab draws what is on the board
  if(app.rig){ app.rig.cols = COLS; app.rig.rows = ROWS; app.rig.reset(); }
  buildScene();
  await app.army.setStyle(app.style).catch(e => { $('note').textContent = 'Style ' + app.style + ' art missing: ' + e.message; throw e; });
  fillUnits();
  $('note').textContent = '';
}

function fillUnits(){
  const sel = $('unit');
  sel.innerHTML = '';
  for(const u of state.units){
    if(u.removed || u.x < 0 || u.type === 'BRIGADIER' && false) continue;
    const o = document.createElement('option');
    o.value = u.id; o.textContent = `${u.side === 'red' ? 'C' : 'F'}: ${u.historicalName || u.type} (${u.type.toLowerCase().replace('_', ' ')})`;
    sel.appendChild(o);
  }
}
const chosen = () => state.units.find(u => u.id === $('unit').value);

function bindUI(){
  const sel = $('battle');
  for(const [id, name] of BATTLES){ const o = document.createElement('option'); o.value = id; o.textContent = name; sel.appendChild(o); }
  sel.onchange = () => loadBattle(sel.value);
  for(const b of document.querySelectorAll('[data-style]')) b.onclick = async () => {
    app.style = b.dataset.style;
    document.querySelectorAll('[data-style]').forEach(x => x.classList.toggle('on', x === b));
    try { await app.army.setStyle(app.style); } catch(e) { $('note').textContent = 'Style B sheets not found (run tools/sprites/render-sheets.mjs): ' + e.message; }
  };
  for(const b of document.querySelectorAll('[data-quality]')) b.onclick = () => {
    app.quality = b.dataset.quality;
    document.querySelectorAll('[data-quality]').forEach(x => x.classList.toggle('on', x === b));
    app.renderer.dispose();
    setupRenderer();
    buildScene();
    app.army.setStyle(app.style).then(fillUnits);
  };
  $('grid').onclick = () => { app.showGrid = !app.showGrid; app.world.grid.visible = app.showGrid; $('grid').classList.toggle('on', app.showGrid); };
  $('labels').onclick = () => { app.showLabels = !app.showLabels; for(const l of app.world.labels) l.visible = app.showLabels; $('labels').classList.toggle('on', app.showLabels); };
  $('ortho').onclick = () => { app.rig.orthographic = !app.rig.orthographic; $('ortho').classList.toggle('on', app.rig.orthographic); resize(); };
  $('reset').onclick = () => { app.rig.reset(); $('tilt').value = Math.round(app.rig.pitch * 180 / Math.PI); };
  $('tilt').oninput = () => app.rig.tiltTo(Number($('tilt').value));
  $('size').oninput = () => { SETTINGS.size = Number($('size').value) / 100; document.querySelectorAll('[data-size]').forEach(x => x.classList.remove('on')); };
  for(const b of document.querySelectorAll('[data-size]')) b.onclick = () => { SETTINGS.size = SIZES[b.dataset.size]; $('size').value = Math.round(SETTINGS.size * 100); document.querySelectorAll('[data-size]').forEach(x => x.classList.toggle('on', x === b)); };
  $('march').onclick = () => { const u = chosen(); if(u) app.army.march(u, 1); };
  $('volley').onclick = () => { const u = chosen(); if(u) app.army.volley(u); };
  $('charge').onclick = () => { const u = chosen(); if(u) app.army.march(u, 2, true); };
  $('fall').onclick = () => { const u = chosen(); if(u) app.army.fall(u); };
  $('allmarch').onclick = () => { for(const u of state.units) if(!u.removed && u.x >= 0) app.army.march(u, 1); };
  $('allvolley').onclick = () => { for(const u of state.units) if(!u.removed && u.x >= 0 && /INFANTRY|GUARD|ARTILLERY/.test(u.type)) app.army.volley(u); };
  $('unitreset').onclick = () => { const u = chosen(); if(u) app.army.resetUnit(u); };
  $('fold').onclick = () => document.body.classList.toggle('folded');
  /* A tap on the board picks the square under it (a ray into the ground), and the unit standing there. */
  app.rig.onTap = (cx, cy) => {
    const c = $('iso'), r = c.getBoundingClientRect();
    const ndc = new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, app.rig.camera);
    const hit = ray.intersectObject(app.world.groundMesh)[0];
    if(!hit){ app.world.markSquare(null); return; }
    const x = Math.floor(hit.point.x), y = Math.floor(hit.point.z);
    if(x < 0 || y < 0 || x >= COLS || y >= ROWS){ app.world.markSquare(null); return; }
    app.world.markSquare(x, y);
    const here = state.units.filter(u => !u.removed && u.x === x && u.y === y);
    const col = String.fromCharCode(65 + x), row = y + 1;
    if(here.length){ $('unit').value = here[0].id; toast(`${here.map(u => u.historicalName || u.type).join(' and ')} at ${col}${row}`); }
    else toast(`${col}${row}: ${state.terrain[y][x].toLowerCase().replace('_', ' ')}`);
  };
  window.addEventListener('resize', resize);
}

/* The on-screen numbers: frames per second, draw calls, triangles, figures, and what the page downloaded. */
function readout(){
  const t = performance.now();
  app.frames++;
  if(t - app.lastFpsAt >= 500){
    app.fps = Math.round(app.frames * 1000 / (t - app.lastFpsAt)); app.frames = 0; app.lastFpsAt = t;
    const info = app.renderer.info.render;
    /* What came down the line: the lab's own files (this page, three.js, the
       figure sheets, the smoke) apart from the game's own preloads (its tiles,
       portraits, dice and icons start loading when its modules are imported;
       a phone that has played the game already has them cached). */
    let lab = 0, game = 0;
    const size = e => e.transferSize || e.encodedBodySize || e.decodedBodySize || 0;
    const isLab = n => /lab\/|three\.min\.js|units-pixel|sprites3d|effects\/smoke|fonts\./.test(n);
    for(const e of performance.getEntriesByType('resource')){ if(isLab(e.name)) lab += size(e); else game += size(e); }
    const nav = performance.getEntriesByType('navigation')[0];
    if(nav) lab += size(nav);
    const mb = b => (b / 1048576).toFixed(2) + ' MB';
    $('stats').textContent = `${app.fps} fps · ${info.calls} draw calls · ${info.triangles.toLocaleString()} tris · ${app.army ? app.army.drawn : 0} figures · ${app.quality} @${app.renderer.getPixelRatio()}x · style ${app.style} · lab download ${mb(lab)} · game preloads ${mb(game)}`;
    app.stats = { fps: app.fps, calls: info.calls, triangles: info.triangles, figures: app.army ? app.army.drawn : 0, lab, game };
  }
}

let toastUntil = 0;
function toast(text){ $('note').textContent = text; toastUntil = performance.now() + 1800; }
function loop(){
  requestAnimationFrame(loop);
  const rig = app.rig;
  rig.apply();
  if(app.world && app.world.water && app.quality === 'high') app.world.water.position.y = WATER_Y + Math.sin(performance.now() / 900) * 0.004;
  if(app.army) app.army.update(rig.camera, rig.yaw);
  if(app.world && app.world.mills) for(const s of app.world.mills) s.rotation.z = performance.now() / 2600;
  if(toastUntil && performance.now() > toastUntil){ toastUntil = 0; $('note').textContent = ''; }
  app.renderer.render(app.scene, rig.camera);
  readout();
}

async function main(){
  if(!THREE){ $('note').textContent = 'three.js did not load (cdnjs unreachable?).'; return; }
  setupRenderer();
  app.rig = new OrbitRig($('iso'), COLS, ROWS);
  bindUI();
  resize();
  const first = new URLSearchParams(location.search).get('battle') || BATTLES[0][0];
  $('battle').value = first;
  const q = new URLSearchParams(location.search).get('quality'); if(q === 'high'){ app.quality = 'high'; document.querySelectorAll('[data-quality]').forEach(x => x.classList.toggle('on', x.dataset.quality === 'high')); app.renderer.dispose(); setupRenderer(); }
  const st = new URLSearchParams(location.search).get('style'); if(st === 'B'){ app.style = 'B'; document.querySelectorAll('[data-style]').forEach(x => x.classList.toggle('on', x.dataset.style === 'B')); }
  $('tilt').value = Math.round(app.rig.pitch * 180 / Math.PI);
  $('size').value = Math.round(SETTINGS.size * 100);
  await loadBattle(first);
  loop();
  window.__iso = app;   // for the check script (tools/lab/iso-check.mjs)
}
main().catch(e => { $('note').textContent = 'Failed: ' + e.message; console.error(e); });
