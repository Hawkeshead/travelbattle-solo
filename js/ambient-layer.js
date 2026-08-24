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
  // Size. Ratio of the ambient canvas width, then clamped, so it survives
  // orientation changes and the two-board field without re-tuning.
  WINGSPAN_RATIO   : 0.018,
  WINGSPAN_MIN_PX  : 7,
  WINGSPAN_MAX_PX  : 16,

  // Silhouette. Not pure black: at this size pure black over the cel-shaded
  // tiles reads as a dead pixel rather than a bird.
  COLOUR           : '#2A2620',
  ALPHA            : 0.62,

  // Two-frame flap. WINGS_OUT_DUTY is the fraction of each flap cycle spent
  // in the wings-out frame; above 0.5 because the powered downstroke (wings
  // hidden) is faster than the recovery.
  FLAP_HZ          : 2.5,
  WINGS_OUT_DUTY   : 0.65,
  FLAPS_PER_GLIDE  : 3,
  // How much wing is still visible on the downstroke. 0 gives a pure
  // body-only frame; at small sizes that flickers rather than flaps,
  // so a short stub reads better. Tune this one by eye.
  WING_STUB        : 0.22,
  GLIDE_MS_MIN     : 800,
  GLIDE_MS_MAX     : 1200,
  FLAP_RATE_JITTER : 0.08,   // +/- per bird, so the flock never syncs

  // Flock. Loose echelon, never a V.
  FLOCK_MIN        : 2,
  FLOCK_MAX        : 3,
  ECHELON_SPACING  : 2.2,    // wingspans between birds, laterally
  ECHELON_LAG      : 0.014,  // fraction of the crossing each follower trails

  // Crossing.
  CROSSING_MS_MIN  : 18000,
  CROSSING_MS_MAX  : 30000,
  ALTITUDE_SWING   : 0.10,   // +/- scale across the crossing, implies height change

  // Scheduling.
  FIRST_DELAY_MS_MIN : 30000,
  FIRST_DELAY_MS_MAX : 45000,
  DORMANT_MS_MIN     : 60000,
  DORMANT_MS_MAX     : 120000,
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
   BIRD_CFG.WING_STUB. Set WING_STUB to 0 for a pure body-only down frame. */
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

function drawBird(ctx, x, y, wingspan, heading, wingsOut, colour, alpha){
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(heading);
  ctx.scale(wingspan, wingspan);
  ctx.fillStyle = colour;
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  pathBody(ctx);
  pathTail(ctx);
  pathWings(ctx, wingsOut ? 1 : BIRD_CFG.WING_STUB);
  ctx.fill();
  ctx.restore();
}

/* Exposed so the review harness can magnify the exact same geometry the
   game draws, rather than a copy of it that can drift out of step. */
export function drawBirdFrame(ctx, x, y, size, heading, wingsOut, alpha){
  drawBird(ctx, x, y, size, heading, wingsOut, BIRD_CFG.COLOUR,
           alpha == null ? BIRD_CFG.ALPHA : alpha);
}

/* ---------------------------------------------------------
   FLAP STATE
   A small phase machine rather than a continuous oscillator. A raw sine
   metronomes immediately; three flaps then a glide is what a real bird
   at distance actually looks like.
--------------------------------------------------------- */
function newFlapState(){
  return {
    mode        : 'flapping',
    flapsLeft   : BIRD_CFG.FLAPS_PER_GLIDE,
    cyclePhase  : Math.random(),                                        // desync at birth
    rate        : 1 + rand(-BIRD_CFG.FLAP_RATE_JITTER, BIRD_CFG.FLAP_RATE_JITTER),
    glideUntil  : 0,
  };
}

function stepFlap(f, dtMs, now){
  if(f.mode === 'gliding'){
    if(now >= f.glideUntil){ f.mode = 'flapping'; f.flapsLeft = BIRD_CFG.FLAPS_PER_GLIDE; f.cyclePhase = 0; }
    return true; // wings out throughout the glide
  }
  const cycleMs = 1000 / (BIRD_CFG.FLAP_HZ * f.rate);
  f.cyclePhase += dtMs / cycleMs;
  while(f.cyclePhase >= 1){
    f.cyclePhase -= 1;
    if(--f.flapsLeft <= 0){
      f.mode = 'gliding';
      f.glideUntil = now + rand(BIRD_CFG.GLIDE_MS_MIN, BIRD_CFG.GLIDE_MS_MAX);
      return true;
    }
  }
  return f.cyclePhase < BIRD_CFG.WINGS_OUT_DUTY;
}

