/* =========================================================
   THE OBJECTIVE PANEL (Operations and Campaigns brief, 2.7)

   A compact card in the map-panel style in the board's bottom-right corner
   while an Operation is played: "Round 3 of 8" and your side's one-line live
   status ("Village: French hold 2 squares"), shown at the start of each turn
   and folded to a small round tab after a few seconds. Tap it to unfold both
   sides' objectives in full with their status; tap again to fold it.
========================================================= */
import { SIDES, state } from './data-core.js';
import { currentRound, objectiveStatusLine, sideKey } from './engine-objectives.js';

let el = null, open = false, timer = null;
/* BETWEEN TURNS, NOT ALL THE TIME (Matthew, 4 Oct 2026): the panel comes up
   with your status at the start of each turn, stays for SHOW_MS, then folds
   to a small "Round 3 of 8" tab in the corner. Tap the tab to open both
   objectives in full; tap again to fold it. */
const SHOW_MS = 5000;
let shownForTurn = null, showUntil = 0;

function ensure(){
  if(el) return el;
  el = document.createElement('div');
  el.id = 'opPanel';
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  el.addEventListener('click', e => { e.stopPropagation(); open = !open; if(!open) showUntil = 0; render(); });
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
  if(state.turnNumber !== shownForTurn){ shownForTurn = state.turnNumber; showUntil = Date.now() + SHOW_MS; open = false; }
  const round = `Round ${Math.min(currentRound(), sc.turnLimit)} of ${sc.turnLimit}`;
  const tab = !open && Date.now() > showUntil;
  el.classList.toggle('tab', tab);
  el.innerHTML = open
    ? `<div class="opp-round">${round}</div>` + block(me, true) + block(them, false)
    : tab ? `<div class="opp-round">${round}</div>`
    : `<div class="opp-round">${round} · ${label(me)}</div><div class="opp-status">${objectiveStatusLine(me)}</div>`;
  el.classList.toggle('open', open);
}

export function showObjectivePanel(){
  ensure(); open = false; render();
  clearInterval(timer);
  timer = setInterval(() => { if(!state.scenario){ el.style.display = 'none'; clearInterval(timer); return; } render(); }, 600);
}
