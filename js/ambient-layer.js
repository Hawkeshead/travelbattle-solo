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
  },
  GEESE: {
    key:'GEESE', label:'Geese',
    COLOUR:'#C9C6BC', BEAK:'#E0A63C',        // whitish grey body, yellow beak
    WEIGHT: 3,
    WINGSPAN_RATIO:0.0382, WINGSPAN_MIN_PX:9, WINGSPAN_MAX_PX:21,
    FLAP_HZ:2.4, WINGS_OUT_DUTY:0.40, FLAPS_PER_GLIDE:5, WING_STUB:0.29,
    FLOCK_MIN:5, FLOCK_MAX:5, ECHELON_SPACING:1.9, ECHELON_LAG:0.020,
    CROSSING_MS:24000, ALTITUDE_SWING:0.26,
  },
  RAPTOR: {
    key:'RAPTOR', label:'Raptor',
    COLOUR:'#6B4A2F', BEAK:'#E0A63C',        // brown body, yellow beak
    WEIGHT: 1.5,
    WINGSPAN_RATIO:0.0509, WINGSPAN_MIN_PX:12, WINGSPAN_MAX_PX:28,
    FLAP_HZ:2.4, WINGS_OUT_DUTY:0.76, FLAPS_PER_GLIDE:2, WING_STUB:0.30,
    FLOCK_MIN:1, FLOCK_MAX:1, ECHELON_SPACING:1.9, ECHELON_LAG:0.020,
    CROSSING_MS:17000, ALTITUDE_SWING:0.17,
  },
};

// Crossing times were tuned as single values. Repeating one to the millisecond
// every time reads as mechanical, so each crossing is jittered by this much
// around the tuned figure. Set to 0 to fly exactly the tuned duration.
export const CROSSING_JITTER = 0.12;

/* ---------------------------------------------------------
   PREFERENCE
   Read through a getter every time rather than cached at init, so toggling it
   mid-battle takes effect on the next frame instead of on the next match.
--------------------------------------------------------- */
const PREF_KEY = 'fc:ambientMotion';
export const AmbientPref = {
  get enabled(){
    try { return localStorage.getItem(PREF_KEY) !== 'off'; }   // default ON
    catch { return true; }                                     // private mode / storage disabled
  },
  set enabled(v){
    try { localStorage.setItem(PREF_KEY, v ? 'on' : 'off'); } catch { /* nothing we can do */ }
  },
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
export const AmbientLayer = (() => {
  let host = null, cv = null, ctx = null;
  let raf = null, lastT = 0;
  let cssW = 0, cssH = 0, dpr = 1;
  let flyovers = [], nextLaunchAt = 0;
  let running = false;
  let reducedMotion = false;
  let ro = null;

  function resize(){
    if(!host || !cv) return;
    const r = host.getBoundingClientRect();
    cssW = Math.max(1, r.width);
    cssH = Math.max(1, r.height);
    dpr  = window.devicePixelRatio || 1;
    cv.style.width  = cssW + 'px';
    cv.style.height = cssH + 'px';
    cv.width  = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function wingspanPx(sp){
    return Math.max(
      sp.WINGSPAN_MIN_PX,
      Math.min(sp.WINGSPAN_MAX_PX, cssW * sp.WINGSPAN_RATIO)
    );
  }

  function tick(now){
    if(!running) return;
    const dt = lastT ? Math.min(100, now - lastT) : 16; // clamp: tab-switch back must not teleport the flock
    lastT = now;

    ctx.clearRect(0, 0, cssW, cssH);

    // Launch. Gated on MAX_CONCURRENT rather than on the sky being empty, which
    // is what lets two crossings overlap. The second is forced to a different
    // species so two identical formations never share the board.
    // Checked per frame, not per session: the Field Report toggle takes effect
    // immediately. Turning it off also clears anything already in the air rather
    // than letting a bird finish its crossing after the player said no.
    if(!AmbientPref.enabled){
      if(flyovers.length) flyovers.length = 0;
      raf = requestAnimationFrame(tick);
      return;
    }

    if(now >= nextLaunchAt && !reducedMotion && flyovers.length < BIRD_CFG.MAX_CONCURRENT){
      const inTheAir = flyovers.length ? flyovers[0].species.key : null;
      flyovers.push(newFlyover(null, null, inTheAir));
      nextLaunchAt = now + rand(BIRD_CFG.LAUNCH_GAP_MS_MIN, BIRD_CFG.LAUNCH_GAP_MS_MAX);
    }

    for(let i = flyovers.length - 1; i >= 0; i--){
      const fo = flyovers[i];
      const sp = fo.species;
      fo.t += dt / fo.durationMs;
      if(fo.t >= 1 + sp.ECHELON_LAG * fo.birds.length){
        flyovers.splice(i, 1);
        continue;
      }
      const W = wingspanPx(sp);
      // Birds are drawn BEFORE the cloud pass will be, so a bird passing
      // under a cloud is dimmed by the cloud's own alpha for free.
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
        const alpha = BIRD_CFG.ALPHA * fadeAt(t);

        // Deliberately NOT snapped to integer pixels: at this size rounding
        // produces visible jitter. Subpixel plus anti-aliasing is smoother.
        drawBird(ctx, px, py, W * altitude, heading, wingsOut, sp, alpha);
      }
    }

    raf = requestAnimationFrame(tick);
  }

  return {
    /* Creates the canvas inside `hostEl` (#boardWrap in the game).
       Does not start animating. */
    init(hostEl){
      if(cv) return this;
      host = hostEl;
      cv = document.createElement('canvas');
      cv.id = 'ambientLayer';
      // pointer-events:none is the single highest-risk line in this file.
      // Without it the sky silently eats every tap on the board.
      cv.style.cssText =
        'position:absolute;left:0;top:0;pointer-events:none;z-index:2;';
      host.appendChild(cv);
      ctx = cv.getContext('2d');

      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      reducedMotion = mq.matches;
      mq.addEventListener?.('change', e => { reducedMotion = e.matches; });

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

    resize,

    destroy(){
      this.suspend();
      ro?.disconnect();
      window.removeEventListener('resize', resize);
      cv?.remove();
      cv = null; ctx = null; host = null;
    },

    get isRunning(){ return running; },
    get isFlying(){ return flyovers.length > 0; },
    get inTheAir(){ return flyovers.length; },
    get flightProgress(){ return flyovers.length ? flyovers[0].t : null; },
    get pathCount(){ return PATHS.length; },
  };
})();
