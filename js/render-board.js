import { AudioManager } from './audio-manager.js';
import { CELL, COLS, HALF_COLS, ROWS, SIDES, SIDE_LABEL, UNIT_TYPES, setCell, state } from './data-core.js';
import { inBounds, isRoadLike, movableUnitsForSide, neighbors8, terrainAt, unitsAt } from './engine-rules.js';
import { log, logReplay } from './engine-state.js';
import { UNIT_IMAGES, drawColumnUnitPair, drawUnit, highlightCells } from './render-units.js';
import { renderAiDebugPanel } from './ui-battle.js';
import { dragState } from './ui-deployment.js';

/* =========================================================
   RENDERING
========================================================= */
// You always sit behind your own troops on screen, regardless of which
// side you're playing. Purely a rendering/input transform — internal
// board coordinates, movement, LOS, and board rotation are untouched.
// Self-inverse (flipping twice returns the original), so the same
// function converts board->screen and screen->board.
export function screenFlipActive(){
  return state.mode==='ai' && state.aiSide===SIDES.RED; // human is playing France (Blue), whose zone is internally "top"
}
export function sy(y){
  return screenFlipActive() ? (ROWS-1-y) : y;
}

/* =========================================================
   UNIT MOVEMENT ANIMATION
   Units jumped instantly to their new square, which made rapid AI
   turns hard to follow. animateUnitTo() updates the logical position
   immediately (game logic never waits on animation) but the VISUAL
   position eases toward it over a short duration; drawUnit reads the
   interpolated position instead of u.x/u.y directly.
========================================================= */
export let unitAnimations = {}; // unitId -> {fromX, fromY, toX, toY, startTime, duration}
export let activeActionLine = null; // {fromX, fromY, toX, toY, color, expiresAt} — who's firing/fighting whom
export let deathEffects = []; // {x, y, startTime} — skull for 2s, then smoke fades over another 2s
export let animFrameHandle = null;

// Undo and the replay player both need to wipe every in-flight visual effect.
// They used to assign to these three bindings directly from another file;
// under ES modules that throws, so the reset lives here instead.
export function clearUnitAnimations(){
  unitAnimations = {};
}

export function clearTransientRenderState(){
  unitAnimations = {};
  activeActionLine = null;
  deathEffects = [];
}

export const DEATH_SKULL_MS = 2000, DEATH_SMOKE_MS = 2000;
export function addDeathEffect(x, y){
  deathEffects.push({x, y, startTime: Date.now()});
  /* The death cry belongs WITH the skull, not beside it.

     Sounding it here rather than in removeUnit means the two halves of the same
     effect can never come apart: anything that raises a skull makes the noise,
     and anything that does not, does not. That distinction already matters. A
     Brigadier whose Brigade breaks is removed but withdraws rather than dying,
     and removeUnit deliberately skips the death effect for him. He should not
     scream either.

     This does put an audio call in the renderer, which I avoided for the board
     ambience on the grounds that the renderer has no business knowing about
     sound. The difference is that addDeathEffect IS the effect rather than the
     board: skull, smoke and cry are one thing presented three ways. */
  // Panned to where the unit fell. panForBoardX is the coarse three-zone helper
  // the other positional effects use.
  AudioManager.playEffect('unit-destroyed', 'audio/effects/unit-destroyed.wav', 'majorCombat',
    { pan: AudioManager.panForBoardX(x) });
  ensureAnimationLoopRunning();
}
export function addCrater(x, y){
  if(state.craters.some(c=>c.x===x && c.y===y)) return; // already scarred, don't stack markers
  state.craters.push({x, y});
}

/* =========================================================
   DISPLAY PATH — how a unit got there, not whether it could

   The engine has already ruled the move legal. This exists only so the icon
   travels through the squares it crossed instead of sliding across the board on
   a straight line.

   Deliberately NOT reconstructPath from the movement search. That search treats
   squares holding other units as blocked, because for legality they are. For
   DISPLAY they are not: a unit whose route runs through its own supports rides
   through those squares and out the far side, which is what actually happened.
   Routing around them, or failing to find a route and falling back to a straight
   line, would both be wrong.

   Terrain restrictions ARE respected, so cavalry never animates through a
   building it could not enter. Occupancy is the only thing ignored.
========================================================= */
const DISPLAY_PATH_MAX = 8;   // no legal move is longer; a guard against a runaway search

export function displayPath(u, fromX, fromY, toX, toY){
  if(fromX===toX && fromY===toY) return [{x:fromX, y:fromY}];
  const t = UNIT_TYPES[u.type];
  const passable = (x,y)=>{
    if(!inBounds(x,y)) return false;
    const terr = terrainAt(x,y);
    return !(terr.restrictTo && !terr.restrictTo.includes(t.key));
  };
  /* The straight walk first. Movement is chebyshev, so stepping one square at a
     time toward the destination is ALWAYS optimal in step count, and it is the
     straightest possible route by construction. That settles the plan's
     tie-breaking rule (fewest direction changes) without needing to score
     alternatives: a search would find equal-cost routes that wander around
     occupied squares and pick between them arbitrarily, which is how a unit
     ends up appearing to sidestep its own supports.

     Only when terrain blocks the straight walk does the search below run. */
  const straight = [{x:fromX, y:fromY}];
  let sx = fromX, sy_ = fromY, straightOk = true;
  for(let i=0; i<DISPLAY_PATH_MAX; i++){
    if(sx===toX && sy_===toY) break;
    sx += Math.sign(toX-sx); sy_ += Math.sign(toY-sy_);
    const atGoal = (sx===toX && sy_===toY);
    if(!passable(sx, sy_) && !atGoal){ straightOk = false; break; }
    straight.push({x:sx, y:sy_});
    if(atGoal) break;
  }
  if(straightOk && straight.length &&
     straight[straight.length-1].x===toX && straight[straight.length-1].y===toY){
    return straight;
  }

  const startKey = fromX+','+fromY, goal = toX+','+toY;
  const cameFrom = new Map();
  const dist = new Map([[startKey, 0]]);
  const queue = [{x:fromX, y:fromY, d:0}];
  while(queue.length){
    const cur = queue.shift();
    if(cur.d >= DISPLAY_PATH_MAX) continue;
    for(const n of neighbors8(cur.x, cur.y)){
      const key = n.x+','+n.y, nd = cur.d+1;
      if(dist.has(key) && dist.get(key) <= nd) continue;
      if(!passable(n.x, n.y) && key !== goal) continue;   // the destination is legal by definition
      dist.set(key, nd);
      cameFrom.set(key, cur.x+','+cur.y);
      queue.push({x:n.x, y:n.y, d:nd});
    }
  }
  if(!cameFrom.has(goal)) return [{x:fromX,y:fromY},{x:toX,y:toY}];
  const out = [];
  let key = goal;
  for(let i=0; i<DISPLAY_PATH_MAX+2; i++){
    const [x,y] = key.split(',').map(Number);
    out.push({x, y});
    if(key === startKey) break;
    key = cameFrom.get(key);
    if(key === undefined) return [{x:fromX,y:fromY},{x:toX,y:toY}];
  }
  return out.reverse();
}

/* Distance along a polyline, so the tween is parametrised by how far the unit
   has travelled rather than by which segment it is on. Per-segment easing
   stutters at every waypoint; this does not. */
function polylineLength(path){
  let total = 0;
  for(let i=1;i<path.length;i++){
    total += Math.hypot(path[i].x-path[i-1].x, path[i].y-path[i-1].y);
  }
  return total;
}

/* Corner rounding. A sharp 90-degree turn reads as mechanical, and a fully
   smoothed spline reads as if the unit skipped squares, so the corner is eased
   only within CORNER_R of the waypoint. The icon still passes through the centre
   region of every square it enters. */
const CORNER_R = 0.30;

function roundCorner(path, i, local){
  const prev = path[i-1], here = path[i], next = path[i+1];
  if(!next) return null;
  const inDir  = { x: here.x-prev.x, y: here.y-prev.y };
  const outDir = { x: next.x-here.x, y: next.y-here.y };
  if(inDir.x===outDir.x && inDir.y===outDir.y) return null;  // straight through
  const distToCorner = 1 - local;
  if(distToCorner > CORNER_R) return null;
  // Quadratic bezier with the control point AT the corner, so the curve still
  // passes close to the square's centre rather than cutting it off.
  const b = (1 - distToCorner/CORNER_R) * 0.5 + 0.5;
  const p0 = { x: here.x - inDir.x*CORNER_R,  y: here.y - inDir.y*CORNER_R };
  const p2 = { x: here.x + outDir.x*CORNER_R, y: here.y + outDir.y*CORNER_R };
  const mt = 1-b;
  return { x: mt*mt*p0.x + 2*mt*b*here.x + b*b*p2.x,
           y: mt*mt*p0.y + 2*mt*b*here.y + b*b*p2.y };
}

function pointAlongPolyline(path, fraction, corners){
  if(path.length === 1) return { x:path[0].x, y:path[0].y };
  const target = polylineLength(path) * fraction;
  let walked = 0;
  for(let i=1;i<path.length;i++){
    const seg = Math.hypot(path[i].x-path[i-1].x, path[i].y-path[i-1].y);
    if(walked + seg >= target || i === path.length-1){
      const local = seg === 0 ? 0 : Math.min(1, (target - walked) / seg);
      if(corners){
        const c = roundCorner(path, i, local);
        if(c) return c;
      }
      return { x: path[i-1].x + (path[i].x-path[i-1].x)*local,
               y: path[i-1].y + (path[i].y-path[i-1].y)*local };
    }
    walked += seg;
  }
  return { x:path[path.length-1].x, y:path[path.length-1].y };
}

/* Vertical gait bob, DRAW TIME ONLY.

   Deliberately not part of getUnitVisualPos: that value feeds the depth sort,
   and a unit whose sort key bobbed would flicker in front of and behind terrain
   at a row boundary. Callers that need to sort ask for the position; callers
   that draw add this on top. */
/* ROAD DUST.

   Emitted only while the segment being crossed is a road square: that is where
   the extra square of movement came from, so the route should show it. One puff
   per square centre crossed rather than a continuous trail, which would read as
   a smoke plume instead of hooves on a dry road.

   Shares the look of the board intro's dust (same colour and ellipse) at lower
   opacity and a shorter life, so the two read as the same material. Kept here
   rather than extracted into a shared emitter: the intro's version is welded
   into its own rAF loop and pulling it out would touch the intro for no gain.
========================================================= */
export const ROAD_DUST = { alpha: 0.22, ms: 420, radius: 0.13 };
const roadDust = [];   // {x, y, startTime} in board coordinates

