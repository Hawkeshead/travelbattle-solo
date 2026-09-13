import { AI_UNIT_VALUE, cavalryThreatWithinCharge, evaluateState, findBoggedEnemyGun, findDefensiveRallyPoint, findVulnerableEnemyUnits, groundDenialBonus, isIsolatedAndThreatened, mutualSupportBonus, rallyPointPullBonus, reserveCrisisExists, retreatToSupportBonus, roadSeekBonus, scenarioMoveBonus, screensGunBonus, supportCountFor, terrainSeekBonus, threatPenalty, vulnerableTargetPullBonus } from './ai-tactics.js';
import { COLS, ROWS, SIDES, SIDE_LABEL, UNIT_TYPES, state } from './data-core.js';
import { otherSide } from './engine-objectives.js';
import { artilleryTargets, chebyshev, combatBonuses, consumePloughEscort, hasChargeableTargetAt, hasLOS, isAdjacent, isCleanChargeRun, isConcealedFromEnemy, isFootInfantry, isHorseArtillery, legalMoves, movableUnitsForSide, neighbors8, resolveFight, stackPartner, terrainAt, unitBaseMove, unitsAt, volleyTargets } from './engine-rules.js';
import { log, logReplay } from './engine-state.js';
import { AudioManager } from './audio-manager.js';
import { animateUnitTo, cameraParkPlayerView, cameraToUnits, displaceBrigadierIfPresent, draw, moveAnimationMs } from './render-board.js';
import { brigadeBrokenStatus, canAttackTarget, canInitiateFight, canLayAmbush, endFightPhase, endFirePhase, endMovePhase, fireArtillery, resolveAmbushSpringsNow, resolveVolley, unitLabel } from './ui-battle.js';

/* How hard evaluateState pulls on a move decision. Declared at module scope
   because two separate comparisons depend on it and they must agree: the
   per-candidate move score, and the Form Square score that is weighed against
   the winner of those candidates. It previously lived inside the candidate loop,
   which is why the Square comparison was left reading evaluateState raw. */
const BASE_STATE_WEIGHT = 0.35;

/* =========================================================
   AI: BATTLEFIELD ASSESSMENT, OPERATIONAL PLAN, BRIGADE MISSIONS
   (Hard difficulty only. Existing tactics elsewhere in this file — terrain
   seeking, gun screening, reserve doctrine, ambush, the bogged column read,
   fight-value estimation — are kept as-is and used as tools by this layer,
   rather than replaced. This module decides WHEN and WHERE to lean on them,
   which was the missing piece: previously every unit scored its own move in
   isolation with no notion of what the army as a whole was trying to do.)
========================================================= */
export const OPERATIONAL_PLAN_TYPES = ['MAIN_ATTACK','FLANK_ATTACK','REFUSED_FLANK','DEFENSIVE','COUNTERATTACK',
  'ARTILLERY_PREP','FIX_AND_FLANK','BRIGADE_DESTRUCTION','CAVALRY_EXPLOITATION','WITHDRAWAL','FINISHING_BLOW'];
export const BRIGADE_MISSIONS = ['MAIN_ATTACK','SUPPORT','FIX','FLANK','RESERVE','SCREEN','HOLD','COUNTERATTACK','WITHDRAW','REGROUP','PRESERVE'];
export const MAX_PLAN_TURNS_UNCHANGED = 6; // a plan that's made no progress in this many AI turns gets reassessed regardless

/* Re-escalation. Every reassessment trigger below MAX_PLAN_TURNS_UNCHANGED used to
   describe deterioration; nothing described improvement. A passive plan could
   therefore only be escaped by the six-turn stale clock, and because HOLD/SCREEN/
   RESERVE/WITHDRAW generate no casualties the strength ratio hadn't moved by the
   time it expired, so the same passive branch was selected again with the clock
   reset. These constants give the passive plans a way out. */
// Exit ratios sit ABOVE the entry ratios (0.5 and 0.75) on purpose: hysteresis, so
// an army hovering on a threshold doesn't flip posture every other turn.
export const PASSIVE_EXIT_RATIO = { WITHDRAWAL: 0.62, DEFENSIVE: 0.88 };
// A plan gets at least this many turns to work before a ratio-recovery trigger can
// unseat it. A genuine finishing chance is exempt — see updateOperationalPlan.
export const MIN_PLAN_TURNS_BEFORE_OPPORTUNITY = 2;
// Below this, exploiting an isolated enemy Brigade stops being a way back into the
// fight and starts being a way to lose the rest of the army faster.
export const MIN_RATIO_FOR_OPPORTUNISM = 0.35;
// An enemy Brigade at or under this many fighters is close enough to breaking that
// finishing it is worth reordering the whole plan around.
export const BRIGADE_ON_THE_BRINK = 2;
// Below this fraction of its fighters still in command from their Brigadier, a
// Brigade cannot prosecute an offensive mission and is sent to REGROUP instead.
export const MIN_COMMAND_FRACTION_TO_ATTACK = 0.5;

// An ambush is a bet that the enemy comes to you. These bound how long the AI
// is willing to hold that bet: if nothing has come within AMBUSH_STANDDOWN_RANGE
// for AMBUSH_STANDDOWN_TURNS consecutive AI turns, the unit breaks cover and
// rejoins the battle rather than sitting out the rest of the match.
/* Cost of stepping into contact with an enemy no other friendly unit could also
   reach this turn.

   Originally 3.0, sized against the charge bonus (2.2). That was the wrong
   comparison. The term it really competes with is the advance pull, which is
   nearestEnemyDist * 0.12, so 0.12 per square closed. At 3.0 the penalty was
   twenty-five times the value of closing a square, which meant that once any
   candidate move would put a unit in contact unsupported, nothing in the scorer
   could outweigh it. The army walked to just outside contact range and stopped
   permanently: a logged match shows Brigade 0 holding the same four squares from
   turn 13 to turn 49 while the rest of the army was destroyed.

   1.2 still makes an unsupported charge (2.2 - 1.2 = +1.0) clearly worse than a
   supported one (2.2), and still outweighs ten squares of advance pull, but it
   can be overcome by a genuinely good opportunity rather than vetoing outright.
   Deliberately a discouragement now, not a prohibition. */
export const SOLO_ATTACK_PENALTY = 1.2;

// Per-square pull toward a mission's target, applied at ANY range rather than
// dying off past six squares. Set above terrainSeekBonus's 0.35 for a hill, so
// an ordered Brigade crosses ground instead of settling on the nicest terrain
// within reach.
export const APPROACH_PULL = 0.16;

// Per-square pull toward an enemy Brigade close to breaking. Breaking two
// Brigades wins the battle, so a Brigade on its last unit is the most valuable
// thing on the board. Sized above APPROACH_PULL so finishing a Brigade outranks
// prosecuting the Brigade's own assigned mission.
export const KILL_PULL_LAST_UNIT = 0.34;
export const KILL_PULL_PENULTIMATE = 0.20;

// A doubled Column is two units to one roundshot, and only a gun can take both.
export const COLUMN_TARGET_BONUS = 3.0;

// A Brigadier whose Brigade is destroyed falls back on the nearest friendly one
// rather than manoeuvring alone.
export const ORPHAN_BRIGADIER_PULL = 0.30;

// Pull toward where the two sides are actually in contact. Below APPROACH_PULL
// (0.16) on purpose: it bends a Brigade's advance toward the fighting rather
// than overriding the mission it was given.
export const CONVERGE_PULL = 0.10;

/* How hard a unit is drawn into a fight it would win. Multiplies the estimated
   value of the fight the move creates, so it is self-limiting: a bad matchup
   produces a negative number and pushes the unit away. Sized to sit alongside
   chargeBonus (2.2) once a decent fight is on offer, rather than below the
   incidental terrain and cohesion terms that were drowning the old pulls. */
/* Lowered from 0.9 with the clamp widened to match. In three logged matches
   engage's observed maximum was exactly 2.70, which is ENGAGE_CLAMP*ENGAGE_WEIGHT
   to the penny: the term was SATURATED. Every square offering any decent fight
   scored the identical capped value, so its spread across those squares was zero
   and it could never be the widest-spread term, which is exactly the statistic
   that says which term decided a move. That is why it "never decides" despite a
   healthy range: not that it is outvoted, but that it cannot tell its own good
   options apart. Widening the clamp and reducing the weight keeps the same
   effective magnitude while restoring the resolution. */
/* S4: back to full weight. At 0.5 a perfect fight was worth 2.3, which could
   not clear cohesionLoss at -2.40, so a unit would never break formation for a
   fight however good. At 1.0 the table runs about -4 to +4.6 as specified, and a
   good fight clears -2.40 on its own without cohesionLoss being touched. */
export const ENGAGE_WEIGHT = 1.0;
// Hard ceiling on the fight estimate before weighting. Belt and braces: the
// estimator is already bounded, and this makes sure engage cannot dominate the
// scorer even if that stops being true.
export const ENGAGE_CLAMP = 5.0;

/* R1: THE AVOIDANCE CAPS, AND THE INVARIANT BEHIND THEM.

   THE INVARIANT IS ABOUT SPREAD, NOT MAGNITUDE. It is tempting to write "no
   avoidance term may exceed engage's positive maximum", but magnitudes do not
   compete in this scorer: only the DIFFERENCE between the chosen square and its
   rivals decides anything. baseState reaches -13.65 and decides nothing, because
   its spread is 0.21 and it cancels across every option. Stated as a magnitude
   rule this would licence tuning baseState down, which is the error the project
   has already made once. Stated correctly: no avoidance term should routinely
   out-SPREAD engage on squares where a fight is available.

   Neither number below existed as a constant. threatPenalty accumulates 0.4-2.0
   per enemy in reach (0.6 per gun with LOS) and is unclamped, so the -5.00
   observed in seed 488332463 is several enemies summing rather than a ceiling
   anyone chose. retreatToSupportBonus is -chebyshev * 0.30, also unclamped, so
   -4.50 is simply a 15-tile distance.

   Capped at the SCORING SITE rather than inside the functions. Both are read as
   scalars by gates elsewhere (square formation at >= 1.4, reserve release at
   >= 1.0, exposed-artillery detection at >= 1, and others), every one of them
   below 1.5. Capping the functions themselves would leave those thresholds
   intact today and silently entangle them the next time one moves. */
export const THREAT_SCORE_MAX  = 2.50;   // was effectively 5.00, uncapped
export const RETREAT_SCORE_MAX = 2.00;   // was effectively 4.50, uncapped

/* R1: WHAT ACTUALLY KEPT THE FRENCH ARMY AT HOME.

   In seed 488332463 France initiated ONE of seven fights and held on 60% of its
   decisions. engage cannot be outvoted on a square where no enemy is reachable,
   so the reason it decided almost nothing is that the army never closed, not
   that avoidance beat it.

   Advancing one square was worth 0.12, for a spread of 0.16 across the match.
   terrainSeek ranges to 0.84, groundDenial to 0.75 and mutualSupport to 1.40, so
   standing on pleasant ground outscored closing with the enemy several times
   over, and five of the twelve closest decisions tied to the penny with 0.01 of
   jitter breaking them. Brigade 0 shuffled between (3,0) and (4,0) for
   twenty-five turns on exactly that.

   At 0.35 a full two-square advance is worth 0.70, which puts closing on terms
   with the terrain and support pulls rather than far beneath them. Deliberately
   not higher: this term is a blunt distance gradient with no notion of whether
   the fight at the end of it is a good one, and engage is what is supposed to
   judge that. A JUDGEMENT CALL WITH NO DATA BEHIND IT — 0.12 was measured and
   found wanting, 0.35 is reasoned. It may want a second pass.

   Note this does NOT reach two of Brigade 0's five units: Brigadiers use
   brigadierTrail instead (Napoleon follows his own units, so he moves once they
   do) and held-back Guard are suppressed by Reserve Doctrine until a crisis
   exists. The latter is R2/R4's problem, not R1's. */
export const ADVANCE_PULL_WEIGHT = 0.35;  // was 0.12

// Reserve release. Any one of these commits a reserve Brigade to SUPPORT.
// A reserve that is never spent is just an absent third of the army.
export const RESERVE_COMMIT_TURN = 12;        // holding back past this is not a plan
export const RESERVE_RELIEF_REMAINING = 2;    // a sister Brigade down to 2 fighters
export const RESERVE_ENEMY_RANGE = 6;         // the enemy has come to us

/* R6: PRESERVE — STAYING ALIVE IS A WAY OF WINNING.

   The match is decided by breaking two of three Brigades, so a Brigade reduced
   to its Brigadier and one fighting unit is worth far more alive and out of
   reach than dead attacking: surviving denies the enemy a kill they REQUIRE.
   This inverts the normal reading of a weak Brigade. It should become harder to
   kill, not spend itself.

   R7 is the same arithmetic seen from the other side, and the two are meant to
   meet in the middle: brigadeKillValue pays the enemy 3.00 for that last unit,
   and PRESERVE is what makes them work for it. */
export const PRESERVE_THRESHOLD = 1;          // Brigadier + this many fighting units

/* BOTH OF THESE ARE THEIR OWN CONSTANTS RATHER THAN MULTIPLES OF APPROACH_PULL.

   They were first written as fractions of APPROACH_PULL (0.16), which produced
   -0.24 for a reserve out of position and -0.96 for a remnant six squares from
   safety. Against cohesionLoss at 2.40 and engage at 2.37 those are noise, and
   both missions would have been as inert as the null RESERVE they replace: the
   behaviour would have looked implemented and done nothing.

   PRESERVE_PULL is the larger of the two on purpose. It has to overcome
   cohesionLoss to pull a remnant out of a line it is standing in, because
   leaving is the entire instruction. At 0.45 a six-square journey is worth 2.70,
   which clears cohesionLoss with something to spare.

   RESERVE_AXIS_PULL is deliberately smaller. A reserve should drift toward the
   decisive axis, not barge toward it through everything else on the board. */
export const PRESERVE_PULL     = 0.45;
export const RESERVE_AXIS_PULL = 0.25;

/* From R5's strength model, built here because R6 needs it and reassignment
   does not exist yet. The Brigadier counts for half: he cannot fight, but a
   Brigade that still has him can rally and can move. */
export function effectiveStrength(side, brigadeId){
  const units = state.units.filter(o=>!o.removed && o.side===side && o.brigadeId===brigadeId);
  const fighters = units.filter(o=>o.type!=='BRIGADIER').length;
  const hasBrigadier = units.some(o=>o.type==='BRIGADIER');
  return fighters + (hasBrigadier ? 0.5 : 0);
}

export function brigadeAtPreserveThreshold(side, brigadeId){
  const units = state.units.filter(o=>!o.removed && o.side===side && o.brigadeId===brigadeId);
  const fighters = units.filter(o=>o.type!=='BRIGADIER').length;
  const hasBrigadier = units.some(o=>o.type==='BRIGADIER');
  // Brigadier + exactly one. With none left the Brigade is broken and there is
  // nothing to preserve; with two or more it can still be useful in the line.
  return hasBrigadier && fighters === PRESERVE_THRESHOLD;
}

/* A DESTINATION, NOT A DIRECTION, and that distinction is the whole rule.

   "Flee from danger" is a gradient with no end, and it produced a French remnant
   wandering the board for twenty turns under artillery fire (seed 3460471751).
   "Get behind Brigade 2 and stop" terminates.

   The tile chosen is on the far side of the strongest surviving friendly
   Brigade's centroid, measured from the nearest enemy: the healthy Brigade ends
   up between the remnant and the fighting, which is the actual protection.
   Cached per side per turn, since it is one shared destination and recomputing
   it per candidate square would be a board scan inside the scoring loop. */
export function preserveDestination(side, brigadeId){
  const cache = state._aiPreserveCache;
  const key = side + ':' + brigadeId;
  if(cache && cache.turn===state.turnNumber && cache.key===key) return cache.point;

  let point = null;
  const others = [0,1,2].filter(id=>id!==brigadeId && effectiveStrength(side,id) > 0);
  if(others.length){
    const strongestId = others.reduce((a,b)=>effectiveStrength(side,b) > effectiveStrength(side,a) ? b : a);
    const guard = state.units.filter(o=>!o.removed && o.side===side && o.brigadeId===strongestId);
    if(guard.length){
      const cx = guard.reduce((n,o)=>n+o.x,0)/guard.length;
      const cy = guard.reduce((n,o)=>n+o.y,0)/guard.length;
      const foes = state.units.filter(o=>!o.removed && o.side!==side && o.type!=='BRIGADIER');
      if(foes.length){
        // Step away from the nearest enemy, through the guarding Brigade's centre.
        const near = foes.reduce((a,b)=>
          (Math.abs(b.x-cx)+Math.abs(b.y-cy)) < (Math.abs(a.x-cx)+Math.abs(a.y-cy)) ? b : a);
        const dx = cx - near.x, dy = cy - near.y;
        const len = Math.max(1, Math.hypot(dx, dy));
        point = {
          x: Math.max(0, Math.min(COLS-1, Math.round(cx + (dx/len)*3))),
          y: Math.max(0, Math.min(ROWS-1, Math.round(cy + (dy/len)*3)))
        };
      } else {
        point = { x: Math.round(cx), y: Math.round(cy) };
      }
    }
  }
  state._aiPreserveCache = { turn: state.turnNumber, key, point };
  return point;
}

// Hysteresis floor. A plan gets at least this many AI turns to execute before a
// SOFT trigger may unseat it. Hard triggers (main effort broken, target Brigade
// destroyed) bypass it, and MAX_PLAN_TURNS_UNCHANGED still forces an eventual
// rethink, so this is a floor rather than a ceiling.
export const MIN_PLAN_TURNS_BEFORE_CHANGE = 3;

// Withdraw once one more Brigade break would lose the battle and the army is
// materially behind. Higher than WITHDRAWAL's 0.5 material threshold because
// the win condition, not the unit count, is what actually decides the match.
export const WITHDRAW_ON_BRINK_RATIO = 0.8;

// Weight toward continuing against the enemy already under attack this phase,
// and toward one that cannot fight back or has just rallied. Both are ordering
// preferences within a mandatory fight phase, never grounds to decline a fight.
// Consecutive AI turns a unit will sit in Square with no cavalry able to reach
// it before reforming Line regardless of other pressure.
export const SQUARE_BREAK_TURNS = 2;

// A Brigadier is held this far behind his Brigade's forward-most unit: close
// enough to keep the cohesion chain intact, far enough not to be in the fight.
export const BRIGADIER_TRAIL_MIN = 1;
export const BRIGADIER_TRAIL_MAX = 2;
export const BRIGADIER_TRAIL_WEIGHT = 0.9;
export const BRIGADIER_CONTACT_PENALTY = 2.5;

// Staying put when there is a shot to take. A gun may move OR fire, so moving
// with a target in view throws the shot away.
export const GUN_HOLDS_FIRE_BONUS = 2.5;

// Pull toward the side's chosen cavalry point. Slightly stronger than the
// per-unit vulnerable pull it replaces (0.22), because the whole value of the
// rule is that the squadrons converge rather than each drifting to its own.
export const CAVALRY_CONCENTRATION_PULL = 0.28;

export const FOCUS_FIRE_BONUS = 1.8;
export const WOUNDED_TARGET_BONUS = 1.2;

/* R7: WHAT A KILL IS WORTH TOWARD WINNING, as opposed to what the unit is worth.

   The match is won by breaking two of three enemy Brigades, and nothing in the
   scoring knew that. A unit in a six-strong Brigade and a unit in a two-strong
   one scored identically, so the AI would spend a good attack widening a lead it
   could not convert while a Brigade sat one casualty from breaking.

   Marginal, not flat: each kill is worth a share of the break it brings closer,
   so the last combat unit in a Brigade is worth the whole break and one of six
   is worth a sixth of it. Doubled when one enemy Brigade is already broken,
   because that break ends the match.

     units left   value   if second break
        6          0.50        1.00
        4          0.75        1.50
        3          1.00        2.00
        2          1.50        3.00
        1          3.00        6.00

   ADDITIVE WITH engage, NEVER REPLACING IT. A remnant is usually protected, and
   a Brigade at its last unit is exactly where a square is standing. Win-condition
   value must not be able to talk the AI into a fight the fight-estimator already
   rates as bad. */
export const BRIGADE_BREAK_VALUE = 3.0;

