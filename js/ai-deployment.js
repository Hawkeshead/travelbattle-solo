import { AI_UNIT_VALUE, terrainSeekBonus } from './ai-tactics.js';
import { COLS, ROWS, SIDES, TB_DATA, state } from './data-core.js';
import { isRoadLike, terrainAt, unitsAt } from './engine-rules.js';
import { confirmCurrentBrigade, placeUnit, sideFullyDeployed } from './ui-deployment.js';

/* =========================================================
   AI: DEPLOYMENT
   One formation plan per Brigade, each anchored to its own column
   band so every Brigade starts as its own connected cluster.
   Front = the row of the AI's 2-row zone closer to the enemy.
========================================================= */
// Hard difficulty only — same three zones the static plan used (roughly matching
// BRIGADE_COMPOSITIONS' order), but cell choice within a zone is terrain-scored
// rather than a fixed column. Easy/Medium keep the exact original static plan below.
export const HARD_DEPLOY_COL_BANDS = [[0,6],[7,13],[14,19]];

/* WHICH BAND A BRIGADE DEPLOYS INTO.

   The bands are fixed left, centre, right, and brigade 0 always took the left
   one. So the AI could correctly spot a weak enemy flank, correctly counter-pick
   an army to punish it, and then deploy its heaviest brigade at the other end of
   the board because that is where index 0 happens to sit.

   Detecting the weakness and then attacking the strong flank is worse than not
   detecting it at all: it commits the counter-pick's weight in the wrong place.
   When a weak flank has been identified, the bands are ordered so that BRIGADE 0
   — the one the templates load heaviest — faces it, and the rest fill in from
   the other end.

   _aiTargetFlankX is the average column of the enemy's weakest brigade, set by
   pickCounterArmy. Absent (deploying first, or no clear weakness), the fixed
   left-to-right order stands. */
export function deployBandFor(bIdx){
  const bands = HARD_DEPLOY_COL_BANDS;
  const targetX = state._aiTargetFlankX;
  if(typeof targetX !== 'number') return bands[bIdx] || [0, COLS-1];
  // Order the bands by how near each is to the enemy's weak point.
  const mid = b => (b[0] + b[1]) / 2;
  const ordered = bands.slice().sort((a,b)=> Math.abs(mid(a)-targetX) - Math.abs(mid(b)-targetX));
  return ordered[bIdx] || bands[bIdx] || [0, COLS-1];
}

export function scoreDeployCell(typeKey, x, y, side, bIdx){
  const terr = terrainAt(x,y);
  if(terr.restrictTo && !terr.restrictTo.includes(typeKey)) return -Infinity;
  if(unitsAt(x,y).length>0) return -Infinity;
  let score = terrainSeekBonus(typeKey, x, y);
  if(typeKey==='ARTILLERY' && terr.key==='HILL') score += 0.4; // elevation for the guns specifically, Section 10
  if((typeKey==='HEAVY_CAV'||typeKey==='LIGHT_CAV') && terr.isRoad) score += 0.3; // faster manoeuvre off the start line
  // Cohesion: strongly favour landing adjacent to an already-placed unit of the
  // same Brigade, so the Brigade actually forms one connected cluster as it's
  // deployed, rather than each unit independently chasing the best terrain
  // anywhere in its (up to 7-column-wide) band. Without this, a unit placed
  // several columns from its Brigadier with nothing chaining them together is
  // disconnected from turn one — and a disconnected unit can't move at all
  // (see movableUnitsForSide), so it stays stuck and useless the entire match.
  if(side !== undefined && bIdx !== undefined){
    const mates = state.units.filter(u=>!u.removed && u.side===side && u.brigadeId===bIdx);
    if(mates.length > 0){
      const nearestDist = Math.min(...mates.map(m => Math.max(Math.abs(m.x-x), Math.abs(m.y-y))));
      score += nearestDist <= 1 ? 2.0 : -1.2*(nearestDist-1); // adjacency beats any plausible terrain bonus; every extra square costs more than one
    }
  }
  return score;
}

