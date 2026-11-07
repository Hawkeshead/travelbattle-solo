/* =========================================================
   ISO LAB: THE ARMIES AS BILLBOARD SPRITES (prototype only)

   Every man, rider, gun and general is one quad that always faces the
   camera, drawn in one instanced batch per army's nation (one draw call per
   nation per frame). Two figure styles, switched live:
     A  the game's own pixel figures (assets/units-pixel, the sheets
        js/render-figures.js draws), packed into an atlas at load;
     B  figures pre-rendered from 3D models by tools/sprites/render-sheets.mjs
        (lab/sprites3d), eight facings each, so they turn as the camera orbits.
   Formations follow the game's (a line of two or three ranks, the square,
   the attack column, three riders, a gun and its crew, the general alone).
   Nothing here touches the game: it reads state.units and draws.
========================================================= */
import { UNIT_TYPES, nationOf, state } from '../js/data-core.js';
import { NATIONS, DEFAULT_NATIONS } from '../js/nations.js';

const THREE = globalThis.THREE;
const MAX_FIGURES = 1200;
const GAME_SCALE = 1.25;     // render-figures FIGURE_SCALE
export const SETTINGS = { size: 0.62, stand: 0.3, variants: 2 };
const MEN = { INFANTRY: 10, GUARD: 10, LIGHT_CAV: 3, HEAVY_CAV: 3, ARTILLERY: 2, BRIGADIER: 1 };
const FOOT = t => t === 'INFANTRY' || t === 'GUARD';
const kind = u => (UNIT_TYPES[u.type] || {}).key;
const artOf = u => (NATIONS[nationOf(u)] || {}).art || NATIONS[DEFAULT_NATIONS[u.side]].art;
const twoRanks = u => nationOf(u) === 'britain';
const now = () => performance.now();

function hash(str){ let h = 2166136261; for(let i = 0; i < str.length; i++){ h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed){ let a = hash(seed); return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/* ---------- the atlas: every frame of every sheet in one texture per nation ---------- */
const OUTLINE = 'rgba(20,13,8,0.92)';
class Atlas {
  constructor(width = 4096){
    this.c = document.createElement('canvas'); this.c.width = width; this.c.height = 256;
    this.g = this.c.getContext('2d');
    this.x = 2; this.y = 2; this.rowH = 0;
    this.frames = {};   // key -> [{u0,v0,u1,v1}]
    this.bytes = 0;
  }
  grow(h){
    const need = this.y + h + 2;
    if(need <= this.c.height) return;
    let H = this.c.height; while(H < need) H *= 2;
    const old = this.c;
    this.c = document.createElement('canvas'); this.c.width = old.width; this.c.height = H;
    this.g = this.c.getContext('2d'); this.g.drawImage(old, 0, 0);
  }
  /* n frames of fw x fh, side by side from (sx, sy) in img, with a one-pixel dark outline round each. */
  add(key, img, sx, sy, fw, fh, n, outline = true){
    const W = this.c.width;
    const rects = [];
    const tmp = document.createElement('canvas'); tmp.width = fw; tmp.height = fh;
    const tg = tmp.getContext('2d');
    const sil = document.createElement('canvas'); sil.width = fw; sil.height = fh;
    const sg = sil.getContext('2d');
    for(let f = 0; f < n; f++){
      if(this.x + fw + 2 > W){ this.x = 2; this.y += this.rowH + 2; this.rowH = 0; }
      this.grow(fh);
      tg.clearRect(0, 0, fw, fh);
      if(outline){
        sg.clearRect(0, 0, fw, fh); sg.globalCompositeOperation = 'source-over';
        sg.drawImage(img, sx + f * fw, sy, fw, fh, 0, 0, fw, fh);
        sg.globalCompositeOperation = 'source-in'; sg.fillStyle = OUTLINE; sg.fillRect(0, 0, fw, fh);
        for(const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) tg.drawImage(sil, dx, dy);
      }
      tg.drawImage(img, sx + f * fw, sy, fw, fh, 0, 0, fw, fh);
      this.g.drawImage(tmp, this.x, this.y);
      rects.push({ x: this.x, y: this.y, w: fw, h: fh });
      this.x += fw + 2; this.rowH = Math.max(this.rowH, fh);
    }
    this.frames[key] = rects;
  }
  finish(){
    const W = this.c.width, H = this.c.height;
    for(const k of Object.keys(this.frames)) this.frames[k] = this.frames[k].map(r => ({ u0: r.x / W, v0: 1 - (r.y + r.h) / H, u1: (r.x + r.w) / W, v1: 1 - r.y / H }));
    const tex = new THREE.CanvasTexture(this.c);
    tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter; tex.anisotropy = 4;
    this.texture = tex;
    this.pixels = W * H;
    return tex;
  }
}
const loadImage = url => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('missing ' + url)); im.src = url; });
const loadJSON = url => fetch(url).then(r => { if(!r.ok) throw new Error('missing ' + url); return r.json(); });

