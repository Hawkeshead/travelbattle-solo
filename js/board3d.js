/* =========================================================
   THE 3D BOARD (7 Nov 2026, Matthew: replace the flat board)

   Draws the battlefield in 3D with three.js r128 (js/vendor, loaded on
   demand): the ground, hills, rivers, woods, villages and bridges from the
   map (js/board3d-world.js, shared with the Iso Lab), the game's own pixel
   figures as billboard sprites, and the game's flat board drawing (move and
   target highlights, the grid, action lines, craters, bodies, the Spyglass,
   deployment zones) laid over the ground as a texture.

   NOTHING ABOUT PLAY CHANGES. render-board still draws its canvas every
   frame (with the ground and smoke left out), render-figures still decides
   who stands, falls, walks and fights, and every tap still reaches the
   game's own handlers: this module only says which square is under the
   finger (render-board cellFromClient) and where a square is on the screen
   (squareToClient), and drives the camera when the game asks it to
   (cameraTo, cameraToAction, park and restore).

   World coordinates are board squares: x across, z down the board (row),
   y up. A square (x, y) spans x..x+1, z y..y+1. The game's screen layout
   (a flipped or side-on view) is honoured by where the camera starts and by
   the overlay's texture coordinates.

   Settings (per device, localStorage): Board 3D or Classic, Graphics Low or
   High, Figures Small or Large. Without WebGL, or headless, it never starts
   and the Classic board carries on as before.
========================================================= */
import { COLS, ROWS, state } from './data-core.js';
import { buildWorld } from './board3d-world.js';
import { OrbitRig } from './board3d-camera.js';
import { CameraPref, SCOLS, SROWS, board3dOn, draw, ensureAnimationLoopRunning, fromScreen, pointerClaimed, setBoard3D, sizeCanvas, toScreen } from './render-board.js';
import { figureSheet, setFigureSink } from './render-figures.js';
import { onGunfire } from './render-gunfire.js';
import { deferAssets } from './asset-loader.js';

const HEADLESS = typeof navigator === 'undefined' || /jsdom/i.test(navigator.userAgent || '');
let THREE = null;
// The battle board's own canvas (render-board's drawing target can be lent to the rules manual's diagrams).
const board2d = HEADLESS ? null : document.getElementById('board');

/* ---------- settings ---------- */
const KEYS = { board: 'fc_board', graphics: 'fc_graphics', figures: 'fc_figures' };
const read = (k, dflt, ok) => { try { const v = localStorage.getItem(k); return ok.includes(v) ? v : dflt; } catch { return dflt; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode: this visit only */ } };
const URL_BOARD = (() => { try { const q = new URLSearchParams(location.search).get('board'); return q === '3d' || q === 'classic' ? q : null; } catch { return null; } })();
export const boardPref = () => URL_BOARD || read(KEYS.board, '3d', ['3d', 'classic']);
export const graphicsPref = () => read(KEYS.graphics, 'low', ['low', 'high']);
let figuresCache = null;   // read once, not every frame (the sprites ask each frame)
export const figuresPref = () => figuresCache || (figuresCache = read(KEYS.figures, 'small', ['small', 'large']));
const FIGURE_SIZE = { small: 0.4, large: 0.9 };   // times the 2D board's figure height (render-figures FIGURE_SCALE)
const FIGURE_SCALE = 1.25;

export function webglAvailable(){
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; }
}
/* Drawn in software (no graphics chip, or one the browser has blocked): the
   3D board would crawl and take the game's own timers down with it (seen on
   CI's two-core runner: the dice and deployment slowed past the smoke
   tests' limits). Such a device keeps the Classic board unless ?board=3d
   asks for 3D. Every phone has a GPU, so this never stops the 3D board there. */
let software = null;
export function softwareRendering(){
  if(software !== null) return software;
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    const name = gl ? String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER)) : '';
    software = /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name);
  } catch { software = false; }
  return software;
}
/* Can the 3D board run here well enough to be the default? */
export const board3dSuitable = () => webglAvailable() && (URL_BOARD === '3d' || !softwareRendering());
function loadThree(){
  if(globalThis.THREE) return Promise.resolve(globalThis.THREE);
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'js/vendor/three.r128.min.js';
    s.onload = () => (globalThis.THREE ? res(globalThis.THREE) : rej(new Error('three.js did not define THREE')));
    s.onerror = () => rej(new Error('three.js did not load'));
    document.head.appendChild(s);
  });
}