export function findBestHardDeployCell(zoneRows, colRange, typeKey, side, bIdx){
  let best=null, bestScore=-Infinity;
  for(const y of zoneRows){
    for(let x=colRange[0]; x<=colRange[1]; x++){
      const s = scoreDeployCell(typeKey, x, y, side, bIdx) + Math.random()*0.05;
      if(s>bestScore && s>-Infinity){ bestScore=s; best={x,y}; }
    }
  }
  return best;
}

export function placeHardDeployUnit(side, typeKey, bIdx, forceBack){
  const deployRows = state.boardMode==='grand' ? 3 : 2;
  const frontRow = side===SIDES.RED ? ROWS-deployRows : deployRows-1;   // row nearest the enemy
  const backRows = side===SIDES.RED                                     // remaining row(s), furthest from the enemy
    ? Array.from({length: deployRows-1}, (_,i)=>ROWS-deployRows+1+i)
    : Array.from({length: deployRows-1}, (_,i)=>deployRows-2-i);
  // forceBack lets an explicit army-composition template (see deployArmyComposition)
  // override the default "only Brigadier/Artillery go in the back" rule with its
  // own front/back rank per unit — undefined keeps today's default behaviour.
  const isBack = forceBack !== undefined ? forceBack : (typeKey==='BRIGADIER' || typeKey==='ARTILLERY');
  const colBand = deployBandFor(bIdx);
  let cell = findBestHardDeployCell(isBack?backRows:[frontRow], colBand, typeKey, side, bIdx)
    || findBestHardDeployCell([frontRow, ...backRows], colBand, typeKey, side, bIdx)
    || findNearestFreeDeployCell(side, (colBand[0]+colBand[1])/2, isBack?backRows[0]:frontRow, typeKey);
  placeUnit(side, typeKey, cell.x, cell.y);
}

// Manoeuvre: whoever deploys second in a Brigade genuinely sees more of the
// board than whoever went first — that's not a bug to work around, it's the
// actual tactical edge of deploying last, and it's only fair to let the AI
// use it when it's genuinely earned, not fabricate a read on an army it
// hasn't actually seen yet. Called only once the human side has at least one
// full Brigade confirmed; the caller falls back to a plain random pick
// otherwise. The three signals mirror real rock-paper-scissors relationships
// between the six named Armies rather than picking the "best" Army outright:
// a cavalry-heavy human deployment gets answered with an Infantry/Guard
// anchor that can form Square and shrug off a charge; a visibly asymmetric,
// thin-flanked deployment gets answered with something fast enough to punish
// the weak side before it can be covered; a generic/balanced deployment gets
// no strong read either way, so it's answered with independent firepower
// rather than a guess.
/* WHICH ARMY TO BRING, AND WHERE TO PUT ITS WEIGHT.

   Two situations, and they call for opposite reasoning.

   DEPLOYING FIRST, the AI is showing its hand: whatever it puts down, the player
   then picks an army specifically to beat it. So it should not gamble on a
   lopsided composition it cannot defend. It reads the ground instead and takes
   the army that suits it, playing for a position that is awkward to attack
   rather than one built to attack something it has not seen yet.

   DEPLOYING SECOND, it has the whole enemy army in front of it and should pick
   to beat that specific army. A weak flank is the prize: two brigades broken
   wins the game, so an easy first break is worth more than a general advantage.

   Previously the first case picked at RANDOM from six armies with no reference
   to the board at all, and the second detected a weak flank but not WHICH SIDE
   it was on, so it could counter-pick a cavalry wing and then deploy it against
   the enemy's strongest brigade.
========================================================= */

/* What the ground rewards. Defensive terrain in a side's own half means an army
   that can hold; open ground with roads means one that can move. */
