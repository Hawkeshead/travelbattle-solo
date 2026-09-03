/* =========================================================
   PHASE AUTO-END COUNTDOWN

   A phase that has nothing left to do should end itself, but not
   instantly: a player who has just moved their last unit needs a moment
   to see the board settle, and sometimes to change their mind. So each
   phase, once every legal action in it has been taken, starts a visible
   four-second countdown on its own End button. Pressing the button ends
   the phase at once; pressing Undo stops the clock dead.

   Only the human's turn counts down. The AI drives its own phase
   transitions directly and would only be slowed by this.

   The three completion tests live here rather than in ui-battle.js so
   there is one place to read when the answer to "why did my turn end?"
   is not obvious:

     move   — no unit on this side has a legal destination left
     fire   — no gun on this side has a legal target left
     fight  — no unit on this side can still initiate a fight

   legalMoves() and artilleryTargets() already encode every exclusion
   these need (already acted, turned around from a pushback, in Square,
   disconnected from its Brigadier, gun that moved this turn, gun in
   contact and therefore fighting rather than firing), so the tests are
   deliberately thin wrappers rather than a second copy of those rules
   that could drift away from them. The move test goes through
   hasAnyLegalMove rather than legalMoves directly, because legalMoves
   leaves a breadcrumb trail behind it that the move animation reads —
   see the note on that function.
========================================================= */
import { state } from './data-core.js';
import { artilleryTargets, hasAnyLegalMove } from './engine-rules.js';

export const AUTO_END_MS = 4000;
const TICK_MS = 100;

const END_BUTTON_ID = { move: 'endMoveBtn', fire: 'endFireBtn', fight: 'endFightBtn' };

/* ui-battle.js owns the end-phase functions and anyFightsAvailable, and hands
   them over at boot rather than being imported from here.

   To be accurate about why: this module is ALREADY inside the codebase's import
   cycle, and unavoidably so — engine-rules.js imports ui-battle.js, so anything
   that needs legalMoves is in the same knot. The registration is not escaping a
   cycle it could otherwise avoid.

   What it does buy is that nothing here reads a ui-battle binding at module
   evaluation time. Function declarations hoist and so survive a cycle; a
   top-level const read across one does not. Keeping the dependency one-way and
   late-bound means this file cannot be the one that turns a latent ordering
   problem into a live TypeError. */
let enders = null;
let fightsAvailableFn = null;
export function registerPhaseEnders(endersByPhase, anyFightsAvailableFn){
  enders = endersByPhase;
  fightsAvailableFn = anyFightsAvailableFn;
}

let ticker = null;
let countingPhase = null;
let deadline = 0;
let restoreLabel = '';

function buttonFor(phase){
  const id = END_BUTTON_ID[phase];
  return id ? document.getElementById(id) : null;
}

// True while a modal is up. The countdown pauses rather than cancels here: a
// dice roll resolving is not the player declining to end their phase, and
// undoLastAction already refuses to run while dice are on screen, so cancelling
// would leave no way to stop the clock during the one window it is unstoppable.
function modalIsBlocking(){
  for(const id of ['diceOverlay', 'overlay']){
    const el = document.getElementById(id);
    if(el && el.classList.contains('show')) return true;
  }
  return false;
}

function isHumanTurn(){
  if(state.gameOver) return false;
  return !(state.mode === 'ai' && state.turn === state.aiSide);
}

/* Every legal action in `phase` has been taken by the side whose turn it is. */
export function phaseActionsComplete(phase){
  const side = state.turn;
  const mine = state.units.filter(u => !u.removed && u.side === side);
  if(phase === 'move')  return !mine.some(u => hasAnyLegalMove(u));
  if(phase === 'fire')  return !mine.some(u => artilleryTargets(u).length > 0);
  if(phase === 'fight') return !(fightsAvailableFn && fightsAvailableFn(side));
  return false;
}

function paint(secondsLeft){
  const btn = buttonFor(countingPhase);
  if(btn) btn.textContent = `${restoreLabel} (${secondsLeft})`;
}

export function cancelAutoEnd(){
  if(ticker){ clearInterval(ticker); ticker = null; }
  if(countingPhase){
    const btn = buttonFor(countingPhase);
    if(btn && restoreLabel) btn.textContent = restoreLabel;
  }
  countingPhase = null;
  deadline = 0;
  restoreLabel = '';
}

export function autoEndRunning(){ return ticker !== null; }

/* Called after every human action and at the start of each human phase.
   Starts the countdown if the phase is finished, and stops it if it isn't —
   so undoing a move, or any action that opens up a new legal option, takes
   the clock away again without every caller having to know that it should. */
export function maybeStartAutoEnd(){
  const phase = state.phase;
  if(!END_BUTTON_ID[phase] || !isHumanTurn() || !enders){ cancelAutoEnd(); return; }
  if(!phaseActionsComplete(phase)){ cancelAutoEnd(); return; }
  if(countingPhase === phase) return; // already running for this phase — don't restart the clock under the player

  cancelAutoEnd();
  const btn = buttonFor(phase);
  if(!btn || btn.disabled || btn.style.display === 'none') return;

  countingPhase = phase;
  restoreLabel = btn.textContent;
  deadline = Date.now() + AUTO_END_MS;
  paint(Math.ceil(AUTO_END_MS / 1000));

  ticker = setInterval(()=>{
    // Phase changed under us (the player pressed the button, or a fight
    // resolution moved things on). Nothing to count towards any more.
    if(state.phase !== countingPhase || !isHumanTurn()){ cancelAutoEnd(); return; }
    if(modalIsBlocking()){ deadline = Math.max(deadline, Date.now() + TICK_MS); return; }
    const remaining = deadline - Date.now();
    if(remaining > 0){ paint(Math.max(1, Math.ceil(remaining / 1000))); return; }
    const finish = enders[countingPhase];
    cancelAutoEnd();
    if(finish) finish();
  }, TICK_MS);
}
