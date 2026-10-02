/* =========================================================
   UNIT FIGURES (Unit Figures brief, placeholder art)

   Each unit is drawn as a squad of separately animated men instead of one icon:
   10 infantry, 3 riders, or a cannon with 2 crew, laid out in their formation,
   and men fall as the unit takes combat results. Visual only: nothing here
   touches rules, the AI, the dice or the simulator.

   UNIT_STYLE ('figures', the default, or 'v1': the old icons and sprite
   exactly; ?units=v1 for one visit) mirrors TERRAIN_STYLE. The figures are off
   when the game runs headless (the simulator), where nothing is drawn and
   nothing here is ticked.

   WHAT IS KEPT, AND WHERE
   - state.figures[unitId] = { n, alive: [bool], slots: [slot per man],
     layout, ev }: which men are standing and where, and how many casualty
     events the unit has had (seeds the next choice). On state, so undo, the
     online sync and the match record carry it, and a reloaded field matches.
   - state.figureBodies = [{ id, bx, by, nation, type, facing, wreck }]: every
     man who fell, in BOARD coordinates, for the whole battle.
   - Runtime only (never saved): which man is mid-fall, a unit's fire or melee
     animation, and a walk between formations.

   RANDOMNESS. Casualty choice, position jitter and start frames use their own
   generator seeded from the match seed + unit id + event count. Never the dice
   generator: battle outcomes and simulator results cannot change, and both
   phones online (and a replay) choose the same men.

   ART. assets/units/{nation}/{unitType}/{anim}_{facing}.webp, a horizontal
   strip of equal frames, feet at bottom centre, drawn at 2x; one sidecar
   {unitType}.json per type (frameWidth, frameHeight, anchorX, anchorY,
   displayScale, and per anim frameCount, fps, loop). The cannon has its own
   sheets under the type ARTILLERY_GUN (idle, fire, wreck); ARTILLERY is its
   crew. The placeholder sheets come from tools/units/make-placeholders.py.
========================================================= */
import { CELL, SIDES, UNIT_TYPES, state } from './data-core.js';
import { toScreen, unitMoveKind } from './render-board.js';

export const UNIT_STYLE = (() => {
  try { const q = new URLSearchParams(globalThis.location ? location.search : '').get('units'); if(q === 'v1' || q === 'figures') return q; }
  catch { /* no address: the default stands */ }
  return 'figures';
})();
const HEADLESS = typeof navigator === 'undefined' || /jsdom/i.test(navigator.userAgent || '');
export const FIGURES = UNIT_STYLE === 'figures' && !HEADLESS;

const NATION = { [SIDES.RED]: 'british', [SIDES.BLUE]: 'french' };
const SHEET_TYPES = ['INFANTRY', 'GUARD', 'LIGHT_CAV', 'HEAVY_CAV', 'ARTILLERY', 'ARTILLERY_GUN'];
const MEN = { INFANTRY: 10, GUARD: 10, LIGHT_CAV: 3, HEAVY_CAV: 3, ARTILLERY: 2 };
const FLOOR = { INFANTRY: 3, GUARD: 3, LIGHT_CAV: 1, HEAVY_CAV: 1, ARTILLERY: 1 };
const WALK_MS = 600;
const MELEE_MS = 2600;

/* ---------- the art ---------- */
const META = {};              // type -> sidecar JSON (same for both nations)
const IMG = {};               // url -> Image
let ready = false;
export function initFigures(){
  if(!FIGURES) return;
  Promise.all(SHEET_TYPES.map(t => fetch(`assets/units/british/${t}/${t}.json`).then(r => r.json()).then(j => { META[t] = j; })))
    .then(() => { ready = true; }, () => { ready = false; });
}
export const figuresReady = () => FIGURES && ready;
function sheet(nation, type, anim, facing){
  const m = META[type];
  if(!m) return null;
  const f = m.facings.includes(facing) ? facing : (facing === 'left' || facing === 'right' ? 'toward' : m.facings[0]);
  const url = `assets/units/${nation}/${type}/${anim}_${f}.webp`;
  let img = IMG[url];
  if(!img){ img = IMG[url] = new Image(); img.src = url; }
  return img.complete && img.naturalWidth ? { img, meta: m, a: m.anims[anim] || m.anims.idle } : null;
}