/* ---------- screen and board coordinates ---------- */
// toScreen is affine, so it maps continuous points too: a board point (in squares, corner origin) to a screen point.
const boardPtToScreen = (bx, by) => { const s = toScreen(bx - 0.5, by - 0.5); return { x: s.x + 0.5, y: s.y + 0.5 }; };
const screenPtToBoard = (sx, sy) => { const b = fromScreen(sx - 0.5, sy - 0.5); return { x: b.x + 0.5, y: b.y + 0.5 }; };
// A direction on the screen as a direction on the board (the linear part of fromScreen).
const screenDirToBoard = (dx, dy) => { const o = screenPtToBoard(0, 0), p = screenPtToBoard(dx, dy); return { x: p.x - o.x, y: p.y - o.y }; };

/* ---------- the sprite atlas: the figures' sheets packed as the game first draws them ---------- */
const OUTLINE = 'rgba(20,13,8,0.92)';
const PAGE_W = 2048, PAGE_H = 2048;
class AtlasPage {
  constructor(){
    this.c = document.createElement('canvas'); this.c.width = PAGE_W; this.c.height = PAGE_H;
    this.g = this.c.getContext('2d');
    this.x = 2; this.y = 2; this.rowH = 0;
    this.tex = new THREE.CanvasTexture(this.c);
    this.tex.minFilter = THREE.LinearMipmapLinearFilter; this.tex.magFilter = THREE.LinearFilter; this.tex.anisotropy = 4;
    this.batch = new SpriteBatch(this.tex);
  }
  /* Room for a strip of n frames fw x fh? Returns its rects (UVs) or null when the page is full. */
  add(img, fw, fh, n){
    const rects = [];
    const tmp = document.createElement('canvas'); tmp.width = fw; tmp.height = fh;
    const tg = tmp.getContext('2d');
    const sil = document.createElement('canvas'); sil.width = fw; sil.height = fh;
    const sg = sil.getContext('2d');
    for(let f = 0; f < n; f++){
      if(this.x + fw + 2 > PAGE_W){ this.x = 2; this.y += this.rowH + 2; this.rowH = 0; }
      if(this.y + fh + 2 > PAGE_H) return null;
      // the game's one-pixel dark outline round every frame, so each man reads against the ground
      tg.clearRect(0, 0, fw, fh); sg.clearRect(0, 0, fw, fh);
      sg.globalCompositeOperation = 'source-over'; sg.drawImage(img, f * fw, 0, fw, fh, 0, 0, fw, fh);
      sg.globalCompositeOperation = 'source-in'; sg.fillStyle = OUTLINE; sg.fillRect(0, 0, fw, fh);
      for(const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) tg.drawImage(sil, dx, dy);
      tg.drawImage(img, f * fw, 0, fw, fh, 0, 0, fw, fh);
      this.g.drawImage(tmp, this.x, this.y);
      rects.push({ u0: this.x / PAGE_W, v0: 1 - (this.y + fh) / PAGE_H, u1: (this.x + fw) / PAGE_W, v1: 1 - this.y / PAGE_H });
      this.x += fw + 2; this.rowH = Math.max(this.rowH, fh);
    }
    this.tex.needsUpdate = true;
    return rects;
  }
}
class Atlas {
  constructor(scene){ this.scene = scene; this.pages = []; this.byImg = new Map(); }
  frames(sh){
    let e = this.byImg.get(sh.img);
    if(e) return e;
    const m = sh.meta, n = Math.max(1, Math.round(sh.img.naturalWidth / m.frameWidth));
    let page = this.pages[this.pages.length - 1], rects = page && page.add(sh.img, m.frameWidth, m.frameHeight, n);
    if(!rects){ page = new AtlasPage(); this.pages.push(page); this.scene.add(page.batch.mesh); rects = page.add(sh.img, m.frameWidth, m.frameHeight, n); }
    if(!rects) return null;
    e = { page, rects };
    this.byImg.set(sh.img, e);
    return e;
  }
  dispose(){ for(const p of this.pages){ this.scene.remove(p.batch.mesh); p.tex.dispose(); p.batch.mesh.geometry.dispose(); p.batch.mat.dispose(); } this.pages = []; this.byImg.clear(); }
}

