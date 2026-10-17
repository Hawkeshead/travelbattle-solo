/* =========================================================
   FRIENDLY AI COMMANDERS (17 Oct 2026, Quick Battle)

   In a Quick Battle the player may hand any of their own Brigades to an AI
   commander (state.friendlyAi, chosen on the Brigades screen in ui-menus.js).
   At the start of each of the player's Move, Fire and Fight phases the AI
   acts first with those Brigades, the camera following it, using the same
   AI partner the online "1 + AI" mode uses (startAiPartner); then the player
   acts with the rest and ends the phase as usual. While it acts, its rolls
   roll themselves and its questions (re-rolls, Leadership, ambushes) are its
   own; the player can look at its units but not give them orders.

   With no Brigade handed over (every other game) nothing here does anything.
========================================================= */
import { friendlyAiCommands, state } from './data-core.js';
import { setLocalCommand } from './online-session.js';
import { startAiPartner } from './ai-strategy.js';
import { cameraRestorePlayerView, draw } from './render-board.js';
import { selectUnit, updateHeader } from './ui-battle.js';
import { maybeStartAutoEnd } from './phase-autoend.js';

const acting = () => !!state._aiPartnerActing;
setLocalCommand({
  ownsUnit: u => !acting() && !friendlyAiCommands(u),
  asksElsewhere: u => friendlyAiCommands(u),
  // Nothing of the player's while the AI commander is still acting.
  interceptOrder: () => { if(!acting()) return false; note('Your AI commander is still acting'); return true; },
  commanderNote: u => friendlyAiCommands(u) ? 'AI commander' : null,
});

/* Does the side have a living unit under a friendly AI commander? */
const hasFriendlyAi = side => !!(state.friendlyAi && state.friendlyAi.length) &&
  state.units.some(u => !u.removed && u.side === side && friendlyAiCommands(u));

/* Called by beginMovePhase, beginFirePhase and beginFightPhase on the
   player's turn. True if the AI commander has started acting (the phase's
   own auto end then waits until it has finished); false to carry on. */
export function runFriendlyAi(phase){
  const side = state.turn;
  if(state.gameOver || state.mode !== 'ai' || side === state.aiSide || state.spectate || state.group) return false;
  if(!hasFriendlyAi(side)) return false;
  state._aiPartnerActing = side;
  selectUnit(null);
  endButton(phase, true); updateHeader();
  note({ move: 'Your AI commander is moving its Brigades', fire: 'Your AI commander is firing', fight: 'Your AI commander is fighting' }[phase]);
  setTimeout(() => startAiPartner(side, phase, u => friendlyAiCommands(u), () => {
    state._aiPartnerActing = null;
    cameraRestorePlayerView();
    endButton(phase, false); updateHeader(); draw();
    if(!state.gameOver && state.phase === phase){
      note('Your turn: your own Brigades');
      maybeStartAutoEnd();
    }
  }), 400);
  return true;
}

/* The phase's End button is off while the AI commander acts. */
function endButton(phase, off){
  const b = document.getElementById({ move: 'endMoveBtn', fire: 'endFireBtn', fight: 'endFightBtn' }[phase]);
  if(b) b.disabled = off;
}

/* A short line at the top of the screen. */
let timer = null;
function note(text, ms = 3000){
  let pill = document.getElementById('friendlyAiPill');
  if(!pill){
    pill = document.createElement('div'); pill.id = 'friendlyAiPill';
    pill.style.cssText = 'position:fixed;top:calc(env(safe-area-inset-top,0px) + 44px);left:50%;transform:translateX(-50%);z-index:29;' +
      'font:14px "IM Fell English",Georgia,serif;color:#fbf6ea;background:rgba(20,24,20,.82);padding:4px 12px;border-radius:14px;' +
      'pointer-events:none;white-space:nowrap;opacity:0;transition:opacity .4s';
    document.body.appendChild(pill);
  }
  pill.textContent = text;
  pill.style.opacity = '1';
  clearTimeout(timer);
  timer = setTimeout(() => { pill.style.opacity = '0'; }, ms);
}
