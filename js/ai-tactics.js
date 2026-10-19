import { isBridgeSquare, meleeBlocked, waterDistance } from './engine-water.js';
import { SIDES, UNIT_TYPES, state } from './data-core.js';
import { otherSide } from './engine-objectives.js';
import { brigadeCavalryCount, canAttackTarget, chebyshev, combatBonuses, hasLOS, inBounds, isAdjacent, isConcealedFromEnemy, isRoadLike, legalMoves, movableUnitsForSide, terrainAt, unitBaseMove } from './engine-rules.js';

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
/* WHAT THE ENEMY COULD DO TO THIS SQUARE BEFORE OUR NEXT TURN.

   The reach test was already here and is right: an enemy threatens a square if
   it can move and still engage, which is its base move plus one. What was missing
   is how the fight would actually GO. Every threat was weighted a flat 1, or 1.6
   for cavalry against a line, so a square covered by cavalry we would beat scored
   the same as one covered by cavalry that would ride us down, and standing in a
   building counted for nothing at all.

   The weight is now the real matchup, taken from the same estimator the fight
   phase uses, so it already accounts for terrain, formation, Square against
   cavalry, Column, and the rest. Kept on the same scale as before (roughly 1 per
   threatening unit) because this value is used as a scalar in several other
   places, and changing its magnitude would silently reweight all of them.

   ARTILLERY IS TESTED ON LINE OF SIGHT, not distance. A gun six squares away
   behind a wood cannot touch the square and should not frighten anything; one on
   a hill firing over its own infantry very much can. Distance answered neither
   case correctly. */
