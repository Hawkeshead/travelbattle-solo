import { AI_UNIT_VALUE, evaluateState, findBoggedEnemyGun, findVulnerableEnemyUnits, isIsolatedAndThreatened, reserveCrisisExists, retreatToSupportBonus, scenarioMoveBonus, screensGunBonus, terrainSeekBonus, threatPenalty, vulnerableTargetPullBonus } from './ai-tactics.js';
import { COLS, ROWS, SIDES, SIDE_LABEL, UNIT_TYPES, state } from './data-core.js';
import { otherSide } from './engine-objectives.js';
import { artilleryTargets, chebyshev, combatBonuses, consumePloughEscort, hasChargeableTargetAt, isAdjacent, isCleanChargeRun, isConcealedFromEnemy, isHorseArtillery, legalMoves, movableUnitsForSide, resolveFight, terrainAt, unitBaseMove, unitsAt } from './engine-rules.js';
import { log } from './engine-state.js';
import { animateUnitTo, displaceBrigadierIfPresent, draw } from './render-board.js';
import { canAttackTarget, canInitiateFight, canLayAmbush, endFightPhase, endFirePhase, endMovePhase, fireArtillery, unitLabel } from './ui-battle.js';

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
  'ARTILLERY_PREP','FIX_AND_FLANK','BRIGADE_DESTRUCTION','CAVALRY_EXPLOITATION','WITHDRAWAL'];
