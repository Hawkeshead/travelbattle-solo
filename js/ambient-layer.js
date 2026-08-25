/* =========================================================
   AMBIENT LAYER
   Environmental motion above the battlefield: birds now, clouds next.

   Deliberately NOT part of the board render pipeline. It owns its own
   canvas and its own rAF loop, sized to #boardWrap rather than to the
   board itself, so it covers the tabletop background as well as the map.

   It is also deliberately NOT inside the board's CSS transform. Zoom and
   pan are applied to #board as a CSS transform; the sky sits above the
   scene rather than being part of it, so it stays put when the player
   pinches in. That is a design decision, not an oversight.

   The whole thing is inert until start() is called, and cancels its rAF
   entirely on suspend() rather than merely hiding — battery matters.
========================================================= */

/* ---------------------------------------------------------
   TUNING
   Every value a reviewer might want to change lives here and
   nowhere else. Mutated live by bird-lab.html.
--------------------------------------------------------- */
export const BIRD_CFG = {
  // Shared across every species. Anything that varies by bird lives in SPECIES.
  ALPHA            : 1.00,
  GLIDE_MS_MIN     : 2400,
  GLIDE_MS_MAX     : 3600,
  FLAP_RATE_JITTER : 0.08,   // +/- per bird, so a flock never syncs

  // Beak length in local wingspan units. Anatomically this should be about
  // 0.075, which at a 10px wingspan is 0.8 of a pixel: it does not read as a
  // beak, it just smears the nose slightly warm. Oversized on purpose, the same
  // caricature logic as the unit icons.
  BEAK_LEN         : 0.07,
  BEAK_HALF_W      : 0.030,

  // Fade. Paths begin and end outside 0..1, so a bird is already off-canvas for
  // roughly the first and last tenth of its crossing. Ramping opacity across a
  // slightly wider band than that means it fades up as it comes over the board
  // edge rather than snapping into existence at the boundary.
  FADE_FRACTION    : 0.19,

  // How many crossings may be in the air simultaneously. A second flyover is
  // always forced to a different species from the one already up, so two
  // identical formations never share the sky.
  MAX_CONCURRENT   : 2,

  // Depth. Applied to any crossing that flies above the cloud layer: further
  // away means smaller and fainter. Set both to 1 to disable the cue.
  ABOVE_CLOUD_SCALE : 0.82,
  ABOVE_CLOUD_ALPHA : 0.80,

  // Scheduling. LAUNCH is the gap between crossings STARTING, not between one
  // ending and the next beginning, which is what produces the occasional overlap.
  FIRST_DELAY_MS_MIN : 30000,
  FIRST_DELAY_MS_MAX : 45000,
  // Must sit BELOW the shortest crossing (17s, the raptor) or a second bird can
  // never get up while the first is still in the air and MAX_CONCURRENT is dead
  // code. Mean gap is still longer than a crossing, so one bird is the normal
  // state and two is an occasional overlap rather than the default.
  LAUNCH_GAP_MS_MIN  : 12000,
  LAUNCH_GAP_MS_MAX  : 60000,
};

/* ---------------------------------------------------------
   SPECIES
   Three birds, tuned on device in the review harness. Every value here was
   read off the lab's own summary block, not invented.

   WEIGHT is relative selection frequency, nothing more: a pair of small birds
   is the everyday sight, geese are a occasional event, and a lone hunter is
   the rare one worth looking up for.
--------------------------------------------------------- */
export const SPECIES = {
  PAIR: {
    key:'PAIR', label:'Pair',
    COLOUR:'#7A3B2E', BEAK:'#1A1713',        // muddy red body, black beak
    WEIGHT: 5,
    WINGSPAN_RATIO:0.0254, WINGSPAN_MIN_PX:6, WINGSPAN_MAX_PX:14,
    FLAP_HZ:3.4, WINGS_OUT_DUTY:0.65, FLAPS_PER_GLIDE:6, WING_STUB:0.30,
    FLOCK_MIN:2, FLOCK_MAX:2, ECHELON_SPACING:1.1, ECHELON_LAG:0.008,
    CROSSING_MS:24000, ALTITUDE_SWING:0.26,
    // Chance this crossing flies ABOVE the cloud layer rather than beneath it.
    // A pair of small birds is low over the fields almost always; geese are a
    // travelling formation at altitude; a raptor is soaring highest of all.
    // Setting these per species rather than at random is what makes the two
    // depths read as height rather than as a rendering glitch.
    ABOVE_CLOUD_CHANCE:0.05,
  },
  GEESE: {
    key:'GEESE', label:'Geese',
    COLOUR:'#C9C6BC', BEAK:'#E0A63C',        // whitish grey body, yellow beak
    WEIGHT: 3,
    WINGSPAN_RATIO:0.0382, WINGSPAN_MIN_PX:9, WINGSPAN_MAX_PX:21,
    FLAP_HZ:2.4, WINGS_OUT_DUTY:0.40, FLAPS_PER_GLIDE:5, WING_STUB:0.29,
    FLOCK_MIN:5, FLOCK_MAX:5, ECHELON_SPACING:1.9, ECHELON_LAG:0.020,
    CROSSING_MS:24000, ALTITUDE_SWING:0.26,
    ABOVE_CLOUD_CHANCE:0.45,
  },
  RAPTOR: {
    key:'RAPTOR', label:'Raptor',
    COLOUR:'#6B4A2F', BEAK:'#E0A63C',        // brown body, yellow beak
    WEIGHT: 1.5,
    WINGSPAN_RATIO:0.0509, WINGSPAN_MIN_PX:12, WINGSPAN_MAX_PX:28,
    FLAP_HZ:2.4, WINGS_OUT_DUTY:0.76, FLAPS_PER_GLIDE:2, WING_STUB:0.30,
    FLOCK_MIN:1, FLOCK_MAX:1, ECHELON_SPACING:1.9, ECHELON_LAG:0.020,
    CROSSING_MS:17000, ALTITUDE_SWING:0.17,
    ABOVE_CLOUD_CHANCE:0.70,
  },
};

