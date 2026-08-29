import { aiDoFightPhase, aiDoFirePhase, aiDoMovePhase, aiPlanTurn, estimateFightValue } from './ai-strategy.js';
import { COLS, ROWS, SIDES, SIDE_COLOR, SIDE_LABEL, UNIT_TYPES, state } from './data-core.js';
import { presentRollTrigger, showDice } from './dice.js';
import { checkScenarioTurnLimit } from './engine-objectives.js';
import { artilleryTargets, canAttackTarget, chebyshev, computeChargeDestinations, consumePloughEscort, currentRngSeed, enforceAmbushWoodsInvariant, inBounds, isAdjacent, isConcealedFromEnemy, isHorseArtillery, legalMoves, pickUnitAtCell, removeUnit, resolveFight, retreatAndRally, rollD6, stackPartner, terrainAt, unitsAt } from './engine-rules.js';
import { log, logNarration, logReplay, pushUndoSnapshot, resetUndoStack, undoLastAction } from './engine-state.js';
import { addCrater, animateUnitTo, CameraPref, cameraRestorePlayerView, canvas, consumeGestureFlag, displaceBrigadierIfPresent, draw, ensureAnimationLoopRunning, FAST_ANIMATION_MODE, moveAnimationMs, observeBoardResize, resetMapView, showActionLine, sizeCanvas, sy } from './render-board.js';
import { BRIGADIER_PORTRAIT_KEY, REGIMENT_IMAGE_DATA, REGIMENT_PORTRAIT_KEY, UNIT_IMAGE_DATA, highlightCells, setHighlightCells } from './render-units.js';
import { handleOrientationClick, showModeSelect } from './ui-menus.js';
import { AudioManager } from './audio-manager.js';
import { confirmCurrentBrigade, handleDeployClick } from './ui-deployment.js';
import { AmbientLayer, AmbientPref } from './ambient-layer.js';

/* =========================================================
   MAIN GAME FLOW
========================================================= */
export function startBattle(){
  document.getElementById('overlay').classList.remove('show');
  state.matchLog = [];
  state.replayStartUnits = JSON.parse(JSON.stringify(state.units));
  state.turn = Math.random()<0.5 ? SIDES.RED : SIDES.BLUE;
  log(`Roll for initiative: ${SIDE_LABEL[state.turn]} moves first.`, 'system');
  document.getElementById('sidebar').style.display='none';
  document.getElementById('unitOverlay').classList.remove('hidden');
  document.getElementById('unitOverlay').classList.remove('show');
  state._aiPlan = { red:null, blue:null };
  state._aiMissions = { red:null, blue:null };
  state._aiFocusTargetId = null;
  /* Metadata and the deployment snapshot, captured HERE rather than rebuilt at
     the end: by the end half the units are dead and their starting tiles and
     formations are gone. Written as the match begins so a crash mid-battle
     still leaves a usable file. */
  state._matchMeta = {
    seed: currentRngSeed(),
    startedAt: new Date().toISOString(),
    difficulty: state.aiDifficulty || 'n/a',
    mode: state.mode,
    playerSide: state.mode==='ai' ? (state.aiSide===SIDES.RED ? SIDES.BLUE : SIDES.RED) : null,
    aiSide: state.mode==='ai' ? state.aiSide : null,
    boardMode: state.boardMode || 'standard',
    deployment: state.units.map(u => ({
      id:u.id, name:u.historicalName || u.type, type:u.type, side:u.side,
      brigadeId:u.brigadeId, x:u.x, y:u.y, formation:u.formation || 'line',
    })),
  };
  state._aiCavTargetCache = null;
  state._aiKillCache = null;
  state._aiContactCache = null;
  state._aiTempoCache = null;
  state._aiDebugLog = { red:null, blue:null };
  beginMovePhase();
}

export function updateHeader(){
  const badge = document.getElementById('turnBadge');
  const sideName = SIDE_LABEL[state.phase==='deploy' ? state.deployTurn : state.turn].split(' ')[0];
  if(state.phase==='deploy'){
    badge.textContent = `Deploying: ${sideName}`;
    badge.style.borderColor = SIDE_COLOR[state.deployTurn];
  } else {
    badge.textContent = sideName;
    badge.style.borderColor = SIDE_COLOR[state.turn];
  }
  renderBrigadeStatus();
}
export function phaseLabel(p){
  return {deploy:'Deployment', move:'Movement', fire:'Artillery Fire', fight:'Fighting', rally:'Rally / Turnaround'}[p] || p;
}

export function brigadeBrokenStatus(side){
  // Returns an array of 3 booleans (broken/not) — a Brigade with no combat
  // units yet (whether that's genuinely empty, or only its Brigadier has been
  // placed so far during deployment) counts as not broken. Deployment always
  // places the Brigadier before any combat unit, so without explicitly
  // excluding "Brigadier-only" here, every single Brigade briefly, incorrectly
  // read as already broken the instant its Brigadier went down.
  const out = [];
  for(let bId=0; bId<3; bId++){
    const group = state.units.filter(u=>u.side===side && u.brigadeId===bId);
    const combatUnits = group.filter(u=>u.type!=='BRIGADIER');
    if(combatUnits.length===0){ out.push(false); continue; }
    out.push(combatUnits.filter(u=>!u.removed).length===0);
  }
  return out;
}

export function renderBrigadeStatus(){
  const el = document.getElementById('brigadeStatus');
  if(!el) return;
  const renderSide = (side)=>{
    const statuses = brigadeBrokenStatus(side);
    const pips = statuses.map(broken=>`<span class="pip ${broken?'broken':'alive'}"></span>`).join('');
    const brokenCount = statuses.filter(Boolean).length;
    return `<span class="side-status" style="color:${SIDE_COLOR[side]}">${SIDE_LABEL[side]}: ${pips} <span style="color:var(--ink-dim);margin-left:2px;">(${brokenCount}/3 broken)</span></span>`;
  };
  el.innerHTML = renderSide(SIDES.RED) + renderSide(SIDES.BLUE);
}

// Section 14: the AI Debug panel. Reads whatever aiPlanTurn last wrote to
// state._aiDebugLog — nothing here computes anything fresh, it's a pure read.
const VOLUME_SLIDERS = [
  ['masterVolumeSlider','master'], ['musicVolumeSlider','music'],
  ['effectsVolumeSlider','effects'], ['ambienceVolumeSlider','ambience'],
];

