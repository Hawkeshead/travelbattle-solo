import { AI_UNIT_VALUE } from './ai-tactics.js';
import { COLS, ROWS, SIDES, SIDE_LABEL, TERRAIN, UNIT_TYPES, state } from './data-core.js';
import { armBattleBed, FAST_DICE_MODE, finishDice, presentRollTrigger, refreshDiceFrame, showDice, showDiceRerollButton } from './dice.js';
import { checkScenarioObjective, endGame } from './engine-objectives.js';
import { log, logNarration, logReplay } from './engine-state.js';
import { addDeathEffect, animateUnitTo, FAST_ANIMATION_MODE, MOVE_PROFILES, moveAnimationMs, showActionLine } from './render-board.js';
import { unitPortraitHTML } from './render-units.js';
import { renderBrigadeStatus, unitLabel } from './ui-battle.js';

/* =========================================================
   GEOMETRY HELPERS
========================================================= */
export function inBounds(x,y){ return x>=0 && x<COLS && y>=0 && y<ROWS; }
export function terrainAt(x,y){ return TERRAIN[state.terrain[y][x]]; }
export function unitsAt(x,y){ return state.units.filter(u=>!u.removed && u.x===x && u.y===y); }
export function unitAt(x,y, excludeId){ return state.units.find(u=>!u.removed && u.x===x && u.y===y && u.id!==excludeId); }

// Stacked squares (doubled infantry in open terrain) hold up to 2 units.
// A single tap only ever reached the first one — repeated taps on the same
// square now cycle through whichever units are actually there.
export function pickUnitAtCell(x,y){
  const list = unitsAt(x,y);
  if(list.length===0) return null;
  if(list.length===1) return list[0];
  const key = x+','+y;
  if(state._stackCycle && state._stackCycle.key===key){
    state._stackCycle.idx = (state._stackCycle.idx+1) % list.length;
  } else {
    state._stackCycle = {key, idx:0};
  }
  return list[state._stackCycle.idx];
}
/* Whether `attacker` is permitted to fight `defender` at all. Two absolute
   prohibitions, independent of dice: Brigadiers are never valid targets, and
   cavalry may never attack a unit sheltering in a building. Depends only on the
   attacker's TYPE and the defender's SQUARE, not on where the attacker stands,
   which is what lets the AI ask the question about a prospective move. */
export function canAttackTarget(attacker, defender){
  if(defender.type==='BRIGADIER') return false;
  if(UNIT_TYPES[attacker.type].isCavalry && terrainAt(defender.x,defender.y).key==='BUILDING') return false;
  return true;
}

export function isAdjacent(a,b){ return Math.max(Math.abs(a.x-b.x), Math.abs(a.y-b.y)) === 1; }

// Woods physically conceal whoever's standing in them (the tree-cluster piece
// acts as a lid on the real board) — this is automatic for ANY unit in a Woods
// square, not just one that's declared Lay Ambush. A declared ambush (u.hidden)
// is a separate, additional layer: same base concealment, plus the spring/bonus
// mechanics. Concealment only affects ranged targeting and AI awareness — an
// adjacent enemy can always see and fight a unit normally, concealed or not.
export function isConcealedFromEnemy(unit){
  if(unit.hidden) return true;
  return terrainAt(unit.x, unit.y).key === 'WOODS';
}
// Ambush status is only meaningful while standing in the Woods that conceal it —
// a defensive invariant, checked at the start of every turn.
export function enforceAmbushWoodsInvariant(){
  for(const u of state.units){
    /* Distinct reason from the move-time check. Both used to log "left the
       woods", which made them indistinguishable in the export, and a match log
       then showed three units standing down at the START of a turn. That should
       be impossible now the flag is cleared on the move itself, so something is
       getting a unit out of the trees without going through animateUnitTo.
       Naming the two apart is what will identify it. */
    if(u.hidden && terrainAt(u.x,u.y).key!=='WOODS'){
      clearAmbushIfOutOfWoods(u, 'turn-start sweep: hidden but not in woods');
    }
  }
}

/* AN AMBUSH ENDS THE MOMENT THE UNIT LEAVES THE TREES.

   The sweep above only ran at the start of a turn, so a unit that laid an ambush
   in woods and then marched out stayed flagged as hidden for the rest of that
   turn. It could stand on a road, in the open, still "IN AMBUSH", and still
   spring one, which is not a thing an ambush is.

   It was also visible: a Column formed by two such units drew as a woods tile,
   because a hidden unit reads as concealed wherever it stands.

   Called on every move now, so the flag cannot outlive the cover that justified
   it. The turn-start sweep is kept as a backstop for any path that repositions a
   unit without going through a move. */
export function clearAmbushIfOutOfWoods(u, reason){
  if(!u.hidden) return;
  if(terrainAt(u.x, u.y).key === 'WOODS') return;
  u.hidden = false;
  u.ambushWaited = 0;
  logReplay('ambush', { unitId:u.id, side:u.side, x:u.x, y:u.y,
    phase:'standDown', reason: reason || 'moved out of the woods' });
}
export function neighbors8(x,y){
  const out=[];
  for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++){
    if(dx===0&&dy===0) continue;
    const nx=x+dx, ny=y+dy;
    if(inBounds(nx,ny)) out.push({x:nx,y:ny,dx,dy});
  }
  return out;
}

/* =========================================================
   COHESION: which units in a brigade can currently move
   (must trace a touching-chain, incl. diagonal, back to the Brigadier)
   Computed per-Brigade — a side fields 3 independent Brigades, each
   with its own Brigadier and its own chain.
========================================================= */
export function movableUnitsForSide(side){
  const mine = state.units.filter(u=>!u.removed && u.side===side);
  const brigadeIds = [...new Set(mine.map(u=>u.brigadeId))];
  const connected = new Set();
  for(const bId of brigadeIds){
    const group = mine.filter(u=>u.brigadeId===bId);
    const brig = group.find(u=>u.type==='BRIGADIER');
    if(!brig){ group.forEach(u=>connected.add(u.id)); continue; } // Brigadier down: this Brigade's survivors act independently
    const local = new Set([brig.id]);
    let changed = true;
    while(changed){
      changed = false;
      for(const u of group){
        if(local.has(u.id)) continue;
        for(const other of group){
          if(!local.has(other.id)) continue;
          if(isAdjacent(u, other)){ local.add(u.id); changed = true; break; }
        }
      }
    }
    local.forEach(id=>connected.add(id));
  }
  return connected;
}

/* =========================================================
   MOVEMENT: BFS over grid, diagonal = 1 step, respects terrain
   and stacking, road bonus if start & end both on road.
========================================================= */
// Artillery brigaded entirely with Cavalry (no other combat unit types in the
// same Brigade) fights as Horse Artillery: moves at Cavalry speed everywhere
// except a ploughed field.
export function isHorseArtillery(u){
  if(u.type !== 'ARTILLERY') return false;
  const groupmates = state.units.filter(o=>!o.removed && o.side===u.side && o.brigadeId===u.brigadeId && o.id!==u.id && o.type!=='BRIGADIER');
  if(groupmates.length===0) return false;
  return groupmates.every(o => UNIT_TYPES[o.type].isCavalry);
}
export function isCavalryOrHorseArtillery(u){
  return UNIT_TYPES[u.type].isCavalry || isHorseArtillery(u);
}
export function brigadeCavalryCount(u){
  return state.units.filter(o=>!o.removed && o.side===u.side && o.brigadeId===u.brigadeId && UNIT_TYPES[o.type].isCavalry).length;
}
export function brigadeHasCavalryEscort(u){
  const available = brigadeCavalryCount(u);
  const key = u.side+'-'+u.brigadeId;
  const used = (state.ploughEscortUsed && state.ploughEscortUsed[key]) || 0;
  return used < available;
}
export function consumePloughEscort(u){
  if(!state.ploughEscortUsed) state.ploughEscortUsed = {};
  const key = u.side+'-'+u.brigadeId;
  state.ploughEscortUsed[key] = (state.ploughEscortUsed[key]||0) + 1;
}

