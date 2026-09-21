import { floatingTextIdle, resetFloatingTextTurnBudget } from './floating-text.js';
import { AI_UNIT_VALUE, cavalryThreatWithinCharge, evaluateState, findBoggedEnemyGun, findRaidableEnemyGun, findDefensiveRallyPoint, findVulnerableEnemyUnits, groundDenialBonus, isIsolatedAndThreatened, mutualSupportBonus, rallyPointPullBonus, reserveCrisisExists, retreatToSupportBonus, roadSeekBonus, scenarioMoveBonus, screensGunBonus, supportCountFor, terrainSeekBonus, threatPenalty, vulnerableTargetPullBonus } from './ai-tactics.js';
import { COLS, ROWS, SIDES, SIDE_LABEL, UNIT_TYPES, state } from './data-core.js';
import { otherSide } from './engine-objectives.js';
import { artilleryTargets, chebyshev, combatBonuses, consumePloughEscort, hasChargeableTargetAt, hasLOS, isAdjacent, isCleanChargeRun, isConcealedFromEnemy, isFootInfantry, isHorseArtillery, legalMoves, movableUnitsForSide, neighbors8, resolveFight, stackPartner, terrainAt, unitBaseMove, unitsAt, volleyTargets, seededRandom } from './engine-rules.js';
import { log, logReplay } from './engine-state.js';
import { AudioManager } from './audio-manager.js';
import { CAMERA_ACTION_PAN_MS, animateUnitTo, cameraParkPlayerView, cameraToAction, cameraToUnits, displaceBrigadierIfPresent, draw, moveAnimationMs } from './render-board.js';
import { brigadeBrokenStatus, canAttackTarget, canInitiateFight, canLayAmbush, endFightPhase, endFirePhase, endMovePhase, fireArtillery, owesAFight, resolveAmbushSpringsNow, resolveVolley, unitLabel } from './ui-battle.js';

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
export const BRIGADE_MISSIONS = ['MAIN_ATTACK','SUPPORT','FIX','FLANK','RESERVE','SCREEN','HOLD','COUNTERATTACK','WITHDRAW','REGROUP','PRESERVE','REUNITE','FETCH'];
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

/* F1: THE CAP, AND THE INVARIANT IT EXISTS TO PROTECT.

   INVARIANT: no single avoidance term may exceed the positive maximum of engage.
   If the worst danger outscores the best fight, the AI is structurally incapable
   of attacking, however well every other term is tuned.
   Previously broken by: threat (-5.00), soloAttackPenalty (-4.80).

   soloAttackPenalty did not drift. The constant above has been 1.2 throughout.
   It is applied once PER ADJACENT ENEMY, so a square touching four of them
   accumulated -4.80 with nothing stopping it, and became the largest-magnitude
   term in the game.

   The stacking is right in principle: walking unsupported into four enemies is
   worse than walking into one. What was wrong is that it stacked without a
   ceiling, so at three or more it stopped being a discouragement and became the
   veto the comment above says it must not be. Capped, the shape is kept and the
   veto is not. */
export const SOLO_ATTACK_PENALTY_MAX = 2.0;

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
/* =========================================================
   PER-SIDE TUNING — how the simulator runs a variant against a control

   Every weight below is a module constant, read directly wherever it is needed.
   That is right for the shipped game, where there is one AI, and it is exactly
   what makes a controlled experiment impossible: with state.aiSide pointed at
   whichever side is acting, both armies necessarily share every constant, so
   there is nothing to compare.

   This is the smallest thing that fixes that. state.aiConfig holds an optional
   override table per side, and tune() consults it with the module constant as
   the fallback. An absent or empty config returns the constant, so the played
   game is byte-identical and no default moves: the constants below remain the
   single source of truth and an override is always visible at the call site.

   Deliberately NOT a wholesale conversion of every constant to an accessor. Only
   the ones a variant actually changes get wired, so the diff stays readable and
   a term that is not part of an experiment cannot silently acquire two values.

   It lives on `state` rather than in a module variable so it is carried through
   undo and snapshotting like everything else, and so it cannot leak between
   matches in a batch.

   flag() is the same idea for behaviour rather than magnitude: a variant that
   adds a rule needs to add it for one side only. Defaults false, so an unset
   flag is the current game. */
/* B2: A CAP ACROSS BOTH gunPositioning GROUPS, not within each.

   GUN_PENALTY_GROUP_CAP is 1.75 and there are two separately capped groups, so
   the term reaches 3.50 in total. That is the figure reported as it having
   "grown to the size of the five terms it replaced", and lowering the group cap
   would halve each group rather than bound the sum. This bounds the sum.

   Defaults to Infinity, so with no override the two groups behave exactly as
   before and nothing in the played game moves. */
/* T6, measured: two gunPositioning groups capped at 1.75 each summed to 3.50,
   which is the size of the five terms the consolidation replaced. This bounds
   the SUM rather than halving each group. */
export const GUN_PENALTY_TOTAL_CAP = 2.00;

function cappedGunPenalty(parts, side, v){
  const cap = tune(side, 'GUN_PENALTY_TOTAL_CAP', GUN_PENALTY_TOTAL_CAP);
  if(cap === Infinity) return v;
  const already = Math.abs(parts.gunPositioning || 0);
  return Math.max(0, Math.min(v, cap - already));
}

export function tune(side, name, fallback){
  const c = state.aiConfig && state.aiConfig[side];
  return (c && c[name] !== undefined) ? c[name] : fallback;
}
export function flag(side, name){
  const c = state.aiConfig && state.aiConfig[side];
  return !!(c && c[name]);
}

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
/* T2, measured: 2.50 let threat decide the most moves in three consecutive
   matches and win the widest-spread comparison against terms worth a tenth of
   it. At 1.80 it fell from first place to fourth (11.0% of moves) and the
   variant carrying it won 58.1% across a swapped run. Still well inside
   engage's +5.00 ceiling, so the invariant holds. */
/* T3, measured: the 2.4 defensive-posture multiplier took terrainSeek to 1.20
   and it was deciding the second-most moves, with units choosing cover over
   contact. Capped at the 0.84 it sat at during the better matches, it now
   decides 1.6%. A CEILING rather than a lower multiplier, so ordinary play,
   where the term is already the right size, is untouched. */
/* T4, measured: MAIN_ATTACK's pull reached 3.57 and the mission was assigned so
   rarely that it barely registered. At 1.26x it reaches about 4.50 and
   missionPull is now the top decider at 25.5%. MAIN_ATTACK only: applied inside
   that case rather than at the call site, which would scale FLANK, SUPPORT and
   FIX with it and change nothing about their relative standing. */
/* T5, measured, and the largest single change here. This gates whether the AI
   may PLAN an attack at all: below it, everything falls through to FIX_AND_FLANK,
   which assigns FLANK and FIX and no attack. At 1.15 an army needed a 15% edge
   before it was allowed to attack, which produced 8 MAIN_ATTACK assignments
   against 97 FLANK and 75 FIX in one match. At 1.00 parity is enough. */
export const MAIN_ATTACK_RATIO = 1.00;

export const MAIN_ATTACK_PULL_MUL = 1.26;

export const TERRAIN_SEEK_MAX = 0.84;

export const THREAT_SCORE_MAX  = 1.80;   // was 2.50; before that effectively 5.00, uncapped
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
/* A4: screensGun was NOT absent, which the export's own term table shows at
   0.00 to 0.50. It was present and too small to matter, which reads the same in
   a decider list and is a different problem. screensGunBonus returns 0.50, so a
   weight of 3 gives the +1.50 asked for. */
export const SCREENS_GUN_WEIGHT = 3.0;

export const GUN_HOLDS_FIRE_BONUS = 3.0;   // T6, measured: was 2.5

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
/* =========================================================
   THE FINISHING RULE

   Seed 1526369304: from turn 21 to turn 44 Britain had one Brigade at
   Brigadier plus a single battery, cornered at (1,7). One kill won the match.
   France fired at it nine times, every one from range 5 needing a 5+, while its
   own battery sat five rows away and never moved, and the 5e Cuirassiers sat
   four tiles off and never closed. Twenty-two turns.

   THE VALUE WAS ALREADY THERE. brigadeKillValue gives a Brigade's last unit
   3.00, doubled to 6.00 once one enemy Brigade is broken, which is exactly this
   case. It never mattered, because it is only applied in the FIGHT step, to
   targets a unit can reach this turn. Nothing four tiles away can, so the one
   number that knew the match was on the line never pulled anybody across the
   board. What did pull was killPull at 0.34 per tile, which ordinary cohesion
   and threat terms outweigh, and artillery is excluded from that entirely, while
   gun positioning measures range to the NEAREST enemy rather than to the
   remnant. A gun with any shot keeps gunHasShot, so it stayed at range 5.

   So the rule acts on MOVEMENT, which is where the problem was:

     cavalry within 6 tiles and infantry within 4 converge on the remnant,
       if the fight estimator does not already rate that fight as bad
     guns with line of fire at range 5+ give up the long shot and close to
       range 3-4, where a battery hits most of the time
     in the fight itself the remnant is worth +6.00, or +8.00 if it wins

   GUARDS, so this cannot turn into suicide charges:
     - Nobody is pulled toward, or paid to attack, a fight estimateFightValue
       rates below zero. A gun in a building is a bad fight for horse and stays
       one: the finishing value is added to a fight worth having, it never
       rescues a fight that is not. Infantry, for whom the same building may be
       a fair fight, still come.
     - squareTrap and the fight estimator are untouched.
     - A unit fleeing for its own life (selfPreservation) is not recruited.
     - EIGHT TURNS. A remnant that cannot be reached must not absorb the whole
       army. On expiry the target goes on an eight-turn cooldown, otherwise
       "revert and re-evaluate" would re-select it at once and it would never
       expire.

   This is the mirror of the player's own PRESERVE play. Reduce a Brigade to a
   Brigadier and one unit, hide it, and grind with the intact Brigades while the
   AI shoots at 5+. The player hunts the AI's remnants with cavalry every time;
   now the AI has the same instinct.

   Brigadiers are never the target (a Brigadier alone is already broken) and are
   never recruited (they are the chain, not a striking unit).
========================================================= */
export const FINISH_MAX_TURNS = 8;
export const FINISH_KILL_VALUE = 6.0;
export const FINISH_KILL_VALUE_WINS = 8.0;
export const FINISH_CAV_RADIUS = 6;
export const FINISH_INF_RADIUS = 4;
export const FINISH_PULL = 1.0;             // per tile; killPull is 0.34
export const FINISH_GUN_BAND_BONUS = 3.0;   // a square at range 3-4 with line of fire

/* OFF BY DEFAULT. Measured over 104 matches against saladin: 48.9% of decided
   matches, remnants finished in a median of 6 to 10 turns either way, and
   undecided matches up from 1 in 26 to 12 in 104. Kept, switched off, until the
   within-reach measurement says whether it does its job where it can. With it
   off, killCreditFor falls straight through to brigadeKillValue on the -1.5
   floor, which is Saladin's behaviour exactly. The 'finishing' variant turns it
   on. */
function finishingEnabled(side){ return tune(side, 'FINISHING_RULE', 0) > 0; }

function finishNote(side, text){
  if(!state._aiFinishingLog) state._aiFinishingLog = {};
  if(!state._aiFinishingLog[side]) state._aiFinishingLog[side] = [];
  state._aiFinishingLog[side].push({ turn: state.turnNumber, text });
}

function fightingMembers(side, bId){
  return state.units.filter(o => !o.removed && o.side===side &&
    o.brigadeId===bId && o.type!=='BRIGADIER');
}

/* Read-only: the target this side is finishing this turn, or null. */
export function currentFinishing(side){
  if(!finishingEnabled(side)) return null;
  const f = state._aiFinishing && state._aiFinishing[side];
  if(!f) return null;
  const t = state.units.find(o => o.id===f.targetId);
  return (t && !t.removed) ? { ...f, unit: t } : null;
}