function renderMenuPanel(){
  const prefs = AudioManager.getPrefs();
  document.getElementById('muteToggle').checked = prefs.muted;
  /* One slider per category. Only 'music' was populated, and only 'music' was
     wired, so master, effects and ambience were unreachable from the menu
     entirely: all four categories existed in the mixer with nothing attached
     to three of them. */
  for(const [id, category] of VOLUME_SLIDERS){
    const el = document.getElementById(id);
    if(el) el.value = Math.round((prefs.volumes[category] ?? 0.8) * 100);
  }
  const ambientEl = document.getElementById('ambientToggle');
  if(ambientEl) ambientEl.checked = AmbientPref.enabled;
  const cameraEl = document.getElementById('cameraToggle');
  if(cameraEl) cameraEl.checked = CameraPref.enabled;
  document.getElementById('backToMenuConfirm').style.display = 'none';
}

function returnToMainMenu(){
  document.getElementById('logOverlay').classList.remove('show');
  showModeSelect();
}

/* Pause the birds while anything is over the board.

   The alternative was calling suspend()/resume() at every point that shows or
   hides an overlay, which is roughly thirty call sites across five files and
   would silently rot the first time someone added a thirty-first. Watching the
   three overlay elements for their 'show' class catches all of them, including
   any added later, and touches none of the existing logic.

   #overlay      dice, dialogs, victory
   #unitOverlay  unit selection panel
   #logOverlay   Field Report / AI Debug / Menu                                */
const AMBIENT_BLOCKING_OVERLAYS = ['overlay', 'unitOverlay', 'logOverlay'];
let ambientWatcherStarted = false;

export function watchOverlaysForAmbient(){
  if(ambientWatcherStarted) return;
  const els = AMBIENT_BLOCKING_OVERLAYS
    .map(id => document.getElementById(id))
    .filter(Boolean);
  if(!els.length) return;
  ambientWatcherStarted = true;

  const anyShown = () => els.some(el => el.classList.contains('show'));
  const sync = () => {
    if(anyShown()){ if(AmbientLayer.isRunning) AmbientLayer.suspend(); }
    else if(!AmbientLayer.isRunning) AmbientLayer.resume();
  };
  const obs = new MutationObserver(sync);
  els.forEach(el => obs.observe(el, { attributes:true, attributeFilter:['class'] }));
  sync();
}

export function renderAiDebugPanel(){
  const el = document.getElementById('aiDebugPanel');
  if(!el) return;
  if(state.mode!=='ai'){
    el.innerHTML = '<div class="dbg-empty">No AI opponent this game.</div>';
    return;
  }
  if(state.aiDifficulty!=='hard'){
    el.innerHTML = `<div class="dbg-empty">${SIDE_LABEL[state.aiSide]} is playing Easy/Medium — no operational plan to report. Switch to Hard to see one.</div>`;
    return;
  }
  const dbg = state._aiDebugLog[state.aiSide];
  if(!dbg){
    el.innerHTML = '<div class="dbg-empty">No AI turn recorded yet.</div>';
    return;
  }
  const a = dbg.assessment, plan = dbg.plan, missions = dbg.missions;
  let html = '';
  html += `<h4>Turn ${dbg.turn}</h4>`;
  html += `<div class="dbg-row"><span class="dbg-label">Strength ratio:</span> ${a.strengthRatio.toFixed(2)} (${a.armyStrength} vs ${a.enemyStrength})</div>`;
  html += `<div class="dbg-row"><span class="dbg-label">Centre of gravity:</span> ${a.centreOfGravity ? 'Enemy Brigade '+(a.centreOfGravity.id+1) : 'none'}</div>`;
  html += `<div class="dbg-row"><span class="dbg-label">Weakest enemy Brigade:</span> ${a.weakestEnemyBrigade ? 'Brigade '+(a.weakestEnemyBrigade.id+1)+' (str '+a.weakestEnemyBrigade.strength+', exposure '+a.weakestEnemyBrigade.exposure.toFixed(2)+')' : 'none'}</div>`;
  html += `<div class="dbg-row"><span class="dbg-label">Isolated enemy Brigades:</span> ${a.isolatedEnemyBrigades.length ? a.isolatedEnemyBrigades.map(b=>'Brigade '+(b.id+1)).join(', ') : 'none'}</div>`;
  html += `<div class="dbg-row"><span class="dbg-label">Weak flank:</span> ${a.weakFlank}</div>`;

  html += `<h4>Operational Plan</h4>`;
  html += `<div class="dbg-row"><span class="dbg-label">Type:</span> ${plan.type}</div>`;
  html += `<div class="dbg-row"><span class="dbg-label">Main effort:</span> ${plan.mainEffortBrigadeId!=null ? 'Own Brigade '+(plan.mainEffortBrigadeId+1) : 'none'}</div>`;
  html += `<div class="dbg-row"><span class="dbg-label">Target:</span> ${plan.targetBrigadeId!=null ? 'Enemy Brigade '+(plan.targetBrigadeId+1) : 'none'}</div>`;
  html += `<div class="dbg-row"><span class="dbg-label">Held for:</span> ${plan.turnsHeld} turn${plan.turnsHeld===1?'':'s'}${plan.reasons&&plan.reasons.length?' — reassessed: '+plan.reasons.join('; '):''}</div>`;

  html += `<h4>Brigade Missions</h4>`;
  for(const bId of Object.keys(missions)){
    html += `<div class="dbg-brigade"><span class="dbg-label">Own Brigade ${Number(bId)+1}:</span> ${missions[bId]}</div>`;
  }

  html += `<h4>This Turn's Decisions</h4>`;
  if(dbg.moveLog.length===0){
    html += '<div class="dbg-empty">Move phase not complete yet — reopen this tab once it finishes.</div>';
  } else {
    for(const m of dbg.moveLog){
      html += `<div class="dbg-move"><span class="dbg-label">${m.unit}</span> (${m.mission||'—'}): ${m.action}` +
        `${m.to?' to '+m.to:''}${m.target?' vs '+m.target:''}${m.reason?' — '+m.reason:''} <span style="color:var(--ink-dim);">[${m.score}]</span></div>`;
    }
  }
  el.innerHTML = html;
}

