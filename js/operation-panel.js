/* =========================================================
   THE OBJECTIVE PANEL (Operations and Campaigns brief, 2.7)

   A compact card in the map-panel style in the board's bottom-right corner
   while an Operation is played: "Round 3 of 8" and your side's one-line live
   status ("Village: French hold 2 squares"). Tap it to unfold both sides'
   objectives in full with their status; tap again to fold it.
========================================================= */
import { SIDES, state } from './data-core.js';
import { currentRound, objectiveStatusLine, sideKey } from './engine-objectives.js';

let el = null, open = false, timer = null;

function ensure(){
  if(el) return el;
  el = document.createElement('div');
  el.id = 'opPanel';
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  el.addEventListener('click', e => { e.stopPropagation(); open = !open; render(); });
  document.body.appendChild(el);
  return el;
}
const playerSide = () => (state.mode === 'ai' && !state.spectate ? (state.aiSide === SIDES.RED ? SIDES.BLUE : SIDES.RED) : (state.turn || SIDES.RED));
const label = side => (side === SIDES.RED ? 'Britain' : 'France');

function render(){
  const sc = state.scenario;
  if(!el) return;
  if(!sc || !sc.win || typeof sc.win !== 'object' || state.phase === 'deploy'){ el.style.display = 'none'; return; }
  el.style.display = 'block';
  const me = playerSide(), them = me === SIDES.RED ? SIDES.BLUE : SIDES.RED;
  const block = (side, mine) => `<div class="opp-side${mine ? ' mine' : ''}"><div class="opp-who">${label(side)}${mine ? ' (you)' : ''}</div>` +
    `<div class="opp-text">${sc.win[sideKey(side)].text}</div><div class="opp-status">${objectiveStatusLine(side)}</div></div>`;
  /* Folded (the default): the round and your side's live status, two short
     lines, so it covers as little of the board as possible. Open: both sides'
     objectives in full, with their status. */
  el.innerHTML = open
    ? `<div class="opp-round">Round ${Math.min(currentRound(), sc.turnLimit)} of ${sc.turnLimit}</div>` + block(me, true) + block(them, false)
    : `<div class="opp-round">Round ${Math.min(currentRound(), sc.turnLimit)} of ${sc.turnLimit} · ${label(me)}</div><div class="opp-status">${objectiveStatusLine(me)}</div>`;
  el.classList.toggle('open', open);
}

export function showObjectivePanel(){
  ensure(); open = false; render();
  clearInterval(timer);
  timer = setInterval(() => { if(!state.scenario){ el.style.display = 'none'; clearInterval(timer); return; } render(); }, 600);
}