/* Once per side per turn, from aiPlanTurn: resolve, expire, or select. */
export function updateFinishing(side){
  if(!state._aiFinishing) state._aiFinishing = {};
  if(!state._aiFinishCooldown) state._aiFinishCooldown = {};
  if(!state._aiFinishCooldown[side]) state._aiFinishCooldown[side] = {};
  const cooldown = state._aiFinishCooldown[side];
  if(!finishingEnabled(side)){ delete state._aiFinishing[side]; return null; }
  const enemy = otherSide(side);
  const cur = state._aiFinishing[side];

  if(cur){
    const t = state.units.find(o => o.id===cur.targetId);
    if(!t || t.removed){
      finishNote(side, `FINISHING resolved: ${cur.label} destroyed T${state.turnNumber}, ` +
        `${state.turnNumber - cur.startedTurn} turns after the rule fired. Enemy Bde ${cur.brigadeId+1} broken.`);
      delete state._aiFinishing[side];
    } else if(state.turnNumber - cur.startedTurn >= FINISH_MAX_TURNS){
      finishNote(side, `FINISHING expired: ${FINISH_MAX_TURNS} turns, ${cur.label} not reached. Reverting.`);
      cooldown[t.id] = state.turnNumber + FINISH_MAX_TURNS;
      delete state._aiFinishing[side];
    } else if(fightingMembers(enemy, t.brigadeId).length !== 1){
      delete state._aiFinishing[side];   // no longer a remnant; nothing to report
    } else {
      return cur;
    }
  }

  const broken = brigadeBrokenStatus(enemy).filter(Boolean).length;
  const own = state.units.filter(o => !o.removed && o.side===side && o.type!=='BRIGADIER');
  if(!own.length) return null;
  let pick = null, pickDist = Infinity;
  for(const bId of brigadeIdsForSide(enemy)){
    const members = fightingMembers(enemy, bId);
    if(members.length !== 1) continue;
    const t = members[0];
    if((cooldown[t.id] || 0) > state.turnNumber) continue;
    if(isConcealedFromEnemy(t)) continue;
    const d = Math.min(...own.map(o => chebyshev(o, t)));
    if(d < pickDist){ pickDist = d; pick = t; }
  }
  if(!pick) return null;

  const wins = broken >= 1;
  const label = pick.historicalName || pick.type;
  const f = { targetId: pick.id, brigadeId: pick.brigadeId, startedTurn: state.turnNumber, wins, label };
  state._aiFinishing[side] = f;

  const near = [], far = [], guns = [];
  for(const o of own){
    const d = chebyshev(o, pick), ot = UNIT_TYPES[o.type];
    const name = o.historicalName || o.type;
    if(ot.isArtillery){
      if(d > 4 && hasLOS(o, pick)) guns.push(`${name} repositioning from range ${d}`);
    } else {
      /* The log names only who is actually committed, by the same test the
         movement term uses, so it can be read as "who went" rather than "who
         was nearby". A unit held back by the fight estimator says so. */
      const radius = ot.isCavalry ? FINISH_CAV_RADIUS : FINISH_INF_RADIUS;
      if(d > radius){ if(ot.isCavalry) far.push(`${name} (${d} tiles, out of range)`); }
      else if((fv => finishFloor(o) === 0 ? fv < 0 : fv <= finishFloor(o))(estimateFightValue(o, pick)))
        far.push(`${name} (${d} tiles, held back: bad fight)`);
      else near.push(`${name} (${d} tiles)`);
    }
  }
  finishNote(side, `FINISHING: enemy Bde ${pick.brigadeId+1} at Brigadier + 1 (${label} at (${pick.x},${pick.y})). ` +
    `Kill value +${(wins ? FINISH_KILL_VALUE_WINS : FINISH_KILL_VALUE).toFixed(2)}${wins ? ' (would win)' : ''}. ` +
    `Converging: ${[...near, ...far].join(', ') || 'none in reach'}.` +
    (guns.length ? ` ${guns.join('; ')}.` : ''));
  return f;
}

/* What this unit does about the remnant this turn, from its REAL position, not
   the candidate square it is being scored on. Cached per unit per turn. */
function finishRoleFor(u, startX, startY){
  if(u._finRoleTurn === state.turnNumber) return u._finRole;
  u._finRoleTurn = state.turnNumber;
  u._finRole = null;
  const f = currentFinishing(u.side);
  if(!f || u.type==='BRIGADIER') return null;
  const tgt = f.unit, ut = UNIT_TYPES[u.type];
  const d = Math.max(Math.abs(startX - tgt.x), Math.abs(startY - tgt.y));
  if(ut.isArtillery){
    const ox = u.x, oy = u.y;
    let los = false;
    try { u.x = startX; u.y = startY; los = hasLOS(u, tgt); } finally { u.x = ox; u.y = oy; }
    if(los && d > 4) u._finRole = { kind: 'gun', f };
    return u._finRole;
  }
  const radius = ut.isCavalry ? FINISH_CAV_RADIUS : FINISH_INF_RADIUS;
  if(d > radius) return null;
  { const fv = estimateFightValue(u, tgt), floor = finishFloor(u);
    if(floor === 0 ? fv < 0 : fv <= floor) return null; }   // a bad fight stays a bad fight
  u._finRole = { kind: ut.isCavalry ? 'cav' : 'inf', f };
  return u._finRole;
}

/* The fight-step win-condition credit, with the finishing target folded in.
   Every site that added brigadeKillValue goes through here so the three agree. */
/* The fight floor a unit must clear before the remnant's value counts. Cavalry
   must face a fight worth having (>= 0): a gun in a building is a bad fight for
   horse and the finishing value must not talk it in. Everyone else keeps the
   floor brigadeKillValue already used (-1.5). Applying the cavalry test to
   infantry as well was measured and made finishing SLOWER than Saladin, since
   it withdrew the +6 Saladin already paid for exactly the fights infantry take
   against a remnant in cover. */
function finishFloor(attacker){
  return attacker && UNIT_TYPES[attacker.type].isCavalry ? 0 : KILL_VALUE_ENGAGE_FLOOR;
}

