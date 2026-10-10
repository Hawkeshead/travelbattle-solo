/* =========================================================
   UNIT FIGURES

   Each unit is drawn as a squad of separately animated men instead of one icon:
   10 infantry, 3 riders, or a cannon with 2 crew, laid out in their formation,
   and men fall as the unit takes combat results. Visual only: nothing here
   touches rules, the AI, the dice or the simulator.

   Drawn when Unit models is 'Animated' (see unitModels below); 'Classic' is
   the old icons and sprite, untouched. Off when the game runs headless (the
   simulator), where nothing is drawn and nothing here is ticked.

   WHAT IS KEPT, AND WHERE
   - state.figures[unitId] = { n, alive: [bool], slots: [slot per man],
     v: [variant per man], layout, ev }: which men are standing, where, which
     face (and horse) each has, and how many casualty events the unit has had
     (seeds the next choice). On state, so undo, the online sync and the match
     record carry it, and a reloaded field matches.
   - state.figureBodies = [{ id, bx, by, nation, type, facing, uf, v, wreck }]:
     every man who fell, in BOARD coordinates, for the whole battle.
   - Runtime only (never saved): which man is mid-fall, a unit's fire or melee
     animation, and a walk between formations.

   RANDOMNESS. Casualty choice, variants, position jitter and start frames use
   their own generator seeded from the match seed + unit id (+ event count).
   Never the dice generator: battle outcomes and simulator results cannot
   change, and both phones online (and a replay) choose the same men.

   ART (Animated). assets/units-pixel/{nation}/{UNIT_TYPE}/{anim}_{facing}_v{n}.webp,
   one horizontal strip of equal frames per file, with a sidecar
   {UNIT_TYPE}.json (frameWidth, frameHeight, displayScale, anchors, variants,
   facings, anims with frameCount/fps/loop); see tools/units/pixel/README.md.
   Types: INFANTRY, GUARD, GUARD_BEARER (one per Guard unit, flag baked in),
   ARTILLERY (the gunners), ARTILLERY_GUN (idle, fire, wreck), LIGHT_CAV,
   HEAVY_CAV. Actions: idle, march, charge (cavalry gallop), fire, serve
   (gunners), melee, fall (held as the body), flee.
========================================================= */
import { CELL, SIDES, UNIT_TYPES, state } from './data-core.js';
import { ensureAnimationLoopRunning, toScreen, unitMoveKind } from './render-board.js';

/* UNIT MODELS: 'animated' (the pixel troops, assets/units-pixel, the default)
   or 'classic' (the old icons and sprite, exactly as before). Chosen in the
   battle Menu (Display > Unit models), kept per device in localStorage, and
   switched live: nothing is reloaded. ?units=animated or ?units=classic
   overrides it for one page load without touching the saved choice (?units=v1,
   the old name for the icons, still means classic).

   The placeholder 'figures' art (assets/units, tools/units/make-placeholders.py)
   is no longer offered; its code path below is kept (PIXEL() false) and the
   tag units-before-pixel holds the last state that used it. */
const MODELS_KEY = 'fc_unit_models';
const URL_MODELS = (() => {
  try {
    const q = new URLSearchParams(globalThis.location ? location.search : '').get('units');
    if(q === 'animated' || q === 'classic') return q;
    if(q === 'v1') return 'classic';
  } catch { /* no address */ }
  return null;
})();
function savedModels(){
  try { return localStorage.getItem(MODELS_KEY) === 'classic' ? 'classic' : 'animated'; }
  catch { return 'animated'; }
}
let style = URL_MODELS || savedModels();
export const unitModels = () => style;
export function setUnitModels(m){
  style = m === 'classic' ? 'classic' : 'animated';
  try { localStorage.setItem(MODELS_KEY, style); } catch { /* private mode: this visit only */ }
  bake = null;
}
const PIXEL = () => style !== 'figures';
const HEADLESS = typeof navigator === 'undefined' || /jsdom/i.test(navigator.userAgent || '');
/* Drawing figures (Animated). The bookkeeping underneath (who has fallen,
   where the bodies lie, each man's variant) runs whatever the setting, so
   switching mid-battle shows the true state, and two phones online keep the
   same state.figures whichever way each player has set his own screen. */