// A clean 2-square Cavalry run in one consistent direction (no pivot), not
// crossing a ploughed field. Detected purely from start/end coordinates:
// covering a 2-square straight-line displacement in exactly 2 steps is only
// possible without a pivot, so no separate path-tracking is needed.
export function isCleanChargeRun(fromX, fromY, toX, toY){
  const dx = toX - fromX, dy = toY - fromY;
  const straight = (dx===0 || Math.abs(dx)===2) && (dy===0 || Math.abs(dy)===2) && !(dx===0 && dy===0);
  if(!straight) return false;
  const midX = fromX + dx/2, midY = fromY + dy/2;
  if(terrainAt(fromX,fromY).plough || terrainAt(midX,midY).plough || terrainAt(toX,toY).plough) return false;
  return true;
}
// Is `pos` adjacent to at least one enemy this side could legally charge? (not in
// Square, and not on higher ground than the charging destination — matches the
// "can't charge uphill or against a Square" restriction).
export function hasChargeableTargetAt(side, pos){
  return state.units.some(o=>!o.removed && o.side!==side && !isConcealedFromEnemy(o) && isAdjacent(pos,o) &&
    o.formation!=='square' && terrainAt(o.x,o.y).elevation<=terrainAt(pos.x,pos.y).elevation);
}
// Every legal move for a Cavalry unit that would count as a clean charge run
// AND land it adjacent to something worth charging — the set of squares the
// Charge button highlights.
export function computeChargeDestinations(u){
  if(!UNIT_TYPES[u.type].isCavalry) return [];
  return legalMoves(u).filter(m => isCleanChargeRun(u.x,u.y,m.x,m.y) && hasChargeableTargetAt(u.side, m));
}

export function unitBaseMove(u){
  if(isHorseArtillery(u)) return UNIT_TYPES.HEAVY_CAV.move;
  return UNIT_TYPES[u.type].move;
}

// Buildings sit on the road network (see the board art — every building square
// is placed on or beside a road), so they grant the same "+1 square if you
// start and end your move on a road" bonus a plain road square does.
export function isRoadLike(terr){ return !!(terr.isRoad || terr.key==='BUILDING'); }

/* The route the last legalMoves search found from a unit's position to a chosen
   destination, inclusive of both ends. A single-square move therefore returns a
   two-element array, per the output contract.

   Module-level rather than local because the animator asks for the path AFTER
   legalMoves has returned, for the move actually chosen. Overwritten by that
   unit's next search, so it is a cache of the last search rather than state that
   accumulates.

   Returns null rather than guessing when the cache does not match the unit or
   the destination was never reached. An animator that invented a route would
   show a unit crossing ground it could not legally cross, so the caller falls
   back to a straight two-point slide instead. */
let lastSearch = null;

export function reconstructPath(u, toX, toY){
  if(!lastSearch || lastSearch.unitId !== u.id) return null;
  const target = toX+','+toY;
  if(target === lastSearch.from) return [{x:toX, y:toY}];
  if(!lastSearch.cameFrom.has(target)) return null;
  const out = [];
  let key = target;
  const guard = COLS*ROWS + 2;           // no path can be longer than the board
  for(let i=0; i<guard; i++){
    const [x,y] = key.split(',').map(Number);
    out.push({x, y});
    if(key === lastSearch.from) break;
    key = lastSearch.cameFrom.get(key);
    if(key === undefined) return null;   // broken chain: never return half a route
  }
  return out.reverse();
}

/* CAN THIS UNIT MOVE AT ALL — asked without disturbing anything.

   legalMoves() is not a pure query: it writes `lastSearch`, and the auto-end
   test asks it of every unit on the side, several times a turn. This saves and
   restores that trail so a bystander's search cannot overwrite a live one.

   CORRECTING AN EARLIER COMMIT MESSAGE, which said this was fixing a visible
   fault in move animation. It was not. reconstructPath() is the only reader of
   lastSearch, and it is currently called from nowhere. The animator uses
   displayPath() in render-board.js, which runs its own search and deliberately
   does NOT consult this one, because for display purposes squares holding other
   units are passable and the legality search cannot treat them that way. So
   there was no live consumer to corrupt and the animation was never at risk.

   Kept regardless, on the narrower grounds that something named like a query
   should not leave state behind and reconstructPath is exported and may yet be
   wired up. But it prevents a hypothetical bug, not one that was happening. */
export function hasAnyLegalMove(u){
  const saved = lastSearch;
  const any = legalMoves(u).length > 0;
  lastSearch = saved;
  return any;
}

export function legalMoves(u){
  if(u.formation==='square') return []; // squares don't move
  if(u.turnOnly) return [];
  if(state.moved && state.moved.has(u.id)) return []; // already moved (or explicitly stood pat) this phase
  const connected = movableUnitsForSide(u.side);
  if(!connected.has(u.id)) return [];

  let allowance = unitBaseMove(u);
  const startRoad = isRoadLike(terrainAt(u.x,u.y));
  const cavOrHorseArty = isCavalryOrHorseArtillery(u);
  const isFootArtillery = UNIT_TYPES[u.type].isArtillery && !isHorseArtillery(u);
  const hasEscort = isFootArtillery ? brigadeHasCavalryEscort(u) : false;

  /* cameFrom records which square each cell was reached FROM, so the route the
     search already walked can be reconstructed instead of thrown away. The BFS
     visits every intermediate square anyway; it simply discarded them. Written
     wherever dist is written, so the two can never disagree. */
  const dist = new Map();
  const cameFrom = new Map();
  const startKey = u.x+','+u.y;
  dist.set(startKey, 0);
  const queue = [{x:u.x,y:u.y,d:0}];
  const results = [];
  const maxSteps = allowance + (startRoad?1:0); // optimistic cap; road bonus validated per-destination below

  while(queue.length){
    const cur = queue.shift();
    if(cur.d >= maxSteps) continue;
    for(const n of neighbors8(cur.x, cur.y)){
      const key = n.x+','+n.y;
      const nd = cur.d + 1;
      if(dist.has(key) && dist.get(key) <= nd) continue;
      const terr = terrainAt(n.x,n.y);
      const t = UNIT_TYPES[u.type];
      if(terr.restrictTo && !terr.restrictTo.includes(t.key)) continue;
      if(terr.plough && isFootArtillery && !hasEscort) continue; // Foot Artillery needs a Cavalry escort in its Brigade to cross a ploughed field
      // occupancy check
      const occ = unitsAt(n.x,n.y).filter(o=>o.id!==u.id && o.side===u.side);
      const enemyUnitsHere = unitsAt(n.x,n.y).filter(o=>o.side!==u.side);
      const enemyOcc = enemyUnitsHere.length>0 && !(enemyUnitsHere.length===1 && enemyUnitsHere[0].type==='BRIGADIER');
      if(enemyOcc) continue; // can't move onto an enemy square (that's a fight, not a move) — except a lone Brigadier, who gets shoved aside instead
      if(occ.length>0){
        /* A SQUARE WILL NOT BE DOUBLED INTO.
        
           canLayAmbush already refuses to form a Square on a shared cell
           ("Square-style formations need the square to itself"), but only in
           that direction: nothing stopped a second unit walking onto a Square
           that had already formed. The result was a Column and a Square on one
           square at once, two formations that mean opposite things (one is a
           marching block, the other is a static all-round defence), with the
           combat code reading whichever it asked for first.
        
           Closed here rather than in the Square button, so the rule holds
           whoever arrives second. */
        const canDouble = terr.allowDouble && (t.key==='INFANTRY'||t.key==='GUARD') && occ.every(o=>UNIT_TYPES[o.type].key==='INFANTRY'||UNIT_TYPES[o.type].key==='GUARD') && occ.every(o=>o.formation!=='square') && occ.length<2;
        if(!canDouble) continue;
      }
      dist.set(key, nd);
      cameFrom.set(key, cur.x+','+cur.y);
      queue.push({x:n.x,y:n.y,d:nd});
    }
  }

  lastSearch = { unitId: u.id, from: startKey, cameFrom };

  const startPlough = terrainAt(u.x,u.y).plough;
  for(const [key,d] of dist){
    if(key===startKey) continue;
    const [x,y] = key.split(',').map(Number);
    const endRoad = isRoadLike(terrainAt(x,y));
    let effAllowance = (startRoad && endRoad) ? allowance+1 : allowance;
    const endPlough = terrainAt(x,y).plough;
    if(cavOrHorseArty && (startPlough || endPlough)) effAllowance = Math.min(effAllowance, 1); // hard going for horses starting or ending on a ploughed field
    if(d <= effAllowance) results.push({x,y,steps:d});
  }
  return results;
}