function emitRoadDustIfCrossing(u, anim, pos){
  if(!anim.path || anim.path.length < 2) return;
  // Which waypoint have we just passed? Only the moment of crossing emits.
  const idx = Math.round(pos.x) === pos.x && Math.round(pos.y) === pos.y ? -1 : Math.floor(
    (anim.path.length - 1) * Math.min(1, (Date.now() - anim.startTime) / anim.duration));
  if(idx < 0 || idx >= anim.path.length) return;
  const sq = anim.path[idx];
  if(!sq || anim.dustAt === idx) return;
  anim.dustAt = idx;
  if(!isRoadLike(terrainAt(sq.x, sq.y))) return;
  roadDust.push({ x: sq.x*CELL + CELL/2, y: (sy(sq.y)+1)*CELL, startTime: Date.now() });
}

export function drawRoadDust(){
  const now = Date.now();
  for(let i=roadDust.length-1; i>=0; i--){
    const p = roadDust[i];
    const age = now - p.startTime;
    if(age > ROAD_DUST.ms){ roadDust.splice(i,1); continue; }
    const t = age/ROAD_DUST.ms;
    ctx.save();
    ctx.globalAlpha = ROAD_DUST.alpha*(1-t);
    ctx.fillStyle = '#c9b98a';
    const r = CELL*ROAD_DUST.radius*(0.4+0.6*t);
    ctx.beginPath(); ctx.ellipse(p.x, p.y, r, r*0.45, 0, 0, Math.PI*2); ctx.fill();
    ctx.restore();
  }
  return roadDust.length > 0;
}

export function unitGaitOffset(u){
  const anim = unitAnimations[u.id];
  if(!anim) return 0;
  const g = GAIT[UNIT_TYPES[u.type].key];
  if(!g) return 0;
  const elapsed = (Date.now() - anim.startTime) / 1000;
  // Faded in and out so a unit does not appear to jolt as it starts and stops.
  const t = Math.min(1, (Date.now() - anim.startTime) / anim.duration);
  const fade = Math.sin(Math.PI * t);
  return -Math.abs(Math.sin(elapsed * Math.PI * g.hz)) * g.amp * fade;
}

export function getUnitVisualPos(u){
  const anim = unitAnimations[u.id];
  if(!anim) return {x:u.x, y:u.y};
  const elapsed = Date.now() - anim.startTime;
  const t = Math.min(1, elapsed/anim.duration);
  if(t>=1){ delete unitAnimations[u.id]; return {x:u.x, y:u.y}; }
  const eased = 1 - Math.pow(1-t, 2); // ease-out — starts fast, settles gently
  // Walk the route if one was found, otherwise the old two-point slide. Eased
  // across the WHOLE polyline by distance travelled, not per segment, so a
  // three-square move reads as one continuous movement rather than three hops.
  const prof = anim.profile || MOVE_PROFILES.march;

  /* Overshoot and settle. A pushback is involuntary: the unit is shoved a little
     past where it ends up and staggers back, which reads differently from an
     ordered step of the same distance. */
  let travel = eased;
  if(prof.settle){
    const OVERSHOOT_UNTIL = 0.82;
    travel = t < OVERSHOOT_UNTIL
      ? eased * (1 + prof.settle)
      : (1 + prof.settle) + (1 - (1 + prof.settle)) * ((t - OVERSHOOT_UNTIL) / (1 - OVERSHOOT_UNTIL));
  }

  let pos = (anim.path && anim.path.length > 2)
    ? pointAlongPolyline(anim.path, Math.min(1, Math.max(0, travel)), prof.corners)
    : { x: anim.fromX + (anim.toX-anim.fromX)*travel, y: anim.fromY + (anim.toY-anim.fromY)*travel };

  /* A routing unit does not run in a clean line. Irregular rather than a sine,
     or it reads as a deliberate weave. Faded out at both ends so the unit still
     leaves and arrives on its squares exactly. */
  if(prof.jitter){
    const fade = Math.sin(Math.PI * t);
    const n = (Math.sin(t*37.1 + u.id*11.3) + Math.sin(t*61.7 + u.id*5.9)) * 0.5;
    pos = { x: pos.x + n * prof.jitter * fade, y: pos.y + n * prof.jitter * fade * 0.6 };
  }
  emitRoadDustIfCrossing(u, anim, pos);
  return pos;
}

// A Brigadier is never blocked from having an enemy move into his square —
// he's simply shoved 1-2 squares clear. Called right before completing a
// move onto a square a lone enemy Brigadier currently occupies.
export function displaceBrigadierIfPresent(x, y, fromX, fromY){
  const occupant = state.units.find(o=>!o.removed && o.x===x && o.y===y && o.type==='BRIGADIER');
  if(!occupant) return;
  const dx = Math.sign(x-fromX) || 0, dy = Math.sign(y-fromY) || 0;
  const candidates = [
    {x:x+dx*2, y:y+dy*2}, {x:x+dx, y:y+dy},
    {x:x+dx, y:y}, {x:x, y:y+dy},
    ...neighbors8(x,y)
  ];
  for(const c of candidates){
    if(inBounds(c.x,c.y) && unitsAt(c.x,c.y).length===0){
      occupant.x = c.x; occupant.y = c.y;
      log(`${SIDE_LABEL[occupant.side]}'s Brigadier is shoved clear.`, 'system');
      return;
    }
  }
}

// Single source of truth for how long a move animation actually takes —
// referenced by the AI's move-phase pacing (aiDoMovePhase in ai-strategy.js)
// so the two can never drift apart the way a duplicated magic number could.
export const UNIT_MOVE_ANIMATION_MS = 1040;

/* Constant speed per square, so a three-square road move takes three times as
   long as an infantry step and the difference is legible. Below the 900ms the
   plan proposed: at 900 a three-square move alone runs 2.7s and an average AI
   turn grows by a third, which works against the battle camera being able to
   keep up. Tunable. */
export const MOVE_MS_PER_SQUARE = 1680;  // doubled again on playtest feedback

/* Per-kind motion profiles. The point is that a player can tell what HAPPENED
   from how a unit moved, before reading any log line: an ordered advance, a
   charge, being shoved, or breaking and running are four different events and
   should not all look like a slide.

   speed   multiplies the duration (lower is faster)
   corners rounds the turns; a charge is a straight run with no pivot by
           definition, so rounding it would contradict the rules
   settle  a short overshoot past the destination, then back — involuntary
   jitter  irregular lateral wobble, as a fraction of a square */
/* Rout is the quickest profile of the four, and deliberately so. A unit that
   breaks does not withdraw in order, it runs, and the retreat can cross most of
   the board: at the march rate an eight-square rout took over ten seconds, which
   is a long time to watch and a long time to wait for the rally roll that follows
   it. */
export const MOVE_PROFILES = {
  march:              { speed: 1.00, corners: true,  settle: 0,    jitter: 0     },
  charge:             { speed: 0.80, corners: false, settle: 0,    jitter: 0     },
  pushback:           { speed: 0.55, corners: false, settle: 0.07, jitter: 0     },
  rout:               { speed: 0.45, corners: true,  settle: 0,    jitter: 0.02  },
  advanceAfterCombat: { speed: 1.00, corners: true,  settle: 0,    jitter: 0     },
};

/* Gait, applied at DRAW time only. The intent is that the arm is readable from
   the movement alone, before the icon itself is legible: infantry plod, light
   cavalry skim, guns barely move.

   amplitude is a fraction of tile height, frequency is in Hz. Computed after
   the depth sort so a bobbing unit cannot z-fight with terrain at a row edge. */
export const GAIT = {
  INFANTRY:  { amp: 0.025, hz: 2.2 },
  GUARD:     { amp: 0.025, hz: 2.2 },
  LIGHT_CAV: { amp: 0.015, hz: 4.5 },
  HEAVY_CAV: { amp: 0.020, hz: 3.5 },
  ARTILLERY: { amp: 0.010, hz: 1.6 },
  BRIGADIER: { amp: 0.015, hz: 4.5 },
};

/* How long a given move will take, so the AI's pacing can wait exactly as long
   as the animation runs instead of a fixed guess. */
export function moveAnimationMs(steps){
  /* The floor was 0.55 of the old flat duration, which quietly undid the point
     of slowing things down: a ONE-square move, which is most of them, came out
     at 572ms against the original flat 1040ms, so movement got faster overall
     even as the per-square figure went up. The floor now scales with the
     per-square setting instead of being pinned to the old constant. */
  return Math.max(MOVE_MS_PER_SQUARE * 0.7, steps * MOVE_MS_PER_SQUARE);
}

export function animateUnitTo(u, newX, newY, kind){
  const start = getUnitVisualPos(u); // current rendered position, in case a prior animation was still mid-flight
  const fromX = u.x, fromY = u.y;
  /* Every move now carries who moved, in what shape, and whether it ended on
     its Brigadier's chain, FOR BOTH SIDES. Previously only French moves carried
     any of this, and only in the separate AI log, so British formation was
     invisible: you could see from a combat bonus that infantry had been caught
     in line by cavalry, but not what formation any British unit was in at any
     other moment, which makes a mistake and a mid-manoeuvre cost look identical.

     Connection is read AFTER the position updates, since that is the state the
     unit ends its move in and the one that matters next turn. */
  const connectedAfter = movableUnitsForSide(u.side).has(u.id);
  logReplay('move', {
    unitId:u.id, side:u.side, from:{x:fromX,y:fromY}, to:{x:newX,y:newY},
    unitType: UNIT_TYPES[u.type].key,
    brigadeId: u.brigadeId,
    formation: u.formation || 'line',
    status: u.turnOnly ? 'PushedBack' : (u.rallying ? 'Rallied' : 'Active'),
    connected: connectedAfter,
  });
  u.x = newX; u.y = newY; // logical position updates immediately — game rules never wait on animation
  if(FAST_ANIMATION_MODE){ delete unitAnimations[u.id]; return; } // test/simulation harnesses only — see setFastAnimationMode

  const path = displayPath(u, fromX, fromY, newX, newY);
  const squares = Math.max(Math.abs(newX-fromX), Math.abs(newY-fromY));
  /* A move of N squares must produce a path of N+1 points. Warn rather than
     silently sliding in a straight line, which is exactly the failure that is
     invisible until someone watches closely and wonders why a three-square move
     looks like a one-square one. */
  if(squares > 1 && path.length !== squares + 1){
    console.warn(`[move] ${u.historicalName || u.type}: ${squares}-square move produced a ` +
      `${path.length}-point path (expected ${squares + 1}) — animating on a straight line`, path);
  }
  const profile = MOVE_PROFILES[kind] || MOVE_PROFILES.march;
  unitAnimations[u.id] = {
    fromX:start.x, fromY:start.y, toX:newX, toY:newY, path, profile,
    startTime:Date.now(),
    duration: moveAnimationMs(Math.max(1, path.length - 1)) * profile.speed,
  };
  ensureAnimationLoopRunning();
}