export function beginMovePhase(){
  if(state.gameOver) return;
  state.phase = 'move';
  // Hand the player's own zoom and pan back as their turn starts. Parked at the
  // top of the AI's move phase; following the action must never cost them where
  // they were looking.
  if(!(state.mode==='ai' && state.turn===state.aiSide)) cameraRestorePlayerView();
  logReplay('turnStart', { side: state.turn });
  state.moved = new Set();
  state.turnComboTarget = null;
  enforceAmbushWoodsInvariant();
  resetUndoStack();
  clearPendingTurnaroundFlagsIfDue();
  document.getElementById('endMoveBtn').style.display='inline-block';
  document.getElementById('endFireBtn').style.display='none';
  document.getElementById('endFightBtn').style.display='none';
  selectUnit(null);
  updateHeader();
  draw();
  const aiTurn = state.mode==='ai' && state.turn===state.aiSide;
  document.getElementById('endMoveBtn').disabled = aiTurn;
  if(aiTurn){
    aiPlanTurn(state.aiSide);
    setTimeout(aiDoMovePhase, FAST_ANIMATION_MODE ? 0 : 500);
  }
}

export function clearPendingTurnaroundFlagsIfDue(){
  // units flagged turnOnly get exactly one phase of "turn around only", then are free again
  for(const u of state.units){
    if(u.side!==state.turn) continue;
    if(u._turnOnlyConsumed){
      u.turnOnly = false;
      u._turnOnlyConsumed = false;
    } else if(u.turnOnly){
      u._turnOnlyConsumed = true;
    }
    // ambush cooldown and stand-down both last only until this side's next turn
    u.ambushSpentThisRound = false;
    u.noActionThisTurn = false;
    u.smokeActive = false;
    u.charged = false; // a declared charge only counts for the turn it was made
  }
  state.ploughEscortUsed = {};
}

export function beginFirePhase(){
  state.phase = 'fire';
  state.fired = new Set();
  state.turnGunTargets = new Set();
  resetUndoStack();
  document.getElementById('endMoveBtn').style.display='none';
  document.getElementById('endFireBtn').style.display='inline-block';
  selectUnit(null);
  updateHeader();
  draw();
  const aiTurn = state.mode==='ai' && state.turn===state.aiSide;
  document.getElementById('endFireBtn').disabled = aiTurn;
  if(aiTurn) setTimeout(aiDoFirePhase, FAST_ANIMATION_MODE ? 0 : 400);
}

export function beginFightPhase(){
  state.phase = 'fight';
  state.fought = new Set();
  resetUndoStack();
  document.getElementById('endFireBtn').style.display='none';
  document.getElementById('endFightBtn').style.display='inline-block';
  selectUnit(null);
  updateHeader();
  draw();
  const aiTurn = state.mode==='ai' && state.turn===state.aiSide;
  document.getElementById('endFightBtn').disabled = aiTurn;
  if(aiTurn){
    if(!anyFightsAvailable(state.turn)){ setTimeout(endFightPhase, 400); return; }
    setTimeout(aiDoFightPhase, FAST_ANIMATION_MODE ? 0 : 500);
    return;
  }
  // auto-skip if no fights available (human turn)
  if(!anyFightsAvailable(state.turn)){
    const stuck = turnedAroundInContact(state.turn);
    if(stuck.length > 0){
      log(`${stuck.map(unitLabel).join(', ')} still turned around from being pushed back — can't fight this turn. Skipping Fight phase.`, 'system');
    } else {
      log('No units in contact — skipping Fight phase.', 'system');
    }
    setTimeout(endFightPhase, 400);
  }
}
// Woodland Ambush: an Infantry-class unit in woods, untouched by the enemy,
// that hasn't already acted this Move phase, may lie in wait instead of
// moving. It's invisible to artillery and to the AI's own tactical reads
// (see threatPenalty/nearestEnemyDist) until it springs.
export function canLayAmbush(u){
  const t = UNIT_TYPES[u.type];
  if(!(t.key==='INFANTRY'||t.key==='GUARD')) return false;
  if(u.hidden) return false;
  if(state.phase!=='move' || u.side!==state.turn || (state.moved && state.moved.has(u.id)) || u.turnOnly) return false;
  if(terrainAt(u.x,u.y).key!=='WOODS') return false;
  if(unitsAt(u.x,u.y).length>1) return false; // Square-style formations need the square to itself, same for an ambush position
  const adjacentEnemy = state.units.some(o=>!o.removed && o.side!==u.side && isAdjacent(u,o));
  return !adjacentEnemy;
}

export function canInitiateFight(u){
  return !u.removed && UNIT_TYPES[u.type].canFight && !u.turnOnly && !u.noActionThisTurn && !(state.fought && state.fought.has(u.id));
}
// Cavalry cannot attack a unit sheltering inside a building under any circumstance.
// A Brigadier is never a valid target at all — he's not a combat unit, only a
// chain-of-command marker. He's immune to being attacked and simply withdraws
// from the board once every other unit in his Brigade is gone (see removeUnit).
// canAttackTarget moved to engine-rules.js (it is a combat-legality rule, not a
// UI concern) so ai-tactics.js can use it without importing this module and
// joining the ui-battle <-> ai-strategy import cycle. Re-exported here so every
// existing importer keeps working unchanged.
export { canAttackTarget };
export function anyFightsAvailable(side){
  return state.units.some(u=>u.side===side && canInitiateFight(u) &&
    state.units.some(o=>!o.removed && o.side!==side && isAdjacent(u,o) && canAttackTarget(u,o)));
}
// Distinguishes "genuinely nothing adjacent" from "adjacent, but every one of
// those units is still turned around from a pushback and can't fight yet" —
// same rule (Section 8: a pushed-back unit spends its whole next turn just
// turning to face, free again the turn after that), but a very different
// thing to see happen, especially after a multi-unit exchange where several
// units get turned around at once. The generic "no units in contact" message
// was misleading here, since there genuinely are units in contact.
export function turnedAroundInContact(side){
  return state.units.filter(u=>!u.removed && u.side===side && u.turnOnly &&
    state.units.some(o=>!o.removed && o.side!==side && isAdjacent(u,o) && canAttackTarget(u,o)));
}

export function endMovePhase(){
  const springs = collectAmbushSprings();
  processAmbushSpringsSequentially(springs, 0, beginFirePhase);
}

// Detects (but does not resolve) any hidden unit now adjacent to an enemy
// that just moved. Resolution is handled separately since a human-owned
// ambush needs to pause for the Hold/Advance choice before any dice are rolled.
export function collectAmbushSprings(){
  const movingSide = state.turn;
  const ambushSide = movingSide===SIDES.RED ? SIDES.BLUE : SIDES.RED;
  const ambushers = state.units.filter(u=>!u.removed && u.side===ambushSide && u.hidden);
  const springs = [];
  for(const amb of ambushers){
    const targets = state.units.filter(o=>!o.removed && o.side===movingSide && o.type!=='BRIGADIER' && isAdjacent(amb,o));
    if(targets.length===0) continue;
    let best=null, bestScore=-Infinity;
    for(const t of targets){
      const s = estimateFightValue(amb, t);
      if(s>bestScore){ bestScore=s; best=t; }
    }
    springs.push({ambusherId:amb.id, targetId:best.id});
  }
  return springs;
}

