import { exportAiMoveLog } from './ai-strategy.js';
import { saveCampaignProgress } from './campaign.js';
import { SIDES, SIDE_LABEL, state } from './data-core.js';
import { unitsAt } from './engine-rules.js';
import { startReplay } from './replay.js';

/* =========================================================
   OPERATIONS — pluggable scenario objectives.
   Five reusable objective types cover all 14 catalogued Operations
   without needing bespoke code per scenario. A scenario's `objective`
   field is { combinator:'all'|'any', conditions:[{type,params}, ...] }.
   Each condition checker returns 'red', 'blue', or null (undecided).
========================================================= */
export function otherSide(side){ return side===SIDES.RED ? SIDES.BLUE : SIDES.RED; }

export function checkCaptureZone(params){
  const { zoneSquares, holdForTurns } = params;
  for(const side of [SIDES.RED, SIDES.BLUE]){
    const enemy = otherSide(side);
    const controls = zoneSquares.every(({x,y}) => {
      const here = unitsAt(x,y).filter(u=>!u.removed);
      return here.some(u=>u.side===side) && !here.some(u=>u.side===enemy);
    });
    if(controls){
      state.captureHoldCounter[side]++;
      state.captureHoldCounter[enemy] = 0;
      if(state.captureHoldCounter[side] >= holdForTurns) return side;
    } else if(state.captureHoldCounter[side] > 0 && zoneSquares.some(({x,y})=>unitsAt(x,y).some(u=>!u.removed && u.side===side))){
      // partial presence, no full control this check — hold streak broken but not reset by the enemy specifically
      state.captureHoldCounter[side] = 0;
    }
  }
  return null;
}

export function checkSurviveTurns(params){
  const { defender, minUnits } = params;
  const attacker = otherSide(defender);
  const defRemaining = state.units.filter(u=>u.side===defender && !u.removed && u.type!=='BRIGADIER').length;
  if(defRemaining < (minUnits||1)) return attacker; // defender's force collapsed before time ran out
  if(state.turnNumber >= state.scenario.turnLimit) return defender; // held out to the end
  return null;
}

export function checkEscapeZone(params){
  const { escapingSide, edgeRows, minUnitsToEscape } = params;
  const escaped = state.units.filter(u=>u.side===escapingSide && !u.removed && edgeRows.includes(u.y)).length;
  if(escaped >= minUnitsToEscape) return escapingSide;
  const remaining = state.units.filter(u=>u.side===escapingSide && !u.removed && u.type!=='BRIGADIER').length;
  if(remaining < minUnitsToEscape - escaped) return otherSide(escapingSide); // can't possibly reach the count anymore
  return null;
}

export function checkEliminateTarget(params){
  const { targetSide, targetCount } = params;
  const eliminated = state.units.filter(u=>u.side===targetSide && u.removed).length;
  if(eliminated >= targetCount) return otherSide(targetSide);
  if(state.scenario.turnLimit && state.turnNumber >= state.scenario.turnLimit) return targetSide; // ran out the clock
  return null;
}

export function checkProtectUnit(params){
  const { protectSide, unitTypes } = params;
  const assets = state.units.filter(u=>u.side===protectSide && unitTypes.includes(u.type));
  const anyLost = assets.some(u=>u.removed);
  if(anyLost) return otherSide(protectSide);
  if(state.scenario.turnLimit && state.turnNumber >= state.scenario.turnLimit) return protectSide;
  return null;
}

export const OBJECTIVE_CHECKERS = {
  CAPTURE_ZONE: checkCaptureZone,
  SURVIVE_TURNS: checkSurviveTurns,
  ESCAPE_ZONE: checkEscapeZone,
  ELIMINATE_TARGET: checkEliminateTarget,
  PROTECT_UNIT: checkProtectUnit
};

export function checkScenarioObjective(){
  const obj = state.scenario.objective;
  const results = obj.conditions.map(c => OBJECTIVE_CHECKERS[c.type](c.params));
  let winner = null;
  if(obj.combinator === 'any'){
    winner = results.find(r => r !== null) || null;
  } else { // 'all' — every condition must agree on the SAME winner
    if(results.every(r => r !== null) && results.every(r => r === results[0])) winner = results[0];
  }
  if(!winner){
    // Safety net: a side wiped out entirely can't go on to achieve any objective,
    // so the other side wins by default rather than the match hanging forever
    // (this matters most for scenarios with no turnLimit, resolved purely by objective).
    for(const side of [SIDES.RED, SIDES.BLUE]){
      const remaining = state.units.filter(u=>!u.removed && u.side===side && u.type!=='BRIGADIER').length;
      if(remaining===0){ winner = otherSide(side); break; }
    }
  }
  if(winner) endGame(winner);
}

export function checkScenarioTurnLimit(){
  // Some objective types (SURVIVE_TURNS, ELIMINATE_TARGET, PROTECT_UNIT) resolve
  // their own turn-limit outcome inside their checker; this just forces a check
  // at the moment the limit is reached in case nothing else has triggered it yet.
  if(state.scenario.turnLimit && state.turnNumber >= state.scenario.turnLimit) checkScenarioObjective();
}

export function endGame(winner){
  state.gameOver = true;
  document.getElementById('overlayTitle').textContent = `${SIDE_LABEL[winner]} Victory`;
  const bodyText = state.scenario
    ? `${SIDE_LABEL[winner]} achieves the objective: ${state.scenario.title}.`
    : `Two of the enemy's three Brigades are broken. ${SIDE_LABEL[winner]} holds the field.`;
  document.getElementById('overlayText').textContent = bodyText;
  const modeChoices = document.getElementById('modeChoices');
  if(modeChoices) modeChoices.style.display = 'none';
  document.getElementById('overlayBtn').style.display = 'inline-block';
  if(state.campaign){
    state.campaignLastWinner = winner;
    state.campaignRecord.push(winner);
    document.getElementById('overlayBtn').textContent = 'Continue Campaign';
    document.getElementById('overlayBtn').onclick = ()=>{
      state.campaignFlowIndex++;
      saveCampaignProgress();
      location.reload();
    };
  } else {
    document.getElementById('overlayBtn').textContent = 'New Battle';
    document.getElementById('overlayBtn').onclick = ()=> location.reload();
  }
  const box = document.querySelector('#overlay .box');
  let extra = document.getElementById('modeChoices');
  if(!extra){
    extra = document.createElement('div');
    extra.id = 'modeChoices';
    extra.style.gap = '8px';
    extra.style.justifyContent = 'center';
    box.appendChild(extra);
  }
  extra.innerHTML = ''; // always rebuilt fresh here — no dependency on what an earlier menu left behind
  const endScreenButtons = [];
  if(state.matchLog && state.matchLog.length>0 && state.replayStartUnits){
    const replayBtn = document.createElement('button');
    replayBtn.textContent = 'Watch Replay';
    replayBtn.onclick = startReplay;
    endScreenButtons.push(replayBtn);
  }
  if(state.aiSide){
    const exportBtn = document.createElement('button');
    exportBtn.textContent = 'Export AI Move Log';
    exportBtn.onclick = ()=>{
      document.getElementById('aiLogExportText').value = exportAiMoveLog();
      document.getElementById('aiLogExportPanel').classList.remove('hidden');
    };
    endScreenButtons.push(exportBtn);
  }
  extra.style.display = endScreenButtons.length ? 'flex' : 'none';
  endScreenButtons.forEach(b=>extra.appendChild(b));
  document.getElementById('overlay').classList.add('show');
}

