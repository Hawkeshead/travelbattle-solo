/* =========================================================
   GUNFIRE AND BATTLEFIELD SMOKE (assets/terrain/v2/effects/smoke/)

   Visual only: nothing here touches a rule, a roll, a turn or the game's
   pacing. Two parts:

   1. The shot itself. A gun plays cannon_blast_1..6 at 90 ms a frame; a
      volley plays musket_flash_1..3 at 70 ms a frame from three points along
      the unit's front, 70 ms apart. Every frame has its muzzle at (40, 256)
      of a 512 x 512 canvas with the blast pointing right, so it is drawn with
      that point on the muzzle and turned to face the target.
   2. The smoke left behind: clouds (cannon_cloud_*, musket_puff_*) that get
      a short push along the line of fire, easing out over 1.5 s, then drift
      with the ambient clouds' wind (AmbientLayer.windAngle) at 1.15 x their
      speed, each a little faster or slower and turned a little. They fade in
      over 0.4 s, hold, and fade out over their last 5 s; 15 s in all, in real
      time. At most SMOKE_MAX_CLOUDS live (the oldest go first), and where
      clouds pile up over a unit they are thinned so the combined smoke over
      it never passes SMOKE_MAX_OVER_UNIT: units stay visible and tappable.
      No drifting smoke with prefers-reduced-motion or in fast animation mode
      (the blast frames still play).

   Positions are kept on the board (so a turned viewpoint carries the smoke
   with the board); the push and the wind are worked out on screen, since the
   wind is a screen direction.
========================================================= */
import { AmbientLayer, CLOUD_CFG } from './ambient-layer.js';

const DIR = 'assets/terrain/v2/effects/smoke/';
export const SMOKE_FILES = {
  cannonBlast: [1,2,3,4,5,6].map(i => `${DIR}cannon_blast_${i}.webp`),
  musketFlash: [1,2,3].map(i => `${DIR}musket_flash_${i}.webp`),
  cannonCloud: [1,2,3,4,5,6].map(i => `${DIR}cannon_cloud_${i}.webp`),
  musketPuff: [1,2,3].map(i => `${DIR}musket_puff_${i}.webp`),
};
export const smokeFileList = () => Object.values(SMOKE_FILES).flat();

const IMG = {};
if(typeof Image !== 'undefined') for(const p of smokeFileList()){ const i = new Image(); i.src = p; IMG[p] = i; }
const ready = p => { const i = IMG[p]; return !!(i && i.complete && i.naturalWidth > 0); };

export const SMOKE_MAX_CLOUDS = 40;
export const SMOKE_MAX_OVER_UNIT = 0.7;
const MUZZLE = { x: 40, y: 256, frame: 512 };
const CANNON = { frameMs: 90, width: 1.9, clouds: [0.5, 0.95, 1.4], cloudEveryMs: 250, from: 1.1, to: 2.0, alpha: 0.6, push: 0.55 };
const MUSKET = { frameMs: 70, width: 0.75, staggerMs: 70, spread: 0.28, from: 0.55, to: 1.1, alpha: 0.5, push: 0.3 };
const LIFE_MS = 15000, FADE_IN_MS = 400, FADE_OUT_MS = 5000, PUSH_MS = 1500;
const WIND_FACTOR = 1.15, SPEED_JITTER = 0.2, MAX_TURN = 0.35;
const MUZZLE_FORWARD = 0.32;          // cells from the unit's centre to its muzzle, toward the target

const blasts = [];                    // { kind, fx, fy, tx, ty, ox, oy, start }  (board coords; ox/oy: point offset)
let clouds = [];                      // { img, fx, fy, tx, ty, along, start, w0, w1, alpha, push, speed, turn, wx, wy }

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const pick = list => list[Math.floor(Math.random() * list.length)];
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/* A shot. kind 'cannon' or 'musket'; from and to are board squares.
   noSmoke: the blast only (reduced motion, fast animation mode). */