/* ---------- the sheets of one nation, in one style ---------- */
/* meta[type] = { h (height in squares before the size setting), fw, fh, ay, anims: { name: { n, fps, loop } }, facings: [...] | dirs: 8 } */
const PIX_TYPES = ['INFANTRY', 'GUARD', 'GUARD_BEARER', 'ARTILLERY', 'ARTILLERY_GUN', 'LIGHT_CAV', 'HEAVY_CAV', 'BRIGADIER'];
const ANIMS_WANTED = { INFANTRY: ['idle', 'march', 'fire', 'fall', 'melee'], GUARD: ['idle', 'march', 'fire', 'fall', 'melee'], GUARD_BEARER: ['idle', 'march', 'fall'],
  ARTILLERY: ['idle', 'march', 'serve', 'fall'], ARTILLERY_GUN: ['idle', 'fire', 'wreck'], LIGHT_CAV: ['idle', 'march', 'charge', 'fall', 'melee'], HEAVY_CAV: ['idle', 'march', 'charge', 'fall', 'melee'], BRIGADIER: ['idle', 'march', 'charge', 'fall'] };
export class NationSheets {
  constructor(art, style){ this.art = art; this.style = style; this.meta = {}; this.atlas = new Atlas(); this.loaded = 0; }
  async load(){
    const t0 = now();
    if(this.style === 'A') await this.loadPixel(); else await this.loadRendered();
    this.atlas.finish();
    this.loadMs = now() - t0;
    return this;
  }
  async loadPixel(){
    const V = SETTINGS.variants;
    await Promise.all(PIX_TYPES.map(async type => {
      const m = await loadJSON(`assets/units-pixel/${this.art}/${type}/${type}.json`);
      const anims = {};
      const facings = m.facings;
      const vars = Math.min(V, m.variants || 1);
      const jobs = [];
      for(const a of ANIMS_WANTED[type]){
        if(!m.anims[a]) continue;
        anims[a] = { n: m.anims[a].frameCount, fps: m.anims[a].fps || 8, loop: !!m.anims[a].loop };
        for(const f of facings) for(let v = 0; v < vars; v++){
          const url = `assets/units-pixel/${this.art}/${type}/${a}_${f}_v${v}.webp`;
          jobs.push(loadImage(url).then(img => { this.atlas.add(`${type}|${a}|${f}|${v}`, img, 0, 0, m.frameWidth, m.frameHeight, anims[a].n); this.loaded++; }));
        }
      }
      await Promise.all(jobs);
      this.meta[type] = { h: m.displayScale * GAME_SCALE, fw: m.frameWidth, fh: m.frameHeight, ay: m.anchorY, ayByFacing: m.anchorYByFacing || null, anims, facings, variants: vars };
    }));
  }
  async loadRendered(){
    await Promise.all(PIX_TYPES.map(async type => {
      const m = await loadJSON(`lab/sprites3d/${this.art}/${type}.json`);
      const img = await loadImage(`lab/sprites3d/${this.art}/${type}.webp`);
      const anims = {};
      let row = 0;
      for(const [a, spec] of Object.entries(m.anims)){
        anims[a] = { n: spec.frames, fps: spec.fps, loop: !!spec.loop };
        for(let d = 0; d < m.dirs; d++){ this.atlas.add(`${type}|${a}|d${d}|0`, img, 0, row * m.frameH, m.frameW, m.frameH, spec.frames, false); row++; }
      }
      this.loaded++;
      this.meta[type] = { h: m.displayScale * GAME_SCALE, fw: m.frameW, fh: m.frameH, ay: m.anchorY, anims, dirs: m.dirs, variants: 1 };
    }));
  }
  /* The frames for a figure: type, anim, its facing on screen (A: toward/away/left/right; B: a direction 0..7), variant. */
  frames(type, anim, facing, v){
    const m = this.meta[type]; if(!m) return null;
    if(!m.anims[anim]) anim = 'idle';
    let key;
    if(m.dirs) key = `${type}|${anim}|d${facing}|0`;
    else {
      const f = m.facings.includes(facing) ? facing : (facing === 'left' || facing === 'right' ? (m.facings.includes('toward') ? 'toward' : m.facings[0]) : m.facings[0]);
      key = `${type}|${anim}|${f}|${Math.min(v, m.variants - 1)}`;
    }
    const fr = this.atlas.frames[key];
    return fr ? { fr, a: m.anims[anim], m, f: m.dirs ? null : key.split('|')[2] } : null;
  }
}