export function processAmbushSpringsSequentially(springs, idx, onDone){
  if(idx >= springs.length){ onDone(); return; }
  const amb = state.units.find(u=>u.id===springs[idx].ambusherId);
  const target = state.units.find(u=>u.id===springs[idx].targetId);
  if(!amb || amb.removed || !amb.hidden || !target || target.removed){
    processAmbushSpringsSequentially(springs, idx+1, onDone); return; // already resolved (e.g. shared target)
  }
  const isHumanOwner = !(state.mode==='ai' && amb.side===state.aiSide);
  if(isHumanOwner){
    showAmbushChoice(amb, target, (mode)=>{
      springAmbush(amb, target, mode, ()=> processAmbushSpringsSequentially(springs, idx+1, onDone));
    });
  } else {
    springAmbush(amb, target, 'hold', ()=> processAmbushSpringsSequentially(springs, idx+1, onDone)); // AI doesn't lay ambush itself, but resolve gracefully if it ever inherits one
  }
}

export function showAmbushChoice(ambusher, target, callback){
  document.getElementById('overlayTitle').textContent = `AMBUSH! ${SIDE_LABEL[ambusher.side]}`;
  document.getElementById('overlayText').innerHTML =
    `Your ${unitLabel(ambusher)} springs on ${unitLabel(target)}. +1 to the roll either way. `+
    `<b>Hold</b> stays in the wood with a single die. <b>Advance</b> gets a genuine second die for this attack, and moves your unit into the open ground if it wins. Either way, the ambush ends and the wood's defence bonus won't apply again until your next turn.`;
  document.getElementById('overlayBtn').style.display = 'none';
  const canvas = document.getElementById('rotationPreviewCanvas');
  if(canvas) canvas.style.display = 'none';
  let extra = document.getElementById('modeChoices');
  extra.innerHTML = '';
  extra.style.display = 'flex';
  extra.style.flexWrap = 'wrap';
  const holdBtn = document.createElement('button');
  holdBtn.textContent = 'Hold Position';
  holdBtn.onclick = ()=>{ extra.style.display='none'; document.getElementById('overlay').classList.remove('show'); callback('hold'); };
  const advBtn = document.createElement('button');
  advBtn.className = 'primary';
  advBtn.textContent = 'Commit to Advance';
  advBtn.onclick = ()=>{ extra.style.display='none'; document.getElementById('overlay').classList.remove('show'); callback('advance'); };
  extra.appendChild(holdBtn);
  extra.appendChild(advBtn);
  document.getElementById('overlay').classList.add('show');
}

export function springAmbush(ambusher, target, mode, onComplete){
  /* The spring. Together with 'set' and 'standDown' this closes the ambush
     lifecycle, which is what the log could not previously show: an ambush that
     was laid and never resolved was indistinguishable from one that was never
     implemented. */
  logReplay('ambush', { unitId:ambusher.id, side:ambusher.side, x:ambusher.x, y:ambusher.y,
    phase:'sprung', mode, targetId:target.id });
  onComplete = onComplete || function(){};
  ambusher.hidden = false;
  ambusher.ambushSpentThisRound = true;
  log(`AMBUSH! ${unitLabel(ambusher)} springs from the woods on ${unitLabel(target)} (${mode}).`, 'combat');
  const beforeX = target.x, beforeY = target.y;
  resolveFight(ambusher, target, mode, ()=>{
    if(mode==='advance'){
      const stillThere = state.units.some(o=>!o.removed && o.id===target.id && o.x===beforeX && o.y===beforeY);
      if(!stillThere && unitsAt(beforeX,beforeY).length===0 && isAdjacent(ambusher,{x:beforeX,y:beforeY})){
        animateUnitTo(ambusher, beforeX, beforeY, 'advanceAfterCombat');
        log(`${unitLabel(ambusher)} advances into the vacated ground.`, 'combat');
      }
    }
    onComplete();
  });
}
export function endFirePhase(){ beginFightPhase(); }
export function endFightPhase(){
  if(state.gameOver) return;
  if(anyFightsAvailable(state.turn)){
    log('Units in contact must fight before the phase can end.', 'system');
    return;
  }
  state.phase = 'rally';
  updateHeader();
  log(`${SIDE_LABEL[state.turn]} turn complete.`, 'system');
  setTimeout(()=>{
    state.turn = state.turn===SIDES.RED ? SIDES.BLUE : SIDES.RED;
    state.turnNumber++;
    if(state.scenario && !state.gameOver) checkScenarioTurnLimit();
    if(!state.gameOver) beginMovePhase();
  }, 300);
}

/* =========================================================
   SELECTION & INTERACTION
========================================================= */
export function selectUnit(id){
  state.selectedUnitId = id;
  setHighlightCells([]);
  const u = id ? state.units.find(x=>x.id===id) : null;
  /* Cavalry draw sabres on selection; everything else keeps the piece-placed
     click. Both armies, light and heavy alike. Plays once, so no duration or
     loop: it is a moment, not an action of variable length. */
  if(u){
    const selT = UNIT_TYPES[u.type];
    if(selT.isCavalry){
      AudioManager.playEffect('cavalry-select', 'audio/effects/cavalry-select-sword.wav', 'ui');
    } else {
      AudioManager.playEffect('unit-select', 'audio/effects/chess-piece-placed.wav', 'ui');
    }
  }
  renderUnitInfo(u);
  if(u && u.side===state.turn){
    if(state.phase==='move'){
      const moves = legalMoves(u);
      setHighlightCells(moves.map(m=>({x:m.x,y:m.y,kind:'move'})));
    } else if(state.phase==='fire' && UNIT_TYPES[u.type].isArtillery){
      const targets = artilleryTargets(u);
      setHighlightCells(targets.map(t=>({x:t.x,y:t.y,kind:'target'})));
    } else if(state.phase==='fight'){
      const targets = state.units.filter(o=>!o.removed && o.side!==u.side && isAdjacent(u,o) && canAttackTarget(u,o));
      setHighlightCells(targets.map(t=>({x:t.x,y:t.y,kind:'target'})));
    }
  }
  draw();
}