export const figuresOn = () => !HEADLESS && style !== 'classic';
const TRACK = !HEADLESS;

const NATION = { [SIDES.RED]: 'british', [SIDES.BLUE]: 'french' };
const OLD_TYPES = ['INFANTRY', 'GUARD', 'LIGHT_CAV', 'HEAVY_CAV', 'ARTILLERY', 'ARTILLERY_GUN'];
const PIX_TYPES = ['INFANTRY', 'GUARD', 'GUARD_BEARER', 'ARTILLERY', 'ARTILLERY_GUN', 'LIGHT_CAV', 'HEAVY_CAV'];
const MEN = { INFANTRY: 10, GUARD: 10, LIGHT_CAV: 3, HEAVY_CAV: 3, ARTILLERY: 2 };
const FLOOR = { INFANTRY: 3, GUARD: 3, LIGHT_CAV: 1, HEAVY_CAV: 1, ARTILLERY: 1 };
/* Faces, and horses, per man: the pixel sheets' "variants" (5 for every man
   and rider; the gun has 1). A constant rather than read from the JSON so a
   unit's men are the same whether or not the art has loaded yet. */
const VARIANTS = 5;
const WALK_MS = 600;
const MELEE_MS = 2600;

/* ---------- the art ---------- */
const META_PIX = {};          // type -> sidecar JSON (same for both nations)
const META_OLD = {};
const META = () => (PIXEL() ? META_PIX : META_OLD);
const IMG = {};               // url -> Image
let ready = false;
export function initFigures(){
  if(HEADLESS) return;
  const load = (dir, types, into) => Promise.all(types.map(t => fetch(`${dir}/british/${t}/${t}.json`).then(r => r.json()).then(j => { into[t] = j; })));
  (PIXEL() ? load('assets/units-pixel', PIX_TYPES, META_PIX) : load('assets/units', OLD_TYPES, META_OLD))
    .then(() => { ready = true; }, () => { ready = false; });
}
export const figuresReady = () => figuresOn() && ready;
/* The sheet for one man. A facing his type was not drawn in (a side-on view
   for cavalry, gunners, the bearer or the gun) uses his unit's own facing,
   toward or away (uf). An anim his type lacks (the bearer's fire or melee,
   gunners in a melee) is idle. */
function sheet(nation, type, anim, facing, v, uf){
  const m = META()[type];
  if(!m) return null;
  if(!m.anims[anim]) anim = 'idle';
  let f = facing, url;
  if(PIXEL()){
    if(!m.facings.includes(f)) f = m.facings.includes(uf) ? uf : m.facings[0];
    const vv = Math.min(Math.max(0, v | 0), (m.variants || 1) - 1);
    url = `assets/units-pixel/${nation}/${type}/${anim}_${f}_v${vv}.webp`;
  } else {
    if(!m.facings.includes(f)) f = f === 'left' || f === 'right' ? 'toward' : m.facings[0];
    url = `assets/units/${nation}/${type}/${anim}_${f}.webp`;
  }
  let img = IMG[url];
  if(!img){ img = IMG[url] = new Image(); img.src = url; }
  return img.complete && img.naturalWidth ? { img, meta: m, a: m.anims[anim], f } : null;
}
/* How long a one-shot anim runs, in ms (fallback when its art is missing). */
function animMs(type, anim, fallback){
  const a = META()[type] && META()[type].anims[anim];
  return a ? (a.frameCount / (a.fps || 12)) * 1000 : fallback;
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
  /* Each man's variant (face, and horse for a rider), dealt once from the
     figure generator (never the dice) and kept all battle: through formation
     changes, columns and splits, and on his body when he falls. On
     state.figures, so a saved match and the other phone online have it too.
     Filled in here as well for a squad saved before variants existed. */
  if(!s.v){
    const R = rng(matchSeed() + '|' + u.id + '|variants');
    s.v = s.alive.map(() => Math.floor(R() * VARIANTS));
  }
  return s;
}
export const standing = u => { const s = squad(u); return s ? s.alive.filter(Boolean).length : 0; };
/* The Guard's colour bearer: always the unit's last man, so the others fill
   their formation's ordinary places in order around him. -1 for every other
   type (and for the old placeholder art, which has no bearer). */
