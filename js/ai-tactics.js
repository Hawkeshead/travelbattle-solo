import { SIDES, UNIT_TYPES, state } from './data-core.js';
import { otherSide } from './engine-objectives.js';
import { brigadeCavalryCount, chebyshev, isAdjacent, isConcealedFromEnemy, movableUnitsForSide, terrainAt, unitBaseMove } from './engine-rules.js';

/* =========================================================
   AI: EVALUATION
========================================================= */
export const AI_UNIT_VALUE = { BRIGADIER:2, INFANTRY:4, GUARD:5, HEAVY_CAV:5, LIGHT_CAV:4, ARTILLERY:6 };

// Manoeuvre: an enemy unit standing without support — either it's lost its own
// chain of command back to its Brigadier (see movableUnitsForSide), or it
// simply has no friendly-to-it units within a short support radius even though
// technically still connected. Either way, it's the kind of target a human
// player concentrates several units against rather than trading evenly with.
// Reuses the exact same connectivity check already built for the AI's own
// cohesion — this is that same weakness, aimed at the opponent instead.
export function findVulnerableEnemyUnits(side){
  const enemy = side===SIDES.RED ? SIDES.BLUE : SIDES.RED;
  const connEnemy = movableUnitsForSide(enemy);
  const enemyUnits = state.units.filter(u=>!u.removed && u.side===enemy && u.type!=='BRIGADIER' && !isConcealedFromEnemy(u));
  return enemyUnits.filter(u=>{
    if(!connEnemy.has(u.id)) return true;
    const nearbySupport = enemyUnits.some(o=>o.id!==u.id && chebyshev(u,o)<=2);
    return !nearbySupport;
  });
}

// How much a candidate square helps concentrate force on the nearest vulnerable
// enemy unit — a stronger pull than the generic "close on the nearest enemy"
// term, so several units genuinely converge on the same weak point in the same
// turn instead of each independently picking whichever enemy happens closest.
export function vulnerableTargetPullBonus(pos, side, vulnerable){
  if(!vulnerable || vulnerable.length===0) return 0;
  const nearest = vulnerable.reduce((best,v)=> chebyshev(pos,v) < chebyshev(pos,best) ? v : best);
  return -chebyshev(pos,nearest) * 0.22;
}

export function evaluateState(perspective){
  let score = 0;
  const enemy = perspective===SIDES.RED ? SIDES.BLUE : SIDES.RED;
  const connMine  = movableUnitsForSide(perspective);
  const connEnemy = movableUnitsForSide(enemy);
  for(const u of state.units){
    if(u.removed) continue;
    let unitScore = AI_UNIT_VALUE[u.type];
    const terr = terrainAt(u.x,u.y);
    if(terr.defenseBonus && (u.type==='INFANTRY'||u.type==='GUARD')) unitScore += 0.6;
    if(terr.elevation>0) unitScore += 0.3;
    if(u.formation==='square') unitScore += 0.4;
    const conn = u.side===perspective ? connMine : connEnemy;
    if(!conn.has(u.id)) unitScore -= 1.0;
    score += (u.side===perspective ? 1 : -1) * unitScore;
  }
  return score;
}

// Rough estimate of how exposed `unit` would be, standing where it is now,
// to enemy units that could reach + fight it on their next turn.
export function threatPenalty(unit, side){
  let penalty = 0;
  const enemy = side===SIDES.RED ? SIDES.BLUE : SIDES.RED;
  for(const e of state.units){
    if(e.removed || e.side!==enemy || isConcealedFromEnemy(e)) continue;
    const eType = UNIT_TYPES[e.type];
    if(!eType.canFight) continue;
    const reach = unitBaseMove(e) + 1; // move then engage
    if(chebyshev(e,unit) <= reach){
      let w = 1;
      if(eType.isCavalry && (unit.type==='INFANTRY'||unit.type==='GUARD') && unit.formation!=='square') w = 1.6;
      if(eType.isArtillery) w = 0.6;
      penalty += w;
    }
  }
  return penalty;
}

/* =========================================================
   AI: MOVEMENT
========================================================= */
// Core Tactic #5, Ground Worth Bleeding For: Medium+ values ending a move on
// terrain that actually helps, rather than pure distance-to-enemy pull.
export function terrainSeekBonus(unitTypeKey, x, y){
  const terr = terrainAt(x,y);
  if(terr.key==='HILL') return 0.35; // tie-win vs a lower attacker, benefits any unit type
  if(terr.key==='WOODS' && (unitTypeKey==='INFANTRY'||unitTypeKey==='GUARD')) return 0.3;
  if(terr.key==='BUILDING' && (unitTypeKey==='INFANTRY'||unitTypeKey==='GUARD'||unitTypeKey==='ARTILLERY')) return 0.3;
  return 0;
}