export const BRIGADE_MISSIONS = ['MAIN_ATTACK','SUPPORT','FIX','FLANK','RESERVE','SCREEN','HOLD','COUNTERATTACK','WITHDRAW'];
export const MAX_PLAN_TURNS_UNCHANGED = 6; // a plan that's made no progress in this many AI turns gets reassessed regardless

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
    return brigadeIdsForSide(brigSide).map(id=>{
      const group = units.filter(u=>u.brigadeId===id);
      const brig = group.find(u=>u.type==='BRIGADIER');
      const fighters = group.filter(u=>u.type!=='BRIGADIER');
      const strength = strengthOf(group);
      const remaining = fighters.length;
      // Cohesion: average distance of this Brigade's units from their Brigadier
      // (or their own centroid unit if he's fallen) — low = still one fist.
      const anchor = brig || group[0];
      const cohesion = (anchor && fighters.length) ? fighters.reduce((s,u)=>s+chebyshev(u,anchor),0)/fighters.length : 0;
      const exposure = fighters.length ? fighters.reduce((s,u)=>s+threatPenalty(u,brigSide),0)/fighters.length : 0;
      // Isolated: no other friendly Brigade has any unit within supporting distance.
      const isolated = fighters.length>0 && !units.some(o=>o.brigadeId!==id && fighters.some(u=>chebyshev(u,o)<=6));
      return { id, side:brigSide, strength, remaining, cohesion, exposure, isolated, hasBrigadier: !!brig };
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

  return {
    side, enemy, armyStrength, enemyStrength,
    strengthRatio: armyStrength / Math.max(1, enemyStrength),
    ownBrigades, enemyBrigades, liveOwnBrigades, liveEnemyBrigades,
    centreOfGravity, weakestEnemyBrigade, weakestOwnBrigade, isolatedEnemyBrigades,
    exposedEnemyArtillery, exposedEnemyCavalry, weakFlank, decisivePoints
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
    else if(assessment.strengthRatio < 0.7 && prev.type!=='DEFENSIVE' && prev.type!=='WITHDRAWAL'
      && !localAttackStillFavourable(assessment, prev.mainEffortBrigadeId, prev.targetBrigadeId)){
      mustReassess = true; reasons.push('army badly outnumbered overall, and the current push has also lost its local edge — abandon and stabilise');
    }
  }

  if(!mustReassess) return prev;

  let plan;
  const a = assessment;
  if(a.strengthRatio < 0.5){
    plan = { type:'WITHDRAWAL', mainEffortBrigadeId:null, targetBrigadeId:null };
  } else if(a.isolatedEnemyBrigades.length>0){
    // Checked ahead of the plain material-ratio DEFENSIVE branch on purpose —
    // an isolated enemy Brigade is worth exploiting precisely when the fight
    // is close, not just once already comfortably ahead. Picking on the weak,
    // unsupported link is how a slightly-behind army claws back to even, not
    // a luxury reserved for when it's already winning.
    const target = a.isolatedEnemyBrigades.slice().sort((x,y)=>x.strength-y.strength)[0];
    const effort = a.liveOwnBrigades.slice().sort((x,y)=>y.strength-x.strength)[0];
    plan = { type:'BRIGADE_DESTRUCTION', mainEffortBrigadeId: effort?effort.id:null, targetBrigadeId: target.id };
  } else if(a.strengthRatio < 0.75){
    plan = { type:'DEFENSIVE', mainEffortBrigadeId: a.weakestOwnBrigade ? a.weakestOwnBrigade.id : null, targetBrigadeId:null };
  } else if(a.weakestEnemyBrigade && a.strengthRatio >= 1.15){
    const effort = a.liveOwnBrigades.slice().sort((x,y)=>y.strength-x.strength)[0];
    plan = { type:'MAIN_ATTACK', mainEffortBrigadeId: effort?effort.id:null, targetBrigadeId: a.weakestEnemyBrigade.id };
  } else if(a.weakestEnemyBrigade){
    const effort = a.liveOwnBrigades.slice().sort((x,y)=>y.strength-x.strength)[0];
    plan = { type:'FIX_AND_FLANK', mainEffortBrigadeId: effort?effort.id:null, targetBrigadeId: a.weakestEnemyBrigade.id };
  } else {
    plan = { type:'DEFENSIVE', mainEffortBrigadeId:null, targetBrigadeId:null };
  }
  plan.createdOnTurn = state.turnNumber;
  plan.turnsHeld = 0;
  plan.reasons = reasons;
  state._aiPlan[side] = plan;
  return plan;
}

// Section 5: turn the plan into one mission per own Brigade.
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
    const weakest = assessment.weakestOwnBrigade;
    for(const id of brigadeIds){
      const b = assessment.liveOwnBrigades.find(x=>x.id===id);
      const inRealTrouble = b && (b.exposure >= 1.5 || b.remaining <= 1);
      missions[id] = inRealTrouble ? 'WITHDRAW' : (weakest && id===weakest.id ? 'HOLD' : 'RESERVE');
    }
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
      return nearestTargetDist!=null ? Math.max(0, 6-nearestTargetDist)*0.18 : 0;
    case 'FLANK':
      // Favour the weak-flank column band while closing, rather than a straight line in.
      if(!assessment) return nearestTargetDist!=null ? Math.max(0,6-nearestTargetDist)*0.12 : 0;
      { const towardFlank = assessment.weakFlank==='left' ? (COLS-pos.x)*0.02 : pos.x*0.02;
        return (nearestTargetDist!=null ? Math.max(0,6-nearestTargetDist)*0.12 : 0) + towardFlank; }
    case 'FIX':
      // Reward staying in contact with the target Brigade without overextending past it.
      return nearestTargetDist!=null ? Math.max(0, 3-Math.abs(nearestTargetDist-1))*0.15 : 0;
    case 'SUPPORT':
      return nearestTargetDist!=null ? Math.max(0, 5-nearestTargetDist)*0.1 : 0;
    case 'RESERVE':
      // Handled mainly via the existing holdingReserve suppression in
      // aiDecideAndExecuteMove; here just a mild pull back toward the Brigadier.
      return 0;
    case 'SCREEN':
      return screensGunBonus(u, side, pos) * 1.2;
    case 'HOLD':
      return terrainSeekBonus(u.type, pos.x, pos.y) * 1.5;
    case 'WITHDRAW':
      { const homeRow = side===SIDES.RED ? ROWS-1 : 0;
        return Math.max(0, 4-Math.abs(pos.y-homeRow)) * 0.2; }
    case 'COUNTERATTACK':
      return nearestTargetDist!=null ? Math.max(0,6-nearestTargetDist)*0.18 : 0;
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
  return units
    .sort((a,b)=> (brigadeX[a.brigadeId]-brigadeX[b.brigadeId]) || (pri[a.type]-pri[b.type]))
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

export function aiDecideAndExecuteMove(u){
  if(u.removed || u.turnOnly) return;
  const side = u.side;
  const t = UNIT_TYPES[u.type];
  const connectedBefore = movableUnitsForSide(side).has(u.id);
  const startX = u.x, startY = u.y;
  function recordMove(action, to){
    state._aiMoveHistory[side].push({
      turn: state.turnNumber, unit: unitLabel(u), type: u.type, brigadeId: u.brigadeId,
      mission: missionFor(u), action, from: {x:startX, y:startY}, to: to || null,
      connectedBefore, connectedAfter: movableUnitsForSide(side).has(u.id)
    });
  }

  if(u.formation==='square'){
    // Reconsider every phase: leaving Square costs this whole move phase (per rulebook),
    // so only bother once the threat that justified it has actually passed.
    if(threatPenalty(u, side) < 0.8){
      u.formation = 'line';
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
  if(state.aiDifficulty==='hard' && canLayAmbush(u)){
    const near = nearestEnemyDist(u, side);
    if(near>=2 && near<=5){
      u.hidden = true;
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
  const boggedTarget = (state.aiDifficulty==='hard' && t.isCavalry) ? findBoggedEnemyGun(side) : null;
  const wasConnected = connectedBefore; // captured before any candidate is tried, at the unit's real starting position
  const currentlyThreatened = threatPenalty(u, side) >= 1.2; // at the unit's real starting position, before any candidate is tried
  const selfPreservation = seekTactics && isIsolatedAndThreatened(u, side); // also at the real starting position
  for(const c of candidates){
    const ox=u.x, oy=u.y;
    u.x=c.x; u.y=c.y;
    let s = evaluateState(side) - 0.5*threatPenalty(u, side);
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
    if(wasConnected && !connNow.has(u.id) && !t.isArtillery) s -= 2.4;
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
      if(brigadeMates.length > 0){
        const connectedCount = brigadeMates.filter(o=>connNow.has(o.id)).length;
        s += connectedCount * 0.5;
      }
    }
    // Without some positional pull, every "safe" square scores identically and the
    // AI never closes to fight. Infantry/cavalry are pulled toward the nearest enemy;
    // artillery is pulled toward its ideal firing band (3-5 squares) instead.
    // Reserve Doctrine (Hard): suppress this pull for a held-back Guard/Heavy
    // Cavalry unit until a real crisis exists, so it doesn't rush the opening exchanges.
    // Self-preservation (below) suppresses it too — an isolated, threatened unit
    // should be falling back toward support, not still being pulled forward alone.
    if(!holdingReserve && !selfPreservation){
      if(t.isArtillery){
        const d = nearestEnemyDist(c, side);
        s -= Math.abs(d-4) * 0.06;
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
          if(goodGround && safeEnough && d<=6) s += 1.6;
        }
      } else {
        s -= nearestEnemyDist(c, side) * 0.12;
      }
    }

    // The defensive mirror of the concentration tactic below: an isolated unit
    // under real threat right now falls back toward its own side rather than the
    // AI continuing to press it forward alone — exactly the exposure the AI is
    // now taught to actively punish an enemy unit for standing in.
    if(selfPreservation){
      s += retreatToSupportBonus(c, side, u);
    }

    // Concentrate on a vulnerable (isolated/unsupported) enemy unit specifically,
    // on top of the generic "close on nearest enemy" pull above — several units
    // converging on the same weak point in one turn is what actually punishes an
    // overextended enemy, rather than each unit independently picking whichever
    // enemy happens to be closest to itself.
    if(seekTactics && !holdingReserve && !selfPreservation && !t.isArtillery){
      s += vulnerableTargetPullBonus(c, side, getVulnerableEnemyUnits(side));
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
        s += 2.2;
        if(state.turnComboTarget && state.turnComboTarget===chargeableTarget.id) s += 1.0;
      }
    }
    // Medium+: deliberately form an Attack Column ahead of a fight it can already see coming,
    // instead of doubling up only as an accidental byproduct of two units picking the same square.
    if(seekTactics && (t.key==='INFANTRY'||t.key==='GUARD') && !c.stay){
      const occ = unitsAt(c.x,c.y).filter(o=>!o.removed && o.side===side && (o.type==='INFANTRY'||o.type==='GUARD'));
      if(occ.length===1 && terrainAt(c.x,c.y).allowDouble && nearestEnemyDist(c, side)<=3) s += 1.4;
    }
    // Core Tactic #5, Ground Worth Bleeding For: value good terrain when otherwise similar —
    // weighted much more heavily when the unit isn't actively closing for an attack (holding,
    // reserving, or a defensive-flavoured mission) or is already under real threat. That's
    // exactly when a real commander repositions onto good ground, rather than just mildly
    // preferring it as a tie-break while advancing straight past it regardless.
    if(seekTactics){
      const defensivePosture = holdingReserve || currentlyThreatened ||
        mission==='HOLD' || mission==='FIX' || mission==='SCREEN' || mission==='WITHDRAW';
      s += terrainSeekBonus(t.key, c.x, c.y) * (defensivePosture ? 2.4 : 1);
    }
    // Core Tactic #2, The Gunner's Creed: value screening an unguarded friendly gun.
    if(seekTactics) s += screensGunBonus(u, side, c);
    // Manoeuvre #20, The Bogged Column (Hard): close on a stuck, unescorted enemy gun.
    if(boggedTarget) s -= chebyshev(c, boggedTarget) * 0.15;
    // Operations: pull toward whatever the active scenario's objective actually rewards.
    if(state.scenario) s += scenarioMoveBonus(u, side, c);
    // Section 6/7 (Hard): reward this square for serving the unit's Brigade mission,
    // on top of (not instead of) all the tactical bonuses above.
    if(mission) s += missionMoveBonus(u, side, c, mission, plan);
    // Section 9 (Hard): selective lookahead, only for the "important" move categories —
    // a charge, a move that sets up a fight next phase, or a Reserve/Fix-mission unit
    // being pulled into contact. Everything else stays 0-ply, same cost as before.
    if(mission){
      const setsUpFight = !c.stay && state.units.some(o=>!o.removed && o.side!==side && isAdjacent(c,o) && !isConcealedFromEnemy(o));
      const committingReserve = (mission==='RESERVE' || mission==='FIX') && !c.stay && nearestEnemyDist(c,side) <= unitBaseMove(u)+1;
      if(isChargeMove || setsUpFight || committingReserve) s -= lookaheadMovePenalty(u, side) * 0.4;
    }

    s += Math.random() * 0.03; // tie-breaking jitter: prevents an exact repeated stall between equally-scored options
    u.x=ox; u.y=oy;
    if(s>bestScore){ bestScore=s; best=c; }
  }

  const canSquare = t.canFormSquare && terrainAt(u.x,u.y).key!=='WOODS' && terrainAt(u.x,u.y).key!=='BUILDING' && unitsAt(u.x,u.y).length<=1;
  if(canSquare && threatPenalty(u, side) >= 1.4){
    const origForm = u.formation;
    u.formation = 'square';
    const squareScore = evaluateState(side) - 0.15*threatPenalty(u, side);
    u.formation = origForm;
    if(squareScore > bestScore){
      u.formation = 'square';
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
    animateUnitTo(u, best.x, best.y);
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
    logAiDebugMove(side, { unit: unitLabel(u), mission, action: (best && !best.stay) ? (u.charged?'Charge':'Advance') : 'Hold', to: best?`(${best.x},${best.y})`:null, score: bestScore.toFixed(2) });
  }
  recordMove((best && !best.stay) ? (u.charged?'Charge':'Advance') : 'Hold', best && !best.stay ? {x:best.x, y:best.y} : null);
}

export function aiDoMovePhase(){
  const order = orderAiUnitsForMove(state.aiSide);
  let i = 0;
  function step(){
    if(state.gameOver) return;
    if(i>=order.length){ endMovePhase(); return; }
    const u = state.units.find(x=>x.id===order[i]); i++;
    aiDecideAndExecuteMove(u);
    draw();
    setTimeout(step, 340);
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

export function aiDoFirePhase(){
  const guns = state.units.filter(u=>!u.removed && u.side===state.aiSide && UNIT_TYPES[u.type].isArtillery && !state.fired.has(u.id));
  let i=0;
  function step(){
    if(state.gameOver) return;
    if(i>=guns.length){ endFirePhase(); return; }
    const gun = guns[i]; i++;
    if(!gun.removed){
      aiFireDecision(gun, ()=>{ draw(); setTimeout(step, 250); });
    } else {
      setTimeout(step, 100);
    }
  }
  step();
}

/* =========================================================
   AI: FIGHTING
========================================================= */
export function estimateFightValue(a, t){
  let aD = combatBonuses(a, t, false).dice;
  let dD = combatBonuses(t, a, true).dice;
  const aType = UNIT_TYPES[a.type], tType = UNIT_TYPES[t.type];
  if(aType.isCavalry && (tType.key==='INFANTRY'||tType.key==='GUARD') && t.formation!=='square') aD = Math.max(aD,2);
  if((aType.key==='INFANTRY'||aType.key==='GUARD') && a.formation!=='square' && (tType.key==='INFANTRY'||tType.key==='GUARD') && t.formation==='square') aD = Math.max(aD,2);
  const edge = aD - dD;
  return edge*2 + AI_UNIT_VALUE[t.type]*0.4 - AI_UNIT_VALUE[a.type]*0.15;
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
  function step(){
    if(state.gameOver) return;
    const attackers = state.units.filter(u=>u.side===state.aiSide && canInitiateFight(u) && !state.fought.has(u.id) &&
      state.units.some(o=>!o.removed && o.side!==state.aiSide && isAdjacent(u,o) && canAttackTarget(u,o)));
    if(attackers.length===0){ endFightPhase(); return; }
    let bestA=null, bestT=null, bestScore=-Infinity;
    for(const a of attackers){
      const targets = state.units.filter(o=>!o.removed && o.side!==state.aiSide && isAdjacent(a,o) && canAttackTarget(a,o));
      for(const t of targets){
        const s = aiEstimateFightValue(a, t, state.aiSide);
        if(s>bestScore){ bestScore=s; bestA=a; bestT=t; }
      }
    }
    if(bestA){
      logAiDebugMove(state.aiSide, { unit: unitLabel(bestA), mission: missionFor(bestA), action:'Fight', target: unitLabel(bestT), score: bestScore.toFixed(2) });
      resolveFight(bestA, bestT, undefined, ()=>{
        state.fought.add(bestA.id);
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
export function exportAiMoveLog(){
  const side = state.aiSide;
  if(!side) return 'No AI opponent in this match — nothing to export.';
  const history = state._aiMoveHistory[side] || [];
  if(history.length===0) return 'No AI moves recorded this match.';

  const lines = [];
  lines.push(`=== AI MOVE LOG — ${SIDE_LABEL[side]} (${state.aiDifficulty||'?'}) ===`);
  lines.push(`Total AI moves: ${history.length}`);
  const disconnectedCount = history.filter(h=>!h.connectedAfter).length;
  lines.push(`Moves ending disconnected from Brigadier: ${disconnectedCount}`);
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