function readGround(side){
  const rows = side === SIDES.RED
    ? [ROWS-3, ROWS-2, ROWS-1]
    : [0, 1, 2];
  let defensive = 0, open = 0, roads = 0;
  for(const y of rows){
    for(let x = 0; x < COLS; x++){
      const terr = terrainAt(x, y);
      if(terr.defenseBonus || terr.elevation > 0) defensive++;
      else open++;
      if(isRoadLike(terr)) roads++;
    }
  }
  return { defensive, open, roads, total: rows.length * COLS };
}

/* Which half of the board an army's heaviest brigade should face. Returns the
   column range the AI wants its strongest brigade deployed against. */
export function weakestEnemyFlank(humanSide){
  const units = state.units.filter(u=>!u.removed && u.side===humanSide && u.type!=='BRIGADIER');
  if(units.length === 0) return null;
  const byBrigade = {};
  for(const u of units){
    (byBrigade[u.brigadeId] = byBrigade[u.brigadeId] || []).push(u);
  }
  let weakest = null;
  for(const [bId, list] of Object.entries(byBrigade)){
    // Fighting strength, not headcount: two Guard is not two line infantry.
    const strength = list.reduce((sum,u)=> sum + (AI_UNIT_VALUE[u.type] || 3), 0);
    const avgX = list.reduce((sum,u)=> sum + u.x, 0) / list.length;
    if(!weakest || strength < weakest.strength) weakest = { bId, strength, avgX, size: list.length };
  }
  return weakest;
}

function pickCounterArmy(humanSide){
  const humanUnits = state.units.filter(u=>!u.removed && u.side===humanSide && u.type!=='BRIGADIER');
  if(humanUnits.length === 0) return null;

  const cavCount = humanUnits.filter(u=>u.type==='HEAVY_CAV'||u.type==='LIGHT_CAV').length;
  if(cavCount / humanUnits.length >= 0.35){
    return Math.random()<0.5 ? 'grand_assault' : 'refused_flank';
  }

  const byBrigade = {};
  for(const u of humanUnits) byBrigade[u.brigadeId] = (byBrigade[u.brigadeId]||0) + 1;
  const counts = Object.values(byBrigade);
  const hasWeakFlank = counts.length >= 2 && Math.min(...counts) <= 2 && Math.max(...counts) >= 5;
  if(hasWeakFlank){
    /* Remember WHICH SIDE it is on, so the AI's own heaviest brigade is deployed
       opposite it rather than wherever the template happens to put it.

       Detecting a weak flank and then attacking the enemy's strong one is worse
       than not detecting it: it commits the counter-pick's weight in the wrong
       place. Two brigades broken wins the game, so an easy first break is the
       single most valuable thing on the board and it is worth aiming at. */
    const weak = weakestEnemyFlank(humanSide);
    if(weak) state._aiTargetFlankX = weak.avgX;
    return Math.random()<0.5 ? 'vanguard' : 'cavalry_wing';
  }

  return Math.random()<0.5 ? 'twin_batteries' : 'balanced';
}

/* DEPLOYING FIRST: read the ground and take the army that suits it.

   The player will see this and pick specifically to beat it, so a lopsided
   composition is a gift. The AI plays instead for a position that is awkward to
   attack.

   Defensive ground (buildings, hills) rewards holding, so twin_batteries: guns
   on good ground with infantry to screen them are miserable to assault. Open
   ground with roads rewards movement, so cavalry_wing, which can punish an
   attacker who commits across it. Anything between takes balanced, which has no
   exploitable weakness.

   refused_flank is never chosen here on purpose: its 2-unit brigade is exactly
   what pickCounterArmy hunts for below, and offering one to a player who picks
   next would be handing over an easy first break, and with it the game. */
function pickGroundSuitedArmy(side){
  const g = readGround(side);
  const defensiveShare = g.defensive / g.total;
  const roadShare = g.roads / g.total;
  if(defensiveShare >= 0.25) return 'twin_batteries';
  if(roadShare >= 0.30 && defensiveShare < 0.15) return 'cavalry_wing';
  return 'balanced';
}