export function unitLabel(u){ return (u && u.historicalName) || UNIT_TYPES[u.type].label; }
export function toggleUnitBio(){
  const bioText = document.getElementById('bioText');
  const btn = document.getElementById('bioToggleBtn');
  if(!bioText || !btn) return;
  const showing = bioText.style.display !== 'none';
  bioText.style.display = showing ? 'none' : 'block';
  btn.textContent = showing ? 'History ▾' : 'History ▴';
}

// renderUnitInfo injects `onclick="toggleUnitBio()"` through innerHTML, and an
// inline handler attribute is compiled against the GLOBAL scope — module scope
// is invisible to it. Without this line the History toggle throws a
// ReferenceError on click, silently, and only for units that have a bio.
//
// The tidier fix is to attach the handler with addEventListener after the
// innerHTML assignment and drop the global entirely. That is a behaviour change
// in code this refactor is meant to leave alone, so it is recorded in TRIAGE.md
// as a follow-up rather than smuggled in here.
window.toggleUnitBio = toggleUnitBio;
export function renderUnitInfo(u){
  const el = document.getElementById('unitInfo');
  const sqBtn = document.getElementById('squareBtn');
  const ambBtn = document.getElementById('ambushBtn');
  const overlay = document.getElementById('unitOverlay');
  if(!u){ el.innerHTML='<span class="empty">No unit selected</span>'; sqBtn.disabled=true; ambBtn.style.display='none'; if(overlay) overlay.classList.remove('show'); return; }
  if(overlay && state.phase!=='deploy') overlay.classList.add('show');
  const panelEl = document.getElementById('unitOverlayPanel');
  if(panelEl){
    const inLeftHalf = u.x < COLS/2;
    panelEl.classList.toggle('anchor-right', inLeftHalf);  // unit on the left -> panel on the right
    panelEl.classList.toggle('anchor-left', !inLeftHalf);  // unit on the right -> panel on the left
  }
  const t = UNIT_TYPES[u.type];
  const terr = terrainAt(u.x,u.y);
  const heading = u.historicalName || t.label;
  const subheading = u.historicalName ? t.label : null;
  el.innerHTML = `
    <div class="u-name" style="color:${SIDE_COLOR[u.side]}">${heading}</div>
    <div style="color:var(--ink-dim);font-size:11px;">${SIDE_LABEL[u.side]}${subheading?(' &middot; '+subheading):''} &middot; (${u.x},${u.y}) &middot; ${terr.key}</div>
    <div class="u-tags">
      <span class="tag st-active">Move ${t.move}</span>
      ${t.reroll?'<span class="tag">Re-roll ★</span>':''}
      ${u.formation==='square'?'<span class="tag st-square">SQUARE</span>':''}
      ${u.turnOnly?'<span class="tag st-pushed">Turning Around</span>':''}
      ${u.rallying?'<span class="tag">Rallying</span>':''}
      ${u.hidden?'<span class="tag st-square">IN AMBUSH</span>':(isConcealedFromEnemy(u)?'<span class="tag">IN COVER (Woods)</span>':'')}
      ${u.charged?'<span class="tag st-active">CHARGED</span>':''}
    </div>
    ${u.historicalBio ? `<div class="bio-toggle" id="bioToggleBtn" onclick="toggleUnitBio()">History ▾</div><div class="bio-text" id="bioText" style="display:none;">${u.historicalBio}</div>` : ''}
  `;
  const portraitEl = document.getElementById('unitPortrait');
  if(portraitEl){
    portraitEl.style.background = `linear-gradient(160deg, ${SIDE_COLOR[u.side]}22, var(--paper-2))`;
    if(t.key==='BRIGADIER' && BRIGADIER_PORTRAIT_KEY[u.historicalName]){
      portraitEl.innerHTML = `<img src="${UNIT_IMAGE_DATA[BRIGADIER_PORTRAIT_KEY[u.historicalName]]}" style="width:92%;height:92%;object-fit:cover;object-position:50% 12%;border-radius:6px;border:3px solid ${u.side===SIDES.RED?'#b9c2c9':'#c9a227'};">`;
    } else if(t.isArtillery){
      portraitEl.innerHTML = `<img src="${UNIT_IMAGE_DATA[u.side===SIDES.RED?'cannon_red':'cannon_blue']}" style="width:80%;height:auto;">`;
    } else if(REGIMENT_PORTRAIT_KEY[u.historicalName]){
      portraitEl.innerHTML = `<img src="${REGIMENT_IMAGE_DATA[REGIMENT_PORTRAIT_KEY[u.historicalName]]}" style="width:92%;height:92%;object-fit:cover;object-position:50% 12%;border-radius:6px;border:3px solid ${SIDE_COLOR[u.side]};">`;
    } else {
      const glyph = (t.key==='HEAVY_CAV'||t.key==='LIGHT_CAV') ? '\u25B2\u25B2\u25B2' : (t.key==='BRIGADIER' ? '\u2605' : '\u25CF\u25CF\u25CF\u25CF\u25CF');
      portraitEl.innerHTML = `<span style="font-size:26px;letter-spacing:2px;color:${SIDE_COLOR[u.side]};">${glyph}</span>`;
    }
  }
  /* Hidden outright for anything that can never form Square, rather than shown
     greyed out. Cavalry, artillery and Brigadiers have no use for this control
     at any point in the game, so a permanently dead button beside them is just
     clutter competing with the unit's own details for space. Matches how the
     ambush button already behaves. */
  sqBtn.style.display = t.canFormSquare ? 'inline-block' : 'none';
  sqBtn.textContent = u.formation==='square' ? 'Leave Square' : 'Form Square';
  const baseOk = t.canFormSquare && state.phase==='move' && u.side===state.turn && !state.moved.has(u.id) && !u.turnOnly;
  if(u.formation==='square'){
    sqBtn.disabled = !baseOk;
  } else {
    sqBtn.disabled = !(baseOk && terrainAt(u.x,u.y).key!=='WOODS' && terrainAt(u.x,u.y).key!=='BUILDING' && unitsAt(u.x,u.y).length<=1);
  }

  if(u.hidden){
    ambBtn.style.display = 'inline-block';
    ambBtn.textContent = 'Stand Down';
    ambBtn.disabled = !(state.phase==='move' && u.side===state.turn && !state.moved.has(u.id));
  } else if(canLayAmbush(u)){
    ambBtn.style.display = 'inline-block';
    ambBtn.textContent = 'Lay Ambush';
    ambBtn.disabled = false;
  } else {
    ambBtn.style.display = 'none';
  }

  const chargeBtn = document.getElementById('chargeBtn');
  const chargeOk = t.isCavalry && state.phase==='move' && u.side===state.turn && !state.moved.has(u.id) && !u.turnOnly;
  if(chargeOk && computeChargeDestinations(u).length>0){
    chargeBtn.style.display = 'inline-block';
    chargeBtn.disabled = false;
  } else {
    chargeBtn.style.display = 'none';
  }
}