/* The brief specified this floor at engage <= -3.00. That is unusable: engage's
   observed floor in seed 499086477 was exactly -3.00, so the guard could only
   fire on a single value and never in practice. It is the one line in R7 that
   has to work, since it is all that stops cavalry being sent into a square for
   win-condition value, so it sits at a magnitude engage actually reaches.
   Documented rather than silently retuned. */
export const KILL_VALUE_ENGAGE_FLOOR = -1.5;

export function brigadeKillValue(target){
  const remaining = state.units.filter(o=>!o.removed && o.side===target.side &&
    o.brigadeId===target.brigadeId && o.type!=='BRIGADIER').length;
  if(remaining === 0) return 0;              // already broken: nothing left to bring closer
  let v = BRIGADE_BREAK_VALUE / remaining;   // the target itself is counted, so a lone unit scores the full break
  if(brigadeBrokenStatus(target.side).filter(Boolean).length === 1) v *= 2.0;
  return v;
}
// An enemy off its Brigadier's chain or with no support within two squares.
// Below the wounded bonus on purpose: isolation is an opportunity, a unit that
// cannot fight back is a certainty.
export const ISOLATED_TARGET_BONUS = 0.9;

export const AMBUSH_STANDDOWN_RANGE = 4;
export const AMBUSH_STANDDOWN_TURNS = 3;

// Turns a unit must spend back in the battle after standing down before it may
// lay another ambush. Without it, standing down and immediately re-hiding on the
// same square is a stable loop a unit can sit in for a whole match.
export const AMBUSH_COOLDOWN_TURNS = 6;

export function brigadeIdsForSide(side){
  const ids = new Set(state.units.filter(u=>u.side===side && u.brigadeId!=null).map(u=>u.brigadeId));
  return [...ids].sort((a,b)=>a-b);
}

// Section 3: read the whole battlefield fresh each AI move phase. Pure function,
// mutates nothing — safe to call for debug/inspection as well as real decisions.
export function assessBattlefield(side){
  const enemy = otherSide(side);
  const ownUnits = state.units.filter(u=>!u.removed && u.side===side);
  const enemyUnits = state.units.filter(u=>!u.removed && u.side===enemy);
  const strengthOf = list => list.reduce((sum,u)=>sum+AI_UNIT_VALUE[u.type],0);
  const armyStrength = strengthOf(ownUnits);
  const enemyStrength = strengthOf(enemyUnits);

  function assessBrigades(brigSide, units){
    // One BFS for the whole side rather than one per Brigade per candidate square.
    const connected = movableUnitsForSide(brigSide);
    return brigadeIdsForSide(brigSide).map(id=>{
      const group = units.filter(u=>u.brigadeId===id);
      const brig = group.find(u=>u.type==='BRIGADIER');
      const fighters = group.filter(u=>u.type!=='BRIGADIER');
      const strength = strengthOf(group);
      const remaining = fighters.length;
      // Command state. `remaining` counts fighters that are alive; it says nothing
      // about whether they can actually be ordered anywhere. A fighter that has
      // fallen off the adjacency chain back to its Brigadier cannot move at all,
      // and one standing in Square has forfeited its move phase whether connected
      // or not. A Brigade ordered to attack with neither is being given an order it
      // has no means of obeying, which is precisely how the Brigadier ends up
      // advancing alone while its own battalions sit stranded behind it.
      const connectedCount = fighters.filter(u=>connected.has(u.id)).length;
      const squaredCount = fighters.filter(u=>u.formation==='square').length;
      const effectiveRemaining = fighters.filter(u=>connected.has(u.id) && u.formation!=='square').length;
      const commandFraction = fighters.length ? connectedCount/fighters.length : 1;
      const strandedUnits = fighters.filter(u=>!connected.has(u.id) || u.formation==='square');
      // Cohesion: average distance of this Brigade's units from their Brigadier
      // (or their own centroid unit if he's fallen) — low = still one fist.
      const anchor = brig || group[0];
      const cohesion = (anchor && fighters.length) ? fighters.reduce((s,u)=>s+chebyshev(u,anchor),0)/fighters.length : 0;
      const exposure = fighters.length ? fighters.reduce((s,u)=>s+threatPenalty(u,brigSide),0)/fighters.length : 0;
      // Isolated: no other friendly Brigade has any unit within supporting distance.
      const isolated = fighters.length>0 && !units.some(o=>o.brigadeId!==id && fighters.some(u=>chebyshev(u,o)<=6));
      return { id, side:brigSide, strength, remaining, cohesion, exposure, isolated, hasBrigadier: !!brig,
               connectedCount, squaredCount, effectiveRemaining, commandFraction, strandedUnits };
    });
  }

  const ownBrigades = assessBrigades(side, ownUnits);
  const enemyBrigades = assessBrigades(enemy, enemyUnits);
  const liveEnemyBrigades = enemyBrigades.filter(b=>b.remaining>0);
  const liveOwnBrigades = ownBrigades.filter(b=>b.remaining>0);

  // Centre of gravity: the enemy Brigade doing the most work — strength adjusted
  // down for poor cohesion, since a scattered Brigade isn't really "one" force.
  const centreOfGravity = liveEnemyBrigades.slice().sort((a,b)=>(b.strength/(1+b.cohesion*0.15))-(a.strength/(1+a.cohesion*0.15)))[0] || null;
  // Weak point: worst combination of low remaining strength and high exposure.
  const weakestEnemyBrigade = liveEnemyBrigades.slice().sort((a,b)=>(a.strength-a.exposure*2)-(b.strength-b.exposure*2))[0] || null;
  const weakestOwnBrigade = liveOwnBrigades.slice().sort((a,b)=>a.strength-b.strength)[0] || null;
  const isolatedEnemyBrigades = liveEnemyBrigades.filter(b=>b.isolated);

  const exposedEnemyArtillery = enemyUnits.filter(u=>UNIT_TYPES[u.type].isArtillery && threatPenalty(u,enemy)>=1);
  const exposedEnemyCavalry = enemyUnits.filter(u=>UNIT_TYPES[u.type].isCavalry && threatPenalty(u,enemy)>=1.5);

  // Weak flank: which half of the board (by column) the enemy has committed
  // less strength to — the brief's "weak flank" / "avenue of advance" read.
  const midCol = COLS/2;
  const enemyLeft = strengthOf(enemyUnits.filter(u=>u.x<midCol));
  const enemyRight = strengthOf(enemyUnits.filter(u=>u.x>=midCol));
  const weakFlank = enemyLeft<enemyRight ? 'left' : 'right';

  // Decisive terrain: hills/buildings in the contested middle band of the board,
  // where holding them actually matters this battle rather than being scenery.
  const decisivePoints = [];
  for(let y=0;y<ROWS;y++) for(let x=0;x<COLS;x++){
    const terr = terrainAt(x,y);
    if(terr.key==='HILL' || terr.key==='BUILDING'){
      const midDist = Math.abs(y - ROWS/2);
      if(midDist<=ROWS*0.4) decisivePoints.push({x,y,key:terr.key});
    }
  }

  // Break proximity: how close either side is to actually WINNING, as opposed to
  // how much material each has left. strengthRatio is blind to this, which is how
  // an AI one casualty away from breaking the enemy's second Brigade could read
  // itself as materially behind and withdraw from a won position. brigadeBreakBonus
  // already understands this at unit level; the operational layer did not.
  const brigadesToBreak = Math.max(1, Math.ceil(enemyBrigades.length * 2/3));
  const enemyBrigadesBroken = enemyBrigades.filter(b=>b.remaining===0).length;
  const ownBrigadesBroken = ownBrigades.filter(b=>b.remaining===0).length;
  const brigadesFromVictory = Math.max(0, brigadesToBreak - enemyBrigadesBroken);
  const brigadesFromDefeat = Math.max(0, Math.max(1, Math.ceil(ownBrigades.length * 2/3)) - ownBrigadesBroken);
  // The live enemy Brigade closest to breaking, and whether taking it wins outright.
  const brinkEnemyBrigade = liveEnemyBrigades.slice().sort((a,b)=>a.remaining-b.remaining)[0] || null;
  const finishingChance = brigadesFromVictory === 1 && brinkEnemyBrigade
    && brinkEnemyBrigade.remaining <= BRIGADE_ON_THE_BRINK;

  return {
    side, enemy, armyStrength, enemyStrength,
    strengthRatio: armyStrength / Math.max(1, enemyStrength),
    ownBrigades, enemyBrigades, liveOwnBrigades, liveEnemyBrigades,
    centreOfGravity, weakestEnemyBrigade, weakestOwnBrigade, isolatedEnemyBrigades,
    exposedEnemyArtillery, exposedEnemyCavalry, weakFlank, decisivePoints,
    brigadesToBreak, enemyBrigadesBroken, ownBrigadesBroken,
    brigadesFromVictory, brigadesFromDefeat, brinkEnemyBrigade, finishingChance
  };
}

// Whether the AI's committed attack (main effort Brigade vs its actual target)
// still looks sound LOCALLY, even once the whole-army strengthRatio has dipped.
// Losing a single unit in a good trade can swing the army-wide ratio without
// changing anything about the actual point of contact — the AI shouldn't read
// that as "the whole war just went badly" and abandon a push that's still
// genuinely cornering the enemy Brigade it was aimed at.
function localAttackStillFavourable(a, mainEffortId, targetId){
  if(mainEffortId==null || targetId==null) return false;
  const effort = a.liveOwnBrigades.find(b=>b.id===mainEffortId);
  const target = a.liveEnemyBrigades.find(b=>b.id===targetId);
  if(!effort || !target) return false;
  return effort.strength >= target.strength * 0.85;
}

// Section 4: pick (or keep) a multi-turn plan. Only reassesses when a Section 12
// trigger actually fires — otherwise the previous turn's plan is returned as-is,
// so the AI doesn't re-litigate its whole strategy every single move phase.
export function updateOperationalPlan(side, assessment){
  const prev = state._aiPlan[side];
  const reasons = [];
  let mustReassess = !prev;
  if(prev) prev.turnsHeld = (prev.turnsHeld||0) + 1;

  if(prev && !mustReassess){
    const mainEffort = assessment.liveOwnBrigades.find(b=>b.id===prev.mainEffortBrigadeId);
    const target = assessment.liveEnemyBrigades.find(b=>b.id===prev.targetBrigadeId);
    if(prev.mainEffortBrigadeId!=null && !mainEffort){ mustReassess = true; reasons.push('main effort Brigade broken/withdrawn'); }
    else if(prev.targetBrigadeId!=null && !target){ mustReassess = true; reasons.push('target Brigade destroyed — exploit or pick a new one'); }
    else if(prev.turnsHeld > MAX_PLAN_TURNS_UNCHANGED){ mustReassess = true; reasons.push('plan stale, no resolution in ' + prev.turnsHeld + ' turns'); }
    /* Soft trigger, so it is gated by the hysteresis floor. The two triggers
       above are HARD (the main effort Brigade broken, the target Brigade
       destroyed) and deliberately bypass it: a plan whose subject no longer
       exists cannot be persevered with. Everything else waits.

       Match 3 shows why the floor is needed: Brigade 1 was given MAIN_ATTACK at
       T15 and had it revoked at T17, having advanced Soult exactly one tile in
       between. Nothing held long enough to execute.

       The counter-evidence matters just as much. Match 6's Brigade 1 held FLANK
       for 45 turns and was the best-performing AI Brigade in six matches. Long
       commitment is not the fault; churn is. So this adds a floor, not a
       ceiling, and MAX_PLAN_TURNS_UNCHANGED still forces a rethink eventually. */
    else if(prev.turnsHeld >= MIN_PLAN_TURNS_BEFORE_CHANGE
      && assessment.strengthRatio < 0.7 && prev.type!=='DEFENSIVE' && prev.type!=='WITHDRAWAL'
      && !localAttackStillFavourable(assessment, prev.mainEffortBrigadeId, prev.targetBrigadeId)){
      mustReassess = true; reasons.push('army badly outnumbered overall, and the current push has also lost its local edge — abandon and stabilise');
    }

    /* --- OPPORTUNITY TRIGGERS ---
       The counterparts to the four above, which between them only ever describe
       things getting worse. Without these a passive plan can only be escaped by
       the stale clock, and since passive missions produce no casualties the
       strength ratio is unchanged when it expires, so the same passive branch is
       re-selected and the clock restarts. The AI wasn't failing to re-escalate; it
       was re-committing to passivity every six turns. */
    if(!mustReassess){
      const passive = prev.type==='DEFENSIVE' || prev.type==='WITHDRAWAL';
      const settled = (prev.turnsHeld||0) >= MIN_PLAN_TURNS_BEFORE_OPPORTUNITY;

      // One Brigade break from LOSING is as urgent as one from winning, and
      // bypasses the settling period for the same reason.
      if(assessment.brigadesFromDefeat <= 1 && prev.type!=='WITHDRAWAL'
        && assessment.strengthRatio < WITHDRAW_ON_BRINK_RATIO){
        mustReassess = true;
        reasons.push('one Brigade break from defeat — withdraw while there is still something to save');
      }
      // A finishing chance overrides everything, including the settling period. One
      // more Brigade break ends the battle; there is no posture worth holding
      // through that.
      else if(assessment.finishingChance && prev.type!=='FINISHING_BLOW'){
        mustReassess = true;
        reasons.push('one Brigade break from victory and an enemy Brigade is on the brink — go and finish it');
      }
      // An enemy Brigade that has come unstuck from its own army is the opening a
      // behind-but-not-beaten army needs, whatever posture it happens to be in.
      else if(settled && assessment.isolatedEnemyBrigades.length>0
        && assessment.strengthRatio >= MIN_RATIO_FOR_OPPORTUNISM
        && prev.type!=='BRIGADE_DESTRUCTION'){
        mustReassess = true;
        reasons.push('an enemy Brigade has become isolated — worth breaking posture to exploit');
      }
      // Material recovery, with hysteresis: the exit ratios sit above the entry
      // ratios so an army sitting on a threshold doesn't flip posture repeatedly.
      else if(settled && passive && assessment.strengthRatio >= (PASSIVE_EXIT_RATIO[prev.type] || Infinity)){
        mustReassess = true;
        reasons.push('position recovered to ratio ' + assessment.strengthRatio.toFixed(2) + ' — no longer justifies staying passive');
      }
    }
  }

  if(!mustReassess) return prev;

  let plan;
  const a = assessment;
  const strongestOwn = a.liveOwnBrigades.slice().sort((x,y)=>y.strength-x.strength)[0];
  // The Brigade a passive plan rallies around. Also gives WITHDRAWAL and the
  // fallback DEFENSIVE a non-null mainEffortBrigadeId, which matters structurally:
  // the first two reassessment triggers above are both gated on that field being
  // non-null, so with it null those plans could ONLY ever be escaped by the stale
  // clock. WITHDRAWAL was the stickiest plan in the set purely by accident.
  const rallyBrigadeId = a.weakestOwnBrigade ? a.weakestOwnBrigade.id : null;

  /* WITHDRAW ON THE WIN CONDITION, not only on the material ratio.

     WITHDRAWAL previously fired at strengthRatio < 0.5 alone. In match 5 it did
     not appear until T63, roughly forty turns after the battle was decided,
     because the ratio is a poor read late on: an army reduced to a few intact
     Guard units can still score respectably against a spread-out winner.

     brigadesFromDefeat is the mirror of finishingChance, which already lets the
     AI recognise it is one break from WINNING. This lets it recognise it is one
     break from LOSING, which is exactly when a withdrawal is still worth
     something. Checked before the finishing branch on purpose: if both are true
     the battle is decided either way, and preserving the Brigade that is about
     to break is the more useful instinct. */
  if(a.brigadesFromDefeat <= 1 && a.strengthRatio < WITHDRAW_ON_BRINK_RATIO && !a.finishingChance){
    plan = { type:'WITHDRAWAL', mainEffortBrigadeId: a.weakestOwnBrigade ? a.weakestOwnBrigade.id : null,
             targetBrigadeId:null };
  } else if(a.finishingChance){
    // Checked first, ahead of every material test. One more break wins the battle,
    // so the strength ratio is no longer the question being asked.
    plan = { type:'FINISHING_BLOW', mainEffortBrigadeId: strongestOwn?strongestOwn.id:null,
             targetBrigadeId: a.brinkEnemyBrigade.id };
  } else if(a.isolatedEnemyBrigades.length>0 && a.strengthRatio >= MIN_RATIO_FOR_OPPORTUNISM){
    // Moved ABOVE the WITHDRAWAL branch. The reasoning in the comment below already
    // argued that picking on an unsupported enemy Brigade is how a slightly-behind
    // army claws back to even, then placed the branch beneath the withdrawal test
    // anyway — so an outnumbered AI facing an isolated, nearly-dead Brigade
    // withdrew instead of finishing it. Floored at MIN_RATIO_FOR_OPPORTUNISM,
    // below which this stops being a way back in and becomes a faster way to lose.
    const target = a.isolatedEnemyBrigades.slice().sort((x,y)=>x.strength-y.strength)[0];
    plan = { type:'BRIGADE_DESTRUCTION', mainEffortBrigadeId: strongestOwn?strongestOwn.id:null, targetBrigadeId: target.id };
  } else if(a.strengthRatio < 0.5){
    plan = { type:'WITHDRAWAL', mainEffortBrigadeId: rallyBrigadeId, targetBrigadeId:null };
  } else if(a.strengthRatio < 0.75){
    plan = { type:'DEFENSIVE', mainEffortBrigadeId: rallyBrigadeId, targetBrigadeId:null };
  } else if(a.weakestEnemyBrigade && a.strengthRatio >= 1.15){
    plan = { type:'MAIN_ATTACK', mainEffortBrigadeId: strongestOwn?strongestOwn.id:null, targetBrigadeId: a.weakestEnemyBrigade.id };
  } else if(a.weakestEnemyBrigade){
    plan = { type:'FIX_AND_FLANK', mainEffortBrigadeId: strongestOwn?strongestOwn.id:null, targetBrigadeId: a.weakestEnemyBrigade.id };
  } else {
    plan = { type:'DEFENSIVE', mainEffortBrigadeId: rallyBrigadeId, targetBrigadeId:null };
  }
  plan.createdOnTurn = state.turnNumber;
  plan.turnsHeld = 0;
  plan.reasons = reasons;
  state._aiPlan[side] = plan;
  return plan;
}

// Section 5: turn the plan into one mission per own Brigade.
/* RESERVE HAS NO EXIT, AND THAT IS HOW A WHOLE BRIGADE DIES WHERE IT STANDS.

   A reserve Brigade has no term pulling it anywhere at all. holdingReserve
   suppresses the advance pull outright, and RESERVE's own movement bonus only
   pulls units back toward their Brigadier, while the Brigadier (since the escort
   rule) is pulled toward its own units. Units follow the Brigadier, the
   Brigadier follows the units, and the whole formation sits in a stable
   equilibrium. Six logged matches show one or two Brigades per match never
   committing; Murat's sat on RESERVE for 45 turns and was destroyed piecemeal
   without moving toward the fighting.

   The one existing release, reserveCrisisExists, needs a friendly non-cavalry
   unit already in contact AND under real threat. That is a rescue trigger, not
   a commitment trigger: by the time it fires the battle is usually decided.

   Three additional releases, per the brief:
     - a friendly Brigade has taken real losses and needs relieving
     - the enemy has come to the reserve rather than the other way round
     - enough turns have passed that holding back is no longer a plan
   Any one of them commits the reserve. */
function reserveShouldCommit(side, assessment){
  if(state.turnNumber >= RESERVE_COMMIT_TURN) return 'turn count';
  // A sister Brigade down to this many fighters or fewer needs relieving.
  const hurt = assessment.liveOwnBrigades.some(b => b.remaining <= RESERVE_RELIEF_REMAINING);
  if(hurt) return 'a friendly Brigade is being broken up';
  // The enemy has arrived. Measured against the Brigade's own units rather than
  // the army, since a reserve on the far flank should react to its own sector.
  const enemy = otherSide(side);
  const foes = state.units.filter(o=>!o.removed && o.side===enemy && o.type!=='BRIGADIER');
  const ourUnits = state.units.filter(u=>!u.removed && u.side===side && u.type!=='BRIGADIER');
  const pressed = ourUnits.some(u => foes.some(o => chebyshev(u,o) <= RESERVE_ENEMY_RANGE));
  if(pressed) return 'enemy within reach of the reserve';
  return null;
}