// Mirrors FAST_DICE_MODE in dice.js exactly — never set by real gameplay, only
// by an automated harness that needs a full match to complete in a reasonable
// wall-clock time rather than waiting out 1040ms per unit move, many times a
// turn, many turns a match.
export let FAST_ANIMATION_MODE = false;
export function setFastAnimationMode(on){
  FAST_ANIMATION_MODE = !!on;
}
if(typeof window !== 'undefined'){
  window.__tbTest = Object.assign(window.__tbTest || {}, { setFastAnimationMode });
}

export function showActionLine(fromUnit, toUnit, color, durationMs, dashed){
  activeActionLine = { fromX:fromUnit.x, fromY:fromUnit.y, toX:toUnit.x, toY:toUnit.y, color, dashed:!!dashed, expiresAt: Date.now()+(durationMs||1800) };
  ensureAnimationLoopRunning();
}

export function ensureAnimationLoopRunning(){
  if(animFrameHandle) return;
  function tick(){
    draw();
    // Road dust outlives the move that kicked it up, so the loop keeps running
    // until the last puff has faded or it would freeze in mid-air.
    const stillAnimating = Object.keys(unitAnimations).length>0 || roadDust.length>0;
    const lineActive = activeActionLine && Date.now() < activeActionLine.expiresAt;
    if(!lineActive) activeActionLine = null;
    const now = Date.now();
    deathEffects = deathEffects.filter(d => now - d.startTime < DEATH_SKULL_MS + DEATH_SMOKE_MS);
    const deathActive = deathEffects.length>0;
    // British Line Infantry's sprite-sheet animation (see
    // drawBritishLineInfantryImage) needs continuous redraws to advance —
    // without this, it only re-renders (and so only appears to animate)
    // when some unrelated move/fight/death animation happens to be running,
    // freezing on whatever frame was current the rest of the time.
    const spriteAnimActive = state.units.some(u => !u.removed && (UNIT_TYPES[u.type].key==='INFANTRY' || UNIT_TYPES[u.type].key==='GUARD'));
    if(stillAnimating || lineActive || deathActive || spriteAnimActive){
      animFrameHandle = requestAnimationFrame(tick);
    } else {
      animFrameHandle = null;
    }
  }
  animFrameHandle = requestAnimationFrame(tick);
}

/* The render target is a live binding, not a constant.

   Every drawing helper in this module and in render-units.js writes to this one
   `ctx` and takes no context parameter, so as a `const` they could only ever
   draw to the battle board. ES modules export live bindings rather than copies,
   so reassigning it here redirects every importer at once, and every existing
   helper draws to the new target with no change to any of them. That is what
   lets the rules manual render its diagrams with the real terrain, unit art and
   tile canopies instead of a reimplementation that would drift out of step.

   Reassigned ONLY through setRenderTarget below, and only inside the
   begin/endDiagramMode pair. Nothing else should ever touch it. */
export let canvas = document.getElementById('board');
export let ctx = canvas.getContext('2d');

/* --- Diagram render scope ------------------------------------------------

   Swapping the render target while anything is drawing asynchronously would
   paint diagram content onto the battle board. There is exactly one such
   source: ensureAnimationLoopRunning's rAF loop, which calls draw() and which
   during a battle runs CONTINUOUSLY rather than occasionally, because
   spriteAnimActive is true whenever any Infantry or Guard unit is on the board.
   So the loop is cancelled for the duration of the swap and restored after,
   which the plan rightly called non-negotiable.

   (The ambient layer runs a second, independent rAF loop, but it owns its own
   canvases and never touches this ctx, so it is deliberately left running.)

   The nested guard is not paranoia: a diagram drawn while already swapped would
   restore the FIRST diagram's target on the inner end() and leave the battle
   board pointing at a detached canvas for the rest of the session, with no
   error at the point of failure. It throws instead. */
let diagramScopeActive = false;
let savedRenderScope = null;

export function setRenderTarget(nextCanvas){
  canvas = nextCanvas;
  ctx = nextCanvas.getContext('2d');
}

export function isDiagramScopeActive(){ return diagramScopeActive; }

/* Fields the render path reads off `state`. Verified by scanning every
   `state.*` reference in render-board.js and render-units.js rather than
   assumed, since a field missed here is a battle-state corruption that only
   shows up after the manual is closed. */
const DIAGRAM_SCOPED_STATE = [
  'terrain', 'units', 'selectedUnitId', 'mode', 'aiSide', 'phase',
  'grassStyles', 'buildingStyles', 'craters', 'excludedRoadEdges', 'boardMode',
];

export function beginDiagramMode(targetCanvas, cellPx, scopedState){
  if(diagramScopeActive){
    throw new Error('beginDiagramMode: already inside a diagram scope (nested swap)');
  }
  diagramScopeActive = true;

  savedRenderScope = {
    canvas, cell: CELL, animHandle: animFrameHandle,
    state: Object.fromEntries(DIAGRAM_SCOPED_STATE.map(k => [k, state[k]])),
  };

  // Stop the loop BEFORE anything is swapped, so no frame can straddle it.
  if(animFrameHandle){ cancelAnimationFrame(animFrameHandle); animFrameHandle = null; }

  setRenderTarget(targetCanvas);
  if(cellPx) setCell(cellPx);
  if(scopedState){
    for(const k of DIAGRAM_SCOPED_STATE){
      if(k in scopedState) state[k] = scopedState[k];
    }
  }
}

export function endDiagramMode(){
  if(!diagramScopeActive) return;         // idempotent: safe in a finally block
  const saved = savedRenderScope;
  diagramScopeActive = false;
  savedRenderScope = null;

  setRenderTarget(saved.canvas);
  setCell(saved.cell);
  // Restores an empty or null baseline as happily as a live battle, which is
  // the pre-battle case: on the rank and orientation screens state.terrain and
  // state.units are not yet populated.
  for(const k of DIAGRAM_SCOPED_STATE) state[k] = saved.state[k];

  // Only restart the loop if it was running. Restarting it unconditionally
  // would spin a rAF on a screen that had none.
  if(saved.animHandle) ensureAnimationLoopRunning();
}

export function computeCellSize(){
  const wrap = document.getElementById('boardWrap');
  const viewportW = document.documentElement.clientWidth || window.innerWidth;
  const availW = Math.max(200, Math.min(wrap.clientWidth, viewportW) - 16);
  const availH = Math.max(200, wrap.clientHeight - 16);
  const byWidth = Math.floor(availW / COLS);
  const byHeight = Math.floor(availH / ROWS);
  return Math.max(22, Math.min(byWidth, byHeight, 68));
}

/* The board is sized from boardWrap's measured box, so it has to be measured
   AFTER the layout has settled. Calling sizeCanvas at the moment deployment
   finishes measures the box the wrapper had while the setup UI was still in it,
   which comes out too small; rotating the device forces a reflow and a
   re-measure, which is why turning the phone and back "fixed" it.

   A ResizeObserver removes the need to guess when layout is done: whenever the
   wrapper's box actually changes, the board is resized to match. That covers the
   end of deployment, rotation, the browser chrome hiding on scroll, and the
   split-screen and keyboard cases nobody has hit yet.

   Guarded against re-entry because sizeCanvas changes the canvas, which is
   inside the observed element, which would otherwise fire the observer again. */
let boardResizeObserver = null;
let resizingBoard = false;

export function observeBoardResize(){
  if(boardResizeObserver || typeof ResizeObserver === 'undefined') return;
  const wrap = document.getElementById('boardWrap');
  if(!wrap) return;
  boardResizeObserver = new ResizeObserver(()=>{
    if(resizingBoard) return;
    const want = computeCellSize();
    if(want === CELL) return;   // nothing to do; avoids a redraw on every scroll
    sizeCanvas();
  });
  boardResizeObserver.observe(wrap);
}

export function sizeCanvas(){
  setCell(computeCellSize());
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = (COLS*CELL) + 'px';
  canvas.style.height = (ROWS*CELL) + 'px';
  canvas.width = COLS*CELL*dpr;
  canvas.height = ROWS*CELL*dpr;
  ctx.setTransform(dpr,0,0,dpr,0,0);
  resetMapView(); // board dimensions just changed (new match, resize, mode switch) — any prior zoom/pan is stale
  resizingBoard = true;
  draw();
  // Released on the next frame: the observer fires asynchronously after this
  // function has already returned, so clearing it here would not prevent the
  // re-entry it exists to stop.
  requestAnimationFrame(()=>{ resizingBoard = false; });
}

/* =========================================================
   MAP ZOOM & PAN
   Pinch-to-zoom and single-finger pan, scoped to the board canvas only —
   #board has touch-action:none so the browser's own page-pinch-zoom never
   fires when a gesture starts here, leaving the rest of the page's native
   zoom untouched. Implemented as a CSS transform on the canvas element
   itself; every existing click/drag handler reads canvas.getBoundingClientRect(),
   which already reflects the transform automatically, so none of that code
   needed to change.
========================================================= */
export const MAP_MIN_ZOOM = 1, MAP_MAX_ZOOM = 3;
export let mapZoom = 1, mapPanX = 0, mapPanY = 0;
export let mapGesturePointers = new Map();
export let mapPinchStartDist = null, mapPinchStartZoom = 1;
export let mapPanStart = null;
// Finger drift, in CSS px, before a touch stops counting as a tap. 6px was well
// under any reasonable touch slop — a phone tap routinely wanders 8-10px between
// down and up, especially one-handed — so ordinary taps were being read as pans.
export const TAP_SLOP_PX = 12;
// Past this, treat it as a deliberate drag and suppress the tap even if the
// board could not move, because nobody drags 32px meaning to tap.
export const TAP_ABANDON_PX = 32;