/* ---------- the instanced billboard batch ---------- */
const VERT = `
attribute vec3 iPos; attribute vec3 iSize; attribute vec4 iUV; attribute float iShade;
uniform vec3 camRight; uniform vec3 camUp; uniform float stand;
varying vec2 vUv; varying float vShade;
void main(){
  vec3 up = normalize(mix(camUp, vec3(0.0, 1.0, 0.0), stand));
  vec3 right = normalize(cross(up, normalize(cross(camRight, up))));
  float ay = 1.0 - iSize.z;
  vec3 p = iPos + camRight * (position.x * iSize.x) + up * ((position.y - ay) * iSize.y);
  vUv = vec2(mix(iUV.x, iUV.z, uv.x), mix(iUV.y, iUV.w, uv.y));
  vShade = iShade;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const FRAG = `
precision mediump float;
uniform sampler2D map; varying vec2 vUv; varying float vShade;
void main(){
  vec4 c = texture2D(map, vUv);
  if(c.a < 0.5) discard;
  gl_FragColor = vec4(c.rgb * vShade, 1.0);
}`;
class SpriteBatch {
  constructor(texture, max = MAX_FIGURES){
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.pos = new Float32Array(max * 3); this.size = new Float32Array(max * 3); this.uv = new Float32Array(max * 4); this.shade = new Float32Array(max);
    geo.setAttribute('iPos', new THREE.InstancedBufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('iSize', new THREE.InstancedBufferAttribute(this.size, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('iUV', new THREE.InstancedBufferAttribute(this.uv, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('iShade', new THREE.InstancedBufferAttribute(this.shade, 1).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: { map: { value: texture }, camRight: { value: new THREE.Vector3(1, 0, 0) }, camUp: { value: new THREE.Vector3(0, 1, 0) }, stand: { value: SETTINGS.stand } }, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.n = 0; this.max = max;
  }
  begin(){ this.n = 0; }
  push(x, y, z, w, h, ay, r, shade){
    if(this.n >= this.max) return;
    const i = this.n++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.size[i * 3] = w; this.size[i * 3 + 1] = h; this.size[i * 3 + 2] = ay;
    this.uv[i * 4] = r.u0; this.uv[i * 4 + 1] = r.v0; this.uv[i * 4 + 2] = r.u1; this.uv[i * 4 + 3] = r.v1;
    this.shade[i] = shade;
  }
  end(camera){
    const g = this.mesh.geometry;
    g.instanceCount = this.n;
    for(const k of ['iPos', 'iSize', 'iUV', 'iShade']) g.attributes[k].needsUpdate = true;
    const right = new THREE.Vector3(), up = new THREE.Vector3();
    camera.matrixWorld.extractBasis(right, up, new THREE.Vector3());
    this.mat.uniforms.camRight.value.copy(right); this.mat.uniforms.camUp.value.copy(up); this.mat.uniforms.stand.value = SETTINGS.stand;
  }
}

/* ---------- formations, in squares: x across the unit's front, d forward (towards the enemy) ---------- */
function ranks(counts){
  const ds = counts.length === 2 ? [0.07, -0.07] : [0.1, 0, -0.1];
  const out = [];
  counts.forEach((n, r) => { const gap = n === 5 ? 0.18 : 0.22; for(let i = 0; i < n; i++) out.push({ x: (i - (n - 1) / 2) * gap, d: ds[r], face: 0 }); });
  return out;
}
/* face: 0 forward, 1 backward, 2 left flank (outward), 3 right flank */
function layoutFor(u, column){
  const k = kind(u);
  if(column){ const out = []; for(let r = 0; r < 5; r++) for(let c = 0; c < 4; c++) out.push({ x: (c - 1.5) * 0.19, d: 0.2 - r * 0.1, face: 0 }); return out; }
  if(FOOT(k)){
    if(u.formation === 'square'){
      const out = [];
      for(let i = 0; i < 4; i++) out.push({ x: (i - 1.5) * 0.19, d: 0.2, face: 0 });
      for(let i = 0; i < 4; i++) out.push({ x: (i - 1.5) * 0.19, d: -0.2, face: 1 });
      out.push({ x: -0.36, d: 0, face: 2 }, { x: 0.36, d: 0, face: 3 });
      return out;
    }
    return twoRanks(u) ? ranks([5, 5]) : ranks([4, 3, 3]);
  }
  if(k === 'LIGHT_CAV' || k === 'HEAVY_CAV') return [{ x: -0.26, d: -0.04, face: 0 }, { x: 0, d: 0.1, face: 0 }, { x: 0.26, d: -0.04, face: 0 }];
  if(k === 'BRIGADIER') return [{ x: 0, d: 0, face: 0 }];
  if(k === 'ARTILLERY') return [{ x: -0.28, d: -0.16, face: 0 }, { x: 0.28, d: -0.16, face: 0 }];
  return [];
}
const forwardOf = u => (u.side === 'red' ? { x: 0, z: -1 } : { x: 0, z: 1 });

/* ---------- the figures on the field ---------- */
export class Army {
  constructor(scene, ground){
    this.scene = scene; this.ground = ground;
    this.sheets = {};        // art -> NationSheets (current style)
    this.batches = {};       // art -> SpriteBatch
    this.squads = new Map(); // unit id -> squad
    this.bodies = [];        // the fallen: { art, type, x, z, frame rect, w, h, ay, facing }
    this.smoke = new Smoke(scene);
    this.style = 'A';
    this.blobs = makeBlobs(scene);
    this.drawn = 0;
  }
  async setStyle(style){
    this.style = style;
    for(const b of Object.values(this.batches)) this.scene.remove(b.mesh);
    this.sheets = {}; this.batches = {};
    const arts = [...new Set(state.units.filter(u => !u.removed).map(artOf))];
    await Promise.all(arts.map(async art => {
      const s = await new NationSheets(art, style).load();
      this.sheets[art] = s;
      const b = new SpriteBatch(s.atlas.texture);
      this.batches[art] = b;
      this.scene.add(b.mesh);
    }));
    this.bodies = [];
    this.squads.clear();
  }
  squad(u){
    let s = this.squads.get(u.id);
    if(s) return s;
    const k = kind(u), n = MEN[k] || 0;
    const R = rng('iso|' + u.id);
    s = { u, n, alive: Array(n).fill(true), v: Array.from({ length: n }, () => Math.floor(R() * 5)), phase: Array.from({ length: n }, () => R()),
      jit: Array.from({ length: n }, () => [(R() - 0.5) * 0.04, (R() - 0.5) * 0.04]),
      pos: { x: u.x + 0.5, z: u.y + 0.5 }, anim: 'idle', start: 0, until: 0, move: null, falling: {} };
    this.squads.set(u.id, s);
    return s;
  }
  /* ---------- the actions the page's buttons call ---------- */
  march(u, squares = 1, charge = false){
    const s = this.squad(u);
    if(s.move) return;
    const f = forwardOf(u);
    let tx = u.x, ty = u.y;
    const free = (x, y) => x >= 0 && y >= 0 && x < state.terrain[0].length && y < state.terrain.length && !state.units.some(o => !o.removed && o !== u && o.x === x && o.y === y);
    for(let k = 0; k < squares; k++){ if(free(tx + f.x, ty + f.z)){ tx += f.x; ty += f.z; } }
    if(tx === u.x && ty === u.y){
      const opts = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy]) => free(u.x + dx, u.y + dy));
      if(!opts.length) return;
      const [dx, dy] = opts[Math.floor(Math.random() * opts.length)]; tx = u.x + dx; ty = u.y + dy;
    }
    const dist = Math.hypot(tx - u.x, ty - u.y);
    s.move = { fx: s.pos.x, fz: s.pos.z, tx: tx + 0.5, tz: ty + 0.5, start: now(), ms: (charge ? 520 : 900) * dist };
    s.anim = charge && !FOOT(kind(u)) ? 'charge' : 'march'; s.start = now(); s.until = s.move.start + s.move.ms;
    u.x = tx; u.y = ty;   // the unit's square, for the next action (the lab's own copy of the state)
  }
  volley(u){
    const s = this.squad(u); const k = kind(u);
    if(s.move) return;
    const a = k === 'ARTILLERY' ? 'serve' : FOOT(k) ? 'fire' : 'melee';
    const sheet = this.sheets[artOf(u)];
    const an = sheet && sheet.meta[k] && sheet.meta[k].anims[a];
    const ms = an ? (an.n / an.fps) * 1000 : 1200;
    s.anim = a; s.start = now(); s.until = s.start + ms; s.fired = false;
  }
  fall(u, count){
    const s = this.squad(u); const k = kind(u);
    const n = count || (FOOT(k) ? 3 : 1);
    const living = s.alive.map((a, i) => a ? i : -1).filter(i => i >= 0 && !s.falling[i]);
    for(let i = 0; i < n && living.length; i++){
      const m = living.splice(Math.floor(Math.random() * living.length), 1)[0];
      s.falling[m] = now() + i * 120;
    }
  }
  resetUnit(u){ this.squads.delete(u.id); this.bodies = this.bodies.filter(b => b.unitId !== u.id); }
  /* ---------- a frame ---------- */
  update(camera, yaw){
    const t = now();
    for(const b of Object.values(this.batches)) b.begin();
    this.drawn = 0;
    // which squares hold two foot units: those draw as one attack column
    const occ = new Map();
    for(const u of state.units){ if(u.removed || u.x < 0) continue; const key = u.x + ',' + u.y; occ.set(key, (occ.get(key) || []).concat(u)); }
    // screen facing helpers
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw)), fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    const facingFor = (meta, fx, fz) => {
      const toward = -(fx * fwd.x + fz * fwd.z), rt = fx * right.x + fz * right.z;
      if(meta.dirs){ let a = Math.atan2(rt, toward); let d = Math.round(a / (Math.PI / 4)); d = ((d % 8) + 8) % 8; return d; }
      if(Math.abs(toward) >= Math.abs(rt) || !meta.facings.includes('left')) return toward > 0 ? 'toward' : 'away';
      return rt > 0 ? 'right' : 'left';
    };
    const sunShade = (fx, fz) => 0.86 + 0.14 * Math.max(0, (-fx * 0.6 - fz * 0.8));   // a touch darker when the figure faces away from the light
    for(const u of state.units){
      if(u.removed || u.x < 0 || !MEN[kind(u)]) continue;
      const art = artOf(u), sheet = this.sheets[art], batch = this.batches[art];
      if(!sheet || !batch) continue;
      const s = this.squad(u), k = kind(u);
      // movement
      if(s.move){
        const w = Math.min(1, (t - s.move.start) / s.move.ms);
        s.pos.x = s.move.fx + (s.move.tx - s.move.fx) * w; s.pos.z = s.move.fz + (s.move.tz - s.move.fz) * w;
        if(w >= 1){ s.move = null; s.anim = 'idle'; }
      } else if(s.until && t > s.until){ s.anim = 'idle'; s.until = 0; }
      const f = forwardOf(u);
      const rightV = { x: -f.z, z: f.x };
      const mates = occ.get(u.x + ',' + u.y) || [];
      const column = FOOT(k) && mates.length === 2 && mates.every(o => FOOT(kind(o)));
      let slots = layoutFor(u, column);
      if(column){ const par = mates.indexOf(u); slots = slots.filter((_, i) => i % 2 === par); }
      const bearer = k === 'GUARD' && this.style === 'A' ? s.n - 1 : -1;
      let slotIdx = 0;
      for(let m = 0; m < s.n; m++){
        if(!s.alive[m]) continue;
        const slot = slots[slotIdx++ % slots.length] || slots[0];
        if(!slot) continue;
        const type = m === bearer ? 'GUARD_BEARER' : k;
        const meta = sheet.meta[type]; if(!meta) continue;
        // where he stands, and which way he faces
        const wx = s.pos.x + rightV.x * slot.x + f.x * slot.d + s.jit[m][0], wz = s.pos.z + rightV.z * slot.x + f.z * slot.d + s.jit[m][1];
        let fx = f.x, fz = f.z;
        if(slot.face === 1){ fx = -f.x; fz = -f.z; } else if(slot.face === 2){ fx = -rightV.x; fz = -rightV.z; } else if(slot.face === 3){ fx = rightV.x; fz = rightV.z; }
        // his animation and frame
        let anim = s.anim, start = s.start, held = false;
        const fallAt = s.falling[m];
        if(fallAt != null){ anim = 'fall'; start = fallAt; if(t < fallAt) anim = s.anim; }
        const fr = sheet.frames(type, anim, facingFor(meta, fx, fz), s.v[m]);
        if(!fr) continue;
        let frame;
        if(fr.a.loop){ frame = Math.floor(((t / 1000) * fr.a.fps + s.phase[m] * fr.a.n)) % fr.a.n; }
        else { frame = Math.min(fr.a.n - 1, Math.floor(((t - start) / 1000) * fr.a.fps)); held = frame === fr.a.n - 1; }
        if(fallAt != null && t >= fallAt && held){
          // down: he stays where he fell, as a body
          const ay = fr.m.ayByFacing && fr.m.ayByFacing[fr.f] != null ? fr.m.ayByFacing[fr.f] : fr.m.ay;
          this.bodies.push({ unitId: u.id, art, x: wx, z: wz, r: fr.fr[frame], h: meta.h * SETTINGS.size, w: meta.h * SETTINGS.size * meta.fw / meta.fh, ay, shade: 0.8 });
          s.alive[m] = false; delete s.falling[m];
          continue;
        }
        const h = meta.h * SETTINGS.size, w = h * meta.fw / meta.fh;
        const ay = fr.m.ayByFacing && fr.m.ayByFacing[fr.f] != null ? fr.m.ayByFacing[fr.f] : fr.m.ay;
        const gy = this.ground.heightAt(wx, wz) + 0.01;
        batch.push(wx, gy, wz, w, h, ay, fr.fr[frame], sunShade(fx, fz));
        this.blobs.push(wx, gy, wz, w * 0.7);
        this.drawn++;
        // the volley's smoke, once the muskets come up
        // the volley's smoke, once the muskets come up: three puffs along the front rank (each puff is a draw call)
        if(anim === 'fire' && !s.fired && t - s.start > 350 && slot.face === 0 && slot.d >= 0.05 && (slotIdx % 2 === 1)){ this.smoke.puff(wx + fx * 0.12, gy + h * 0.55, wz + fz * 0.12, 'musket'); }
      }
      if(s.anim === 'fire' && !s.fired && t - s.start > 350) s.fired = true;
      // the gun, in front of its crew
      if(k === 'ARTILLERY'){
        const meta = sheet.meta.ARTILLERY_GUN;
        if(meta){
          const gx = s.pos.x + f.x * 0.1, gz = s.pos.z + f.z * 0.1;
          const firing = s.anim === 'serve' && t - s.start < 900;
          const fr = sheet.frames('ARTILLERY_GUN', firing ? 'fire' : 'idle', facingFor(meta, f.x, f.z), 0);
          if(fr){
            const frame = fr.a.loop ? 0 : Math.min(fr.a.n - 1, Math.floor(((t - s.start) / 1000) * fr.a.fps));
            const h = meta.h * SETTINGS.size, w = h * meta.fw / meta.fh;
            const ay = fr.m.ayByFacing && fr.m.ayByFacing[fr.f] != null ? fr.m.ayByFacing[fr.f] : fr.m.ay;
            const gy = this.ground.heightAt(gx, gz) + 0.01;
            batch.push(gx, gy, gz, w, h, ay, fr.fr[frame], 1);
            this.blobs.push(gx, gy, gz, w * 0.8);
            this.drawn++;
            if(s.anim === 'serve' && !s.fired && t - s.start > 250){ this.smoke.puff(gx + f.x * 0.3, gy + h * 0.35, gz + f.z * 0.3, 'cannon'); s.fired = true; }
          }
        }
      }
    }
    for(const b of this.bodies){
      const batch = this.batches[b.art]; if(!batch) continue;
      batch.push(b.x, this.ground.heightAt(b.x, b.z) + 0.008, b.z, b.w, b.h, b.ay, b.r, b.shade);
      this.drawn++;
    }
    for(const b of Object.values(this.batches)) b.end(camera);
    this.blobs.end();
    this.smoke.update(t);
  }
}

/* ---------- soft shadows under the figures ---------- */
function makeBlobs(scene){
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'); const gr = g.createRadialGradient(32, 32, 4, 32, 32, 30);
  gr.addColorStop(0, 'rgba(10,8,4,0.45)'); gr.addColorStop(1, 'rgba(10,8,4,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 0.55), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }), MAX_FIGURES);
  mesh.frustumCulled = false; mesh.renderOrder = 1;
  scene.add(mesh);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2), v = new THREE.Vector3(), sc = new THREE.Vector3();
  let n = 0;
  return {
    mesh,
    push(x, y, z, w){ if(n >= MAX_FIGURES) return; m.compose(v.set(x, y + 0.004, z), q, sc.set(w, w, 1)); mesh.setMatrixAt(n++, m); },
    end(){ mesh.count = n; mesh.instanceMatrix.needsUpdate = true; n = 0; },
  };
}

/* ---------- gun smoke: the game's own puffs and clouds, as sprites ---------- */
class Smoke {
  constructor(scene){
    this.scene = scene; this.pool = []; this.live = [];
    const L = new THREE.TextureLoader();
    const tex = url => { const t = L.load(url); t.encoding = THREE.sRGBEncoding; return t; };
    this.mats = { musket: [1, 2, 3].map(i => new THREE.SpriteMaterial({ map: tex(`assets/terrain/v2/effects/smoke/musket_puff_${i}.webp`), transparent: true, depthWrite: false, opacity: 0.85 })),
      cannon: [1, 2, 3, 4].map(i => new THREE.SpriteMaterial({ map: tex(`assets/terrain/v2/effects/smoke/cannon_cloud_${i}.webp`), transparent: true, depthWrite: false, opacity: 0.9 })) };
  }
  puff(x, y, z, kind){
    const mats = this.mats[kind];
    const spr = this.pool.pop() || new THREE.Sprite();
    spr.material = mats[Math.floor(Math.random() * mats.length)].clone();
    const s = kind === 'cannon' ? 0.5 : 0.22;
    spr.scale.set(s * 1.6, s, 1); spr.position.set(x, y, z);
    spr.renderOrder = 5;
    this.scene.add(spr);
    this.live.push({ spr, born: now(), life: kind === 'cannon' ? 3200 : 2200, s, drift: (Math.random() - 0.5) * 0.1 });
  }
  update(t){
    for(let i = this.live.length - 1; i >= 0; i--){
      const p = this.live[i], a = (t - p.born) / p.life;
      if(a >= 1){ this.scene.remove(p.spr); p.spr.material.dispose(); this.pool.push(p.spr); this.live.splice(i, 1); continue; }
      const grow = 1 + a * 1.4;
      p.spr.scale.set(p.s * 1.6 * grow, p.s * grow, 1);
      p.spr.position.y += 0.0018; p.spr.position.x += p.drift * 0.004;
      p.spr.material.opacity = (1 - a) * 0.85;
    }
  }
}