export function assignBrigadeMissions(side, plan, assessment){
  const missions = {};
  const brigadeIds = assessment.liveOwnBrigades.map(b=>b.id);
  const others = brigadeIds.filter(id=>id!==plan.mainEffortBrigadeId);

  if(plan.type==='WITHDRAWAL'){
    // Only a Brigade that's ACTUALLY in real trouble itself withdraws — applying
    // this to every Brigade just because the army overall is struggling is
    // exactly the "whole army huddles in one corner" collapse this avoids.
    // A Brigade that's still individually healthy instead holds as a Reserve
    // (see the existing holdingReserve/reserveCrisisExists mechanism, which
    // already knows to drop that restraint the moment IT runs into real
    // trouble), consolidating the army into one more defensible shape around
    // whichever Brigade needs the help most, rather than every Brigade
    // independently fleeing toward its own board edge.
    // Rally anchor comes from the plan, not from a fresh weakestOwnBrigade read:
    // the plan's choice is frozen at creation, whereas the live weakest Brigade can
    // change hands turn to turn and drag the whole army's rally point with it.
    const anchorId = plan.mainEffortBrigadeId != null
      ? plan.mainEffortBrigadeId
      : (assessment.weakestOwnBrigade ? assessment.weakestOwnBrigade.id : null);
    for(const id of brigadeIds){
      const b = assessment.liveOwnBrigades.find(x=>x.id===id);
      const inRealTrouble = b && (b.exposure >= 1.5 || b.remaining <= 1);
      missions[id] = inRealTrouble ? 'WITHDRAW' : (id===anchorId ? 'HOLD' : 'RESERVE');
    }
  } else if(plan.type==='FINISHING_BLOW'){
    // Everything commits. Holding a Brigade in reserve when a single Brigade break
    // ends the battle is saving a card for a hand that will not be played.
    if(plan.mainEffortBrigadeId!=null) missions[plan.mainEffortBrigadeId] = 'MAIN_ATTACK';
    for(const id of others) missions[id] = 'SUPPORT';
  } else if(plan.type==='DEFENSIVE'){
    for(const id of brigadeIds) missions[id] = (id===plan.mainEffortBrigadeId) ? 'HOLD' : 'SCREEN';
  } else if(plan.type==='MAIN_ATTACK' || plan.type==='BRIGADE_DESTRUCTION' || plan.type==='CAVALRY_EXPLOITATION'){
    if(plan.mainEffortBrigadeId!=null) missions[plan.mainEffortBrigadeId] = 'MAIN_ATTACK';
    others.forEach((id,i)=>{ missions[id] = i===0 ? 'SUPPORT' : 'RESERVE'; });
  } else if(plan.type==='FIX_AND_FLANK' || plan.type==='FLANK_ATTACK'){
    if(plan.mainEffortBrigadeId!=null) missions[plan.mainEffortBrigadeId] = 'FLANK';
    others.forEach((id,i)=>{ missions[id] = i===0 ? 'FIX' : 'RESERVE'; });
  } else {
    // fallback: everyone holds
    for(const id of brigadeIds) missions[id] = 'HOLD';
  }

  /* --- RESERVE RELEASE ---
     Applied before the command-state pass so a committed reserve is still
     checked for a broken command chain like any other active Brigade. */
  const commitReason = reserveShouldCommit(side, assessment);
  if(commitReason){
    for(const id of brigadeIds){
      if(missions[id] !== 'RESERVE') continue;
      const b = assessment.liveOwnBrigades.find(x=>x.id===id);
      if(!b) continue;
      // Committed toward the same target the plan is already prosecuting, so
      // the reserve reinforces the main effort rather than opening a third axis.
      missions[id] = 'SUPPORT';
    }
  }

  /* --- PRESERVE OVERRIDE (R6) ---
     Applied AFTER the reserve release and before the command-state pass, and it
     overrides everything: a Brigade down to its Brigadier and one fighting unit
     must not be committed by any of the rules above. Surviving denies the enemy
     a Brigade break they need to win, which is worth more than anything that one
     unit could achieve in the line.

     Not applied to a Brigade with no Brigadier: without him it cannot rally and
     cannot reliably move, so hiding it achieves nothing, and it is broken as
     soon as its last fighter goes anyway. */
  for(const id of brigadeIds){
    if(brigadeAtPreserveThreshold(side, id)) missions[id] = 'PRESERVE';
  }

  /* --- COMMAND-STATE PASS ---
     Missions above are assigned purely on brigadeId, which says nothing about
     whether a Brigade can carry the order out. Two things make an offensive
     mission unexecutable, and neither was visible to this function:

       - a fighter off the adjacency chain back to its Brigadier cannot move at all
       - a fighter in Square has forfeited its move phase whether connected or not,
         and because it cannot move it also cannot repair a chain that runs through
         it, so it freezes every unit behind it in the chain as well

     A Brigade ordered to MAIN_ATTACK in that state sends its Brigadier forward
     alone (he is connected to himself by definition, so nothing penalises him)
     while his own battalions sit stranded. REGROUP reverses the direction: the
     Brigadier rides back to the stalled units instead of the units being expected
     to catch up, which is both the only mechanism available and the historically
     correct one.

     Deliberately NOT changed: the Square reform threshold in aiDecideAndExecuteMove
     stays at threatPenalty < 0.8. Loosening it to repair a chain would push units
     out of Square while Cavalry are still on them, which trades a stalled Brigade
     for a destroyed one. */
  /* Every mission where a Brigade is expected to act, not just the offensive
     ones. RESERVE, SCREEN and HOLD were originally excluded on the reasoning
     that a Brigade sitting still does not need its command chain intact. That
     is wrong: a Brigade cannot act on ANY future order if its units are off the
     Brigadier's chain, and a disconnected unit cannot move itself back, so the
     Brigadier has to come to it. Excluding the defensive missions is why Soult
     marched alone from (6,1) to (2,9) across ten turns while his last unit,
     4e Ligne, sat stranded at (0,0) for fifty. Both were on HOLD, so REGROUP
     could never fire. WITHDRAW is left out on purpose: a Brigade running for
     the edge has no use for a rally point behind it. */
  const NEEDS_COMMAND = new Set(['MAIN_ATTACK','FLANK','SUPPORT','FIX','COUNTERATTACK',
                                 'RESERVE','SCREEN','HOLD']);
  let mainEffortRegrouped = false;
  for(const id of brigadeIds){
    if(!NEEDS_COMMAND.has(missions[id])) continue;
    const b = assessment.liveOwnBrigades.find(x=>x.id===id);
    if(!b || !b.hasBrigadier) continue; // Brigadier down: survivors already act independently
    if(b.effectiveRemaining === 0 || b.commandFraction < MIN_COMMAND_FRACTION_TO_ATTACK){
      missions[id] = 'REGROUP';
      if(id === plan.mainEffortBrigadeId) mainEffortRegrouped = true;
    }
  }
  // If the main effort itself has come apart, hand the push to the best-placed
  // Brigade still in command rather than leaving the plan with no one prosecuting
  // it — that gap is another route into the same passive drift.
  if(mainEffortRegrouped){
    const relief = assessment.liveOwnBrigades
      .filter(b=>missions[b.id] && missions[b.id]!=='REGROUP' && b.effectiveRemaining>0)
      .sort((x,y)=>y.effectiveRemaining-x.effectiveRemaining)[0];
    if(relief) missions[relief.id] = plan.type==='FIX_AND_FLANK' || plan.type==='FLANK_ATTACK' ? 'FLANK' : 'MAIN_ATTACK';
  }
  return missions;
}

// Called once per AI move phase, before any per-unit decisions — Section 2's
// three-level command hierarchy in practice: army plan, then Brigade mission,
// then (in aiDecideAndExecuteMove) individual unit execution of that mission.
export function aiPlanTurn(side){
  if(state.aiDifficulty!=='hard'){ state._aiDebugLog[side]=null; return; }
  const assessment = assessBattlefield(side);
  const plan = updateOperationalPlan(side, assessment);
  const missions = assignBrigadeMissions(side, plan, assessment);
  state._aiMissions[side] = missions;
  state._aiDebugLog[side] = { turn: state.turnNumber, assessment, plan, missions, moveLog: [] };
}

export function missionFor(u){
  const missions = state._aiMissions[u.side];
  if(!missions) return null;
  return missions[u.brigadeId] || null;
}

export function logAiDebugMove(side, entry){
  const dbg = state._aiDebugLog[side];
  if(dbg) dbg.moveLog.push(entry);
}

// Section 6/7: how well a candidate square serves this unit's Brigade mission —
// added on top of the existing tactical bonuses in aiDecideAndExecuteMove, not
// instead of them. Only active on Hard, where missions actually exist.
// Cached per (side, turn) — the rally point is a single shared destination
// for the whole side this turn, not something to recompute (a full board
// scan) for every candidate square of every unit deciding a HOLD/WITHDRAW move.
function getDefensiveRallyPoint(side, nearPos){
  const cache = state._aiRallyCache;
  if(cache && cache.side===side && cache.turn===state.turnNumber) return cache.point;
  const point = findDefensiveRallyPoint(nearPos, 12);
  state._aiRallyCache = { side, turn: state.turnNumber, point };
  return point;
}

export function missionMoveBonus(u, side, pos, mission, plan){
  if(!mission) return 0;
  const assessment = state._aiDebugLog[side] ? state._aiDebugLog[side].assessment : null;
  const targetBrigade = plan && plan.targetBrigadeId!=null
    ? state.units.filter(o=>!o.removed && o.side===otherSide(side) && o.brigadeId===plan.targetBrigadeId)
    : [];
  const nearestTargetDist = targetBrigade.length ? Math.min(...targetBrigade.map(o=>chebyshev(pos,o))) : null;

  switch(mission){
    case 'MAIN_ATTACK':
      // Push hard at the plan's actual target, not just the nearest enemy.
      return nearestTargetDist!=null
        ? -nearestTargetDist*APPROACH_PULL + Math.max(0, 6-nearestTargetDist)*0.18 : 0;
    case 'FLANK':
      // Favour the weak-flank column band while closing, rather than a straight line in.
      if(!assessment) return nearestTargetDist!=null
        ? -nearestTargetDist*APPROACH_PULL + Math.max(0,6-nearestTargetDist)*0.12 : 0;
      { const towardFlank = assessment.weakFlank==='left' ? (COLS-pos.x)*0.02 : pos.x*0.02;
        return (nearestTargetDist!=null
          ? -nearestTargetDist*APPROACH_PULL + Math.max(0,6-nearestTargetDist)*0.12 : 0) + towardFlank; }
    case 'FIX':
      // Reward staying in contact with the target Brigade without overextending past it.
      return nearestTargetDist!=null ? Math.max(0, 3-Math.abs(nearestTargetDist-1))*0.15 : 0;
    case 'SUPPORT':
      return nearestTargetDist!=null
        ? -nearestTargetDist*APPROACH_PULL*0.7 + Math.max(0, 5-nearestTargetDist)*0.1 : 0;
    case 'RESERVE': {
      /* R2: A RESERVE THAT DOES SOMETHING.

         This returned 0, so combined with the holdingReserve suppression a
         reserve Brigade had NO term pulling it anywhere at all: units follow
         their Brigadier, the Brigadier follows his units, and the formation sits
         in equilibrium until the match ends. Murat's Brigade sat on RESERVE for
         45 turns and was destroyed piecemeal without moving.

         A reserve is not a spectator. It sits within reach of the axis the
         battle is being decided on, so that when it commits it is already
         somewhere useful. Half MAIN_ATTACK's approach pull, and explicitly
         floored so it stops short: the fall-off term rewards being NEAR the
         target Brigade, not in contact with it, and the engagement suppression
         at holdingReserve still stops it starting anything. */
      if(nearestTargetDist == null) return 0;
      const RESERVE_STANDOFF = 4;   // squares from the target Brigade: close enough to matter, far enough not to be drawn in
      return -Math.abs(nearestTargetDist - RESERVE_STANDOFF) * RESERVE_AXIS_PULL;
    }
    case 'PRESERVE': {
      /* R6. A destination, not a direction. Once there, nothing pulls it
         further, which is the entire point: a gradient away from danger is what
         sent a remnant wandering the board under fire for twenty turns. */
      const dest = preserveDestination(side, u.brigadeId);
      if(!dest) return 0;
      const d = chebyshev(pos, dest);
      /* Yields on arrival, and the deadlock rule falls out of that rather than
         needing its own code: a PRESERVE Brigade under no time pressure simply
         stops wanting ground once it is close, so a reserve advancing through
         the same tiles is never contested. */
      if(d <= 1) return 0.6;
      return -d * PRESERVE_PULL;
    }
    case 'SCREEN':
      return screensGunBonus(u, side, pos) * 1.2;
    case 'HOLD':
      return terrainSeekBonus(u.type, pos.x, pos.y) * 1.5 + rallyPointPullBonus(pos, getDefensiveRallyPoint(side, pos));
    case 'WITHDRAW':
      { const homeRow = side===SIDES.RED ? ROWS-1 : 0;
        return Math.max(0, 4-Math.abs(pos.y-homeRow)) * 0.2 + rallyPointPullBonus(pos, getDefensiveRallyPoint(side, pos)); }
    case 'COUNTERATTACK':
      return nearestTargetDist!=null
        ? -nearestTargetDist*APPROACH_PULL + Math.max(0,6-nearestTargetDist)*0.18 : 0;
    case 'REGROUP': {
      // Restore the command chain. The pull runs in opposite directions depending
      // on who is deciding, which is the whole point: a stranded unit may well be
      // unable to move at all, so the Brigadier has to be the one that closes the
      // distance. Weighted above MAIN_ATTACK's 0.18 on purpose — a Brigade that
      // cannot be ordered anywhere has nothing more valuable to be doing.
      const brigade = assessment ? assessment.ownBrigades.find(b=>b.id===u.brigadeId) : null;
      if(UNIT_TYPES[u.type].key === 'BRIGADIER'){
        // strandedUnits is a snapshot taken at the top of the move phase, so filter
        // casualties out at use time rather than steering the Brigadier at a corpse.
        const stranded = brigade ? brigade.strandedUnits.filter(o=>!o.removed) : [];
        if(!stranded.length) return 0;
        const meanDist = stranded.reduce((s,o)=>s+chebyshev(pos,o),0) / stranded.length;
        return Math.max(0, 8-meanDist) * 0.30;
      }
      const brig = state.units.find(o=>!o.removed && o.side===side && o.brigadeId===u.brigadeId && o.type==='BRIGADIER');
      if(!brig) return 0;
      return Math.max(0, 8-chebyshev(pos,brig)) * 0.22;
    }
    default:
      return 0;
  }
}

export function orderAiUnitsForMove(side){
  // Grouped by Brigade, leftmost Brigade first, so a human watching can follow
  // "now it's doing the left Brigade's turn" rather than units from all three
  // Brigades interleaving across the board in the same pass. Within each
  // Brigade the Brigadier still goes first — it anchors that Brigade's
  // cohesion chain (never penalized for its own "disconnection" — see
  // movableUnitsForSide), so leading with it gives the rest of that Brigade a
  // freshly-moved anchor to path toward before they decide their own moves.
  const pri = { BRIGADIER:0, INFANTRY:1, GUARD:1, LIGHT_CAV:2, HEAVY_CAV:2, ARTILLERY:3 };
  const units = state.units.filter(u=>!u.removed && u.side===side);
  const brigadeX = {};
  for(const bId of new Set(units.map(u=>u.brigadeId))){
    const brig = units.find(u=>u.brigadeId===bId && u.type==='BRIGADIER');
    const members = units.filter(u=>u.brigadeId===bId);
    brigadeX[bId] = brig ? brig.x : members.reduce((s,u)=>s+u.x,0)/members.length;
  }
  /* WITHIN A BRIGADE, THE OUTERMOST UNIT MOVES FIRST.
  
     Ordering by unit type alone ignored the cohesion chain, and the chain is a
     chain: a unit in the middle of it holds the ones beyond it connected. Move
     that middle unit first and everything past it is severed and cannot move
     at all, which throws away a whole unit's turn for nothing.
  
     Moving from the outside in removes the problem rather than mitigating it.
     The unit furthest from its Brigadier has nothing depending on it, so it can
     always go first safely; once it has moved, the next-furthest is now the
     outermost, and so on inward.
  
     The Brigadier is first of all, ahead of everyone: he is the anchor, and the
     rest need a freshly-moved anchor to path toward rather than chasing where
     he used to be. -Infinity rather than a small number, so no distance can
     ever sort a unit ahead of him.
  
     Type priority stays as the final tie-break, and Brigades are still grouped
     left to right so the camera can follow one at a time. */
  const brigadierOf = {};
  for(const bId of new Set(units.map(u=>u.brigadeId))){
    brigadierOf[bId] = units.find(u=>u.brigadeId===bId && u.type==='BRIGADIER') || null;
  }
  const chainDepth = u => {
    if(u.type==='BRIGADIER') return -Infinity;
    const brig = brigadierOf[u.brigadeId];
    return brig ? -chebyshev(u, brig) : 0;   // negated, so furthest sorts first
  };
  
  return units
    .sort((a,b)=> (brigadeX[a.brigadeId]-brigadeX[b.brigadeId])
               || (chainDepth(a)-chainDepth(b))
               || (pri[a.type]-pri[b.type]))
    .map(u=>u.id);
}

export function nearestEnemyDist(pos, side){
  const enemy = side===SIDES.RED ? SIDES.BLUE : SIDES.RED;
  let best = 999;
  for(const e of state.units){
    if(e.removed || e.side!==enemy || isConcealedFromEnemy(e)) continue;
    const d = chebyshev(pos, e);
    if(d<best) best = d;
  }
  return best;
}

// Section 9, selective lookahead: for the move categories the brief singles out
// (a candidate square that would put u in a fight next turn, a charge, or pulling
// a Reserve/Fix-mission unit into contact), estimate the worst plausible immediate
// enemy reply rather than just the static threatPenalty count. Generalises the
// same expected-margin approach simulateFightAftermathScore already uses for
// fights — call with u already sitting at the candidate square (the loop in
// aiDecideAndExecuteMove already does this temporarily, same as threatPenalty).
export function lookaheadMovePenalty(u, side){
  if(state.aiDifficulty!=='hard') return 0;
  const enemy = otherSide(side);
  const EV_BY_DICE = {1:3.5, 2:4.47};
  let worst = 0;
  for(const e of state.units){
    if(e.removed || e.side!==enemy || isConcealedFromEnemy(e)) continue;
    const eType = UNIT_TYPES[e.type];
    if(!eType.canFight) continue;
    const reach = unitBaseMove(e) + 1; // move then engage, mirrors threatPenalty's reach
    if(chebyshev(e,u) > reach) continue;
    const eDice = combatBonuses(e, u, false).dice;
    const uDice = combatBonuses(u, e, true).dice;
    const margin = (EV_BY_DICE[Math.min(eDice,2)]||3.5) - (EV_BY_DICE[Math.min(uDice,2)]||3.5);
    let loss = 0;
    if(margin >= 3) loss = AI_UNIT_VALUE[u.type];        // likely removed outright
    else if(margin >= 1) loss = AI_UNIT_VALUE[u.type]*0.35; // likely pushed back/turnOnly
    if(loss > worst) worst = loss;
  }
  return worst;
}

// Cached per (side, turn) — findVulnerableEnemyUnits is cheap but there's no
// reason to recompute it for every one of a side's dozen-odd units in the
// same move phase, when the board hasn't changed between them starting.
function getVulnerableEnemyUnits(side){
  const cache = state._aiVulnCache;
  if(cache && cache.side===side && cache.turn===state.turnNumber) return cache.list;
  const list = findVulnerableEnemyUnits(side);
  state._aiVulnCache = { side, turn: state.turnNumber, list };
  return list;
}

/* THE CAVALRY SCHWERPUNKT: one point, chosen for the whole side's horse.

   vulnerableTargetPullBonus pulls each unit toward ITS OWN nearest weak enemy,
   which for cavalry means two squadrons on opposite wings are each pulled to a
   different target and neither arrives in strength. Cavalry is the arm that
   only works concentrated: a single squadron trades itself for nothing, two
   together break a flank.

   Weakness is measured as the brief specifies, by how well supported a unit is
   rather than how close it happens to be: friendly units near it, and how near
   its own Brigadier is (a unit its Brigadier has left behind cannot be
   reinforced and, if the chain is broken, cannot even withdraw).

   Cached per (side, turn) so every squadron in a turn aims at the same point.
   Recomputed next turn, so it follows the battle rather than fixating. */