// Crossing times were tuned as single values. Repeating one to the millisecond
// every time reads as mechanical, so each crossing is jittered by this much
// around the tuned figure. Set to 0 to fly exactly the tuned duration.
export const CROSSING_JITTER = 0.12;

/* =========================================================
   CLOUDS

   Two passes on two different canvases, because they are two different
   physical things:

   - The CLOUD itself is in the sky. It drifts over the board AND over the
     tabletop background, because that is what a sky does. It lives on the
     same canvas as the birds, drawn after them, so a bird passing beneath
     a cloud is dimmed by the cloud's own alpha at no cost.

   - The SHADOW is on the ground. It is clipped to the board rect, because a
     cloud shadow falling on a walnut desk is the one thing here that would
     look wrong. It lives on its own canvas with CSS mix-blend-mode:multiply,
     which genuinely darkens the terrain underneath rather than laying a grey
     blob over it.

   Why the shadow could not go in the board's own render pipeline, which was
   the original plan: draw() only runs on state change, so shadows would
   freeze solid between moves. And a canvas composite operation cannot reach
   across to a different canvas element, so 'multiply' on the sky canvas would
   have multiplied against nothing. CSS blending is the only mechanism that
   crosses the element boundary.

   Shadow speed deliberately matches cloud speed exactly, with a fixed offset.
   Modelling a sun angle was considered and cut: the offset is what sells it,
   and any speed differential divorces a shadow from its cloud within a few
   minutes of play.
========================================================= */
export const CLOUD_CFG = {
  COUNT            : 8,       // tuned on device. Heavy cover by design.
  ALPHA            : 0.40,    // tuned on device. Note this is a meaningful
                              // contrast cost: COUNT x ALPHA is roughly total
                              // sky cover, so 8 x 0.40 is about ten times the
                              // original 3 x 0.11. Revisit alongside the
                              // artillery firing line legibility fix.
  SHADOW_ALPHA     : 0.27,
  SHADOWS_ENABLED  : true,

  // Size, as a fraction of host width at scale 1. Halved from the original
  // tuned 0.43 after seeing it over a real battle: at that size the cover
  // competed with the terrain and the units for attention. 0.22 is the
  // nearest step the lab's slider can express to exactly half.
  WIDTH_RATIO      : 0.22,
  SCALE_MIN        : 0.80,
  SCALE_MAX        : 1.80,

  // Drift, in host widths per second. At 0.046 a cloud crosses a phone screen
  // in roughly twenty seconds, which is visible scudding rather than ambient
  // drift. Tuned deliberately; drop to ~0.004 for the near-static original.
  SPEED_RATIO      : 0.046,
  SPEED_JITTER     : 0.35,    // +/- per cloud, so they never move as a block

  // Wind is one vector for the whole battle, picked at start and exposed as
  // AmbientLayer.windAngle so any future gunsmoke can reuse it for free.
  // Kept near horizontal: a steeply diagonal sky reads as a storm.
  WIND_SPREAD_RAD  : 0.28,

  // Fixed sun offset, as a fraction of cloud width.
  SHADOW_OFFSET_X  : -0.13,
  SHADOW_OFFSET_Y  : 0.29,
  SHADOW_SCALE     : 1.12,    // shadows are softer and broader than their cloud

  COLOUR           : '#f2ece0',  // warm white, not pure white
  SHADOW_COLOUR    : '#2f3a44',  // desaturated blue-grey, never black

  TEX_COUNT        : 5,       // distinct baked shapes, each flippable
};


/* ---------------------------------------------------------
   PREFERENCE
   Read through a getter every time rather than cached at init, so toggling it
   mid-battle takes effect on the next frame instead of on the next match.
--------------------------------------------------------- */
const PREF_KEY = 'fc:ambientMotion';

function prefersReducedMotion(){
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  catch { return false; }
}