export let mapGestureMoved = false; // true once the current gesture passed the tap threshold — the click handler checks this to avoid selecting a cell after a pan/pinch

// Read-and-clear, for the board click handler in ui-battle.js. It used to read
// mapGestureMoved and reset it directly; an imported binding is read-only under
// ES modules, so the write has to happen in the file that owns the variable.
export function consumeGestureFlag(){
  const moved = mapGestureMoved;
  mapGestureMoved = false;
  return moved;
}

export function resetMapView(){
  mapZoom = 1; mapPanX = 0; mapPanY = 0;
  mapGesturePointers.clear();
  mapPinchStartDist = null; mapPanStart = null; mapGestureMoved = false;
  applyMapTransform();
}

/* =========================================================
   BATTLE CAMERA

   During the AI's turn the board follows the action, so a player can see where
   the fighting is without hunting for it. Deliberately a REGION camera, not a
   unit camera: it frames the part of the map a Brigade is working in, at a
   modest zoom, rather than pushing right in on two units. Several fights
   usually happen inside one frame.

   It pans rather than cuts, with an ease-in-out so the movement reads as a
   camera being swung rather than the board teleporting. Because the AI moves
   Brigade by Brigade (orderAiUnitsForMove groups them, leftmost first) and
   cohesion keeps a Brigade's units together, this naturally works out at around
   three long pans per turn rather than one per unit.

   The player's own view is captured before the AI turn and restored after, so
   following the action never costs them where they were looking.
========================================================= */
export const CAMERA_ZOOM = 1.4;        // enough to frame a Brigade's area, not a duel
export const CAMERA_PAN_MS = 900;      // long enough to read as a pan, short enough not to drag
const CAMERA_PREF_KEY = 'fc:battleCamera';

export const CameraPref = {
  get enabled(){
    try { return localStorage.getItem(CAMERA_PREF_KEY) !== 'off'; } catch { return true; }
  },
  set enabled(v){
    try { localStorage.setItem(CAMERA_PREF_KEY, v ? 'on' : 'off'); } catch { /* private mode */ }
  },
};

let cameraRaf = null;
let playerView = null;   // the human's own zoom/pan, parked for the AI turn

// Ease-in-out cubic: accelerates away, coasts, settles. A linear pan reads as a
// mechanism moving; this reads as a camera operator.
function easeInOut(t){ return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3)/2; }

/* Centre the view on a board cell. Coordinates are in CELL space and converted
   here, so callers pass a square rather than pixels. */
export function cameraTo(cellX, cellY, opts = {}){
  if(!CameraPref.enabled) return;
  const wrap = document.getElementById('boardWrap');
  if(!wrap || !canvas) return;

  const zoom = opts.zoom != null ? opts.zoom : CAMERA_ZOOM;
  // The canvas is laid out at its CSS size; CELL is in canvas-internal units, so
  // scale between them before working out where the cell lands on screen.
  const scale = canvas.offsetWidth / (COLS * CELL);
  const targetX = (cellX + 0.5) * CELL * scale * zoom;
  const targetY = (sy(cellY) + 0.5) * CELL * scale * zoom;

  const fromX = mapPanX, fromY = mapPanY, fromZ = mapZoom;
  const toX = wrap.clientWidth/2 - targetX;
  const toY = wrap.clientHeight/2 - targetY;

  if(cameraRaf) cancelAnimationFrame(cameraRaf);
  const t0 = performance.now();
  const dur = opts.durationMs != null ? opts.durationMs : CAMERA_PAN_MS;

  function frame(now){
    const raw = Math.min(1, (now - t0) / dur);
    const t = easeInOut(raw);
    mapZoom = fromZ + (zoom - fromZ) * t;
    mapPanX = fromX + (toX - fromX) * t;
    mapPanY = fromY + (toY - fromY) * t;
    applyMapTransform();          // clamps, so the camera cannot swing off-board
    cameraRaf = raw < 1 ? requestAnimationFrame(frame) : null;
  }
  cameraRaf = requestAnimationFrame(frame);
}

/* Frame a group of units rather than a point: their centroid, so a Brigade
   spread over a few squares is centred on its middle. */
export function cameraToUnits(units, opts){
  const live = (units || []).filter(u => u && !u.removed);
  if(!live.length) return;
  const cx = live.reduce((s,u)=>s+u.x,0) / live.length;
  const cy = live.reduce((s,u)=>s+u.y,0) / live.length;
  cameraTo(cx, cy, opts);
}

/* Park the human's own view before the AI takes over, and give it back after.
   Following the action should never cost the player where they were looking. */
export function cameraParkPlayerView(){
  if(!CameraPref.enabled) return;
  if(playerView) return;                       // already parked; do not overwrite
  playerView = { zoom: mapZoom, x: mapPanX, y: mapPanY };
}

export function cameraRestorePlayerView(){
  const v = playerView;
  playerView = null;
  if(!v || !CameraPref.enabled) return;
  if(cameraRaf) cancelAnimationFrame(cameraRaf);
  const fromX = mapPanX, fromY = mapPanY, fromZ = mapZoom;
  const t0 = performance.now();
  function frame(now){
    const raw = Math.min(1, (now - t0) / CAMERA_PAN_MS);
    const t = easeInOut(raw);
    mapZoom = fromZ + (v.zoom - fromZ) * t;
    mapPanX = fromX + (v.x - fromX) * t;
    mapPanY = fromY + (v.y - fromY) * t;
    applyMapTransform();
    cameraRaf = raw < 1 ? requestAnimationFrame(frame) : null;
  }
  cameraRaf = requestAnimationFrame(frame);
}

export function clampMapPan(){
  const wrap = document.getElementById('boardWrap');
  const scaledW = canvas.offsetWidth * mapZoom, scaledH = canvas.offsetHeight * mapZoom;
  const minX = Math.min(0, wrap.clientWidth - scaledW), maxX = 0;
  const minY = Math.min(0, wrap.clientHeight - scaledH), maxY = 0;
  mapPanX = Math.max(minX, Math.min(maxX, mapPanX));
  mapPanY = Math.max(minY, Math.min(maxY, mapPanY));
}

export function applyMapTransform(){
  clampMapPan();
  canvas.style.transform = `translate(${mapPanX}px, ${mapPanY}px) scale(${mapZoom})`;
}

canvas.addEventListener('pointerdown', (e)=>{
  try { canvas.setPointerCapture(e.pointerId); } catch(err) { /* not always available/needed — gesture tracking below still works without it */ }
  mapGesturePointers.set(e.pointerId, {x:e.clientX, y:e.clientY});
  mapGestureMoved = false;
  if(mapGesturePointers.size===1){
    mapPanStart = {x:e.clientX, y:e.clientY, panX:mapPanX, panY:mapPanY};
  } else if(mapGesturePointers.size===2){
    const pts = [...mapGesturePointers.values()];
    mapPinchStartDist = Math.hypot(pts[0].x-pts[1].x, pts[0].y-pts[1].y);
    mapPinchStartZoom = mapZoom;
    mapPanStart = null; // a second finger landed — hand off from pan to pinch
  }
});

canvas.addEventListener('pointermove', (e)=>{
  if(!mapGesturePointers.has(e.pointerId)) return;
  mapGesturePointers.set(e.pointerId, {x:e.clientX, y:e.clientY});
  if(mapGesturePointers.size===2 && mapPinchStartDist){
    const pts = [...mapGesturePointers.values()];
    const dist = Math.hypot(pts[0].x-pts[1].x, pts[0].y-pts[1].y);
    mapZoom = Math.max(MAP_MIN_ZOOM, Math.min(MAP_MAX_ZOOM, mapPinchStartZoom * (dist/mapPinchStartDist)));
    mapGestureMoved = true;
    applyMapTransform();
  } else if(mapGesturePointers.size===1 && mapPanStart){
    const dx = e.clientX-mapPanStart.x, dy = e.clientY-mapPanStart.y;
    const drift = Math.hypot(dx,dy);
    if(drift > TAP_SLOP_PX){
      // Suppress the tap only if the board ACTUALLY moved. The old code set the
      // flag the moment the finger passed 6px, before clampMapPan had its say —
      // and at the default zoom the canvas fits its container, so minX/maxX both
      // collapse to 0 and the pan is pinned straight back to zero. The board
      // stayed put AND the tap was swallowed: tap a unit, nothing happens, tap
      // again, nothing happens. Comparing before and after the clamp means a
      // gesture that changed nothing on screen no longer eats the tap.
      const beforeX = mapPanX, beforeY = mapPanY;
      mapPanX = mapPanStart.panX + dx;
      mapPanY = mapPanStart.panY + dy;
      applyMapTransform();
      if(mapPanX !== beforeX || mapPanY !== beforeY) mapGestureMoved = true;
      // A drag this long was never a tap, whatever the clamp did with it.
      else if(drift > TAP_ABANDON_PX) mapGestureMoved = true;
    }
  }
});

export function mapPointerEnd(e){
  mapGesturePointers.delete(e.pointerId);
  if(mapGesturePointers.size<2) mapPinchStartDist = null;
  if(mapGesturePointers.size===0) mapPanStart = null;
}
canvas.addEventListener('pointerup', mapPointerEnd);
canvas.addEventListener('pointercancel', mapPointerEnd);
canvas.addEventListener('dblclick', resetMapView); // quick reset for anyone who finds pinch fiddly

export function terrainColor(key){
  return { OPEN: '#3c4a34', FIELD:'#8a7d3f', PLOUGHED_FIELD:'#b89a3f', ROAD:'#8a7350', WOODS:'#26361f', BUILDING:'#6b5847', HILL:'#5a5636' }[key];
}

// A faint, warm paper-grain texture, generated once and reused as a repeating
// pattern — gives the map a physical, aged-paper feel instead of a flat
// digital fill, at negligible per-frame cost since it's a single pattern fill.
export let PARCHMENT_TEXTURE_CACHE = null;
export function getParchmentTexturePattern(){
  if(PARCHMENT_TEXTURE_CACHE) return PARCHMENT_TEXTURE_CACHE;
  const tile = document.createElement('canvas');
  tile.width = 96; tile.height = 96;
  const tctx = tile.getContext('2d');
  const imgData = tctx.createImageData(96,96);
  for(let i=0;i<imgData.data.length;i+=4){
    const v = 210 + Math.floor((Math.random()-0.5)*70);
    imgData.data[i] = v; imgData.data[i+1] = v-6; imgData.data[i+2] = v-18; imgData.data[i+3] = 12;
  }
  tctx.putImageData(imgData,0,0);
  PARCHMENT_TEXTURE_CACHE = ctx.createPattern(tile, 'repeat');
  return PARCHMENT_TEXTURE_CACHE;
}