// Registered from boot.js rather than at load time. `canvas` belongs to
// render-board.js, and reading another module's binding while modules are still
// evaluating is a temporal-dead-zone error waiting to happen — these two files
// import from each other, so evaluation order between them is not guaranteed.
// Deferring the read until start-up sidesteps that entirely.
export function initBoardInput(){
  canvas.addEventListener('click', (e)=>{
    if(consumeGestureFlag()){ return; } // this click is the tail end of a pan/pinch, not a tap
    const rect = canvas.getBoundingClientRect();
    const cellPxX = rect.width / COLS, cellPxY = rect.height / ROWS;
    const x = Math.floor((e.clientX-rect.left)/cellPxX);
    const screenY = Math.floor((e.clientY-rect.top)/cellPxY);
    const y = sy(screenY);
    if(!inBounds(x,y)) return;
    onCellClick(x,y);
  });
}

export function onCellClick(x,y){
  if(state.gameOver) return;
  if(state.phase==='orientation'){ handleOrientationClick(x); return; }
  if(state.phase==='deploy'){ handleDeployClick(x,y); return; }
  if(state.mode==='ai' && state.turn===state.aiSide) return; // AI's turn, ignore human clicks

  const clicked = pickUnitAtCell(x,y);
  const sel = state.selectedUnitId ? state.units.find(u=>u.id===state.selectedUnitId) : null;

  if(state.phase==='move'){
    if(sel && sel.side===state.turn && highlightCells.some(c=>c.x===x&&c.y===y&&c.kind==='charge')){
      pushUndoSnapshot();
      const fromX=sel.x, fromY=sel.y;
      displaceBrigadierIfPresent(x, y, fromX, fromY);
      animateUnitTo(sel, x, y, 'charge');
      sel.charged = true;
      state.moved.add(sel.id);
      log(`${unitLabel(sel)} charges to engage!`, sel.side);
      selectUnit(sel.id);
      return;
    }
    if(sel && sel.side===state.turn && highlightCells.some(c=>c.x===x&&c.y===y&&c.kind==='move')){
      pushUndoSnapshot();
      const fromX=sel.x, fromY=sel.y;
      displaceBrigadierIfPresent(x, y, fromX, fromY);
      if(UNIT_TYPES[sel.type].isArtillery && !isHorseArtillery(sel) && terrainAt(x,y).plough) consumePloughEscort(sel);
      // Captured BEFORE animateUnitTo, which updates sel.x/sel.y immediately;
      // reading them afterwards would always give a distance of zero.
      const marchSteps = Math.max(Math.abs(x-sel.x), Math.abs(y-sel.y));
      animateUnitTo(sel, x, y, 'march');
      if(UNIT_TYPES[sel.type].key==='INFANTRY' || UNIT_TYPES[sel.type].key==='GUARD'){
        // Lasts exactly as long as this unit is walking, one square or three.
        AudioManager.playEffect('infantry-march', 'audio/effects/infantry-marching.wav', 'movement',
          { durationMs: moveAnimationMs(Math.max(1, marchSteps)) });
      }
      if(UNIT_TYPES[sel.type].isCavalry){
        // Loops to cover the whole ride; cut at the end of the animation.
        AudioManager.playEffect('cavalry-gallop', 'audio/effects/cavalry-gallop.wav', 'movement',
          { durationMs: moveAnimationMs(Math.max(1, marchSteps)), loop: true });
      }
      state.moved.add(sel.id);
      log(`${unitLabel(sel)} moves to (${x},${y}).`, sel.side);
      selectUnit(sel.id);
      return;
    }
    if(clicked && clicked.side===state.turn){ selectUnit(clicked.id); return; }
    selectUnit(clicked ? clicked.id : null);
  } else if(state.phase==='fire'){
    if(sel && UNIT_TYPES[sel.type].isArtillery && highlightCells.some(c=>c.x===x&&c.y===y&&c.kind==='target')){
      const target = pickUnitAtCell(x,y);
      pushUndoSnapshot();
      selectUnit(null);
      fireArtillery(sel, target);
      return;
    }
    if(clicked && clicked.side===state.turn && UNIT_TYPES[clicked.type].isArtillery){ selectUnit(clicked.id); return; }
    selectUnit(clicked ? clicked.id : null);
  } else if(state.phase==='fight'){
    /* canInitiateFight is re-checked HERE, not only at selection time.
    
       The guard below records the attacker the moment an attack is declared,
       which is right. But the selection fallthrough at the end of this block
       selects any friendly unit whether or not it may still fight, and this
       branch only tested that the clicked cell was a highlighted target. So a
       unit that had already fought could be re-selected and thrown in again.
    
       A logged match shows the 10th Hussars attacking FOUR times in turn 31:
       it pushed a battery back, killed it, killed the second battery, then
       fought the 7e Hussards. One unit, four fights, one turn. */
    if(sel && sel.side===state.turn && canInitiateFight(sel) &&
       highlightCells.some(c=>c.x===x&&c.y===y&&c.kind==='target')){
      const target = pickUnitAtCell(x,y);
      pushUndoSnapshot();
      selectUnit(null);
      /* Mark the attacker as HAVING FOUGHT before the fight resolves, not after.

         It used to be recorded in the completion callback, which fires at the
         dice settle roughly 2.9 seconds later. Until then canInitiateFight still
         returned true for that unit, so the same attacker could be re-selected
         and thrown at the same defender again inside the window. A logged match
         shows the Royal Horse Guards fighting 1er Grenadiers FIVE times in one
         turn: four stalemates and then a pushback, because a drawn fight leaves
         both units in contact and the player simply attacked again.

         A drawn fight is supposed to lock both units and continue next turn. The
         commitment happens when the attack is declared, so that is where it is
         recorded. */
      state.fought.add(sel.id);
      resolveFight(sel, target, undefined, ()=>{
        if(!anyFightsAvailable(state.turn)) setTimeout(endFightPhase, 500);
      });
      return;
    }
    if(clicked && clicked.side===state.turn && canInitiateFight(clicked)){ selectUnit(clicked.id); return; }
    selectUnit(clicked ? clicked.id : null);
  }
}