/* Resolved once and invalidated on change rather than recomputed per frame:
   the gate below runs every animation frame, and localStorage.getItem is a
   synchronous, disk-backed call. Caching is still immediate because the only
   two things that can change the answer both invalidate it. */
let prefCache = null;
function resolvePref(){
  if(prefCache !== null) return prefCache;
  let stored = null;
  try { stored = localStorage.getItem(PREF_KEY); } catch { /* private mode */ }
  prefCache = (stored === 'on' || stored === 'off')
    ? stored === 'on'
    // Reduce Motion sets the DEFAULT only. It used to veto the layer outright,
    // which was defensible when there was no user control — but now that the
    // Field Report carries an Ambient Motion switch, a player who deliberately
    // turns birds ON and sees nothing has no way to discover why. An explicit
    // choice always wins; the accessibility default still protects anyone who
    // never opens the menu.
    : !prefersReducedMotion();
  return prefCache;
}

try {
  window.matchMedia('(prefers-reduced-motion: reduce)')
        .addEventListener?.('change', () => { prefCache = null; });
} catch { /* matchMedia unavailable */ }

export const AmbientPref = {
  get enabled(){ return resolvePref(); },
  set enabled(v){
    prefCache = !!v;
    try { localStorage.setItem(PREF_KEY, v ? 'on' : 'off'); } catch { /* nothing we can do */ }
  },
  /* Whether the player has ever made a choice, as opposed to inheriting the
     accessibility default. Useful for diagnostics. */
  get isExplicit(){
    try { const v = localStorage.getItem(PREF_KEY); return v === 'on' || v === 'off'; }
    catch { return false; }
  },
  get reducedMotion(){ return prefersReducedMotion(); },
};

/* ---------------------------------------------------------
   TRAJECTORIES
   Preplanned quadratic beziers in normalised canvas space.
   Start and end sit outside 0..1 so birds enter and leave off-canvas.
   Six paths, each picked at random per flyover with a jittered offset,
   so repeats are not obvious without being fully procedural.
--------------------------------------------------------- */
const PATHS = [
  { p0:{x:-0.15,y:0.30}, cp:{x:0.50,y:0.20}, p1:{x: 1.15,y:0.36} }, // L -> R, shallow
  { p0:{x: 1.15,y:0.66}, cp:{x:0.50,y:0.74}, p1:{x:-0.15,y:0.58} }, // R -> L, shallow
  { p0:{x:-0.15,y:-0.10}, cp:{x:0.45,y:0.48}, p1:{x: 1.15,y:1.10} }, // TL -> BR
  { p0:{x:-0.15,y: 1.10}, cp:{x:0.55,y:0.52}, p1:{x: 1.15,y:-0.10} }, // BL -> TR
  { p0:{x:-0.15,y: 0.78}, cp:{x:0.50,y:0.04}, p1:{x: 1.15,y:0.72} }, // L -> R, lazy arc
  { p0:{x: 1.15,y:-0.10}, cp:{x:0.50,y:0.50}, p1:{x:-0.15,y:1.10} }, // TR -> BL
];

const rand  = (a,b) => a + Math.random()*(b-a);
const randI = (a,b) => Math.floor(rand(a,b+1));

function bezier(path, t){
  const mt = 1-t;
  return {
    x: mt*mt*path.p0.x + 2*mt*t*path.cp.x + t*t*path.p1.x,
    y: mt*mt*path.p0.y + 2*mt*t*path.cp.y + t*t*path.p1.y,
  };
}

// Analytic tangent. Used for heading, so the two frames always point the
// way the bird is actually travelling on a curved path.
function bezierTangent(path, t){
  const mt = 1-t;
  return {
    x: 2*mt*(path.cp.x-path.p0.x) + 2*t*(path.p1.x-path.cp.x),
    y: 2*mt*(path.cp.y-path.p0.y) + 2*t*(path.p1.y-path.cp.y),
  };
}

/* ---------------------------------------------------------
   THE TWO FRAMES
   Drawn as vector paths rather than loaded as PNGs, so they scale to any
   board size, cost nothing in file weight, and anti-alias cleanly at 7px.

   Both are authored in local space: wingspan 1.0, nose pointing along +X,
   origin at the centre of mass. The caller scales and rotates.

   FRAME A (wings out)  — the glide pose, and the recovery half of a flap.
   FRAME B (wings down) — body only. Seen from directly above, a bird on the
   downstroke has its wings hidden beneath it, which is exactly why two
   frames is enough at this angle and would not be at any other.
--------------------------------------------------------- */
function pathBody(ctx){
  // Tapered spindle, widest just behind the shoulder. Chunkier than looks
  // right in isolation: at 12px a slender body vanishes into the terrain.
  ctx.moveTo( 0.32, 0);
  ctx.quadraticCurveTo( 0.16,  0.055, -0.18, 0.016);
  ctx.quadraticCurveTo(-0.26,  0.000, -0.18,-0.016);
  ctx.quadraticCurveTo( 0.16, -0.055,  0.32, 0);
}