const bearerOf = (u, s) => (PIXEL() && kind(u) === 'GUARD' ? s.n - 1 : -1);

/* ---------- facing ---------- */
/* The unit faces the enemy's edge; on screen that is up ('away') or down
   ('toward') depending on which way the board is turned. Turned around, it
   flips. The pixel flee sheets already show the man turned to run, so a
   routing unit keeps its facing; the old placeholders flipped. */
function facingOf(u, fleeing){
  // Toward the enemy: up the board from the bottom edge, down it from the top
  // (a campaign rearguard action can put either side at either edge).
  const hr = state.mapBattle && state.mapBattle.homeRow && state.mapBattle.homeRow[u.side];
  const fwd = hr ? (hr === 'top' ? 1 : -1) : (u.side === SIDES.RED ? -1 : 1);
  const sy = toScreen(0, 5 + fwd).y - toScreen(0, 5).y;
  let away = sy < 0;
  if(u.turnOnly || (fleeing && !PIXEL())) away = !away;
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
  if(k === 'LIGHT_CAV' || k === 'HEAVY_CAV') return [{ x: -0.27, y: 0.32, f: facing }, { x: 0, y: 0.21, f: facing }, { x: 0.27, y: 0.32, f: facing }];
  if(k === 'ARTILLERY'){
    // Crew behind the gun (the pixel gun is deep, so they stand well back).
    const back = facing === 'away' ? 0.36 : (PIXEL() ? 0.04 : 0.06);
    return [{ x: -0.30, y: back, f: facing }, { x: 0.30, y: back, f: facing }];
  }
  return [];
}
/* The places a unit's men take: { rest, bearer }. rest is the ordinary slots
   the men fill in order; bearer is where the Guard's colour bearer stands, or
   null. Line: the middle of the British rear rank, the French middle rank.
   Column (par = this unit's half of the interleaved block): the centre of the
   block. Square: the middle of the square, facing the unit's way. */
function placesFor(u, slots, facing, par){
  if(kind(u) !== 'GUARD' || !PIXEL()) return { rest: slots, bearer: null };
  if(par == null && u.formation === 'square') return { rest: slots, bearer: { x: 0, y: 0.16, f: facing } };
  // Column block indices 10 (unit 1's evens) and 9 (unit 2's odds) are its
  // centre: own-list positions 5 and 4. Line: see ranks() for the order.
  const bi = par != null ? (par === 0 ? 5 : 4) : (u.side === SIDES.RED ? 7 : 5);
  return { rest: slots.filter((_, i) => i !== bi), bearer: slots[bi] || null };
}
const placeOf = (places, s, m, B) => (m === B ? places.bearer : places.rest[s.slots[m]]);
const layoutKey = (u, partnerId) => `${u.formation || 'line'}|${partnerId || ''}`;

/* ---------- runtime animation state (never saved) ---------- */
const FX = {};        // unitId -> { anim: 'fire'|'melee', start, until }
const WALK = {};      // unitId -> { start, from: Map(man -> {x,y}) }
const FALLING = {};   // bodyId -> start
const WALK_PREV = {}; // unitId -> the places it was last drawn in
let bodyCounter = 0;
const now = () => Date.now();

