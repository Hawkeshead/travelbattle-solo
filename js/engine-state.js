import { NARRATION, UNIT_ARCHIVE, nextUid, state } from './data-core.js';
import { clearTransientRenderState, draw } from './render-board.js';
import { setHighlightCells } from './render-units.js';
import { selectUnit, updateHeader } from './ui-battle.js';
import { renderRoster, resetDeploymentUiState } from './ui-deployment.js';
import { cancelAutoEnd, maybeStartAutoEnd } from './phase-autoend.js';

/* =========================================================
   UNDO
   Snapshot the whole game state before each human-initiated mutating
   action. Only human actions push a snapshot — the AI's own move/fire/
   fight decisions never call pushUndoSnapshot, so there's nothing to
   rewind into on the AI's turn. The stack is reset at the start of
   every human turn (and deployment turn-change), so undo can only ever
   reach back to the start of the current turn, never before it.
========================================================= */
export let undoStack = [];

export function snapshotState(){
  return JSON.stringify(state, (key, value) => (value instanceof Set) ? {__isSet:true, items:[...value]} : value);
}
export function restoreState(snap){
  const parsed = JSON.parse(snap, (key, value) => (value && value.__isSet) ? new Set(value.items) : value);
  // Replace the contents in place rather than rebinding `state`. Two reasons:
  // an imported binding is read-only under ES modules, so `state = ...` from
  // this file would throw; and keeping one stable object identity means every
  // module that already holds a reference keeps seeing the live data.
  for(const key of Object.keys(state)) delete state[key];
  Object.assign(state, parsed);
}
export function pushUndoSnapshot(){
  undoStack.push(snapshotState());
  if(undoStack.length>50) undoStack.shift(); // cap memory use
  updateUndoButtons();
}
export function resetUndoStack(){
  undoStack = [];
  updateUndoButtons();
}
export function undoLastAction(){
  if(undoStack.length===0) return;
  const diceOverlay = document.getElementById('diceOverlay');
  if(diceOverlay && diceOverlay.classList.contains('show')){
    log('Cannot undo while dice are on screen — wait for the result to clear.', 'system');
    return;
  }
  const snap = undoStack.pop();
  restoreState(snap);
  clearTransientRenderState();  // render-board: animations, action line, death effects
  resetDeploymentUiState();     // ui-deployment: selected chip, in-flight drag
  setHighlightCells([]);        // render-units: selection highlights
  if(state.phase==='deploy') renderRoster();
  else selectUnit(null);
  syncPhaseButtons();
  updateHeader();
  draw();
  log('Undone.', 'system');
  updateUndoButtons();
  /* Undo is the documented way to interrupt the auto-end countdown, so it stops
     the clock first and only then re-tests. Normally the test now fails (the
     undone action is exactly the one that completed the phase) and no new
     countdown starts. Where it still passes — undoing something that never
     blocked the phase — the clock restarts from four rather than resuming, so a
     player who undoes at the last moment always gets the full window back. */
  cancelAutoEnd();
  maybeStartAutoEnd();
}
// Ensures the visible End-Phase button always matches state.phase — called
// after undo as a defensive re-sync (the undo stack is now scoped so it can
// never actually cross a phase boundary, but this keeps the UI honest regardless).
export function syncPhaseButtons(){
  const moveBtn = document.getElementById('endMoveBtn');
  const fireBtn = document.getElementById('endFireBtn');
  const fightBtn = document.getElementById('endFightBtn');
  if(!moveBtn || !fireBtn || !fightBtn) return;
  moveBtn.style.display = state.phase==='move' ? 'inline-block' : 'none';
  fireBtn.style.display = state.phase==='fire' ? 'inline-block' : 'none';
  fightBtn.style.display = state.phase==='fight' ? 'inline-block' : 'none';
}
export function updateUndoButtons(){
  const disabled = undoStack.length===0;
  const b1 = document.getElementById('undoBtn'); if(b1) b1.disabled = disabled;
  const b2 = document.getElementById('undoBtnBattle'); if(b2) b2.disabled = disabled;
}

export let historicalSlotCounters = { red:{}, blue:{} };
export function resetHistoricalIdentities(){ historicalSlotCounters = { red:{}, blue:{} }; }
export function newUnit(side, typeKey, x, y, brigadeId){
  const counters = historicalSlotCounters[side];
  const idx = counters[typeKey] || 0;
  counters[typeKey] = idx + 1;
  const archiveList = (UNIT_ARCHIVE[side] && UNIT_ARCHIVE[side][typeKey]) || [];
  const historical = archiveList.length ? archiveList[idx % archiveList.length] : null;
  return {
    id: 'u'+nextUid(), side, type: typeKey, brigadeId,
    x, y, removed:false, formation:'line', pushed:false,
    turnOnly:false, // true = can only turn around this coming turn
    rallying:false,
    charged:false,          // clean 2-square Cavalry run this turn — wins ties in the ensuing fight
    leadershipUsed:false,   // Brigadiers only: one guaranteed Rally save per match
    hidden:false,           // Woodland Ambush — invisible to artillery and to the AI's own targeting
    ambushSpentThisRound:false, // sprang an ambush this round — no woods defence bonus until side's next turn
    noActionThisTurn:false, // stood down an ambush without springing — can't move or fight for the rest of this turn
    smokeActive:false,      // fired this cycle — shows muzzle smoke until this unit's side's next turn
    historicalName: historical ? historical.name : null,
    historicalBio: historical ? historical.bio : null
  };
}

/* =========================================================
   LOGGING
========================================================= */
export function log(msg, cls){
  if(state.replaying) return;
  const el = document.getElementById('log');
  const div = document.createElement('div');
  div.className = 'entry'+(cls?(' '+cls):'');
  div.textContent = msg;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}
export function pick(arr){ return arr[Math.floor(Math.random()*arr.length)]; }

/* =========================================================
   BATTLE REPLAY — event capture
   Every entry the replay player will step through. Kept deliberately
   lightweight (no dice arrays, no reasons lists) — just enough to drive
   the board visually and know when to pause. See REPLAY section near
   the bottom of the file for playback.
========================================================= */
export function logReplay(type, data){
  if(!state.matchLog || state.replaying) return;
  state.matchLog.push(Object.assign({
    type, turn: state.turnNumber, phase: state.phase
  }, data));
}

// Assembles a short flavor paragraph from a narration bucket (opening + middle
// with {status} filled in + closing), picking randomly from each array for
// variety run to run. `variant` is 'win'|'loss' for the buckets that have a
// perspective split (always narrated from the ATTACKER's point of view — did
// their attack succeed or fail), omitted for buckets that don't (a genuine
// draw, or ranged artillery fire, which is unilateral).
export function narrate(bucketKey, variant){
  const bucket = NARRATION[bucketKey];
  if(!bucket) return null;
  const scene = variant ? bucket[variant] : bucket;
  if(!scene) return null;
  const status = bucket.status;
  const line = [pick(scene.opening), pick(scene.middle).replace('{status}', status), pick(scene.closing)].join(' ');
  return line;
}
export function logNarration(bucketKey, variant){
  const line = narrate(bucketKey, variant);
  if(line) log(line, 'narrative');
}