// Small hand-drawn map-symbol glyphs, in the ink/brass palette, standing in
// for the old emoji icons (which render inconsistently across platforms and
// read as a placeholder rather than a deliberate mark on an aged map).
export function drawHillGlyph(cx, cy, cell){
  // A soft double-peak contour, low-opacity — Hill already carries its own
  // fill colour and a rocky border around the whole landform, so this is a
  // light accent rather than the primary way hills read.
  ctx.save();
  ctx.translate(cx, cy);
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = '#e9e4d6';
  ctx.lineWidth = Math.max(1, cell*0.035);
  ctx.lineJoin = 'round';
  const w = cell*0.34, h = cell*0.22;
  ctx.beginPath();
  ctx.moveTo(-w, h*0.4);
  ctx.lineTo(-w*0.28, -h*0.7);
  ctx.lineTo(-w*0.02, -h*0.15);
  ctx.lineTo(w*0.32, -h);
  ctx.lineTo(w, h*0.4);
  ctx.stroke();
  ctx.restore();
}

/* =========================================================
   TERRAIN RENDERING HELPERS
   The map is meant to read as geomorphic and analogue, not a rigid
   grid — the grid only matters for movement/LOS/combat range. These
   helpers group same-type terrain into connected regions and render
   them as one organic shape rather than a tile-by-tile stamp.
========================================================= */
export function findConnectedRegions(terrain, key){
  const h = terrain.length, w = terrain[0].length;
  const regions = [];
  const visited = new Set();
  for(let y=0;y<h;y++){
    for(let x=0;x<w;x++){
      if(terrain[y][x]!==key) continue;
      const k = x+','+y;
      if(visited.has(k)) continue;
      const region = [];
      const stack = [[x,y]];
      visited.add(k);
      while(stack.length){
        const [cx,cy] = stack.pop();
        region.push([cx,cy]);
        for(const [dx,dy] of [[0,-1],[0,1],[-1,0],[1,0]]){
          const nx=cx+dx, ny=cy+dy;
          if(nx<0||nx>=w||ny<0||ny>=h) continue;
          const nk = nx+','+ny;
          if(visited.has(nk) || terrain[ny][nx]!==key) continue;
          visited.add(nk);
          stack.push([nx,ny]);
        }
      }
      regions.push(region);
    }
  }
  return regions;
}
export function seededWobble(seed){
  const v = Math.sin(seed*12.9898)*43758.5453;
  return (v - Math.floor(v)) - 0.5; // -0.5..0.5
}
export function seededRand(seed){ return seededWobble(seed) + 0.5; } // 0..1, same generator
// Deterministic per-cell pick from the 6 Forest tile styles — each Woods cell
// independently "rolls" its own style, but stays stable across redraws since
// it's a function of the cell's own coordinates rather than stored RNG state.
// How far the Woods art is drawn beyond its cell so the treetops overhang
// the tile above (see the drawing loop for why the art needs it).
export const WOODS_OVERSCAN = 1.3;
export function woodsStyleIndex(x,y){
  return 1 + Math.floor(seededRand(x*97+y*131+5) * 6);
}
// Same idea for Hill — each cell independently picks one of 6 hill-mound
// tiles. Unlike Woods this trades away the old connected-region outline that
// made a hill mass read as one landform (each tile is a complete standalone
// mound, not a modular hillside chunk) — a deliberate trade Matthew chose
// for richer art. Different seed offsets from woodsStyleIndex so the two
// don't correlate on cells that happen to share coordinates.
export function hillStyleIndex(x,y){
  return 1 + Math.floor(seededRand(x*151+y*211+37) * 6);
}

// A faint repeating grass-blade texture for Open/Hill ground — cheap (one
// pattern fill covering the whole board) rather than per-tile stroke calls,
// which matters once Grand Strategy's 400-cell board is in play.
export let GRASS_TEXTURE_CACHE = null;
export function getGrassTexturePattern(){
  if(GRASS_TEXTURE_CACHE) return GRASS_TEXTURE_CACHE;
  const tile = document.createElement('canvas');
  const size = 72;
  tile.width = size; tile.height = size;
  const tctx = tile.getContext('2d');
  for(let i=0;i<26;i++){
    const bx = seededRand(i*7+1)*size, by = seededRand(i*13+2)*size;
    const len = 4 + seededRand(i*19+3)*6;
    const lean = (seededWobble(i*23+4))*len*0.7;
    const dark = seededWobble(i*29+5) > 0;
    tctx.strokeStyle = dark ? 'rgba(18,24,14,0.16)' : 'rgba(150,165,118,0.14)';
    tctx.lineWidth = 1.1;
    tctx.beginPath();
    tctx.moveTo(bx, by);
    tctx.quadraticCurveTo(bx+lean*0.5, by-len*0.6, bx+lean, by-len);
    tctx.stroke();
  }
  GRASS_TEXTURE_CACHE = ctx.createPattern(tile, 'repeat');
  return GRASS_TEXTURE_CACHE;
}

export function roundedBlobPath(ctx, x, y, w, h, r){
  ctx.beginPath();
  ctx.moveTo(x+r,y);
  ctx.arcTo(x+w,y,x+w,y+h,r);
  ctx.arcTo(x+w,y+h,x,y+h,r);
  ctx.arcTo(x,y+h,x,y,r);
  ctx.arcTo(x,y,x+w,y,r);
  ctx.closePath();
}

// A cluster of small overlapping canopy shapes, standing in for a single flat
// tree-blob — a few individual tree crowns rather than one solid mass, in
// varied green tones for depth. Seeded per cell so it's stable across redraws.
export function drawTreeCanopyCluster(cx, cy, cellSize, seed){
  const shades = ['#33472a','#243318','#3d5230'];
  const n = 4 + Math.floor(seededRand(seed*3+1)*2); // 4-5 canopies
  for(let i=0;i<n;i++){
    const ang = seededRand(seed*11+i*17+1) * Math.PI*2;
    const dist = seededRand(seed*13+i*19+2) * cellSize*0.28;
    const px = cx + Math.cos(ang)*dist, py = cy + Math.sin(ang)*dist*0.8;
    const r = cellSize*(0.16 + seededRand(seed*7+i*23+3)*0.10);
    ctx.fillStyle = shades[i % shades.length];
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI*2);
    ctx.fill();
  }
}

// A loose cluster of small varied cottages standing in for one uniform
// building icon — a hamlet rather than a single house, roof tones and sizes
// jittered per building so no two tiles look identical. Base positions are
// fixed per cluster size (not fully random) so houses reliably separate
// rather than landing on top of each other, with a little seeded jitter on
// top for an organic, not-quite-uniform arrangement.
export function drawBuildingCluster(cx, cy, cellSize, seed){
  const roofColors = ['#8a4f36','#6b5847','#7a6248'];
  const n = 2 + Math.floor(seededRand(seed*5+1)*2); // 2-3 houses
  const basePositions = n===2
    ? [[-0.24,0.08],[0.24,-0.12]]
    : [[-0.28,0.16],[0.26,0.12],[0.02,-0.26]];
  for(let i=0;i<n;i++){
    const [bx,by] = basePositions[i];
    const jx = seededWobble(seed*9+i*29+1) * cellSize*0.06;
    const jy = seededWobble(seed*17+i*31+2) * cellSize*0.06;
    const px = cx + bx*cellSize + jx, py = cy + by*cellSize + jy;
    const scale = 0.60 + seededRand(seed*21+i*37+3)*0.24;
    const w = cellSize*0.30*scale, hWall = cellSize*0.20*scale, hRoof = cellSize*0.18*scale;
    ctx.save();
    ctx.translate(px, py);
    ctx.fillStyle = '#e9e4d6';
    ctx.globalAlpha = 0.9;
    ctx.fillRect(-w*0.55, -hWall*0.05, w*1.1, hWall*1.05);
    ctx.fillStyle = roofColors[(i+Math.floor(seed))%roofColors.length];
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.moveTo(-w*0.68, -hWall*0.05);
    ctx.lineTo(0, -hRoof-hWall*0.05);
    ctx.lineTo(w*0.68, -hWall*0.05);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#3a2f22';
    ctx.fillRect(-w*0.12, hWall*0.35, w*0.24, hWall*0.65);
    ctx.restore();
  }
}