export function aiDeployStepHard(side){
  const bIdx = state.deployBrigadeIndex[side];
  if(!state.currentBrigadeHasBrigadier[side]){
    placeHardDeployUnit(side, 'BRIGADIER', bIdx);
    return;
  }
  const store = (state._aiHardDeployRemaining || (state._aiHardDeployRemaining = {red:{}, blue:{}}))[side];
  if(!store[bIdx]){
    store[bIdx] = {};
    // Which Army this side uses is decided once per match, not once per Brigade —
    // a real commander doesn't reinvent the army's whole shape between Brigades.
    // Grand Strategy's doubled roster keeps its own existing standard/cavalry-
    // focused split (data/army-compositions.json is sized for the standard
    // 17-unit army only); a standard match instead picks randomly from the same
    // six named Armies a human can choose from — one shared system for both,
    // each with its own explicit front/back rank per unit rather than the old
    // blanket "only Brigadier/Artillery go in the back" rule.
    const isGrand = state.boardMode==='grand';
    if(isGrand){
      const choices = (state._aiCompositionChoice || (state._aiCompositionChoice = {red:null, blue:null}));
      if(choices[side] === null) choices[side] = Math.random() < (1/3) ? 'cavalryFocused' : 'standard';
      const compositions = choices[side]==='cavalryFocused' ? TB_DATA.unitTypes.brigadeCompositionsCavalryFocusedGrand : TB_DATA.unitTypes.brigadeCompositionsGrand;
      for(const ty of (compositions[bIdx]||[])) if(ty!=='BRIGADIER') store[bIdx][ty] = (store[bIdx][ty]||0)+1;
    } else {
      const choices = (state._aiArmyChoice || (state._aiArmyChoice = {red:null, blue:null}));
      if(!choices[side]){
        const humanSide = side===SIDES.RED ? SIDES.BLUE : SIDES.RED;
        const otherIsHuman = !(state.mode==='ai' && humanSide===state.aiSide);
        /* Deploying SECOND (enemy units already on the board): counter-pick against
           what is actually there. Deploying FIRST: read the ground instead.
        
           The random fallback is gone. It only ever applied when the AI deployed
           first, which is exactly the case where a lopsided army is most dangerous
           to itself: it could hand the player a refused_flank, whose 2-unit brigade
           is the very thing the AI's own counter-pick hunts for. */
        const enemyIsDown = state.units.some(u=>!u.removed && u.side===humanSide && u.type!=='BRIGADIER');
        const counterPick = (otherIsHuman && enemyIsDown) ? pickCounterArmy(humanSide) : null;
        choices[side] = counterPick || pickGroundSuitedArmy(side);
      }
      const army = TB_DATA.armyCompositions.find(a=>a.id===choices[side]);
      const brig = army && army.brigades[bIdx];
      store[bIdx] = brig ? brig.units.slice() : [];
    }
  }
  const remaining = store[bIdx];
  if(Array.isArray(remaining)){
    // Standard-mode ordered list ({type, rank} entries) — placed in the
    // template's own order so front-rank units land before back-rank ones.
    const nextIdx = remaining.findIndex(entry => state.deployPool[side].includes(entry.type));
    if(nextIdx === -1){ confirmCurrentBrigade(); return; }
    const [entry] = remaining.splice(nextIdx, 1);
    placeHardDeployUnit(side, entry.type, bIdx, entry.rank!=='front');
    return;
  }
  // Grand Strategy's unordered count map, unchanged from before.
  const nextType = Object.keys(remaining).find(ty=>remaining[ty]>0 && state.deployPool[side].includes(ty));
  if(!nextType){ confirmCurrentBrigade(); return; }
  remaining[nextType]--;
  placeHardDeployUnit(side, nextType, bIdx);
}