/* GO FOR THE KILL: pull toward an enemy Brigade that is nearly broken.

   brigadeBreakBonus already understands that taking a Brigade's last unit is
   worth 6, but it is only ever consulted in FIGHT scoring, once a unit is
   already adjacent. Nothing pulled the army TOWARD such a Brigade, so the AI
   would finish a kill it happened to be standing next to and ignore one two
   squares away. Breaking two Brigades wins the battle, so a Brigade on its last
   unit is the single most valuable thing on the board and should be worth
   crossing ground for.

   Cached per (side, turn) like the other per-turn reads. */
function killTarget(side){
  const cache = state._aiKillCache;
  if(cache && cache.side===side && cache.turn===state.turnNumber) return cache.hit;
  const enemy = otherSide(side);
  const byBrigade = new Map();
  for(const o of state.units){
    if(o.removed || o.side!==enemy || o.type==='BRIGADIER') continue;
    if(!byBrigade.has(o.brigadeId)) byBrigade.set(o.brigadeId, []);
    byBrigade.get(o.brigadeId).push(o);
  }
  let hit = null, best = 0;
  for(const [, members] of byBrigade){
    // 1 unit left: taking it breaks the Brigade. 2 left: one hit from breaking.
    const worth = members.length===1 ? KILL_PULL_LAST_UNIT
                : members.length===2 ? KILL_PULL_PENULTIMATE : 0;
    if(worth > best){
      best = worth;
      hit = { unit: members.reduce((a,b)=> (b.turnOnly||b.rallying) && !(a.turnOnly||a.rallying) ? b : a, members[0]),
              worth };
    }
  }
  state._aiKillCache = { side, turn: state.turnNumber, hit };
  return hit;
}

/* WHERE THE BATTLE IS.

   Once first contact is made, Brigades should pull toward it rather than
   continuing on independent axes. Logged matches show the opposite: the French
   fight three separate small actions while the player concentrates, and loses
   all three.

   The contact point is the midpoint of every square where the two sides are
   actually adjacent, so it is the centre of the fighting rather than the centre
   of the army. Cached per (side, turn), and null before first contact, which is
   correct: there is nothing to converge on during the approach.
========================================================= */
function contactPoint(side){
  const cache = state._aiContactCache;
  if(cache && cache.side===side && cache.turn===state.turnNumber) return cache.point;
  const enemy = otherSide(side);
  let sx=0, sy=0, n=0;
  for(const u of state.units){
    if(u.removed || u.side!==side) continue;
    for(const o of state.units){
      if(o.removed || o.side!==enemy) continue;
      if(!isAdjacent(u,o)) continue;
      sx += (u.x+o.x)/2; sy += (u.y+o.y)/2; n++;
      break;
    }
  }
  const point = n ? { x:sx/n, y:sy/n } : null;
  state._aiContactCache = { side, turn: state.turnNumber, point };
  return point;
}

/* PHASED TEMPO: build, hold, commit.

   The player's two decisive breakthroughs across the logs are the same shape: a
   wide parallel advance, a deliberate pause while the artillery works, then
   every Brigade forward at once. The AI has no rhythm at all: each Brigade
   closes when it individually feels like it, so its attacks arrive one at a time
   and are beaten one at a time.

   BUILD   advance on a wide front, no committed attacks
   HOLD    a pause: guns work, the enemy is invited forward, position consolidates
   COMMIT  one general advance, every Brigade together

   HOLD IS HARD-BOUNDED, and that bound is the important part. A pause with a
   soft exit is indistinguishable from the frozen-Brigade failure that took
   several matches to diagnose, so it ends at TEMPO_COMMIT_TURN whatever else is
   true, and ends early if the enemy closes or a Brigade is one break from going.
   The AI can be made deliberate; it must not be made passive. */
export const TEMPO_HOLD_FROM = 6;     // no pause before this: the armies are not in touch yet
export const TEMPO_COMMIT_TURN = 14;  // hard ceiling on the pause
export const TEMPO_PULL = { BUILD: 1.0, HOLD: 0.4, COMMIT: 1.7 };

function tempoPhase(side){
  const cache = state._aiTempoCache;
  if(cache && cache.side===side && cache.turn===state.turnNumber) return cache.phase;
  let phase;
  if(state.turnNumber >= TEMPO_COMMIT_TURN) phase = 'COMMIT';
  else if(state._aiPlan[side] && state._aiPlan[side].type==='FINISHING_BLOW') phase = 'COMMIT';
  else if(state.turnNumber < TEMPO_HOLD_FROM) phase = 'BUILD';
  else if(contactPoint(side)) phase = 'COMMIT';   // they came to us; the pause is over
  else phase = 'HOLD';
  state._aiTempoCache = { side, turn: state.turnNumber, phase };
  return phase;
}

/* IS THIS GUN EARNING ITS ISOLATION?

   A battery is scored like everyone else for breaking the Brigadier's chain,
   which is wrong for artillery specifically. A gun on a rise with the enemy in
   front of it is doing its job whether or not anyone is holding its hand, and
   dragging it back into the chain gives up the position for nothing.

   A gun EARNS its isolation by having targets, or by holding ground worth
   denying: woods or a building an attacker would otherwise take, or ground
   alongside its own infantry that would be uncovered if it left.

   The inverse matters as much. A gun with nothing to shoot and no ground worth
   holding is not being bold, it is stranded, and that is what should bring the
   Brigadier over. */
/* ARTILLERY VANTAGE POINTS.

   A gun's whole job is to find one good position and fire from it for the rest
   of the match. Previously it had no concept of a position at all: it was
   rewarded for STAYING somewhere decent, but never for going and finding
   somewhere decent, so where a battery ended up was an accident of whatever the
   general advance terms happened to do.

   A vantage point is judged on two things, in order:

     1. SUSTAINED targets. Not what it can hit this turn, but how many enemy
        units are within range and likely to still be there: a position covering
        a crowded sector keeps firing turn after turn, and one covering a single
        passing unit does not. TWO is the minimum that counts, because one target
        is a shot, not a position.

     2. Defensive value. A building gives +1 in defence, and a hill lets the gun
        fire over friendly units and obstacles. Both matter, but neither is worth
        as much as having something to shoot at.

   COHESION IS TWO-PHASE, and that is the part the old code could not express. A
   gun ON THE MOVE needs its Brigadier's chain, or it cannot move at all. A gun
   ESTABLISHED at a vantage point does not: it should hold the position and fire,
   and being dragged back into the chain gives up the ground for nothing.

   Judged per gun, not per side. Two batteries may sit at different vantage
   points in different Brigades, and one being established says nothing about the
   other. */
export const GUN_MIN_SUSTAINED_TARGETS = 2;  // one target is a shot, not a position
export const GUN_VANTAGE_SEEK_PULL = 0.55;   // per square, toward the best vantage found
/* How much better a square must be before an ESTABLISHED gun will give up its
   shot to move there. A gun may move OR fire, so repositioning always costs a
   turn of fire: the threshold is what stops that being paid for a rounding
   error. 0.6 is roughly one extra target at middling range, or a hill. */
export const GUN_SEEK_IMPROVEMENT = 0.6;

/* =========================================================
   GUN DOCTRINE — how a battery decides to move, as a gunner would

   Written from how Matthew plays his own artillery, and the four rules are his:

   1. ONE ENEMY CLOSING IS AN OPPORTUNITY, NOT A THREAT. You do not pull a
      battery back because a single unit came near: that is a canister shot, and
      canister is the best thing a gun does.

   2. SEVERAL ENEMIES CLOSING IS A THREAT, because a gun fires once a turn. Two
      units inside canister range means one of them reaches you untouched, and a
      gun in melee is the most fragile thing on the board (W5 gives its attacker
      a second die). At that point the gun is worth more alive than the shot is
      worth taking.

   3. ADVANCE EARLY, THEN STOP. A gun may move OR fire, so every reposition costs
      a turn of fire. The time to spend those turns is at the start, before
      anyone is in range to shoot at. After that a battery should be settled and
      should only move for a reason.

   4. DO NOT WALK INTO THE ENEMY'S REACH. Moving to a square within three of an
      enemy invites exactly the melee in rule 2, and is only worth it where your
      own side already holds the ground.

   Together these also relieve a fault neither of them is aimed at. In seed
   104014103 both French batteries advanced ahead of their Brigade, broke the
   command chain, and a disconnected unit CANNOT MOVE: Battery A froze at (1,2)
   from turn 10 to turn 24, Battery B froze at (13,1) until it was destroyed. All
   three command breaks that match were artillery. A gun that stops advancing
   after the opening, and that withdraws toward its own side when crowded, walks
   into that far less often.
========================================================= */
export const GUN_ADVANCE_WINDOW  = 10;   // turns in which a battery may freely go looking for ground
export const GUN_CROWD_RADIUS    = 2;    // canister range: inside this a unit reaches the gun next turn
export const GUN_CROWD_THRESHOLD = 2;    // this many inside that radius and the gun cannot answer them all
export const GUN_APPROACH_GUARD  = 3;    // do not move this close to an enemy without holding the ground

/* How many enemies could be on the gun next turn from a given square. */
export function gunCrowdCount(side, x, y){
  return state.units.filter(o=>!o.removed && o.side!==side && o.type!=='BRIGADIER' &&
    UNIT_TYPES[o.type].canFight && chebyshev({x,y}, o) <= GUN_CROWD_RADIUS).length;
}

/* "Unless I have an overwhelming presence in that area and can afford the risk."
   Counts fighting units on both sides near the square, the gun excluded: it is
   the thing being protected, not part of the protection. */
export function localSuperiority(side, x, y, radius){
  let friend = 0, foe = 0;
  for(const o of state.units){
    if(o.removed || o.type==='BRIGADIER' || !UNIT_TYPES[o.type].canFight) continue;
    if(UNIT_TYPES[o.type].isArtillery) continue;
    if(chebyshev({x,y}, o) > radius) continue;
    if(o.side === side) friend++; else foe++;
  }
  return friend - foe;
}
export const GUN_VANTAGE_SEARCH = 6;         // how far a gun will look for one

/* How good a square would be to settle on. Returns 0 for anywhere that fails the
   sustained-target test, so a gun is never drawn to safe ground with nothing to
   shoot at. */
/* WHAT A SHOT AT RANGE N IS WORTH, 0-1.

   The to-hit number IS the range (needed = dist in the fire path), so a target
   at 6 is a 1-in-6 shot and one at 3 is 2-in-3. vantageScore used to count every
   target as 1.0 regardless, which meant a square seeing three enemies at range 6
   scored exactly the same as one seeing the same three at range 2, and nothing
   in the AI had any reason to close. Both French batteries in the Sep 8 match
   (seed 488332463) sat at the back edge for 23 and 17 turns respectively, and
   this is why: from the scoring's point of view they were already ideally sited.

   Peaks at 3-4 rather than at the best odds available. Range 1-2 is canister and
   hits far more often, but W5 made a gun in melee something attackers get a
   second die against, and 1-2 squares is inside a charge. The curve prices that:
   good odds are not worth being overrun for. Deliberate doctrine, not an
   approximation of the hit table. */
const GUN_RANGE_WORTH = { 1: 0.5, 2: 0.8, 3: 1.0, 4: 1.0, 5: 0.5, 6: 0.25 };
export function rangeWorth(d){ return GUN_RANGE_WORTH[d] || 0; }

/* THE ACTUAL CHANCE OF HITTING AT RANGE d, which is a different question from
   how much we WANT the gun at range d.

   rangeWorth above is doctrine: it peaks at 3-4 because closer is more exposed.
   This is arithmetic: needed = dist, so range 6 hits one time in six. The two
   are used for different decisions. Choosing where to stand is doctrine;
   deciding whether the shot in hand is worth forfeiting a move for is
   arithmetic, and using the doctrine curve for it priced a 1-in-6 shot at a
   quarter of a certain one when it is worth a sixth.

   Canister (range <= 2) rolls two dice to hit, hence the near-certainty. */
const GUN_HIT_CHANCE = { 1: 0.97, 2: 0.97, 3: 0.667, 4: 0.5, 5: 0.333, 6: 0.167 };
export function hitChance(d){ return GUN_HIT_CHANCE[d] || 0; }

/* WHAT A SQUARE IS WORTH TO MOVE TOWARD, as opposed to worth settling on.

   vantageScore answers "could a battery hold this position", and gates on
   GUN_MIN_SUSTAINED_TARGETS so that one fleeting target does not read as a
   position. That gate is right for gunIsEstablished and gunStranded and wrong
   for seeking, and it made gunSeekVantage DEAD CODE: a gun with fewer than two
   targets scored zero on every candidate square so there was nothing to seek
   toward, and a gun with two or more counted as established so seeking was
   suppressed. The term appears in neither the Sep 8 nor the Sep 9 export
   (addScore skips zeros), across two full matches.

   So the seek measure drops the gate and keeps the weighting. One target at a
   good range is a real reason to sidestep; it is simply not a reason to call
   yourself established. */
export function vantageSeekScore(gun, x, y){
  let score = weightedTargetsFromSquare(gun, x, y);
  const terr = terrainAt(x, y);
  if(terr.defenseBonus) score += 0.6;
  if(terr.elevation > 0) score += 0.5;
  return score;
}

export function vantageScore(gun, x, y){
  const targets = targetsFromSquare(gun, x, y);
  /* The GATE is still a raw head-count, so "can this square sustain a position"
     answers the same as it always did and gunIsEstablished / gunStranded keep
     their existing behaviour. Only the SCORE is weighted. */
  if(targets < GUN_MIN_SUSTAINED_TARGETS) return 0;
  const terr = terrainAt(x, y);
  // Targets dominate; ground breaks ties between positions that can both shoot.
  let score = weightedTargetsFromSquare(gun, x, y);
  if(terr.defenseBonus) score += 0.6;   // a building: +1 in defence
  if(terr.elevation > 0) score += 0.5;  // a hill: fires over friendly units
  return score;
}

/* As targetsFromSquare, but each target counts what a shot at it is worth from
   here rather than counting one. Same LOS test, so the two never disagree about
   what is visible — only about what it is worth. */
export function weightedTargetsFromSquare(gun, x, y){
  const probe = { x, y };
  let n = 0;
  for(const o of state.units){
    if(o.removed || o.side === gun.side) continue;
    if(o.type === 'BRIGADIER') continue;
    if(isConcealedFromEnemy(o)) continue;
    if(hasLOS(probe, o)) n += rangeWorth(chebyshev(probe, o));
  }
  return n;
}

/* Enemy units within firing range of a square, whether or not the gun is there
   now. artilleryTargets only answers for the gun's CURRENT square, which cannot
   tell it whether somewhere else would be better. */
export function targetsFromSquare(gun, x, y){
  /* Asks hasLOS about the HYPOTHETICAL square rather than approximating with a
     radius. hasLOS already encodes range, blocking terrain, intervening units and
     the overhead-fire rule that lets a gun on high ground shoot over them, so
     using it means the AI's idea of a firing position matches the one the rules
     will actually apply when it gets there. A radius check would rate a square
     behind a wood as excellent. */
  const probe = { x, y };
  let n = 0;
  for(const o of state.units){
    if(o.removed || o.side === gun.side) continue;
    if(o.type === 'BRIGADIER') continue;          // guns cannot target Brigadiers
    if(isConcealedFromEnemy(o)) continue;         // cannot shoot what it cannot see
    if(hasLOS(probe, o)) n++;
  }
  return n;
}

/* Established means: standing on a square that still earns its keep. The moment
   it stops earning it — fewer than two targets left in range, the sector having
   moved on — the gun stops being established and cohesion matters again. */
export function gunIsEstablished(gun){
  if(!UNIT_TYPES[gun.type].isArtillery) return false;
  return vantageScore(gun, gun.x, gun.y) > 0;
}

/* Superseded by GUN_MIN_SUSTAINED_TARGETS. The old rule accepted a SINGLE target
   as justification for a gun standing alone, which is a shot rather than a
   position: the battery would plant itself wherever one enemy happened to wander
   into arc, then be stranded when that unit moved on. Two sustained targets is
   the test now. */
// Holding a good position alone is worth about what breaking the chain costs
// everyone else, so a gun with a field of fire will choose to stay put.
export const GUN_VANTAGE_BONUS = 2.0;
/* How near a Brigadier must already be before collecting a stranded gun becomes
   his business. Beyond this it is someone else's problem: crossing the board for
   one gun is how a Brigade's plan gets quietly abandoned. */
export const GUN_RECOVERY_RANGE = 6;
// Below APPROACH_PULL (0.16) on purpose: an errand, not a mission.
export const GUN_RECOVERY_PULL = 0.13;


/* A gun the Brigadier should come and collect: cut off, nothing to shoot, and
   no ground worth denying. */
export function gunIsStranded(gun){
  if(!UNIT_TYPES[gun.type].isArtillery) return false;
  if(movableUnitsForSide(gun.side).has(gun.id)) return false;
  /* Stranded means cut off AND not earning it. An ESTABLISHED gun is left
     alone however isolated it looks: it is doing exactly what a battery is
     for, and collecting it would give up the position. The moment it drops
     below two sustained targets it stops being established, and the Brigadier
     comes for it. */
  return !gunIsEstablished(gun);
}

function cavalrySchwerpunkt(side){
  const cache = state._aiCavTargetCache;
  if(cache && cache.side===side && cache.turn===state.turnNumber) return cache.target;
  const enemy = otherSide(side);
  const foes = state.units.filter(o=>!o.removed && o.side===enemy &&
    o.type!=='BRIGADIER' && UNIT_TYPES[o.type].canFight && !isConcealedFromEnemy(o));
  let target = null, bestWeakness = -Infinity;
  for(const f of foes){
    const support = state.units.filter(o=>!o.removed && o.side===enemy && o.id!==f.id &&
      o.type!=='BRIGADIER' && chebyshev(o,f)<=2).length;
    const brig = state.units.find(o=>!o.removed && o.side===enemy &&
      o.type==='BRIGADIER' && o.brigadeId===f.brigadeId);
    const brigDist = brig ? chebyshev(brig,f) : 12;   // no Brigadier at all is the weakest case
    const weakness = brigDist - support*2;
    if(weakness > bestWeakness){ bestWeakness = weakness; target = f; }
  }
  state._aiCavTargetCache = { side, turn: state.turnNumber, target };
  return target;
}

/* SCORE RECORDERS.

   The move scorer used to accumulate a single running total, so a log could say
   which square a unit chose but never why. Six matches of analysis produced
   repeated conclusions of the form "the Brigade did nothing for twenty turns"
   with no way to tell whether Hold genuinely scored highest, whether the
   alternatives were filtered out before scoring, or whether the mission pull was
   simply zero.

   Each contribution now names itself on the way past. These return the value
   unchanged, so the arithmetic is exactly what it was: the total cannot drift
   from the components because the components ARE the total.

   Zero contributions are skipped, or every candidate would carry two dozen
   empty entries and the interesting ones would be lost in them. */
function addScore(parts, key, v){ if(v) parts[key] = (parts[key]||0) + v; return v; }
function subScore(parts, key, v){ if(v) parts[key] = (parts[key]||0) - v; return v; }