/* ---------- drawing a unit ---------- */
/* ctx is translated to nothing: cx, cy are the cell centre in canvas pixels. */
export function drawUnitFigures(c, u, cx, cy, alpha = 1){
  if(!figuresReady()) return false;
  const s = squad(u); if(!s) return false;
  const anim = unitAnim(u);
  const facing = facingOf(u, anim === 'flee');
  const places = placesFor(u, layoutFor(u, facing, null), facing, null);
  const key = layoutKey(u, null);
  if(s.layout !== key) reassign(u, s, key);
  WALK_PREV[u.id] = places;
  const men = [];
  collectMen(men, u, s, places, anim, facing);
  paintMen(c, men, cx, cy, alpha);
  return true;
}
/* A new formation: the men walk from where they stood to their new places,
   the living refilling the ordinary slots in order (the bearer keeps his own). */
function reassign(u, s, key){
  const first = s.layout == null;
  s.layout = key;
  const B = bearerOf(u, s);
  if(!first){
    const prev = WALK_PREV[u.id], from = new Map();
    s.alive.forEach((a, m) => { const p = a && prev && placeOf(prev, s, m, B); if(p) from.set(m, p); });
    WALK[u.id] = { start: now(), from };
  }
  let k = 0;
  s.alive.forEach((a, m) => { if(a && m !== B) s.slots[m] = k++; });
}

/* Two units stacked in one square: their men share the 20-slot column block,
   interleaved (unit 1 the even slots, unit 2 the odd), each unit keeping its
   own men and casualties. */
export function drawColumnFigures(c, u1, u2, cx, cy){
  if(!figuresReady()) return false;
  const s1 = squad(u1), s2 = squad(u2);
  if(!s1 || !s2) return false;
  const facing = facingOf(u1, false);
  const block = layoutFor(u1, facing, u2);
  const men = [];
  for(const [u, s, partner, par] of [[u1, s1, u2, 0], [u2, s2, u1, 1]]){
    const places = placesFor(u, block.filter((_, i) => i % 2 === par), facing, par);
    const key = layoutKey(u, partner.id);
    if(s.layout !== key) reassign(u, s, key);
    WALK_PREV[u.id] = places;
    // A column fights as one block: the unit not in the fight acts with the one that is.
    const shared = clashAnim(u1) || clashAnim(u2);
    collectMen(men, u, s, places, shared && !unitMoveKind(u.id) ? shared : unitAnim(u), facing);
  }
  // Both units' men as one list, painted rear rank first.
  paintMen(c, men, cx, cy, 1);
  return true;
}

function unitAnim(u){
  const fx = FX[u.id];
  const t = now();
  const moving = unitMoveKind(u.id);
  if(moving === 'rout') return 'flee';
  // The loser of a fight recoils to its new square at a run, not a walk.
  if(moving === 'pushback' && FLEE_UNTIL[u.id] > t) return 'flee';
  const ca = !moving && clashAnim(u);
  if(ca) return ca;
  // The gallop is cavalry's charge; infantry charging with the bayonet march.
  if(moving === 'charge' && (kind(u) === 'LIGHT_CAV' || kind(u) === 'HEAVY_CAV') && PIXEL()) return 'charge';
  if(moving) return 'march';
  if(WALK[u.id] && t - WALK[u.id].start < WALK_MS) return 'march';
  if(fx && t < fx.until) return fx.anim;
  return 'idle';
}