/* ---------------------------------------------------------
   FLYOVER
   One crossing by one flock. Followers do not steer: because the path is
   known ahead of time they simply sample it at t minus a lag, with a
   lateral offset. Free, and indistinguishable from real flocking at
   this scale.
--------------------------------------------------------- */
function newFlyover(pathIndex){
  const base = PATHS[pathIndex != null ? pathIndex : randI(0, PATHS.length-1)];
  const jitterY = rand(-0.08, 0.08);
  const path = {
    p0: { x: base.p0.x, y: base.p0.y + jitterY },
    cp: { x: base.cp.x, y: base.cp.y + jitterY },
    p1: { x: base.p1.x, y: base.p1.y + jitterY },
  };
  const size = randI(BIRD_CFG.FLOCK_MIN, BIRD_CFG.FLOCK_MAX);
  const birds = [];
  for(let i=0; i<size; i++){
    birds.push({
      lag     : i * BIRD_CFG.ECHELON_LAG,
      lateral : (i === 0 ? 0 : (i % 2 ? 1 : -1) * BIRD_CFG.ECHELON_SPACING * rand(0.75, 1.35)),
      flap    : newFlapState(),
    });
  }
  return {
    path,
    birds,
    t         : 0,
    durationMs: rand(BIRD_CFG.CROSSING_MS_MIN, BIRD_CFG.CROSSING_MS_MAX),
  };
}

/* ---------------------------------------------------------
   THE LAYER
--------------------------------------------------------- */
export const AmbientLayer = (() => {
  let host = null, cv = null, ctx = null;
  let raf = null, lastT = 0;
  let cssW = 0, cssH = 0, dpr = 1;
  let flyover = null, nextFlyoverAt = 0;
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

  function wingspanPx(){
    return Math.max(
      BIRD_CFG.WINGSPAN_MIN_PX,
      Math.min(BIRD_CFG.WINGSPAN_MAX_PX, cssW * BIRD_CFG.WINGSPAN_RATIO)
    );
  }

  function tick(now){
    if(!running) return;
    const dt = lastT ? Math.min(100, now - lastT) : 16; // clamp: tab-switch back must not teleport the flock
    lastT = now;

    ctx.clearRect(0, 0, cssW, cssH);

    if(!flyover && now >= nextFlyoverAt && !reducedMotion){
      flyover = newFlyover();
    }

    if(flyover){
      flyover.t += dt / flyover.durationMs;
      if(flyover.t >= 1 + BIRD_CFG.ECHELON_LAG * flyover.birds.length){
        flyover = null;
        nextFlyoverAt = now + rand(BIRD_CFG.DORMANT_MS_MIN, BIRD_CFG.DORMANT_MS_MAX);
      } else {
        const W = wingspanPx();
        // Birds are drawn BEFORE the cloud pass will be, so a bird passing
        // under a cloud is dimmed by the cloud's own alpha for free.
        for(const b of flyover.birds){
          const t = flyover.t - b.lag;
          if(t < 0 || t > 1) { stepFlap(b.flap, dt, now); continue; }

          const p   = bezier(flyover.path, t);
          const tan = bezierTangent(flyover.path, t);
          const heading = Math.atan2(tan.y, tan.x);

          // Lateral offset is perpendicular to heading, so the echelon holds
          // its shape through a curve instead of collapsing on the bends.
          const px = p.x * cssW + Math.cos(heading + Math.PI/2) * b.lateral * W;
          const py = p.y * cssH + Math.sin(heading + Math.PI/2) * b.lateral * W;

          const altitude = 1 + Math.sin(t * Math.PI) * BIRD_CFG.ALTITUDE_SWING * (b.lag ? 1 : 1);
          const wingsOut = stepFlap(b.flap, dt, now);

          // Deliberately NOT snapped to integer pixels: at this size rounding
          // produces visible jitter. Subpixel plus anti-aliasing is smoother.
          drawBird(ctx, px, py, W * altitude, heading, wingsOut, BIRD_CFG.COLOUR, BIRD_CFG.ALPHA);
        }
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
      nextFlyoverAt = performance.now() +
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
    flyNow(pathIndex){
      flyover = newFlyover(pathIndex);
    },

    resize,

    destroy(){
      this.suspend();
      ro?.disconnect();
      window.removeEventListener('resize', resize);
      cv?.remove();
      cv = null; ctx = null; host = null;
    },

    get isRunning(){ return running; },
    get pathCount(){ return PATHS.length; },
  };
})();
