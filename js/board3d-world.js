/* =========================================================
   ISO LAB: THE GROUND (prototype only, 7 Nov 2026)

   Builds a Grognards battlefield in three.js from the game's own state
   (state.terrain, state.roads, state.water, state.places): a height field
   with gentle hills and cut river channels, a painted ground texture in the
   game's palette (farmland stripes, worn roads laid out by the game's own
   road rules in js/terrain-v2.js), instanced trees and cottages, bridges, a
   water plane, a grid you can toggle, and floating place names.

   Reads the game's state and pure helpers; writes nothing back. three.js is
   the page's global THREE (r128 from cdnjs).
========================================================= */
import { COLS, ROWS, state } from './data-core.js';
import { ROAD, buildRoadGraph, grassPicks, roadChains, smoothChain } from './terrain-v2.js';

/* three.js is loaded on demand (js/board3d.js loadThree), so it is read when first used, not when this module loads. */
let THREE = globalThis.THREE;

/* The game's palette (render-board.js terrainColor and the v2 art). */
export const PALETTE = {
  table: '#34241A',
  grass: ['#4a5f36', '#4f6539', '#46593a', '#536a3c'],
  hill: ['#5c6a3a', '#66733f', '#5a6536'],
  field: ['#a08a44', '#b89a3f', '#8f7a3a'],
  woodsFloor: '#2d4126',
  village: '#6b5847',
  road: ROAD.STROKES,
  river: { bank: 'rgba(72,58,34,0.8)', channel: '#2e4448', water: '#5e9aa6', ford: '#b9a56a' },
  rock: ['#8a8578', '#9a9486', '#767164'],
  canopy: ['#2f4a28', '#3a5a2e', '#2a4323', '#44633a'],
  trunk: '#4a3524',
  wall: ['#cbb996', '#bfae8c', '#d6c6a4'],
  roof: ['#8a4f36', '#6b5847', '#7a6248'],
  stone: '#8d8678',
  wood: '#6e5235',
};

export const HS = 6;              // height-field subdivisions per square
export const HILL_H = 0.62;       // a hill's rise, in squares
export const WATER_Y = -0.075;    // the water surface
const RIVER_DEPTH = 0.2, FORD_DEPTH = 0.09, RIVER_HALF = 0.3;