export function aiDecideAndExecuteMove(u){
  if(u.removed || u.turnOnly) return;
  const side = u.side;
  const t = UNIT_TYPES[u.type];
  const connectedBefore = movableUnitsForSide(side).has(u.id);
  const startX = u.x, startY = u.y;
  /* Filled in by the candidate loop below, and null for actions that never
     scored candidates (Form Square, Lay Ambush, Stand Down). That is correct:
     there is nothing to break down. */
  let decisionForLog = null;
  function recordMove(action, to){
    state._aiMoveHistory[side].push({
      turn: state.turnNumber, unit: unitLabel(u), type: u.type, brigadeId: u.brigadeId,
      mission: missionFor(u), action, from: {x:startX, y:startY}, to: to || null,
      connectedBefore, connectedAfter: movableUnitsForSide(side).has(u.id),
      decision: decisionForLog,
    });
  }

  if(u.formation==='square'){
    // Reconsider every phase: leaving Square costs this whole move phase (per rulebook),
    // so only bother once the threat that justified it has actually passed.
    //
    // The old gate was threatPenalty < 0.8, the same type-blind number that
    // formed the square. A unit ringed by infantry therefore had a high threat
    // reading that both put it into Square and kept it there, immobile, until
    // it was destroyed where it stood. Squares held for ten-plus turns against
    // infantry and guns are a substantial share of the AI's losses.
    //
    // Now: no cavalry able to reach it for SQUARE_BREAK_TURNS consecutive turns
    // and it reforms Line regardless of how much other pressure it is under,
    // because against everything except cavalry the Square is the thing making
    // it worse off.
    const cavNear = cavalryThreatWithinCharge(u, side);
    u.squareNoCavTurns = cavNear ? 0 : (u.squareNoCavTurns || 0) + 1;
    const strandedInSquare = u.squareNoCavTurns >= SQUARE_BREAK_TURNS;
    if(strandedInSquare || threatPenalty(u, side) < 0.8){
      u.formation = 'line';
      logReplay('formation', { unitId:u.id, side:u.side, x:u.x, y:u.y, to:'line', by:'ai' });
      u.squareNoCavTurns = 0;
      state.moved.add(u.id);
      log(`${unitLabel(u)} (${SIDE_LABEL[side]}) reforms Line, no longer threatened.`, side);
      recordMove('Reform Line');
    } else {
      recordMove('Hold (Square)');
    }
    return; // whether it left Square or stayed, a squared unit takes no other move action this phase
  }

  const candidates = [{x:u.x,y:u.y,stay:true}].concat(legalMoves(u));
  const seekTactics = state.aiDifficulty !== 'easy';

  // Hard only: lay an ambush instead of advancing, when an enemy is close enough
  // to plausibly walk into it but not already close enough that fighting normally
  // is clearly better. A first-pass heuristic, not a deep tactical read.
  // Stand down from an ambush nobody walked into.
  //
  // u.hidden appeared exactly ONCE in this file before now: the line that sets
  // it. Nothing ever read it back, so a unit that hid in a wood the enemy had no
  // reason to approach was removed from the battle permanently. It cannot move
  // (canLayAmbush refuses while hidden, and the scoring loop never reconsiders),
  // it cannot be seen, and it waits for a spring that will never come. Three
  // logged matches show ambushes laid and none ever triggered.
  //
  // The mechanism itself is sound (endMovePhase -> collectAmbushSprings resolves
  // correctly from both sides). What was missing is a way out.
  if(u.hidden){
    const nearNow = nearestEnemyDist(u, side);
    u.ambushWaited = (nearNow <= AMBUSH_STANDDOWN_RANGE) ? 0 : (u.ambushWaited || 0) + 1;
    if(u.ambushWaited >= AMBUSH_STANDDOWN_TURNS){
      u.hidden = false;
      u.ambushWaited = 0;
      /* COOLDOWN, and this is the whole bug. Standing down only cleared the
         hidden flag, so the very next time the unit was scored it met the same
         board, judged an ambush worthwhile again, and hid on the same square.
         The logged match shows 1er Grenadiers and 17e Legere doing exactly that
         every six turns from turn 4 to turn 56: set, stand down, set again,
         never once moving. Two of Napoleon's four fighting units spent the
         entire battle in that loop, which is a large part of why his Brigade
         did nothing.

         The unit now has to rejoin the battle for a while before it may hide
         again. */
      u.ambushCooldown = AMBUSH_COOLDOWN_TURNS;
      logReplay('ambush', { unitId:u.id, side:u.side, x:u.x, y:u.y, phase:'standDown',
        reason:`no enemy within ${AMBUSH_STANDDOWN_RANGE} for ${AMBUSH_STANDDOWN_TURNS} turns` });
      log(`${unitLabel(u)} (${SIDE_LABEL[side]}) breaks cover, the ambush unsprung.`, side);
      logAiDebugMove(side, { unit: unitLabel(u), mission: missionFor(u), action:'Stand Down',
        reason:`no enemy within ${AMBUSH_STANDDOWN_RANGE} for ${AMBUSH_STANDDOWN_TURNS} turns` });
      // Falls through to normal move scoring this turn rather than idling again.
    } else {
      return; // still lying in wait, and something is still plausibly coming
    }
  }

  // Tick the cooldown down once per AI turn for this unit.
  if(u.ambushCooldown > 0) u.ambushCooldown -= 1;

  if(state.aiDifficulty==='hard' && !u.ambushCooldown && canLayAmbush(u)){
    const near = nearestEnemyDist(u, side);
    if(near>=2 && near<=5){
      u.hidden = true;
      u.ambushWaited = 0;
      logReplay('ambush', { unitId:u.id, side:u.side, x:u.x, y:u.y, phase:'set', by:'ai' });
      state.moved.add(u.id);
      log(`${unitLabel(u)} (${SIDE_LABEL[side]}) lies in ambush, sensing the enemy closing in.`, side);
      logAiDebugMove(side, { unit: unitLabel(u), mission: missionFor(u), action:'Lay Ambush', reason:`nearest enemy ${near} squares away` });
      recordMove('Lay Ambush');
      return;
    }
  }

  let best = candidates[0], bestScore = -Infinity;
  const isReserveType = t.key==='GUARD' || (t.isCavalry && t.key==='HEAVY_CAV');
  const mission = state.aiDifficulty==='hard' ? missionFor(u) : null;
  const plan = state.aiDifficulty==='hard' ? state._aiPlan[side] : null;
  // RESERVE mission supersedes the old static isReserveType/reserveCrisisExists gate when a
  // mission exists — a Guard unit assigned MAIN_ATTACK should never be held back, and a
  // non-Guard unit assigned RESERVE should be, which the old type-only check couldn't express.
  const holdingReserve = mission ? (mission==='RESERVE' && !reserveCrisisExists(side))
    : (state.aiDifficulty==='hard' && isReserveType && !reserveCrisisExists(side));
  /* R6: a PRESERVE Brigade never initiates. It defends normally if attacked and
     still rallies, but nothing pays it to look for a fight, because the whole
     value of the Brigade now lies in continuing to exist. */
  const preserving = mission === 'PRESERVE';
  const boggedTarget = (state.aiDifficulty==='hard' && t.isCavalry) ? findBoggedEnemyGun(side) : null;
  const wasConnected = connectedBefore; // captured before any candidate is tried, at the unit's real starting position
  const currentlyThreatened = threatPenalty(u, side) >= 1.2; // at the unit's real starting position, before any candidate is tried
  const selfPreservation = seekTactics && isIsolatedAndThreatened(u, side); // also at the real starting position
  // Every candidate's breakdown, kept so the chosen move and its rivals can
  // be compared. Per unit, not per match: only the current decision matters
  // and holding them all would grow without bound.
  const scored = [];
  for(const c of candidates){
    const ox=u.x, oy=u.y;
    u.x=c.x; u.y=c.y;
    const parts = {};
    /* BASE_STATE_WEIGHT: the fix for a 93% Hold rate.

         evaluateState is a whole-board safety read, and moving toward the enemy
         always makes it worse. Measured across a real match, it varied by 0.79
         between rival squares and decided more moves than any other term, while
         every intent term (mission 0.51, cavalry 0.56, converge 0.15, advance
         0.16) is a per-square distance gradient worth a fraction of that. Even
         combined they came to roughly half a point against its 0.79.

         So the AI wanted to advance and something bigger and quieter kept
         vetoing it. That is why fixing the mission cliff, adding the kill pull
         and adding converge-after-contact each changed behaviour so little:
         every one of them was an order of magnitude too small to be heard.

         At 0.35 its spread drops to about 0.28, in the same range as the terms
         it was drowning. This demotes it from decider to contributor rather than
         removing it.

         threatPenalty is deliberately left at FULL weight: a unit stepping into
         immediate danger should still notice. What stops is the vague
         board-wide unease that was vetoing every advance. */
      let s = addScore(parts, 'baseState', evaluateState(side) * BASE_STATE_WEIGHT)
            + addScore(parts, 'threat', Math.max(-THREAT_SCORE_MAX, -0.5*threatPenalty(u, side)));
    // A currently-cohesive unit stranding itself is worse than evaluateState's flat
    // per-unit disconnection penalty alone accounts for — that penalty also applies
    // to a unit that was ALREADY stuck, so on its own it's nowhere near enough to
    // outweigh a Charge's +2.2 (or more, stacked with a Column combo/mission bonus).
    // This is what let a charge strand a Cavalry unit turn after turn — the charge
    // always scored higher despite cutting the unit off from its Brigadier for good.
    const connNow = movableUnitsForSide(side);
    // Artillery is exempt — neither canInitiateFight nor fireArtillery check
    // connectivity, so a gun that's found a genuinely good firing position can
    // keep firing indefinitely after its Brigade advances past it, with no need
    // to move again at all. Artillery also moves last within its own Brigade
    // (see orderAiUnitsForMove), so by the time it decides, the rest of the
    // Brigade has usually already moved — without this exemption, simply
    // staying in a great spot was scoring as a fresh self-inflicted
    // disconnection every single turn, pushing the AI to keep dragging its guns
    // forward to keep pace instead of letting them settle and fire.
    /* Artillery was already exempt from the cohesion penalty, but only because
       guns cannot move and fire in the same turn. Now it is exempt for a reason:
       a gun with targets, or on ground worth denying, is doing its job alone and
       is positively rewarded for holding there rather than merely not punished.
       A gun with neither takes the penalty like anyone else, because it is
       stranded rather than bold. */
    if(wasConnected && !connNow.has(u.id)){
      if(!t.isArtillery) s -= subScore(parts, 'cohesionLoss', 2.4);
      /* S7: DISCONNECTING FOR NOTHING COSTS EXTRA.

         Disconnections ran 1.5% -> 8% -> 11% across three matches. cohesionLoss
         at 2.4 is deliberately clearable, and has to be: S4 raises engage to
         +4.3 for a genuinely good fight, and a unit SHOULD leave its Brigadier's
         chain to destroy an exposed battery. Raising cohesionLoss would undo
         that, which is why the brief says not to touch it.

         The units actually going missing are not doing that. They drift off the
         chain for terrain, ground denial or mission pull, gaining nothing worth
         the isolation, and then cannot move at all until the Brigadier catches
         up. So the extra cost is charged only when the move creates no fight:
         reachable enemies from the candidate square, not a general threat
         count.

         Result: breaking cohesion for a target stays affordable at 2.4, and
         breaking it for scenery costs 4.0, which nothing else in the scoring
         can clear. */
      const buysAFight = state.units.some(o=>!o.removed && o.side!==side &&
        isAdjacent(c, o) && canAttackTarget(u, o));
      if(!t.isArtillery && !buysAFight) s -= subScore(parts, 'cohesionDrift', 1.6);
    /* Judged on the CANDIDATE square, not the gun's current one, so a move INTO
       a vantage point counts as established and is not penalised for arriving
       out of contact. The old test asked where the gun already stood, so a
       battery could never move to a better position that was off the chain. */
      else if(!vantageScore(u, c.x, c.y)) s -= subScore(parts, 'gunStranded', 2.4);
    }
    if(t.isArtillery && !connNow.has(u.id) && vantageScore(u, c.x, c.y) > 0){
      /* Range-scaled for the same reason as gunGoodGround: this exists to let a
         gun stay off the cohesion chain when it has a real field of fire, not to
         pay it for being far away with a nominal one. */
      s += addScore(parts, 'gunVantage', GUN_VANTAGE_BONUS * rangeWorth(nearestEnemyDist(c, side)));
    }
    // A Brigadier is always "connected" to itself by definition (see
    // movableUnitsForSide — the chain starts FROM the Brigadier), so the penalty
    // above can never fire for a Brigadier choosing to hold still. That's exactly
    // how a stationary Brigadier ends up stranding its own advancing Brigade
    // without ever itself being flagged as the cause — confirmed directly from a
    // move log: a Brigadier camped in place for a dozen-plus turns while two of
    // its own units pushed on ahead and lost their chain back to it. A Brigadier's
    // candidate squares are scored instead by how many of its own Brigade-mates
    // that position would keep connected, so it actively follows its most
    // advanced units rather than anchoring the whole Brigade to where it started.
    if(t.key==='BRIGADIER'){
      const brigadeMates = state.units.filter(o=>!o.removed && o.side===side && o.brigadeId===u.brigadeId && o.id!==u.id);
      if(brigadeMates.length === 0){
        /* His Brigade is gone. With nothing to trail he has no anchor at all, so
           the trailing rule above cannot help and he drifts wherever the
           incidental terms take him: logged matches show Soult walking alone
           into the British deployment zone. He now falls back on the nearest
           friendly Brigadier instead, which keeps him alive and near the army
           rather than wandering into the guns. */
        const otherBrig = state.units.find(o=>!o.removed && o.side===side &&
          o.type==='BRIGADIER' && o.id!==u.id);
        if(otherBrig){
          s -= subScore(parts, 'orphanFallback', chebyshev(c, otherBrig) * ORPHAN_BRIGADIER_PULL);
        }
        if(state.units.some(o=>!o.removed && o.side!==side && isAdjacent(c,o))){
          s -= subScore(parts, 'brigadierContact', BRIGADIER_CONTACT_PENALTY);
        }
      }
      /* COLLECTING A STRANDED GUN. Deliberately a pull on the Brigadier's own
         movement rather than a change of mission: the Brigade keeps doing what
         it was doing, and its Brigadier drifts toward the gun as he goes. It
         only bites when the two are already fairly close, so he tidies up a gun
         he happens to be near rather than marching across the board for it and
         abandoning the plan.

         A gun with a field of fire is NOT collected: it is where it should be,
         and gunIsEstablished already keeps it there. */
      const strandedGun = state.units.find(o => !o.removed && o.side===side &&
        o.brigadeId===u.brigadeId && gunIsStranded(o));
      if(strandedGun && chebyshev(u, strandedGun) <= GUN_RECOVERY_RANGE){
        s -= subScore(parts, 'collectStrandedGun',
          chebyshev(c, strandedGun) * GUN_RECOVERY_PULL);
      }

      if(brigadeMates.length > 0){
        const connectedCount = brigadeMates.filter(o=>connNow.has(o.id)).length;
        s += addScore(parts, 'cohesionGain', connectedCount * 0.5);

        /* TRAIL THE LINE. A Brigadier is a chain-of-command marker, not a
           fighting man: he cannot attack, cannot be attacked, and carries his
           Brigade's single Leadership Roll. His whole job is to stay close
           enough to keep the cohesion chain intact so his units can move at all.

           He was being scored like a combat unit, picking up the generic
           "close on the nearest enemy" pull below, which is why French
           Brigadiers wander onto independent axes while Wellington, Graham and
           Uxbridge sit where they are needed. Now he is held a short distance
           behind whichever of his units is furthest forward. */
        const forwardMost = brigadeMates.reduce((best,o)=>
          nearestEnemyDist(o, side) < nearestEnemyDist(best, side) ? o : best, brigadeMates[0]);
        const gap = chebyshev(c, forwardMost);
        const off = gap < BRIGADIER_TRAIL_MIN ? (BRIGADIER_TRAIL_MIN - gap)
                  : gap > BRIGADIER_TRAIL_MAX ? (gap - BRIGADIER_TRAIL_MAX) : 0;
        s -= subScore(parts, 'brigadierTrail', off * BRIGADIER_TRAIL_WEIGHT);

        // Never in contact. He cannot be attacked, but standing in the enemy's
        // face puts the Brigade's only Leadership Roll where the line will move
        // through it, and blocks a square his own units may need.
        if(state.units.some(o=>!o.removed && o.side!==side && isAdjacent(c,o))){
          s -= subScore(parts, 'brigadierContact', BRIGADIER_CONTACT_PENALTY);
        }
      }
    }
    // Without some positional pull, every "safe" square scores identically and the
    // AI never closes to fight. Infantry/cavalry are pulled toward the nearest enemy;
    // artillery is pulled toward its ideal firing band (3-5 squares) instead.
    // Reserve Doctrine (Hard): suppress this pull for a held-back Guard/Heavy
    // Cavalry unit until a real crisis exists, so it doesn't rush the opening exchanges.
    // Self-preservation (below) suppresses it too — an isolated, threatened unit
    // should be falling back toward support, not still being pulled forward alone.
    // Brigadiers excluded: they have their own trailing rule above, and taking
    // this pull as well is what sent them off on independent paths toward the
    // enemy instead of following their own Brigade.
    /* R2: ARTILLERY IS EXEMPT FROM THE RESERVE SUPPRESSION.

       A reserve Brigade holds its foot back; its guns should still go forward to
       a firing position, because a battery parked on the baseline contributes
       nothing to a reserve's purpose and is the single easiest thing a held-back
       Brigade CAN do usefully. Only the gunStandoff branch below is reached in
       that case, which is the band pull, not an advance to contact.

       PRESERVE suppresses everything including the guns: that Brigade is not
       trying to influence the battle at all. */
    if((!holdingReserve || t.isArtillery) && !preserving && !selfPreservation && t.key!=='BRIGADIER'){
      if(t.isArtillery){
        const d = nearestEnemyDist(c, side);
        /* Was Math.abs(d-4) * 0.06, which pointed at the right band and could
           not reach it: across the whole Sep 8 match it produced a spread of
           0.07, against gunHasShot's 2.82. A term that never separates two
           squares by more than a rounding error decides nothing, however
           correct its direction.

           Now a flat-bottomed band at 3-4 with a coefficient that can actually
           move a decision. Flat rather than a point at 4 so the gun is not
           dragged off a good square at 3 for an equal one at 4. */
        /* RULE 2: CROWDED MEANS WITHDRAW, and it is measured per candidate square
           so the withdrawal has somewhere to go rather than just a reason.

           One enemy inside canister range scores NOTHING either way: that is the
           shot the gun wants and it should stand and take it. Two is the point
           where a gun that fires once a turn cannot answer them all, and the
           penalty scales with how many, so a battery with three closing pulls
           back harder than one with two. Squares that reduce the count are
           thereby the attractive ones, which is what makes this a retreat rather
           than only a fear. */
        const crowd = gunCrowdCount(side, c.x, c.y);
        if(crowd >= GUN_CROWD_THRESHOLD){
          s -= subScore(parts, 'gunCrowded', (crowd - GUN_CROWD_THRESHOLD + 1) * 1.3);
        }

        /* RULE 4: DO NOT WALK INTO REACH without holding the ground.

           Only applied to a square the gun is MOVING TO. A gun already sited
           close is covered by rule 2, which is about how many are coming rather
           than how near they are: standing firm for a canister shot must not be
           penalised as though the gun had just walked there. */
        if(!c.stay && d <= GUN_APPROACH_GUARD){
          const edge = localSuperiority(side, c.x, c.y, GUN_APPROACH_GUARD);
          if(edge < 2) s -= subScore(parts, 'gunApproachGuard', (GUN_APPROACH_GUARD - d + 1) * 0.7);
        }

        /* RULE 3: ADVANCE EARLY, THEN ONLY FOR A REASON.

           Every reposition costs a turn of fire, so the turns to spend are the
           opening ones, before anyone is in range to be shot at. After the
           window a settled battery pays to move at all, and the two things that
           excuse it are the two real reasons: being crowded (rule 2, a retreat)
           and a materially better position (gunSeekVantage, which already has
           its own improvement threshold).

           Not a prohibition. It is a cost, so a large enough reason still
           outweighs it, and a gun is never frozen by its own doctrine. */
        const settled = state.turnNumber > GUN_ADVANCE_WINDOW;
        if(settled && !c.stay && crowd < GUN_CROWD_THRESHOLD){
          s -= subScore(parts, 'gunSettled', 1.1);
        }

        /* RULE 1: CLOSE IS NOT PUNISHED ANY MORE.

           bandMiss used to penalise BOTH ends, d<3 as well as d>4, which meant a
           gun sitting at canister range was charged for it. That is the opposite
           of the doctrine: one enemy at two squares is the best shot the gun
           will ever get and it should stand and take it.

           The close end is now rule 4's job, and rule 4 asks the right question.
           It charges for MOVING into reach without holding the ground, and says
           nothing about a gun that is already there. One concern, one mechanism.
           This term is now purely "you are too far to hit anything". */
        const bandMiss = d > 4 ? (d - 4) : 0;
        /* 0.45 -> 0.90. At 0.45 the pull toward the band was smaller than the
           hold bonus a gun forfeits by moving, so a battery with any shot at all
           preferred to keep taking it. This is the term whose entire job is to
           get guns into the band, and it has to be able to pay for one turn of
           lost fire to do it. */
        s -= subScore(parts, 'gunStandoff', bandMiss * 0.90);

        /* SEEKING A VANTAGE POINT. The old logic only rewarded STAYING somewhere
           good, never GOING somewhere good, so where a battery finished up was an
           accident of the general advance terms. A gun that is not established now
           scores each square by what it would be worth to settle on: sustained
           targets first, defensive ground second.
        
           Only while NOT established, so a gun that has found its position is not
           tempted away by a marginally better one. That shuffling between two
           adequate squares is what the logged Battery A did for turns on end. */
        /* SCORED AS AN IMPROVEMENT ON WHERE IT STANDS, not as an absolute.

           The absolute form could not distinguish "this square is good" from
           "this square is good and so is the one I am on", so on top of the dead
           gate above it had no gradient to offer even when it did fire.

           The anti-shuffle intent of the old `!gunIsEstablished` guard is kept,
           but as hysteresis rather than a prohibition: an established gun still
           looks for something better, and only moves for a MEANINGFUL
           improvement. Battery A shuffling between two adequate squares was the
           behaviour to avoid, and a threshold avoids it without also freezing a
           battery into the first place it happened to see two targets from.

           Long-range approach is NOT this term's job. gunStandoff supplies that
           gradient (bandMiss * 0.45 off nearestEnemyDist, which works at any
           distance); this is the local choice of arc once the gun is in the
           area. */
        const hereWorth = vantageSeekScore(u, u.x, u.y);
        const thereWorth = vantageSeekScore(u, c.x, c.y);
        const gain = thereWorth - hereWorth;
        const needed = gunIsEstablished(u) ? GUN_SEEK_IMPROVEMENT : 0;
        if(gain > needed) s += addScore(parts, 'gunSeekVantage', gain * GUN_VANTAGE_SEEK_PULL);
        // Manoeuvre: a gun already well-placed — decent ground, not under real
        // threat, the enemy already within (or close to) firing range — should
        // settle there and keep firing, not repeatedly reposition just to keep
        // pace with the rest of its advancing Brigade. This only rewards
        // STAYING (c.stay), not moving toward such a square, so it doesn't
        // create a new reason to relocate — only a reason to stop once there.
        if(c.stay){
          const terr = terrainAt(c.x, c.y);
          const goodGround = terr.elevation>0 || terr.defenseBonus;
          const safeEnough = threatPenalty(u, side) < 1.4;
          /* B2: SCALED BY RANGE. This was a flat 1.6 for standing on a hill or in
             a building at ANY range out to 6, and it is the largest single gun
             term. A hill six squares from the enemy scored the same as a hill at
             three, so a battery that reached high ground stayed there and shot
             at 1-in-6 for the rest of the match. French Battery A sat on the
             hill at (6,0) in seed 373739702 doing exactly that, and nine of the
             ten range-6 shots in that match were French.

             Elevation and cover are worth having, but they are worth having
             WITHIN RANGE. A gun that cannot hit from its hill is not well sited,
             it is merely comfortable. */
          if(goodGround && safeEnough && d<=6) s += addScore(parts, 'gunGoodGround', 1.6 * rangeWorth(d));

          /* A gun may MOVE OR FIRE, never both in the same turn. So if it has a
             shot from where it stands, repositioning does not merely delay the
             shot, it forfeits it outright.

             The bonus above only rewarded settling on GOOD GROUND (elevation or
             a defence bonus), so a battery with a clear field of fire on flat
             open ground got nothing for staying and kept shuffling. That is the
             logged French Battery A, moving between (0,3) and (1,3) for turns on
             end without ever establishing a firing position.

             Scaled a little by how many targets are available, so a gun with one
             marginal shot is still willing to reposition for a better arc, while
             one covering three units stays put. Gated on not being under real
             threat: a battery about to be overrun should still run. */
          if(safeEnough){
            /* SCALED BY WHAT THE SHOT IS WORTH, not just that one exists.

               This is the strongest gun term in the model (spread 2.82, decided
               17 moves in the Sep 8 match, second only to cohesionLoss), and it
               paid the same hold bonus for a 1-in-6 shot at range 6 as for a
               2-in-3 at range 3. Since move-or-fire means repositioning forfeits
               the shot, that was enough to pin a battery at long range
               indefinitely: it had "a shot", so it stayed, forever.

               Quality comes from the BEST target available, because that is the
               one the gun would actually take. */
            const targets = artilleryTargets(u);
            const shots = targets.length;
            if(shots > 0){
              let best = 0;
              /* hitChance, not rangeWorth. This decides whether to give up the
                 shot in hand to reposition, which is a question about expected
                 damage, not about where we would like the gun to be. The floor
                 is gone with it: a shot so poor it is not worth a move should
                 not be propped up by a minimum. */
              for(const t2 of targets) best = Math.max(best, hitChance(chebyshev(u, t2)));
              s += addScore(parts, 'gunHasShot',
                (GUN_HOLDS_FIRE_BONUS + Math.min(shots, 3) * 0.2) * best);
            }
          }
        }
      } else {
        s -= subScore(parts, 'advancePull', nearestEnemyDist(c, side) * ADVANCE_PULL_WEIGHT);
        // Core Tactic: prefer the road network while actually closing distance
        // — the real +1 movement bonus for starting and ending on road, and
        // the same reason a human player uses roads to move quickly into the
        // enemy's lines rather than cutting cross-country. Only while
        // genuinely advancing — holding/withdrawing have their own separate
        // pulls above, and this one shouldn't compete with them.
        if(seekTactics) s += addScore(parts, 'roadSeek', roadSeekBonus(c.x, c.y));
      }
    }

    // The defensive mirror of the concentration tactic below: an isolated unit
    // under real threat right now falls back toward its own side rather than the
    // AI continuing to press it forward alone — exactly the exposure the AI is
    // now taught to actively punish an enemy unit for standing in.
    if(selfPreservation){
      s += addScore(parts, 'retreatToSupport', Math.max(-RETREAT_SCORE_MAX, retreatToSupportBonus(c, side, u)));
    }

    // Concentrate on a vulnerable (isolated/unsupported) enemy unit specifically,
    // on top of the generic "close on nearest enemy" pull above — several units
    // converging on the same weak point in one turn is what actually punishes an
    // overextended enemy, rather than each unit independently picking whichever
    // enemy happens to be closest to itself.
    /* CONVERGE AFTER CONTACT. Once the armies are engaged somewhere, drifting
       off on an independent axis is how three separate small actions get lost
       one after another. Deliberately weaker than the mission pull, so it bends
       a Brigade's line of advance toward the fighting rather than overriding
       where it was sent. Null before first contact, so the approach is
       unaffected. */
    if(seekTactics && !selfPreservation){
      const contact = contactPoint(side);
      if(contact) s -= subScore(parts, 'convergeOnContact', chebyshev(c, contact) * CONVERGE_PULL);
    }

    /* Closing on a Brigade that is one or two units from breaking. Applies to
       every fighting type including cavalry, and is deliberately NOT suppressed
       by holdingReserve: a reserve exists precisely for the moment the battle can
       be won, and sitting it out while a Brigade is one hit from breaking is the
       reserve doctrine misfiring. */
    if(seekTactics && !selfPreservation && !t.isArtillery){
      const kill = killTarget(side);
      if(kill) s -= subScore(parts, 'killPull', chebyshev(c, kill.unit) * kill.worth);
    }

    if(seekTactics && !holdingReserve && !preserving && !selfPreservation && !t.isArtillery){
      if(t.isCavalry){
        // Cavalry aims at the side's single chosen point rather than each
        // squadron at its own nearest weak enemy, so the horse arrives together.
        const point = cavalrySchwerpunkt(side);
        /* S8: cavalryConcentration reaches 0 when massed, and pays when it can
           mass ON something.

           It was distance * PULL, subtracted. Distance is never negative, so the
           term was never zero and never positive: a permanent tax on every
           cavalry move, functioning only as a tie-break between degrees of
           badness (range -4.76 to -1.12 in the last match). It could not reward
           the behaviour it is named after.

           Now the penalty is only the distance STILL to travel, so arriving at
           the rally point scores exactly 0.00. And when two or more cavalry can
           reach the same enemy this turn, it goes positive, which is the
           concentration the term was always supposed to buy. */
        if(point){
          const gap = chebyshev(c, point);
          if(gap > 0) s -= subScore(parts, 'cavalryConcentration', gap * CAVALRY_CONCENTRATION_PULL);
          const massed = state.units.filter(o=>!o.removed && o.side===side && o.id!==u.id &&
            UNIT_TYPES[o.type].isCavalry && chebyshev(o, point) <= 2).length;
          if(massed >= 1) s += addScore(parts, 'cavalryConcentration', Math.min(2, massed) * 0.6);
        }
        else s += addScore(parts, 'vulnerablePull', vulnerableTargetPullBonus(c, side, getVulnerableEnemyUnits(side)));
      } else {
        s += addScore(parts, 'vulnerablePull', vulnerableTargetPullBonus(c, side, getVulnerableEnemyUnits(side)));
      }
    }

    /* NEVER ATTACK ALONE.

       The single highest-value behaviour in the AI brief. Every British unit
       lost across three logged matches was a solo attacker with no supporting
       unit in reach; almost every French unit destroyed was hit by two or more
       attackers in sequence.

       This has to be a MOVE-phase rule, not a fight-phase one. Fights are
       mandatory: endFightPhase refuses to end while anyFightsAvailable(side) is
       true, so an AI that declined a lone attack once already adjacent would
       loop forever and freeze the turn. The only place a solo engagement can
       actually be avoided is before it exists, by not stepping into contact
       alone in the first place.

       Two exemptions, both from the brief:
         - the target is already turned around or rallying, where finishing it
           denies the rally and is worth the risk
         - the unit is ALREADY in contact, where the decision has been taken and
           declining changes nothing */
    if(seekTactics && !holdingReserve && !preserving){
      const alreadyInContact = state.units.some(o=>!o.removed && o.side!==side &&
        isAdjacent({x:ox,y:oy}, o) && canAttackTarget(u, o));
      if(!alreadyInContact){
        const wouldContact = state.units.filter(o=>!o.removed && o.side!==side &&
          isAdjacent(c, o) && canAttackTarget(u, o));
        for(const target of wouldContact){
          if(target.turnOnly || target.rallying) continue;   // wounded: finish it
          // Would anyone else be able to join this fight this turn?
          if(supportCountFor(target, side, u.id) === 0) s -= subScore(parts, 'soloAttackPenalty', SOLO_ATTACK_PENALTY);
        }
      }
    }

    // Medium+: deliberately seek out a Charge instead of only charging by accident.
    // Also coordinates with an Attack Column already formed this turn (Manoeuvre
    // #19, Hammer and Column) — a charge against the same target the Column is
    // already threatening is worth more than an isolated one.
    let isChargeMove = false;
    if(seekTactics && t.isCavalry && !c.stay && isCleanChargeRun(ox,oy,c.x,c.y)){
      const chargeableTarget = state.units.find(o=>!o.removed && o.side!==side && isAdjacent(c,o) &&
        o.formation!=='square' && terrainAt(o.x,o.y).elevation<=terrainAt(c.x,c.y).elevation);
      if(chargeableTarget){
        isChargeMove = true;
        s += addScore(parts, 'chargeBonus', 2.2);
        if(state.turnComboTarget && state.turnComboTarget===chargeableTarget.id) s += addScore(parts, 'comboTarget', 1.0);
      }
    }
    /* ENGAGE: a reason to take the LAST step into contact.
    
       Only cavalry were ever paid for closing, via chargeBonus. Infantry had
       nothing: they are pulled toward the enemy by distance gradients that go
       quiet at range 1, so they walked up to the enemy and stopped. The result
       is that the player declares nearly every fight and therefore picks every
       matchup. In the last match Britain initiated 22 of 33.
    
       Scaled by the fight the move would actually create, using the same
       estimator the fight phase uses to choose targets. So this is not blanket
       aggression: a good matchup pulls the unit in, a bad one produces a
       negative number and pushes it away.
    
       Skipped when the move is already a charge, or the two would stack and send
       cavalry in on anything. */
    /* W7.3: NEVER END A CAVALRY MOVE NEXT TO A SQUARE.

       The most important of the matchup rules, and it is POSITIONAL rather than
       target selection. Adjacency compels a fight, so cavalry that finishes its
       move beside a square will be FORCED into it next phase at one die against
       two. Declining the attack is not available; the tile has to be avoided.

       The reverse is worth just as much and is deliberately exploited: infantry
       in line is rewarded for taking adjacency to an enemy square, because it
       will be compelled into a fight it is favoured to win (second die under
       Infantry vs Square, and after W4 the square cannot even initiate back).

       Applied to the candidate square rather than to any target, so it shapes
       where units stand and not merely what they choose to hit. */
    if(seekTactics && !c.stay){
      const adjSquare = state.units.some(o=>!o.removed && o.side!==side &&
        o.formation==='square' && isAdjacent(c,o));
      if(adjSquare){
        if(t.isCavalry) s += addScore(parts, 'squareTrap', -3.0);
        else if((t.key==='INFANTRY'||t.key==='GUARD') && u.formation!=='square') s += addScore(parts, 'squareHunt', 1.6);
      }
    }

    /* S4: `isChargeMove` USED TO EXCLUDE THIS BLOCK, and that was the collapse.

       Reported as "engage went the wrong way": maximum value +0.42 against an
       intended +4.0. The weight was not the cause. +0.42 is exactly a level
       fight against a Guard (4*0.25 - 4*0.10 = 0.85, halved by ENGAGE_WEIGHT),
       which means the best fight the AI saw all match was a 1 v 1.

       It could not see better, because every 2 v 1 in the game belongs to
       cavalry closing on infantry, and a cavalry move into contact is a CHARGE.
       Excluding charges excluded exactly the matchups engage exists to find, so
       it only ever scored infantry walking into level fights. chargeBonus is a
       flat 2.2 for any charge at all and cannot tell a good one from a bad one,
       so nothing was reading the matchup.

       The two now coexist: chargeBonus prices the manoeuvre, engage prices the
       fight it creates. A charge into square scores 2.2 - 2.4 and is correctly
       declined; a charge into exposed artillery scores 2.2 + 4.1. */
    if(seekTactics && !c.stay && canInitiateFight(u)){
      const reachable = state.units.filter(o=>!o.removed && o.side!==side &&
        isAdjacent(c,o) && canAttackTarget(u,o));
      if(reachable.length){
        // The BEST fight from this square, not the sum: a unit fights once, so
        // standing next to three enemies is not three times as good.
        /* estimateFightValue, NOT aiEstimateFightValue.
        
           On Hard, aiEstimateFightValue returns simulateFightAftermathScore, which
           is a whole-board evaluation, so engage inherited exactly the unbounded
           scale that baseState had. In one logged match it produced values from
           -27.03 to +8.79 against an intended range of -1.8 to +2.3, and it grew as
           the match went on. That sent units into fights at almost any cost and
           dragged them off their Brigadier's chain to do it: France lost 12 to 4 and
           disconnections doubled to 42.
        
           estimateFightValue is the bounded one: a dice-count edge plus unit values,
           which stays in roughly -2.5 to +4.5 whatever the board looks like. Clamped
           as well, because a term that decides moves should not be able to run away
           again for a reason nobody predicted. */
        /* Chosen on engage + brigadeKillValue together, then reported as two
           terms, so Section 4 can show which of the two actually moved the
           decision rather than burying the win-condition pull inside engage. */
        let bestTarget = null, raw = -Infinity;
        for(const o of reachable){
          const fv = estimateFightValue(u, o);
          const combined = fv + (fv > KILL_VALUE_ENGAGE_FLOOR ? brigadeKillValue(o) : 0);
          if(combined > raw){ raw = combined; bestTarget = o; }
        }
        const rawEngage = bestTarget ? estimateFightValue(u, bestTarget) : 0;
        const best = Math.max(-ENGAGE_CLAMP, Math.min(ENGAGE_CLAMP, rawEngage));
        /* W9: a unit that keeps losing stops looking for new fights.

           Three consecutive defeats is the point a human commander pulls a unit
           out rather than feeding it back in. engage is clamped to zero rather
           than reversed, so the unit does not flee, it simply stops being
           PAID to start anything, which lets retreatToSupport and threat carry
           it back without a new term fighting them for control. */
        const beaten = (u.lossStreak || 0) >= 3;
        s += addScore(parts, 'engage', (beaten ? Math.min(0, best) : best) * ENGAGE_WEIGHT);
        if(beaten) s += addScore(parts, 'disengage', -0.5 * Math.min(5, u.lossStreak));
        if(!beaten && bestTarget && best > KILL_VALUE_ENGAGE_FLOOR){
          s += addScore(parts, 'brigadeKillValue', brigadeKillValue(bestTarget));
        }
      }
    }

    // Medium+: deliberately form an Attack Column ahead of a fight it can already see coming,
    // instead of doubling up only as an accidental byproduct of two units picking the same square.
    if(seekTactics && (t.key==='INFANTRY'||t.key==='GUARD') && !c.stay){
      const occ = unitsAt(c.x,c.y).filter(o=>!o.removed && o.side===side && (o.type==='INFANTRY'||o.type==='GUARD'));
      if(occ.length===1 && terrainAt(c.x,c.y).allowDouble && nearestEnemyDist(c, side)<=3) s += addScore(parts, 'formColumn', 1.4);
    }
    // Core Tactic #5, Ground Worth Bleeding For: value good terrain when otherwise similar —
    // weighted much more heavily when the unit isn't actively closing for an attack (holding,
    // reserving, or a defensive-flavoured mission) or is already under real threat. That's
    // exactly when a real commander repositions onto good ground, rather than just mildly
    // preferring it as a tie-break while advancing straight past it regardless.
    if(seekTactics){
      const defensivePosture = holdingReserve || preserving || currentlyThreatened ||
        mission==='HOLD' || mission==='FIX' || mission==='SCREEN' || mission==='WITHDRAW';
      s += addScore(parts, 'terrainSeek', terrainSeekBonus(t.key, c.x, c.y) * (defensivePosture ? 2.4 : 1));

      /* SHAPE, not distance. Every other term here is "how far am I from X", so
         two squares equidistant from everything score identically: a logged match
         had six of six sampled decisions as exact ties broken by jitter. These two
         ask what a square IS rather than where it is, so they can separate options
         the rest of the scoring cannot tell apart.
      
         Sized to break ties rather than to dominate. The largest either can offer
         is about 1.4, comparable to formColumn and well under cohesionLoss: enough
         to decide between two otherwise equal squares, not enough to drag a unit
         off its mission. Brigadiers are excluded from both, since they neither
         support a fight nor hold ground. */
      if(t.key !== 'BRIGADIER'){
        s += addScore(parts, 'mutualSupport', mutualSupportBonus(side, c, u.id));
        s += addScore(parts, 'groundDenial', groundDenialBonus(side, c));
      }
    }
    // Core Tactic #2, The Gunner's Creed: value screening an unguarded friendly gun.
    if(seekTactics) s += addScore(parts, 'screensGun', screensGunBonus(u, side, c));
    // Manoeuvre #20, The Bogged Column (Hard): close on a stuck, unescorted enemy gun.
    if(boggedTarget) s -= subScore(parts, 'boggedGun', chebyshev(c, boggedTarget) * 0.15);
    // Operations: pull toward whatever the active scenario's objective actually rewards.
    if(state.scenario) s += addScore(parts, 'scenario', scenarioMoveBonus(u, side, c));
    // Section 6/7 (Hard): reward this square for serving the unit's Brigade mission,
    // on top of (not instead of) all the tactical bonuses above.
    /* The tempo multiplier scales the mission pull, so a Brigade advances hard
       during COMMIT, normally during BUILD, and only reluctantly during the HOLD
       pause. Applied to the mission pull ALONE rather than the whole score: a
       paused Brigade should still take good ground and hold its cohesion, it
       just should not be closing on its own. */
    if(mission){
      /* PRESERVE IS EXEMPT FROM THE TEMPO MULTIPLIER.

         TEMPO_PULL.COMMIT (1.7) exists to make the army press harder late in a
         match. Getting a beaten Brigade out of the line is not a tempo decision,
         and multiplying it produced a -9.18 pull in seed 104014103: a remnant
         twelve squares from safety wanted to reach it so badly that it would
         weigh almost nothing else on the way. Same destination, same behaviour,
         less frantic about the route. */
      const tempoMul = mission === 'PRESERVE' ? 1 : (TEMPO_PULL[tempoPhase(side)] ?? 1);
      s += addScore(parts, 'missionPull', missionMoveBonus(u, side, c, mission, plan) * tempoMul);
    }
    // Section 9 (Hard): selective lookahead, only for the "important" move categories —
    // a charge, a move that sets up a fight next phase, or a Reserve/Fix-mission unit
    // being pulled into contact. Everything else stays 0-ply, same cost as before.
    if(mission){
      const setsUpFight = !c.stay && state.units.some(o=>!o.removed && o.side!==side && isAdjacent(c,o) && !isConcealedFromEnemy(o));
      const committingReserve = (mission==='RESERVE' || mission==='FIX') && !c.stay && nearestEnemyDist(c,side) <= unitBaseMove(u)+1;
      if(isChargeMove || setsUpFight || committingReserve) s -= subScore(parts, 'lookahead', lookaheadMovePenalty(u, side) * 0.4);
    }

    s += addScore(parts, 'jitter', Math.random() * 0.03); // tie-breaking jitter: prevents an exact repeated stall between equally-scored options
    u.x=ox; u.y=oy;
    scored.push({ x:c.x, y:c.y, stay:!!c.stay, total:s, parts });
    if(s>bestScore){ bestScore=s; best=c; }
  }

  /* Keep the chosen square and its nearest rivals. All of them would be a wall
     of text for a unit with twenty legal moves; the top few answer the question
     that matters, which is whether the chosen action won on merit or whether
     everything else was worse for a reason worth seeing. */
  scored.sort((a,b)=>b.total-a.total);
  const decision = { chosen: scored[0] || null, alternatives: scored.slice(1,4), considered: scored.length };
  decisionForLog = decision;

  const canSquare = t.canFormSquare && terrainAt(u.x,u.y).key!=='WOODS' && terrainAt(u.x,u.y).key!=='BUILDING' && unitsAt(u.x,u.y).length<=1;
  // Square is gated on an actual cavalry unit able to reach this square, not on
  // a generic threat count. It is the only thing Square is good against, and
  // against infantry or artillery forming one is strictly worse than staying in
  // line: no move, +1 to the enemy's artillery effect roll, and a second die for
  // infantry attacking it. The old log line already claimed "sensing cavalry
  // nearby" while checking no such thing.
  /* S5: SQUARE IS NOT THE ONLY ANSWER TO CAVALRY, AND OFTEN NOT THE BEST ONE.

     The AI's cavalry judgement is sound and is deliberately left alone: it read
     correctly that British cavalry was dismantling it and forced the player onto
     infantry instead, and four units forming square in one turn was a good
     collective decision. What it lacks is the alternatives.

     Measured cost of not having them: seven "Infantry vs Square" bonuses for
     Britain against two "Square vs Cavalry" for France. Squares were caught by
     line infantry three and a half times for every time square did its job.

     Three checks, cheapest first, each one a reason NOT to form:

       enemyLineNear   Forming square beside enemy line infantry trades one bad
                       matchup for a worse one. After S2 the square faces 1 v 2
                       in BOTH directions, so it cannot even attack its way out.
                       This is the clause that matters most.
       coverNear       Woods or a building already does the job: cavalry loses
                       its second die into woods (W3/F1) and cannot enter a
                       building at all. Standing there costs no move and keeps
                       the unit able to fight normally.
       columnPartner   An adjacent friendly infantry gives a second die through
                       Attack Column without giving up mobility.

     Deliberately NOT scored as a penalty against squareScore. A square formed
     next to enemy line infantry is a mistake at any score, so this is a gate. */
  const enemyLineNear = state.units.some(o=>!o.removed && o.side!==side &&
    (UNIT_TYPES[o.type].key==='INFANTRY'||UNIT_TYPES[o.type].key==='GUARD') &&
    o.formation!=='square' && chebyshev(o, u) <= 2);
  const coverNear = ['WOODS','BUILDING'].includes(terrainAt(u.x,u.y).key) ||
    neighbors8(u.x,u.y).some(n=>['WOODS','BUILDING'].includes(terrainAt(n.x,n.y).key) &&
      unitsAt(n.x,n.y).length===0 && !state.moved.has(u.id));
  const columnPartner = state.units.some(o=>!o.removed && o.side===side && o.id!==u.id &&
    (UNIT_TYPES[o.type].key==='INFANTRY'||UNIT_TYPES[o.type].key==='GUARD') &&
    o.formation!=='square' && isAdjacent(o, u));
  if(canSquare && !enemyLineNear && !coverNear && !columnPartner &&
     cavalryThreatWithinCharge(u, side) && threatPenalty(u, side) >= 1.4){
    const origForm = u.formation;
    u.formation = 'square';
    /* NOT logged here. This square is hypothetical: it is set only to score the
       option and is reverted two lines down. Logging it recorded a formation
       change that never happened, which is why the export shows every AI square
       twice. The real change is logged below, inside the branch that keeps it. */
    /* SCORED ON THE SAME SCALE AS THE MOVES IT IS COMPARED AGAINST.

       This read `evaluateState(side)` raw while bestScore contains
       `evaluateState(side) * BASE_STATE_WEIGHT`. The two sides of the
       comparison below were a factor of ~2.9 apart, and have been since
       baseState was demoted from 1.0 to 0.35 to fix the 93% hold rate.

       Because evaluateState is a material balance, that turned "should this
       unit form Square?" into a question about how the whole match was going.
       Solving the old comparison gives Square winning only when
       0.65 * evaluateState exceeds the intent terms, so roughly only while the
       AI was materially AHEAD by about two points.

       That is backwards. Square is what you form when cavalry is about to ride
       you down, which is usually when you are losing. And it produced both
       halves of a symptom that looked like two separate bugs: in a match the AI
       was winning, evaluateState sat near zero, Square cleared the bar
       constantly and the export showed 18 formation changes in 41 turns; in a
       match it was losing 14 units to 2, evaluateState reached -17.8, Square
       could never clear the bar again and the AI formed one ZERO times in 53
       turns while the enemy collected four Cavalry-vs-non-Square bonuses off
       its unformed infantry. Same fault, two ends of one curve. It also fed
       back on itself: losing material disabled Square, which lost more.

       Applying the weight makes the 0.35*evaluateState term appear identically
       on both sides, where it cancels, exactly as it does between candidate
       squares. What is left is the real question: does the threat Square
       removes outweigh what holding still gives up.

       NOT CHANGED, but noted because it is the next thing anyone will ask
       about: this prices threat at -0.15 while the move path prices it at -0.5
       (see the 'threat' term above). Since Square's whole purpose is to lower
       threatPenalty, the lighter coefficient systematically undervalues its
       main benefit. Left alone deliberately so this fix can be measured on its
       own rather than tangled with a weight change. */
    const squareScore = evaluateState(side) * BASE_STATE_WEIGHT - 0.15*threatPenalty(u, side);
    u.formation = origForm;
    if(squareScore > bestScore){
      u.formation = 'square';
      logReplay('formation', { unitId:u.id, side:u.side, x:u.x, y:u.y, to:'square', by:'ai' });
      u.squareNoCavTurns = 0;
      state.moved.add(u.id);
      log(`${unitLabel(u)} (${SIDE_LABEL[side]}) forms Square, sensing cavalry nearby.`, side);
      logAiDebugMove(side, { unit: unitLabel(u), mission: missionFor(u), action:'Form Square', reason:`squareScore ${squareScore.toFixed(2)} beat best move ${bestScore.toFixed(2)}` });
      recordMove('Form Square');
      return;
    }
  }

  if(best && !best.stay){
    const fromX=u.x, fromY=u.y;
    displaceBrigadierIfPresent(best.x, best.y, fromX, fromY);
    if(t.isArtillery && !isHorseArtillery(u) && terrainAt(best.x,best.y).plough) consumePloughEscort(u);
    // u.charged is set AFTER this call (a few lines below), so it cannot be read
    // here. The charge is detected from the move itself, using the same test the
    // engine applies when it sets the flag.
    const isCharge = t.isCavalry && isCleanChargeRun(fromX,fromY,best.x,best.y) &&
      hasChargeableTargetAt(side, best);
    animateUnitTo(u, best.x, best.y, isCharge ? 'charge' : 'march');
    if(t.key==='INFANTRY' || t.key==='GUARD'){
      // Lasts exactly as long as this unit is walking, one square or three.
        // Measured from fromX/fromY: animateUnitTo has already moved the unit's
        // logical position to the destination by this point.
      AudioManager.playEffect('infantry-march', 'audio/effects/infantry-marching.wav', 'movement',
        { durationMs: moveAnimationMs(Math.max(1, Math.max(Math.abs(best.x-fromX), Math.abs(best.y-fromY)))) });
    }
    if(t.isCavalry){
      // Loops to cover the whole ride: the clip is 4s and a three-square move
      // is 5.04s. Same distance measurement as the infantry march above.
      AudioManager.playEffect('cavalry-gallop', 'audio/effects/cavalry-gallop.wav', 'movement',
        { durationMs: moveAnimationMs(Math.max(1, Math.max(Math.abs(best.x-fromX), Math.abs(best.y-fromY)))), loop: true });
    }
    // A Brigadier is one rider, so a single horse rather than the squadron.
    // Keyed on the type: isCavalry is false for Brigadiers.
    if(t.key === 'BRIGADIER'){
      AudioManager.playEffect('brigadier-gallop', 'audio/effects/brigadier-gallop.wav', 'movement',
        { durationMs: moveAnimationMs(Math.max(1, Math.max(Math.abs(best.x-fromX), Math.abs(best.y-fromY)))), loop: true });
    }
    // Gun carriage on the move: wheels on a dirt road.
    if(t.isArtillery){
      AudioManager.playEffect('artillery-move', 'audio/effects/artillery-move.wav', 'movement',
        { durationMs: moveAnimationMs(Math.max(1, Math.max(Math.abs(best.x-fromX), Math.abs(best.y-fromY)))), loop: true });
    }
    if(t.isCavalry && isCleanChargeRun(fromX,fromY,best.x,best.y) && hasChargeableTargetAt(side, best)){
      u.charged = true;
      log(`${unitLabel(u)} (${SIDE_LABEL[side]}) charges to engage!`, side);
    } else {
      log(`${unitLabel(u)} (${SIDE_LABEL[side]}) advances to (${best.x},${best.y}).`, side);
    }
    if(seekTactics && (t.key==='INFANTRY'||t.key==='GUARD')){
      const stacked = unitsAt(best.x,best.y).some(o=>!o.removed && o.id!==u.id && o.side===side && (o.type==='INFANTRY'||o.type==='GUARD'));
      if(stacked){
        const nearbyEnemy = state.units.find(o=>!o.removed && o.side!==side && isAdjacent(best,o));
        if(nearbyEnemy) state.turnComboTarget = nearbyEnemy.id;
      }
    }
    state.moved.add(u.id);
  }
  if(mission){
    /* The full decision, not just its outcome. `decision` carries the chosen
       square's score broken down by contribution, plus the next best rivals, so
       a unit that held can be checked: did Hold win on merit, or was every
       alternative dragged down by one term? */
    logAiDebugMove(side, { unit: unitLabel(u), mission,
      action: (best && !best.stay) ? (u.charged?'Charge':'Advance') : 'Hold',
      to: best?`(${best.x},${best.y})`:null, score: bestScore.toFixed(2), decision });
  }
  recordMove((best && !best.stay) ? (u.charged?'Charge':'Advance') : 'Hold', best && !best.stay ? {x:best.x, y:best.y} : null);
}