function pathTail(ctx){
  // Shallow fan. Barely visible, but its absence reads as "insect".
  ctx.moveTo(-0.18,  0.016);
  ctx.lineTo(-0.32,  0.045);
  ctx.lineTo(-0.32, -0.045);
  ctx.lineTo(-0.18, -0.016);
  ctx.closePath();
}

/* Wings at extension `ext`: 1.0 is fully out, and the down frame uses
   the species' own WING_STUB. Set a species' WING_STUB to 0 for a pure
   body-only down frame. */
function pathWings(ctx, ext){
  if(ext <= 0.001) return;
  for(const s of [1,-1]){
    const tipX = 0.17 + (-0.13 - 0.17)*ext;
    const tipY = 0.50 * ext * s;
    ctx.moveTo(0.17, 0.045*s);
    // Leading edge sweeps aft to the tip.
    ctx.quadraticCurveTo(0.17 + (0.06-0.17)*ext, 0.27*ext*s, tipX, tipY);
    // Trailing edge returns with real chord, so the wing reads as a swept
    // crescent rather than a drawn line.
    ctx.quadraticCurveTo(0.045 + (-0.06-0.045)*ext, 0.25*ext*s, -0.02, 0.05*s);
    ctx.closePath();
  }
}

/* The beak. Drawn as its own fill in its own colour, after the body, so it
   reads as a coloured tip rather than tinting the whole nose. */
function pathBeak(ctx){
  const L = BIRD_CFG.BEAK_LEN, W = BIRD_CFG.BEAK_HALF_W;
  // Base sits INSIDE the body (0.28 < the body's 0.32 nose) so there is never a
  // seam between the two fills at small sizes or under anti-aliasing.
  ctx.moveTo(0.28,  W);
  ctx.lineTo(0.32 + L, 0);
  ctx.lineTo(0.28, -W);
  ctx.closePath();
}

function drawBird(ctx, x, y, wingspan, heading, wingsOut, sp, alpha){
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(heading);
  ctx.scale(wingspan, wingspan);
  ctx.globalAlpha = alpha;

  ctx.fillStyle = sp.COLOUR;
  ctx.beginPath();
  pathBody(ctx);
  pathTail(ctx);
  pathWings(ctx, wingsOut ? 1 : sp.WING_STUB);
  ctx.fill();

  ctx.fillStyle = sp.BEAK;
  ctx.beginPath();
  pathBeak(ctx);
  ctx.fill();

  ctx.restore();
}

/* Exposed so the review harness can magnify the exact same geometry the
   game draws, rather than a copy of it that can drift out of step. */
export function drawBirdFrame(ctx, x, y, size, heading, wingsOut, speciesKey, alpha){
  const sp = SPECIES[speciesKey] || SPECIES.PAIR;
  drawBird(ctx, x, y, size, heading, wingsOut, sp, alpha == null ? BIRD_CFG.ALPHA : alpha);
}

/* ---------------------------------------------------------
   FLAP STATE
   A small phase machine rather than a continuous oscillator. A raw sine
   metronomes immediately; three flaps then a glide is what a real bird
   at distance actually looks like.
--------------------------------------------------------- */
function newFlapState(sp){
  return {
    mode        : 'flapping',
    flapsLeft   : sp.FLAPS_PER_GLIDE,
    cyclePhase  : Math.random(),                                        // desync at birth
    rate        : 1 + rand(-BIRD_CFG.FLAP_RATE_JITTER, BIRD_CFG.FLAP_RATE_JITTER),
    glideUntil  : 0,
  };
}

function stepFlap(f, dtMs, now, sp){
  if(f.mode === 'gliding'){
    if(now >= f.glideUntil){ f.mode = 'flapping'; f.flapsLeft = sp.FLAPS_PER_GLIDE; f.cyclePhase = 0; }
    return true; // wings out throughout the glide
  }
  const cycleMs = 1000 / (sp.FLAP_HZ * f.rate);
  f.cyclePhase += dtMs / cycleMs;
  while(f.cyclePhase >= 1){
    f.cyclePhase -= 1;
    if(--f.flapsLeft <= 0){
      f.mode = 'gliding';
      f.glideUntil = now + rand(BIRD_CFG.GLIDE_MS_MIN, BIRD_CFG.GLIDE_MS_MAX);
      return true;
    }
  }
  return f.cyclePhase < sp.WINGS_OUT_DUTY;
}

/* ---------------------------------------------------------
   FLYOVER
   One crossing by one flock. Followers do not steer: because the path is
   known ahead of time they simply sample it at t minus a lag, with a
   lateral offset. Free, and indistinguishable from real flocking at
   this scale.
--------------------------------------------------------- */
function pickSpecies(excludeKey){
  const pool = Object.values(SPECIES).filter(sp => sp.key !== excludeKey);
  const total = pool.reduce((t,sp)=>t+sp.WEIGHT, 0);
  let r = Math.random()*total;
  for(const sp of pool){ r -= sp.WEIGHT; if(r <= 0) return sp; }
  return pool[pool.length-1];
}