/* =========================================================
   ARTILLERY: RANGE, LINE OF SIGHT
========================================================= */
export function chebyshev(a,b){ return Math.max(Math.abs(a.x-b.x), Math.abs(a.y-b.y)); }

export function lineCells(a,b){
  // Bresenham-ish supercover line between cell centers, used for LOS sampling
  const cells = [];
  let x0=a.x, y0=a.y, x1=b.x, y1=b.y;
  const dx = Math.abs(x1-x0), dy = Math.abs(y1-y0);
  const sx = x0<x1?1:-1, sy = y0<y1?1:-1;
  let err = dx-dy, x=x0, y=y0;
  while(true){
    cells.push({x,y});
    if(x===x1 && y===y1) break;
    const e2 = 2*err;
    if(e2 > -dy){ err -= dy; x += sx; }
    if(e2 < dx){ err += dx; y += sy; }
  }
  return cells;
}

export function hasLOS(gun, target){
  if(chebyshev(gun,target) > 6) return false;
  const path = lineCells(gun,target).slice(1,-1); // exclude endpoints
  const gunElev = terrainAt(gun.x,gun.y).elevation;
  const tgtElev = terrainAt(target.x,target.y).elevation;
  const shooterElevated = gunElev > 0 || tgtElev > 0;
  let blockedCount = 0;
  for(const c of path){
    const terr = terrainAt(c.x,c.y);
    const occ = unitsAt(c.x,c.y).length>0;
    const blocksHere = terr.blocksLOS || occ;
    if(blocksHere){
      // overhead fire allowed if gun or target is on higher ground than the obstruction
      if(shooterElevated && terr.elevation <= Math.max(gunElev,tgtElev)) continue;
      blockedCount++;
    }
  }
  // "needs to see half or more of target" -> simplified: no more than half the path may be blocked
  return blockedCount === 0 || (blockedCount / Math.max(path.length,1)) < 0.5;
}

export function artilleryTargets(gun){
  if(gun.turnOnly) return []; // pushed/shaken: can only turn around, not fire
  if(state.fired && state.fired.has(gun.id)) return []; // already fired this phase
  if(state.moved && state.moved.has(gun.id)) return []; // moved this turn — Artillery is move OR fire, never both
  if(isInActiveFight(gun)) return []; // in contact with an enemy: it joins the Fight phase instead of firing at range
  return state.units.filter(t=>!t.removed && !isConcealedFromEnemy(t) && t.type!=='BRIGADIER' && t.side!==gun.side && hasLOS(gun,t) && !isInActiveFight(t));
}
export function isInActiveFight(u){
  return state.units.some(o=>!o.removed && o.side!==u.side && isAdjacent(o,u));
}

/* =========================================================
   COMBAT
========================================================= */
/* SEEDED DICE, so a match can be reproduced from its log.

   rollD6 called Math.random() directly, which meant no bug found in an export
   could ever be replayed: the same log could not be regenerated even with
   identical play. A seed is recorded in the match metadata and every roll comes
   from it.

   mulberry32: small, fast, and good enough for dice. Not cryptographic, and it
   does not need to be. The sequence is deterministic given the seed, so a
   reported log can be reproduced exactly by starting a match with the same one. */
let rngState = (Date.now() ^ 0x9e3779b9) >>> 0;
let rngSeed = rngState;

export function seedRng(seed){
  rngSeed = (seed >>> 0) || 1;
  rngState = rngSeed;
}
export function currentRngSeed(){ return rngSeed; }