export function aiDoMovePhase(){
  const order = orderAiUnitsForMove(state.aiSide);
  let i = 0;
  cameraParkPlayerView();
  /* The camera follows by BRIGADE, not by unit. orderAiUnitsForMove already
     groups the turn Brigade by Brigade (leftmost first), and cohesion keeps a
     Brigade's units within a few squares of each other, so framing the Brigade's
     centroid gives roughly three long pans across a turn instead of seventeen
     jumps. The pan is started when the Brigade changes and left to run while its
     units move inside the frame. */
  let cameraBrigade = null;
  function step(){
    if(state.gameOver) return;
    if(i>=order.length){ endMovePhase(); return; }
    const u = state.units.find(x=>x.id===order[i]); i++;
    if(u && u.brigadeId !== cameraBrigade){
      cameraBrigade = u.brigadeId;
      cameraToUnits(state.units.filter(o=>!o.removed && o.side===state.aiSide && o.brigadeId===cameraBrigade));
    }
    const beforeX = u.x, beforeY = u.y;
    aiDecideAndExecuteMove(u);
    draw();
    // Only wait out the full move animation when this unit actually moved —
    // a unit that stayed, formed Square, or fired has nothing animating, so
    // holding up the next unit's turn for it would just slow the AI down
    // for no visual benefit. +60ms settle buffer past the animation itself
    // so the next unit's turn doesn't visually overlap the tail end of it.
    const moved = u && (u.x!==beforeX || u.y!==beforeY);
    // Wait for as long as THIS move actually takes. A three-square move now runs
    // three times as long as a one-square step, so a fixed wait would start the
    // next unit while the previous was still crossing the board.
    const steps = Math.max(Math.abs(u.x-beforeX), Math.abs(u.y-beforeY));
    /* An ambush the AI has just walked into resolves here, between units,
       rather than waiting for endMovePhase. Same reason as the human path: the
       ambusher should not have to wait while the rest of the Brigade forms up
       around its victim. resolveAmbushSpringsNow is a no-op when nothing is
       pending, which is the overwhelming majority of steps, and the human
       owner's Hold/Advance dialog holds the loop until it is answered because
       the next step() is its callback. */
    setTimeout(()=> resolveAmbushSpringsNow(step),
      moved ? moveAnimationMs(Math.max(1, steps)) + 60 : 340);
  }
  step();
}