function collectMen(men, u, s, places, anim, facing){
  const nation = NATION[u.side];
  const k = kind(u);
  const B = bearerOf(u, s);
  // Position jitter and each man's place in the idle loop (0..1), from the
  // figure generator, so no two men sway or glance in step.
  const R = rng(matchSeed() + '|' + u.id + '|layout');
  const jit = s.alive.map(() => [(R() - 0.5) * 0.05, (R() - 0.5) * 0.04, R()]);
  const walk = WALK[u.id];
  const w = walk ? Math.min(1, (now() - walk.start) / WALK_MS) : 1;
  if(walk && w >= 1) delete WALK[u.id];
  const fx = FX[u.id];
  const cl = CLASH[u.id];
  // A clash's fall runs from the moment the verdict is shown; anything else from its own start.
  const start = anim === 'fall' && cl && cl.tEnd != null ? cl.tEnd : (fx && fx.start) || 0;
  // A battery's fire: the gun fires, the crew serve it, from the same moment.
  const manAnim = k === 'ARTILLERY' && anim === 'fire' && PIXEL() ? 'serve' : anim;
  s.alive.forEach((a, m) => {
    if(!a) return;
    const slot = placeOf(places, s, m, B) || places.rest[m % Math.max(1, places.rest.length)];
    if(!slot) return;
    let x = slot.x + jit[m][0], y = slot.y + jit[m][1];
    if(walk && walk.from.has(m) && w < 1){ const f = walk.from.get(m); x = f.x + (x - f.x) * w; y = f.y + (y - f.y) * w; }
    men.push({ x, y, nation, type: m === B ? 'GUARD_BEARER' : k, facing: slot.f, uf: facing, v: s.v[m], anim: manAnim, phase: jit[m][2], start });
  });
  if(k === 'ARTILLERY'){
    // The gun, centred in front of its crew. Its flash and recoil run once,
    // then it stands at idle while the crew finish serving it.
    const fire = anim === 'fire' && now() - start < animMs('ARTILLERY_GUN', 'fire', 700);
    men.push({ x: 0, y: facing === 'away' ? (PIXEL() ? 0.20 : 0.18) : 0.30, nation, type: 'ARTILLERY_GUN', facing, uf: facing, v: 0, anim: fire ? 'fire' : 'idle', phase: 0, start, gun: true });
  }
}

/* ---------- putting a sprite on the canvas ---------- */
/* Feet at (fx, fy) in canvas units. Pixel art is drawn nearest-neighbour, at
   a position and size rounded to whole device pixels so every sprite pixel
   stays a crisp block (the board's transform is a plain scale: zoom times
   device pixel ratio). */
function blit(c, sh, frame, fx, fy){
  const { img, meta, f } = sh;
  const ay = meta.anchorYByFacing && meta.anchorYByFacing[f] != null ? meta.anchorYByFacing[f] : meta.anchorY;
  const h = CELL * meta.displayScale, w = h * meta.frameWidth / meta.frameHeight;
  const x = fx - w * meta.anchorX, y = fy - h * ay;
  const sx = frame * meta.frameWidth;
  if(meta.pixelArt){
    const t = c.getTransform();
    if(!t.b && !t.c){
      const dx = Math.round(t.a * x + t.e), dy = Math.round(t.d * y + t.f);
      const dw = Math.round(t.a * (x + w) + t.e) - dx, dh = Math.round(t.d * (y + h) + t.f) - dy;
      c.save();
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.imageSmoothingEnabled = false;
      c.drawImage(img, sx, 0, meta.frameWidth, meta.frameHeight, dx, dy, dw, dh);
      c.restore();
      return;
    }
  }
  c.drawImage(img, sx, 0, meta.frameWidth, meta.frameHeight, x, y, w, h);
}

/* Paints men rear first (smaller y first), each from his sheet at the
   animation frame for now. Loops start each man at his own frame; one-shot
   animations (fire, serve) run from their start and hold the last frame. */
function paintMen(c, men, cx, cy, alpha){
  men.sort((a, b) => a.y - b.y);
  const t = now();
  c.save();
  if(alpha !== 1) c.globalAlpha = alpha;
  for(const m of men){
    const sh = sheet(m.nation, m.type, m.anim, m.facing, m.v, m.uf) || sheet(m.nation, m.type, 'idle', m.facing, m.v, m.uf);
    if(!sh) continue;
    const a = sh.a, fps = a.fps || 12, n = a.frameCount || 1;
    const frame = a.loop ? (Math.floor(t / (1000 / fps)) + Math.floor(m.phase * n)) % n : Math.min(n - 1, Math.max(0, Math.floor((t - m.start) / (1000 / fps))));
    blit(c, sh, frame, cx + m.x * CELL, cy + m.y * CELL);
  }
  c.restore();
}