export const AI_DEPLOY_PLANS = TB_DATA.unitTypes.aiDeployPlans;

export function aiDeployStep(){
  const side = state.aiSide;
  if(sideFullyDeployed(side)) return;
  if(state.aiDifficulty==='hard'){ aiDeployStepHard(side); return; }
  const bIdx = state.deployBrigadeIndex[side];
  const plan = AI_DEPLOY_PLANS[bIdx];

  // Brigadier must go first, same as the human flow requires
  if(!state.currentBrigadeHasBrigadier[side]){
    const brigEntry = plan.find(p=>p.type==='BRIGADIER');
    placeAiPlanEntry(side, brigEntry);
    return;
  }

  const usedPlanEntries = (state._aiPlanUsed || (state._aiPlanUsed = {red:new Set(), blue:new Set()}))[side];
  const remainingPlanEntries = plan.filter(p => p.type!=='BRIGADIER' && !usedPlanEntries.has(p) && state.deployPool[side].includes(p.type));

  if(remainingPlanEntries.length===0){
    confirmCurrentBrigade();
    return;
  }

  placeAiPlanEntry(side, remainingPlanEntries[0]);
}

export function placeAiPlanEntry(side, planEntry){
  const usedPlanEntries = (state._aiPlanUsed || (state._aiPlanUsed = {red:new Set(), blue:new Set()}))[side];
  usedPlanEntries.add(planEntry);
  const frontRow = side===SIDES.RED ? ROWS-2 : 1;
  const backRow  = side===SIDES.RED ? ROWS-1 : 0;
  const targetRow = planEntry.front ? frontRow : backRow;
  const cell = findNearestFreeDeployCell(side, planEntry.col, targetRow, planEntry.type);
  placeUnit(side, planEntry.type, cell.x, cell.y);
}

// A full named Army — three Brigades' worth of units, each with an explicit
// front/back rank — placed onto the actual board in one pass. This is the
// human-facing "auto-deploy" shortcut; it shares placeHardDeployUnit with the
// AI's own use of the same Army data, so a human picking "Army B" and the AI
// randomly rolling "Army B" can never end up placed differently.
export function deployArmyComposition(side, armyId){
  const army = TB_DATA.armyCompositions.find(a => a.id === armyId);
  if(!army) return false;
  state._suppressArmyPicker = true; // this loop's own confirmCurrentBrigade() calls momentarily flip deployTurn to the other side between Brigades — without this, that could flash open the OTHER side's picker mid-loop in a hotseat match before this loop forces the turn back
  for(const brig of army.brigades){
    state.deployTurn = side; // deployment normally alternates sides per Brigade — this places all of THIS side's Brigades in one go, so it must hold the turn itself throughout
    const bIdx = state.deployBrigadeIndex[side];
    placeHardDeployUnit(side, 'BRIGADIER', bIdx);
    for(const entry of brig.units){
      placeHardDeployUnit(side, entry.type, bIdx, entry.rank !== 'front');
    }
    confirmCurrentBrigade();
  }
  state._suppressArmyPicker = false;
  return true;
}

export function findNearestFreeDeployCell(side, col, row, typeKey){
  const deployRows = state.boardMode==='grand' ? 3 : 2;
  const zoneRows = side===SIDES.RED
    ? Array.from({length: deployRows}, (_,i)=>ROWS-deployRows+i)
    : Array.from({length: deployRows}, (_,i)=>i);
  const candidates = [];
  for(const y of zoneRows){
    for(let x=0;x<COLS;x++){
      const terr = terrainAt(x,y);
      if(terr.restrictTo && !terr.restrictTo.includes(typeKey)) continue;
      if(unitsAt(x,y).length>0) continue;
      const dist = Math.abs(x-col) + Math.abs(y-row)*0.5;
      candidates.push({x,y,dist});
    }
  }
  candidates.sort((a,b)=>a.dist-b.dist);
  return candidates[0] || {x:col,y:row};
}

