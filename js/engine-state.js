import { FCT_AI_HOLD_MS, emitFloatingText } from './floating-text.js';
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
  const ev = Object.assign({ type, turn: state.turnNumber, phase: state.phase }, data);
  state.matchLog.push(ev);
  emitLabelFor(ev);
}

/* =========================================================
   FLOATING TEXT ADAPTER

   Every rules event already passes through logReplay at the exact moment the
   rule resolves, which is where the spec says labels must fire. Hooking here
   rather than adding twenty scattered emit calls has three consequences worth
   stating:

   ONE PLACE TO READ. The mapping from rule to label is a single table, so what
   the player sees can be checked against what the game recorded without going
   through the whole rules layer.

   IT CANNOT INVENT A TRIGGER. A label exists only where an event already
   exists, which satisfies the spec's non-goal directly: nothing here adds a
   rules branch to create a trigger point that was not already there.

   AND IT CANNOT CHANGE ANYTHING. The adapter reads the event and calls a leaf
   module. floating-text.js imports nothing, so there is no path from a label
   back into state.

   Ordering within one resolution (formation, bonuses, penalties, outcome) falls
   out of the order the rules code already writes its events in, which is the
   order the rules actually resolve. */
const FCT_ORDER = { formation:0, bonus:1, penalty:2, command:3 };
function emitLabelFor(ev){
  let labels = null;
  if(ev.type === 'formation'){
    const to = String(ev.to || '').toUpperCase();
    labels = [{ text: to === 'SQUARE' ? 'SQUARE!' : to === 'COLUMN' ? 'COLUMN!' : 'SQUARE LOWERED!', kind:'formation' }];
  } else if(ev.type === 'rally'){
    labels = [{ text: ev.success ? 'RALLIED!' : 'RALLY FAILED!', kind: ev.success ? 'bonus' : 'penalty' }];
  } else if(ev.type === 'leadership'){
    labels = [{ text:'LEADERSHIP!', kind:'command' }];
  } else if(ev.type === 'ambush'){
    labels = [{ text:'AMBUSH! +1', kind:'bonus' }];
  } else if(ev.type === 'fight'){
    /* MELEE WAS THE BIG GAP. Formations were labelled and the outcome of every
       fight was not, which is why only SQUARE! was showing in play: a match has
       a handful of formation changes and dozens of fights.

       Bonuses are read from the STRUCTURED source lists the fight event already
       records (aSources / dSources), not by parsing panel text. Each is labelled
       over the unit that earned it, which is why the event now carries the
       attacker's square as well as the defender's. */
    const out = [];
    const push = (arr, text, kind, atAttacker) => arr.push({ text, kind, atAttacker });
    for(const [sources, atAttacker] of [[ev.diag && ev.diag.aSources, true], [ev.diag && ev.diag.dSources, false]]){
      for(const src of (sources || [])){
        if(src === 'Defending in woods')        push(out, 'WOODS +1', 'bonus', atAttacker);
        else if(src === 'Defending in a building') push(out, 'VILLAGE +1', 'bonus', atAttacker);
        else if(src === 'Attack Column')        push(out, 'COLUMN +1', 'bonus', atAttacker);
        else if(src === 'Infantry vs Square')   push(out, '+1 VS SQUARE', 'bonus', atAttacker);
        else if(src === 'Ambush: committed second die') push(out, 'AMBUSH! +1', 'bonus', atAttacker);
        else if(/turned around/i.test(src))     push(out, 'STRUCK FROM BEHIND! +1', 'penalty', !atAttacker);
      }
    }
    const ties = (ev.diag && ev.diag.ties) || {};
    if(ties.attackerChargeTieWin) push(out, 'CHARGE!', 'bonus', true);
    if(ties.defenderHillTieWin)   push(out, 'HIGH GROUND!', 'bonus', false);
    // The outcome lands on the defender, and last, so it reads after its causes.
    if(ev.result === 'pushback') push(out, 'PUSHED BACK!', 'penalty', false);
    if(ev.result === 'rout')     push(out, 'ROUTED!', 'penalty', false);
    if(ev.result === 'destroy')  push(out, 'DESTROYED!', 'penalty', false);
    for(const l of out) l.col = l.atAttacker ? ev.ax : ev.x, l.row = l.atAttacker ? ev.ay : ev.y;
    labels = out;
  } else if(ev.type === 'status'){
    /* Destroyed also arrives on the fight and fire events that caused it. The
       250ms same-square-same-text collapse in the emitter is what stops the
       double, which is exactly what it was built for. Lost is skipped: it is
       always immediately followed by Destroyed and would read as two deaths. */
    if(ev.newStatus === 'Destroyed')    labels = [{ text:'DESTROYED!', kind:'penalty' }];
    else if(ev.newStatus === 'Rallied') labels = [{ text:'RALLIED!', kind:'bonus' }];
  } else if(ev.type === 'fire'){
    if(ev.hit === false) return;                       // a miss is not an event on the target
    labels = [];
    if(!ev.volley) labels.push({ text:'DIRECT HIT!', kind:'penalty' });
    if(ev.effect === 'rout')      labels.push({ text:'ROUTED!', kind:'penalty' });
    if(ev.effect === 'disrupt')   labels.push({ text:'TURNED AROUND!', kind:'penalty' });
    if(ev.effect === 'knockback') labels.push({ text:'PUSHED BACK!', kind:'penalty' });
    if(ev.effect === 'destroy')   labels.push({ text:'DESTROYED!', kind:'penalty' });
  }
  if(!labels || !labels.length) return;
  labels.sort((a,b)=>FCT_ORDER[a.kind] - FCT_ORDER[b.kind]);
  const aiTurn = state.turn === state.aiSide;
  for(const l of labels){
    emitFloatingText({ col: l.col != null ? l.col : ev.x, row: l.row != null ? l.row : ev.y,
                       text: l.text, kind: l.kind,
                       hold: aiTurn ? FCT_AI_HOLD_MS : 0 });
  }
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