/* ---------- the clash: two units close while their fight's dice are up ----------
   Visual only. Nothing here moves a unit's real square or touches the dice,
   the timing of resolution or the match log; a unit is only DRAWN off its
   square, by an offset that is zero whenever no fight is on the board.

   Driven by the fight's dice (js/dice.js, setDiceClash, wired in boot), which
   run on the rolling phone and, mirrored, on the online opponent's, and by
   the 'fight' event in Watch Replay (clashReplay):
   - start (the dice appear): both step towards each other, the attacker most
     of the way to the shared edge, the defender a little. Cavalry gallop
     (charge frames) and close faster. A unit in Square, and a gun, hold
     their ground; only the other side closes.
   - they hold at the edge playing melee while the dice tumble and the
     strengths appear (and for as long as a re-roll is pending).
   - result (the verdict is on screen): the winner steps back to its square;
     the loser recoils (pushback) or turns and runs (rout) back to it with
     its flee frames, or, destroyed, stays where they met so its men fall
     there; a stalemate sends both back. All of it over before the dice fade.
   The rules then move units exactly as before; a pushed-back loser makes
   that move with its flee frames too (FLEE_UNTIL).

   Offsets are in screen squares along the line between the two units, so a
   diagonal fight closes diagonally. The furthest a figure goes is just past
   the middle of the shared edge. Old icon style: the same, scaled down to a
   nudge. Headless (no figures, fast dice): never started, so no cost. */
const CLASH = {};       // unitId -> { other, from:{x,y}, to:{x,y}, dist, gallop, t0, adv, tEnd, end, endMs }
const SHOWN = {};       // 'attackerId|defenderId' -> when its clash ran, so the fight event does not replay a melee
const FLEE_UNTIL = {};  // unitId -> until when its pushback move runs with flee frames
const CLASH_ATTACK = 0.34, CLASH_ATTACK_CAV = 0.40, CLASH_DEFEND = 0.12;   // squares travelled
const CLASH_ADV_MS = 650, CLASH_ADV_CAV_MS = 420, CLASH_END_MS = 650;
const CLASH_NUDGE = 0.3;   // the old icons only lean in
const isCav = u => kind(u) === 'LIGHT_CAV' || kind(u) === 'HEAVY_CAV';
const holdsGround = u => u.formation === 'square' || kind(u) === 'ARTILLERY';
const ease = x => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/* The dice for a fight have appeared (or, without a Roll tap, been thrown). */
export function clashStart(attackerId, defenderId, opts = {}){
  if(!TRACK) return;
  const a = unitById(attackerId), d = unitById(defenderId);
  if(!a || !d) return;
  if(CLASH[a.id] && CLASH[a.id].other === d.id) return;   // the same fight, already on
  const t = now();
  const fast = opts.fast || 1;
  for(const [u, o, attacking] of [[a, d, true], [d, a, false]]){
    const gallop = isCav(u) && attacking;
    let dist = holdsGround(u) ? 0 : attacking ? (isCav(u) ? CLASH_ATTACK_CAV : CLASH_ATTACK) : CLASH_DEFEND;
    if(attacking && o.formation === 'square') dist = Math.min(dist, 0.30);   // up to the square's face, not into it
    CLASH[u.id] = { other: o.id, from: { x: u.x, y: u.y }, to: { x: o.x, y: o.y }, dist, gallop,
      t0: t, adv: (isCav(u) ? CLASH_ADV_CAV_MS : CLASH_ADV_MS) * fast, tEnd: null, end: null, endMs: CLASH_END_MS * fast };
  }
  SHOWN[a.id + '|' + d.id] = t;
  ensureAnimationLoopRunning();
}
/* The verdict is on screen: each side starts its ending after delayMs (the
   dice landing and the strengths showing first). loserId null: stalemate. */