function nextRandom(){
  rngState = (rngState + 0x6D2B79F5) >>> 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function rollD6(){ return 1+Math.floor(nextRandom()*6); }
export function rollBest(n){ /* keptDie is the die that COUNTS, tracked separately from value because value later absorbs bonuses and re-rolls */ let best=0; const all=[]; for(let i=0;i<n;i++){const r=rollD6(); all.push(r); if(r>best) best=r;} return {value:best, rolls:all, keptDie: best }; }

// Two Infantry/Guard units doubled into the same open-terrain square form
// a Column: a genuine combat bonus, not just shared artillery vulnerability.
export function stackPartner(u){
  if(!(u.type==='INFANTRY'||u.type==='GUARD')) return null;
  return state.units.find(o=>!o.removed && o.id!==u.id && o.side===u.side && o.x===u.x && o.y===u.y && (o.type==='INFANTRY'||o.type==='GUARD'));
}
export function isInColumn(u){ return !!stackPartner(u); }

// Every combat bonus that grants a unit a 2nd die comes from a different source
// (terrain, Square vs Cavalry, Cavalry vs open Infantry, Attack Column,
// Infantry vs Square, Ambush-Advance). Guard/Heavy Cavalry's own re-roll is
// NOT one of these — it's an interactive choice offered after the roll if
// that unit is losing, not an upfront extra die — see offerCombatReroll()
// below, called from resolveFight.
export function combatBonuses(unit, opponent, defending, extraSources){
  const t = UNIT_TYPES[unit.type];
  const oppT = UNIT_TYPES[opponent.type];
  const terr = terrainAt(unit.x,unit.y);
  const sources = [];
  // Bonuses that must be a flat +1 rather than the second die that the FIRST
  // entry in `sources` always grants.
  let valueBonusDirect = 0;
  const directReasons = [];

  const eligibleDefender = t.key==='INFANTRY' || t.key==='GUARD' || t.key==='ARTILLERY';
  // A unit that sprang a Woodland Ambush this round gets no woods defence bonus until its side's next turn.
  const ambushSuppressed = terr.key==='WOODS' && unit.ambushSpentThisRound;
  if(defending && terr.defenseBonus && eligibleDefender && !ambushSuppressed){
    const coverLabel = terr.key==='WOODS' ? 'Defending in woods' : 'Defending in a building';
    /* WOODS IS +1 FOR EVERYONE, never a second die.
    
       Trees break up a formation as much as they shelter it: a unit in woods is
       harder to come at but cannot bring more muskets to bear, which is what a
       second die represents. A building is different and keeps the die for
       infantry, who can line every window and fire together.
    
       The second die in woods now belongs to the AMBUSH alone, which is the one
       case where being among the trees multiplies what a unit can do rather than
       merely protecting it. Granting the die for ordinary woods defence as well
       made the ambush's own bonus nearly worthless by comparison. */
    if(t.isArtillery || terr.key==='WOODS'){
      /* A gun in cover gets +1 to its result, never a second die. Crews
         sheltering in a building fight better than in the open, but the cover
         does not put more of them in the firing line the way it does for
         infantry, who can line every window. Applied directly rather than
         through `sources`, because the first entry there always grants a
         second die and that is precisely what should not happen here. */
      valueBonusDirect += 1;
      directReasons.push(coverLabel + ': +1 to roll');
    } else {
      sources.push(coverLabel);
    }
  }
  /* SQUARE ONLY HELPS A UNIT THAT IS RECEIVING, not one that attacks.
  
     The `defending` gate was missing, so infantry in square drew its second die
     when it marched out and attacked cavalry. A logged fight shows 9e Legere
     attacking the Scots Greys and rolling two dice for 'Square vs Cavalry'.
  
     A square is formed to stand and receive a charge; a unit that leaves to
     attack is not doing that, and every other cover and formation bonus here is
     already gated on defending.
  
     FLAGGED AS A JUDGEMENT, not a citation: the ruleset PDF in the project is
     not readable (it carries a ZIP header, so the file is something else under
     a .pdf name). The cavalry bonus immediately below WAS checked against the
     printed rules and is deliberately not gated, so the two differ on purpose
     rather than by oversight. Worth confirming against the book. */
  if(defending && oppT.isCavalry && (t.key==='INFANTRY'||t.key==='GUARD') && unit.formation==='square'){
    sources.push('Square vs Cavalry');
  }
  /* Cavalry fighting Infantry/Guard not in Square rolls a second die, whether
     the cavalry is attacking or defending.

     W3, HOUSE RULE: except into woods, where it gets the +1 without the die.

     Trees break up a charge. Shock is the whole of cavalry's advantage over
     formed infantry, and an extra die is what shock is worth in this system, so
     terrain that removes the charge should remove the die rather than merely
     tax the result. Note the printed ruleset has no woods clause here at all,
     and also forbids cavalry from ENTERING woods, so this only ever applies to
     a charge made from outside into infantry sheltering among the trees.

     Deliberately still worth +1: the horsemen are still a threat at the edge of
     the wood, just not a decisive one. Under the sources model below the first
     entry grants the second die and later ones grant +1 each, so this has to be
     applied directly rather than pushed, or it would silently become the die it
     is meant to withhold. */
  if(t.isCavalry && (oppT.key==='INFANTRY'||oppT.key==='GUARD') && opponent.formation!=='square'){
    if(terrainAt(opponent.x, opponent.y).key === 'WOODS'){
      valueBonusDirect += 1;
      directReasons.push('Cavalry into woods: +1 to roll (no 2nd die)');
    } else {
      sources.push('Cavalry vs non-Square Infantry');
    }
  }

  /* W5, HOUSE RULE: melee against artillery is a second die, not just a +1,
     unless the gun is in a building.

     Artillery is the only ranged unit in the game and it is the strongest thing
     on the board at range, so it should be correspondingly fragile once anyone
     reaches it. This was already a flat +1 applied further down in resolveFight;
     it moves here so that it grants the die, and so that it appears in the
     logged sources list like every other bonus.

     A BUILDING CANCELS BOTH the die and the +1. A gun behind walls is fought as
     an ordinary defender, and the defender's own building bonus then applies on
     top, which makes buildings genuinely worth siting a battery in rather than
     incidental terrain.

     Never three dice: the sources model grants exactly one second die however
     many entries fire, so cavalry attacking a gun in the open rolls two, the
     same as infantry attacking that gun. Artillery is not infantry, so the
     cavalry clause above does not fire against it in any case. */
  if(!defending && (t.key==='INFANTRY'||t.key==='GUARD'||t.isCavalry) && oppT.key==='ARTILLERY'
     && terrainAt(opponent.x, opponent.y).key !== 'BUILDING'){
    sources.push('Attacking Artillery');
  }
  if((t.key==='INFANTRY'||t.key==='GUARD') && isInColumn(unit)){
    sources.push('Attack Column');
  }
  // Infantry attacking a Square (and not itself in Square) rolls a second die —
  // attacker-only, since a Square never initiates a fight (it can't move).
  if(!defending && (t.key==='INFANTRY'||t.key==='GUARD') && unit.formation!=='square' && (oppT.key==='INFANTRY'||oppT.key==='GUARD') && opponent.formation==='square'){
    sources.push('Infantry vs Square');
  }
  for(const ex of (extraSources||[])){ if(ex.applies) sources.push(ex.reason); }

  let dice = 1, valueBonus = 0;
  const reasons = [];
  sources.forEach((label, i)=>{
    if(i===0){ dice = 2; reasons.push(label); }
    else { valueBonus += 1; reasons.push(`${label}: +1 to roll (2nd die already granted)`); }
  });
  // `sources` is returned so a fight can log every bonus that fired, not only
  // the totals. The FIRST source grants a second die and every further source
  // grants +1 to the value instead, so a duplicated entry is invisible in the
  // totals and obvious in the list.
  valueBonus += valueBonusDirect;
  for(const r of directReasons) reasons.push(r);
  return { dice, valueBonus, reasons, sources: sources.concat(directReasons) };
}

// Guard Infantry and Heavy Cavalry's own re-roll (the physical rulebook card:
// "Gets to re-roll in combat") is an interactive choice offered to whichever
// of the two currently has the lower roll — shown as a button under the dice
// that are already on screen, not a separate modal, so the actual roll is
// visible before any decision is asked for. No listed limit on the card, so
// it's available every fight, and the AI always takes it when eligible since
// there's no cost to declining.
export function offerCombatReroll(attacker, defender, aRoll, dRoll, aReasons, dReasons, aValueBonus, dValueBonus, onComplete){
  const aLabel = SIDE_LABEL[attacker.side].split(' ')[0], dLabel = SIDE_LABEL[defender.side].split(' ')[0];
  function currentGroups(){
    return [
      {label:aLabel, rolls:aRoll.rolls, keptValue:aRoll.keptDie, finalValue:aRoll.value, notes:aReasons,
       portrait:unitPortraitHTML(attacker), unitName:attacker.historicalName || UNIT_TYPES[attacker.type].label},
      {label:dLabel, rolls:dRoll.rolls, keptValue:dRoll.keptDie, finalValue:dRoll.value, notes:dReasons,
       portrait:unitPortraitHTML(defender), unitName:defender.historicalName || UNIT_TYPES[defender.type].label}
    ];
  }
  function leadText(){
    if(aRoll.value === dRoll.value) return 'Tied so far';
    return aRoll.value > dRoll.value ? `${aLabel} leads` : `${dLabel} leads`;
  }
  function tryOne(unit, roll, reasons, valueBonus, opponentValue, next){
    if(!UNIT_TYPES[unit.type].reroll || roll.value >= opponentValue){ next(); return; }
    const isHuman = !FAST_DICE_MODE && !(state.mode==='ai' && unit.side===state.aiSide);
    const doReroll = ()=> applyCombatReroll(unit, roll, reasons, valueBonus, ()=>{
      refreshDiceFrame(currentGroups(), leadText(), '');
      next();
    });
    if(!isHuman){
      setTimeout(doReroll, 500); // AI always takes it when eligible — no cost to declining
      return;
    }
    showDiceRerollButton(`Use Re-roll (${unitLabel(unit)})`, doReroll, next);
  }
  // Defender's chance first, then attacker's — the printed ruleset (p.6) is
  // explicit that where both sides can re-roll, the defender decides first.
  // The attacker is then offered whatever aRoll.value/dRoll.value now are
  // after any defender re-roll, so an attacker who was only just barely ahead
  // can still find themselves behind and eligible in turn.
  tryOne(defender, dRoll, dReasons, dValueBonus, aRoll.value, ()=>{
    tryOne(attacker, aRoll, aReasons, aValueBonus, dRoll.value, onComplete);
  });
}

export function applyCombatReroll(unit, roll, reasons, valueBonus, next){
  const newVal = rollD6();
  const previous = roll.rolls.slice();   // everything thrown before this re-roll
  roll.rolls.push(newVal);

  /* THE RE-ROLL REPLACES THE LOWEST DIE, and can never leave the unit worse off.

     With two dice, the lower one is thrown again and the best of what stands is
     kept. With one die, the new roll competes with the old rather than replacing
     it outright. Both cases come to the same thing: keep the best of everything
     thrown. This is a privilege of Guard and Heavy Cavalry and should be a
     reliable improvement in the odds, not a gamble that can cost them the fight.

     THIS REVERSES AN EARLIER CHANGE, deliberately. That change made the re-roll
     replace the kept die outright, and it was made to fix the PANEL showing a
     discarded die as kept (a Guard rolling 5, re-rolling to 2, and fighting on 2
     while the display highlighted the 5). The real fault there was that keptDie
     was not being tracked, and that fix stays: keptDie is still set explicitly
     here, so the panel highlights whatever the unit actually fights on. Only the
     choice of which die to keep has changed back. */
  roll.keptDie = Math.max(...previous, newVal);
  // Uncapped, matching the bonus application in resolveFight: see the note there.
  roll.value = roll.keptDie + valueBonus;
  reasons.push(`Re-roll (Guard/Hvy Cav): re-rolled to ${newVal}, fights on ${roll.keptDie}`);
  log(`${unitLabel(unit)} uses its re-roll (Guard/Hvy Cav) — new roll: ${newVal}.`, 'combat');
  next();
}

export function resolveFight(attacker, defender, ambushMode, onComplete){
  onComplete = onComplete || function(){};
  showActionLine(attacker, defender, '#a8720b', 3800);
  const aType = UNIT_TYPES[attacker.type], dType = UNIT_TYPES[defender.type];
  const aExtra = [];
  if(ambushMode==='advance') aExtra.push({applies:true, reason:'Ambush: committed second die'});
  const aBonus = combatBonuses(attacker, defender, false, aExtra);
  const dBonus = combatBonuses(defender, attacker, true, []);
  let aDice = aBonus.dice, dDice = dBonus.dice;
  const aReasons = [...aBonus.reasons], dReasons = [...dBonus.reasons];
  // Surface the Charge as a visible factor in the roll popup even when it isn't the
  // deciding one (previously only appeared if it happened to win a tie, which made
  // charging look like it did nothing most of the time).
  if(attacker.charged && aType.isCavalry && dType.key!=='BRIGADIER'){
    aReasons.push('Charging: wins ties outright');
  }
  // House rule: a unit still turned around from a prior pushback (or an artillery
  // result of 4) gives the attacker +1 to their rolled value if
  // struck while in that state — same phrasing/mechanic as the Ambush bonus.
  let aValueBonus = aBonus.valueBonus, dValueBonus = dBonus.valueBonus;
  /* Several +1s are applied HERE rather than inside combatBonuses, so they were
     absent from the logged sources list and a fight could show "bonus +2" with
     nothing accounting for it. They were never hidden from the player (they are
     in the panel's notes), but they were hidden from the log, which is exactly
     where someone checking the arithmetic would look. */
  const extraASources = [];
  if(defender.turnOnly){ aValueBonus += 1; aReasons.push('Defender turned around: +1 to roll'); extraASources.push('Defender turned around +1'); }
  if(ambushMode){ aValueBonus += 1; aReasons.push('Ambush: +1 to roll'); extraASources.push('Ambush +1'); }
  /* The Attacking Artillery bonus used to be a flat +1 applied here. It moved
     into combatBonuses under W5, where it grants a second die instead and is
     cancelled entirely by a building. Applying it here as well would double it. */

  const aName = SIDE_LABEL[attacker.side].split(' ')[0], dName = SIDE_LABEL[defender.side].split(' ')[0];
  const tieWinNote = attacker.charged && aType.isCavalry && defender.formation!=='square' ? `${aName} wins ties (Charge)`
    : isInColumn(attacker) && (aType.key==='INFANTRY'||aType.key==='GUARD') ? `${aName} wins ties (Column)`
    : null;
  const legend = 'Draw: fight continues \u00b7 Margin 1: pushed back \u00b7 Margin 2: routed \u00b7 Margin 3+: destroyed' + (tieWinNote ? ` \u00b7 ${tieWinNote}` : '');

  // Pure — no side effects — so it's safe to call more than once (the interim
  // display before any re-roll decision, and again after) without double-adding
  // a tie-win note to aReasons/dReasons each time it's called.
  function computeFightResult(aVal, dVal){
    const isTie = aVal === dVal;
    const defenderHillTieWin = isTie &&
      terrainAt(defender.x,defender.y).elevation > terrainAt(attacker.x,attacker.y).elevation;
    const attackerChargeTieWin = isTie && !defenderHillTieWin && attacker.charged &&
      UNIT_TYPES[attacker.type].isCavalry && defender.formation!=='square' &&
      terrainAt(defender.x,defender.y).elevation <= terrainAt(attacker.x,attacker.y).elevation;
    const attackerColumnTieWin = isTie && !defenderHillTieWin && !attackerChargeTieWin &&
      (aType.key==='INFANTRY'||aType.key==='GUARD') && isInColumn(attacker);
    const genuineDraw = isTie && !defenderHillTieWin && !attackerChargeTieWin && !attackerColumnTieWin;
    /* THE MESSAGE NAMES THE EFFECT, not just the margin.
    
       It reported the arithmetic and left the player to map it onto an outcome
       from the reference line: "Britain wins by 3" never actually said the unit
       dies, and a tie-win said nothing about what happened at all while the board
       quietly pushed somebody back. Two descriptions of one event, which is how a
       correct outcome comes to look like a bug.
    
       Derived from the SAME margin the board uses, so the sentence and the effect
       cannot describe different things. */
    const margin = Math.abs(aVal - dVal);
    const effectOf = m => m >= 3 ? 'destroyed' : m === 2 ? 'routed' : 'pushed back';
    
    let resultText, resultCls;
    if(genuineDraw){ resultText = 'Drawn — continues next turn'; resultCls = 'draw'; }
    // A tie-win is always a pushback: the margin is zero by definition.
    else if(defenderHillTieWin){ resultText = `${dName} holds the high ground — ${aName} pushed back`; resultCls = 'win'; }
    else if(attackerChargeTieWin){ resultText = `${aName}'s charge carries the tie — ${dName} pushed back`; resultCls = 'win'; }
    else if(attackerColumnTieWin){ resultText = `${aName}'s Column carries the tie — ${dName} pushed back`; resultCls = 'win'; }
    else {
      const winner = aVal > dVal ? aName : dName, loser = aVal > dVal ? dName : aName;
      resultText = `${winner} wins by ${margin} — ${loser} ${effectOf(margin)}`;
      resultCls = 'win';
    }
    return { resultText, resultCls, genuineDraw, defenderHillTieWin, attackerChargeTieWin, attackerColumnTieWin };
  }

  /* Arm the battle bed for THIS panel only. Artillery uses the same dice
     overlay and must stay silent under it, so nothing else calls this. The
     observer in dice.js disarms itself when the panel closes, so a fight that
     ends without reaching here cannot leave it armed for the next one. */
  armBattleBed();
  presentRollTrigger([
    {label:aName, diceCount:aDice, notes:aReasons,
     portrait:unitPortraitHTML(attacker), unitName:attacker.historicalName || aType.label},
    {label:dName, diceCount:dDice, notes:dReasons,
     portrait:unitPortraitHTML(defender), unitName:defender.historicalName || dType.label}
  ], attacker.side, ()=>{
    const aRoll = rollBest(aDice);
    const dRoll = rollBest(dDice);
    /* NO CAP ON THE BONUSED VALUE.

       It used to clamp at 6, which quietly threw the bonus away whenever the
       unit had rolled well: with two dice a 6 comes up 30.6% of the time, so
       roughly a third of every bonus in the game was wasted, and wasted
       precisely on the rolls that deserved it most. An ambush landing a 6 got
       nothing for springing from cover.

       Removing it costs 5 points of win rate and 5 of destroy rate back to the
       bonused side, and makes a bonus mean the same thing regardless of the die
       under it. The margin table is unbounded above (3+ destroys), so a value of
       7 or 8 needs no special handling: it simply widens the margin, which is
       what a bonus is for. */
    if(aValueBonus) aRoll.value = aRoll.value + aValueBonus;
    if(dValueBonus) dRoll.value = dRoll.value + dValueBonus;

    // Show the actual roll immediately — held open rather than auto-fading —
    // so it's genuinely visible before any re-roll decision is asked for. Uses
    // the exact same result phrasing as the final settle below (not a
    // placeholder "X leads"), recomputed here since the tie-break rules
    // (Charge/Column/Hill) can only be evaluated once real values exist.
    const interim = computeFightResult(aRoll.value, dRoll.value);
    showDice([
      {label:aName, rolls:aRoll.rolls, keptValue:aRoll.keptDie, finalValue:aRoll.value, notes:aReasons,
       portrait:unitPortraitHTML(attacker), unitName:attacker.historicalName || aType.label},
      {label:dName, rolls:dRoll.rolls, keptValue:dRoll.keptDie, finalValue:dRoll.value, notes:dReasons,
       portrait:unitPortraitHTML(defender), unitName:defender.historicalName || dType.label}
    ], interim.resultText, interim.resultCls, null, true);

    offerCombatReroll(attacker, defender, aRoll, dRoll, aReasons, dReasons, aValueBonus, dValueBonus, ()=>{
    /* FROZEN AT THE MOMENT THE PANEL IS BUILT.
    
       A logged fight showed the panel reading "Britain wins by 3" while the
       board did a pushback. A pushback is exactly what a 6-against-6 charge tie
       produces, so the BOARD was right: the panel was describing 6 against 3,
       the PRE-re-roll values. The defender's own note on that panel read
       "re-rolled to 6, fights on 6", contradicting the headline above it.
    
       Rather than keep hunting for where the two readings diverge, they can no
       longer diverge. The values are captured once, here, after every re-roll is
       settled, and the headline, the kept-die highlight, the outcome and the
       replay entry all derive from THESE rather than from a fresh read of
       aRoll/dRoll. The panel and the board cannot tell different stories because
       there is now only one story. */
    const finalA = aRoll.value, finalD = dRoll.value;
    const final = computeFightResult(finalA, finalD);
    const { resultText, resultCls, genuineDraw, defenderHillTieWin, attackerChargeTieWin, attackerColumnTieWin } = final;
    if(defenderHillTieWin) dReasons.push('Tie-win: Hill defence');
    else if(attackerChargeTieWin) aReasons.push('Tie-win: Charge');
    else if(attackerColumnTieWin) aReasons.push('Tie-win: Attack Column');

    refreshDiceFrame([
      // finalValue from the frozen pair, so the headline, the highlighted die and
      {label:aName, rolls:aRoll.rolls, keptValue:aRoll.keptDie, finalValue:finalA, notes:aReasons,
       portrait:unitPortraitHTML(attacker), unitName:attacker.historicalName || aType.label},
      // the adjustment beneath it all describe the same fight.
      {label:dName, rolls:dRoll.rolls, keptValue:dRoll.keptDie, finalValue:finalD, notes:dReasons,
       portrait:unitPortraitHTML(defender), unitName:defender.historicalName || dType.label}
    ], resultText, resultCls);

    /* Exactly what the PANEL was built from. fightOutcome below is computed
       inside the settle roughly 2.9 seconds later and reads the same two
       variables. If anything moves them in between, the board does one thing
       while the panel said another, which is the reported symptom. Compared in
       the log rather than assumed equal. */
    const panelSnapshot = { a: finalA, d: finalD };

    finishDice(()=>{
      // Deferred until the popup has fully faded — nothing on the board moves
      // while there are still dice on screen to read.
      attacker.charged = false; // spent, win or lose — a charge is a one-shot burst of momentum

      // Derived from the FROZEN values, not a fresh read. See the note above.
      const fightOutcome = genuineDraw ? 'stalemate'
        : (defenderHillTieWin || attackerChargeTieWin || attackerColumnTieWin) ? 'pushback'
        : (Math.abs(finalA-finalD)>=3 ? 'destroy' : Math.abs(finalA-finalD)===2 ? 'rout' : 'pushback');
      logReplay('fight', {
        attackerId: attacker.id, defenderId: defender.id,
        attackerSide: attacker.side, defenderSide: defender.side,
        x: defender.x, y: defender.y, result: fightOutcome,
        aRoll: finalA, dRoll: finalD,
        /* DIAGNOSTIC. Screenshots from a real match showed the panel and the
           board disagreeing: one frame carried a "Tie-win: Attack Column" note,
           recorded only when the two values are EQUAL, alongside a headline of
           "Britain wins by 5". Reading the source did not explain it, so the
           replay now records everything the panel was built from beside what
           the engine actually resolved on. Whichever is wrong, the next
           exported log says so outright instead of leaving it to be inferred
           from screenshots. Worth keeping: a fight that resolves oddly is
           exactly what a replay should be able to answer. */
        diag: {
          aRolls: aRoll.rolls.slice(), aKept: aRoll.keptDie, aBonus: aValueBonus,
          dRolls: dRoll.rolls.slice(), dKept: dRoll.keptDie, dBonus: dValueBonus,
          // The count actually rolled with, not aBonus.dice: aDice is a `let` that
          // later code can raise, and a re-roll pushes another entry into rolls,
          // so the two legitimately differ and comparing them raised false alarms.
          aDice, dDice,
          // Every bonus that fired, in order. The first grants a second die and
          // each later one grants +1, so a source appearing twice inflates the
          // value silently. This is the list to read if a bonus is doubled.
          aSources: (aBonus.sources||[]).concat(extraASources),
          dSources: (dBonus.sources||[]).slice(),
          panelText: resultText,
          panelA: panelSnapshot.a, panelD: panelSnapshot.d,
          settleA: finalA, settleD: finalD,
          /* Kept as a LIVE read on purpose. The panel and the outcome now share
             one frozen pair, so this can no longer catch a divergence between
             them; what it still catches is anything mutating aRoll/dRoll AFTER
             the freeze, which would be a new fault worth knowing about. */
          drift: (panelSnapshot.a !== aRoll.value || panelSnapshot.d !== dRoll.value),
          margin: Math.abs(finalA - finalD),
          ties: { genuineDraw, defenderHillTieWin, attackerChargeTieWin, attackerColumnTieWin },
          aNotes: aReasons.slice(), dNotes: dReasons.slice(),
          // Feature probe: is the RUNNING code the current build? Mobile Safari
          // caches ES modules, so a stale engine-rules.js alongside a fresh
          // index.html would reproduce every symptom reported. Self-maintaining,
          // unlike a version constant someone has to remember to bump.
          build: { keptDie: typeof aRoll.keptDie === 'number',
                   sources: Array.isArray(aBonus.sources) }
        }
      });

      if(genuineDraw){
        log(`${aType.label} vs ${dType.label}: ${finalA}-${finalD}, drawn — fight continues next turn.`, 'combat');
        logNarration('melee_stalemate');
        onComplete();
        return;
      }
      if(defenderHillTieWin){
        log(`${dType.label} holds the high ground against ${aType.label}: ${finalA}-${finalD} tie goes to the defender.`, 'combat');
        logNarration('melee_pushback', 'loss');
        pushBack(attacker, defender);
        onComplete();
        return;
      }
      if(attackerChargeTieWin || attackerColumnTieWin){
        const reason = attackerChargeTieWin ? 'a clean charge' : 'a Column formation';
        log(`${aType.label}'s ${reason} carries the ${finalA}-${finalD} tie against ${dType.label}.`, 'combat');
        logNarration('melee_pushback', 'win');
        pushBack(defender, attacker);
        onComplete();
        return;
      }
      // Frozen throughout: who won, and by how much, cannot drift from the panel.
      const winnerIsAttacker = finalA > finalD;
      const winner = winnerIsAttacker ? attacker : defender;
      const loser = winnerIsAttacker ? defender : attacker;
      const diff = Math.abs(finalA - finalD);
      log(`${unitLabel(attacker)} (${SIDE_LABEL[attacker.side]}) vs ${unitLabel(defender)} (${SIDE_LABEL[defender.side]}): ${finalA}-${finalD}. ${unitLabel(loser)} of ${SIDE_LABEL[loser.side]} takes the worse of it.`, 'combat');

      const columnPartner = stackPartner(loser); // a broken Column takes both units with it
      const attackerSucceeded = winnerIsAttacker;
      if(diff===1){
        logNarration('melee_pushback', attackerSucceeded ? 'win' : 'loss');
        pushBack(loser, winner);
        onComplete();
      } else if(diff===2){
        logNarration('melee_rout', attackerSucceeded ? 'win' : 'loss');
        retreatAndRally(loser, ()=>{
          if(columnPartner) retreatAndRally(columnPartner, onComplete);
          else onComplete();
        });
      } else {
        logNarration('melee_destroy', attackerSucceeded ? 'win' : 'loss');
        removeUnit(loser, 'destroyed in combat');
        /* NO SHARED FATE IN MELEE. Only an ARTILLERY hit takes both halves of a
           Column: a roundshot goes through a doubled stand and kills the lot, which
           is the risk of stacking. Infantry and cavalry fight one unit at a time,
           and beating the top one does not kill the one underneath it.
        
           Both halves still ROUT together on a margin of 2 (see above): the stand
           breaks as one and the partner cannot hold the ground alone. Only
           destruction is separated.
        
           This also removes the most efficient result in the game from melee, where
           it was two kills from a single roll. */
        onComplete();
      }
    });
    });
  }, legend);
}

export function pushBack(loser, winner){
  const dx = Math.sign(loser.x - winner.x) || 0;
  const dy = Math.sign(loser.y - winner.y) || 0;
  const nx = loser.x + dx, ny = loser.y + dy;
  if(inBounds(nx,ny) && !unitsAt(nx,ny).some(o=>o.side!==loser.side)){
    // shove any friendly unit already standing in the landing square one further step back
    const blocker = unitsAt(nx,ny).find(o=>o.side===loser.side && o.id!==loser.id);
    let landingClear = true;
    if(blocker){
      const bx = nx+dx, by = ny+dy;
      if(inBounds(bx,by) && unitsAt(bx,by).length===0){
        animateUnitTo(blocker, bx, by, 'pushback');   // shoved aside by the unit being pushed into it
        blocker.turnOnly = true;
        log(`${unitLabel(blocker)} is shoved back by the retreat.`, 'combat');
      } else {
        landingClear = false; // nowhere for the blocker to go — loser can't retreat into it either
      }
    }
    if(landingClear){ animateUnitTo(loser, nx, ny, 'pushback'); }
  } else if(!inBounds(nx,ny)){
    /* Back to the board edge with nowhere further to give. The house rule is that
       the unit bolts along its own edge rather than standing still.

       It used to pick a CORNER (x = 0 or COLS-1 depending on which half it was
       in) and then take the free cell nearest that corner along the whole
       twenty-wide edge row. A unit at (8,0) was therefore thrown to (0,0): eight
       tiles from a single one-margin pushback, which is four times a cavalry
       charge and further than any unit can move in a turn. Logged at T21, and it
       stranded 4e Ligne alone in the corner, disconnected from its Brigade, for
       the remaining fifty turns of the match.

       A pushback moves one square. It now slides one square ALONG the edge, away
       from the winner, and only if that square is blocked does it try the other
       direction. If both are blocked it stands its ground, which is the honest
       outcome for a unit with genuinely nowhere to go. */
    const along = Math.sign(loser.x - winner.x) || (loser.x < COLS/2 ? 1 : -1);
    const options = [loser.x + along, loser.x - along];
    let moved = false;
    for(const tx of options){
      if(tx < 0 || tx >= COLS) continue;
      if(unitsAt(tx, loser.y).some(o=>o.id!==loser.id)) continue;
      animateUnitTo(loser, tx, loser.y, 'pushback');
      log(`${unitLabel(loser)} has nowhere left to give and edges along the board edge.`, 'combat');
      moved = true;
      break;
    }
    if(!moved){
      log(`${unitLabel(loser)} is pinned against the board edge with nowhere to go.`, 'combat');
    }
  }
  loser.turnOnly = true;
  log(`${unitLabel(loser)} pushed back and turned around; can only turn around next turn.`, 'combat');
}

export function retreatAndRally(loser, onComplete){
  onComplete = onComplete || function(){};
  const brig = state.units.find(u=>!u.removed && u.side===loser.side && u.type==='BRIGADIER' && u.brigadeId===loser.brigadeId);
  const edgeY = loser.side===SIDES.RED ? ROWS-1 : 0;
  const preferredX = brig ? clamp(brig.x,0,COLS-1) : loser.x;
  const cell = findNearestFreeEdgeCell(edgeY, preferredX, loser.id);
  const routSteps = Math.max(Math.abs(cell.x-loser.x), Math.abs(cell.y-loser.y));

  /* THE RALLY IS ROLLED WHERE THE UNIT STANDS, and only a unit that rallies
     retreats.

     It used to retreat first and roll afterwards, so a unit that failed died at
     the board edge, several squares from the fight that broke it, with the skull
     and the death cry landing somewhere the player was not looking. Rolling on
     the spot puts the consequence where the fight was.

     It also removes the vanishing-retreat problem by construction rather than by
     timing. The retreat now runs AFTER the dice panel has closed, so there is no
     window in which it plays out behind an overlay. Two previous attempts tried
     to schedule around that overlap; this removes the overlap.

     A unit with nowhere to go (already on its edge, or the edge full) holds its
     square either way, and is turned about either way. */
  const nowhereToGo = (cell.x === loser.x && cell.y === loser.y);
  loser.turnOnly = true;
  loser.rallying = true;

  const t = UNIT_TYPES[loser.type];
  // House rule: Heavy Cavalry rallies on 3+ alongside Guard Infantry. The printed
  // ruleset (p.7) grants the easier rally to Guard Infantry only, but Heavy Cavalry
  // is meant to be the strongest piece on the board, so it gets the same standard.
  let successOn = [4,5,6];
  if(t.key==='GUARD' || t.key==='HEAVY_CAV') successOn = [3,4,5,6];
  if(t.key==='ARTILLERY') successOn = [5,6];
  const rallyNote = t.key==='GUARD' ? ['Guard Infantry: needs 3+']
    : t.key==='HEAVY_CAV' ? ['Heavy Cavalry: needs 3+']
    : t.key==='ARTILLERY' ? ['Artillery: needs 5+'] : [];

  presentRollTrigger([{label:'Rally', diceCount:1, notes:rallyNote}], loser.side, ()=>{
    const r = rollD6();
    const success = successOn.includes(r);
    /* The rally in full: the roll, the threshold and its reason, whether a
       Brigadier was in range and which one, and whether the Leadership Roll was
       still available. Only the outcome used to be recorded, so a poor rally
       record could not be told apart from Brigadiers being out of position. */
    logReplay('rally', {
      unitId: loser.id, side: loser.side, x: loser.x, y: loser.y,
      roll: r, threshold: successOn[0], success,
      brigadier: brig ? (brig.historicalName || 'Brigadier') : null,
      brigadierInRange: !!brig,
      leadershipAvailable: !!(brig && !brig.leadershipUsed),
      note: rallyNote[0] || null,
    });
    showDice([{label:'Rally', rolls:[r], keptValue:r, notes:rallyNote}], success ? 'Rallies!' : 'Fails to rally', success ? 'win' : 'lose', ()=>{
      if(success){
        logNarration('rally_success');
        if(nowhereToGo){
          log(`${unitLabel(loser)} is driven against the board edge with nowhere to go — ` +
              `it holds the square, turned about, and RALLIES (rolled ${r}).`, 'combat');
          logReplay('status', { unitId:loser.id, side:loser.side, x:loser.x, y:loser.y,
            newStatus:'HeldAtEdge', reason:'rallied with nowhere to retreat to' });
          onComplete();
          return;
        }
        /* ONLY NOW does it retreat, with the panel gone and nothing over the
           board: through square centres, above the map, below the ambient clouds
           and birds, in the same style as any other move. */
        log(`${unitLabel(loser)} RALLIES (rolled ${r}) and falls back to the board edge.`, 'combat');
        animateUnitTo(loser, cell.x, cell.y, 'rout');
        logReplay('status', { unitId:loser.id, side:loser.side, x:cell.x, y:cell.y, newStatus:'Rallied' });
        // Hand back only once the run has finished, so the next fight cannot open
        // a panel over a unit that is still moving.
        const runMs = FAST_ANIMATION_MODE ? 0 : Math.min(
          MOVE_PROFILES.rout.maxMs || Infinity,
          moveAnimationMs(Math.max(1, routSteps)) * MOVE_PROFILES.rout.speed) + 120;
        setTimeout(onComplete, runMs);
        return;
      }
      // Fails where it fought, not at the edge: the skull and the death cry land
      // on the square the player was already watching.
      log(`${unitLabel(loser)} fails to rally (rolled ${r}) and is lost where it stood.`, 'combat');
      if(brig && !brig.leadershipUsed){
        offerLeadershipRoll(loser, brig, onComplete);
      } else {
        logNarration('rally_failure');
        logReplay('status', { unitId:loser.id, side:loser.side, x:loser.x, y:loser.y, newStatus:'Lost' });
        removeUnit(loser, 'failed rally');
        onComplete();
      }
    });
  });
}

// Leadership Roll is one guaranteed save per Brigade for the whole match, so
// spending it on the first failed rally isn't automatically correct — it's
// worth asking (or, for the AI, weighing) whether THIS is the unit worth it.
export function offerLeadershipRoll(loser, brig, onComplete){
  onComplete = onComplete || function(){};
  const isHuman = !FAST_DICE_MODE && !(state.mode==='ai' && loser.side===state.aiSide);
  if(!isHuman){
    const useIt = aiDecideLeadershipRoll(loser, brig);
    applyLeadershipRollChoice(loser, brig, useIt, onComplete);
    return;
  }
  document.getElementById('overlayTitle').textContent = 'Use Leadership Roll?';
  document.getElementById('overlayText').innerHTML =
    `${unitLabel(loser)} has failed to rally and will be removed unless you spend ${unitLabel(brig)}'s Leadership Roll — one guaranteed save for the whole match, for any unit in this Brigade. Use it now?`;
  document.getElementById('overlayBtn').style.display = 'none';
  const canvas = document.getElementById('rotationPreviewCanvas');
  if(canvas) canvas.style.display = 'none';
  let extra = document.getElementById('modeChoices');
  extra.innerHTML = '';
  extra.style.display = 'flex';
  const yesBtn = document.createElement('button');
  yesBtn.className = 'primary';
  yesBtn.textContent = 'Use Leadership Roll';
  yesBtn.onclick = ()=>{ extra.style.display='none'; document.getElementById('overlay').classList.remove('show'); applyLeadershipRollChoice(loser, brig, true, onComplete); };
  const noBtn = document.createElement('button');
  noBtn.textContent = 'Let the Unit Go';
  noBtn.onclick = ()=>{ extra.style.display='none'; document.getElementById('overlay').classList.remove('show'); applyLeadershipRollChoice(loser, brig, false, onComplete); };
  extra.appendChild(yesBtn);
  extra.appendChild(noBtn);
  document.getElementById('overlay').classList.add('show');
}

export function applyLeadershipRollChoice(loser, brig, useIt, onComplete){
  onComplete = onComplete || function(){};
  if(useIt){
    brig.leadershipUsed = true;
    log(`${unitLabel(loser)} fails to rally, but ${unitLabel(brig)}'s Leadership Roll guarantees it — saved! (one-time use, now spent)`, 'combat');
    logNarration('rally_success');
  } else {
    log(`${unitLabel(loser)} is removed from the field.`, 'combat');
    logNarration('rally_failure');
    removeUnit(loser, 'failed rally');
  }
  onComplete();
}

// AI heuristic: save the unit if its Brigade is already close to breaking (this
// loss would matter a lot) or if the unit itself is high-value (Guard, Heavy
// Cavalry, Artillery) — otherwise bank the Leadership Roll for later.
export function aiDecideLeadershipRoll(loser, brig){
  const remaining = state.units.filter(o=>!o.removed && o.side===loser.side && o.brigadeId===loser.brigadeId && o.type!=='BRIGADIER').length;
  const closeToBreaking = remaining<=2; // includes the loser itself, not yet removed
  const highValue = AI_UNIT_VALUE[loser.type] >= 5;
  return closeToBreaking || highValue;
}

export function findNearestFreeEdgeCell(edgeY, preferredX, excludeId){
  let candidates = [];
  for(let x=0;x<COLS;x++){
    if(unitsAt(x,edgeY).some(o=>o.id!==excludeId)) continue;
    candidates.push({x, y:edgeY, dist: Math.abs(x-preferredX)});
  }
  if(candidates.length===0) return {x:clamp(preferredX,0,COLS-1), y:edgeY}; // edge is full — fall back to overlap rather than throw
  candidates.sort((a,b)=>a.dist-b.dist);
  return candidates[0];
}

export function clamp(v,min,max){ return Math.max(min,Math.min(max,v)); }

export function removeUnit(u, reason){
  u.removed = true;
  logReplay('status', { unitId:u.id, side:u.side, x:u.x, y:u.y, newStatus:'Destroyed', reason });
  addDeathEffect(u.x, u.y);
  log(`${unitLabel(u)} (${SIDE_LABEL[u.side]}) removed: ${reason}.`, 'system');
  if(u.type!=='BRIGADIER'){
    const brig = state.units.find(o=>!o.removed && o.side===u.side && o.brigadeId===u.brigadeId && o.type==='BRIGADIER');
    if(brig){
      const remaining = state.units.filter(o=>!o.removed && o.side===u.side && o.brigadeId===u.brigadeId && o.type!=='BRIGADIER');
      if(remaining.length===0){
        brig.removed = true; // withdraws, not killed — no death effect for a non-combat unit
        log(`${unitLabel(brig)} (${SIDE_LABEL[brig.side]}) withdraws — the Brigade is broken.`, 'system');
      }
    }
  }
  checkWinCondition();
  renderBrigadeStatus();
}

export function checkWinCondition(){
  if(state.replaying) return;
  if(state.scenario){ checkScenarioObjective(); return; }
  for(const side of [SIDES.RED, SIDES.BLUE]){
    let brokenCount = 0;
    for(let bId=0; bId<3; bId++){
      const group = state.units.filter(u=>u.side===side && u.brigadeId===bId);
      if(group.length===0) continue;
      const remaining = group.filter(u=>!u.removed && u.type!=='BRIGADIER');
      if(remaining.length===0) brokenCount++;
    }
    if(brokenCount>=2){
      const winner = side===SIDES.RED ? SIDES.BLUE : SIDES.RED;
      endGame(winner);
      return;
    }
  }
}

