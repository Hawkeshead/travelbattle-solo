/* =========================================================
   MATCH SAVE AND RESUME (3 Oct 2026)

   A battle against the AI (standard or an Operation) saves itself as it goes,
   on the phone, so a dropped connection, a closed app or a call does not cost
   the match. The start screen then offers "Resume Battle" at the top. Online
   matches are not saved here (the match lives on the server and both phones
   sync it); Spectate, Group and Real-Time are not saved either.

   WHAT A SAVE IS. The whole game state, exactly as undo snapshots it
   (engine-state snapshotState), plus the dice generator's position (so the
   rest of the match rolls as it would have), plus the match record the
   telemetry is building (so the record carries on rather than being cut off
   as incomplete), plus a short summary for the Resume button. One save,
   in IndexedDB (a long match is a few megabytes, more than localStorage
   should hold), replaced each time.

   WHEN IT SAVES. Only at moments when nothing is in flight, so a resumed game
   never wakes up mid-roll or mid-animation:
   - at the start of every phase, either side's, before the phase sets itself
     up (resumeAt 'move' / 'fire' / 'fight': resuming runs that phase's start
     again, which also restarts the AI if it is the AI's phase);
   - during your own phase, a couple of seconds after each action settles,
     and the moment the app goes into the background, provided no dice,
     prompt or animation is showing (resumeAt 'continue': resuming puts the
     board back exactly as it was, mid-phase).
   An AI phase is therefore resumed from its start, and nothing the AI did in
   it before you left is kept; it plays the phase again with the same dice.

   WHEN IT GOES. When the match ends (it is finished, nothing to resume), when
   you discard it, and when a new battle starts (its record is then sent as an
   incomplete match, like any abandoned one).
========================================================= */
import { setBoardMode, state } from './data-core.js';
import { BUILD } from './build-info.js';
import { isOnline } from './online-session.js';
import { restoreState, snapshotState } from './engine-state.js';
import { getRngState, setRngState } from './engine-rules.js';
import { currentRecord, recResume, recoverIncomplete } from './telemetry/recorder.js';
import { queueRecord } from './telemetry/sender.js';

const DB = 'fc_saves', STORE = 'saves', KEY = 'current', VERSION = 1;
let dbP = null;
function db(){
  if(dbP) return dbP;
  dbP = new Promise((ok, no) => {
    if(typeof indexedDB === 'undefined'){ no(new Error('no IndexedDB')); return; }
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { if(!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE); };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error);
  });
  return dbP;
}
async function io(mode, fn){
  const d = await db();
  return new Promise((ok, no) => {
    const t = d.transaction(STORE, mode); const req = fn(t.objectStore(STORE));
    t.oncomplete = () => ok(req && 'result' in req ? req.result : undefined);
    t.onerror = () => no(t.error); t.onabort = () => no(t.error);
  });
}

const HEADLESS = typeof navigator === 'undefined' || /jsdom/i.test(navigator.userAgent || '');
let resuming = false;

/* Only a battle against the AI on this phone, while it is being fought. */
export function saveable(){
  if(HEADLESS || resuming) return false;
  if(state.mode !== 'ai' || state.spectate || state.group || state.rts || isOnline()) return false;
  if(state.gameOver || !['move', 'fire', 'fight'].includes(state.phase)) return false;
  return !!state._matchMeta;
}
const humanTurn = () => state.turn && state.turn !== state.aiSide;
function quiet(){
  const dice = document.getElementById('diceOverlay');
  if(dice && dice.classList.contains('show')) return false;
  const prompt = document.querySelector('#diceOverlay .dice-panel.prompting');
  if(prompt) return false;
  if(state.pendingFight || state.pendingAmbush || state.replaying) return false;
  return !animating();
}
let animating = () => false;
export function setAnimatingProbe(fn){ animating = fn; }

function summary(){
  const me = state.aiSide === 'red' ? 'blue' : 'red';
  return {
    round: Math.max(1, Math.ceil((state.turnNumber || 1) / 2)), turnNumber: state.turnNumber || 1,
    playerSide: me, operation: state.scenario && state.scenario.kind === 'operation' ? state.scenario.name : null,
    alive: { red: state.units.filter(u => u.side === 'red' && !u.removed && u.type !== 'BRIGADIER').length,
      blue: state.units.filter(u => u.side === 'blue' && !u.removed && u.type !== 'BRIGADIER').length },
  };
}
async function write(resumeAt){
  try {
    const rec = currentRecord();
    const payload = { v: VERSION, savedAt: Date.now(), resumeAt, build: BUILD.commit, summary: summary(),
      snap: snapshotState(), rng: getRngState(), rec: rec && !rec.endedAt ? JSON.parse(JSON.stringify(rec)) : null };
    await io('readwrite', s => s.put(payload, KEY));
  } catch { /* storage refused: the game plays on regardless */ }
}

/* At the start of a phase, before it sets itself up. */
export function saveAtPhaseStart(phase){
  if(!saveable()) return;
  clearTimeout(soonT);
  write(phase);
}
/* During your own phase, a moment after an action settles. */
let soonT = null;
export function saveSoon(){
  if(!saveable() || !humanTurn()) return;
  clearTimeout(soonT);
  soonT = setTimeout(() => { if(saveable() && humanTurn() && quiet()) write('continue'); }, 1500);
}
/* Leaving the app: save now if the board is quiet on your turn. */
export function saveOnHide(){
  if(!saveable() || !humanTurn() || !quiet()) return;
  clearTimeout(soonT);
  write('continue');
}

export async function loadSave(){
  try { const s = await io('readonly', st => st.get(KEY)); return s && s.v === VERSION ? s : null; } catch { return null; }
}
export async function clearSave(){ clearTimeout(soonT); try { await io('readwrite', s => s.delete(KEY)); } catch { /* nothing to clear */ } }

/* A new battle is starting over an unfinished saved one: its record goes as an
   incomplete match (the telemetry's usual treatment of an abandoned one). */
export async function abandonSave(){
  const s = await loadSave();
  if(s && s.rec){ try { await queueRecord(recoverIncomplete(s.rec)); } catch { /* best effort */ } }
  await clearSave();
}

/* Puts the saved battle back. ui: the screen work only the game modules can
   do (battle layout, board size, ambience, phase start), passed in by the
   menu so this module stays free of them. */
export async function resumeSave(s, ui){
  if(!s) return false;
  resuming = true;
  try {
    restoreState(s.snap);
    setBoardMode(state.boardMode || 'standard');   // the board's size lives outside state (COLS, ROWS)
    setRngState(s.rng);
    if(s.rec) recResume(s.rec);
    ui.prepare();
    if(s.resumeAt === 'move') ui.beginMove();
    else if(s.resumeAt === 'fire') ui.beginFire();
    else if(s.resumeAt === 'fight') ui.beginFight();
    else ui.continueHere();
  } finally { resuming = false; }
  return true;
}

if(!HEADLESS && typeof document !== 'undefined'){
  document.addEventListener('visibilitychange', () => { if(document.hidden) saveOnHide(); });
  window.addEventListener('pagehide', () => saveOnHide());
}