/* ---------- one instanced batch of billboards ---------- */
const VERT = `
attribute vec3 iPos; attribute vec3 iSize; attribute vec4 iUV; attribute float iAlpha;
uniform vec3 camRight; uniform vec3 camUp; uniform float stand;
varying vec2 vUv; varying float vAlpha;
void main(){
  vec3 up = normalize(mix(camUp, vec3(0.0, 1.0, 0.0), stand));
  float ay = 1.0 - iSize.z;
  vec3 p = iPos + camRight * (position.x * iSize.x) + up * ((position.y - ay) * iSize.y);
  vUv = vec2(mix(iUV.x, iUV.z, uv.x), mix(iUV.y, iUV.w, uv.y));
  vAlpha = iAlpha;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
/* Alpha below one (a concealed unit, a fading body) is drawn by leaving out a
   share of the pixels in a fine pattern, so the sprites need no sorting. */
const FRAG = `
precision mediump float;
uniform sampler2D map; varying vec2 vUv; varying float vAlpha;
void main(){
  vec4 c = texture2D(map, vUv);
  if(c.a < 0.5) discard;
  if(vAlpha < 0.99){ float d = fract(sin(dot(floor(gl_FragCoord.xy), vec2(12.9898, 78.233))) * 43758.5453); if(d > vAlpha) discard; }
  gl_FragColor = vec4(c.rgb, 1.0);   // the sheets' own colours, as painted (no colour-space round trip)
}`;
const MAX_SPRITES = 3000;
class SpriteBatch {
  constructor(texture){
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.pos = new Float32Array(MAX_SPRITES * 3); this.size = new Float32Array(MAX_SPRITES * 3); this.uv = new Float32Array(MAX_SPRITES * 4); this.alpha = new Float32Array(MAX_SPRITES);
    geo.setAttribute('iPos', new THREE.InstancedBufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('iSize', new THREE.InstancedBufferAttribute(this.size, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('iUV', new THREE.InstancedBufferAttribute(this.uv, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('iAlpha', new THREE.InstancedBufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, side: THREE.DoubleSide,
      uniforms: { map: { value: texture }, camRight: { value: new THREE.Vector3(1, 0, 0) }, camUp: { value: new THREE.Vector3(0, 1, 0) }, stand: { value: 0.3 } } });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 3;
    this.n = 0;
  }
  push(x, y, z, w, h, ay, r, alpha){
    if(this.n >= MAX_SPRITES) return;
    const i = this.n++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.size[i * 3] = w; this.size[i * 3 + 1] = h; this.size[i * 3 + 2] = ay;
    this.uv[i * 4] = r.u0; this.uv[i * 4 + 1] = r.v0; this.uv[i * 4 + 2] = r.u1; this.uv[i * 4 + 3] = r.v1;
    this.alpha[i] = alpha;
  }
  end(camera){
    const g = this.mesh.geometry;
    g.instanceCount = this.n;
    for(const k of ['iPos', 'iSize', 'iUV', 'iAlpha']) g.attributes[k].needsUpdate = true;
    const right = new THREE.Vector3(), up = new THREE.Vector3();
    camera.matrixWorld.extractBasis(right, up, new THREE.Vector3());
    this.mat.uniforms.camRight.value.copy(right); this.mat.uniforms.camUp.value.copy(up);
    this.n = 0;
  }
}

/* ---------- smoke and muzzle flashes in the air ---------- */
const SMOKE = { musketMs: 1700, cannonMs: 2600, hazeMs: [2600, 4200], hazeMax: 24 };   // Matthew: lingering, but gone in a few seconds
class Smoke {
  constructor(scene){
    this.scene = scene; this.live = []; this.haze = []; this.pool = [];
    const L = new THREE.TextureLoader();
    const tex = url => { const t = L.load(url); t.encoding = THREE.sRGBEncoding; return t; };
    this.mats = {
      musket: [1, 2, 3].map(i => new THREE.SpriteMaterial({ map: tex(`assets/terrain/v2/effects/smoke/musket_puff_${i}.webp`), transparent: true, depthWrite: false })),
      cannon: [1, 2, 3, 4].map(i => new THREE.SpriteMaterial({ map: tex(`assets/terrain/v2/effects/smoke/cannon_cloud_${i}.webp`), transparent: true, depthWrite: false })),
    };
    this.flashMat = new THREE.SpriteMaterial({ color: 0xffe08a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  }
  sprite(mat){ const s = this.pool.pop() || new THREE.Sprite(); s.material = mat.clone(); s.renderOrder = 5; this.scene.add(s); return s; }
  drop(s){ this.scene.remove(s); s.material.dispose(); this.pool.push(s); }
  puff(x, y, z, kind, dirX, dirZ){
    const mats = this.mats[kind];
    const s = this.sprite(mats[Math.floor(Math.random() * mats.length)]);
    const size = kind === 'cannon' ? 0.55 : 0.24;
    s.scale.set(size * 1.6, size, 1); s.position.set(x, y, z);
    this.live.push({ s, born: performance.now(), life: kind === 'cannon' ? SMOKE.cannonMs : SMOKE.musketMs, size, dx: dirX * 0.0025, dz: dirZ * 0.0025, kind });
    const f = this.sprite(this.flashMat);
    f.scale.set(size * 0.7, size * 0.7, 1); f.position.set(x + dirX * 0.08, y, z + dirZ * 0.08);
    this.live.push({ s: f, born: performance.now(), life: 120, size: size * 0.7, flash: true });
  }
  get count(){ return this.live.length + this.haze.length; }
  update(t){
    for(let i = this.live.length - 1; i >= 0; i--){
      const p = this.live[i], a = (t - p.born) / p.life;
      if(a >= 1){
        if(!p.flash && this.haze.length < SMOKE.hazeMax){
          const h = this.sprite(this.mats.cannon[Math.floor(Math.random() * 4)]);
          h.position.copy(p.s.position); h.scale.set(p.size * 3.2, p.size * 1.8, 1);
          this.haze.push({ s: h, born: t, life: SMOKE.hazeMs[0] + Math.random() * (SMOKE.hazeMs[1] - SMOKE.hazeMs[0]), size: p.size });
        }
        this.drop(p.s); this.live.splice(i, 1); continue;
      }
      if(p.flash){ p.s.material.opacity = 1 - a; continue; }
      const g = 1 + a * 1.4;
      p.s.scale.set(p.size * 1.6 * g, p.size * g, 1);
      p.s.position.x += p.dx; p.s.position.z += p.dz; p.s.position.y += 0.0016;
      p.s.material.opacity = (1 - a) * 0.85;
    }
    for(let i = this.haze.length - 1; i >= 0; i--){
      const h = this.haze[i], a = (t - h.born) / h.life;
      if(a >= 1){ this.drop(h.s); this.haze.splice(i, 1); continue; }
      const g = 1 + a * 2;
      h.s.scale.set(h.size * 3.2 * g, h.size * 1.8 * g, 1);
      h.s.position.x += 0.0008; h.s.position.y += 0.0003;   // a light wind from the west
      h.s.material.opacity = 0.26 * Math.sin(Math.min(1, a * 4) * Math.PI / 2) * (1 - a);
    }
  }
  clear(){ for(const p of [...this.live, ...this.haze]) this.drop(p.s); this.live = []; this.haze = []; }
}

/* ---------- the board ---------- */
const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
class Board3D {
  constructor(){
    this.active = false;
    this.sprites = [];     // the men render-figures handed over during the last draw()
    this.pending = [];
    this.overlayDirty = true;
    this.worldKey = null;
    this.camAnim = null;
    this.parked = null;
    this.returnTimer = null;
    this.stats = { fps: 0, calls: 0, triangles: 0, sprites: 0 };
    this._frames = 0; this._fpsAt = performance.now();
  }
  /* ---------- start and stop ---------- */
  async start(){
    if(this.active || HEADLESS) return;
    if(!webglAvailable()) return;
    THREE = await loadThree();
    const wrap = document.getElementById('boardWrap');
    if(!wrap) return;
    if(!this.canvas){
      const c = document.createElement('canvas');
      c.id = 'board3d';
      c.setAttribute('aria-label', 'The battlefield');
      c.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;';
      wrap.insertBefore(c, wrap.firstChild);   // under the floating text, the dice and the clouds
      this.canvas = c;
      this.bindInput();
      if(!this._ro){ this._ro = new ResizeObserver(() => this.resize()); this._ro.observe(wrap); }   // once, whichever canvas
    }
    this.canvas.style.display = 'block';
    this.makeRenderer();
    this.rig = new OrbitRig(this.canvas, COLS, ROWS);
    this.rig.ignore = e => e.__fcClaimed === true;
    this.rig.onTap = (x, y) => this.tap(x, y);
    this.rig.onUserMove = () => { this.camAnim = null; clearTimeout(this.returnTimer); this.returnTimer = null; this.returnTo = null; };
    // a double tap's reset shows the whole board, fitted to the screen
    const baseReset = this.rig.reset.bind(this.rig);
    this.rig.reset = () => { baseReset(); if(this.world) this.fitDefault(); };
    this.active = true;
    board2d.style.visibility = 'hidden';
    setFigureSink((sh, frame, sx, sy, alpha, who) => { if(!board3dOn()) return false; this.pending.push({ sh, frame, sx, sy, alpha, who }); }, board3dOn);
    onGunfire((kind, from, to, noSmoke) => this.shot(kind, from, to, noSmoke));
    sizeCanvas();   // the 2D canvas's backing drops to the overlay's resolution (render-board targetRenderScale)
    this.resize();
    draw(); ensureAnimationLoopRunning();
    if(!this.raf) this.loop();
  }
  stop(){
    if(!this.active) return;
    this.active = false;
    setFigureSink(null); onGunfire(null);
    if(this.canvas) this.canvas.style.display = 'none';
    board2d.style.visibility = '';
    cancelAnimationFrame(this.raf); this.raf = null;
    this.disposeScene();
    if(this.renderer){ this.renderer.dispose(); this.renderer = null; }
    sizeCanvas(); draw();
  }
  makeRenderer(){
    const high = graphicsPref() === 'high';
    if(this.renderer) this.renderer.dispose();
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: high, powerPreference: 'high-performance' });
    this.renderer.outputEncoding = THREE.sRGBEncoding;
    this.renderer.shadowMap.enabled = high;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setPixelRatio(high ? Math.min(2, window.devicePixelRatio || 1) : 1);
    this.quality = high ? 'high' : 'low';
    this.worldKey = null;   // rebuilt for the new quality
  }
  /* High and Low differ in edge smoothing (antialias), which a browser fixes
     when a canvas's 3D context is first made: so the canvas is replaced, and
     the board started again on the new one, keeping where the camera was. */
  setGraphics(v){
    write(KEYS.graphics, v);
    if(!this.active) return;
    const keep = this.rig ? this.view() : null;
    this.stop();
    if(this.canvas){ this.canvas.remove(); this.canvas = null; }
    this.start().then(() => { if(keep && this.rig && this.ensureWorld()){ const r = this.rig; r.target.x = keep.x; r.target.z = keep.z; r.dist = keep.d; r.yaw = keep.yaw; r.pitch = keep.pitch; } });
  }
  setFigures(v){ write(KEYS.figures, v); figuresCache = null; }
  setBoard(v){ write(KEYS.board, v); this.wanted = v === '3d'; if(v === '3d') this.start(); else this.stop(); }
  resize(){
    if(!this.renderer || !this.canvas) return;
    const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    if(this.rig) this.rig.resize(w, h);
  }
  /* ---------- the world, rebuilt when the map changes ---------- */
  disposeScene(){
    if(this.atlas) this.atlas.dispose();
    if(this.smoke) this.smoke.clear();
    if(this.scene) this.scene.traverse(o => { if(o.geometry) o.geometry.dispose(); if(o.material && o.material.map && o.material.map !== this.overlayTex) o.material.map.dispose(); });
    this.scene = null; this.worldKey = null;
  }
  ensureWorld(){
    if(!state.terrain || !state.terrain.length) return false;
    const key = [COLS, ROWS, this.quality, state.viewEdge || '', toScreen(0, 0).x, toScreen(0, 0).y].join('|');
    if(this.scene && this.worldKey === key && this.terrainRef === state.terrain && this.waterRef === state.water) return true;
    this.disposeScene();
    this.terrainRef = state.terrain; this.waterRef = state.water;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#1b1f17');
    const hemi = new THREE.HemisphereLight('#dfe8ff', '#4a4030', 0.55);
    const sun = new THREE.DirectionalLight('#ffe8c0', 0.95);
    sun.position.set(COLS * 0.8, Math.max(COLS, ROWS) * 0.9, ROWS * 1.1);
    sun.target.position.set(COLS / 2, 0, ROWS / 2);
    if(this.quality === 'high'){
      sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
      const r = Math.max(COLS, ROWS) * 0.7;
      Object.assign(sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: 1, far: 80 }); sun.shadow.bias = -0.0005;
    }
    scene.add(hemi, sun, sun.target);
    this.world = buildWorld(scene, this.quality);
    this.world.grid.visible = false;            // the game draws its own grid, where it wants one
    this.ground = this.world.ground;
    // the game's flat drawing, draped over the ground
    if(!this.overlayTex){
      this.overlayTex = new THREE.CanvasTexture(board2d);
      this.overlayTex.encoding = THREE.sRGBEncoding;
      this.overlayTex.minFilter = THREE.LinearFilter; this.overlayTex.generateMipmaps = false;
    }
    const og = this.world.groundMesh.geometry.clone();
    const pos = og.attributes.position, uv = og.attributes.uv;
    for(let i = 0; i < pos.count; i++){
      const s = boardPtToScreen(pos.getX(i), pos.getZ(i));
      uv.setXY(i, s.x / SCOLS(), 1 - s.y / SROWS());
    }
    uv.needsUpdate = true;
    const om = new THREE.Mesh(og, new THREE.MeshBasicMaterial({ map: this.overlayTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    om.renderOrder = 2;
    scene.add(om);
    this.overlayMesh = om;
    this.atlas = new Atlas(scene);
    this.smoke = new Smoke(scene);
    this.scene = scene;
    this.worldKey = key;
    // the camera starts behind the player's own troops, as the flat board is shown
    const down = screenDirToBoard(0, 1);
    this.rig.cols = COLS; this.rig.rows = ROWS;
    this.rig.defaultYaw = Math.atan2(down.x, down.y);
    this.rig.reset();
    this.fitDefault();
    this.overlayDirty = true;
    return true;
  }
  /* The whole board in view at the start, whatever the screen's shape. */
  fitDefault(){
    /* The closest view that still shows the whole board, its four corners
       inside the screen with a little room: found by stepping in from far out. */
    const r = this.rig;
    r.target.set(COLS / 2, 0, ROWS / 2);
    const corners = [[0, 0], [COLS, 0], [0, ROWS], [COLS, ROWS]].map(([x, z]) => new THREE.Vector3(x, 0, z));
    const fits = () => { r.apply(); return corners.every(c => { const p = c.clone().project(r.camera); return Math.abs(p.x) < 0.97 && Math.abs(p.y) < 0.94; }); };
    let d = Math.max(COLS, ROWS) * 3;
    r.dist = d;
    while(d > 4){ r.dist = d * 0.97; if(!fits()) break; d *= 0.97; }
    r.dist = d;
    this.homeDist = d;
  }
  /* ---------- the game's draw(), each time it runs ---------- */
  beforeDraw(){ this.pending = []; }
  afterDraw(){ this.sprites = this.pending; this.overlayDirty = true; }
  /* ---------- a frame ---------- */
  loop(){
    this.raf = requestAnimationFrame(() => this.loop());
    if(!this.active || !this.renderer) return;
    if(!this.ensureWorld()) return;
    const t = performance.now();
    this.stepCamera(t);
    this.rig.apply();
    if(this.overlayDirty){ this.overlayTex.needsUpdate = true; this.overlayDirty = false; }
    if(this.world.mills) for(const s of this.world.mills) s.rotation.z = t / 2600;
    this.drawSprites();
    this.smoke.update(t);
    this.renderer.render(this.scene, this.rig.camera);
    const info = this.renderer.info.render;
    this._frames++;
    if(t - this._fpsAt > 500){ this.stats = { fps: Math.round(this._frames * 1000 / (t - this._fpsAt)), calls: info.calls, triangles: info.triangles, sprites: this.drawn }; this._frames = 0; this._fpsAt = t; }
    // the game's own loop draws while anything moves; between moves the idle men still breathe
    if(t - (this._kick || 0) > 250){ this._kick = t; ensureAnimationLoopRunning(); }
  }
  drawSprites(){
    const size = FIGURE_SIZE[figuresPref()] || FIGURE_SIZE.small;
    const yaw = this.rig.yaw;
    const camRight = { x: Math.cos(yaw), z: -Math.sin(yaw) }, camFwd = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
    let drawn = 0;
    for(const p of this.sprites){
      let sh = p.sh;
      const who = p.who;
      // turn the man to the camera: his facing on the flat board, as a direction on the ground
      if(who && sh.meta){
        const fs = sh.f;
        const sd = fs === 'away' ? [0, -1] : fs === 'toward' ? [0, 1] : fs === 'left' ? [-1, 0] : fs === 'right' ? [1, 0] : null;
        if(sd){
          const d = screenDirToBoard(sd[0], sd[1]);
          const toward = -(d.x * camFwd.x + d.y * camFwd.z), rt = d.x * camRight.x + d.y * camRight.z;
          const fac = sh.meta.facings || [];
          let want = Math.abs(toward) >= Math.abs(rt) || !fac.includes('left') ? (toward > 0 ? 'toward' : 'away') : (rt > 0 ? 'right' : 'left');
          if(!fac.includes(want)) want = fac.includes(who.uf) ? who.uf : fs;
          if(want !== fs){
            const m = /\/([a-z]+)_(?:toward|away|left|right)_v\d+\.webp$/.exec(sh.url || '');
            const alt = m && figureSheet(who.nation, who.type, m[1], want, who.v, want);
            if(alt && alt.a && sh.a && alt.a.frameCount === sh.a.frameCount) sh = alt;
          }
        }
      }
      const fr = this.atlas.frames(sh);
      if(!fr) continue;
      const r = fr.rects[Math.min(fr.rects.length - 1, p.frame)];
      const meta = sh.meta;
      const ay = meta.anchorYByFacing && meta.anchorYByFacing[sh.f] != null ? meta.anchorYByFacing[sh.f] : meta.anchorY;
      const h = meta.displayScale * FIGURE_SCALE * size, w = h * meta.frameWidth / meta.frameHeight;
      const b = screenPtToBoard(p.sx, p.sy);
      const gy = this.ground.heightAt(b.x, b.y) + 0.01;
      fr.page.batch.push(b.x, gy, b.y, w, h, ay, r, Math.max(0, Math.min(1, p.alpha)));
      drawn++;
    }
    for(const page of this.atlas.pages) page.batch.end(this.rig.camera);
    this.drawn = drawn;
  }
  /* ---------- a shot: flash and smoke at the muzzle, and the camera on it ---------- */
  shot(kind, from, to, noSmoke){
    if(!this.scene) return;
    const fx = from.x + 0.5, fz = from.y + 0.5, tx = to.x + 0.5, tz = to.y + 0.5;
    const d = Math.hypot(tx - fx, tz - fz) || 1, dx = (tx - fx) / d, dz = (tz - fz) / d;
    if(!noSmoke){
      const points = kind === 'cannon' ? [0] : [-0.25, 0, 0.25];
      points.forEach((o, i) => setTimeout(() => {
        if(!this.scene) return;
        const px = fx + dx * 0.28 - dz * o, pz = fz + dz * 0.28 + dx * o;
        this.smoke.puff(px, this.ground.heightAt(px, pz) + (kind === 'cannon' ? 0.16 : 0.12), pz, kind === 'cannon' ? 'cannon' : 'musket', dx, dz);
      }, i * 70));
    }
    /* Matthew: any firing or volleying zooms in. The AI's own shots are framed
       by the AI (cameraToAction) and its view is restored after its turn; the
       player's own come back to where they were looking a moment later. */
    if(!CameraPref.enabled) return;
    const mine = !(state.mode === 'ai' && state.turn === state.aiSide);
    this.frame([{ x: from.x, y: from.y }, { x: to.x, y: to.y }], { durationMs: 420, comeBack: mine && !this.parked });
  }
  /* ---------- the camera, when the game asks ---------- */
  animateTo(target, dist, ms){
    const r = this.rig;
    /* Keep the view on the board: the centre stays far enough in from the
       edges that the field, not the table, fills the screen. */
    const half = Math.tan(14 * Math.PI / 180) * dist;
    const mx = Math.min(COLS / 2, half * 0.9), mz = Math.min(ROWS / 2, half * 0.9);
    target = { x: Math.max(mx, Math.min(COLS - mx, target.x)), z: Math.max(mz, Math.min(ROWS - mz, target.z)) };
    this.camAnim = { t0: performance.now(), ms: Math.max(1, ms), from: { x: r.target.x, z: r.target.z, d: r.dist }, to: { x: target.x, z: target.z, d: dist } };
  }
  stepCamera(t){
    const a = this.camAnim; if(!a) return;
    const k = Math.min(1, (t - a.t0) / a.ms), e = easeInOut(k), r = this.rig;
    r.target.x = a.from.x + (a.to.x - a.from.x) * e; r.target.z = a.from.z + (a.to.z - a.from.z) * e;
    r.dist = a.from.d + (a.to.d - a.from.d) * e;
    if(k >= 1) this.camAnim = null;
  }
  view(){ const r = this.rig; return { x: r.target.x, z: r.target.z, d: r.dist, yaw: r.yaw, pitch: r.pitch }; }
  cameraTo(x, y, opts = {}){
    if(!this.rig) return;
    const zoom = opts.zoom != null ? opts.zoom : 1.4;
    this.animateTo({ x: x + 0.5, z: y + 0.5 }, Math.max(this.rig.distMin, (this.homeDist || this.rig.dist) / zoom), opts.durationMs != null ? opts.durationMs : 900);
  }
  /* Frame the units (or points) an action involves: the box round them, with room. */
  frame(list, opts = {}){
    if(!this.rig || !list.length) return;
    const xs = list.map(u => u.x + 0.5), zs = list.map(u => u.y + 0.5);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) + 1;
    const dist = Math.max(this.rig.distMin + 1, Math.min(this.homeDist || 30, span * 2.6 + 2.5));
    if(opts.comeBack){
      if(!this.returnTo) this.returnTo = this.view();
      clearTimeout(this.returnTimer);
      this.returnTimer = setTimeout(() => { const v = this.returnTo; this.returnTo = null; this.returnTimer = null; if(v) this.animateTo({ x: v.x, z: v.z }, v.d, 700); }, 1900);
    }
    this.animateTo({ x: cx, z: cz }, dist, opts.durationMs != null ? opts.durationMs : 420);
  }
  park(){ if(this.rig && !this.parked) this.parked = this.view(); }
  restore(){ const v = this.parked; this.parked = null; if(v) this.animateTo({ x: v.x, z: v.z }, v.d, 900); }
  resetView(){ if(!this.rig) return; this.camAnim = null; this.rig.reset(); this.fitDefault(); }
  /* ---------- taps: the square under the finger ---------- */
  hit(clientX, clientY){
    if(!this.world || !this.rig) return null;
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, this.rig.camera);
    const h = ray.intersectObject(this.world.groundMesh)[0];
    if(!h) return null;
    const x = Math.floor(h.point.x), y = Math.floor(h.point.z);
    return x >= 0 && y >= 0 && x < COLS && y < ROWS ? { x, y } : null;
  }
  pick(clientX, clientY){
    const b = this.hit(clientX, clientY);
    if(!b) return null;
    const s = toScreen(b.x, b.y);
    return { x: s.x, screenY: s.y };
  }
  tap(clientX, clientY){
    board2d.dispatchEvent(new MouseEvent('click', { clientX, clientY, bubbles: true, cancelable: true }));
  }
  bindInput(){
    const c = this.canvas;
    /* Every pointer event goes on to the flat board too (render-board leaves its
       own pan and zoom alone while the 3D board is on), so a drag that starts on
       one of your units in deployment, or a long press to ping, still works. */
    const forward = e => {
      if(!this.active) return;
      const ev = new PointerEvent(e.type, { pointerId: e.pointerId, pointerType: e.pointerType, isPrimary: e.isPrimary, clientX: e.clientX, clientY: e.clientY, button: e.button, buttons: e.buttons, bubbles: true, cancelable: true });
      board2d.dispatchEvent(ev);
      if(e.type === 'pointerdown' && pointerClaimed(e.pointerId)) e.__fcClaimed = true;
    };
    for(const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) c.addEventListener(t, forward);
  }
  /* ---------- where a square is on the screen ---------- */
  project(x, y){
    const r = this.canvas.getBoundingClientRect();
    if(!this.world || !this.rig) return { x: r.left + r.width / 2, y: r.top + r.height / 2, cell: 30 };
    const cam = this.rig.camera;
    const wx = x + 0.5, wz = y + 0.5, gy = this.ground.heightAt(wx, wz);
    const p = new THREE.Vector3(wx, gy, wz).project(cam);
    const q = new THREE.Vector3(wx + 1, gy, wz).project(cam), q2 = new THREE.Vector3(wx, gy, wz + 1).project(cam);
    const px = v => ({ x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height });
    const a = px(p), b = px(q), b2 = px(q2);
    const cell = Math.max(6, (Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(b2.x - a.x, b2.y - a.y)) / 2);
    return { x: a.x, y: a.y, cell };
  }
  /* The floating battle text's layer: the whole wrap, untransformed; labels are placed by projection. */
  syncFct(el){
    const wrap = this.canvas.parentElement;
    el.style.left = '0px'; el.style.top = '0px';
    el.style.width = wrap.clientWidth + 'px'; el.style.height = wrap.clientHeight + 'px';
    el.style.transform = 'none';
    const mid = this.project(COLS / 2 - 0.5, ROWS / 2 - 0.5);
    el.style.setProperty('--fct-scale', Math.round(Math.max(24, Math.min(70, mid.cell * 1.3))) + 'px');
  }
  fctPoint(col, row){
    const wr = this.canvas.parentElement.getBoundingClientRect();
    const p = this.project(col, row);
    const x = p.x - wr.left, y = p.y - wr.top - p.cell * 0.35;
    return { centreX: x, top: y - p.cell * 0.5, bottom: y + p.cell * 0.5, atTopEdge: y < p.cell * 1.2 };
  }
}

export const board3d = new Board3D();
/* At start-up (boot.js): register with render-board and start if the player wants the 3D board. */
export function initBoard3D(){
  if(HEADLESS) return;
  setBoard3D(board3d);
  board3d.wanted = boardPref() === '3d' && board3dSuitable();
  // the flat board's painted ground is not needed to start a battle in 3D
  if(board3d.wanted) deferAssets(['assets/terrain/v2/grass', 'assets/terrain/v2/hill', 'assets/terrain/v2/farm', 'assets/terrain/v2/woods', 'assets/terrain/v2/building', 'assets/terrain/bridges']);
  try { window.__board3d = board3d; } catch { /* no window */ }   // for the checks (tools/lab/board3d-check.mjs)
  if(board3d.wanted) board3d.start().catch(e => { console.warn('3D board unavailable, Classic board kept:', e && e.message); board3d.stop(); });
}