export function killCreditFor(side, target, fv, attacker){
  const f = currentFinishing(side);
  if(f && f.targetId === target.id){
    const floor = finishFloor(attacker);
    if(floor === 0 ? fv < 0 : fv <= floor) return 0;
    return f.wins ? FINISH_KILL_VALUE_WINS : FINISH_KILL_VALUE;
  }
  return fv > KILL_VALUE_ENGAGE_FLOOR ? brigadeKillValue(target) : 0;
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
  /* T5: THIS IS THE MISSION DISTRIBUTION LEVER, and it is a plan threshold
     rather than a mission one. MAIN_ATTACK as a MISSION is only ever handed out
     by a MAIN_ATTACK, BRIGADE_DESTRUCTION, CAVALRY_EXPLOITATION or
     FINISHING_BLOW plan. Everything between 0.75 and this ratio falls through to
     FIX_AND_FLANK, which assigns FLANK and FIX and no attack at all. That is the
     whole of the reported 8 MAIN_ATTACK against 97 FLANK and 75 FIX: not a
     reluctant mission pass, an army that is almost never quite strong enough to
     be allowed to plan an attack. */
  } else if(a.weakestEnemyBrigade && a.strengthRatio >= tune(side, 'MAIN_ATTACK_RATIO', MAIN_ATTACK_RATIO)){
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
    /* TIER 1: THE THIRD BRIGADE GETS A JOB.

       It was RESERVE, and RESERVE with nothing to release it means idle. The
       Sep 19 match is the clearest case in the dataset: Murat's Brigade held
       position from turn 11 to turn 25 while the Carabiniers fought eighteen
       times on their own three squares away.

       An army with three Brigades and one enemy worth attacking has a spare
       formation, and the use of a spare formation is to stop the enemy's other
       Brigades from joining in. That is what FIX means and the mission already
       exists; nothing was ever routed to it outside the two flanking plans.

       Only when there IS a second enemy Brigade to pin. With one enemy Brigade
       left there is nothing to fix and RESERVE is honest. */
    others.forEach((id,i)=>{
      if(i===0){ missions[id] = 'SUPPORT'; return; }
      const spare = tier(side, 1) && (assessment.liveEnemyBrigades||[]).some(b=>b.id!==plan.targetBrigadeId);
      missions[id] = spare ? 'FIX' : 'RESERVE';
    });
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
  /* DRIVEN HERE, NOT FROM THE PLAN CHOOSER. It was called from inside the plan
     chooser first, which looked like the same thing and is not: hysteresis makes
     that function early-return whenever the previous plan is kept, so the tempo
     machine only advanced on turns the PLAN changed. The army sat in BUILD past
     turn 13 with an 8-turn cap that never fired, and half of all sides never
     reached COMMIT at all. aiPlanTurn runs once per side per turn regardless. */
  /* Stamp how long each unit has been off the chain, once per side per turn.
     Cleared the moment it reconnects, so the count is "stuck since", not "ever
     stuck". Lives on the unit, so undo carries it like everything else. */
  {
    const conn = movableUnitsForSide(side);
    for(const u of state.units){
      if(u.removed || u.side!==side || u.type==='BRIGADIER') continue;
      if(conn.has(u.id)) delete u._strandedSince;
      else if(u._strandedSince === undefined) u._strandedSince = state.turnNumber;
    }
  }
  if(tempoV2(side)) advanceTempo(side, assessment);
  const plan = updateOperationalPlan(side, assessment);
  const missions = assignBrigadeMissions(side, plan, assessment);
  /* Recovery errands override the army's mission for at most one Brigade, and
     outrank a plan refresh for their duration: the plan may change around the
     Brigadier, it may not call him back halfway. */
  updateRecoveryErrands(side, missions);
  updateFinishing(side);
  state._aiMissions[side] = missions;
  if(!state._aiObjectives) state._aiObjectives = {};
  state._aiObjectives[side] = assignBrigadeObjectives(side, plan, assessment, missions);
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

/* ============================ PLANNING HIERARCHY ============================
   Three tiers, each with its own off switch so a measurement can attribute a
   result to one of them instead of to all three at once.

     tier 1  ARMY      which Brigade does what (roles across the army)
     tier 2  BRIGADE   what each Brigade's own objective is
     tier 3  GROUPING  sub-Brigade clusters, re-formed every turn

   DEFAULT OFF, after measurement. Built ON, measured at 44% over 28 matches
   losing on BOTH sides (41.6% / 46.1%), which is the shape of a real change
   effect rather than a side artefact, so it does not ship on. With all three off
   the scoring is byte-identical to the build before them.

   Turn one on at a time in the simulator to find which tier costs:
     node tools/sim/run.mjs 30 plan_tier1   (and plan_tier2, plan_tier3) */
export function tier(side, n){ return tune(side, 'PLAN_TIER'+n, 0) > 0; }

/* TIER 2. Each Brigade's own target. The main effort and its supporter go at the
   plan's target; anything on FIX pins a DIFFERENT enemy Brigade, chosen as the
   nearest one that is not already being attacked, so the spare formation holds
   the reinforcements rather than joining the queue. Computed once per side per
   turn in aiPlanTurn and read from the cache here. */
export function objectiveTargetFor(side, brigadeId, plan){
  const obj = state._aiObjectives && state._aiObjectives[side];
  if(obj && obj[brigadeId] !== undefined) return obj[brigadeId];
  return plan ? plan.targetBrigadeId : null;
}

export function assignBrigadeObjectives(side, plan, assessment, missions){
  const out = {};
  const enemyBrigades = assessment.liveEnemyBrigades || [];
  for(const id of Object.keys(missions)){
    const bid = Number(id);
    if(missions[id] !== 'FIX'){ out[bid] = plan ? plan.targetBrigadeId : null; continue; }
    const own = state.units.filter(o=>!o.removed && o.side===side && o.brigadeId===bid);
    let best = null, bestD = Infinity;
    for(const eb of enemyBrigades){
      if(eb.id === (plan ? plan.targetBrigadeId : null)) continue;
      const foes = state.units.filter(o=>!o.removed && o.side===otherSide(side) && o.brigadeId===eb.id);
      if(!foes.length || !own.length) continue;
      let d = Infinity;
      for(const a of own) for(const f of foes) d = Math.min(d, chebyshev(a,f));
      if(d < bestD){ bestD = d; best = eb.id; }
    }
    out[bid] = best!=null ? best : (plan ? plan.targetBrigadeId : null);
  }
  return out;
}

/* TIER 3. SUB-BRIGADE CLUSTERS, re-formed every turn.

   A Brigade is not reliably one body. It arrives as one, gets cut in half by a
   dead unit in the middle of the chain, and then fights as two groups whether
   the AI models that or not. Until now it did not: every unit was pulled toward
   the Brigade as a whole, which for a split Brigade means pulled toward the
   average of two places it is not, so both halves drift inward and neither
   arrives anywhere.

   Clusters are transitive at chebyshev <= 2 and rebuilt from scratch each turn,
   so there is no membership to maintain and no stale group to go wrong: two
   halves that reunite are simply one cluster again next turn.

   Memoised per side per turn because the scoring loop asks once per candidate
   square. */
export const CLUSTER_RADIUS = 2;
export const CLUSTER_COHESION_PULL = 0.22;
let _clusterCache = { turn: -1, side: null, byUnit: null };
export function clusterOf(u){
  if(_clusterCache.turn !== state.turnNumber || _clusterCache.side !== u.side){
    const byUnit = new Map();
    const pool = state.units.filter(o=>!o.removed && o.side===u.side && o.type!=='BRIGADIER');
    const seen = new Set();
    for(const seed of pool){
      if(seen.has(seed.id)) continue;
      const group = [seed]; seen.add(seed.id);
      for(let i=0; i<group.length; i++){
        for(const o of pool){
          if(seen.has(o.id) || o.brigadeId !== seed.brigadeId) continue;
          if(chebyshev(group[i], o) <= CLUSTER_RADIUS){ group.push(o); seen.add(o.id); }
        }
      }
      for(const m of group) byUnit.set(m.id, group);
    }
    _clusterCache = { turn: state.turnNumber, side: u.side, byUnit };
  }
  return _clusterCache.byUnit.get(u.id) || null;
}

export function missionMoveBonus(u, side, pos, mission, plan){
  if(!mission) return 0;
  const assessment = state._aiDebugLog[side] ? state._aiDebugLog[side].assessment : null;
  /* TIER 2: THE BRIGADE'S OWN OBJECTIVE, not the army's.

     Every Brigade used to aim at plan.targetBrigadeId, so a FIX Brigade pinned
     the same enemy the main effort was already attacking. That is not fixing,
     it is queueing: two Brigades converge on one target while the enemy's other
     Brigades walk to wherever they like. Tier 2 gives each Brigade its own
     target and the fallback is the old army-wide one, so with the tier off the
     behaviour is byte-identical. */
  const objTargetId = tier(side, 2) ? objectiveTargetFor(side, u.brigadeId, plan) : (plan ? plan.targetBrigadeId : null);
  const targetBrigade = objTargetId!=null
    ? state.units.filter(o=>!o.removed && o.side===otherSide(side) && o.brigadeId===objTargetId)
    : [];
  const nearestTargetDist = targetBrigade.length ? Math.min(...targetBrigade.map(o=>chebyshev(pos,o))) : null;

  switch(mission){
    case 'MAIN_ATTACK':
      // Push hard at the plan's actual target, not just the nearest enemy.
      /* T4: MAIN_ATTACK ONLY. Multiplied here rather than at the missionPull
         call site, which would scale FLANK, SUPPORT and FIX with it and change
         nothing about their relative standing. Defaults to 1. */
      return (nearestTargetDist!=null
        ? -nearestTargetDist*APPROACH_PULL + Math.max(0, 6-nearestTargetDist)*0.18 : 0)
        * tune(side, 'MAIN_ATTACK_PULL_MUL', MAIN_ATTACK_PULL_MUL);
    case 'FLANK':
      // Favour the weak-flank column band while closing, rather than a straight line in.
      if(!assessment) return nearestTargetDist!=null
        ? -nearestTargetDist*APPROACH_PULL + Math.max(0,6-nearestTargetDist)*0.12 : 0;
      { const towardFlank = assessment.weakFlank==='left' ? (COLS-pos.x)*0.02 : pos.x*0.02;
        return (nearestTargetDist!=null
          ? -nearestTargetDist*APPROACH_PULL + Math.max(0,6-nearestTargetDist)*0.12 : 0) + towardFlank; }
    case 'REUNITE':
    case 'FETCH': {
      const errand = brigadeErrand(side, u.brigadeId);
      const rally = errand ? errandRallyPoint(errand) : null;
      if(!rally) return 0;
      const d = chebyshev(pos, rally);
      /* He is the one going. The close-range sweetener is what stops him
         stopping two squares short, which frees nobody. */
      if(u.type==='BRIGADIER') return -d*APPROACH_PULL + Math.max(0, 4-d)*0.20;
      /* REUNITE brings the Brigade back with him. FETCH leaves it where it
         stands, which is the entire point of FETCH: the ground it holds is
         worth more than closing the gap. */
      return mission==='REUNITE' ? -d*APPROACH_PULL*0.6 : 0;
    }
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
  /* THE BRIGADIER GOES IN THE MIDDLE WHEN PART OF HIS BRIGADE IS CUT OFF.

     Brigadier first is right for a Brigade that is all in one piece: the rest
     get a freshly-moved anchor to path toward. It is wrong the moment the
     Brigade is in two pieces, and that is how a Brigade usually ends up, because
     the enemy kills the unit in the middle of the chain on purpose. Severing a
     Brigade is a real tactic and the AI should answer it rather than have the
     rule bent for it.

     A person answers it by ORDERING the turn. Move the group that can already
     move, then walk the Brigadier across to bridge the group that cannot, then
     move those as well. One Brigadier serves two clusters in a single turn.

     The AI could not do that for one reason: the Brigadier always moved first,
     so his new position could only ever help NEXT turn. Everything else needed
     was already in place, because legalMoves recomputes the chain for every unit
     as it moves, so a Brigadier who repositions mid-phase unlocks units behind
     him immediately.

     So when a Brigade has a cut-off member, the order becomes:
        connected members (outermost first)  ->  Brigadier  ->  cut-off members
     and when it does not, it stays exactly as it was.

     ARTILLERY IS NOT COUNTED as cut off for this. A battery parked on a vantage
     point and deliberately left off the chain is normal play, not an accident,
     and rearranging a whole Brigade's turn to go and collect one would be the AI
     misreading a good position as a problem. */
  const connected = movableUnitsForSide(side);
  const strandedMates = {};
  for(const bId of Object.keys(brigadierOf)){
    strandedMates[bId] = units.some(u => u.brigadeId===bId && u.type!=='BRIGADIER' &&
      !UNIT_TYPES[u.type].isArtillery && !connected.has(u.id));
  }
  const PHASE_CONNECTED = 0, PHASE_BRIGADIER = 1, PHASE_CUTOFF = 2;
  const phaseOf = u => {
    if(!strandedMates[u.brigadeId]) return PHASE_CONNECTED;   // unchanged ordering
    if(u.type==='BRIGADIER') return PHASE_BRIGADIER;
    return connected.has(u.id) ? PHASE_CONNECTED : PHASE_CUTOFF;
  };
  const chainDepth = u => {
    if(u.type==='BRIGADIER') return -Infinity;
    const brig = brigadierOf[u.brigadeId];
    return brig ? -chebyshev(u, brig) : 0;   // negated, so furthest sorts first
  };

  return units
    .sort((a,b)=> (brigadeX[a.brigadeId]-brigadeX[b.brigadeId])
               || (phaseOf(a)-phaseOf(b))
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

/* F1: IN-MATCH ADAPTATION — posture from how the battle is actually going.

   Everything that decides tempo today is a clock: BUILD until turn 6, HOLD until
   contact or turn 14, COMMIT after. It never once asks whether the army is
   winning. So an AI three units down presses on the same schedule as one three
   units up, which is the wrong way round on both counts.

   AHEAD ON MATERIAL: commit. A lead is a wasting asset in a game decided by
   Brigade breaks, and the side that is ahead wants the match resolved while the
   advantage exists.

   BEHIND ON MATERIAL: hold. Not retreat, and not PRESERVE, which is a separate
   and much later judgement about a specific Brigade. Simply refuse the even
   fight that a losing side cannot afford, and wait for a better one.

   Measured from evaluateState, which is already the AI's own view of the
   position, rather than a unit count: it weighs a Guard against a battery
   properly and counts terrain and command chains, which a headcount does not.

   NOT AN ESCALATION. A previous attempt raised mission pull as a match went
   stale and measured 15% stalls to 27%, because forcing both sides forward hands
   the match to whoever is not first into contact. This changes WHICH side
   presses rather than pressing both, so it cannot produce that failure: the two
   sides cannot both be ahead.

   Off unless ADAPT_TO_MATERIAL is set. */
function materialPosture(side){
  if(!flag(side, 'ADAPT_TO_MATERIAL')) return null;
  const margin = evaluateState(side);
  const threshold = tune(side, 'ADAPT_MARGIN', 2.0);
  if(margin >= threshold) return 'COMMIT';
  if(margin <= -threshold) return 'HOLD';
  return null;   // level enough that the clock knows better
}

/* =========================================================
   PHASED TEMPO — the army arrives together or not at all

   BUILD, HOLD and COMMIT already existed as a TURN CLOCK: build until 6, hold
   until 14 or contact, commit thereafter, with one multiplier on missionPull.
   That is a schedule, not a tempo. It cannot tell an army that has closed up
   from one still strung out, so units reach contact at their own pace and fight
   one at a time, which is how five units go 0 from 1 in a single match.

   This keeps the three phases and replaces the clock with triggers, so the phase
   describes what the army IS doing rather than what turn it is.

   IT ADDS NO SCORING. Every phase effect is a multiplier on a term that already
   exists, applied in tempoMultipliers below. The tempo layer decides WHEN engage
   is allowed to matter; the existing scoring decides everything else.

   Gated behind TEMPO_V2, so with the flag unset the clock runs exactly as before.

   NOTE FOR THE SIMULATOR: this is written as a fix for France arriving
   piecemeal, but the AI is side-agnostic and a spectated match gives BOTH armies
   the same code. Two armies that both hold and both commit may simply cancel, so
   a variant-vs-control run is the only measurement that means anything here. A
   self-play run will not show it.
========================================================= */
export const TEMPO_BUILD_MAX_TURNS   = 8;   // BUILD cannot run for ever on a wide board
export const TEMPO_HOLD_MAX_TURNS    = 6;   // nor can HOLD: hard cap, always commit eventually
export const TEMPO_CONTACT_DISTANCE  = 4;   // centroid separation that counts as "at contact distance"
export const TEMPO_GUNS_FIRED_TURNS  = 4;   // guns firing this long with no answer means go
export const TEMPO_COMMIT_LOSSES     = 4;   // cumulative losses after COMMIT that send the army back to HOLD
export const TEMPO_COMMIT_DRY_TURNS  = 3;   // turns with no contact after COMMIT before resetting
/* HOW CLOSED UP THE ARMY MUST BE BEFORE IT IS ALLOWED TO GO.

   Aiming every Brigade at one sector is not the same as them arriving there
   together. Without this the army commits on the first opportunity whatever
   shape it is in, a Brigade five squares back sets off anyway, and it turns up
   late and alone: measured at 8.6 units going 0 from 1 per match, worse than
   doing nothing at all.

   Measured as the widest separation between Brigade centroids. The hard HOLD cap
   deliberately OVERRIDES this, because an army that waits for a formation it can
   never achieve is the never-commit failure again wearing a different hat. */
export const TEMPO_READY_SPREAD = 6;

/* PHASED TEMPO STAYS OFF BY DEFAULT, on the evidence rather than on doubt.

   It was measured twice, in opposite directions, and neither result is strong
   enough to act on:

     tempo ON as the variant, old clock as control   60.0% on 25 decided
     old clock as the variant, tempo ON as control   57.5% on 33 decided

   Those cannot both be right. The second is the mirror of the first and should
   have come back near 40% if the first were real. Two readings in the 55-60 band
   pointing opposite ways is not a close call, it is no evidence, and the honest
   conclusion is that the 60% was small-sample noise that happened to land the
   flattering side of the line.

   The system is not reverted, because the tempo report shows it doing what it
   was built to do on the measures that are not win rate: contact spread 49.8
   turns to 17.5, units dying alone 7.0 to 3.8, fighting after COMMIT nearly six
   times the fighting before. Those are real and they are not visible in a win
   rate, because both armies get the change and the advantage cancels.

   So it stays available and off. Turning it on is a variant away. What it needs
   before it becomes the default is a run large enough to separate 55% from 50%,
   which at the current stall rate means several hundred matches. */
export const TEMPO_V2_DEFAULT = false;

/* THE AVOIDANCE CEILING.

   No avoidance term may outweigh the best fight on the board. brigadierTrail
   reached -6.30 and freeStrandedUnit -7.20 in one match, against an engage that
   only reached +3.00, so a Brigadier faced -13.50 for doing anything other than
   reconnecting and would decline a winning fight to go and tidy up.

   NEITHER WAS A WEIGHT BLOWOUT, which matters for the fix. Both are
   distance-proportional: trail is off x 0.9 and recovery is chebyshev x 0.9, so
   at eight squares they read -6.30 and -7.20 from a weight of 0.9 that has not
   moved. Capping the TERM is therefore right and lowering the weight would be
   wrong: the weight is what gives the Brigadier a gradient to follow.

   The cost, stated because it is real: beyond about three squares the cap
   flattens the gradient, so a distant Brigadier sees the same score everywhere
   and has nothing to walk down. Recovery survives that because the trail anchor
   still points at the stranded unit; if it stops working, this is why. */
export const AVOIDANCE_CEILING = 2.50;

/* THE TWO HEAVIES ARE A PAIR. Built earlier and left at 0, so it has never run.
   Turned on now because the case is specific: across one match the Carabiniers
   and Cuirassiers fought six times between them and were never once adjacent to
   each other, going 1 from 6, while the British heavies went 9 from 12 operating
   together. cavalryConcentration treats all four horse alike, which is right for
   arriving together and wrong for this: the bond is between two named regiments. */
export const HEAVY_PAIR_BONUS = 2.00;

/* A FLOOR ON missionPull, which is a pull and should not behave like a wall.
   It reached -6.30, which is past engage's whole ceiling, so a unit could refuse
   a winning fight because the mission disliked the square. -4.00 leaves it the
   largest single pull in the game and stops it deciding fights on its own. */
export const MISSION_PULL_FLOOR = -4.00;

/* CAUTION THAT WEARS OFF WHEN NOTHING IS HAPPENING.

   Four attempts on the stalls have failed, and every one pushed on the wrong
   side: Brigadier recovery, mission suppression, tempo escalation and letting
   cut-off units move all tried to make the army GO. The term data says the
   problem is the opposite. killPull, vulnerablePull and threat are what block
   every stalled decision dumped so far: an even fight looks not worth having, so
   nobody takes it, and two armies that both decline every even fight sit still
   for two thousand turns.

   So this decays the AVOIDANCE rather than raising the pull. The difference
   matters and is not cosmetic: raising the pull pushes both sides forward and
   hands the match to whoever is not first into contact, which is exactly how the
   tempo escalation measured 15% stalls to 27%. Making a fight look less
   frightening does not create that asymmetry, because the side that takes the
   fight is the side that had the better one available.

   MEASURED IN CASUALTIES, NOT TURNS. A grinding, bloody match should never feel
   this; a staring contest should feel it hard. Turns since anything died says
   exactly that, where raw turn number cannot tell the two apart. It resets the
   moment a unit falls, so the army presses, resolves something, and settles
   again rather than ratcheting to reckless and staying there. */
export const STALE_FROM = 12;    // side activations without a casualty before caution loosens
export const STALE_STEP = 0.04;  // fraction of caution shed per activation beyond that
export const STALE_FLOOR = 0.35; // never below this: a decayed AI is not a suicidal one

export function turnsSinceKill(){
  return state.turnNumber - (state._lastKillTurn ?? 1);
}

/* 1.0 normally, falling toward STALE_FLOOR the longer nothing dies. */
export function cautionDecay(side){
  if(!flag(side, 'STALE_DECAY')) return 1;
  const stale = turnsSinceKill() - STALE_FROM;
  if(stale <= 0) return 1;
  return Math.max(STALE_FLOOR, 1 - stale * STALE_STEP);
}

/* Per-phase multipliers on terms that already exist. 1 means untouched.
   threat at 0.6 in COMMIT is the one to watch: it is what carries an advance
   through rather than stalling it on the first bad tile, and it is also the
   most likely thing to make the AI walk into a wall. */
export const TEMPO_MULTIPLIERS = {
  BUILD:  { engage:0.2, missionPull:1.0, mutualSupport:1.5, advancePull:1.0, threat:1.0, gunHasShot:1.0, terrainSeek:1.0 },
  HOLD:   { engage:0.2, missionPull:0.3, mutualSupport:1.5, advancePull:0.0, threat:1.0, gunHasShot:1.5, terrainSeek:1.5 },
  COMMIT: { engage:1.0, missionPull:1.5, mutualSupport:1.0, advancePull:1.5, threat:0.6, gunHasShot:1.0, terrainSeek:0.5 },
};

/* ON unless a variant explicitly turns it off. tune() rather than flag(),
   because flag() defaults false and this now defaults true: a variant sets
   TEMPO_V2 to false to get the old turn clock back as a control. */
function tempoV2(side){ return tune(side, 'TEMPO_V2', TEMPO_V2_DEFAULT) !== false; }

export function tempoMultiplier(side, term){
  if(!tempoV2(side)) return term==='missionPull' ? (TEMPO_PULL[tempoPhase(side)] ?? 1) : 1;
  const m = TEMPO_MULTIPLIERS[tempoPhase(side)];
  return (m && m[term] !== undefined) ? m[term] : 1;
}

function centroidOf(units){
  if(!units.length) return null;
  return { x: units.reduce((t,u)=>t+u.x,0)/units.length, y: units.reduce((t,u)=>t+u.y,0)/units.length };
}

/* The tempo record for a side, created on first use and carried on state so it
   survives undo and cannot leak between matches. */
function tempoState(side){
  if(!state._tempo) state._tempo = {};
  if(!state._tempo[side]) state._tempo[side] = {
    phase: 'BUILD', since: state.turnNumber, gunsFiredTurns: 0,
    commitSector: null, lossesSinceCommit: 0, dryTurns: 0, lastTurn: -1,
  };
  return state._tempo[side];
}

/* Evaluated once per side per turn. Returns the phase and records the reason, so
   the log can say WHY rather than only what. */
function advanceTempo(side, assessment){
  const t = tempoState(side);
  if(t.lastTurn === state.turnNumber) return t;
  t.lastTurn = state.turnNumber;
  const turnsIn = state.turnNumber - t.since;
  const live = s2 => state.units.filter(u=>!u.removed && u.side===s2);
  const own = centroidOf(live(side)), foe = centroidOf(live(side==='red'?'blue':'red'));
  const gap = (own && foe) ? Math.max(Math.abs(own.x-foe.x), Math.abs(own.y-foe.y)) : 99;
  const inContact = !!contactPoint(side);
  if(inContact) t.gunsFiredTurns++; else t.gunsFiredTurns = 0;

  const to = (phase, reason) => {
    if(t.phase !== phase){
      logReplay('tempo', { side, from:t.phase, to:phase, reason, turn:state.turnNumber,
                           commitSector:t.commitSector });
      log(`TEMPO: ${t.phase} -> ${phase}  reason="${reason}"`, 'system');
      t.phase = phase; t.since = state.turnNumber;
      t.lossesSinceCommit = 0; t.dryTurns = 0;
    }
    t.reason = reason;
  };

  if(t.phase === 'BUILD'){
    if(gap <= TEMPO_CONTACT_DISTANCE) to('HOLD', `army within ${TEMPO_CONTACT_DISTANCE} of the enemy mass`);
    else if(turnsIn >= TEMPO_BUILD_MAX_TURNS) to('HOLD', `BUILD capped at ${TEMPO_BUILD_MAX_TURNS} turns`);
  } else if(t.phase === 'HOLD'){
    /* Opportunity triggers first, so a real opening beats the timeout and the
       sector it happened in becomes the commit axis rather than a fallback. */
    const a = assessment;
    let sector = null, why = null;
    if(a && a.weakestEnemyBrigade && a.weakestEnemyBrigade.remaining <= 2){
      sector = a.weakestEnemyBrigade.centroid || null; why = 'an enemy Brigade is below half';
    } else if(a && a.exposedEnemyArtillery && a.exposedEnemyArtillery.length){
      sector = a.exposedEnemyArtillery[0]; why = 'enemy artillery is unescorted';
    } else if(inContact){
      sector = contactPoint(side); why = 'the enemy came into the held line';
    } else if(t.gunsFiredTurns >= TEMPO_GUNS_FIRED_TURNS){
      sector = a && a.weakestEnemyBrigade ? (a.weakestEnemyBrigade.centroid||null) : null;
      why = `guns have fired for ${TEMPO_GUNS_FIRED_TURNS} turns and the enemy is not coming`;
    } else if(turnsIn >= TEMPO_HOLD_MAX_TURNS){
      sector = a && a.weakestEnemyBrigade ? (a.weakestEnemyBrigade.centroid||null) : null;
      why = `HOLD capped at ${TEMPO_HOLD_MAX_TURNS} turns`;
    }
    /* The widest gap between this side's Brigade centroids. */
    const brigCentroids = [...new Set(live(side).map(u=>u.brigadeId))]
      .map(b => centroidOf(live(side).filter(u=>u.brigadeId===b))).filter(Boolean);
    let spread = 0;
    for(const a1 of brigCentroids) for(const b1 of brigCentroids){
      spread = Math.max(spread, Math.max(Math.abs(a1.x-b1.x), Math.abs(a1.y-b1.y)));
    }
    const ready = spread <= TEMPO_READY_SPREAD;
    const forced = turnsIn >= TEMPO_HOLD_MAX_TURNS;
    if(why && (ready || forced)){
      t.commitSector = sector || foe;
      to('COMMIT', ready ? why : `${why} (committed unready: HOLD capped)`);
    } else if(why){
      t.reason = `waiting to close up (Brigades ${spread} apart)`;
    }
  } else if(t.phase === 'COMMIT'){
    if(inContact) t.dryTurns = 0; else t.dryTurns++;
    if(t.lossesSinceCommit >= TEMPO_COMMIT_LOSSES) to('HOLD', `${TEMPO_COMMIT_LOSSES} losses since COMMIT`);
    else if(t.dryTurns >= TEMPO_COMMIT_DRY_TURNS) to('HOLD', `no contact for ${TEMPO_COMMIT_DRY_TURNS} turns after COMMIT`);
  }
  log(`TEMPO: phase=${t.phase} turn_in_phase=${state.turnNumber - t.since}`, 'system');
  return t;
}

function tempoPhase(side){
  if(tempoV2(side)) return tempoState(side).phase;
  const cache = state._aiTempoCache;
  if(cache && cache.side===side && cache.turn===state.turnNumber) return cache.phase;
  let phase;
  const posture = materialPosture(side);
  if(posture) phase = posture;
  else if(state.turnNumber >= TEMPO_COMMIT_TURN) phase = 'COMMIT';
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
/* F2: NARROWED FROM 3 TO 2, and this is the change that lets the guns shoot.

   The doctrine says do not move within 3 of an enemy. The acceptance target
   wants most shots at range 2-4. Those contradict: to shoot at range 3 a gun
   must STAND at range 3, which was inside the guard, so the rule written to keep
   batteries safe was the rule keeping them out of their own effective band. Four
   matches running, range 5-6 took the majority of shots and hit 14-18%.

   At 2 the guard still covers what it was for. A gun at 1 or 2 is reachable by
   anything; a gun at 3 is a move away from being reached, which is the risk
   canister is worth taking. Range 3 and 4 are now free ground. */
export const GUN_APPROACH_GUARD  = 2;    // do not move this close to an enemy without holding the ground

/* F2: TWO TERMS, NOT FIVE, AND A CEILING ON BOTH.

   Five overlapping negatives (standoff, stranded, approachGuard, settled,
   crowded) summed to a potential -10.50 against +5.15 of positives, and each was
   individually defensible while the total was not. They are now reported and
   capped as two groups:

     gunExposure    - proximity danger: crowding, and walking into reach
     gunPositioning - positioning quality: too far to hit, churning, no vantage

   Capped at 1.75 each, so the combined gun negative cannot exceed -3.50 however
   many of the underlying rules fire at once. The rules themselves are unchanged
   and still readable one at a time; what changed is that they can no longer
   stack into a veto behind everyone's back. Same fault as soloAttackPenalty in
   F1, and the same fix. */
export const GUN_PENALTY_GROUP_CAP = 1.75;

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

/* RECOVERING A UNIT THAT IS NOT A GUN IS NOT AN ERRAND.

   A gun off the cohesion chain may still be doing its job, which is why
   gunIsStranded exempts an established battery and why the pull that collects
   one is deliberately weak.

   Nothing else has that defence. movableUnitsForSide gates a unit on where it
   IS, and moving is the only way back onto the chain, so an Infantry or Cavalry
   unit that loses its link is frozen for the rest of the match: it cannot move,
   cannot rejoin, and cannot be freed by anything it does itself. It still counts
   as a live unit, so its Brigade never breaks. A hundred-match run found matches
   running past turn 2000 for exactly this reason, with the board static except a
   Brigadier shuffling between two squares.

   So for anything but a gun the recovery is the mission, not an errand:
   ANYWHERE on the board, and a pull above APPROACH_PULL so it outweighs the
   general advance. Nothing the Brigade can do is worth more than getting a
   frozen unit moving again, and nothing else will. */
export const STRANDED_RECOVERY_RANGE = 99;   // the whole board — distance is not the test
/* Deliberately BRIGADIER_TRAIL_WEIGHT, not a number picked for this. Recovery
   REPLACES trailing the line rather than competing with it (see the Brigadier
   block below), so it wants the same magnitude as the term it stands in for.
   Tried at 0.30 first and it lost: Uxbridge sat still with three of his own
   units frozen because closing one square gained 0.30 and cost 0.41 of trail. */
export const STRANDED_RECOVERY_PULL = 0.9;


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

/* THE ONE UNIT A BRIGADIER SHOULD DROP EVERYTHING FOR, or null.

   Factored out because three separate places need the same answer and they must
   agree: the pull that draws him toward it, the trail anchor it replaces, and
   the mission pull it overrides. Two of those live in a different function from
   the third, and an earlier version computed it twice with slightly different
   rules, which produced a Brigadier who was pulled toward a stranded unit by one
   term and held in place by another.

   NON-GUNS FIRST, then nearest. A gun off the chain may be doing its job and
   gunIsStranded already exempts an established battery. Anything else off the
   chain is frozen for the rest of the match, so it always outranks a gun. */
/* =========================================================
   BRIGADE RECOVERY ERRANDS — REUNITE and FETCH

   Reconnecting a scattered Brigade is a CAMPAIGN, not a step. It can take the
   Brigadier several turns to reach a cut-off group, and for those turns a large
   part of the Brigade is either walking backwards or unable to move at all. So
   it has to be a decision he commits to and sees through, not something
   re-litigated every turn by whichever square happens to score best.

   TWO ERRANDS, because there are two situations and they want opposite things
   from the units that are still connected:

     REUNITE  the Brigade falls back onto the cut-off group. Used when the
              units he would otherwise leave behind are under pressure, so
              splitting the Brigade further is how you lose both halves.

     FETCH    the connected units hold the ground they are on, and he goes and
              collects the strays alone. He is the fastest thing on the board,
              two squares minimum and no terrain penalty, so he can make the
              round trip while the rest keep their position. Used when nothing
              can reach the units he is leaving.

   THE TRIGGER is more than 40% of the Brigade's remaining units off the chain.
   Below that he leaves them and the Brigade keeps doing its job, which is the
   right answer: going back for one straggler while the other five are winning
   a fight is how a Brigade loses the fight.

   HE COMMITS TO A GROUP, NOT A UNIT. Cut-off units cluster, and the chain is
   built from adjacency, so arriving beside two of them frees two. Committing to
   the group is also what stops him dithering between individuals.

   THE COMMITMENT RUNS UP TO FOUR TURNS and is released early only by success or
   death, never by the trigger ratio moving. That matters because the ratio is a
   proportion of REMAINING units, so a single casualty can flip it without
   anybody moving, and an errand cancelled halfway is worse than one never
   started. The one exception is a FETCH upgrading to a REUNITE when the units
   left behind come under threat, which is the failsafe rather than a reversal.

   ONE BRIGADE AT A TIME per side. Three Brigadiers all walking backwards at
   once is an army in retreat, and the other two Brigades have work to do
   holding the enemy's attention while this one sorts itself out.

   Move ordering needs nothing added: orderAiUnitsForMove already runs connected
   members, then the Brigadier, then the cut-off group whenever a Brigade is
   split, which is exactly the fall-back order a person plays. Because he moves
   after his own units and is pulled toward the strays, he ends up stepping back
   behind the line on the diagonal without any notion of "backwards" having to
   be hard-coded, which would have read wrong the moment a Brigade wheels.
========================================================= */
export const ERRAND_TRIGGER_RATIO = 0.40;
export const ERRAND_MAX_TURNS = 4;
export const ERRAND_GROUP_RADIUS = 2;
export const FETCH_THREAT_RADIUS = 2;     // one move plus contact for most things
export const FETCH_THREAT_RATIO = 0.50;

/* NOT AI_UNIT_VALUE, which rates artillery highest at 6. That is right for what
   a gun is worth and wrong for who to walk to: a battery parked on a vantage
   point and deliberately left off the chain is normal play, not an accident. */
const RECOVERY_VALUE = { HEAVY_CAV:5, GUARD:4.5, LIGHT_CAV:4, INFANTRY:3, ARTILLERY:0.5 };

function errandsEnabled(side){ return tune(side, 'BRIGADE_ERRANDS', 1) > 0; }

function brigadeMembers(side, bId){
  return state.units.filter(o => !o.removed && o.side===side &&
    o.brigadeId===bId && o.type!=='BRIGADIER');
}

/* Transitive clustering at ERRAND_GROUP_RADIUS, so a string of cut-off units
   reads as one errand rather than three. */
function strandedGroups(side, bId){
  const stray = brigadeMembers(side, bId).filter(unitIsStranded);
  const groups = [], seen = new Set();
  for(const u of stray){
    if(seen.has(u.id)) continue;
    const g = [u]; seen.add(u.id);
    for(let i=0; i<g.length; i++){
      for(const o of stray){
        if(seen.has(o.id)) continue;
        if(chebyshev(g[i], o) <= ERRAND_GROUP_RADIUS){ g.push(o); seen.add(o.id); }
      }
    }
    groups.push(g);
  }
  return groups;
}

/* VALUE AND PROXIMITY WEIGH THE SAME, deliberately: a line unit back in the
   fight this turn can be worth more than heavy cavalry back next turn. Longest
   wait breaks a tie, which keeps the rotation that stops him fixating on the
   same group; a coin flip breaks what is left, on the SEEDED stream so a match
   still replays exactly. */
function chooseErrandGroup(brig, groups){
  if(!groups.length) return null;
  if(groups.length === 1) return groups[0];
  const val  = g => g.reduce((s,u) => s + (RECOVERY_VALUE[u.type] ?? 3), 0);
  const dist = g => Math.min(...g.map(u => chebyshev(brig, u)));
  const vals = groups.map(val), dists = groups.map(dist);
  const vLo = Math.min(...vals), vHi = Math.max(...vals);
  const dLo = Math.min(...dists), dHi = Math.max(...dists);
  const norm = (x, lo, hi) => hi > lo ? (x - lo) / (hi - lo) : 1;
  let best = -Infinity, ties = [];
  groups.forEach((g, i) => {
    const score = norm(vals[i], vLo, vHi) + (1 - norm(dists[i], dLo, dHi));
    if(score > best + 1e-9){ best = score; ties = [g]; }
    else if(Math.abs(score - best) <= 1e-9) ties.push(g);
  });
  if(ties.length === 1) return ties[0];
  const waited = g => Math.max(...g.map(u => state.turnNumber - (u._strandedSince ?? state.turnNumber)));
  const longest = Math.max(...ties.map(waited));
  const still = ties.filter(g => waited(g) === longest);
  return still[Math.floor(seededRandom() * still.length)] || still[0];
}

export function brigadeErrand(side, bId){
  const book = state._aiErrands && state._aiErrands[side];
  return book ? (book[bId] || null) : null;
}

/* The rally point is the centroid of the group he is going to, recomputed each
   turn from whoever is still alive. They cannot move, so it barely shifts; it
   moves when one of them dies, which is the right time for it to move. */
export function errandRallyPoint(errand){
  const live = errand.ids.map(id => state.units.find(o => o.id===id)).filter(o => o && !o.removed);
  if(!live.length) return null;
  return { x: Math.round(live.reduce((s,o)=>s+o.x,0) / live.length),
           y: Math.round(live.reduce((s,o)=>s+o.y,0) / live.length) };
}

function pressingEnemies(side, units){
  if(!units.length) return 0;
  /* Flat headcount, no weighting for cavalry: infantry form square against
     horse and already do so under the existing tactics. */
  return state.units.filter(o => !o.removed && o.side!==side && o.type!=='BRIGADIER' &&
    units.some(f => chebyshev(o, f) <= FETCH_THREAT_RADIUS)).length;
}

/* Called once per side per turn, straight after missions are assigned, and it
   OVERRIDES the mission for at most one Brigade. */
export function updateRecoveryErrands(side, missions){
  if(!state._aiErrands) state._aiErrands = {};
  if(!state._aiErrands[side]) state._aiErrands[side] = {};
  const book = state._aiErrands[side];
  if(!errandsEnabled(side)){
    for(const k of Object.keys(book)) delete book[k];
    return missions;
  }

  /* Running errands are settled BEFORE any ratio is recomputed, so a casualty
     moving the denominator cannot cancel one in flight. */
  for(const key of Object.keys(book)){
    const e = book[key], bId = Number(key);
    const live = e.ids.filter(id => {
      const o = state.units.find(x => x.id===id);
      return o && !o.removed && unitIsStranded(o);
    });
    const hasBrigadier = state.units.some(o => !o.removed && o.side===side &&
      o.brigadeId===bId && o.type==='BRIGADIER');
    if(!live.length || !hasBrigadier || state.turnNumber - e.startedTurn >= ERRAND_MAX_TURNS){
      delete book[key];
      continue;
    }
    e.ids = live;
    /* The threat failsafe: a FETCH becomes a REUNITE the moment the units he
       left behind are pressed. Never the reverse, which would be a reversal
       rather than a failsafe. */
    if(e.kind === 'FETCH'){
      const held = brigadeMembers(side, bId).filter(o => !e.ids.includes(o.id) && !unitIsStranded(o));
      if(held.length && pressingEnemies(side, held) >= held.length * FETCH_THREAT_RATIO) e.kind = 'REUNITE';
    }
    if(missions[bId] != null) missions[bId] = e.kind;
  }

  if(Object.keys(book).length) return missions;    // one Brigade at a time

  let pick = null, pickGroup = null, pickRatio = ERRAND_TRIGGER_RATIO;
  for(const key of Object.keys(missions)){
    const bId = Number(key);
    if(missions[key]==='WITHDRAW' || missions[key]==='PRESERVE') continue;
    const brig = state.units.find(o => !o.removed && o.side===side &&
      o.brigadeId===bId && o.type==='BRIGADIER');
    if(!brig) continue;
    const members = brigadeMembers(side, bId);
    if(members.length < 2) continue;
    const groups = strandedGroups(side, bId);
    const ratio = groups.reduce((s,g)=>s+g.length, 0) / members.length;
    if(ratio <= pickRatio) continue;
    const g = chooseErrandGroup(brig, groups);
    if(g){ pickRatio = ratio; pick = bId; pickGroup = g; }
  }
  if(pick == null) return missions;

  const held = brigadeMembers(side, pick).filter(o => !pickGroup.includes(o) && !unitIsStranded(o));
  const kind = (held.length && pressingEnemies(side, held) >= held.length * FETCH_THREAT_RATIO)
    ? 'REUNITE' : 'FETCH';
  book[pick] = { kind, ids: pickGroup.map(u => u.id), startedTurn: state.turnNumber };
  missions[pick] = kind;
  return missions;
}

/* The per-turn pin. brigadierRecoveryTarget answers "who should he go to from
   where he is standing", which is a question about the Brigadier's real
   position, not about a square being considered. Cached per unit per turn so
   every candidate is scored against the same man. */
export function brigadierRecoveryTargetForTurn(brig){
  if(brig.type!=='BRIGADIER') return null;
  if(brig._recoveryPinTurn !== state.turnNumber){
    brig._recoveryPinTurn = state.turnNumber;
    brig._recoveryPin = brigadierRecoveryTarget(brig);
  }
  /* A pin survives the turn, not the target's death or rescue. */
  const t = brig._recoveryPin;
  if(t && (t.removed || !unitIsStranded(t))) return null;
  return t;
}

export function brigadierRecoveryTarget(brig){
  if(brig.type!=='BRIGADIER') return null;
  const mates = state.units.filter(o => !o.removed && o.side===brig.side &&
    o.brigadeId===brig.brigadeId && o.id!==brig.id && unitIsStranded(o));
  if(mates.length===0) return null;
  /* LONGEST WAITING FIRST, then nearest. This is the rotation.

     Nearest alone makes a Brigadier fixate: he bridges the closest group, they
     move, they are closest again next turn, and a Brigade split three ways gets
     the same cluster freed over and over while the others sit for the whole
     match. Which is exactly what the probe found, with four units cut off in one
     Brigade and only ever one of them collected.

     A person does not play it that way. He bridges one group, then the other,
     then back, so every cluster gets its turn across two or three moves. Sorting
     by how long a unit has been stuck reproduces that without needing a rota:
     the group just freed resets to zero and drops to the back of the queue, and
     whoever has waited longest comes to the front on its own.

     Distance still breaks the tie inside a wait band, so he does not cross the
     board past a nearer group to reach one that has been stuck a turn longer. */
  mates.sort((a,b) => {
    const ga = UNIT_TYPES[a.type].isArtillery ? 1 : 0;
    const gb = UNIT_TYPES[b.type].isArtillery ? 1 : 0;
    if(ga !== gb) return ga - gb;
    const wa = state.turnNumber - (a._strandedSince ?? state.turnNumber);
    const wb = state.turnNumber - (b._strandedSince ?? state.turnNumber);
    if(wa !== wb) return wb - wa;                       // longest wait first
    return chebyshev(brig,a) - chebyshev(brig,b);
  });
  const best = mates[0];
  if(UNIT_TYPES[best.type].isArtillery) return null;   // a gun stays the errand it always was
  return best;
}

/* Cut off from the Brigadier's chain, and therefore unable to move at all until
   he comes. Artillery keeps its exemption: an established battery is where it
   should be. Everything else is simply frozen. */
export function unitIsStranded(u){
  if(UNIT_TYPES[u.type].isArtillery) return gunIsStranded(u);
  if(u.type==='BRIGADIER') return false;   // the chain starts from him; he is connected by definition
  return !movableUnitsForSide(u.side).has(u.id);
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
    /* F3: SET AND STAND-DOWN NOW SHARE ONE RADIUS.

       Setting allowed an enemy up to 5 squares away; standing down fires when
       none is within AMBUSH_STANDDOWN_RANGE (4) for three turns. A unit that hid at
       exactly 5 was therefore already in stand-down territory on the turn it
       committed, and burned three unit-turns proving it. In seed 99304470 that
       is all three ambushes: two laid in a far corner at T5 and stood down at
       T11 and T13, none ever resolving.

       Same class of fault as the fight-gate hang: two numbers that had to agree,
       with nothing making them. One constant now, read by both. */
    if(near>=2 && near<=AMBUSH_STANDDOWN_RANGE){
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
  /* C5: the bogged gun stays exactly as it was. The raid flag widens the search
     to any UNESCORTED battery, which is the common case the bogged test cannot
     see, and gives it its own weight so the two can be told apart in the export. */
  let boggedTarget = (state.aiDifficulty==='hard' && t.isCavalry) ? findBoggedEnemyGun(side) : null;
  let raidTarget = null;
  if(!boggedTarget && t.isCavalry && flag(side, 'GUN_RAID')){
    raidTarget = findRaidableEnemyGun(side, u);
  }
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
            + addScore(parts, 'threat', Math.max(-tune(side, 'THREAT_SCORE_MAX', THREAT_SCORE_MAX), -0.5*threatPenalty(u, side)) * tempoMultiplier(side, 'threat') * cautionDecay(side));
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
      /* C1: RANGING CAVALRY. The brief named brigadierTrail, but that term only
         exists on a Brigadier. The leash on a moving unit is cohesionLoss, so
         the discount belongs here.

         A cavalry unit with a fight worth having may leave command range for it;
         below the threshold the leash holds at full weight. That preserves the
         7e Hussards pattern (5 fights, 3 wins, 0 losses while disconnected)
         without reopening general disconnection, which ran 1.5% to 8% to 11%
         across three matches and is the reason cohesionLoss exists.

         The fight is measured against enemies adjacent to the CANDIDATE square
         rather than the full reachable set, because engage is not computed until
         much later in this function and duplicating the reachability walk here
         would cost more than the term is worth. Melee is at range 1 anyway, so
         the two agree for everything except a charge run. */
      const ranging = flag(side, 'CAVALRY_MAY_RANGE') && t.isCavalry;
      let leash = 2.4;
      if(ranging){
        let bestFight = -Infinity;
        for(const o of state.units){
          if(o.removed || o.side===side || chebyshev(c, o) > 1) continue;
          bestFight = Math.max(bestFight, estimateFightValue(u, o));
        }
        if(bestFight >= tune(side, 'CAVALRY_RANGE_THRESHOLD', 3.0)) leash *= 0.3;
      }
      if(!t.isArtillery) s -= subScore(parts, 'cohesionLoss', leash);
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
      // Reported as gunPositioning so the export shows the two groups rather than a
      // third name for the same concern: a gun with no field of fire is badly placed.
      else if(!vantageScore(u, c.x, c.y)) s -= subScore(parts, 'gunPositioning', cappedGunPenalty(parts, side, Math.min(2.4, GUN_PENALTY_GROUP_CAP)));
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
      /* The gun errand, unchanged: weak, range-limited, and only when there is
         no frozen unit to go to instead (brigadierRecoveryTarget returns null
         when the best candidate is a gun). */
      const strandedGun = state.units.find(o => !o.removed && o.side===side &&
        o.brigadeId===u.brigadeId && gunIsStranded(o));
      /* PINNED FOR THE TURN, AT HIS REAL POSITION.

         This used to be recomputed on every candidate square, and the scorer
         teleports the unit to the candidate before scoring, so who counted as
         stranded changed from square to square. The result was the exact
         opposite of the intended behaviour: the moment a step WOULD reconnect
         the man he was going to, that man stopped being stranded, the target
         switched to the next casualty further away, and the penalty went UP.

         Measured in a stalled match, seed 1. Thomas Graham two squares from the
         Scots Greys, who had zero legal moves: holding scored the term at 1.80,
         stepping to 16,6 and actually freeing them scored 2.50, because from
         there the term had moved on to the 10th Hussars three squares away. He
         held. All three Brigadiers held, in armies where ten of eighteen units
         could not move at all, for eighteen hundred turns.

         He was being punished for succeeding. Pinning the target for the turn
         is what makes the distance a gradient he can walk down. */
      const recovering = brigadierRecoveryTargetForTurn(u);
      /* ONE TERM, NOT TWO, and it keeps the old name so a term-spread comparison
         against earlier match exports still lines up. What changed is which
         units it fires for and how hard it pulls, both readable from the value. */
      /* TWO DIFFERENT ERRANDS, TWO DIFFERENT NAMES, and they were sharing one.

         freeStrandedUnit is a Brigadier going to un-freeze a unit that cannot
         move at all until he arrives. collectStrandedGun is him picking up a
         battery that can still move and is merely out of position. They were
         both logged as 'collectStrandedGun', so the export could not say which
         was doing the work, exactly as cavalryConcentration could not. */
      if(recovering){
        s -= subScore(parts, 'freeStrandedUnit',
          Math.min(tune(side,'AVOIDANCE_CEILING',AVOIDANCE_CEILING),
                   chebyshev(c, recovering) * tune(side, 'STRANDED_RECOVERY_PULL', STRANDED_RECOVERY_PULL)));
      } else if(strandedGun && chebyshev(u, strandedGun) <= GUN_RECOVERY_RANGE){
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
        /* RECOVERY REPLACES TRAILING, it does not compete with it.

           Trailing the forward-most unit is the Brigadier's job only while the
           line can move. With a Brigade-mate cut off the chain, that unit is
           frozen for the rest of the match unless he goes to it, and trailing is
           the exact term that keeps him from going: it holds him one to two
           squares behind the advance, which is usually the opposite direction.
           Observed directly, with Uxbridge stationary while three of his own
           units sat immobile five and six squares away.

           So while he is recovering, the unit he trails IS the cut-off one. Same
           weight, same band, same machinery; only the anchor changes. A gun does
           NOT do this: an established battery is where it should be, and
           collecting it stays the errand it always was. */
        const anchor = recovering || brigadeMates.reduce((best,o)=>
          nearestEnemyDist(o, side) < nearestEnemyDist(best, side) ? o : best, brigadeMates[0]);
        const gap = chebyshev(c, anchor);
        /* RECOVERY NEEDS ADJACENCY, NOT PROXIMITY. The normal band holds him one
           to two squares behind the line, which is right for a Brigadier
           following an advance and useless for freeing a cut-off unit: the
           cohesion chain is built from ADJACENCY, so stopping at two squares
           leaves the unit exactly as frozen as before. Watched Murat do it,
           walking to within two of a stranded Grenadier and settling there for
           two hundred turns. While recovering the band is 0 to 1. */
        /* The adjacency band is what makes recovery WORK (the chain is built
           from adjacency, so stopping two squares short frees nobody), so it is
           not tunable. The PULL is, because that is what decides how much else
           the Brigadier abandons on the way. */
        const trailMin = recovering ? 0 : BRIGADIER_TRAIL_MIN;
        const trailMax = recovering ? 1 : BRIGADIER_TRAIL_MAX;
        const off = gap < trailMin ? (trailMin - gap)
                  : gap > trailMax ? (gap - trailMax) : 0;
        s -= subScore(parts, 'brigadierTrail',
          Math.min(tune(side,'AVOIDANCE_CEILING',AVOIDANCE_CEILING), off * BRIGADIER_TRAIL_WEIGHT));

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
        let exposure = 0, positioning = 0;
        if(crowd >= GUN_CROWD_THRESHOLD) exposure += (crowd - GUN_CROWD_THRESHOLD + 1) * 1.3;

        /* RULE 4: DO NOT WALK INTO REACH without holding the ground.

           Only applied to a square the gun is MOVING TO. A gun already sited
           close is covered by rule 2, which is about how many are coming rather
           than how near they are: standing firm for a canister shot must not be
           penalised as though the gun had just walked there. */
        if(!c.stay && d <= GUN_APPROACH_GUARD){
          const edge = localSuperiority(side, c.x, c.y, GUN_APPROACH_GUARD);
          if(edge < 2) exposure += (GUN_APPROACH_GUARD - d + 1) * 0.7;
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
          positioning += 1.1;
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
        positioning += bandMiss * 0.90;

        // Capped as groups, so no combination of the rules above can veto a move.
        if(exposure > 0)    s -= subScore(parts, 'gunExposure',    Math.min(exposure, GUN_PENALTY_GROUP_CAP));
        if(positioning > 0) s -= subScore(parts, 'gunPositioning', cappedGunPenalty(parts, side, Math.min(positioning, GUN_PENALTY_GROUP_CAP)));

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
              /* C2: HOLD FIRE AND WALK TO A BETTER ANGLE.

                 Scaling the hold bonus by hit chance was the soft version of this
                 and it is not enough on its own. A gun with a 1-in-3 shot at range
                 5 still scores something for staying, and something beats nothing
                 when the alternative tile has no target in view at all until the
                 gun arrives. The Sep 19 match fired thirteen times at range 5 for
                 two hits while range 3 went five for five.

                 So when the shot in hand is poor and a genuinely better one is
                 within this turn's move, the bonus for staying is withdrawn
                 outright rather than merely discounted. The gun is then free to
                 reposition on gunVantage, which already knows where the good
                 ground is.

                 BUILT IN THE MOVE PHASE, WHICH IS THE ONLY PLACE IT CAN WORK. A
                 gun cannot move and fire in the same turn, so a Fire-phase version
                 of this rule declines the shot and then has nothing to spend the
                 turn on: it just loses the shot. The decision is a movement
                 decision and has to be taken while movement is still available. */
              const poorNow  = best <= HOLD_FIRE_POOR;
              const betterEls = poorNow && bestReachableHitChance(u) >= HOLD_FIRE_GOOD;
              /* A closing gun gives up the long shot: moving to range 3-4 on
                 the remnant beats a 5+ roll at it, every turn it is available. */
              const closing = (finishRoleFor(u, startX, startY) || {}).kind === 'gun';
              if(!betterEls && !closing){
                s += addScore(parts, 'gunHasShot',
                  (tune(side, 'GUN_HOLDS_FIRE_BONUS', GUN_HOLDS_FIRE_BONUS) +
                   Math.min(shots, 3) * 0.2) * best * tempoMultiplier(side, 'gunHasShot'));
              }
            }
          }
        }
      } else {
        s -= subScore(parts, 'advancePull', nearestEnemyDist(c, side) * ADVANCE_PULL_WEIGHT * tempoMultiplier(side, 'advancePull'));
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
    /* FINISHING: converge on the remnant. Not gated on seekTactics or
       holdingReserve for the same reason as killPull, and far stronger than it,
       because this is the one move that ends the match. */
    if(!selfPreservation){
      const role = finishRoleFor(u, startX, startY);
      if(role && (role.kind==='cav' || role.kind==='inf')){
        s -= subScore(parts, 'finishing', chebyshev(c, role.f.unit) * FINISH_PULL * (role.kind==='inf' ? 0.6 : 1));
      } else if(role && role.kind==='gun'){
        const d = chebyshev(c, role.f.unit);
        if(d >= 3 && d <= 4 && hasLOS(u, role.f.unit)) s += addScore(parts, 'finishing', FINISH_GUN_BAND_BONUS);
        else s -= subScore(parts, 'finishing', Math.max(0, d - 4) * 0.5);
      }
    }
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
          /* TWO TERMS, NOT ONE LABEL.

             These used to share the name 'cavalryConcentration', so the export
             showed only their NET and the two cancelled. That produced three
             separate reports of the term "regressing to negative-only" and one
             of it vanishing, none of which were regressions: they were matches
             where the horse were not massed, read through a label that could not
             say so. It was nearly patched a fourth time.

             Split, the log answers the actual question: cavalryMass is what
             massing PAYS, cavalryConcentration is what being scattered COSTS.
             The scoring is byte-identical, only the reporting changes. */
          const gap = chebyshev(c, point);
          if(gap > 0) s -= subScore(parts, 'cavalryConcentration', gap * CAVALRY_CONCENTRATION_PULL);
          const massed = state.units.filter(o=>!o.removed && o.side===side && o.id!==u.id &&
            UNIT_TYPES[o.type].isCavalry && chebyshev(o, point) <= 2).length;
          if(massed >= 1) s += addScore(parts, 'cavalryMass', Math.min(2, massed) * 0.6);
        }
        else s += addScore(parts, 'vulnerablePull', vulnerableTargetPullBonus(c, side, getVulnerableEnemyUnits(side)));
        /* B5: THE TWO HEAVIES ARE A PAIR, not two cavalry.

           cavalryConcentration and cavalryMass treat all four horse alike, which
           is right for arriving together and wrong for the thing the dataset
           actually shows: every AI success had the heavy regiments operating
           together, every collapse had them split. That is a bond between two
           specific units, not a general proximity reward, so it is its own term
           and reads as its own line in the export.

           Defaults to 0, so it does not exist unless a variant turns it on.

           PLACED AFTER the if(point)/else chain, not between them. The first
           attempt sat between the closing brace and the else, which is valid
           JavaScript and silently rebound that else to THIS if: every light
           cavalry started collecting vulnerablePull on top of the rally-point
           logic, and seeds 1 to 3 went from resolving to stalling. node --check
           and eslint both passed it. Only the simulator caught it. */
        if(UNIT_TYPES[u.type].key === 'HEAVY_CAV'){
          const pairBonus = tune(side, 'HEAVY_PAIR_BONUS', HEAVY_PAIR_BONUS);
          if(pairBonus){
            const partner = state.units.find(o => !o.removed && o.side===side && o.id!==u.id &&
              UNIT_TYPES[o.type].key === 'HEAVY_CAV');
            if(partner && chebyshev(c, partner) <= 2) s += addScore(parts, 'heavyPair', pairBonus);
          }
        }
        /* TIER 3: FIGHT AS THE GROUP YOU ARE IN, not the one on the roster.

           Pull toward this unit's own cluster's centre rather than the Brigade's.
           For an intact Brigade the two are the same place and this changes
           nothing. For a Brigade cut in two it is the whole difference: the old
           behaviour pulled both halves toward the average of two positions, which
           is a point neither half occupies and often one no unit can reach, so
           both drifted and neither concentrated.

           Zero for a cluster of one. A lone unit is not a group and should be
           free to go where the rest of its scoring sends it rather than be taxed
           for standing alone, which threat and soloAttackPenalty already handle
           and handle better. */
        if(tier(side, 3)){
          const group = clusterOf(u);
          if(group && group.length > 1){
            let cx = 0, cy = 0, n = 0;
            for(const m of group){ if(m.id===u.id) continue; cx += m.x; cy += m.y; n++; }
            if(n){
              const gap = chebyshev(c, { x: cx/n, y: cy/n });
              if(gap > CLUSTER_RADIUS) s -= subScore(parts, 'clusterCohesion', (gap-CLUSTER_RADIUS) * CLUSTER_COHESION_PULL);
            }
          }
        }
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
        let solo = 0;
        for(const target of wouldContact){
          if(target.turnOnly || target.rallying) continue;   // wounded: finish it
          // Would anyone else be able to join this fight this turn?
          if(supportCountFor(target, side, u.id) === 0) solo += SOLO_ATTACK_PENALTY;
        }
        /* Decayed alongside threat. These two are the genuine avoidance terms in
           a stalled decision. killPull and vulnerablePull look like blockers in a
           parts dump because they read negative, but both are -distance x worth,
           so they get LESS negative as a unit closes: they are pulls toward a
           target, and decaying them would make the AI more timid, not less. */
        if(solo > 0) s -= subScore(parts, 'soloAttackPenalty',
          Math.min(solo, SOLO_ATTACK_PENALTY_MAX) * cautionDecay(side));
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
          const combined = fv + killCreditFor(side, o, fv, u);
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
        s += addScore(parts, 'engage', (beaten ? Math.min(0, best) : best) * ENGAGE_WEIGHT * tempoMultiplier(side, 'engage'));
        if(beaten) s += addScore(parts, 'disengage', -0.5 * Math.min(5, u.lossStreak));
        if(!beaten && bestTarget){
          const credit = killCreditFor(side, bestTarget, rawEngage, u);
          const fin = currentFinishing(side);
          if(credit) s += addScore(parts, fin && fin.targetId===bestTarget.id ? 'finishing' : 'brigadeKillValue', credit);
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
      /* T3: a ceiling, not a weight change. The defensive multiplier of 2.4 is
         what takes this past 1.20, and scaling the multiplier would also weaken
         it in the ordinary case where it is already the right size. Capping the
         term leaves normal play alone and only trims the defensive peak.
         Defaults to Infinity, so with no override nothing moves. */
      s += addScore(parts, 'terrainSeek',
        Math.min(tune(side, 'TERRAIN_SEEK_MAX', TERRAIN_SEEK_MAX),
                 terrainSeekBonus(t.key, c.x, c.y) * (defensivePosture ? 2.4 : 1))
        * tempoMultiplier(side, 'terrainSeek'));

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
        s += addScore(parts, 'mutualSupport', mutualSupportBonus(side, c, u.id) * tempoMultiplier(side, 'mutualSupport'));
        s += addScore(parts, 'groundDenial', groundDenialBonus(side, c));
      }
    }
    // Core Tactic #2, The Gunner's Creed: value screening an unguarded friendly gun.
    if(seekTactics) s += addScore(parts, 'screensGun',
      screensGunBonus(u, side, c) * tune(side, 'SCREENS_GUN_WEIGHT', SCREENS_GUN_WEIGHT));
    // Manoeuvre #20, The Bogged Column (Hard): close on a stuck, unescorted enemy gun.
    if(boggedTarget) s -= subScore(parts, 'boggedGun', chebyshev(c, boggedTarget) * 0.15);
    else if(raidTarget) s -= subScore(parts, 'gunRaid',
      chebyshev(c, raidTarget) * tune(side, 'GUN_RAID_PULL', 0.15));
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
      /* PRESERVE is exempt from the tempo layer entirely, as the brief
         requires: a Brigade pulling out is not part of the army's pacing.
         tempoMultiplier itself returns the old single missionPull value when
         TEMPO_V2 is off, so this one line covers both worlds. */
      const tempoMul = mission === 'PRESERVE' ? 1 : tempoMultiplier(side, 'missionPull');
      /* MEASURED AND REVERTED: suppressing missionPull for a recovering
         Brigadier. The reasoning was sound (there is no version of his mission
         worth anything while a third of his Brigade cannot move) and the local
         effect was exactly as intended: Thomas Graham stopped oscillating and
         advanced on his cut-off unit.

         The aggregate went the other way, hard. Stall rate over forty matches
         went from 6 in 40 to 14 in 39. A Brigadier with no mission pull stops
         holding the Brigade together in the ways the mission was quietly doing,
         so he frees one unit and strands the next. Left as a comment because the
         idea reads as obviously right and should not be re-derived from scratch
         in six months. It is not right. */
      s += addScore(parts, 'missionPull',
        Math.max(tune(side, 'MISSION_PULL_FLOOR', MISSION_PULL_FLOOR),
                 missionMoveBonus(u, side, c, mission, plan) * tempoMul));
    }
    // Section 9 (Hard): selective lookahead, only for the "important" move categories —
    // a charge, a move that sets up a fight next phase, or a Reserve/Fix-mission unit
    // being pulled into contact. Everything else stays 0-ply, same cost as before.
    if(mission){
      const setsUpFight = !c.stay && state.units.some(o=>!o.removed && o.side!==side && isAdjacent(c,o) && !isConcealedFromEnemy(o));
      const committingReserve = (mission==='RESERVE' || mission==='FIX') && !c.stay && nearestEnemyDist(c,side) <= unitBaseMove(u)+1;
      if(isChargeMove || setsUpFight || committingReserve) s -= subScore(parts, 'lookahead', lookaheadMovePenalty(u, side) * 0.4);
    }

    s += addScore(parts, 'jitter', seededRandom() * 0.03); // tie-breaking jitter: prevents an exact repeated stall between equally-scored options
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
  /* HEAVY CAVALRY WITH NOTHING TO ANSWER IT is its own reason to form, and it
     bypasses the threat threshold rather than adding to it.

     The trigger was tightened to stop over-forming and it worked, but it now
     under-forms against the one thing square exists for: Britain took fifteen
     "Cavalry vs non-Square Infantry" bonuses in a match where France formed
     square barely at all. HEAVY specifically, because the light regiments are
     what the tightened trigger is correctly ignoring and the heavies are what
     does the killing.

     The "no friendly cavalry within 2" clause is the important half. Square is
     the answer when there is no better one; with your own horse alongside, the
     better answer is to let them meet the charge and keep the infantry mobile.

     The three gates above still apply. Forming square next to enemy line
     infantry is a mistake whatever the cavalry is doing. */
  const enemyHeavyNear = state.units.some(o=>!o.removed && o.side!==side &&
    UNIT_TYPES[o.type].key==='HEAVY_CAV' && chebyshev(o, u) <= 3);
  const ownHorseNear = state.units.some(o=>!o.removed && o.side===side && o.id!==u.id &&
    UNIT_TYPES[o.type].isCavalry && chebyshev(o, u) <= 2);
  const heavyThreat = enemyHeavyNear && !ownHorseNear;
  if(canSquare && !enemyLineNear && !coverNear && !columnPartner &&
     (heavyThreat || (cavalryThreatWithinCharge(u, side) && threatPenalty(u, side) >= 1.4))){
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
    /* LABELS DRAIN PER UNIT, NOT PER TURN. The gate sits here, where a single
       unit's action has fully resolved, so the player reads what happened to
       that unit before the next one starts. Waiting until endMovePhase would
       let seventeen units' worth of labels pile up and then replay as a burst
       with nothing on the board to attach them to.

       floatingTextIdle resolves instantly when the queue is empty or the
       feature is off, so this costs nothing on a quiet turn and a turn with
       labels disabled runs at exactly its previous duration. The per-turn
       budget inside the module is what stops a heavy turn dragging. */
    setTimeout(()=> floatingTextIdle().then(()=> resolveAmbushSpringsNow(step)),
      moved ? moveAnimationMs(Math.max(1, steps)) + 60 : 340);
  }
  resetFloatingTextTurnBudget();
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
      score += pHit * tune(gun.side, 'COLUMN_TARGET_BONUS', COLUMN_TARGET_BONUS);
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
  /* FRAME THE SHOT BEFORE TAKING IT. The Firing phase never moved the camera at
     all, so a battery could fire from wherever the Move phase had left the view
     and the player would see the dice panel explain a shot happening off-screen.
     Both ends are framed, not the gun alone: the shot is only legible if you can
     see what it is aimed at. */
  cameraToAction([gun, best], { durationMs: CAMERA_ACTION_PAN_MS });
  setTimeout(()=> fireArtillery(gun, best, onComplete), CAMERA_ACTION_PAN_MS);
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
    /* VOLLEY TO MAKE THE OPENING, not merely to do damage.

       A volley that lands turns its target around, and a turned-around defender
       hands every attacker +1 for the rest of the turn. So the volley's real
       value is usually not the hit, it is the fight that comes after it, and the
       AI had no way to see that: this function scored Brigade attrition and
       nothing else, so it shot at whatever was nearest to breaking rather than
       at whatever its own cavalry was about to charge.

       The Sep 19 match is the gap in one line. Britain took 20 "Defender turned
       around" bonuses in 42 fights. France took 4. Nearly half of every British
       attack landed on a unit that had already been turned, and almost none of
       France's did.

       THE TARGET DOES NOT HAVE TO BE DISPLACED for this to work, which is where
       the existing VOLLEY_SETUP experiment went wrong: it scored the square the
       target would be knocked BACK to and then looked for someone who could
       reach it. A plain disrupt moves nobody and still confers the bonus. So the
       question is just: can one of ours fight this unit afterwards, where it
       already stands.

       Cavalry counts double. It has the reach to convert an opening from further
       out and the dice to make the +1 decisive, and pairing the volley with the
       charge is the combination the player uses. */
    let followUp = 0;
    for(const o of state.units){
      if(o.removed || o.side===t.side) continue;
      if(o.side!==state.aiSide) continue;
      if(UNIT_TYPES[o.type].isArtillery || o.type==='BRIGADIER') continue;
      if(o.turnOnly) continue;
      const horse = o.type==='HEAVY_CAV' || o.type==='LIGHT_CAV';
      const reach = horse ? unitBaseMove(o) : 1;
      if(chebyshev(o, t) <= reach) followUp = Math.max(followUp, horse ? 2.0 : 1.0);
    }
    sc += followUp * tune(state.aiSide, 'VOLLEY_OPENING', 1.0);
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
    /* C3: A VOLLEY IS A SETUP, NOT A KILL.

       Since a volley knocks back rather than destroys, its whole value is what
       happens next. The AI found the combination once on its own (seed 44561174,
       turn 20: the volley knocked 15th Hussars back, Carabiniers charged the
       displaced unit into "Defender turned around" and killed it) and never
       repeated it. Unscored, it either over-volleys for nothing or abandons the
       weapon entirely.

       Worth 1.5 when a friendly melee unit can reach the square the target is
       knocked back to this turn, 0.3 otherwise. Below the floor the volley is
       skipped, so the unit keeps its action for something that matters.

       Gated off by default: with VOLLEY_SETUP unset this does not run and every
       volley is taken exactly as before. */
    if(flag(u.side, 'VOLLEY_SETUP')){
      const dx = Math.sign(target.x - u.x), dy = Math.sign(target.y - u.y);
      const land = { x: target.x + dx, y: target.y + dy };
      const followUp = state.units.some(o => !o.removed && o.side===u.side && o.id!==u.id &&
        !UNIT_TYPES[o.type].isArtillery && o.type!=='BRIGADIER' &&
        chebyshev(o, land) <= unitBaseMove(o));
      const value = followUp ? 1.5 : 0.3;
      if(value < tune(u.side, 'VOLLEY_FLOOR', 1.0)){ step(); return; }
    }
    logAiDebugMove(u.side, { unit: unitLabel(u), mission: missionFor(u), action:'Volley',
                             target: unitLabel(target), score: '—' });
    /* A volley is always at range 1, so this is close to a pure close-up: the
       fit calculation settles at CAMERA_ACTION_ZOOM for two adjacent squares. */
    cameraToAction([u, target], { durationMs: CAMERA_ACTION_PAN_MS });
    setTimeout(()=> resolveVolley(u, target, ()=>{ draw(); setTimeout(step, 250); }), CAMERA_ACTION_PAN_MS);
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

/* C2 support. The best hit chance this gun could have from anywhere it can reach
   this turn, target visibility recomputed from each tile rather than assumed.

   Memoised per unit per turn: it is asked once per candidate square inside the
   scoring loop, and it walks every reachable tile and every enemy, so without the
   cache a single battery would pay for that scan a dozen times over for an answer
   that cannot change within the turn.

   The unit is moved onto each tile and put back, because artilleryTargets reads
   the gun's own position for range and line of sight. Restored in a finally, so
   an exception cannot leave a battery parked somewhere it never went. */
export const HOLD_FIRE_POOR = 0.34;   // 1-in-3 or worse (range 5+) counts as a poor shot
export const HOLD_FIRE_GOOD = 0.50;   // 1-in-2 or better (range 4 or nearer) is worth walking to
let _reachHitCache = { turn: -1, side: null, by: new Map() };
export function bestReachableHitChance(u){
  if(_reachHitCache.turn !== state.turnNumber || _reachHitCache.side !== u.side){
    _reachHitCache = { turn: state.turnNumber, side: u.side, by: new Map() };
  }
  if(_reachHitCache.by.has(u.id)) return _reachHitCache.by.get(u.id);
  const ox = u.x, oy = u.y;
  let best = 0;
  try {
    for(const c of legalMoves(u)){
      if(c.x===ox && c.y===oy) continue;
      u.x = c.x; u.y = c.y;
      for(const t of artilleryTargets(u)) best = Math.max(best, hitChance(chebyshev(u, t)));
    }
  } finally { u.x = ox; u.y = oy; }
  _reachHitCache.by.set(u.id, best);
  return best;
}

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
    /* THE SAME PREDICATE THE GATE USES, deliberately, and this is the fix for the
       turn-never-ends hang. This list and endFightPhase's gate used to decide
       independently whether a unit owed a fight, and R6's PRESERVE exclusion was
       added here only. A PRESERVE unit in contact became an obligation the gate
       demanded and this list refused to supply, and the phase retried forever.

       owesAFight is now the only definition of "this unit owes a fight" in the
       codebase, so there is no second place for a future exclusion to be added
       to and no way for the two to drift apart again. */
    const attackers = state.units.filter(u=>owesAFight(u, state.aiSide));
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
        s += killCreditFor(a.side, t, estimateFightValue(a, t), a);

        // Cut off from its Brigadier, or with no friendly unit within two
        // squares. It cannot be reinforced and, if disconnected, cannot even
        // move itself back to safety.
        if(vulnerableIds.has(t.id)) s += ISOLATED_TARGET_BONUS;

        if(s>bestScore){ bestScore=s; bestA=a; bestT=t; }
      }
    }
    if(bestA){
      /* A fight is the thing most worth seeing, so the camera reframes on the
         pair even if they are inside the Brigade frame already. cameraToUnits
         centred them at the Brigade zoom of 1.4, which frames the area rather
         than the duel; cameraToAction fits the pair, so two adjacent units get a
         genuine close-up. The resolve is held for the pan so the dice do not
         land while the board is still moving. */
      cameraToAction([bestA, bestT], { durationMs: CAMERA_ACTION_PAN_MS });
      logAiDebugMove(state.aiSide, { unit: unitLabel(bestA), mission: missionFor(bestA), action:'Fight', target: unitLabel(bestT), score: bestScore.toFixed(2) });
      // Remember what we are working on, so the next attacker in this phase
      // piles onto the same unit. Cleared when the fight phase ends.
      state._aiFocusTargetId = bestT.id;
      // Committed at declaration, matching the human path: the attacker has
      // thrown itself in, whatever the dice then say. Recording it at the settle
      // instead left a window in which the same unit could fight again.
      state.fought.add(bestA.id);
      setTimeout(()=> resolveFight(bestA, bestT, undefined, ()=>{
        // A destroyed or routed target is finished business; let the next
        // attacker choose freshly rather than chasing a unit that has gone.
        if(bestT.removed || bestT.rallying) state._aiFocusTargetId = null;
        draw();
        setTimeout(step, 300);
      }), CAMERA_ACTION_PAN_MS);
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

