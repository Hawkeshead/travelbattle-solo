import { AI_UNIT_VALUE } from './ai-tactics.js';
import { COLS, ROWS, SIDES, SIDE_LABEL, TERRAIN, UNIT_TYPES, state } from './data-core.js';
import { FAST_DICE_MODE, finishDice, presentRollTrigger, refreshDiceFrame, showDice, showDiceRerollButton } from './dice.js';
import { checkScenarioObjective, endGame } from './engine-objectives.js';
import { log, logNarration, logReplay } from './engine-state.js';
import { addDeathEffect, animateUnitTo, showActionLine } from './render-board.js';
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
    if(u.hidden && terrainAt(u.x,u.y).key!=='WOODS') u.hidden = false;
  }
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

  const dist = new Map();
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
        const canDouble = terr.allowDouble && (t.key==='INFANTRY'||t.key==='GUARD') && occ.every(o=>UNIT_TYPES[o.type].key==='INFANTRY'||UNIT_TYPES[o.type].key==='GUARD') && occ.length<2;
        if(!canDouble) continue;
      }
      dist.set(key, nd);
      queue.push({x:n.x,y:n.y,d:nd});
    }
  }

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
export function rollD6(){ return 1+Math.floor(Math.random()*6); }
export function rollBest(n){ let best=0; const all=[]; for(let i=0;i<n;i++){const r=rollD6(); all.push(r); if(r>best) best=r;} return {value:best, rolls:all}; }

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

  const eligibleDefender = t.key==='INFANTRY' || t.key==='GUARD' || t.key==='ARTILLERY';
  // A unit that sprang a Woodland Ambush this round gets no woods defence bonus until its side's next turn.
  const ambushSuppressed = terr.key==='WOODS' && unit.ambushSpentThisRound;
  if(defending && terr.defenseBonus && eligibleDefender && !ambushSuppressed){
    sources.push(terr.key==='WOODS' ? 'Defending in woods' : 'Defending in a building');
  }
  if(oppT.isCavalry && (t.key==='INFANTRY'||t.key==='GUARD') && unit.formation==='square'){
    sources.push('Square vs Cavalry');
  }
  // Cavalry fighting Infantry/Guard not in Square rolls a second die, regardless of
  // whether the Cavalry is attacking or defending (ruleset makes no attacker-only
  // distinction here).
  if(t.isCavalry && (oppT.key==='INFANTRY'||oppT.key==='GUARD') && opponent.formation!=='square'){
    sources.push('Cavalry vs non-Square Infantry');
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
  return { dice, valueBonus, reasons };
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
      {label:aLabel, rolls:aRoll.rolls, keptValue:aRoll.value, notes:aReasons},
      {label:dLabel, rolls:dRoll.rolls, keptValue:dRoll.value, notes:dReasons}
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
  roll.rolls.push(newVal);
  roll.value = Math.min(6, newVal + valueBonus);
  reasons.push(`Re-roll (Guard/Hvy Cav): re-rolled to ${newVal}`);
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
  // result of 4) gives the attacker +1 to their rolled value (capped at 6) if
  // struck while in that state — same phrasing/mechanic as the Ambush bonus.
  let aValueBonus = aBonus.valueBonus, dValueBonus = dBonus.valueBonus;
  if(defender.turnOnly){ aValueBonus += 1; aReasons.push('Defender turned around: +1 to roll'); }
  if(ambushMode){ aValueBonus += 1; aReasons.push('Ambush: +1 to roll (capped at 6)'); }
  // Infantry, Guard, and Cavalry all get +1 to the roll when attacking Artillery.
  if((aType.key==='INFANTRY'||aType.key==='GUARD'||aType.isCavalry) && dType.key==='ARTILLERY'){
    aValueBonus += 1; aReasons.push('Attacking Artillery: +1 to roll');
  }

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
    let resultText, resultCls;
    if(genuineDraw){ resultText = 'Drawn — continues next turn'; resultCls = 'draw'; }
    else if(defenderHillTieWin){ resultText = `${dName} holds the high ground`; resultCls = 'win'; }
    else if(attackerChargeTieWin){ resultText = `${aName}'s charge carries the tie`; resultCls = 'win'; }
    else if(attackerColumnTieWin){ resultText = `${aName}'s Column carries the tie`; resultCls = 'win'; }
    else if(aVal > dVal){ resultText = `${aName} wins by ${aVal-dVal}`; resultCls = 'win'; }
    else { resultText = `${dName} wins by ${dVal-aVal}`; resultCls = 'win'; }
    return { resultText, resultCls, genuineDraw, defenderHillTieWin, attackerChargeTieWin, attackerColumnTieWin };
  }

  presentRollTrigger([
    {label:aName, diceCount:aDice, notes:aReasons},
    {label:dName, diceCount:dDice, notes:dReasons}
  ], attacker.side, ()=>{
    const aRoll = rollBest(aDice);
    const dRoll = rollBest(dDice);
    if(aValueBonus) aRoll.value = Math.min(6, aRoll.value + aValueBonus);
    if(dValueBonus) dRoll.value = Math.min(6, dRoll.value + dValueBonus);

    // Show the actual roll immediately — held open rather than auto-fading —
    // so it's genuinely visible before any re-roll decision is asked for. Uses
    // the exact same result phrasing as the final settle below (not a
    // placeholder "X leads"), recomputed here since the tie-break rules
    // (Charge/Column/Hill) can only be evaluated once real values exist.
    const interim = computeFightResult(aRoll.value, dRoll.value);
    showDice([
      {label:aName, rolls:aRoll.rolls, keptValue:aRoll.value, notes:aReasons},
      {label:dName, rolls:dRoll.rolls, keptValue:dRoll.value, notes:dReasons}
    ], interim.resultText, interim.resultCls, null, true);

    offerCombatReroll(attacker, defender, aRoll, dRoll, aReasons, dReasons, aValueBonus, dValueBonus, ()=>{
    const final = computeFightResult(aRoll.value, dRoll.value);
    const { resultText, resultCls, genuineDraw, defenderHillTieWin, attackerChargeTieWin, attackerColumnTieWin } = final;
    if(defenderHillTieWin) dReasons.push('Tie-win: Hill defence');
    else if(attackerChargeTieWin) aReasons.push('Tie-win: Charge');
    else if(attackerColumnTieWin) aReasons.push('Tie-win: Attack Column');

    refreshDiceFrame([
      {label:aName, rolls:aRoll.rolls, keptValue:aRoll.value, notes:aReasons},
      {label:dName, rolls:dRoll.rolls, keptValue:dRoll.value, notes:dReasons}
    ], resultText, resultCls);
    finishDice(()=>{
      // Deferred until the popup has fully faded — nothing on the board moves
      // while there are still dice on screen to read.
      attacker.charged = false; // spent, win or lose — a charge is a one-shot burst of momentum

      const fightOutcome = genuineDraw ? 'stalemate'
        : (defenderHillTieWin || attackerChargeTieWin || attackerColumnTieWin) ? 'pushback'
        : (Math.abs(aRoll.value-dRoll.value)>=3 ? 'destroy' : Math.abs(aRoll.value-dRoll.value)===2 ? 'rout' : 'pushback');
      logReplay('fight', {
        attackerId: attacker.id, defenderId: defender.id,
        attackerSide: attacker.side, defenderSide: defender.side,
        x: defender.x, y: defender.y, result: fightOutcome,
        aRoll: aRoll.value, dRoll: dRoll.value
      });

      if(genuineDraw){
        log(`${aType.label} vs ${dType.label}: ${aRoll.value}-${dRoll.value}, drawn — fight continues next turn.`, 'combat');
        logNarration('melee_stalemate');
        onComplete();
        return;
      }
      if(defenderHillTieWin){
        log(`${dType.label} holds the high ground against ${aType.label}: ${aRoll.value}-${dRoll.value} tie goes to the defender.`, 'combat');
        logNarration('melee_pushback', 'loss');
        pushBack(attacker, defender);
        onComplete();
        return;
      }
      if(attackerChargeTieWin || attackerColumnTieWin){
        const reason = attackerChargeTieWin ? 'a clean charge' : 'a Column formation';
        log(`${aType.label}'s ${reason} carries the ${aRoll.value}-${dRoll.value} tie against ${dType.label}.`, 'combat');
        logNarration('melee_pushback', 'win');
        pushBack(defender, attacker);
        onComplete();
        return;
      }
      const winnerIsAttacker = aRoll.value > dRoll.value;
      const winner = winnerIsAttacker ? attacker : defender;
      const loser = winnerIsAttacker ? defender : attacker;
      const diff = Math.abs(aRoll.value - dRoll.value);
      log(`${unitLabel(attacker)} (${SIDE_LABEL[attacker.side]}) vs ${unitLabel(defender)} (${SIDE_LABEL[defender.side]}): ${aRoll.value}-${dRoll.value}. ${unitLabel(loser)} of ${SIDE_LABEL[loser.side]} takes the worse of it.`, 'combat');

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
        if(columnPartner) removeUnit(columnPartner, 'Column broken alongside its partner');
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
        animateUnitTo(blocker, bx, by);
        blocker.turnOnly = true;
        log(`${unitLabel(blocker)} is shoved back by the retreat.`, 'combat');
      } else {
        landingClear = false; // nowhere for the blocker to go — loser can't retreat into it either
      }
    }
    if(landingClear){ animateUnitTo(loser, nx, ny); }
  } else if(!inBounds(nx,ny)){
    // Already at the board edge with nowhere further to go — house rule: run to the
    // nearest corner of its own edge instead of simply standing in place.
    const edgeY = loser.side===SIDES.RED ? ROWS-1 : 0;
    const preferredCornerX = loser.x < COLS/2 ? 0 : COLS-1;
    const corner = findNearestFreeEdgeCell(edgeY, preferredCornerX, loser.id);
    if(corner && (corner.x!==loser.x || corner.y!==loser.y)){
      animateUnitTo(loser, corner.x, corner.y);
      log(`${unitLabel(loser)} has nowhere left to give and bolts for the corner.`, 'combat');
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
  animateUnitTo(loser, cell.x, cell.y);
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
    showDice([{label:'Rally', rolls:[r], keptValue:r, notes:rallyNote}], success ? 'Rallies!' : 'Fails to rally', success ? 'win' : 'lose', ()=>{
      if(success){
        log(`${unitLabel(loser)} falls back to the board edge and RALLIES (rolled ${r}).`, 'combat');
        logNarration('rally_success');
        logReplay('status', { unitId:loser.id, side:loser.side, x:loser.x, y:loser.y, newStatus:'Rallied' });
        onComplete();
        return;
      }
      log(`${unitLabel(loser)} fails to rally (rolled ${r}).`, 'combat');
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

