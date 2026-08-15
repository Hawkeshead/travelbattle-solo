import { terrainSeekBonus } from './ai-tactics.js';
import { BRIGADE_COMPOSITIONS, COLS, ROWS, SIDES, TB_DATA, state } from './data-core.js';
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

export function scoreDeployCell(typeKey, x, y){
  const terr = terrainAt(x,y);
  if(terr.restrictTo && !terr.restrictTo.includes(typeKey)) return -Infinity;
  if(unitsAt(x,y).length>0) return -Infinity;
  let score = terrainSeekBonus(typeKey, x, y);
  if(typeKey==='ARTILLERY' && terr.key==='HILL') score += 0.4; // elevation for the guns specifically, Section 10
  if((typeKey==='HEAVY_CAV'||typeKey==='LIGHT_CAV') && terr.isRoad) score += 0.3; // faster manoeuvre off the start line
  return score;
}

export function findBestHardDeployCell(zoneRows, colRange, typeKey){
  let best=null, bestScore=-Infinity;
  for(const y of zoneRows){
    for(let x=colRange[0]; x<=colRange[1]; x++){
      const s = scoreDeployCell(typeKey, x, y) + Math.random()*0.05;
      if(s>bestScore && s>-Infinity){ bestScore=s; best={x,y}; }
    }
  }
  return best;
}

export function placeHardDeployUnit(side, typeKey, bIdx){
  const deployRows = state.boardMode==='grand' ? 3 : 2;
  const frontRow = side===SIDES.RED ? ROWS-deployRows : deployRows-1;   // row nearest the enemy
  const backRows = side===SIDES.RED                                     // remaining row(s), furthest from the enemy
    ? Array.from({length: deployRows-1}, (_,i)=>ROWS-deployRows+1+i)
    : Array.from({length: deployRows-1}, (_,i)=>deployRows-2-i);
  const isBack = typeKey==='BRIGADIER' || typeKey==='ARTILLERY';
  const colBand = HARD_DEPLOY_COL_BANDS[bIdx] || [0, COLS-1];
  let cell = findBestHardDeployCell(isBack?backRows:[frontRow], colBand, typeKey)
    || findBestHardDeployCell([frontRow, ...backRows], colBand, typeKey)
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
    const compositions = state.boardMode==='grand' ? TB_DATA.unitTypes.brigadeCompositionsGrand : BRIGADE_COMPOSITIONS;
    for(const ty of (compositions[bIdx]||[])) if(ty!=='BRIGADIER') store[bIdx][ty] = (store[bIdx][ty]||0)+1;
  }
  const remaining = store[bIdx];
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