export function fireArtillery(gun, target, onComplete){
  onComplete = onComplete || function(){};
  const dist = chebyshev(gun,target);
  if(dist<=1){
    resolveFight(gun, target, undefined, ()=>{ state.fired.add(gun.id); selectUnit(null); onComplete(); });
    return;
  }
  gun.smokeActive = true;
  ensureAnimationLoopRunning();
  showActionLine(gun, target, '#a33330', 3800, true);
  const needed = dist; // to-hit number: a target at range N needs a roll of N or higher — pure range, no formation modifier
  const hitNotes = [];
  const minRoll = Math.max(1, Math.min(6, needed));
  hitNotes.push(minRoll<=6 ? `Need ${minRoll}+ to hit` : 'Out of range — cannot hit');

  presentRollTrigger([{label:'To Hit', diceCount:1, notes:hitNotes}], gun.side, ()=>{
    const roll = rollD6();
    const hit = roll >= needed;
    showDice([{label:'To Hit', rolls:[roll], keptValue:roll, notes:hitNotes}], hit ? 'Hit!' : 'Miss', hit ? 'win' : 'lose', ()=>{
      log(`Artillery fires at ${unitLabel(target)} (range ${dist}, needs ${needed}+): rolled ${roll}.`, 'combat');
      if(!hit){
        logNarration('artillery_miss');
        log('Shot falls wide.', 'combat');
        state.fired.add(gun.id);
        selectUnit(null);
        onComplete();
        return;
      }
      addCrater(target.x, target.y);
      // Brigadiers are never valid artillery targets (artilleryTargets() already
      // excludes them) — but they can share a square with the actual target,
      // and the effect roll must not splash onto him too. He's immune to being
      // attacked outright; the only thing that ever moves him is a unit stepping
      // onto his square (see displaceBrigadierIfPresent).
      const stack = unitsAt(target.x, target.y).filter(u=>u.type!=='BRIGADIER');
      const inCover = terrainAt(target.x,target.y).key==='WOODS' || terrainAt(target.x,target.y).key==='BUILDING';
      // Square/Column bonus now lands on the EFFECT roll, not the to-hit roll.
      // A "Column" here is two Infantry/Guard doubled into one open-terrain square.
      const isColumn = stack.length>1;
      const formationBonus = (target.formation==='square' || isColumn) ? 1 : 0;
      // Firing again on an already-Shaken target gets +1 effect. For a Column,
      // BOTH units in the stack must already be Shaken for the bonus to apply.
      const shakenBonus = isColumn
        ? (stack.every(u=>u.turnOnly) ? 1 : 0)
        : (target.turnOnly ? 1 : 0);
      const effNotes = [];
      if(inCover) effNotes.push('-1 effect: target in wood/building');
      if(formationBonus) effNotes.push(target.formation==='square' ? '+1 effect: Square formation' : '+1 effect: doubled Infantry (Column)');
      if(shakenBonus) effNotes.push(isColumn ? '+1 effect: both units already Shaken' : '+1 effect: target already Shaken');

      presentRollTrigger([{label:'Effect', diceCount:1, notes:effNotes}], gun.side, ()=>{
        let effRoll = rollD6();
        effRoll = Math.min(6, effRoll + formationBonus + shakenBonus);
        if(inCover) effRoll = Math.max(1, effRoll-1);
        const effLabel = effRoll<=3 ? 'No effect' : effRoll===4 ? 'Shaken' : effRoll===5 ? 'Falls back' : 'Removed';
        const effCls = effRoll<=3 ? '' : effRoll<=4 ? 'draw' : 'lose';
        showDice([{label:'Effect', rolls:[effRoll], keptValue:effRoll, notes:effNotes}], effLabel, effCls, ()=>{
          // Stacked units (doubled infantry in open terrain) suffer the same effect roll together —
          // each may need its own async Rally/Leadership sequence, so process them one at a time.
          if(stack.length>1) log(`${stack.length} units in that square share the effect.`, 'combat');
          applyArtilleryEffectToStack(stack, effRoll, 0, ()=>{
            state.fired.add(gun.id);
            selectUnit(null);
            onComplete();
          });
        });
      });
    });
  });
}

export function applyArtilleryEffectToStack(stack, roll, idx, onAllDone){
  if(idx >= stack.length){ onAllDone(); return; }
  const u = stack[idx];
  if(u.removed){ applyArtilleryEffectToStack(stack, roll, idx+1, onAllDone); return; }
  applyArtilleryEffect(u, roll, ()=> applyArtilleryEffectToStack(stack, roll, idx+1, onAllDone));
}

export function applyArtilleryEffect(u, roll, onComplete){
  onComplete = onComplete || function(){};
  const t = UNIT_TYPES[u.type];
  logReplay('fire', { targetId:u.id, side:u.side, x:u.x, y:u.y, roll, effect: roll<=3?'none':roll===4?'disrupt':roll===5?'rout':'destroy' });
  if(roll<=3){
    log(`${unitLabel(u)} carries on regardless.`, 'combat'); logNarration('artillery_no_effect');
    onComplete();
  } else if(roll===4){
    u.turnOnly=true;
    log(`${unitLabel(u)} is shaken — cannot move next turn, turns to face.`, 'combat'); logNarration('artillery_disrupt');
    onComplete();
  } else if(roll===5){
    logNarration('artillery_rout');
    // A Column breaks as one, so both halves rout together.
    const routPartner = stackPartner(u);
    retreatAndRally(u, ()=>{
      if(routPartner && !routPartner.removed) retreatAndRally(routPartner, onComplete);
      else onComplete();
    });
  } else {
    logNarration('artillery_destroy');
    /* THE COLUMN RULE BELONGS HERE, and only here. A roundshot goes through a
       doubled stand and kills both units: that is the risk of stacking, and the
       most efficient result in the game.
    
       It was previously applied in MELEE and not applied here at all, which is
       exactly backwards. Infantry and cavalry fight one unit at a time, so
       beating the top of a Column does not kill the one beneath it. A gun does
       not care which of them it hits. */
    const killPartner = stackPartner(u);
    removeUnit(u,'destroyed by artillery');
    if(killPartner && !killPartner.removed){
      removeUnit(killPartner, 'Column broken alongside its partner');
    }
    onComplete();
  }
}