/* Forces the next crossing to a chosen depth. Review only; null means
   "decide normally from the species chance". */
let forceAboveClouds = null;

function newFlyover(speciesKey, pathIndex, excludeKey){
  const sp = SPECIES[speciesKey] || pickSpecies(excludeKey);
  const base = PATHS[pathIndex != null ? pathIndex : randI(0, PATHS.length-1)];
  const jitterY = rand(-0.08, 0.08);
  const path = {
    p0: { x: base.p0.x, y: base.p0.y + jitterY },
    cp: { x: base.cp.x, y: base.cp.y + jitterY },
    p1: { x: base.p1.x, y: base.p1.y + jitterY },
  };
  const size = randI(sp.FLOCK_MIN, sp.FLOCK_MAX);
  const birds = [];
  for(let i=0; i<size; i++){
    birds.push({
      lag     : i * sp.ECHELON_LAG,
      lateral : (i === 0 ? 0 : (i % 2 ? 1 : -1) * sp.ECHELON_SPACING * rand(0.75, 1.35)),
      flap    : newFlapState(sp),
    });
  }
  const j = CROSSING_JITTER;
  return {
    species: sp,
    path,
    birds,
    t         : 0,
    durationMs: sp.CROSSING_MS * rand(1-j, 1+j),
    // Decided once, at launch, and fixed for the whole crossing. A bird that
    // changed depth halfway across would read as a bug, not as a climb.
    aboveClouds: forceAboveClouds !== null
      ? forceAboveClouds
      : Math.random() < (sp.ABOVE_CLOUD_CHANCE ?? 0),
  };
}

/* Opacity envelope across a crossing: up over the first FADE_FRACTION, full
   through the middle, down over the last. Without it a bird pops into and out
   of existence at the canvas boundary. */
function fadeAt(t){
  const f = BIRD_CFG.FADE_FRACTION;
  if(f <= 0) return 1;
  if(t < f)     return Math.max(0, t / f);
  if(t > 1 - f) return Math.max(0, (1 - t) / f);
  return 1;
}

/* ---------------------------------------------------------
   THE LAYER
--------------------------------------------------------- */
/* ---------------------------------------------------------
   CLOUD TEXTURES
   Baked once at init into offscreen canvases, then blitted. Procedural
   rather than PNG assets: base64 image data already dominates this project's
   file size, and a handful of gradients gives unlimited non-cloned variation
   for nothing. Baking matters — compositing eight radial gradients per cloud
   per frame would be the most expensive thing on the screen.
--------------------------------------------------------- */
const TEX_W = 512, TEX_H = 300;
let cloudTex = null;   // [{ light, dark }]

function bakeOneCloud(colour){
  const c = document.createElement('canvas');
  c.width = TEX_W; c.height = TEX_H;
  const x = c.getContext('2d');

  // Puffs arranged along a squashed ellipse with a heavier lower edge, which
  // is what gives a flat-bottomed cumulus read rather than a ball of cotton.
  const puffs = randI(7, 10);
  for(let i=0; i<puffs; i++){
    const a  = rand(0, Math.PI*2);
    const rr = Math.sqrt(Math.random());
    const px = TEX_W/2 + Math.cos(a) * rr * TEX_W*0.30;
    const py = TEX_H/2 + Math.sin(a) * rr * TEX_H*0.20 + TEX_H*0.03;
    const pr = rand(TEX_H*0.22, TEX_H*0.42);
    const g  = x.createRadialGradient(px, py, 0, px, py, pr);
    g.addColorStop(0,    hexToRgba(colour, 0.55));
    g.addColorStop(0.45, hexToRgba(colour, 0.30));
    g.addColorStop(1,    hexToRgba(colour, 0));
    x.fillStyle = g;
    x.beginPath(); x.arc(px, py, pr, 0, Math.PI*2); x.fill();
  }
  return c;
}