/* ---------- seeded randomness (never the dice) ---------- */
function hash(str){ let h = 2166136261; for(let i = 0; i < str.length; i++){ h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seedStr){
  let a = hash(seedStr);
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const matchSeed = () => String((state._matchMeta && state._matchMeta.seed) || 'x');

/* ---------- the squad ---------- */
const kind = u => (UNIT_TYPES[u.type] || {}).key;
export function hasFigures(u){ return !!MEN[kind(u)]; }
function squad(u){
  const k = kind(u);
  if(!MEN[k]) return null;
  state.figures = state.figures || {};
  let s = state.figures[u.id];
  if(!s){
    s = state.figures[u.id] = { n: MEN[k], alive: Array(MEN[k]).fill(true), slots: Array.from({ length: MEN[k] }, (_, i) => i), layout: null, ev: 0 };
  }
  return s;
}
export const standing = u => { const s = squad(u); return s ? s.alive.filter(Boolean).length : 0; };

/* ---------- facing ---------- */
/* The unit faces the enemy's edge; on screen that is up ('away') or down
   ('toward') depending on which way the board is turned. Turned around or
   fleeing, it flips. */
function facingOf(u, fleeing){
  const fwd = u.side === SIDES.RED ? -1 : 1;
  const sy = toScreen(0, 5 + fwd).y - toScreen(0, 5).y;
  let away = sy < 0;
  if(u.turnOnly || fleeing) away = !away;
  return away ? 'away' : 'toward';
}

/* ---------- formations: slot positions in cell units, screen space ----------
   x across, y down from the cell centre, at the FEET. front = the rank nearest
   the enemy; for 'toward' that is the rank nearest the viewer. */
function ranks(counts, facing){
  const ys = counts.length === 2 ? [0.30, 0.12] : [0.34, 0.20, 0.06];
  const order = facing === 'away' ? [...ys].reverse() : ys;
  const out = [];
  counts.forEach((n, r) => { for(let i = 0; i < n; i++) out.push({ x: (i - (n - 1) / 2) * 0.18, y: order[r], f: facing }); });
  return out;
}
function layoutFor(u, facing, partner){
  const k = kind(u);
  if(partner){
    // Attack Column: 20 men, 4 wide by 5 deep, the two units interleaved.
    const out = [];
    for(let r = 0; r < 5; r++) for(let c = 0; c < 4; c++) out.push({ x: (c - 1.5) * 0.19, y: -0.06 + r * 0.095, f: facing });
    return out;
  }
  if(k === 'INFANTRY' || k === 'GUARD'){
    if(u.formation === 'square'){
      const out = [];
      for(let i = 0; i < 4; i++) out.push({ x: (i - 1.5) * 0.19, y: 0.34, f: 'toward' });
      for(let i = 0; i < 4; i++) out.push({ x: (i - 1.5) * 0.19, y: -0.02, f: 'away' });
      out.push({ x: -0.40, y: 0.16, f: 'left' }, { x: 0.40, y: 0.16, f: 'right' });
      return out;
    }
    return u.side === SIDES.RED ? ranks([5, 5], facing) : ranks([4, 3, 3], facing);
  }
  if(k === 'LIGHT_CAV' || k === 'HEAVY_CAV') return [{ x: -0.27, y: 0.32, f: facing }, { x: 0, y: 0.22, f: facing }, { x: 0.27, y: 0.32, f: facing }];
  if(k === 'ARTILLERY'){
    const back = facing === 'away' ? 0.36 : 0.06;   // crew behind the gun
    return [{ x: -0.30, y: back, f: facing }, { x: 0.30, y: back, f: facing }];
  }
  return [];
}
const layoutKey = (u, partnerId) => `${u.formation || 'line'}|${partnerId || ''}`;

/* ---------- runtime animation state (never saved) ---------- */
const FX = {};        // unitId -> { anim: 'fire'|'melee', start, until }
const WALK = {};      // unitId -> { start, from: Map(man -> {x,y}) }
const FALLING = {};   // bodyId -> start
let bodyCounter = 0;
const now = () => Date.now();

/* ---------- drawing a unit ---------- */
/* ctx is translated to nothing: cx, cy are the cell centre in canvas pixels. */
export function drawUnitFigures(c, u, cx, cy, alpha = 1){
  if(!figuresReady()) return false;
  const s = squad(u); if(!s) return false;
  const anim = unitAnim(u);
  const facing = facingOf(u, anim === 'flee');
  const slots = layoutFor(u, facing, null);
  const key = layoutKey(u, null);
  if(s.layout !== key) reassign(u, s, key, WALK_PREV[u.id]);
  WALK_PREV[u.id] = slots;
  drawSquad(c, u, s, slots, cx, cy, anim, alpha);
  return true;
}
const WALK_PREV = {};
function reassign(u, s, key, prevSlots){
  const first = s.layout == null;
  s.layout = key;
  if(first) return;
  const from = new Map();
  s.alive.forEach((a, m) => { if(a && prevSlots && prevSlots[s.slots[m]]) from.set(m, prevSlots[s.slots[m]]); });
  let k = 0;
  s.alive.forEach((a, m) => { if(a) s.slots[m] = k++; });
  WALK[u.id] = { start: now(), from };
}

/* Two units stacked in one square: their men share the 20-slot column block,
   interleaved (unit 1 the even slots, unit 2 the odd), each unit keeping its
   own men and casualties. */
export function drawColumnFigures(c, u1, u2, cx, cy){
  if(!figuresReady()) return false;
  const s1 = squad(u1), s2 = squad(u2);
  if(!s1 || !s2) return false;
  const anim1 = unitAnim(u1), anim2 = unitAnim(u2);
  const facing = facingOf(u1, false);
  const block = layoutFor(u1, facing, u2);
  const key1 = layoutKey(u1, u2.id), key2 = layoutKey(u2, u1.id);
  for(const [u, s, key, par] of [[u1, s1, key1, 0], [u2, s2, key2, 1]]){
    if(s.layout !== key){
      const prev = WALK_PREV[u.id];
      const first = s.layout == null;
      s.layout = key;
      if(!first){
        const from = new Map();
        s.alive.forEach((a, m) => { if(a && prev && prev[s.slots[m]]) from.set(m, prev[s.slots[m]]); });
        WALK[u.id] = { start: now(), from };
      }
      let k = 0;
      s.alive.forEach((a, m) => { if(a) s.slots[m] = k++; });
      s._par = par;
    }
    // This unit's view of the block: its own men on every other slot.
    const own = block.filter((_, i) => i % 2 === par);
    WALK_PREV[u.id] = own;
  }
  // Draw both, rear rank first, as one sorted list of men.
  const men = [];
  for(const [u, s, anim, par] of [[u1, s1, anim1, 0], [u2, s2, anim2, 1]]){
    const own = block.filter((_, i) => i % 2 === par);
    collectMen(men, u, s, own, anim);
  }
  paintMen(c, men, cx, cy, 1);
  return true;
}

function unitAnim(u){
  const fx = FX[u.id];
  const t = now();
  const moving = unitMoveKind(u.id);
  if(moving === 'rout') return 'flee';
  if(moving) return 'march';
  if(WALK[u.id] && t - WALK[u.id].start < WALK_MS) return 'march';
  if(fx && t < fx.until) return fx.anim;
  return 'idle';
}

function collectMen(men, u, s, slots, anim){
  const nation = NATION[u.side];
  const k = kind(u);
  const R = rng(matchSeed() + '|' + u.id + '|layout');
  const jit = s.alive.map(() => [(R() - 0.5) * 0.05, (R() - 0.5) * 0.04, Math.floor(R() * 12)]);
  const walk = WALK[u.id];
  const w = walk ? Math.min(1, (now() - walk.start) / WALK_MS) : 1;
  if(walk && w >= 1) delete WALK[u.id];
  s.alive.forEach((a, m) => {
    if(!a) return;
    const slot = slots[s.slots[m]] || slots[m % Math.max(1, slots.length)];
    if(!slot) return;
    let x = slot.x + jit[m][0], y = slot.y + jit[m][1];
    if(walk && walk.from.has(m) && w < 1){ const f = walk.from.get(m); x = f.x + (x - f.x) * w; y = f.y + (y - f.y) * w; }
    men.push({ x, y, nation, type: k, facing: slot.f, anim, phase: jit[m][2], start: (FX[u.id] && FX[u.id].start) || 0 });
  });
  if(k === 'ARTILLERY'){
    // The gun itself, centred in front of its crew.
    const facing = slots[0] ? slots[0].f : 'toward';
    men.push({ x: 0, y: facing === 'away' ? 0.18 : 0.30, nation, type: 'ARTILLERY_GUN', facing, anim: anim === 'fire' ? 'fire' : 'idle', phase: 0, start: (FX[u.id] && FX[u.id].start) || 0 });
  }
}
function drawSquad(c, u, s, slots, cx, cy, anim, alpha){
  const men = [];
  collectMen(men, u, s, slots, anim);
  paintMen(c, men, cx, cy, alpha);
}

/* Paints men rear first (smaller y first), each from its sheet at the
   animation frame for now. One-shot animations hold their last frame. */
function paintMen(c, men, cx, cy, alpha){
  men.sort((a, b) => a.y - b.y);
  const t = now();
  c.save();
  if(alpha !== 1) c.globalAlpha = alpha;
  for(const m of men){
    const sh = sheet(m.nation, m.type, m.anim, m.facing) || sheet(m.nation, m.type, 'idle', m.facing);
    if(!sh) continue;
    const { img, meta, a } = sh;
    const fps = a.fps || 12, n = a.frameCount || 1;
    // Loops start each man on his own frame (phase), so no two move in step;
    // one-shot animations (fire) run from their start and hold the last frame.
    const frame = a.loop ? Math.floor((t + m.phase * 83) / (1000 / fps)) % n : Math.min(n - 1, Math.floor((t - m.start) / (1000 / fps)));
    const h = CELL * meta.displayScale, w = h * meta.frameWidth / meta.frameHeight;
    const px = cx + m.x * CELL - w * meta.anchorX, py = cy + m.y * CELL - h * meta.anchorY;
    c.drawImage(img, frame * meta.frameWidth, 0, meta.frameWidth, meta.frameHeight, px, py, w, h);
  }
  c.restore();
}

/* ---------- events: what happened to a unit (engine-state logReplay) ---------- */
function strike(u, count){
  const s = squad(u); if(!s || count <= 0) return;
  const k = kind(u);
  s.ev += 1;
  const R = rng(matchSeed() + '|' + u.id + '|' + s.ev);
  const up = () => s.alive.map((a, i) => (a ? i : -1)).filter(i => i >= 0);
  const floor = count === Infinity ? 0 : FLOOR[k];
  let left = up();
  let n = Math.min(count, Math.max(0, left.length - floor));
  while(n-- > 0 && left.length){
    const pick = left[Math.floor(R() * left.length)];
    fell(u, s, pick);
    left = up();
  }
}
function fell(u, s, man){
  s.alive[man] = false;
  const slots = WALK_PREV[u.id] || layoutFor(u, facingOf(u, false), null);
  const slot = slots[s.slots[man]] || { x: 0, y: 0.2, f: 'toward' };
  const p = boardOffset(slot.x, slot.y);
  const id = 'b' + (++bodyCounter) + '_' + u.id + '_' + man;
  (state.figureBodies = state.figureBodies || []).push({ id, bx: u.x + p.x, by: u.y + p.y, nation: NATION[u.side], type: kind(u), facing: slot.f, side: u.side });
  FALLING[id] = now();
}
/* A screen-space offset as board coordinates, so bodies stay put whichever
   way the board is later turned. */
function boardOffset(dx, dy){
  const o = toScreen(5, 5), ex = toScreen(6, 5), ey = toScreen(5, 6);
  const ax = ex.x - o.x, ay = ey.y - o.y;   // +1 or -1 when the board is turned
  return { x: dx * ax, y: dy * ay };
}
function wreck(u){
  const slots = layoutFor(u, facingOf(u, false), null);
  const facing = slots[0] ? slots[0].f : 'toward';
  const p = boardOffset(0, facing === 'away' ? 0.18 : 0.30);
  const id = 'w' + (++bodyCounter) + '_' + u.id;
  (state.figureBodies = state.figureBodies || []).push({ id, bx: u.x + p.x, by: u.y + p.y, nation: NATION[u.side], type: 'ARTILLERY_GUN', facing, side: u.side, wreck: true });
}
const unitById = id => (state.units || []).find(u => u.id === id);

export function figuresOnEvent(ev){
  if(!FIGURES || !ev) return;
  try {
    if(ev.type === 'fire'){
      if(ev.volley){
        const sh = unitById(ev.shooterId); if(sh) FX[sh.id] = { anim: 'fire', start: now(), until: now() + 600 };
        const tg = unitById(ev.targetId);
        if(tg) strike(tg, ev.effect === 'none' ? (inf(tg) ? 1 : 0) : (inf(tg) ? 2 : 1));
      } else {
        const g = unitById(ev.gunId); if(g) FX[g.id] = { anim: 'fire', start: now(), until: now() + 700 };
        const tg = unitById(ev.targetId);
        if(tg && ev.hit) strike(tg, inf(tg) ? 1 : 0);
      }
    } else if(ev.type === 'fight'){
      const a = unitById(ev.attackerId), d = unitById(ev.defenderId);
      for(const u of [a, d]) if(u) FX[u.id] = { anim: 'melee', start: now(), until: now() + MELEE_MS };
      if(a && d && ev.result && ev.result !== 'stalemate' && ev.aRoll !== ev.dRoll){
        const loser = ev.aRoll > ev.dRoll ? d : a;
        if(ev.result !== 'destroy') strike(loser, inf(loser) ? 2 : 1);
      }
    } else if(ev.type === 'status' && (ev.newStatus === 'Destroyed' || ev.newStatus === 'Lost')){
      const u = unitById(ev.unitId);
      if(u && hasFigures(u) && standing(u) > 0){
        strike(u, Infinity);
        if(kind(u) === 'ARTILLERY') wreck(u);
      }
    }
  } catch { /* drawing aid only: never into the game */ }
}
const inf = u => kind(u) === 'INFANTRY' || kind(u) === 'GUARD';

/* ---------- the fallen ---------- */
/* Bodies sit above the terrain and below the units and smoke. The settled ones
   are baked into one offscreen canvas, rebuilt only when a body is added or
   the view changes; a man still falling is drawn live until his fall ends. */
let bake = null;
export function drawFigureBodies(c, canvasW, canvasH, viewKey, hiddenAt){
  if(!figuresReady()) return;
  const bodies = state.figureBodies || [];
  if(!bodies.length){ bake = null; return; }
  const t = now();
  const settled = [], falling = [];
  for(const b of bodies){
    if(hiddenAt && hiddenAt(b)) continue;
    const st = FALLING[b.id];
    if(st != null){
      const meta = META[b.type], a = meta && meta.anims.fall;
      const dur = a ? (a.frameCount / a.fps) * 1000 : 400;
      if(t - st < dur){ falling.push({ b, st }); continue; }
      delete FALLING[b.id];
    }
    settled.push(b);
  }
  const key = [viewKey, canvasW, canvasH, CELL, settled.length, settled.length && settled[settled.length - 1].id].join('|');
  if(!bake || bake.key !== key){
    const off = bake && bake.canvas ? bake.canvas : document.createElement('canvas');
    off.width = canvasW; off.height = canvasH;
    const g = off.getContext('2d');
    g.setTransform(c.getTransform());
    g.clearRect(-1e4, -1e4, 2e4, 2e4);
    let missing = false;
    for(const b of settled) if(!paintBody(g, b, null)) missing = true;
    bake = { key: missing ? key + '|partial' + t : key, canvas: off };
  }
  c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.drawImage(bake.canvas, 0, 0); c.restore();
  for(const f of falling) paintBody(c, f.b, f.st);
}
function paintBody(c, b, fallStart){
  const anim = b.wreck ? 'wreck' : 'fall';
  const sh = sheet(b.nation, b.type, anim, b.facing);
  if(!sh) return false;
  const { img, meta, a } = sh;
  const n = a.frameCount || 1;
  const frame = fallStart == null ? n - 1 : Math.min(n - 1, Math.floor((now() - fallStart) / (1000 / (a.fps || 12))));
  const p = toScreen(b.bx, b.by);
  const cx = (p.x + 0.5) * CELL, cy = (p.y + 0.5) * CELL;
  const h = CELL * meta.displayScale, w = h * meta.frameWidth / meta.frameHeight;
  c.drawImage(img, frame * meta.frameWidth, 0, meta.frameWidth, meta.frameHeight, cx - w * meta.anchorX, cy - h * meta.anchorY, w, h);
  return true;
}
export const figuresAnimating = () => FIGURES && (Object.keys(FALLING).length > 0 || Object.keys(WALK).length > 0);