// All DOM wiring lives behind this, called once from boot.js. Registering
// listeners at module-evaluation time would tie start-up to module ordering;
// doing it explicitly keeps the sequence obvious and under our control.
export function initBattleControls(){
  // Registered here with the rest of the one-time DOM wiring, not at module
  // evaluation, so the overlay elements are guaranteed to exist.
  watchOverlaysForAmbient();

  const exportPanel = document.getElementById('aiLogExportPanel');
  const exportText = document.getElementById('aiLogExportText');
  document.getElementById('aiLogExportCloseBtn').onclick = ()=> exportPanel.classList.add('hidden');
  document.getElementById('aiLogExportBackdrop').onclick = ()=> exportPanel.classList.add('hidden');
  document.getElementById('aiLogExportCopyBtn').onclick = ()=>{
    exportText.select();
    navigator.clipboard?.writeText(exportText.value).catch(()=>{
      document.execCommand('copy'); // older-browser fallback — clipboard API isn't universal on mobile Safari yet
    });
  };

  document.getElementById('logIconBtn').onclick = ()=>{
    const overlay = document.getElementById('logOverlay');
    overlay.classList.remove('hidden');
    overlay.classList.add('show');
    const log = document.getElementById('log');
    log.scrollTop = log.scrollHeight;
  };
  document.getElementById('logCloseBtn').onclick = ()=>{
    document.getElementById('logOverlay').classList.remove('show');
  };
  document.getElementById('logOverlayBackdrop').onclick = ()=>{
    document.getElementById('logOverlay').classList.remove('show');
  };
  document.getElementById('logTabReport').onclick = ()=>{
    document.getElementById('logTabReport').classList.add('active');
    document.getElementById('logTabDebug').classList.remove('active');
    document.getElementById('logTabMenu').classList.remove('active');
    document.getElementById('log').style.display = 'block';
    document.getElementById('aiDebugPanel').style.display = 'none';
    document.getElementById('menuPanel').style.display = 'none';
  };
  document.getElementById('logTabDebug').onclick = ()=>{
    document.getElementById('logTabDebug').classList.add('active');
    document.getElementById('logTabReport').classList.remove('active');
    document.getElementById('logTabMenu').classList.remove('active');
    document.getElementById('log').style.display = 'none';
    document.getElementById('aiDebugPanel').style.display = 'block';
    document.getElementById('menuPanel').style.display = 'none';
    renderAiDebugPanel();
  };
  document.getElementById('logTabMenu').onclick = ()=>{
    document.getElementById('logTabMenu').classList.add('active');
    document.getElementById('logTabReport').classList.remove('active');
    document.getElementById('logTabDebug').classList.remove('active');
    document.getElementById('log').style.display = 'none';
    document.getElementById('aiDebugPanel').style.display = 'none';
    document.getElementById('menuPanel').style.display = 'block';
    renderMenuPanel();
  };

  document.getElementById('muteToggle').onchange = (e)=> AudioManager.setMuted(e.target.checked);
  const ambientToggleEl = document.getElementById('ambientToggle');
  if(ambientToggleEl) ambientToggleEl.onchange = (e)=>{ AmbientPref.enabled = e.target.checked; };
  const cameraToggleEl = document.getElementById('cameraToggle');
  if(cameraToggleEl) cameraToggleEl.onchange = (e)=>{ CameraPref.enabled = e.target.checked; };
  for(const [id, category] of VOLUME_SLIDERS){
    const el = document.getElementById(id);
    if(el) el.oninput = (e)=> AudioManager.setVolume(category, e.target.value/100);
  }
  document.getElementById('backToMenuBtn').onclick = ()=>{
    if(state.gameOver){
      returnToMainMenu();
    } else {
      document.getElementById('backToMenuConfirm').style.display = 'block';
    }
  };
  document.getElementById('backToMenuConfirmYes').onclick = returnToMainMenu;
  document.getElementById('backToMenuConfirmNo').onclick = ()=>{
    document.getElementById('backToMenuConfirm').style.display = 'none';
  };

  document.getElementById('squareBtn').onclick = ()=>{
    const u = state.units.find(x=>x.id===state.selectedUnitId);
    if(!u) return;
    pushUndoSnapshot();
    if(u.formation==='square'){
      u.formation = 'line';
      logReplay('formation', { unitId:u.id, side:u.side, x:u.x, y:u.y, to:'line', by:'player' });
      state.moved.add(u.id);
      log(`${unitLabel(u)} reforms Line.`, u.side);
    } else {
      u.formation = 'square';
      logReplay('formation', { unitId:u.id, side:u.side, x:u.x, y:u.y, to:'square', by:'player' });
      state.moved.add(u.id);
      log(`${unitLabel(u)} forms Square.`, u.side);
    }
    selectUnit(u.id);
    draw();
  };

  document.getElementById('ambushBtn').onclick = ()=>{
    const u = state.units.find(x=>x.id===state.selectedUnitId);
    if(!u) return;
    pushUndoSnapshot();
    if(u.hidden){
      u.hidden = false;
      state.moved.add(u.id);
      u.noActionThisTurn = true;
      log(`${unitLabel(u)} stands down from ambush — no move or fight for the rest of this turn.`, u.side);
    } else if(canLayAmbush(u)){
      u.hidden = true;
      state.moved.add(u.id);
      log(`${unitLabel(u)} lies in ambush in the woods.`, u.side);
    }
    selectUnit(u.id);
    draw();
  };

  document.getElementById('chargeBtn').onclick = ()=>{
    const u = state.units.find(x=>x.id===state.selectedUnitId);
    if(!u) return;
    const dests = computeChargeDestinations(u);
    setHighlightCells(dests.map(m=>({x:m.x, y:m.y, kind:'charge'})));
    draw();
  };

  document.getElementById('endMoveBtn').onclick = endMovePhase;
  document.getElementById('endFireBtn').onclick = endFirePhase;
  document.getElementById('endFightBtn').onclick = endFightPhase;
  document.getElementById('confirmBrigadeBtn').onclick = confirmCurrentBrigade;
  document.getElementById('endDeployBtn').onclick = startBattle;
  document.getElementById('undoBtn').onclick = undoLastAction;
  document.getElementById('undoBtnBattle').onclick = undoLastAction;
  document.getElementById('resetViewBtn').onclick = resetMapView;

  document.getElementById('overlayBtn').onclick = ()=>{
    document.getElementById('overlay').classList.remove('show');
  };

  /* =========================================================
     BOOT
  ========================================================= */
  // Watches the board wrapper's box directly, which catches the end of
  // deployment where a resize event never fires because the window never changed
  // size: only the layout inside it did.
  observeBoardResize();
  window.addEventListener('resize', sizeCanvas);
  window.addEventListener('orientationchange', ()=> setTimeout(sizeCanvas, 200));
  window.addEventListener('load', ()=> setTimeout(sizeCanvas, 60));
}

