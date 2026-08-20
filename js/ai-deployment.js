import { terrainSeekBonus } from './ai-tactics.js';
import { COLS, ROWS, SIDES, TB_DATA, state } from './data-core.js';
import { terrainAt, unitsAt } from './engine-rules.js';
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
  const colBand = HARD_DEPLOY_COL_BANDS[bIdx] || [0, COLS-1];
  let cell = findBestHardDeployCell(isBack?backRows:[frontRow], colBand, typeKey, side, bIdx)
    || findBestHardDeployCell([frontRow, ...backRows], colBand, typeKey, side, bIdx)
    || findNearestFreeDeployCell(side, (colBand[0]+colBand[1])/2, isBack?backRows[0]:frontRow, typeKey);
  placeUnit(side, typeKey, cell.x, cell.y);
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
        const armies = TB_DATA.armyCompositions;
        choices[side] = armies[Math.floor(Math.random()*armies.length)].id;
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