export function clashResult(attackerId, defenderId, result, loserId, delayMs = 0){
  if(!TRACK) return;
  const t = now() + Math.max(0, delayMs);
  for(const id of [attackerId, defenderId]){
    const c = CLASH[id]; if(!c) continue;
    c.tEnd = t;
    c.end = id !== loserId || !loserId ? 'back' : result === 'destroy' ? 'hold' : 'flee';
    if(id === loserId && (result === 'pushback' || result === 'rout')) FLEE_UNTIL[id] = t + 9000;
  }
  ensureAnimationLoopRunning();
}
/* How far a unit is drawn off its square now, in screen squares, or null.
   full: the figures' own distance even in the old icon style (for bodies). */
export function clashOffset(u, full){
  const c = CLASH[u.id];
  if(!c) return null;
  const t = now();
  if(t - c.t0 > 20000 || (c.tEnd != null && c.end !== 'hold' && t > c.tEnd + c.endMs)){ delete CLASH[u.id]; return null; }
  if(!c.dist) return null;
  let k = ease((t - c.t0) / c.adv);
  if(c.tEnd != null && t > c.tEnd && c.end !== 'hold') k *= 1 - ease((t - c.tEnd) / c.endMs);
  const p = toScreen(c.from.x, c.from.y), q = toScreen(c.to.x, c.to.y);
  const dx = q.x - p.x, dy = q.y - p.y, len = Math.hypot(dx, dy) || 1;
  const m = c.dist * k * (full || (figuresOn() && hasFigures(u)) ? 1 : CLASH_NUDGE);
  return { x: dx / len * m, y: dy / len * m };
}
/* Which frames a unit in a clash plays, or null when it is not in one. */
function clashAnim(u){
  const c = CLASH[u.id];
  if(!c) return null;
  const t = now();
  if(c.tEnd != null && t >= c.tEnd){
    if(t > c.tEnd + c.endMs && c.end !== 'hold') return null;
    if(c.end === 'hold') return 'fall';   // destroyed: they fall where they met, and lie there
    if(!c.dist) return c.end === 'flee' ? null : 'idle';   // standing its ground: no running on the spot
    return c.end === 'flee' ? 'flee' : 'march';
  }
  if(t - c.t0 < c.adv) return !c.dist ? 'idle' : c.gallop && PIXEL() ? 'charge' : 'march';
  return 'melee';
}
export const clashActive = () => Object.keys(CLASH).length > 0;

/* Watch Replay: no dice there, so the 'fight' event plays the whole clash in
   the time the replay gives a fight (1.5 s). loserId as clashResult. */