export function draw(){
  const debugPanel = document.getElementById('aiDebugPanel');
  if(debugPanel && debugPanel.style.display==='block') renderAiDebugPanel();
  const flip = screenFlipActive();
  ctx.clearRect(0,0,canvas.width,canvas.height);
  const terrain = state.terrain;

  // base fill — road cells fill as open ground; Hill matches Open (elevation is
  // shown by its border, not a colour change); the ploughed-field/woods passes
  // paint over their own cells next. Kept as a fallback fill even for Open
  // cells (drawn over next, once the grass tile images are ready) so there's
  // no flash of blank canvas while those assets are still decoding.
  for(let y=0;y<ROWS;y++){
    const sy_ = sy(y);
    for(let x=0;x<COLS;x++){
      const key = terrain[y][x];
      ctx.fillStyle = terrainColor(key==='ROAD' ? 'OPEN' : key);
      ctx.fillRect(x*CELL,sy_*CELL,CELL,CELL);
    }
  }

  // Open ground: each cell independently shows one of 6 grassland tile
  // styles (assignGrassStyles, computed once per terrain generation — see
  // ui-menus.js) rather than a flat fill, patched together so same-style
  // cells clump into small "fields" instead of scattering as noise. These
  // tiles already fill their full square with real grass/flower detail, so
  // Road keeps the older flat-colour-plus-blade-texture treatment below
  // rather than doubling up on top of this.
  if(state.grassStyles){
    for(let y=0;y<ROWS;y++){
      const sy_ = sy(y);
      for(let x=0;x<COLS;x++){
        // BUILDING as well as OPEN — see assignGrassStyles. Drawn before the
        // hamlet pass below, so the village plate lands on real grassland
        // instead of the flat fallback fill.
        if(terrain[y][x]!=='OPEN' && terrain[y][x]!=='BUILDING') continue;
        const style = state.grassStyles[y][x];
        if(!style) continue;
        const img = UNIT_IMAGES['grass_'+style];
        if(img && img.complete && img.naturalWidth>0){
          ctx.drawImage(img, x*CELL, sy_*CELL, CELL, CELL);
        }
      }
    }
  }

  // Grass texture — a repeating blade pattern clipped to Road cells only
  // now; Open and Hill ground get their detail from the tile images above.
  ctx.save();
  ctx.beginPath();
  for(let y=0;y<ROWS;y++){
    for(let x=0;x<COLS;x++){
      const key = terrain[y][x];
      if(key==='ROAD') ctx.rect(x*CELL, sy(y)*CELL, CELL, CELL);
    }
  }
  ctx.clip();
  ctx.fillStyle = getGrassTexturePattern();
  ctx.fillRect(0, 0, COLS*CELL, ROWS*CELL);
  ctx.restore();

  // Ploughed fields: wheat yellow with furrow lines along the field's long axis,
  // computed per contiguous group so a whole field reads as one shape.
  const ploughRegions = findConnectedRegions(terrain, 'PLOUGHED_FIELD');
  for(const region of ploughRegions){
    ctx.save();
    ctx.beginPath();
    for(const [x,y] of region) ctx.rect(x*CELL, sy(y)*CELL, CELL, CELL);
    ctx.clip();
    const screenYs = region.map(([,y])=>sy(y));
    const minX=Math.min(...region.map(c=>c[0])), maxX=Math.max(...region.map(c=>c[0]));
    const minSY=Math.min(...screenYs), maxSY=Math.max(...screenYs);
    const widthPx = (maxX-minX+1)*CELL, heightPx = (maxSY-minSY+1)*CELL;
    const horizontal = widthPx >= heightPx;
    ctx.strokeStyle = 'rgba(120,88,32,0.55)';
    ctx.lineWidth = Math.max(1, CELL*0.045);
    const spacing = CELL*0.24;
    if(horizontal){
      for(let ly=minSY*CELL; ly<(maxSY+1)*CELL; ly+=spacing){
        ctx.beginPath(); ctx.moveTo(minX*CELL,ly); ctx.lineTo((maxX+1)*CELL,ly); ctx.stroke();
      }
    } else {
      for(let lx=minX*CELL; lx<(maxX+1)*CELL; lx+=spacing){
        ctx.beginPath(); ctx.moveTo(lx,minSY*CELL); ctx.lineTo(lx,(maxSY+1)*CELL); ctx.stroke();
      }
    }
    ctx.restore();
  }

  // Roads: tile art for genuine 2+ way connections (straight, corner, T,
  // cross), matching whichever cardinal directions are connected on SCREEN —
  // not logical grid direction, since the board can flip vertically for the
  // human player's side (screenFlipActive) while the tile art itself has a
  // fixed visual orientation. X never flips in this game, only Y. A cell
  // with 0 or 1 connections (an isolated stub, or a genuine dead-end from
  // excludedRoadEdges) has no matching tile, so it just shows the grass
  // backdrop with nothing drawn over it.
  const excluded = state.excludedRoadEdges || new Set();
  const roadConn = {};
  for(let y=0;y<ROWS;y++) for(let x=0;x<COLS;x++){
    if(terrain[y][x]!=='ROAD') continue;
    const list = [];
    for(const [dx,dy] of [[0,-1],[0,1],[-1,0],[1,0]]){
      const nx=x+dx, ny=y+dy;
      if(!inBounds(nx,ny) || terrain[ny][nx]!=='ROAD') continue;
      const ekey = (x<nx || (x===nx && y<ny)) ? `${x},${y}-${nx},${ny}` : `${nx},${ny}-${x},${y}`;
      if(excluded.has(ekey)) continue;
      list.push({x:nx,y:ny});
    }
    roadConn[x+','+y] = list;
  }
  // For choosing tile ART only, a road running off the edge of the board counts
  // as a connection. The two boards are laid side by side in play, so a road
  // that reaches the edge continues onto its neighbour — drawing it as a stub
  // that stops short of the edge is what made joins look broken. Deliberately
  // kept separate from roadConn, which stays strictly in-bounds because the
  // stroke fallback and roadAnchor below both need real coordinates to draw to.
  //
  // Off-board neighbours are expressed as out-of-range coordinates on purpose:
  // sy() maps y=-1 to ROWS when the board is flipped, so an edge that is "up"
  // in grid space correctly becomes "down" on screen without a special case.
  function roadArtDirs(x, y, list){
    const dirs = roadScreenDirs(x, y, list);
    const sy0 = sy(y);
    for(const [dx,dy] of [[0,-1],[0,1],[-1,0],[1,0]]){
      const nx = x+dx, ny = y+dy;
      if(inBounds(nx,ny)) continue;          // real neighbour, already handled
      if(nx < x) dirs.left = true;
      else if(nx > x) dirs.right = true;
      else if(sy(ny) < sy0) dirs.up = true;
      else dirs.down = true;
    }
    return dirs;
  }
  function roadScreenDirs(x, y, list){
    const dirs = { up:false, down:false, left:false, right:false };
    const sy0 = sy(y);
    for(const n of list){
      if(n.x < x) dirs.left = true;
      else if(n.x > x) dirs.right = true;
      else if(sy(n.y) < sy0) dirs.up = true;
      else if(sy(n.y) > sy0) dirs.down = true;
    }
    return dirs;
  }
  function roadTileKey(dirs){
    const count = (dirs.up?1:0)+(dirs.down?1:0)+(dirs.left?1:0)+(dirs.right?1:0);
    if(count===4) return 'road_cross';
    if(count===3){
      if(!dirs.up) return 'road_t_missing_up';
      if(!dirs.down) return 'road_t_missing_down';
      if(!dirs.left) return 'road_t_missing_left';
      return 'road_t_missing_right';
    }
    if(count===2){
      if(dirs.up && dirs.down) return 'road_straight_v';
      if(dirs.left && dirs.right) return 'road_straight_h';
      if(dirs.up && dirs.right) return 'road_corner_tr';
      if(dirs.down && dirs.right) return 'road_corner_br';
      if(dirs.down && dirs.left) return 'road_corner_bl';
      if(dirs.up && dirs.left) return 'road_corner_tl';
    }
    // A genuine dead end: the road arrives from one side and stops. Named for
    // the direction the road comes FROM, matching the T tiles' convention of
    // describing the art rather than the topology.
    if(count===1){
      if(dirs.up) return 'road_end_up';
      if(dirs.down) return 'road_end_down';
      if(dirs.left) return 'road_end_left';
      return 'road_end_right';
    }
    return null;
  }
  for(let y=0;y<ROWS;y++){
    const sy_ = sy(y);
    for(let x=0;x<COLS;x++){
      if(terrain[y][x]!=='ROAD') continue;
      const list = roadConn[x+','+y] || [];
      const key = roadTileKey(roadArtDirs(x, y, list));
      if(!key){
        // 0 or 1 connections — no matching tile art, so this cell would
        // otherwise sit on the plain dark Open-terrain fallback fill with
        // nothing to soften it, unlike an actual Open cell (which gets a
        // proper grass tile). Give it the same grass backdrop Woods/Hill
        // use for their own per-cell art — a deterministic hash, not the
        // constrained patchwork algorithm, since this is just a rare
        // fallback backdrop, not a real "grass square" needing that
        // clustering behaviour. Nothing is drawn over it.
        const gimg = UNIT_IMAGES['grass_'+woodsStyleIndex(x,y)];
        if(gimg && gimg.complete && gimg.naturalWidth>0){
          ctx.drawImage(gimg, x*CELL, sy_*CELL, CELL, CELL);
        }
        continue;
      }
      const img = UNIT_IMAGES[key];
      if(img && img.complete && img.naturalWidth>0){
        ctx.drawImage(img, x*CELL, sy_*CELL, CELL, CELL);
      }
    }
  }
  /* ---------------------------------------------------------------------
     RAISED FEATURES — one pass, ordered by SCREEN ROW.

     Hill, Building and Woods all draw at WOODS_OVERSCAN: 1.3 cells wide,
     1.69 tall, bottom-anchored, so each bleeds 15% of a cell to either side
     and 0.69 of a cell upward over whatever is behind it.

     They used to be three separate passes, run in type order with Ploughed,
     the road texture and the road tile art interleaved between them. That
     ordering has nothing to do with what is in front of what, so it produced
     two visible faults once the tiles started bleeding:

       - a Building on row 2 painted over a Hill on row 10, because the
         Building pass simply ran later than the Hill pass
       - Roads and Ploughed fields, running after Buildings, painted their
         full CELL x CELL square straight over any village bleeding into
         them, cutting a hard rectangular seam across the artwork

     The second is why enlarging the hamlets appeared to fix some tiles and
     not others: a village surrounded by Open grass looked right, because
     grass draws before it. One touching a road or a field got a square
     stamped over its corner.

     Sorting by sy(y) rather than y is load-bearing. screenFlipActive()
     inverts the board for the second player, and sorting on the raw row
     would invert the entire depth order for them — everything in front
     drawn behind — which is a hard fault to spot because it only appears on
     a flipped board.

     Ground passes (base fill, grass, road texture, Ploughed, road art) all
     draw exactly CELL x CELL and stay where they are, above. Only these
     three bleed, so only these three need ordering.
  --------------------------------------------------------------------- */
  const raisedFeatures = [];
  for(let y=0;y<ROWS;y++){
    for(let x=0;x<COLS;x++){
      const key = terrain[y][x];
      if(key==='HILL' || key==='BUILDING' || key==='WOODS'){
        raisedFeatures.push({ x, y, key, sy_: sy(y) });
      }
    }
  }
  // Lower screen row last, so it lands on top of anything behind it. The x
  // tiebreak only keeps the order deterministic within a row; nothing in a
  // single row can overlap anything else in that row by more than the 15%
  // side bleed, so it has no visual consequence.
  raisedFeatures.sort((a,b) => a.sy_ - b.sy_ || a.x - b.x);

  for(const f of raisedFeatures){
    const { x, y, key, sy_ } = f;

    if(key === 'HILL'){
      const img = UNIT_IMAGES['hill_'+hillStyleIndex(x,y)];
      if(img && img.complete && img.naturalWidth>0){
        // The source art fits its whole composition (ground platform plus
        // trees) inside its bottom 1000x1000 square, leaving the 300px
        // overflow band empty — so drawn at exactly one cell wide the trees
        // stop dead at the cell's top edge and never overlap the tile above.
        const w = CELL*WOODS_OVERSCAN;
        const h = w*(img.naturalHeight/img.naturalWidth);
        ctx.drawImage(img, x*CELL-(w-CELL)/2, sy_*CELL+CELL-h, w, h);
      }

    } else if(key === 'BUILDING'){
      const style = state.buildingStyles && state.buildingStyles[y][x];
      if(!style) continue;
      const img = UNIT_IMAGES['building_'+style];
      if(img && img.complete && img.naturalWidth>0){
        // Drawn at WOODS_OVERSCAN like Hill and Woods. It used to draw at
        // exactly one cell wide while every other feature drew at 1.3, which
        // rendered hamlets at 77% the size of the terrain beside them. The old
        // height clamp went with it: at one cell wide min(CELL*1.3, w*ratio)
        // was a no-op because the art is exactly 1.3:1, but at 1.3 cells wide
        // the natural height is 1.69 cells and the clamp would have squashed
        // every hamlet by 23% instead of enlarging it.
        const w = CELL*WOODS_OVERSCAN;
        const h = w*(img.naturalHeight/img.naturalWidth);
        ctx.drawImage(img, x*CELL-(w-CELL)/2, sy_*CELL+CELL-h, w, h);
      }

    } else { // WOODS
      const imgKey = 'forest_notroops_' + woodsStyleIndex(x,y);
      const img = UNIT_IMAGES[imgKey];
      if(img && img.complete && img.naturalWidth>0){
        // Lay a grass tile down first. The forest art's own base doesn't quite
        // reach the cell's top corners (the treeline curves inward there), and
        // unlike an Open cell a Woods cell otherwise has nothing underneath —
        // so those corners showed the plain dark fallback fill. Confined to
        // this cell, so it cannot disturb anything already drawn beside it.
        const gimg = UNIT_IMAGES['grass_'+woodsStyleIndex(x,y)];
        if(gimg && gimg.complete && gimg.naturalWidth>0){
          ctx.drawImage(gimg, x*CELL, sy_*CELL, CELL, CELL);
        }
        const w = CELL*WOODS_OVERSCAN;
        const h = w*(img.naturalHeight/img.naturalWidth);
        ctx.drawImage(img, x*CELL-(w-CELL)/2, sy_*CELL+CELL-h, w, h);
      } else {
        // fallback while the image decodes: the old flat fill, no canopy detail
        ctx.fillStyle = terrainColor('WOODS');
        ctx.fillRect(x*CELL, sy_*CELL, CELL, CELL);
      }
    }
  }

  // Road and building connections are entirely tile art now — the old
  // hand-drawn brown strokes (per-edge curved road lines, the dot for an
  // isolated road cell, and the building-to-road connector lines) have all
  // been removed. Road cells that don't match one of the 11 tile patterns
  // (an isolated stub or a genuine dead-end from excludedRoadEdges) just
  // show the grass backdrop laid down above, with no stroke over it.

  // craters: every square Artillery has hit this match, above terrain, below units
  for(const c of state.craters){
    const cx = c.x*CELL+CELL/2, cy = sy(c.y)*CELL+CELL/2;
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = '#1a1710';
    ctx.beginPath(); ctx.arc(cx, cy, CELL*0.20, 0, Math.PI*2); ctx.fill();
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = '#3a332a';
    ctx.beginPath(); ctx.arc(cx, cy, CELL*0.30, 0, Math.PI*2); ctx.fill();
    ctx.restore();
  }

  // grid — always visible during deployment (placing units needs the whole
  // board legible); during battle it stays hidden until a unit is selected,
  // then only draws on the cells that unit can actually act on (so the board
  // reads as a clean map rather than permanent graph paper). Move squares
  // keep the standard gold, squares that would trigger a fight (a target or
  // a charge's resulting contact) draw in red so the consequence of tapping
  // that square is visible before you commit to it.
  const showFullGrid = state.phase==='deploy';
  const showSelectionGrid = !showFullGrid && state.selectedUnitId && highlightCells && highlightCells.length;
  if(showFullGrid){
    ctx.strokeStyle = 'rgba(184,147,79,0.18)';
    ctx.lineWidth = 1;
    for(let x=0;x<=COLS;x++){ ctx.beginPath(); ctx.moveTo(x*CELL,0); ctx.lineTo(x*CELL,ROWS*CELL); ctx.stroke(); }
    for(let y=0;y<=ROWS;y++){ ctx.beginPath(); ctx.moveTo(0,y*CELL); ctx.lineTo(COLS*CELL,y*CELL); ctx.stroke(); }
  } else if(showSelectionGrid){
    /* A double stroke, dark under light. A single light outline disappears
       against the pale parts of the grass art and a single dark one disappears
       into woods and hedges, so each is drawn over the other: whichever the
       terrain swallows, the other survives. The highlight then never depends on
       what happens to be underneath it. */
    for(const c of highlightCells){
      const hx = c.x*CELL, hy = sy(c.y)*CELL;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(24,20,14,0.55)';
      ctx.strokeRect(hx+1.5, hy+1.5, CELL-3, CELL-3);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = c.kind==='move' ? 'rgba(253,246,227,0.95)' : 'rgba(255,150,140,0.95)';
      ctx.strokeRect(hx+1.5, hy+1.5, CELL-3, CELL-3);
    }
    ctx.lineWidth = 1;
  }

  // seam between the two physical boards — only relevant while still picking
  // orientation; once that's settled and deployment begins, the seam is no
  // longer meaningful and just clutters the board.
  if(state.phase==='orientation'){
    ctx.strokeStyle = 'rgba(233,228,214,0.35)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6,4]);
    ctx.beginPath(); ctx.moveTo(HALF_COLS*CELL,0); ctx.lineTo(HALF_COLS*CELL,ROWS*CELL); ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
  }

  // deployment zone tint during deploy phase (Blue = top rows, Red = bottom rows;
  // depth is 2 for a standard match, 3 for Grand Strategy — see attemptDeployAt)
  if(state.phase==='deploy'){
    const deployRows = state.boardMode==='grand' ? 3 : 2;
    const blueTop = Math.min(sy(0), sy(deployRows-1));
    ctx.fillStyle = 'rgba(46,69,102,0.14)';
    ctx.fillRect(0, blueTop*CELL, COLS*CELL, deployRows*CELL);
    const redTop = Math.min(sy(ROWS-deployRows), sy(ROWS-1));
    ctx.fillStyle = 'rgba(163,64,58,0.10)';
    ctx.fillRect(0, redTop*CELL, COLS*CELL, deployRows*CELL);
  }

  /* Movement and target highlights.

     The move wash was gold rgba(184,147,79,0.35) over grass whose mean colour is
     #7a7816. Both are yellow-green, giving 1.18:1 contrast, which is invisible.
     Raising the alpha barely helped, because the HUE was the problem rather than
     the strength: gold at 60% still only reaches 1.34:1. Pale parchment reaches
     2.1:1 against the same grass while staying in the same family as the rest of
     the chrome.

     A corner tick is drawn as well. On a busy board an edge-to-edge wash gets
     lost in the tile art, but four short marks at the corners of a square are a
     SHAPE, and the eye picks a shape out regardless of what is underneath it. */
  if(highlightCells && highlightCells.length){
    for(const c of highlightCells){
      const hx = c.x*CELL, hy = sy(c.y)*CELL;
      ctx.fillStyle = c.kind==='move' ? 'rgba(253,246,227,0.30)'
        : c.kind==='charge' ? 'rgba(224,110,30,0.55)' : 'rgba(181,69,63,0.50)';
      ctx.fillRect(hx+3, hy+3, CELL-6, CELL-6);

      const tick = Math.max(5, CELL*0.18);
      ctx.strokeStyle = c.kind==='move' ? 'rgba(253,246,227,0.95)' : 'rgba(255,180,170,0.95)';
      ctx.lineWidth = Math.max(2, CELL*0.045);
      ctx.beginPath();
      for(const [cx,cy,dx,dy] of [[hx+4,hy+4,1,1],[hx+CELL-4,hy+4,-1,1],
                                  [hx+4,hy+CELL-4,1,-1],[hx+CELL-4,hy+CELL-4,-1,-1]]){
        ctx.moveTo(cx+dx*tick, cy); ctx.lineTo(cx, cy); ctx.lineTo(cx, cy+dy*tick);
      }
      ctx.stroke();
      ctx.lineWidth = 1;
    }
  }

  // drag-and-drop hover cell during deployment
  if(dragState && dragState.dragging && dragState.hoverCell){
    ctx.fillStyle = 'rgba(184,147,79,0.5)';
    ctx.fillRect(dragState.hoverCell.x*CELL+2, sy(dragState.hoverCell.y)*CELL+2, CELL-4, CELL-4);
    ctx.strokeStyle = 'rgba(253,246,227,0.9)'; ctx.lineWidth=2;
    ctx.strokeRect(dragState.hoverCell.x*CELL+2, sy(dragState.hoverCell.y)*CELL+2, CELL-4, CELL-4);
  }

  // who's firing/fighting whom — fades out on its own after a couple of seconds
  if(activeActionLine && Date.now() < activeActionLine.expiresAt){
    const ln = activeActionLine;
    const fx = ln.fromX*CELL+CELL/2, fy = sy(ln.fromY)*CELL+CELL/2;
    const tx = ln.toX*CELL+CELL/2, ty = sy(ln.toY)*CELL+CELL/2;
    const remaining = (ln.expiresAt - Date.now()) / 3800;
    const alpha = Math.max(0, Math.min(1, remaining*2.2)); // hold steady, then fade in the last stretch
    ctx.save();
    ctx.strokeStyle = ln.color;
    ctx.globalAlpha = alpha;
    if(ln.dashed){
      // Artillery firing line specifically — much bolder than the plain fight
      // line so it reads clearly across the board, not just up close.
      ctx.lineWidth = Math.max(5, CELL*0.16);
      ctx.setLineDash([CELL*0.18, CELL*0.09]);
    } else {
      ctx.lineWidth = Math.max(2, CELL*0.06);
    }
    ctx.beginPath(); ctx.moveTo(fx,fy); ctx.lineTo(tx,ty); ctx.stroke();
    ctx.setLineDash([]);
    // arrowhead at the target end
    const ang = Math.atan2(ty-fy, tx-fx);
    const ah = CELL*0.16;
    ctx.beginPath();
    ctx.moveTo(tx,ty);
    ctx.lineTo(tx-ah*Math.cos(ang-Math.PI/7), ty-ah*Math.sin(ang-Math.PI/7));
    ctx.lineTo(tx-ah*Math.cos(ang+Math.PI/7), ty-ah*Math.sin(ang+Math.PI/7));
    ctx.closePath();
    ctx.fillStyle = ln.color;
    ctx.fill();
    ctx.restore();
  }

  /* UNITS DRAW ABOVE EVERY MAP LAYER. Deliberate, and settled by testing.

     Sorting units into the depth-major terrain pass was tried (bc73cf51) so that
     a hill in front of a unit would hide its feet. In practice units vanished
     entirely behind hill and wood tile art rather than being partly occluded,
     because those tiles are drawn at WOODS_OVERSCAN (1.3x) and their canopy
     covers the whole square and then some. A unit standing one row behind a hill
     was simply gone.

     The rule is therefore: board units sit above all map layers. Only the
     ambient birds and clouds, which own their own canvases above this one, draw
     over them. Do not reintroduce depth sorting for units without solving the
     overscan problem first: the tile art, not the sort, is what hides them.

     Stacked squares (doubled infantry) are offset so both are visible. */
  const stackGroups = {};
  for(const u of state.units){
    if(u.removed) continue;
    const key = u.x+','+u.y;
    (stackGroups[key] = stackGroups[key] || []).push(u);
  }
  const STACK_OFFSETS = [{dx:-0.15,dy:-0.15,scale:0.72},{dx:0.15,dy:0.15,scale:0.72}];
  /* A unit in mid-move is drawn last, above anything it rides through. Its
     LOGICAL square is already the destination, so without this it would be
     grouped with whatever stands there and could be drawn underneath a unit it
     is currently crossing. Held back and drawn after the rest. */
  // Dust sits above the ground and below the units that kicked it up.
  drawRoadDust();

  const moving = [];
  for(const key in stackGroups){
    const list = stackGroups[key];
    if(list.length===1 && unitAnimations[list[0].id]){ moving.push(list[0]); continue; }
    if(list.length===1){ drawUnit(list[0]); }
    else if(list.length===2 && (list[0].type==='INFANTRY'||list[0].type==='GUARD') && (list[1].type==='INFANTRY'||list[1].type==='GUARD')){
      drawColumnUnitPair(list[0], list[1]);
    }
    else { list.forEach((u,i)=> drawUnit(u, STACK_OFFSETS[i % STACK_OFFSETS.length])); }
  }
  for(const u of moving) drawUnit(u);

  // muzzle smoke: lingers around a gun from the moment it fires until its side's next turn
  for(const u of state.units){
    if(u.removed || !u.smokeActive) continue;
    const vp = getUnitVisualPos(u);
    const cx = vp.x*CELL+CELL/2, cy = sy(vp.y)*CELL+CELL/2;
    ctx.save();
    ctx.fillStyle = '#f4f1e8';
    [[-0.22,-0.30,0.16],[0.10,-0.36,0.13],[0.28,-0.18,0.11]].forEach(([ox,oy,r])=>{
      ctx.globalAlpha = 0.45;
      ctx.beginPath(); ctx.arc(cx+ox*CELL, cy+oy*CELL, r*CELL, 0, Math.PI*2); ctx.fill();
    });
    ctx.restore();
  }

  // death markers: skull holds for a beat, then fades into drifting smoke
  const now = Date.now();
  for(const d of deathEffects){
    const elapsed = now - d.startTime;
    const cx = d.x*CELL+CELL/2, cy = sy(d.y)*CELL+CELL/2;
    if(elapsed < DEATH_SKULL_MS){
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.font = Math.floor(CELL*0.5)+'px sans-serif';
      ctx.fillText('\u{1F480}', cx, cy);
      ctx.restore();
    } else {
      const smokeT = (elapsed - DEATH_SKULL_MS) / DEATH_SMOKE_MS; // 0..1
      const fade = 1 - smokeT;
      ctx.save();
      ctx.fillStyle = '#d8d4c8';
      [[-0.15,-0.1,0.18],[0.15,-0.15,0.15],[0,0.05,0.20]].forEach(([ox,oy,r])=>{
        ctx.globalAlpha = 0.4*fade;
        const drift = smokeT*0.25;
        ctx.beginPath(); ctx.arc(cx+ox*CELL, cy+(oy-drift)*CELL, (r+smokeT*0.15)*CELL, 0, Math.PI*2); ctx.fill();
      });
      ctx.restore();
    }
  }

  // vignette: a soft darkening toward the board's outer edge, so the map reads
  // as a physical object sitting on a table rather than a flat filled rectangle
  const vw = COLS*CELL, vh = ROWS*CELL;
  ctx.fillStyle = getParchmentTexturePattern();
  ctx.fillRect(0, 0, vw, vh);
  const vignette = ctx.createRadialGradient(vw/2, vh/2, Math.min(vw,vh)*0.35, vw/2, vh/2, Math.hypot(vw,vh)*0.62);
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(10,8,4,0.30)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, vw, vh);

  // Kick the animation loop if it isn't already running and British Line
  // Infantry are on the board — draw() itself gets called from plenty of
  // places that aren't already inside that loop (unit selection, menu
  // toggles...), and without this the sprite sheet would only start
  // advancing once some unrelated move/fight animation happened to trigger
  // it first, sitting frozen on frame 0 until then.
  if(!animFrameHandle && state.units.some(u => !u.removed && (UNIT_TYPES[u.type].key==='INFANTRY' || UNIT_TYPES[u.type].key==='GUARD'))){
    ensureAnimationLoopRunning();
  }
}