/* Seeded noise, so the same battle looks the same on every load. */
function mulberry(seed){ let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const hash2 = (x, y, s) => { const v = ((x * 73856093) ^ (y * 19349663) ^ (s * 83492791)) % 1000003; return v < 0 ? v + 1000003 : v; };

/* The river's course as a dense polyline in line coordinates (as render-board riverPoints). */
function riverPoints(course){
  let pts = [];
  for(let i = 0; i < course.length - 1; i++){
    const [a, b] = [course[i], course[i + 1]];
    const n = Math.max(2, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) * 12));
    for(let k = 0; k < n; k++) pts.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
  }
  pts.push(course[course.length - 1].slice());
  for(let pass = 0; pass < 2; pass++){
    const Wn = 4;
    pts = pts.map((p, i) => {
      if(i < Wn || i > pts.length - 1 - Wn) return p;
      let sx = 0, sy = 0; for(let k = -Wn; k <= Wn; k++){ sx += pts[i + k][0]; sy += pts[i + k][1]; }
      return [sx / (2 * Wn + 1), sy / (2 * Wn + 1)];
    });
  }
  return pts;
}
const distToPolyline = (px, py, pts) => {
  let best = Infinity;
  for(let i = 0; i < pts.length - 1; i++){
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1e-9;
    let t = ((px - ax) * dx + (py - ay) * dy) / l2; t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
    if(d < best) best = d;
  }
  return best;
};
const inFord = (x, y, fords) => (fords || []).some(([x0, x1, y0, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1);

/* ---------- the height field ---------- */
export class Ground {
  constructor(){
    THREE = globalThis.THREE;
    this.cols = COLS; this.rows = ROWS;
    this.w = this.cols * HS + 1; this.h = this.rows * HS + 1;
    this.height = new Float32Array(this.w * this.h);
    this.build();
  }
  build(){
    const { cols, rows, w, h } = this;
    const T = state.terrain;
    const water = state.water;
    const river = water && water.spec ? riverPoints(water.spec.course) : null;
    const fords = water && water.spec ? water.spec.fords : null;
    // 1. a hill mask, blurred into gentle slopes
    const mask = new Float32Array(w * h);
    for(let j = 0; j < h; j++) for(let i = 0; i < w; i++){
      const x = Math.min(cols - 1, Math.floor(i / HS)), y = Math.min(rows - 1, Math.floor(j / HS));
      mask[j * w + i] = T[y][x] === 'HILL' ? 1 : 0;
    }
    const R = HS, k = [];
    for(let d = -R; d <= R; d++) k.push(Math.exp(-(d * d) / (2 * (R / 2.8) ** 2)));
    const ks = k.reduce((a, b) => a + b, 0);
    const tmp = new Float32Array(w * h);
    for(let j = 0; j < h; j++) for(let i = 0; i < w; i++){
      let s = 0; for(let d = -R; d <= R; d++){ const ii = Math.max(0, Math.min(w - 1, i + d)); s += mask[j * w + ii] * k[d + R]; }
      tmp[j * w + i] = s / ks;
    }
    const rnd = mulberry(7);
    for(let j = 0; j < h; j++) for(let i = 0; i < w; i++){
      let s = 0; for(let d = -R; d <= R; d++){ const jj = Math.max(0, Math.min(h - 1, j + d)); s += tmp[jj * w + i] * k[d + R]; }
      let v = (s / ks) * HILL_H + (rnd() - 0.5) * 0.012;
      // 2. the river channel, cut into the ground; fords shallower
      if(river){
        const lx = i / HS, ly = j / HS;    // line coordinates
        const d = distToPolyline(lx, ly, river);
        if(d < RIVER_HALF + 0.12){
          const depth = inFord(lx, ly, fords) ? FORD_DEPTH : RIVER_DEPTH;
          const t = Math.max(0, Math.min(1, (RIVER_HALF + 0.12 - d) / 0.24));
          const cut = depth * (t * t * (3 - 2 * t));
          v = Math.min(v, 0.02) - cut;
        }
      }
      this.height[j * w + i] = v;
    }
  }
  /* Height at a board position (x, z in squares), bilinear. */
  heightAt(x, z){
    const fx = Math.max(0, Math.min(this.w - 1.001, x * HS)), fz = Math.max(0, Math.min(this.h - 1.001, z * HS));
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
    const H = this.height, w = this.w;
    const a = H[j * w + i], b = H[j * w + i + 1], c = H[(j + 1) * w + i], d = H[(j + 1) * w + i + 1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  }
  /* How steep the ground is at a point (rise per square). */
  slopeAt(x, z){
    const e = 0.08;
    return Math.hypot(this.heightAt(x + e, z) - this.heightAt(x - e, z), this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e);
  }
  geometry(){
    const { w, h, cols, rows } = this;
    const pos = new Float32Array(w * h * 3), uv = new Float32Array(w * h * 2);
    for(let j = 0; j < h; j++) for(let i = 0; i < w; i++){
      const n = j * w + i;
      pos[n * 3] = i / HS; pos[n * 3 + 1] = this.height[n]; pos[n * 3 + 2] = j / HS;
      uv[n * 2] = i / HS / cols; uv[n * 2 + 1] = 1 - j / HS / rows;
    }
    const idx = [];
    for(let j = 0; j < h - 1; j++) for(let i = 0; i < w - 1; i++){
      const a = j * w + i, b = a + 1, c = a + w, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }
}

/* ---------- the painted ground ---------- */
const P = 64;   // texture pixels per square
export function paintGround(){
  THREE = globalThis.THREE;
  const cols = COLS, rows = ROWS, T = state.terrain;
  const c = document.createElement('canvas'); c.width = cols * P; c.height = rows * P;
  const g = c.getContext('2d');
  const rnd = mulberry(11);
  const overlay = new Set();
  const picks = grassPicks(T, overlay);
  // base colour per square, in the game's palette
  for(let y = 0; y < rows; y++) for(let x = 0; x < cols; x++){
    const t = T[y][x];
    let col;
    if(t === 'HILL') col = PALETTE.hill[hash2(x, y, 1) % PALETTE.hill.length];
    else if(t === 'PLOUGHED_FIELD') col = PALETTE.field[hash2(x, y, 3) % PALETTE.field.length];
    else if(t === 'WOODS') col = PALETTE.woodsFloor;
    else if(t === 'BUILDING') col = PALETTE.village;
    else col = PALETTE.grass[(picks[y][x].plain - 1) % PALETTE.grass.length];
    g.fillStyle = col; g.fillRect(x * P, y * P, P, P);
  }
  // a soft blend between neighbouring squares, so the ground is not a checkerboard
  g.globalAlpha = 0.35;
  for(let y = 0; y < rows; y++) for(let x = 0; x < cols; x++){
    const t = T[y][x];
    if(t === 'PLOUGHED_FIELD' || t === 'BUILDING') continue;
    const col = t === 'WOODS' ? PALETTE.woodsFloor : t === 'HILL' ? PALETTE.hill[0] : PALETTE.grass[(x + y) % 4];
    g.fillStyle = col;
    g.beginPath(); g.arc(x * P + P / 2, y * P + P / 2, P * 0.9, 0, Math.PI * 2); g.fill();
  }
  g.globalAlpha = 1;
  // hills: paler, drier grass towards the crown, so the rise reads from above too
  for(let y = 0; y < rows; y++) for(let x = 0; x < cols; x++){
    if(T[y][x] !== 'HILL') continue;
    const g2 = g.createRadialGradient(x * P + P / 2, y * P + P / 2, P * 0.15, x * P + P / 2, y * P + P / 2, P * 0.95);
    g2.addColorStop(0, 'rgba(176,170,120,0.55)'); g2.addColorStop(1, 'rgba(176,170,120,0)');
    g.fillStyle = g2; g.fillRect(x * P - P, y * P - P, 3 * P, 3 * P);
  }
  // speckle
  for(let n = 0; n < cols * rows * 60; n++){
    const x = rnd() * c.width, y = rnd() * c.height;
    g.fillStyle = rnd() < 0.5 ? 'rgba(20,30,10,0.18)' : 'rgba(200,210,150,0.12)';
    g.fillRect(x, y, 2 + rnd() * 2, 1 + rnd() * 2);
  }
  // farmland: furrows, the direction alternating as the game's farm tiles mirror
  for(let y = 0; y < rows; y++) for(let x = 0; x < cols; x++){
    if(T[y][x] !== 'PLOUGHED_FIELD') continue;
    const vertical = ((x + y) % 2) === 1;
    g.strokeStyle = 'rgba(70,50,20,0.35)'; g.lineWidth = 2;
    for(let k = 4; k < P; k += 7){
      g.beginPath();
      if(vertical){ g.moveTo(x * P + k, y * P + 2); g.lineTo(x * P + k, y * P + P - 2); }
      else { g.moveTo(x * P + 2, y * P + k); g.lineTo(x * P + P - 2, y * P + k); }
      g.stroke();
    }
    g.strokeStyle = 'rgba(90,70,30,0.6)'; g.lineWidth = 3; g.strokeRect(x * P + 1.5, y * P + 1.5, P - 3, P - 3);
  }
  // villages: a trodden yard
  for(let y = 0; y < rows; y++) for(let x = 0; x < cols; x++){
    if(T[y][x] !== 'BUILDING') continue;
    for(let n = 0; n < 40; n++){ g.fillStyle = rnd() < 0.5 ? 'rgba(40,30,20,0.25)' : 'rgba(160,140,110,0.25)'; g.fillRect(x * P + rnd() * P, y * P + rnd() * P, 3, 3); }
  }
  // roads: the game's own road rules (terrain-v2), drawn as worn tracks
  const adj = buildRoadGraph(T, () => false, state.roads || null);
  const ident = (x, y) => ({ x, y: y + (0.5 - ROAD.FACE_CY) });   // the face centre of a flat square is its middle
  g.lineCap = 'round'; g.lineJoin = 'round';
  for(const ch of roadChains(adj)){
    const Q = smoothChain(ch, ident);
    const path = () => { g.beginPath(); Q.forEach(([x, y], i) => i ? g.lineTo(x * P, y * P) : g.moveTo(x * P, y * P)); };
    for(const [wd, col] of ROAD.STROKES){ path(); g.lineWidth = wd * P; g.strokeStyle = col; g.stroke(); }
  }
  // the river channel, banks and fords
  const water = state.water;
  if(water && water.spec){
    const pts = riverPoints(water.spec.course).map(([x, y]) => [x * P, y * P]);   // line coordinates: the grid lines are at whole numbers
    const path = () => { g.beginPath(); pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); };
    for(const [wd, col] of [[0.8, PALETTE.river.bank], [0.66, '#5a6640'], [0.56, PALETTE.river.channel], [0.4, '#263a3e']]){ path(); g.lineWidth = wd * P; g.strokeStyle = col; g.stroke(); }
    for(const [x0, x1, y0, y1] of (water.spec.fords || [])){
      g.save(); g.beginPath(); g.rect(x0 * P, y0 * P, (x1 - x0) * P, (y1 - y0) * P); g.clip();
      path(); g.lineWidth = 0.6 * P; g.strokeStyle = PALETTE.river.ford; g.stroke();
      for(let n = 0; n < 60; n++){ g.fillStyle = rnd() < 0.5 ? 'rgba(90,80,50,0.5)' : 'rgba(230,220,180,0.6)'; const i = Math.floor(rnd() * pts.length); g.fillRect(pts[i][0] + (rnd() - 0.5) * P * 0.4, pts[i][1] + (rnd() - 0.5) * P * 0.4, 2, 2); }
      g.restore();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4; tex.encoding = THREE.sRGBEncoding;
  return tex;
}

/* Three-step toon shading, as Arkside's gradient map. */
export function gradientMap(){
  THREE = globalThis.THREE;
  const data = new Uint8Array([90, 160, 255]);
  const t = new THREE.DataTexture(data, 3, 1, THREE.LuminanceFormat);
  t.minFilter = THREE.NearestFilter; t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true;
  return t;
}

/* ---------- the scene ---------- */
export function buildWorld(scene, quality){
  THREE = globalThis.THREE;
  const out = { props: [], ground: null };
  const ground = new Ground();
  out.ground = ground;
  const grad = gradientMap();
  // the palette's hex values are sRGB; the renderer outputs sRGB, so materials take them in linear
  const lin = c => new THREE.Color(c).convertSRGBToLinear();
  const toon = (opts) => { const o = Object.assign({ gradientMap: grad }, opts); if(o.color) o.color = lin(o.color); return new THREE.MeshToonMaterial(o); };

  // the table under the board
  const table = new THREE.Mesh(new THREE.PlaneGeometry(COLS + 6, ROWS + 6), new THREE.MeshBasicMaterial({ color: lin(PALETTE.table) }));
  table.rotation.x = -Math.PI / 2; table.position.set(COLS / 2, -0.32, ROWS / 2);
  scene.add(table); out.props.push(table);

  // the ground
  const groundMesh = new THREE.Mesh(ground.geometry(), toon({ map: paintGround() }));
  groundMesh.receiveShadow = true;
  scene.add(groundMesh); out.props.push(groundMesh); out.groundMesh = groundMesh;
  // its sides (a skirt), so the board reads as a slab
  const skirt = new THREE.Mesh(new THREE.BoxGeometry(COLS, 0.3, ROWS), toon({ color: '#3b2a1e' }));
  skirt.position.set(COLS / 2, -0.15 - 0.16, ROWS / 2);
  scene.add(skirt); out.props.push(skirt);

  // the water: one plane, seen only in the channels the ground is cut below it
  if(state.water && state.water.spec){
    const wm = new THREE.MeshPhongMaterial({ color: lin(PALETTE.river.water), transparent: true, opacity: 0.8, shininess: 90, specular: lin('#cfe6e0'), emissive: lin('#1a3a44') });
    const wp = new THREE.Mesh(new THREE.PlaneGeometry(COLS, ROWS), wm);
    wp.rotation.x = -Math.PI / 2; wp.position.set(COLS / 2, WATER_Y, ROWS / 2);
    scene.add(wp); out.props.push(wp); out.water = wp;
  }

  // trees: woods squares, and a few lone oaks on open squares (as the game's detail tiles)
  const T = state.terrain, rnd = mulberry(23);
  const picks = grassPicks(T, new Set());
  const trees = [];
  for(let y = 0; y < ROWS; y++) for(let x = 0; x < COLS; x++){
    if(T[y][x] === 'WOODS'){
      const n = quality === 'high' ? 14 : 9;
      for(let k = 0; k < n; k++) trees.push({ x: x + 0.06 + rnd() * 0.88, z: y + 0.06 + rnd() * 0.88, s: 0.7 + rnd() * 0.6 });
    } else if(T[y][x] === 'OPEN' && picks[y][x].detail >= 0 && picks[y][x].detail < 6){
      // the oaks: single, pair or trio, kept to a corner so the square's middle is clear for units
      const n = 1 + (picks[y][x].detail % 3);
      for(let k = 0; k < n; k++) trees.push({ x: x + 0.1 + rnd() * 0.3 + (picks[y][x].detail % 2 ? 0.5 : 0), z: y + 0.08 + rnd() * 0.25, s: 0.9 + rnd() * 0.4 });
    }
  }
  if(trees.length){
    const canopyGeo = new THREE.ConeGeometry(0.16, 0.42, 7);
    const trunkGeo = new THREE.CylinderGeometry(0.03, 0.045, 0.2, 5);
    const canopies = new THREE.InstancedMesh(canopyGeo, toon({ color: '#ffffff' }), trees.length);
    const trunks = new THREE.InstancedMesh(trunkGeo, toon({ color: PALETTE.trunk }), trees.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), sc = new THREE.Vector3();
    const col = new THREE.Color();
    trees.forEach((t, i) => {
      const h = ground.heightAt(t.x, t.z);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * Math.PI * 2);
      sc.set(t.s, t.s, t.s);
      m.compose(v.set(t.x, h + 0.2 * t.s + 0.21 * t.s, t.z), q, sc); canopies.setMatrixAt(i, m);
      canopies.setColorAt(i, col.set(PALETTE.canopy[Math.floor(rnd() * PALETTE.canopy.length)]).convertSRGBToLinear());
      m.compose(v.set(t.x, h + 0.1 * t.s, t.z), q, sc); trunks.setMatrixAt(i, m);
    });
    canopies.castShadow = trunks.castShadow = quality === 'high';
    scene.add(canopies, trunks); out.props.push(canopies, trunks);
  }

  // rocky outcrops where the hills' slopes are steep
  const rocks = [];
  for(let y = 0; y < ROWS; y++) for(let x = 0; x < COLS; x++){
    const nearHill = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => T[y + b] && T[y + b][x + a] === 'HILL');
    if(!nearHill) continue;
    const n = quality === 'high' ? 10 : 7;
    for(let k = 0; k < n; k++){
      const px = x + rnd(), pz = y + rnd();
      const sl = ground.slopeAt(px, pz);
      if(sl < 0.42 || rnd() > (sl - 0.3)) continue;
      rocks.push({ x: px, z: pz, s: 0.05 + rnd() * 0.07 + sl * 0.06 });
    }
  }
  if(rocks.length){
    const rockGeo = new THREE.DodecahedronGeometry(1, 0);
    const rm = new THREE.InstancedMesh(rockGeo, toon({ color: '#ffffff' }), rocks.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), sc = new THREE.Vector3(), col = new THREE.Color();
    rocks.forEach((r, i) => {
      q.setFromEuler(new THREE.Euler(rnd() * 3, rnd() * 3, rnd() * 3));
      m.compose(v.set(r.x, ground.heightAt(r.x, r.z) + r.s * 0.3, r.z), q, sc.set(r.s * (1 + rnd()), r.s, r.s * (1 + rnd()))); rm.setMatrixAt(i, m);
      rm.setColorAt(i, col.set(PALETTE.rock[i % PALETTE.rock.length]).convertSRGBToLinear());
    });
    rm.castShadow = quality === 'high';
    scene.add(rm); out.props.push(rm);
  }

  // hedges and low walls round the farmland (a gap where a road crosses the edge)
  {
    const isField = (x, y) => T[y] && T[y][x] === 'PLOUGHED_FIELD';
    const road = (x, y) => !!(state.roads && state.roads[y] && state.roads[y][x]);
    const segs = [];
    for(let y = 0; y < ROWS; y++) for(let x = 0; x < COLS; x++){
      if(!isField(x, y)) continue;
      for(const [dx, dy, cx, cz, r] of [[1, 0, 1, 0.5, 0], [-1, 0, 0, 0.5, 0], [0, 1, 0.5, 1, 1], [0, -1, 0.5, 0, 1]]){
        if(isField(x + dx, y + dy)) continue;
        if(road(x, y) && road(x + dx, y + dy)) continue;
        const wall = hash2(x, y, 5) % 3 === 0;   // every third field is walled rather than hedged
        segs.push({ x: x + cx, z: y + cz, r, wall });
      }
    }
    if(segs.length){
      const hedges = segs.filter(s => !s.wall), walls = segs.filter(s => s.wall);
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), sc = new THREE.Vector3();
      const place = (mesh, list, h, w) => list.forEach((s, i) => {
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), s.r ? 0 : Math.PI / 2);
        m.compose(v.set(s.x, ground.heightAt(s.x, s.z) + h / 2, s.z), q, sc.set(0.92, h, w)); mesh.setMatrixAt(i, m);
      });
      if(hedges.length){ const hm = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), toon({ color: '#2f4a28' }), hedges.length); place(hm, hedges, 0.09, 0.08); hm.castShadow = quality === 'high'; scene.add(hm); out.props.push(hm); }
      if(walls.length){ const wm = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), toon({ color: PALETTE.stone }), walls.length); place(wm, walls, 0.06, 0.05); wm.castShadow = quality === 'high'; scene.add(wm); out.props.push(wm); }
    }
  }

  // windmills where a place is a mill
  out.mills = [];
  for(const [name, px, py] of (state.places || [])){
    if(!/mill/i.test(name)) continue;
    const grp = new THREE.Group();
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.11, 0.34, 8), toon({ color: PALETTE.wall[1] })); tower.position.y = 0.17;
    const cap = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.1, 8), toon({ color: PALETTE.roof[1] })); cap.position.y = 0.39;
    const sails = new THREE.Group(); sails.position.set(0, 0.34, 0.11);
    for(let k = 0; k < 4; k++){ const s = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.28, 0.01), toon({ color: '#e9e4d6' })); s.position.y = 0.14; const arm = new THREE.Group(); arm.rotation.z = k * Math.PI / 2; arm.add(s); sails.add(arm); }
    grp.add(tower, cap, sails);
    grp.traverse(o => { if(o.isMesh) o.castShadow = quality === 'high'; });
    grp.position.set(px, ground.heightAt(px, py), py);
    scene.add(grp); out.props.push(grp); out.mills.push(sails);
  }

  // the selection marker: a square on the ground, hidden until a tap
  {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d'); g.strokeStyle = '#f2e6c0'; g.lineWidth = 10; g.strokeRect(8, 8, 112, 112);
    g.fillStyle = 'rgba(242,230,192,0.18)'; g.fillRect(14, 14, 100, 100);
    const tex = new THREE.CanvasTexture(c); tex.encoding = THREE.sRGBEncoding;
    const mk = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 4, 4), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    mk.rotation.x = -Math.PI / 2; mk.visible = false; mk.renderOrder = 2;
    scene.add(mk); out.props.push(mk); out.marker = mk;
    /* Put the marker on a square, draped on the ground. */
    out.markSquare = (x, y) => {
      if(x == null){ mk.visible = false; return; }
      const pos = mk.geometry.attributes.position;
      for(let i = 0; i < pos.count; i++){ const lx = pos.getX(i), ly = pos.getY(i); pos.setZ(i, ground.heightAt(x + 0.5 + lx, y + 0.5 - ly) + 0.015); }
      pos.needsUpdate = true;
      mk.position.set(x + 0.5, 0, y + 0.5); mk.visible = true;
    };
  }

  // villages: cottages on every building square, and a church on the first square of each village
  const houses = [], churches = [];
  const seenVillage = new Set();
  for(let y = 0; y < ROWS; y++) for(let x = 0; x < COLS; x++){
    if(T[y][x] !== 'BUILDING') continue;
    const key = x + ',' + y;
    const joined = [[x - 1, y], [x, y - 1]].some(([a, b]) => seenVillage.has(a + ',' + b));
    seenVillage.add(key);
    // three or four buildings round the square's edge, the middle left clear for the troops
    // the first square of a village keeps its back half for the church
    const spots = joined ? [[0.22, 0.2], [0.78, 0.22], [0.2, 0.8], [0.8, 0.78]].sort(() => rnd() - 0.5).slice(0, 3 + (rnd() < 0.5 ? 1 : 0)) : [[0.2, 0.82], [0.8, 0.8]];
    for(const [ox, oz] of spots){
      const roll = rnd();
      const kind = roll < 0.42 ? 'cottage' : roll < 0.68 ? 'farmhouse' : roll < 0.88 ? 'town' : 'barn';
      const dims = { cottage: [0.3, 0.2, 0.15], farmhouse: [0.42, 0.22, 0.16], town: [0.28, 0.24, 0.27], barn: [0.44, 0.28, 0.2] }[kind];
      houses.push({ x: x + ox + (rnd() - 0.5) * 0.05, z: y + oz + (rnd() - 0.5) * 0.05, r: (Math.abs(ox - 0.5) > Math.abs(oz - 0.5) ? Math.PI / 2 : 0) + (rnd() - 0.5) * 0.12, kind,
        w: dims[0] * (0.9 + rnd() * 0.2), d: dims[1] * (0.9 + rnd() * 0.2), h: dims[2] * (0.9 + rnd() * 0.2), roofH: kind === 'town' ? 0.16 : kind === 'barn' ? 0.16 : 0.13 });
    }
    if(!joined) churches.push({ x: x + 0.55, z: y + 0.32 });
  }
  buildVillages(scene, out, ground, houses, churches, quality, toon, rnd);

  // bridges: a deck across the channel between the two squares, with low parapets
  if(state.water && state.water.bridges){
    for(const br of state.water.bridges){
      const wooden = /wooden|pontoon/.test(br.art || '');
      const mat = toon({ color: wooden ? PALETTE.wood : PALETTE.stone });
      const cx = (br.a.x + br.b.x) / 2 + 0.5, cz = (br.a.y + br.b.y) / 2 + 0.5;
      const along = br.a.x === br.b.x;   // the road runs up and down the board
      const grp = new THREE.Group();
      const deck = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.05, 0.34), mat); deck.position.y = 0.04;
      const p1 = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.08, 0.04), mat); p1.position.set(0, 0.09, 0.17);
      const p2 = p1.clone(); p2.position.z = -0.17;
      const pier = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.3, 0.4), mat); pier.position.y = -0.12;
      grp.add(deck, p1, p2, pier);
      if(along) grp.rotation.y = Math.PI / 2;
      grp.position.set(cx, Math.max(0, ground.heightAt(cx, cz) + 0.1), cz);
      grp.traverse(o => { if(o.isMesh) o.castShadow = quality === 'high'; });
      scene.add(grp); out.props.push(grp);
    }
  }

  // the grid (toggled)
  {
    const pts = [];
    const step = 1 / HS;
    for(let x = 0; x <= COLS; x++) for(let z = 0; z < ROWS; z += step){ pts.push(x, ground.heightAt(x, z) + 0.012, z, x, ground.heightAt(x, z + step) + 0.012, z + step); }
    for(let z = 0; z <= ROWS; z++) for(let x = 0; x < COLS; x += step){ pts.push(x, ground.heightAt(x, z) + 0.012, z, x + step, ground.heightAt(x + step, z) + 0.012, z); }
    const gg = new THREE.BufferGeometry(); gg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const grid = new THREE.LineSegments(gg, new THREE.LineBasicMaterial({ color: '#e9e4d6', transparent: true, opacity: 0.22 }));
    scene.add(grid); out.props.push(grid); out.grid = grid;
  }

  // place names, floating above the ground
  out.labels = [];
  for(const [name, px, py, kind] of (state.places || [])){
    const spr = makeLabel(name, kind);
    const h = ground.heightAt(px, py);
    spr.position.set(px, h + 0.55, py);
    scene.add(spr); out.props.push(spr); out.labels.push(spr);
  }
  return out;
}