export function spawnGunfire(kind, from, to, { noSmoke = false } = {}){
  const t = now();
  // Blasts are only removed as they are drawn; where nothing draws (the headless
  // simulator), drop any that are long finished so they cannot pile up.
  for(let i = blasts.length - 1; i >= 0; i--) if(t - blasts[i].start > 2000) blasts.splice(i, 1);
  const points = kind === 'cannon' ? [0] : [-1, 0, 1];
  points.forEach((p, i) => blasts.push({ kind, fx: from.x, fy: from.y, tx: to.x, ty: to.y, side: p, start: t + (kind === 'musket' ? i * MUSKET.staggerMs : 0) }));
  if(noSmoke || reducedMotion()) return;
  if(kind === 'cannon'){
    CANNON.clouds.forEach((along, i) => clouds.push(newCloud(pick(SMOKE_FILES.cannonCloud), from, to, along, 0, t + i * CANNON.cloudEveryMs, CANNON)));
  } else {
    points.forEach((p, i) => clouds.push(newCloud(pick(SMOKE_FILES.musketPuff), from, to, MUZZLE_FORWARD + 0.15, p, t + i * MUSKET.staggerMs, MUSKET)));
  }
  if(clouds.length > SMOKE_MAX_CLOUDS) clouds = clouds.slice(clouds.length - SMOKE_MAX_CLOUDS);   // oldest go first
}
function newCloud(img, from, to, along, side, start, cfg){
  return { img, fx: from.x, fy: from.y, tx: to.x, ty: to.y, along, side, start, w0: cfg.from, w1: cfg.to, alpha: cfg.alpha,
    push: cfg.push, speed: 1 + (Math.random() * 2 - 1) * SPEED_JITTER, turn: (Math.random() * 2 - 1) * MAX_TURN, wx: 0, wy: 0, px: 0, py: 0, last: start };
}

/* DEATH SMOKE: where a unit has just been destroyed, as its skull fades, two
   clouds of the same smoke (a random pick from the cannon clouds and musket
   puffs, never the same image twice in one death) rise on its square a few
   pixels apart. Lighter than a cannon's (0.45 at most) and smaller (CELL x 0.6
   growing to 1.3), so a death reads as a puff rather than a barrage. No push:
   they only drift with the wind. Same life, fades, cap and per-unit limit as
   all the other smoke. Not spawned with prefers-reduced-motion. */
export const DEATH_SMOKE = { clouds: 2, from: 0.6, to: 1.3, alpha: 0.45, spreadPx: 5 };
export function spawnDeathSmoke(at){
  if(reducedMotion()) return;
  const pool = [...SMOKE_FILES.cannonCloud, ...SMOKE_FILES.musketPuff];
  const t = now();
  for(let i = 0; i < DEATH_SMOKE.clouds; i++){
    const img = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
    const c = newCloud(img, at, at, 0, 0, t, { from: DEATH_SMOKE.from, to: DEATH_SMOKE.to, alpha: DEATH_SMOKE.alpha, push: 0 });
    const a = Math.random() * Math.PI * 2;                                       // a few pixels apart
    c.px = Math.cos(a) * DEATH_SMOKE.spreadPx * (i ? -1 : 1); c.py = Math.sin(a) * DEATH_SMOKE.spreadPx * (i ? -1 : 1);
    clouds.push(c);
  }
  if(clouds.length > SMOKE_MAX_CLOUDS) clouds = clouds.slice(clouds.length - SMOKE_MAX_CLOUDS);   // oldest go first
}

export function gunfireActive(){
  const t = now();
  return blasts.length > 0 || clouds.some(c => t - c.start < LIFE_MS);
}
export const smokeCount = () => clouds.length;   // for checks and tests
export function clearGunfire(){ blasts.length = 0; clouds = []; }

/* Called from draw(), above the units and effects and below the UI.
   v: { ctx, CELL, toScreen, zoom, units }  (units: drawn units, board coords). */