/* =========================================================
   BATTLE INTRO ANIMATION
   Plays once at the start of a standard (non-campaign) AI-opponent match,
   right when the board first becomes visible — every grid tile drops in
   from above and bounce-settles into place, top-left to bottom-right,
   left-to-right across each row. Cannot be skipped; the caller is expected
   to hold off anything else (the orientation dice roll, in practice) until
   the onComplete callback fires.

   Implementation: rather than threading a per-cell animated offset through
   every existing terrain-drawing pass (grass, hill, road, building, woods,
   craters, road-to-building connectors...), which would mean touching a
   lot of delicate, already-working code — this renders the final board
   exactly once with the normal draw(), captures that as a snapshot, then
   animates cropped per-cell fragments of that snapshot into place. The
   live terrain-rendering pipeline itself is never touched.
========================================================= */
export function playBoardIntroAnimation(onComplete){
  draw(); // render the true final board once, to capture as the source for every tile fragment
  const snapshot = document.createElement('canvas');
  snapshot.width = canvas.width;
  snapshot.height = canvas.height;
  snapshot.getContext('2d').drawImage(canvas, 0, 0);

  const dpr = window.devicePixelRatio || 1;
  const fallDistance = window.innerHeight; // always starts fully off the top of the current viewport, whatever the phone's orientation
  const FALL_MS = 300, BOUNCE1_MS = 150, BOUNCE2_MS = 100, STAGGER_MS = 50;
  const DUST_MS = 200;

  const tiles = [];
  for(let y=0;y<ROWS;y++){
    for(let x=0;x<COLS;x++){
      tiles.push({ x, y, startDelay:(y*COLS+x)*STAGGER_MS, dustSpawned:false });
    }
  }
  const dustParticles = []; // {x, y, startTime}
  const startTime = performance.now();

  function tileOffset(elapsed){
    if(elapsed < 0) return { offset:-fallDistance, phase:'waiting' };
    if(elapsed < FALL_MS){
      const t = elapsed/FALL_MS;
      const eased = 1 - Math.pow(1-t, 2); // ease-out, matching the codebase's existing move-animation easing
      return { offset:-fallDistance*(1-eased), phase:'falling' };
    }
    const b1 = elapsed - FALL_MS;
    if(b1 < BOUNCE1_MS){
      const t = b1/BOUNCE1_MS;
      return { offset:-CELL*0.15*Math.sin(Math.PI*t), phase:'bounce1' };
    }
    const b2 = b1 - BOUNCE1_MS;
    if(b2 < BOUNCE2_MS){
      const t = b2/BOUNCE2_MS;
      return { offset:-CELL*0.05*Math.sin(Math.PI*t), phase:'bounce2' };
    }
    return { offset:0, phase:'settled' };
  }

  function tick(){
    const now = performance.now();
    const elapsedGlobal = now - startTime;
    ctx.clearRect(0, 0, COLS*CELL, ROWS*CELL);

    let allSettled = true;
    for(const tile of tiles){
      const localElapsed = elapsedGlobal - tile.startDelay;
      const { offset, phase } = tileOffset(localElapsed);
      if(phase!=='settled') allSettled = false;
      if(phase!=='waiting'){
        const dx = tile.x*CELL, dy = tile.y*CELL + offset;
        const sx = tile.x*CELL*dpr, sy = tile.y*CELL*dpr;
        ctx.drawImage(snapshot, sx, sy, CELL*dpr, CELL*dpr, dx, dy, CELL, CELL);
      }
      if(!tile.dustSpawned && localElapsed >= FALL_MS){
        tile.dustSpawned = true;
        dustParticles.push({ x: tile.x*CELL+CELL/2, y: (tile.y+1)*CELL, startTime: now });
      }
    }

    let dustActive = false;
    for(let i=dustParticles.length-1; i>=0; i--){
      const p = dustParticles[i];
      const age = now - p.startTime;
      if(age > DUST_MS){ dustParticles.splice(i,1); continue; }
      dustActive = true;
      const t = age/DUST_MS;
      ctx.save();
      ctx.globalAlpha = 0.30*(1-t);
      ctx.fillStyle = '#c9b98a';
      const r = CELL*0.16*(0.4+0.6*t);
      ctx.beginPath(); ctx.ellipse(p.x, p.y, r, r*0.45, 0, 0, Math.PI*2); ctx.fill();
      ctx.restore();
    }

    if(!allSettled || dustActive){
      requestAnimationFrame(tick);
    } else {
      draw(); // one final normal render, guaranteed pixel-identical to live state
      onComplete();
    }
  }
  requestAnimationFrame(tick);
}