function makeLabel(text, kind){
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  const font = `${kind === 'feature' ? 'italic ' : ''}600 26px Cinzel, Georgia, serif`;
  g.font = font;
  const w = Math.ceil(g.measureText(text).width) + 24;
  c.width = w; c.height = 40;
  g.font = font; g.textBaseline = 'middle'; g.textAlign = 'center';
  g.lineWidth = 5; g.strokeStyle = 'rgba(20,14,8,0.85)'; g.strokeText(text, w / 2, 20);
  g.fillStyle = kind === 'water' ? 'rgb(214,230,214)' : 'rgb(246,236,206)'; g.fillText(text, w / 2, 20);
  const tex = new THREE.CanvasTexture(c);
  const mat = new THREE.SpriteMaterial({ map: tex, sizeAttenuation: false, depthTest: false, transparent: true });
  const s = new THREE.Sprite(mat);
  s.scale.set(w / 1100, 40 / 1100, 1);   // screen-relative size, whatever the zoom
  s.renderOrder = 10;
  return s;
}

/* ---------- the villages ---------- */
/* Painted once: a wall with a door, two shuttered windows and a plinth (tinted per house), a tiled
   roof, a slate roof, thatch, and a barn's boarding. Each on a canvas, so nothing is downloaded. */
function canvasTex(w, h, paint){
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  paint(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; t.anisotropy = 4;
  return t;
}
const TEX = {};
function villageTextures(){
  if(TEX.wall) return TEX;
  TEX.wall = canvasTex(128, 64, (g, w, h) => {
    g.fillStyle = '#f2ece0'; g.fillRect(0, 0, w, h);
    for(let i = 0; i < 300; i++){ g.fillStyle = `rgba(120,100,80,${Math.random() * 0.08})`; g.fillRect(Math.random() * w, Math.random() * h, 3, 2); }
    g.fillStyle = '#9a9286'; g.fillRect(0, h - 7, w, 7);                          // the plinth
    g.fillStyle = '#4a3424'; g.fillRect(56, 26, 16, 31);                           // the door
    g.fillStyle = '#6a4a32'; g.fillRect(58, 28, 12, 27);
    for(const wx of [18, 92]){
      g.fillStyle = '#2a2a30'; g.fillRect(wx, 20, 18, 18);                         // the glass
      g.fillStyle = '#e8e2d2'; g.fillRect(wx + 8, 20, 2, 18); g.fillRect(wx, 28, 18, 2);
      g.fillStyle = '#3f5a3a'; g.fillRect(wx - 6, 19, 5, 20); g.fillRect(wx + 19, 19, 5, 20);   // the shutters
    }
    g.strokeStyle = 'rgba(70,50,30,0.5)'; g.lineWidth = 2; g.strokeRect(1, 1, w - 2, h - 2);
  });
  TEX.town = canvasTex(128, 128, (g, w, h) => {
    g.fillStyle = '#f2ece0'; g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(90,64,40,0.85)'; g.lineWidth = 4;                       // half-timbering
    for(const x of [4, 42, 86, 124]){ g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
    for(const y of [4, 62, 124]){ g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
    g.beginPath(); g.moveTo(4, 62); g.lineTo(42, 4); g.moveTo(124, 62); g.lineTo(86, 4); g.stroke();
    g.fillStyle = '#2a2a30'; for(const [wx, wy] of [[52, 18], [52, 76], [16, 76], [96, 76]]) g.fillRect(wx, wy, 22, 26);
    g.fillStyle = '#4a3424'; g.fillRect(52, 92, 22, 32);
  });
  TEX.barn = canvasTex(128, 64, (g, w, h) => {
    g.fillStyle = '#7a5a3a'; g.fillRect(0, 0, w, h);
    for(let x = 0; x < w; x += 8){ g.fillStyle = x % 16 ? '#6e5032' : '#82603e'; g.fillRect(x, 0, 7, h); }
    g.fillStyle = '#3e2a1a'; g.fillRect(40, 18, 48, 46);
    g.strokeStyle = '#a8865a'; g.lineWidth = 3; g.beginPath(); g.moveTo(40, 18); g.lineTo(88, 64); g.moveTo(88, 18); g.lineTo(40, 64); g.stroke();
  });
  TEX.tiles = canvasTex(64, 64, (g, w, h) => {
    g.fillStyle = '#c87a5a'; g.fillRect(0, 0, w, h);
    for(let y = 0; y < h; y += 8){ g.fillStyle = 'rgba(60,20,10,0.4)'; g.fillRect(0, y + 6, w, 2); for(let x = (y / 8) % 2 ? 4 : 0; x < w; x += 8){ g.fillStyle = `rgba(255,220,190,${0.06 + Math.random() * 0.1})`; g.fillRect(x, y, 7, 6); } }
  });
  TEX.slate = canvasTex(64, 64, (g, w, h) => {
    g.fillStyle = '#7a7e86'; g.fillRect(0, 0, w, h);
    for(let y = 0; y < h; y += 6){ g.fillStyle = 'rgba(20,24,30,0.45)'; g.fillRect(0, y + 5, w, 1); for(let x = (y / 6) % 2 ? 5 : 0; x < w; x += 10){ g.fillStyle = 'rgba(20,24,30,0.35)'; g.fillRect(x, y, 1, 5); } }
  });
  TEX.thatch = canvasTex(64, 64, (g, w, h) => {
    g.fillStyle = '#b8955a'; g.fillRect(0, 0, w, h);
    for(let i = 0; i < 500; i++){ g.strokeStyle = Math.random() < 0.5 ? 'rgba(90,64,30,0.35)' : 'rgba(240,210,150,0.3)'; g.lineWidth = 1; const x = Math.random() * w, y = Math.random() * h; g.beginPath(); g.moveTo(x, y); g.lineTo(x + (Math.random() - 0.5) * 2, y + 5 + Math.random() * 4); g.stroke(); }
  });
  TEX.stone = canvasTex(64, 64, (g, w, h) => {
    g.fillStyle = '#9a9486'; g.fillRect(0, 0, w, h);
    for(let y = 0; y < h; y += 8) for(let x = (y / 8) % 2 ? 6 : 0; x < w; x += 12){ g.fillStyle = `rgba(${90 + Math.random() * 60},${86 + Math.random() * 50},${76 + Math.random() * 40},0.6)`; g.fillRect(x + 1, y + 1, 10, 6); }
  });
  for(const k of ['tiles', 'slate', 'thatch', 'stone']){ TEX[k].wrapS = TEX[k].wrapT = THREE.RepeatWrapping; }
  return TEX;
}
/* A gabled roof one unit wide (x, along the ridge), one deep (z) and one high (y), on y = 0: two
   sloping faces. The gable ends are a separate geometry (the wall's material fills them). */
function roofGeometry(){
  const v = [
    -0.5, 0, 0.5,   0.5, 0, 0.5,   0.5, 1, 0,   -0.5, 1, 0,     // front slope
    0.5, 0, -0.5,  -0.5, 0, -0.5, -0.5, 1, 0,    0.5, 1, 0,     // back slope
  ];
  const uv = [0, 0, 2, 0, 2, 1.4, 0, 1.4, 0, 0, 2, 0, 2, 1.4, 0, 1.4];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  g.computeVertexNormals();
  return g;
}
function gableGeometry(){
  const v = [0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 1, 0, -0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 1, 0];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0.5, 0.6, 0, 0, 1, 0, 0.5, 0.6], 2));
  g.setIndex([0, 1, 2, 3, 4, 5]);
  g.computeVertexNormals();
  return g;
}
function buildVillages(scene, out, ground, houses, churches, quality, toon, rnd){
  const T = villageTextures();
  const shadow = quality === 'high';
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), sc = new THREE.Vector3(), col = new THREE.Color();
  const up = new THREE.Vector3(0, 1, 0);
  const box = new THREE.BoxGeometry(1, 1, 1), roof = roofGeometry(), gable = gableGeometry();
  const WALLS = ['#f4eee2', '#ece2cc', '#e8dcc0', '#f0e6d8', '#e2d6bc'];
  // which roof each house gets: barns thatch or tile; town houses slate or tile; cottages any
  const roofOf = h => h.kind === 'barn' ? (rnd() < 0.5 ? 'thatch' : 'tiles') : h.kind === 'town' ? (rnd() < 0.5 ? 'slate' : 'tiles') : (['tiles', 'tiles', 'slate', 'thatch'][Math.floor(rnd() * 4)]);
  houses.forEach(h => { h.roof = roofOf(h); h.wallTex = h.kind === 'barn' ? 'barn' : h.kind === 'town' ? 'town' : 'wall'; h.eave = h.roof === 'thatch' ? 0.05 : 0.03; });
  const groups = {};
  for(const h of houses){ (groups['wall|' + h.wallTex] = groups['wall|' + h.wallTex] || []).push(h); (groups['roof|' + h.roof] = groups['roof|' + h.roof] || []).push(h); }
  const add = (mesh) => { mesh.castShadow = shadow; mesh.receiveShadow = shadow; scene.add(mesh); out.props.push(mesh); };
  for(const [key, list] of Object.entries(groups)){
    const [part, kind] = key.split('|');
    if(part === 'wall'){
      const walls = new THREE.InstancedMesh(box, toon({ color: '#ffffff', map: T[kind] }), list.length);
      const gables = new THREE.InstancedMesh(gable, toon({ color: '#ffffff', map: T[kind] }), list.length);
      list.forEach((h, i) => {
        const gy = ground.heightAt(h.x, h.z) - 0.01;
        q.setFromAxisAngle(up, h.r);
        m.compose(v.set(h.x, gy + h.h / 2, h.z), q, sc.set(h.w, h.h, h.d)); walls.setMatrixAt(i, m);
        m.compose(v.set(h.x, gy + h.h, h.z), q, sc.set(h.w, h.roofH, h.d)); gables.setMatrixAt(i, m);
        const c = col.set(kind === 'barn' ? '#ffffff' : WALLS[Math.floor(rnd() * WALLS.length)]).convertSRGBToLinear();
        walls.setColorAt(i, c); gables.setColorAt(i, c);
      });
      add(walls); add(gables);
    } else {
      const roofs = new THREE.InstancedMesh(roof, toon({ color: '#ffffff', map: T[kind], side: THREE.DoubleSide }), list.length);
      list.forEach((h, i) => {
        const gy = ground.heightAt(h.x, h.z) - 0.01;
        q.setFromAxisAngle(up, h.r);
        m.compose(v.set(h.x, gy + h.h - 0.004, h.z), q, sc.set(h.w + h.eave * 1.4, h.roofH + 0.01, h.d + h.eave * 2)); roofs.setMatrixAt(i, m);
        roofs.setColorAt(i, col.setHSL(0, 0, 0.82 + rnd() * 0.18));
      });
      add(roofs);
    }
  }
  // chimneys on the houses (not the barns)
  const chim = houses.filter(h => h.kind !== 'barn');
  if(chim.length){
    const cm = new THREE.InstancedMesh(box, toon({ color: '#ffffff', map: T.stone }), chim.length);
    chim.forEach((h, i) => {
      const gy = ground.heightAt(h.x, h.z), side = rnd() < 0.5 ? -1 : 1;
      const lx = side * h.w * 0.32;
      v.set(lx, 0, 0).applyAxisAngle(up, h.r);
      q.setFromAxisAngle(up, h.r);
      m.compose(v.set(h.x + v.x, gy + h.h + h.roofH * 0.75, h.z + v.z), q, sc.set(0.04, 0.12, 0.04)); cm.setMatrixAt(i, m);
      cm.setColorAt(i, col.set('#c8beb0').convertSRGBToLinear());
    });
    add(cm);
  }
  // the churches: a nave with a gabled slate roof, a stone tower with a spire, a rounded apse
  for(const ch of churches){
    const gy = ground.heightAt(ch.x, ch.z) - 0.01;
    const grp = new THREE.Group();
    const stoneMat = toon({ color: '#ffffff', map: T.stone }), slateMat = toon({ color: '#ffffff', map: T.slate, side: THREE.DoubleSide });
    const nave = new THREE.Mesh(box, stoneMat); nave.scale.set(0.46, 0.22, 0.24); nave.position.y = 0.11;
    const nroof = new THREE.Mesh(roof, slateMat); nroof.scale.set(0.5, 0.15, 0.3); nroof.position.y = 0.218;
    const ngab = new THREE.Mesh(gable, stoneMat); ngab.scale.set(0.46, 0.15, 0.24); ngab.position.y = 0.22;
    const apse = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.18, 10, 1, false, 0, Math.PI), stoneMat); apse.position.set(0.23, 0.09, 0);
    const apseRoof = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.09, 10, 1, false, 0, Math.PI), slateMat); apseRoof.position.set(0.23, 0.22, 0);
    const tower = new THREE.Mesh(box, stoneMat); tower.scale.set(0.15, 0.44, 0.15); tower.position.set(-0.29, 0.22, 0);
    const belfry = new THREE.Mesh(box, toon({ color: '#2a2a30' })); belfry.scale.set(0.155, 0.05, 0.06); belfry.position.set(-0.29, 0.38, 0);
    const spire = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.24, 4), slateMat); spire.rotation.y = Math.PI / 4; spire.position.set(-0.29, 0.56, 0);
    const cross = new THREE.Mesh(box, toon({ color: '#c9a84a' })); cross.scale.set(0.01, 0.06, 0.01); cross.position.set(-0.29, 0.7, 0);
    grp.add(nave, nroof, ngab, apse, apseRoof, tower, belfry, spire, cross);
    grp.traverse(o => { if(o.isMesh){ o.castShadow = shadow; o.receiveShadow = shadow; } });
    grp.position.set(ch.x, gy, ch.z);
    scene.add(grp); out.props.push(grp);
  }
}