export function drawGunfire(v){
  const { ctx, CELL, toScreen } = v;
  const t = now();
  // Screen geometry for a shot: centre of the shooter, unit direction to the target.
  const geom = (fx, fy, tx, ty) => {
    const a = toScreen(fx, fy), b = toScreen(tx, ty);
    const cx = (a.x + 0.5) * CELL, cy = (a.y + 0.5) * CELL;
    let dx = (b.x - a.x), dy = (b.y - a.y); const n = Math.hypot(dx, dy) || 1; dx /= n; dy /= n;
    return { cx, cy, dx, dy, angle: Math.atan2(dy, dx) };
  };

  // 1. Drifting smoke (drawn first, so a fresh blast sits on top of it).
  const windSpeed = WIND_FACTOR * (typeof innerWidth === 'number' ? innerWidth : 800) * CLOUD_CFG.SPEED_RATIO / Math.max(1, v.zoom || 1);
  const wa = AmbientLayer.windAngle || 0, wvx = Math.cos(wa), wvy = Math.sin(wa);
  clouds = clouds.filter(c => t - c.start < LIFE_MS);
  const live = [];
  for(const c of clouds){
    const age = t - c.start;
    if(age < 0) continue;
    const dt = Math.max(0, Math.min(0.1, (t - c.last) / 1000)); c.last = t;
    c.wx += wvx * windSpeed * c.speed * dt; c.wy += wvy * windSpeed * c.speed * dt;
    const g = geom(c.fx, c.fy, c.tx, c.ty);
    const ease = 1 - Math.pow(1 - Math.min(1, age / PUSH_MS), 3);
    const along = (c.along + c.push * ease) * CELL;
    const px = -g.dy, py = g.dx;                                          // across the line, for a volley's three points
    const x = g.cx + g.dx * along + px * c.side * MUSKET.spread * CELL + c.wx + c.px;
    const y = g.cy + g.dy * along + py * c.side * MUSKET.spread * CELL + c.wy + c.py;
    const w = (c.w0 + (c.w1 - c.w0) * Math.min(1, age / LIFE_MS)) * CELL;
    const fade = age < FADE_IN_MS ? age / FADE_IN_MS : age > LIFE_MS - FADE_OUT_MS ? Math.max(0, (LIFE_MS - age) / FADE_OUT_MS) : 1;
    live.push({ c, x, y, w, a: c.alpha * fade, k: 1 });
  }
  // Keep units readable: where clouds overlap a unit, thin them so the combined
  // cover over its centre stays at or under SMOKE_MAX_OVER_UNIT.
  for(const u of (v.units || [])){
    const s = toScreen(u.x, u.y), ux = (s.x + 0.5) * CELL, uy = (s.y + 0.5) * CELL;
    const over = live.filter(L => Math.hypot(L.x - ux, L.y - uy) < L.w * 0.42);
    if(over.length === 0) continue;
    const cover = f => 1 - over.reduce((p, L) => p * (1 - Math.min(1, L.a * L.k * f)), 1);
    if(cover(1) <= SMOKE_MAX_OVER_UNIT) continue;
    let lo = 0, hi = 1;
    for(let i = 0; i < 14; i++){ const m = (lo + hi) / 2; if(cover(m) > SMOKE_MAX_OVER_UNIT) hi = m; else lo = m; }
    for(const L of over) L.k *= lo;
  }
  for(const L of live){
    if(!ready(L.c.img) || L.a * L.k <= 0.003) continue;
    const img = IMG[L.c.img], h = L.w * (img.naturalHeight / img.naturalWidth);
    ctx.save();
    ctx.globalAlpha = L.a * L.k;
    ctx.translate(L.x, L.y); ctx.rotate(L.c.turn);
    ctx.drawImage(img, -L.w / 2, -h / 2, L.w, h);
    ctx.restore();
  }

  // 2. Blasts and flashes.
  for(let i = blasts.length - 1; i >= 0; i--){
    const b = blasts[i];
    const cfg = b.kind === 'cannon' ? CANNON : MUSKET;
    const frames = b.kind === 'cannon' ? SMOKE_FILES.cannonBlast : SMOKE_FILES.musketFlash;
    const age = t - b.start;
    if(age < 0) continue;
    const f = Math.floor(age / cfg.frameMs);
    if(f >= frames.length){ blasts.splice(i, 1); continue; }
    if(!ready(frames[f])) continue;
    const g = geom(b.fx, b.fy, b.tx, b.ty);
    const px = -g.dy, py = g.dx;
    const mx = g.cx + g.dx * MUZZLE_FORWARD * CELL + px * b.side * MUSKET.spread * CELL;
    const my = g.cy + g.dy * MUZZLE_FORWARD * CELL + py * b.side * MUSKET.spread * CELL;
    const s = cfg.width * CELL / MUZZLE.frame;
    ctx.save();
    ctx.translate(mx, my); ctx.rotate(g.angle);
    ctx.drawImage(IMG[frames[f]], -MUZZLE.x * s, -MUZZLE.y * s, MUZZLE.frame * s, MUZZLE.frame * s);
    ctx.restore();
  }
}