// Core Tactic #2, The Gunner's Creed: Medium+ non-artillery units value ending a
// move screening a friendly gun that doesn't already have a screener.
export function screensGunBonus(mover, side, pos){
  const t = UNIT_TYPES[mover.type];
  if(t.isArtillery || t.key==='BRIGADIER') return 0;
  const unscreenedGun = state.units.find(o=>!o.removed && o.side===side && o.type==='ARTILLERY' &&
    isAdjacent(pos,o) &&
    !state.units.some(s=>!s.removed && s.id!==mover.id && s.id!==o.id && s.side===side &&
      UNIT_TYPES[s.type].key!=='ARTILLERY' && UNIT_TYPES[s.type].key!=='BRIGADIER' && isAdjacent(o,s)));
  return unscreenedGun ? 0.5 : 0;
}

// Manoeuvre #12, Reserve Doctrine: Hard holds a Guard/Heavy Cavalry unit back
// from the opening exchanges unless a genuine crisis point already exists —
// a friendly unit already in contact and under real threat.
export function reserveCrisisExists(side){
  return state.units.some(u=>!u.removed && u.side===side && u.type!=='BRIGADIER' && !UNIT_TYPES[u.type].isArtillery &&
    state.units.some(o=>!o.removed && o.side!==side && isAdjacent(u,o)) && threatPenalty(u,side) > 1.0);
}

// Manoeuvre #20, The Bogged Column: Hard scouts for an enemy gun stuck on/beside
// ploughed ground with no Cavalry escort in its own Brigade, and exploits it.
export function findBoggedEnemyGun(side){
  const enemy = otherSide(side);
  return state.units.find(o=>!o.removed && o.side===enemy && UNIT_TYPES[o.type].isArtillery &&
    terrainAt(o.x,o.y).plough && brigadeCavalryCount(o)===0);
}

// Operations: how much a candidate position or fight target actually serves the
// active scenario's objective — generalizes brigadeBreakBonus to whatever the
// real win condition is, rather than always assuming "break 2 of 3 Brigades."
export function scenarioMoveBonus(mover, side, pos){
  if(!state.scenario) return 0;
  let bonus = 0;
  for(const cond of state.scenario.objective.conditions){
    if(cond.type==='CAPTURE_ZONE'){
      const dists = cond.params.zoneSquares.map(z=>chebyshev(pos,z));
      bonus += Math.max(0, 3 - Math.min(...dists)) * 0.25; // pull toward the zone as it gets close
    } else if(cond.type==='ESCAPE_ZONE' && cond.params.escapingSide===side){
      const edgeDist = Math.min(...cond.params.edgeRows.map(r=>Math.abs(pos.y-r)));
      bonus += Math.max(0, 4 - edgeDist) * 0.2; // pull toward the exit edge
    } else if(cond.type==='PROTECT_UNIT' && cond.params.protectSide===side){
      const asset = state.units.find(o=>!o.removed && o.side===side && cond.params.unitTypes.includes(o.type));
      if(asset && UNIT_TYPES[mover.type].key!=='BRIGADIER' && !UNIT_TYPES[mover.type].isArtillery && isAdjacent(pos,asset)) bonus += 0.4;
    } else if(cond.type==='SURVIVE_TURNS' && cond.params.defender===side){
      bonus += terrainSeekBonus(mover.type, pos.x, pos.y) * 0.6; // lean harder into defensible ground
    }
  }
  return bonus;
}

// The defensive mirror of findVulnerableEnemyUnits — is THIS unit itself
// standing without support and under real threat right now. Used to pull an
// exposed unit back toward its own side rather than continuing to advance
// alone into the situation the AI is now actively taught to punish an enemy
// unit for being in.
export function isIsolatedAndThreatened(u, side){
  if(threatPenalty(u, side) < 1.0) return false;
  const friendlies = state.units.filter(o=>!o.removed && o.side===side && o.id!==u.id && o.type!=='BRIGADIER');
  return !friendlies.some(o=>chebyshev(u,o)<=2);
}

// Pull toward the nearest friendly unit — retreat-to-support for a unit that's
// isolated and under threat, rather than continuing to press forward alone.
export function retreatToSupportBonus(pos, side, self){
  const friendlies = state.units.filter(o=>!o.removed && o.side===side && o.id!==self.id && o.type!=='BRIGADIER');
  if(friendlies.length===0) return 0;
  const nearest = friendlies.reduce((best,o)=> chebyshev(pos,o) < chebyshev(pos,best) ? o : best);
  return -chebyshev(pos,nearest) * 0.30;
}