/* =========================================================
   AI: ARTILLERY FIRE
========================================================= */
export function aiFireDecision(gun, onComplete){
  onComplete = onComplete || function(){};
  const targets = artilleryTargets(gun);
  if(targets.length===0){ state.fired.add(gun.id); onComplete(); return; }
  const plan = state.aiDifficulty==='hard' ? state._aiPlan[gun.side] : null;
  let best=null, bestScore=-Infinity;
  for(const t of targets){
    const dist = chebyshev(gun,t);
    const pHit = dist<=1 ? 1 : Math.max(0,(7-dist))/6;
    let score = pHit * AI_UNIT_VALUE[t.type];
    if(state.aiDifficulty!=='easy') score += pHit * brigadeBreakBonus(t);
    /* A doubled Column is worth two units to one shot, and ONLY to a gun:
       since the Column rule moved to the artillery path, infantry and cavalry
       take one unit at a time. That makes a stacked pair the most efficient
       target on the board for a battery and an ordinary one for everyone else,
       so the preference belongs here rather than in the general target scoring.

       Weighted by the chance of hitting, like the other terms, so a stacked pair
       at extreme range does not outrank a certain hit on a lone gun. */
    if(state.aiDifficulty!=='easy' && stackPartner(t)){
      score += pHit * COLUMN_TARGET_BONUS;
    }
    // Manoeuvre #11, Grand Battery (Hard): concentrate onto a target another
    // friendly gun already hit this phase, while still within effective range.
    if(state.aiDifficulty==='hard' && dist<=3 && state.turnGunTargets && state.turnGunTargets.has(t.id)) score += 1.5;
    // Section 6, Artillery concentration (Hard): weight toward the plan's actual
    // target Brigade rather than always taking the single highest expected-damage shot.
    if(plan && plan.targetBrigadeId!=null && t.brigadeId===plan.targetBrigadeId) score += pHit * 1.0;
    if(score>bestScore){ bestScore=score; best=t; }
  }
  if(!state.turnGunTargets) state.turnGunTargets = new Set();
  state.turnGunTargets.add(best.id);
  logAiDebugMove(gun.side, { unit: unitLabel(gun), mission: missionFor(gun), action:'Fire', target: unitLabel(best), score: bestScore.toFixed(2) });
  fireArtillery(gun, best, onComplete);
}

/* WHICH UNIT IN A COLUMN THE AI SHOOTS AT.

   A Column is two units on one tile, and a killing volley removes only the one
   aimed at. Raw unit value is the wrong tie-break: what a kill is worth is what
   it does to the WIN CONDITION, and the match is won by breaking two of three
   enemy Brigades, not by points.

   So the AI shoots whichever candidate leaves its Brigade nearest to breaking.
   A unit in a two-strong Brigade is worth far more dead than an identical unit
   in a six-strong one, and the last combat unit in a Brigade is worth most of
   all because killing it breaks the Brigade outright.

   Wounded units break the tie: a turned-around or rallying unit is closer to
   removal already and cannot answer the volley. */
export function pickVolleyTarget(candidates){
  let best = null, bestScore = -Infinity;
  for(const t of candidates){
    const remaining = state.units.filter(o=>!o.removed && o.side===t.side &&
      o.brigadeId===t.brigadeId && o.type!=='BRIGADIER').length;
    if(remaining === 0) continue;
    let sc = 3.0 / remaining;                       // last unit in a Brigade scores 3.0
    if(t.turnOnly || t.rallying) sc += 0.5;         // already wounded, and cannot reply
    if(sc > bestScore){ bestScore = sc; best = t; }
  }
  return best;
}

/* The Firing phase runs guns first, then volleys.

   Guns first is deliberate rather than incidental: artillery has range and can
   often shoot a unit that is not adjacent to anything, while a volley is only
   ever available at contact. Resolving the longer weapon first means a gun is
   never wasted on a target the volley was about to remove anyway. */
export function aiDoFirePhase(){
  const guns = state.units.filter(u=>!u.removed && u.side===state.aiSide && UNIT_TYPES[u.type].isArtillery && !state.fired.has(u.id));
  let i=0;
  function step(){
    if(state.gameOver) return;
    if(i>=guns.length){ aiDoVolleyStep(); return; }
    const gun = guns[i]; i++;
    if(!gun.removed){
      aiFireDecision(gun, ()=>{ draw(); setTimeout(step, 250); });
    } else {
      setTimeout(step, 100);
    }
  }
  step();
}

/* Volleys are taken unconditionally where one is available. There is no decision
   to model: a volley costs nothing (it does not consume the move, and the unit
   may still melee the same target afterwards), so declining one is never
   correct. The only judgement is WHICH unit to shoot at, which is
   pickVolleyTarget's job. */
function aiDoVolleyStep(){
  const shooters = state.units.filter(u=>!u.removed && u.side===state.aiSide && isFootInfantry(u));
  let i=0;
  function step(){
    if(state.gameOver) return;
    if(i>=shooters.length){ endFirePhase(); return; }
    const u = shooters[i]; i++;
    const targets = volleyTargets(u);
    if(!targets.length){ step(); return; }
    const target = pickVolleyTarget(targets);
    if(!target){ step(); return; }
    logAiDebugMove(u.side, { unit: unitLabel(u), mission: missionFor(u), action:'Volley',
                             target: unitLabel(target), score: '—' });
    resolveVolley(u, target, ()=>{ draw(); setTimeout(step, 250); });
  }
  step();
}

/* =========================================================
   AI: FIGHTING
========================================================= */
/* W1: WHAT THIS FIGHT IS WORTH, not merely that a fight is possible.

   Rewritten for three reasons.

   1. IT CONTRADICTED THE RULES IT WAS MEANT TO MODEL. The two Math.max(aD,2)
      lines re-asserted the cavalry and infantry-vs-square dice AFTER
      combatBonuses had already decided them. Harmless while the two agreed;
      actively wrong from W3 onward, where cavalry into woods gets +1 and no
      second die. The override would have told the AI it still had two, and it
      would have gone on charging woods forever. Everything is now taken from
      combatBonuses alone, so the estimator cannot drift from the rules again.

   2. DICE WERE UNDERWEIGHTED AGAINST FLAT BONUSES. A second die is worth far
      more than +1: it reshapes the distribution rather than shifting it (the
      expected kept value goes 3.5 -> 4.47, and the tail matters more than the
      mean when margins of 2 and 3 decide rout and removal). Weighted at 3:1
      accordingly. Under the old edge*2 with +1s counted nowhere, a level fight
      with two flat bonuses could outscore a genuine dice advantage.

   3. IT DID NOT KNOW ABOUT STATUS (W8). The player picks targets that are
      turned around, and the bonus tally shows it: Britain 22, France 4 in one
      match; Britain 5, France 1 in the next. That is not a facing model, since
      units fight omnidirectionally. It is target selection, and it belongs
      here.

   W4: a unit in Square cannot initiate at all, so there is no fight to value.
   Returned as a large negative rather than zero, because zero means "a level
   fight, no better than standing still" and this must be strictly worse than
   any move that keeps the option.

   Scale: dice edge dominates at +/-3 per die, flat bonuses at 1 each, and unit
   values kept as a light tiebreaker so that among equally good matchups the AI
   prefers to kill the more valuable thing. */
