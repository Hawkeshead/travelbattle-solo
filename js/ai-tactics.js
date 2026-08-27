import { SIDES, UNIT_TYPES, state } from './data-core.js';
import { otherSide } from './engine-objectives.js';
import { brigadeCavalryCount, canAttackTarget, chebyshev, isAdjacent, isConcealedFromEnemy, isRoadLike, legalMoves, movableUnitsForSide, terrainAt, unitBaseMove } from './engine-rules.js';

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
/* =========================================================
   REACHABILITY: who else can get at this target this turn

   The AI had no way to ask "could anyone else join this fight". It could ask
   whether a unit was already adjacent (canAttackTarget) and how far the nearest
   enemy was (nearestEnemyDist), but nothing in between. That gap is why it
   attacks alone: a lone charge and a two-unit converging attack score
   identically, because nothing in the scoring can tell them apart.

   A unit can engage a target this turn if it is already adjacent and allowed to
   attack it, or if it has not yet moved and legalMoves() reaches a square from
   which it could. legalMoves already handles cohesion, allowance, roads,
   ploughed fields, escorts, Square and turnOnly, so this is a wrapper rather
   than a reimplementation.

   CACHING. legalMoves runs a BFS per unit, and this gets asked once per
   candidate target per deciding unit, so the naive version is O(units^2) BFS
   per turn. Results are cached and invalidated whenever the board changes
   underneath them: a unit moving (state.moved grows), a unit dying, or the turn
   advancing. Keyed on that stamp rather than cleared manually, so a missed
   invalidation is impossible by construction.
========================================================= */
let reachCache = new Map();
let reachStamp = '';

function currentStamp(){
  const moved = state.moved ? state.moved.size : 0;
  const alive = state.units.reduce((n,u)=>n + (u.removed?0:1), 0);
  return `${state.turnNumber}:${state.turn}:${moved}:${alive}`;
}

function reachableSquares(u){
  const stamp = currentStamp();
  if(stamp !== reachStamp){ reachCache = new Map(); reachStamp = stamp; }
  if(reachCache.has(u.id)) return reachCache.get(u.id);
  const squares = legalMoves(u).map(m => m.x + ',' + m.y);
  const set = new Set(squares);
  reachCache.set(u.id, set);
  return set;
}

/* Could `u` fight `target` at some point this turn, from where it stands or
   after a legal move? Deliberately does NOT consider whether doing so is a good
   idea; that is the scorer's job. */
export function canEngageThisTurn(u, target){
  if(u.removed || target.removed || u.side === target.side) return false;
  if(UNIT_TYPES[u.type].canFight === false) return false;
  if(isAdjacent(u, target) && canAttackTarget(u, target)) return true;
  // Not adjacent: it has to be able to move somewhere that is. canAttackTarget
  // is evaluated from the prospective square, since terrain matters (cavalry may
  // never attack into a building, whatever square it attacks from).
  // canAttackTarget depends on the attacker's type and the DEFENDER's square,
  // never on where the attacker stands, so it is settled before the search: if
  // this unit could not attack that target from anywhere, no square helps.
  if(!canAttackTarget(u, target)) return false;
  const reach = reachableSquares(u);
  if(reach.size === 0) return false;
  for(let dy=-1; dy<=1; dy++){
    for(let dx=-1; dx<=1; dx++){
      if(dx===0 && dy===0) continue;
      if(reach.has((target.x+dx)+','+(target.y+dy))) return true;
    }
  }
  return false;
}

/* How many OTHER friendly units could also reach this target this turn. The
   number the "never attack alone" rule is built on. */