export function clashReplay(ev, loserId){
  if(!TRACK || !ev) return;
  clashStart(ev.attackerId, ev.defenderId, { fast: 0.55 });
  clashResult(ev.attackerId, ev.defenderId, ev.result, loserId, 650);
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
/* A man falls where he stood. His body keeps his variant (and, for the
   bearer, the colours) for the rest of the battle. */
function fell(u, s, man){
  s.alive[man] = false;
  const B = bearerOf(u, s);
  const facing = facingOf(u, false);
  const places = WALK_PREV[u.id] || placesFor(u, layoutFor(u, facing, null), facing, null);
  const slot = placeOf(places, s, man, B) || { x: 0, y: 0.2, f: facing };
  // Where he actually stood: a unit destroyed in a fight dies where it met the enemy.
  const co = clashOffset(u, true) || { x: 0, y: 0 };
  const p = boardOffset(slot.x + co.x, slot.y + co.y);
  const id = 'b' + (++bodyCounter) + '_' + u.id + '_' + man;
  (state.figureBodies = state.figureBodies || []).push({ id, bx: u.x + p.x, by: u.y + p.y, nation: NATION[u.side], type: man === B ? 'GUARD_BEARER' : kind(u), facing: slot.f, uf: facing, v: s.v ? s.v[man] : 0, side: u.side });
  // A man who already fell in the clash lies still; anyone else falls now.
  if(!(CLASH[u.id] && CLASH[u.id].end === 'hold')) FALLING[id] = now();
}
/* A screen-space offset as board coordinates, so bodies stay put whichever
   way the board is later turned. */
function boardOffset(dx, dy){
  const o = toScreen(5, 5), ex = toScreen(6, 5), ey = toScreen(5, 6);
  const ax = ex.x - o.x, ay = ey.y - o.y;   // +1 or -1 when the board is turned
  return { x: dx * ax, y: dy * ay };
}
/* A destroyed battery leaves its gun on the field as a wreck, like a body. */
function wreck(u){
  const facing = facingOf(u, false);
  const p = boardOffset(0, facing === 'away' ? (PIXEL() ? 0.20 : 0.18) : 0.30);
  const id = 'w' + (++bodyCounter) + '_' + u.id;
  (state.figureBodies = state.figureBodies || []).push({ id, bx: u.x + p.x, by: u.y + p.y, nation: NATION[u.side], type: 'ARTILLERY_GUN', facing, uf: facing, v: 0, side: u.side, wreck: true });
}
const unitById = id => (state.units || []).find(u => u.id === id);
/* A unit's fire or melee, for as long as its longest sheet runs (a battery:
   the crew's serve, which outlasts the gun's flash). */
function act(u, anim, fallback){
  const k = kind(u);
  const ms = anim === 'melee' ? MELEE_MS : PIXEL() && k === 'ARTILLERY' ? Math.max(animMs('ARTILLERY', 'serve', fallback), animMs('ARTILLERY_GUN', 'fire', fallback)) : animMs(k, anim, fallback);
  FX[u.id] = { anim, start: now(), until: now() + Math.max(fallback, ms) };
}

export function figuresOnEvent(ev){
  if(!TRACK || !ev) return;
  try {
    if(ev.type === 'fire'){
      if(ev.volley){
        const sh = unitById(ev.shooterId); if(sh) act(sh, 'fire', 600);
        const tg = unitById(ev.targetId);
        if(tg) strike(tg, ev.effect === 'none' ? (inf(tg) ? 1 : 0) : (inf(tg) ? 2 : 1));
      } else {
        const g = unitById(ev.gunId); if(g) act(g, 'fire', 700);
        const tg = unitById(ev.targetId);
        if(tg && ev.hit) strike(tg, inf(tg) ? 1 : 0);
      }
    } else if(ev.type === 'fight'){
      const a = unitById(ev.attackerId), d = unitById(ev.defenderId);
      // The clash already showed this fight on the board while the dice were
      // up; only a fight that had none (no dice drawn) gets the melee now.
      const shown = a && d && SHOWN[a.id + '|' + d.id] > now() - 15000;
      if(!shown) for(const u of [a, d]) if(u) act(u, 'melee', MELEE_MS);
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
      if(u) delete CLASH[u.id];   // a loser held where it fell can go now its men lie there
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
      const meta = META()[b.type], a = meta && meta.anims.fall;
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
  const sh = sheet(b.nation, b.type, anim, b.facing, b.v, b.uf || b.facing);
  if(!sh || sh.a !== (META()[b.type] || { anims: {} }).anims[anim]) return false;   // not loaded yet: try again next frame
  const n = sh.a.frameCount || 1;
  const frame = fallStart == null ? n - 1 : Math.min(n - 1, Math.floor((now() - fallStart) / (1000 / (sh.a.fps || 12))));
  const p = toScreen(b.bx, b.by);
  blit(c, sh, frame, (p.x + 0.5) * CELL, (p.y + 0.5) * CELL);
  return true;
}
export const figuresAnimating = () => figuresOn() && (Object.keys(FALLING).length > 0 || Object.keys(WALK).length > 0);