export const DIE_WEIGHT = 3.0;
export const BONUS_WEIGHT = 1.0;

export function estimateFightValue(a, t){
  /* S2/S4: a square CAN attack now, so the -9 sentinel is gone. combatBonuses
     carries the whole matrix, so square scores 0.0 into cavalry (neutral, worth
     taking if it is the only option) and -3.0 into line infantry (avoid),
     without a special case here. */
  /* An ambush on cavalry strips its second die, so ambushing horsemen is worth
     considerably more than ambushing infantry. Modelled by setting the same flag
     combatBonuses reads, rather than by a parallel clause that could drift from
     the rule. Restored immediately: this is a hypothetical, not a live fight. */
  const wasAmbushed = t.ambushedThisFight;
  if(a.hidden && UNIT_TYPES[t.type].isCavalry) t.ambushedThisFight = true;
  const aB = combatBonuses(a, t, false);
  const dB = combatBonuses(t, a, true);
  if(wasAmbushed === undefined) delete t.ambushedThisFight; else t.ambushedThisFight = wasAmbushed;

  /* The status bonuses live in resolveFight rather than combatBonuses, so they
     have to be added by hand here. Kept in step with that list deliberately:
     turned-around and rallying are the two that grant the attacker +1. */
  let aBonus = aB.valueBonus + (t.turnOnly ? 1 : 0) + (t.rallying ? 1 : 0);
  const dBonus = dB.valueBonus;

  const edge = (aB.dice - dB.dice) * DIE_WEIGHT + (aBonus - dBonus) * BONUS_WEIGHT;
  /* The unit-value tiebreaker is now zero-MEAN: a difference, not two separate
     terms. Written as value*0.25 - value*0.10 it added about +0.6 to every
     matchup, so a level fight scored +0.60 rather than 0.00 and the whole table
     sat above the specification. That matters because 0.00 is load-bearing: it
     is the statement that an even fight is worth no more than standing still.
     As a difference it vanishes between equals and still prefers the more
     valuable target among equally good matchups. */
  return edge + (AI_UNIT_VALUE[t.type] - AI_UNIT_VALUE[a.type]) * 0.15;
}

// Medium+: how much finishing off `target` matters for actually winning the game —
// Easy has no concept of this and just takes the best immediate trade available.
export function brigadeBreakBonus(target){
  const remaining = state.units.filter(o=>!o.removed && o.side===target.side && o.brigadeId===target.brigadeId && o.type!=='BRIGADIER').length;
  if(remaining<=1) return 6;   // this IS the Brigade's last unit — taking it breaks the Brigade outright
  if(remaining===2) return 2.5; // one hit from breaking
  return 0;
}

// Hard only: a cheap, deterministic stand-in for real lookahead. Rather than a
// single random roll, use the EXPECTED margin from the dice-count edge to predict
// the likely outcome bucket, apply it to a temporary clone of the two units, score
// the resulting position with evaluateState, then revert. Not true minimax — the
// branching factor here doesn't justify that — but a genuine step past the
// immediate trade instead of a static heuristic.
export function simulateFightAftermathScore(attacker, defender, side){
  const aD = combatBonuses(attacker, defender, false).dice;
  const dD = combatBonuses(defender, attacker, true).dice;
  const EV_BY_DICE = {1:3.5, 2:4.47};
  const margin = (EV_BY_DICE[Math.min(aD,2)]||3.5) - (EV_BY_DICE[Math.min(dD,2)]||3.5);

  const snap = { aRemoved:attacker.removed, aX:attacker.x, aY:attacker.y, aTurnOnly:attacker.turnOnly,
                 dRemoved:defender.removed, dX:defender.x, dY:defender.y, dTurnOnly:defender.turnOnly };

  if(margin >= 3){ defender.removed = true; }
  else if(margin >= 1){ defender.turnOnly = true; }
  else if(margin <= -3){ attacker.removed = true; }
  else if(margin <= -1){ attacker.turnOnly = true; }
  // roughly even (|margin|<1): treat as a draw, no change — matches the real rule's tie-continues behaviour

  // "And then what" — a fight that wins but leaves the attacker (if it survives)
  // badly exposed to the rest of the enemy army next turn shouldn't score as well
  // as an identical win somewhere safer. Computed after the defender's projected
  // fate is applied above, so a fight that removes the defender correctly reads
  // as one less threat source afterwards.
  const postFightExposure = attacker.removed ? 0 : threatPenalty(attacker, side) * 0.35;
  const score = evaluateState(side) + brigadeBreakBonus(defender)*0.5 - postFightExposure;

  attacker.removed=snap.aRemoved; attacker.x=snap.aX; attacker.y=snap.aY; attacker.turnOnly=snap.aTurnOnly;
  defender.removed=snap.dRemoved; defender.x=snap.dX; defender.y=snap.dY; defender.turnOnly=snap.dTurnOnly;

  return score;
}

// Single entry point the AI's Fight-phase loop calls — branches on difficulty,
// Easy's exact original behaviour untouched.
// Operations: fight decisions need to serve whatever the active objective
// actually is — chasing Brigade-breaks in an escape or survival scenario is
// actively counterproductive, not just unsophisticated.
export function scenarioFightBonus(target, side){
  if(!state.scenario) return 0;
  let bonus = 0;
  for(const cond of state.scenario.objective.conditions){
    if(cond.type==='ELIMINATE_TARGET' && cond.params.targetSide===target.side) bonus += 1.0;
    if(cond.type==='SURVIVE_TURNS' && cond.params.defender===side) bonus -= 0.6;
    if(cond.type==='ESCAPE_ZONE' && cond.params.escapingSide===side) bonus -= 0.8;
  }
  return bonus;
}

// Section 8, Hard only: distinguish "this Brigade is almost destroyed, finish it"
// (already covered by brigadeBreakBonus inside simulateFightAftermathScore) from
// "this Brigade is already strategically neutralised, stop spending attacks here."
// Rewards fighting the plan's actual target; mildly discourages a Main-Attack/Flank/
// Counterattack unit getting distracted onto a target the plan isn't pointed at.
export function missionFightBonus(a, target, side, plan){
  if(!plan) return 0;
  let bonus = 0;
  if(plan.targetBrigadeId!=null && target.brigadeId===plan.targetBrigadeId) bonus += 1.2;
  const mission = missionFor(a);
  if((mission==='MAIN_ATTACK' || mission==='FLANK' || mission==='COUNTERATTACK') &&
     plan.targetBrigadeId!=null && target.brigadeId!==plan.targetBrigadeId) bonus -= 0.6;
  return bonus;
}

export function aiEstimateFightValue(a, t, side){
  const scenarioAdj = scenarioFightBonus(t, side);
  if(state.aiDifficulty==='hard'){
    const plan = state._aiPlan[side];
    return simulateFightAftermathScore(a, t, side) + estimateFightValue(a,t)*0.15 + scenarioAdj + missionFightBonus(a, t, side, plan);
  }
  if(state.aiDifficulty==='medium') return estimateFightValue(a,t) + (state.scenario ? scenarioAdj : brigadeBreakBonus(t));
  return estimateFightValue(a,t) + scenarioAdj*0.5; // even Easy needs baseline awareness a non-standard objective exists, not full doctrine
}

export function aiDoFightPhase(){
  state._aiFocusTargetId = null;
  function step(){
    if(state.gameOver) return;
    /* Target priority (brief 2.5) is artillery, then isolated units, then the
       damaged, then everything else. Artillery already comes first via
       AI_UNIT_VALUE (6 against infantry's 4) inside estimateFightValue, and the
       damaged are covered by WOUNDED_TARGET_BONUS below. Isolation was the gap:
       findVulnerableEnemyUnits existed but only ever fed MOVE scoring, so the
       AI would march toward an unsupported enemy and then, once there, pick its
       fight without caring. Computed once per step rather than per candidate
       pair, since it runs a cohesion BFS.

       Deliberately NOT the getVulnerableEnemyUnits cache above: that is keyed on
       (side, turnNumber) and never invalidates on a death, which is correct in
       the move phase where nothing dies, and wrong here where every resolved
       fight can isolate a unit by removing the neighbour that was supporting
       it. Recomputed per step so it always reflects the board as it now is. */
    const vulnerableIds = new Set(findVulnerableEnemyUnits(state.aiSide).map(v=>v.id));
    /* R6: a PRESERVE Brigade defends normally if attacked but never initiates,
       so it is filtered out of the attacker pool here as well as being denied
       the engage score on movement. Suppressing only the movement term would
       leave a remnant that had been caught still throwing itself forward, which
       is the exact behaviour PRESERVE exists to stop. */
    const attackers = state.units.filter(u=>u.side===state.aiSide && canInitiateFight(u) && !state.fought.has(u.id) &&
      missionFor(u) !== 'PRESERVE' &&
      state.units.some(o=>!o.removed && o.side!==state.aiSide && isAdjacent(u,o) && canAttackTarget(u,o)));
    if(attackers.length===0){ endFightPhase(); return; }
    let bestA=null, bestT=null, bestScore=-Infinity;
    for(const a of attackers){
      const targets = state.units.filter(o=>!o.removed && o.side!==state.aiSide && isAdjacent(a,o) && canAttackTarget(a,o));
      for(const t of targets){
        let s = aiEstimateFightValue(a, t, state.aiSide);

        /* FOCUS FIRE. Once this turn's fighting has started against a given
           enemy, keep going at it rather than spreading across separate
           targets. Extra rolls against one unit beat single rolls against
           several: the loser of each fight is pushed back, routed or destroyed,
           so every additional attack lands on an enemy that is already worse
           off. The human player's kill sequences are almost entirely this
           shape. Costs nothing when only one attack is available. */
        if(state._aiFocusTargetId === t.id) s += FOCUS_FIRE_BONUS;

        /* FINISH THE WOUNDED. A unit still turned around from a pushback cannot
           fight back at all and grants the attacker +1, and one that has just
           rallied is one loss from gone. Denying the rally is a deliberate,
           repeated pattern in the player's play that the AI did not have. */
        if(t.turnOnly)  s += WOUNDED_TARGET_BONUS;
        if(t.rallying)  s += WOUNDED_TARGET_BONUS;

        /* R7 at the point of attack as well as the approach. The same guard
           applies: a fight the estimator rates below the floor gets no
           win-condition credit, so a protected last unit cannot draw an attack
           that engage alone would refuse. */
        if(estimateFightValue(a, t) > KILL_VALUE_ENGAGE_FLOOR) s += brigadeKillValue(t);

        // Cut off from its Brigadier, or with no friendly unit within two
        // squares. It cannot be reinforced and, if disconnected, cannot even
        // move itself back to safety.
        if(vulnerableIds.has(t.id)) s += ISOLATED_TARGET_BONUS;

        if(s>bestScore){ bestScore=s; bestA=a; bestT=t; }
      }
    }
    if(bestA){
      // A fight is the thing most worth seeing, so the camera reframes on the
      // pair even if they are inside the Brigade frame already.
      cameraToUnits([bestA, bestT]);
      logAiDebugMove(state.aiSide, { unit: unitLabel(bestA), mission: missionFor(bestA), action:'Fight', target: unitLabel(bestT), score: bestScore.toFixed(2) });
      // Remember what we are working on, so the next attacker in this phase
      // piles onto the same unit. Cleared when the fight phase ends.
      state._aiFocusTargetId = bestT.id;
      // Committed at declaration, matching the human path: the attacker has
      // thrown itself in, whatever the dice then say. Recording it at the settle
      // instead left a window in which the same unit could fight again.
      state.fought.add(bestA.id);
      resolveFight(bestA, bestT, undefined, ()=>{
        // A destroyed or routed target is finished business; let the next
        // attacker choose freshly rather than chasing a unit that has gone.
        if(bestT.removed || bestT.rallying) state._aiFocusTargetId = null;
        draw();
        setTimeout(step, 300);
      });
    } else {
      endFightPhase();
    }
  }
  step();
}

// Plain-text, copy-pasteable transcript of every AI move for the whole match —
// grouped by turn, flagging any move that broke or was made while disconnected
// from the Brigadier, since that's the specific weakness under investigation.
// Difficulty-agnostic (mission/score columns are simply blank on Easy/Medium,
// where no mission exists).
/* Section 4 of the match export: the AI's decision, not just its outcome.

   Prints the chosen square's score broken down by contribution, and the next
   best rivals with theirs. That is the whole point: "the Brigade did nothing for
   twenty turns" becomes answerable, because Hold's score sits next to the moves
   it beat and the terms that produced each are named.

   Only printed where a breakdown exists. Form Square, Lay Ambush and Stand Down
   never score candidates, so there is nothing to show and an empty block would
   only be noise. */
function formatParts(parts){
  return Object.entries(parts)
    .filter(([,v]) => Math.abs(v) >= 0.005)
    .sort((a,b) => Math.abs(b[1]) - Math.abs(a[1]))
    .map(([k,v]) => `${k} ${v>=0?'+':''}${v.toFixed(2)}`)
    .join('  ');
}

/* WHICH TERM ACTUALLY DECIDED EACH MOVE.

   This is the analysis I have run by hand on every export so far, moved into the
   tool. For each decision it measures how far each contribution SPREADS between
   the chosen square and its rivals: a term that is large but identical
   everywhere decides nothing, while a small term that differs decides
   everything. The term with the widest spread is the one that actually made the
   choice.

   It found the two faults that mattered. baseState was deciding 7 of 15 sampled
   moves with a spread of 0.79 while every intent term sat near 0.15, which is
   why three successive additions changed nothing. And engage, once added,
   swung from -27 to +8.79 against an intended -1.8 to +2.3.

   Printing this instead of every breakdown takes section 4 from roughly 3600
   lines to about 25, which is the difference between an export that can be
   shared and one that cannot. */
export function summariseAiDecisions(side){
  const hist = (state._aiMoveHistory && state._aiMoveHistory[side]) || [];
  const decided = {}, spreads = {}, ranges = {};
  let withBreakdown = 0, holds = 0;
  for(const h of hist){
    const d = h.decision;
    if(!d || !d.chosen) continue;
    withBreakdown++;
    if(h.action === 'Hold' || d.chosen.stay) holds++;
    const alts = d.alternatives || [];
    if(!alts.length) continue;
    const keys = new Set([...Object.keys(d.chosen.parts), ...alts.flatMap(a=>Object.keys(a.parts))]);
    let top = null, topSpread = 0;
    for(const k of keys){
      const vals = [d.chosen.parts[k] || 0, ...alts.map(a=>a.parts[k] || 0)];
      const sp = Math.max(...vals) - Math.min(...vals);
      (spreads[k] = spreads[k] || []).push(sp);
      const r = ranges[k] = ranges[k] || { lo: Infinity, hi: -Infinity };
      for(const v of vals){ if(v < r.lo) r.lo = v; if(v > r.hi) r.hi = v; }
      if(sp > topSpread){ topSpread = sp; top = k; }
    }
    if(top) decided[top] = (decided[top] || 0) + 1;
  }
  return { total: withBreakdown, holds, decided, spreads, ranges };
}

export function formatAiDecisionSummary(side, label){
  const a = summariseAiDecisions(side);
  const out = [];
  if(!a.total){ out.push(`${label}: no scored decisions`); return out; }
  out.push(`${label}: ${a.total} scored decisions, ${a.holds} were Hold ` +
           `(${Math.round(a.holds/a.total*100)}%)`);
  out.push('');
  out.push('  WHICH TERM DECIDED THE MOVE (widest spread between the chosen square and its rivals)');
  const byCount = Object.entries(a.decided).sort((x,y)=>y[1]-x[1]);
  if(!byCount.length) out.push('    (no alternatives were recorded)');
  for(const [k,n] of byCount.slice(0,10)){
    const sp = a.spreads[k] || [0];
    const avg = sp.reduce((p,c)=>p+c,0)/sp.length;
    out.push(`    ${k.padEnd(24)} decided ${String(n).padStart(4)}   avg spread ${avg.toFixed(2)}`);
  }
  out.push('');
  out.push('  EVERY TERM: how much room it has to influence anything, and its observed range');
  const byInfluence = Object.entries(a.spreads)
    .map(([k,v]) => [k, v.reduce((p,c)=>p+c,0)/v.length])
    .sort((x,y)=>y[1]-x[1]);
  for(const [k,avg] of byInfluence){
    const r = a.ranges[k];
    out.push(`    ${k.padEnd(24)} spread ${avg.toFixed(2)}   range ${r.lo.toFixed(2)} to ${r.hi.toFixed(2)}`);
  }
  return out;
}

export function formatAiDecision(entry, indent){
  const d = entry.decision;
  if(!d || !d.chosen) return [];
  const pad = indent || '    ';
  const out = [];
  const c = d.chosen;
  out.push(`${pad}chose (${c.x},${c.y})${c.stay?' [HOLD]':''} total ${c.total.toFixed(2)}  of ${d.considered} options`);
  out.push(`${pad}  ${formatParts(c.parts) || '(nothing scored)'}`);
  for(const a of (d.alternatives||[])){
    out.push(`${pad}  vs (${a.x},${a.y})${a.stay?' [HOLD]':''} ${a.total.toFixed(2)}: ${formatParts(a.parts)}`);
  }
  return out;
}

export function exportAiMoveLog(){
  const side = state.aiSide;
  if(!side) return 'No AI opponent in this match — nothing to export.';
  const history = state._aiMoveHistory[side] || [];
  if(history.length===0) return 'No AI moves recorded this match.';

  const lines = [];
  lines.push(`=== AI MOVE LOG — ${SIDE_LABEL[side]} (${state.aiDifficulty||'?'}) ===`);
  lines.push(`Total AI moves: ${history.length}`);
  /* TWO NUMBERS, BECAUSE ONE OF THEM HAS BEEN MISREAD THREE TIMES.

     A disconnected unit CANNOT MOVE until its Brigadier returns, so it logs
     "Hold, DISCONNECTED" every turn it stays stranded. Counting those states
     measures how long units were stuck, not how often the AI chose badly, and
     one frozen cavalry regiment can generate a dozen of them on its own: 7e
     Hussards produced 12 of 41 in seed 499086477 while never once choosing to
     move. Read as a decision metric it reported 17%, 15% and "worst since the
     79-disconnection match" for matches whose real rates were 5.8% and 5.6%.

     The DECISION is the move that broke the chain. That is the number to tune
     against. The state count is kept because it is a real measure of a real
     problem (units frozen out of the battle), just a different one.

     Artillery is reported apart from both, because guns are deliberately exempt
     from cohesionLoss so that a battery in a good position can keep firing after
     its Brigade advances past it. Those disconnections are sanctioned, and
     counting them against a target they were never meant to meet is what makes
     the headline figure look like a regression. */
  const disconnectedCount = history.filter(h=>!h.connectedAfter).length;
  const breaking = history.filter(h=>!h.connectedAfter && h.connectedBefore && h.action !== 'Hold');
  const breakingGuns = breaking.filter(h=>UNIT_TYPES[h.type] && UNIT_TYPES[h.type].isArtillery).length;
  const breakingRest = breaking.length - breakingGuns;
  const pct = history.length ? (breakingRest / history.length * 100).toFixed(1) : '0.0';
  lines.push(`Moves that BROKE the command chain: ${breaking.length} of ${history.length} (${breakingRest} non-artillery = ${pct}%, ${breakingGuns} artillery, exempt by design)`);
  lines.push(`Turns spent already disconnected (a frozen unit re-flags every turn): ${disconnectedCount}`);
  lines.push('');

  let lastTurn = null;
  for(const h of history){
    if(h.turn !== lastTurn){
      lines.push(`--- Turn ${h.turn} ---`);
      lastTurn = h.turn;
    }
    const fromStr = `(${h.from.x},${h.from.y})`;
    const toStr = h.to ? ` -> (${h.to.x},${h.to.y})` : '';
    const missionStr = h.mission ? ` [mission: ${h.mission}]` : '';
    const scoreStr = h.score!==undefined ? ` score:${h.score}` : '';
    const flag = !h.connectedAfter ? '  \u26A0 DISCONNECTED FROM BRIGADIER'
      : (h.connectedBefore && !h.connectedAfter ? '  \u26A0 LOST connection this move' : '');
    lines.push(`${h.unit} (Brigade ${h.brigadeId}) [${h.type}]: ${h.action} ${fromStr}${toStr}${missionStr}${scoreStr}${flag}`);
  }
  return lines.join('\n');
}