export function supportCountFor(target, side, selfId){
  let n = 0;
  for(const o of state.units){
    if(o.removed || o.side !== side || o.id === selfId) continue;
    if(o.type === 'BRIGADIER') continue;
    if(canEngageThisTurn(o, target)) n++;
  }
  return n;
}

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
/* Is there an enemy CAVALRY unit close enough to charge this unit next turn?

   Square exists for exactly one purpose: to break a cavalry charge. It costs the
   unit its entire move to form, it cannot move at all while formed, and it is
   MORE vulnerable to artillery (+1 to the enemy's effect roll) and to infantry
   (who roll a second die against it). Against anything except cavalry it is
   strictly worse than standing in line.

   The AI was gating Square on threatPenalty() >= 1.4, which is type-blind: it
   weights cavalry higher but still accumulates from infantry and guns, so three
   infantry closing in clears the bar just as readily as one cavalry. Three
   logged matches show squares formed against approaching infantry and artillery
   and then held for ten-plus turns (the reform gate is the same number read the
   other way, so a high threat both forms the square and keeps it), each ending
   with the unit destroyed where it stood. It is a substantial share of the AI's
   total losses.

   Range is the cavalry's own move plus one to engage. Concealed units do not
   count, matching threatPenalty: the AI cannot form square against a threat it
   is not allowed to know about. */
export function cavalryThreatWithinCharge(unit, side){
  const enemy = side===SIDES.RED ? SIDES.BLUE : SIDES.RED;
  for(const e of state.units){
    if(e.removed || e.side!==enemy || isConcealedFromEnemy(e)) continue;
    if(!UNIT_TYPES[e.type].isCavalry) continue;
    if(chebyshev(e, unit) <= unitBaseMove(e) + 1) return true;
  }
  return false;
}

export function terrainSeekBonus(unitTypeKey, x, y){
  const terr = terrainAt(x,y);
  if(terr.key==='HILL') return 0.35; // tie-win vs a lower attacker, benefits any unit type
  if(terr.key==='WOODS' && (unitTypeKey==='INFANTRY'||unitTypeKey==='GUARD')) return 0.3;
  if(terr.key==='BUILDING' && (unitTypeKey==='INFANTRY'||unitTypeKey==='GUARD'||unitTypeKey==='ARTILLERY')) return 0.3;
  return 0;
}

// Manoeuvre: when falling back or digging in, head for an actual strongpoint
// — a cluster of Woods/Building terrain, not just whichever single defensible
// square happens to be nearest each unit individually. Scores every such cell
// on the board by how many similar cells surround it (a bigger cluster reads
// as a stronger position to rally on) minus distance, so the whole group
// converges on the same real fort rather than scattering across whichever
// isolated tree or cottage each unit happened to be closest to.
export function findDefensiveRallyPoint(nearPos, maxRange = 10){
  const ROWS = state.terrain.length, COLS = state.terrain[0].length;
  let best = null, bestScore = -Infinity;
  for(let y=0; y<ROWS; y++){
    for(let x=0; x<COLS; x++){
      const t = terrainAt(x,y);
      if(t.key!=='WOODS' && t.key!=='BUILDING') continue;
      const dist = chebyshev(nearPos, {x,y});
      if(dist > maxRange) continue;
      let clusterSize = 0;
      for(let dy=-1; dy<=1; dy++){
        for(let dx=-1; dx<=1; dx++){
          const nx=x+dx, ny=y+dy;
          if(nx<0||ny<0||nx>=COLS||ny>=ROWS) continue;
          const nt = terrainAt(nx,ny);
          if(nt.key==='WOODS' || nt.key==='BUILDING') clusterSize++;
        }
      }
      const score = clusterSize*2 - dist*0.3;
      if(score > bestScore){ bestScore = score; best = {x,y}; }
    }
  }
  return best;
}
export function rallyPointPullBonus(pos, rallyPoint){
  if(!rallyPoint) return 0;
  return -chebyshev(pos, rallyPoint) * 0.16;
}

// Core Tactic: prefer the road network while actively advancing — both for the
// real +1 movement bonus a unit gets from starting and ending its move on
// road (see isRoadLike/unitBaseMove), and because a column that stays on
// roads simply covers ground faster turn over turn, the same reason a human
// player uses them to close distance quickly rather than cutting cross-
// country. Modest on its own so it nudges toward a road without overriding a
// more direct route to a real target.
export function roadSeekBonus(x, y){
  return isRoadLike(terrainAt(x,y)) ? 0.15 : 0;
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