function hexToRgba(hex, a){
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${a})`;
}

function bakeCloudTextures(){
  cloudTex = [];
  for(let i=0; i<CLOUD_CFG.TEX_COUNT; i++){
    // Light and dark are baked from independent puff layouts on purpose:
    // a shadow is a diffuse projection, not a traced copy, and an exactly
    // matching outline is the thing that makes cheap cloud shadows look cheap.
    cloudTex.push({
      light: bakeOneCloud(CLOUD_CFG.COLOUR),
      dark : bakeOneCloud(CLOUD_CFG.SHADOW_COLOUR),
    });
  }
}

/* ---------------------------------------------------------
   CLOUD INSTANCES
   Positions live in host CSS pixels and wrap toroidally over a domain one
   margin larger than the canvas on each side. Wrapping both axes (rather
   than only along the wind) stops an angled wind slowly stacking every
   cloud against one edge over a long game.
--------------------------------------------------------- */
function newCloud(cssW, cssH, seeded){
  const scale = rand(CLOUD_CFG.SCALE_MIN, CLOUD_CFG.SCALE_MAX);
  const w = cssW * CLOUD_CFG.WIDTH_RATIO * scale;
  const margin = w;
  return {
    tex   : randI(0, CLOUD_CFG.TEX_COUNT - 1),
    flip  : Math.random() < 0.5,
    scale,
    // `seeded` clouds are placed across the whole field at start-up so the
    // sky is already populated; the alternative is a battle that opens with
    // an empty sky and waits two minutes for weather to arrive.
    x     : seeded ? rand(-margin, cssW + margin) : -margin,
    y     : rand(-cssH*0.15, cssH*0.85),
    speed : 1 + rand(-CLOUD_CFG.SPEED_JITTER, CLOUD_CFG.SPEED_JITTER),
    alpha : rand(0.8, 1.2),   // multiplier on CLOUD_CFG.ALPHA
  };
}

function wrap(v, lo, hi){
  const span = hi - lo;
  return ((v - lo) % span + span) % span + lo;
}

export const AmbientLayer = (() => {
  let host = null, cv = null, ctx = null;
  let shadowCv = null, shadowCtx = null, boardEl = null;
  let raf = null, lastT = 0;
  let cssW = 0, cssH = 0, dpr = 1;
  let flyovers = [], nextLaunchAt = 0;
  let clouds = [], windAngle = 0;
  let running = false;
  let ro = null;

  function resize(){
    if(!host || !cv) return;
    const r = host.getBoundingClientRect();
    cssW = Math.max(1, r.width);
    cssH = Math.max(1, r.height);
    dpr  = window.devicePixelRatio || 1;
    for(const c of [cv, shadowCv]){
      if(!c) continue;
      c.style.width  = cssW + 'px';
      c.style.height = cssH + 'px';
      c.width  = Math.round(cssW * dpr);
      c.height = Math.round(cssH * dpr);
      c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    // Cloud sizes are a ratio of host width, so a rotation invalidates the
    // whole sky. Reseed rather than rescale: clouds have no identity worth
    // preserving across an orientation change.
    if(clouds.length) seedClouds();
  }

  function seedClouds(){
    clouds = [];
    for(let i=0; i<CLOUD_CFG.COUNT; i++) clouds.push(newCloud(cssW, cssH, true));
  }

  /* The board's on-screen rect in host coordinates. Read fresh each frame so
     the shadow clip follows a pinch-zoom or pan without any coupling to the
     board's transform code. One getBoundingClientRect per frame is cheap;
     mirroring the transform matrix would not be. */
  function boardRect(){
    if(!boardEl) return null;
    const b = boardEl.getBoundingClientRect();
    const h = host.getBoundingClientRect();
    return { x: b.left - h.left, y: b.top - h.top, w: b.width, h: b.height };
  }

  function wingspanPx(sp){
    return Math.max(
      sp.WINGSPAN_MIN_PX,
      Math.min(sp.WINGSPAN_MAX_PX, cssW * sp.WINGSPAN_RATIO)
    );
  }

  function drawFlyover(fo, dt, now){
    const sp = fo.species;
    const W = wingspanPx(sp);
    // A bird above the cloud layer is genuinely further away, so it is drawn
    // slightly smaller and slightly fainter. Without this the two depths read
    // as a z-order bug rather than as height.
    const depthScale = fo.aboveClouds ? BIRD_CFG.ABOVE_CLOUD_SCALE : 1;
    const depthAlpha = fo.aboveClouds ? BIRD_CFG.ABOVE_CLOUD_ALPHA : 1;

    for(const b of fo.birds){
      const t = fo.t - b.lag;
      if(t < 0 || t > 1) { stepFlap(b.flap, dt, now, sp); continue; }

      const p   = bezier(fo.path, t);
      const tan = bezierTangent(fo.path, t);
      const heading = Math.atan2(tan.y, tan.x);

      // Lateral offset is perpendicular to heading, so the echelon holds
      // its shape through a curve instead of collapsing on the bends.
      const px = p.x * cssW + Math.cos(heading + Math.PI/2) * b.lateral * W;
      const py = p.y * cssH + Math.sin(heading + Math.PI/2) * b.lateral * W;

      const altitude = 1 + Math.sin(t * Math.PI) * sp.ALTITUDE_SWING;
      const wingsOut = stepFlap(b.flap, dt, now, sp);
      // Fade is per BIRD, not per flyover, so a trailing goose is still
      // fading up while the leader is already at full opacity.
      const alpha = BIRD_CFG.ALPHA * fadeAt(t) * depthAlpha;

      // Deliberately NOT snapped to integer pixels: at this size rounding
      // produces visible jitter. Subpixel plus anti-aliasing is smoother.
      drawBird(ctx, px, py, W * altitude * depthScale, heading, wingsOut, sp, alpha);
    }
  }

  function drawClouds(dt){
    if(!clouds.length) seedClouds();
    const rect = CLOUD_CFG.SHADOWS_ENABLED ? boardRect() : null;

    if(shadowCtx && rect){
      shadowCtx.save();
      // Clipped to the board, so nothing falls on the tabletop.
      shadowCtx.beginPath();
      shadowCtx.rect(rect.x, rect.y, rect.w, rect.h);
      shadowCtx.clip();
    }

    const vx = Math.cos(windAngle), vy = Math.sin(windAngle);
    const base = cssW * CLOUD_CFG.SPEED_RATIO * (dt/1000);

    for(const c of clouds){
      const w = cssW * CLOUD_CFG.WIDTH_RATIO * c.scale;
      const h = w * (TEX_H/TEX_W);
      const m = w;

      c.x += vx * base * c.speed;
      c.y += vy * base * c.speed;
      c.x = wrap(c.x, -m, cssW + m);
      c.y = wrap(c.y, -cssH*0.20 - h, cssH + h);

      const tex = cloudTex[c.tex];
      if(!tex) continue;

      // SHADOW first, on its own multiply canvas, at a fixed offset.
      if(shadowCtx && rect){
        const sw = w * CLOUD_CFG.SHADOW_SCALE, sh = h * CLOUD_CFG.SHADOW_SCALE;
        const sx = c.x - sw/2 + w*CLOUD_CFG.SHADOW_OFFSET_X;
        const sy = c.y - sh/2 + h*CLOUD_CFG.SHADOW_OFFSET_Y;
        // Skip blits the clip would discard anyway. At COUNT 8 a meaningful
        // share of shadows sit entirely off the board on any given frame, and
        // these are large full-texture draws, not cheap ones.
        if(sx + sw < rect.x || sx > rect.x + rect.w ||
           sy + sh < rect.y || sy > rect.y + rect.h){ /* off board */ } else {
        shadowCtx.globalAlpha = CLOUD_CFG.SHADOW_ALPHA * c.alpha;
        shadowCtx.drawImage(tex.dark, sx, sy, sw, sh);
        }
      }

      // CLOUD second, on the sky canvas, drawn after the birds so a bird
      // passing beneath one is dimmed by it for free.
      ctx.save();
      ctx.globalAlpha = CLOUD_CFG.ALPHA * c.alpha;
      if(c.flip){ ctx.translate(c.x, c.y); ctx.scale(-1, 1); ctx.translate(-c.x, -c.y); }
      ctx.drawImage(tex.light, c.x - w/2, c.y - h/2, w, h);
      ctx.restore();
    }

    if(shadowCtx && rect) shadowCtx.restore();
  }

  function tick(now){
    if(!running) return;
    const dt = lastT ? Math.min(100, now - lastT) : 16; // clamp: tab-switch back must not teleport the flock
    lastT = now;

    ctx.clearRect(0, 0, cssW, cssH);
    if(shadowCtx) shadowCtx.clearRect(0, 0, cssW, cssH);

    // Launch. Gated on MAX_CONCURRENT rather than on the sky being empty, which
    // is what lets two crossings overlap. The second is forced to a different
    // species so two identical formations never share the board.
    // Checked per frame, not per session: the Field Report toggle takes effect
    // immediately. Turning it off also clears anything already in the air rather
    // than letting a bird finish its crossing after the player said no.
    if(!AmbientPref.enabled){
      if(flyovers.length) flyovers.length = 0;
      if(clouds.length) clouds.length = 0;
      raf = requestAnimationFrame(tick);
      return;
    }

    if(now >= nextLaunchAt && flyovers.length < BIRD_CFG.MAX_CONCURRENT){
      const inTheAir = flyovers.length ? flyovers[0].species.key : null;
      flyovers.push(newFlyover(null, null, inTheAir));
      nextLaunchAt = now + rand(BIRD_CFG.LAUNCH_GAP_MS_MIN, BIRD_CFG.LAUNCH_GAP_MS_MAX);
    }

    // ADVANCE AND CULL, once per flyover per frame. Kept separate from the
    // draw passes below because the sky is now painted in three layers and a
    // flyover must not be advanced twice.
    for(let i = flyovers.length - 1; i >= 0; i--){
      const fo = flyovers[i];
      fo.t += dt / fo.durationMs;
      if(fo.t >= 1 + fo.species.ECHELON_LAG * fo.birds.length) flyovers.splice(i, 1);
    }

    // THREE PASSES, in physical order: birds under the clouds, then the
    // clouds, then birds over the clouds. Each flyover sits in exactly one
    // bird pass, so stepFlap still advances once per bird per frame.
    for(const fo of flyovers) if(!fo.aboveClouds) drawFlyover(fo, dt, now);
    drawClouds(dt);
    for(const fo of flyovers) if( fo.aboveClouds) drawFlyover(fo, dt, now);

    raf = requestAnimationFrame(tick);
  }

  return {
    /* Creates the canvas inside `hostEl` (#boardWrap in the game).
       Does not start animating. */
    init(hostEl, opts){
      if(cv) return this;
      host = hostEl;
      boardEl = (opts && opts.boardEl) || document.getElementById('board');

      // mix-blend-mode below blends against whatever backdrop it can reach.
      // Without an explicit isolation group that is the whole page, so the
      // shadows would darken the app chrome rather than the terrain. Setting
      // it here rather than in index.html keeps the module self-contained.
      // (This is also the documented fix for blend modes silently overriding
      // z-index, which has bitten this codebase before.)
      try { host.style.isolation = 'isolate'; } catch { /* non-fatal */ }

      // SHADOW CANVAS. Sits below the sky canvas and below the UI, and
      // multiplies into the board beneath it.
      shadowCv = document.createElement('canvas');
      shadowCv.id = 'ambientShadows';
      shadowCv.style.cssText =
        'position:absolute;left:0;top:0;pointer-events:none;z-index:9;' +
        'mix-blend-mode:multiply;';
      host.appendChild(shadowCv);
      shadowCtx = shadowCv.getContext('2d');

      cv = document.createElement('canvas');
      cv.id = 'ambientLayer';
      // pointer-events:none is the single highest-risk line in this file.
      // Without it the sky silently eats every tap on the board.
      //
      // z-index 10 sits deliberately between the map and the chrome. The board
      // canvas is static (its transform paints it at the 0 level) so birds pass
      // over terrain, units and portraits; every piece of UI in the app starts
      // at 20 (dice popup, corner buttons, unit panel, Field Report, modals) so
      // all of it occludes them. 10 leaves headroom on both sides — the old
      // value of 2 sat one step off the board and would have been covered by
      // the first stray z-index:3 anyone added.
      cv.style.cssText =
        'position:absolute;left:0;top:0;pointer-events:none;z-index:10;';
      host.appendChild(cv);
      ctx = cv.getContext('2d');

      bakeCloudTextures();

      resize();
      if(window.ResizeObserver){
        ro = new ResizeObserver(resize);
        ro.observe(host);
      }
      window.addEventListener('resize', resize);
      return this;
    },

    start(){
      if(running || !cv) return;
      running = true;
      lastT = 0;
      // One wind vector for the whole battle. Direction is a coin flip, angle
      // is a small deviation from horizontal. Exposed as .windAngle so any
      // future gunsmoke drifts the same way without a second source of truth.
      windAngle = (Math.random() < 0.5 ? 0 : Math.PI) +
                  rand(-CLOUD_CFG.WIND_SPREAD_RAD, CLOUD_CFG.WIND_SPREAD_RAD);
      seedClouds();
      nextLaunchAt = performance.now() +
        rand(BIRD_CFG.FIRST_DELAY_MS_MIN, BIRD_CFG.FIRST_DELAY_MS_MAX);
      raf = requestAnimationFrame(tick);
    },

    /* Cancel outright rather than hide. Called when a modal, the unit
       selection overlay or the Field Report menu opens. */
    suspend(){
      running = false;
      if(raf) cancelAnimationFrame(raf);
      raf = null;
      if(ctx) ctx.clearRect(0, 0, cssW, cssH);
      if(shadowCtx) shadowCtx.clearRect(0, 0, cssW, cssH);
    },

    resume(){
      if(running || !cv) return;
      running = true;
      lastT = 0;
      raf = requestAnimationFrame(tick);
    },

    /* Force a crossing immediately. Debug and review only. */
    flyNow(pathIndex, speciesKey){
      flyovers.push(newFlyover(speciesKey, pathIndex));
    },

    /* Clear the sky without stopping the loop. Review only. */
    clear(){ flyovers.length = 0; },

    /* Re-bake and re-place the clouds. Review only: needed after changing
       any CLOUD_CFG value that is baked in rather than read per frame
       (colours, TEX_COUNT). Alpha, speed and size are read live and need
       no reseed. */
    reseedClouds(rebake){
      if(rebake) bakeCloudTextures();
      seedClouds();
    },

    /* Override the battle wind. Review only. */
    setWind(rad){ windAngle = rad; },

    /* Jump every crossing in the air to a point in its path. Review only. */
    seek(t){ for(const fo of flyovers) fo.t = t; },

    /* Force every subsequent crossing above or below the clouds.
       true / false / null (null restores the per-species chance).
       Review only. */
    forceDepth(v){ forceAboveClouds = v; },

    resize,

    destroy(){
      this.suspend();
      ro?.disconnect();
      window.removeEventListener('resize', resize);
      cv?.remove();
      shadowCv?.remove();
      cv = null; ctx = null;
      shadowCv = null; shadowCtx = null;
      host = null; boardEl = null;
      clouds = []; cloudTex = null;
    },

    get isRunning(){ return running; },
    get isFlying(){ return flyovers.length > 0; },
    get inTheAir(){ return flyovers.length; },
    get flightProgress(){ return flyovers.length ? flyovers[0].t : null; },
    get pathCount(){ return PATHS.length; },
    get windAngle(){ return windAngle; },
    get cloudCount(){ return clouds.length; },
    get aboveCloudCount(){ return flyovers.filter(f => f.aboveClouds).length; },
    /* Present so callers can confirm the shadow layer actually mounted,
       rather than assuming it did. */
    get hasShadowLayer(){ return !!shadowCv; },
  };
})();