export function threatPenalty(unit, side){
  let penalty = 0;
  const enemy = side===SIDES.RED ? SIDES.BLUE : SIDES.RED;
  for(const e of state.units){
    if(e.removed || e.side!==enemy || isConcealedFromEnemy(e)) continue;
    const eType = UNIT_TYPES[e.type];
    if(!eType.canFight) continue;

    if(eType.isArtillery){
      // A gun's threat is its arc, and it must be able to see the square.
      if(hasLOS(e, unit)) penalty += 0.6;
      continue;
    }

    const reach = unitBaseMove(e) + 1; // move then engage
    if(chebyshev(e,unit) > reach) continue;

    /* How badly this would go, from the ENEMY's side of the fight. Positive
       means the attack favours them. Mapped onto roughly the old scale so the
       callers that treat this as a scalar keep working: an even matchup stays
       near 1, a bad one rises toward 2, a favourable one falls toward 0.4. */
    /* The matchup computed HERE rather than borrowed from estimateFightValue.
       That function lives in ai-strategy, which already imports this module, so
       importing it back would make a cycle. combatBonuses is the actual rule and
       is what estimateFightValue itself reads, so this asks the same source
       directly: dice the attacker would roll against dice we would roll, with
       terrain, formation, Square-against-cavalry and the rest already folded in
       by the engine. */
    const atk = combatBonuses(e, unit, false).dice;
    const def = combatBonuses(unit, e, true).dice;
    const edge = atk - def;   // +1 they out-dice us, -1 we out-dice them
    penalty += Math.max(0.4, Math.min(2.0, 1 + edge * 0.5));
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
  /* VOLLEY RAISED THE PRICE OF COVER. Woods and buildings now subtract 1 from
     every incoming volley's effect roll, which turns a 4 into a miss and a 6
     into a rout: cover no longer merely helps in melee, it removes a whole band
     of the new effect table. 0.3 -> 0.5 accordingly.

     HILL IS DELIBERATELY NOT RAISED. Elevation lets a gun fire over friendly
     units and wins ties against a lower attacker, but it is explicitly NOT cover
     against a volley, so nothing about this rule made it better. Raising it too
     would have quietly erased the distinction the rule just created. */
  if(terr.key==='HILL') return 0.35; // tie-win vs a lower attacker, benefits any unit type
  if(terr.key==='WOODS' && (unitTypeKey==='INFANTRY'||unitTypeKey==='GUARD')) return 0.5;
  if(terr.key==='BUILDING' && (unitTypeKey==='INFANTRY'||unitTypeKey==='GUARD'||unitTypeKey==='ARTILLERY')) return 0.5;
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

/* C5: AN EXPOSED BATTERY IS AN OPPORTUNITY, not just a bogged one.

   findBoggedEnemyGun only answers for a gun stuck in plough with no cavalry in
   its Brigade. That is one way a battery becomes takeable and not the common
   one: the usual way is that its escort has been drawn off or killed, which the
   old test cannot see at all.

   A gun is raidable when nothing of its own side that can fight in melee is
   adjacent to it. Artillery cannot defend itself in contact, so an unescorted
   battery is a free kill for anything that can reach it, and it is worth more
   than its material value because losing it removes the enemy's reach.

   Returns the NEAREST such gun to the raider, so two cavalry do not set off for
   opposite ends of the board after one gun each. */
export function findRaidableEnemyGun(side, from){
  const enemy = otherSide(side);
  const guns = state.units.filter(o => !o.removed && o.side===enemy && UNIT_TYPES[o.type].isArtillery)
    .filter(o => !state.units.some(f => !f.removed && f.side===enemy && f.id!==o.id &&
      !UNIT_TYPES[f.type].isArtillery && f.type!=='BRIGADIER' && chebyshev(f,o) <= 1));
  if(!guns.length) return null;
  if(!from) return guns[0];
  return guns.sort((a,b) => chebyshev(from,a) - chebyshev(from,b))[0];
}

/* OPERATIONS (Operations and Campaigns brief, 2.8): how much a candidate
   square serves the side's objective, driven by the card's aiRoles:
     attack  pull toward the objective area
     hold    lean into defensible squares inside the area, and back toward it
     escape  pull toward the side's exit edge (the Brigadier less, so he goes last)
     hunt    pull toward the enemy units the side must destroy
   No weight tuning in this step: the pulls are modest and sit beside the
   standard scoring. */
const OP_SIDE_KEY = { red: 'british', blue: 'french' };
export function operationRole(side){
  const r = state.scenario && state.scenario.aiRoles;
  return r ? r[OP_SIDE_KEY[side]] || null : null;
}
function operationAreaFor(side){
  const w = state.scenario && state.scenario.win && state.scenario.win[OP_SIDE_KEY[side]];
  const c = w && (w.conditions || []).find(x => x.area);
  const other = state.scenario && state.scenario.win && state.scenario.win[OP_SIDE_KEY[side === 'red' ? 'blue' : 'red']];
  const c2 = !c && other ? (other.conditions || []).find(x => x.area) : null;
  const name = (c || c2 || {}).area;
  return name ? ((state.scenario.map.areas || {})[name] || []).map(([x, y]) => ({ x, y })) : [];
}
/* =========================================================
   PLAYING FOR THE OBJECTIVE (campaign battles, 18 Oct 2026)

   In an independently judged battle each side reads its OWN objective's
   conditions and pulls its units towards what they name, harder as the
   round each one is judged at comes closer:
     take or hold a place     towards its squares; standing in one is worth
                              a lot, more when the round is near
     hold N of several places towards the nearest of them
     units in an area         towards it
     join up with an ally     the tagged Brigade towards the other
     a commander to keep      kept back, near friends; into the area if named
     a commander to kill      cavalry and nearby units hunt him
     march off                towards the exit edge (the named commander first)
   It also reads the ENEMY's objective and sits in the places the enemy must
   take, which is how a defender knows where to stand.
   Distances go round rivers (waterDistance).
========================================================= */
const roundNow = () => Math.max(1, Math.ceil((state.turnNumber || 1) / 2));
function urgency(c){
  const due = c.atRound || c.byRound || (state.scenario && state.scenario.turnLimit) || 10;
  const left = due - roundNow();
  return left <= 0 ? 2.5 : left <= 2 ? 2.0 : left <= 4 ? 1.4 : 1.0;
}
const sqOf = name => (((state.scenario.map || {}).areas || {})[name] || []).map(([x, y]) => ({ x, y }));
const nearest = (pos, sqs) => sqs.length ? Math.min(...sqs.map(q => waterDistance(pos, q))) : 99;
/* THE ASSAULT (19 Oct 2026). The attacking AI closed up on a defended village
   and stopped: stepping next to its defenders scores as a bad fight, and in
   contact a fight is owed. A real commander commits when the clock runs out.
   Standing next to an enemy unit that holds one of the objective's squares
   (not across open water) is worth ASSAULT_PULL, times the deadline urgency:
   1.0 early, up to 2.5 at the deadline, enough by then to outweigh a bad
   fight estimate. Infantry and Guard lead (cavalry at half, guns not at all). */
export const ASSAULT_PULL = 1.6;
function assaultPull(mover, side, pos, sqs, k){
  const t = UNIT_TYPES[mover.type];
  if(t.isArtillery) return 0;
  const held = state.units.filter(o => !o.removed && o.side !== side && o.type !== 'BRIGADIER' && sqs.some(q => q.x === o.x && q.y === o.y));
  if(!held.some(o => Math.max(Math.abs(o.x - pos.x), Math.abs(o.y - pos.y)) === 1 && !meleeBlocked(pos, o))) return 0;
  return ASSAULT_PULL * k * (t.isCavalry ? 0.5 : 1);
}
/* CROSSINGS (19 Oct 2026). Every bridge and every ford edge is a crossing
   with a square on each bank. In the brook battles (Ligny, Saint-Amand,
   Quatre Bras) the attackers queued at one bridge, one unit a turn, while the
   defenders plugged its far end, and the fords on the flanks went unused.
     attacker  heads for the crossing that is nearest, least crowded with its
               own units and least held by the enemy; standing on its far
               (enemy-side) square is a bridgehead, worth a lot
     defender  holds the crossing squares on its own bank (the chokepoints),
               more where the enemy is close
   A side's bank is the one nearer its home row. */
export const CROSSING = { APPROACH: 0.35, BRIDGEHEAD: 2.5, NEAR: 0.8, CROWD: 1.2, HELD: 1.5, HOLD: 1.6, HOLD_THREAT: 1.0 };
function crossings(){
  const w = state.water; if(!w) return [];
  if(w._crossings && w._crossings.v === w.version) return w._crossings.list;
  const list = [];
  for(const [k, t] of Object.entries(w.edges)){
    if(t === 'river') continue;
    const [a, b] = k.split('|').map(q => q.split(',').map(Number)).map(([x, y]) => ({ x, y }));
    if(t === 'bridge'){ const br = w.bridges.find(o => o.key === k); if(br && br.broken){ /* a ford now */ } }
    list.push({ a, b });
  }
  w._crossings = { v: w.version, list };
  return list;
}
function crossingTerm(mover, side, pos, attacking, k){
  const list = crossings(); if(!list.length) return 0;
  const rows = state.terrain.length, home = side === 'red' ? rows - 1 : 0;
  const t = UNIT_TYPES[mover.type];
  if(t.isArtillery || t.key === 'BRIGADIER') return 0;
  const mineFirst = c => Math.abs(c.a.y - home) <= Math.abs(c.b.y - home) ? [c.a, c.b] : [c.b, c.a];
  const at = (q, p) => q.x === p.x && q.y === p.y;
  const friends = state.units.filter(o => !o.removed && o.side === side && o.id !== mover.id);
  const foes = state.units.filter(o => !o.removed && o.side !== side);
  let s = 0;
  if(attacking){
    let best = null;
    for(const c of list){
      const [near, far] = mineFirst(c);
      if(at(far, pos)) return CROSSING.BRIDGEHEAD * k;   // on the far bank of a crossing: the bridgehead
      const crowd = friends.filter(o => Math.max(Math.abs(o.x - near.x), Math.abs(o.y - near.y)) <= 1).length;
      const held = foes.some(o => at(o, far)) ? 1 : 0;
      const cost = waterDistance(pos, near) + crowd * CROSSING.CROWD + held * CROSSING.HELD;
      if(!best || cost < best.cost) best = { cost, near };
    }
    if(best){
      if(at(best.near, pos)) s += CROSSING.NEAR * k;
      else s += Math.max(0, 8 - best.cost) * CROSSING.APPROACH * k;
    }
  } else {
    for(const c of list){
      const [mine] = mineFirst(c);
      if(!at(mine, pos)) continue;
      const threat = foes.some(o => Math.max(Math.abs(o.x - mine.x), Math.abs(o.y - mine.y)) <= 3) ? CROSSING.HOLD_THREAT : 0;
      s += CROSSING.HOLD + threat;
      break;
    }
  }
  return s;
}
function storyMoveBonus(mover, side, pos){
  const sc = state.scenario, key = OP_SIDE_KEY[side], foeKey = OP_SIDE_KEY[side === 'red' ? 'blue' : 'red'];
  const t = UNIT_TYPES[mover.type], brig = t.key === 'BRIGADIER';
  /* The ATTACKING side pulls much harder (Ligny, AI against AI: the French
     never crossed the brook in ten rounds; the modest pull lost to keeping out
     of the guns' reach). Defenders keep the gentler pull. */
  const attacking = sc.aiRoles && sc.aiRoles[key] === 'attack';
  const reach = attacking ? 14 : 8, per = attacking ? 0.55 : 0.30, inPlace = attacking ? 3.0 : 2.0;
  let s = 0;
  /* A Brigadier on a bridge square blocks it (one unit per bridge square):
     at Wavre the French Brigadier parked on the bridge and his own infantry
     could not cross. Brigadiers keep off them. */
  if(brig && isBridgeSquare(pos.x, pos.y)) s -= 4;
  /* Late on, an objective square the attacker can simply walk into counts
     for more again: at Wavre the infantry stood at the bridge with the far
     bank empty and never stepped over. */
  const late = c => attacking && urgency(c) >= 1.4 ? 1.8 : 1;
  /* Getting closer must never be worth more than being there: next to the
     Bierges bridge the approach reward (14.3) beat standing on the bridgehead
     (10.8), and the unit stopped a square short. A cap on the approach fixed
     that but flattened the pull far away (Quatre Bras: 1.8 at five squares).
     So the approach keeps its full slope, and being there is worth the whole
     slope PLUS the in-place value: always more than any square short of it. */
  const approach = (d, k) => Math.max(0, reach - d) * per * k;
  const there = (k, c) => (reach * per + inPlace) * k * late(c);
  for(const c of ((sc.win[key] || {}).conditions || [])){
    const k = urgency(c);
    if(['HOLD_AREA', 'HOLD_COUNT', 'CONTROL_AREA', 'IN_AREA', 'ENTERED', 'CLEAR_AREA'].includes(c.type) && c.area){
      if(c.tag && mover.storyTag !== c.tag) continue;
      if(brig && c.type !== 'IN_AREA') continue;
      const sqs = sqOf(c.area), d = nearest(pos, sqs);
      const taken = sqs.some(q => q.x === pos.x && q.y === pos.y);
      s += taken ? there(k, c) + terrainSeekBonus(mover.type, pos.x, pos.y) * 0.5 : approach(d, k);
      if(attacking && !brig) s += assaultPull(mover, side, pos, sqs, k);
    } else if(c.type === 'HOLD_AREAS' && !brig){
      const sqs = (c.areas || []).flatMap(sqOf), d = nearest(pos, sqs);
      s += d === 0 ? there(k, c) + terrainSeekBonus(mover.type, pos.x, pos.y) * 0.5 : approach(d, k);
      if(attacking) s += assaultPull(mover, side, pos, sqs, k);
    } else if(c.type === 'NEXT_TO' && mover.storyTag === c.tag && !brig){
      const friends = state.units.filter(o => !o.removed && o.side === side && o.storyTag === c.nextTo);
      const d = friends.length ? Math.min(...friends.map(o => waterDistance(pos, o))) : 99;
      s += d === 1 ? 2.5 * k : Math.max(0, 10 - d) * 0.30 * k;
    } else if(c.type === 'COMMANDER' && brig && mover.storyTag === c.tag){
      if(c.area){ const d = nearest(pos, sqOf(c.area)); s += d === 0 ? 3.0 * k : Math.max(0, 8 - d) * 0.40 * k; }
      const near = state.units.filter(o => !o.removed && o.side === side && o.id !== mover.id && o.type !== 'BRIGADIER' && chebyshev(o, pos) <= 1).length;
      s += Math.min(near, 2) * 0.6;
      if(state.units.some(o => !o.removed && o.side !== side && o.type !== 'BRIGADIER' && chebyshev(o, pos) <= 1)) s -= 3.0;
    } else if(c.type === 'COMMANDER_REMOVED' && !brig){
      const prey = state.units.find(o => !o.removed && o.side !== side && o.type === 'BRIGADIER' && o.storyTag === c.tag);
      if(prey){ const d = waterDistance(pos, prey); s += Math.max(0, reach - d) * (t.isCavalry ? per + 0.15 : per) * k; }
    } else if(c.type === 'MARCH_OFF'){
      const ex = sc.map.exits && sc.map.exits[key];
      if(!ex) continue;
      const row = ex === 'britishEdge' ? state.terrain.length - 1 : 0;
      const pull = Math.max(0, 20 - Math.abs(pos.y - row)) * 0.45 * k;   // the full length of a corridor (Genappe: the cavalry stopped halfway)
      s += c.mustIncludeTag ? (mover.storyTag === c.mustIncludeTag && brig ? pull * 2 : pull * 0.4) : pull;
    }
  }
  // Crossings: the attacker spreads over them and seizes their far ends; the defender holds its own.
  s += crossingTerm(mover, side, pos, attacking, Math.max(1, ...((sc.win[key] || {}).conditions || []).map(urgency)));
  // Stand where the enemy must go: its places are ours to deny.
  if(!brig){
    for(const c of ((sc.win[foeKey] || {}).conditions || [])){
      const names = c.areas || (c.area ? [c.area] : []);
      if(!names.length || !['HOLD_AREA', 'HOLD_COUNT', 'CONTROL_AREA', 'HOLD_AREAS', 'IN_AREA', 'ENTERED'].includes(c.type)) continue;
      const sqs = names.flatMap(sqOf), d = nearest(pos, sqs);
      s += d === 0 ? 1.5 * urgency(c) + terrainSeekBonus(mover.type, pos.x, pos.y) * 0.4 : Math.max(0, 4 - d) * 0.15;
    }
  }
  return s;
}
export function scenarioMoveBonus(mover, side, pos){
  if(state.scenario && state.scenario.judging === 'independent') return storyMoveBonus(mover, side, pos);
  if(!state.scenario || !state.scenario.aiRoles) return 0;
  const role = operationRole(side);
  const t = UNIT_TYPES[mover.type];
  if(role === 'attack' || role === 'hold'){
    const area = operationAreaFor(side);
    if(!area.length) return 0;
    const d = Math.min(...area.map(z => chebyshev(pos, z)));
    if(role === 'attack') return Math.max(0, 6 - d) * 0.25;
    /* HOLD, strengthened (4 Oct 2026). In Matthew's first Lincelles the
       defenders stepped out of the village on turn 2: inside was worth 0.9,
       and forming a column outside 1.4, so they went. A holder's place is in
       the area: 2.0 for standing in it, plus the cover it gives, and nothing
       for the squares beside it, so leaving costs the full amount. Its
       Brigadier can still move about inside. Attackers are unchanged. */
    if(d === 0) return 2.0 + terrainSeekBonus(mover.type, pos.x, pos.y) * 0.6;
    return Math.max(0, 3 - d) * 0.15;
  }
  if(role === 'escape'){
    const ex = state.scenario.map.exits && state.scenario.map.exits[OP_SIDE_KEY[side]];
    if(!ex) return 0;
    const row = ex === 'britishEdge' ? state.terrain.length - 1 : 0;
    const pull = Math.max(0, 10 - Math.abs(pos.y - row)) * 0.25;
    return t.key === 'BRIGADIER' ? pull * 0.5 : pull;
  }
  if(role === 'hunt'){
    const w = state.scenario.win[OP_SIDE_KEY[side]];
    const types = new Set((w.conditions || []).filter(c => c.type === 'DESTROY').flatMap(c => c.unitTypes || []));
    const prey = state.units.filter(o => !o.removed && o.side !== side && o.type !== 'BRIGADIER' && (!types.size || types.has(o.type)));
    if(!prey.length) return 0;
    const d = Math.min(...prey.map(o => chebyshev(pos, o)));
    return Math.max(0, 5 - d) * 0.15;
  }
  return 0;
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

/* =========================================================
   SHAPE: MUTUAL SUPPORT AND GROUND DENIAL

   Every term the AI had was a distance gradient, so any two squares equidistant
   from the same things scored identically. A logged match showed six of six
   sampled decisions as EXACT ties broken by jitter worth 0.03, several described
   as "identical terms": the scoring simply could not tell most squares apart.

   These two terms are about SHAPE rather than distance, so they distinguish
   squares the existing ones cannot. Both are deliberately local: they ask what a
   square is like, not how far it is from something.
========================================================= */

/* MUTUAL SUPPORT. Two units that can answer for each other are worth more than
   two isolated ones, because an attacker either has to take on both or accept a
   counter-attack. It also keeps Column and Square available, which need a
   neighbour.

   Counts friendly FIGHTING units adjacent to the square. Brigadiers are excluded:
   they are not a counter-attack, and cohesion already values being near one, so
   counting them here would double-pay the same thing.

   Diminishing: the second neighbour is worth much less than the first, because
   the jump from alone to supported is the one that changes what an attacker can
   do. Three units in a heap is not three times as good as a pair. */
export function mutualSupportBonus(side, pos, selfId){
  let n = 0;
  for(const o of state.units){
    if(o.removed || o.side !== side || o.id === selfId) continue;
    if(o.type === 'BRIGADIER') continue;
    if(!UNIT_TYPES[o.type].canFight) continue;
    if(isAdjacent(pos, o)) n++;
  }
  if(n === 0) return 0;
  return n === 1 ? 0.9 : 0.9 + Math.min(n - 1, 2) * 0.25;
}

/* GROUND DENIAL. A square that controls a road or a gap between impassable
   terrain costs the enemy tempo: roads grant the extra square of movement, and
   gaps funnel an advance onto ground of our choosing. Worth holding even when
   the square itself offers nothing defensively, which is exactly the judgement no
   existing term could express.

   A gap is detected by looking at the square's neighbours: ground that units can
   cross, flanked by ground they cannot. Two impassable sides make it a defile,
   one makes it an edge worth something.

   Only counted when the ground is actually contested — an enemy within reach of
   it. Denying a road in the far corner of the board is not denial, it is
   loitering, and rewarding it would just invent a new way to sit still. */
export const DENIAL_CONTEST_RANGE = 7;

export function groundDenialBonus(side, pos){
  const enemy = otherSide(side);
  const contested = state.units.some(o => !o.removed && o.side === enemy &&
    !isConcealedFromEnemy(o) && chebyshev(pos, o) <= DENIAL_CONTEST_RANGE);
  if(!contested) return 0;

  let value = 0;
  if(isRoadLike(terrainAt(pos.x, pos.y))) value += 0.5;

  // A defile: passable ground with impassable ground either side of it.
  let walls = 0;
  for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
    const nx = pos.x+dx, ny = pos.y+dy;
    if(!inBounds(nx,ny)){ walls++; continue; }          // the board edge is a wall
    const terr = terrainAt(nx,ny);
    // Impassable to the arms that do the advancing.
    if(terr.restrictTo && !terr.restrictTo.includes('INFANTRY')) walls++;
  }
  if(walls >= 2) value += 0.7;
  else if(walls === 1) value += 0.25;

  return value;
}
