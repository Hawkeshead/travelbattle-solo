import { state } from './data-core.js';

export const PIP_LAYOUT = {1:[4],2:[0,8],3:[0,4,8],4:[0,2,6,8],5:[0,2,4,6,8],6:[0,2,3,5,6,8]};
export function dieFaceHTML(value, extraClass){
  const active = PIP_LAYOUT[value] || [];
  let cells = '';
  for(let i=0;i<9;i++) cells += active.includes(i) ? '<span class="pip"></span>' : '<span></span>';
  return `<div class="die ${extraClass||''}">${cells}</div>`;
}

// Shows a dice group in PENDING state (labels + bonus notes visible, dice faces
// blank) and waits for the roll to actually be triggered — a tap for a human
// player, or a brief pause for the AI, so it doesn't look abruptly different
// from watching a human turn. Nothing is randomized until onTrigger fires.
export let FAST_DICE_MODE = false; // test/simulation harnesses only — never set by real gameplay

// Before the move to ES modules, a harness could flip FAST_DICE_MODE straight
// off the global scope. Module bindings aren't reachable that way, and an
// imported binding is read-only anyway, so the capability is exposed
// deliberately instead: as an accessor, and on a clearly-named test hook.
export function setFastDiceMode(on){
  FAST_DICE_MODE = !!on;
}

if(typeof window !== 'undefined'){
  window.__tbTest = Object.assign(window.__tbTest || {}, { setFastDiceMode });
}
/* ---------------------------------------------------------------------
   PENDING SETTLE — the re-entrancy guard for the roll pipeline.

   Every consequence of a resolved fight (pushback, retreat, removal,
   recording the attacker in state.fought, the replay entry, clearing
   charged) runs inside finishDice's onSettled callback, fired by a 2900ms
   timer. presentRollTrigger used to open by simply clearTimeout-ing that
   timer, which THREW THE CALLBACK AWAY. The dice panel is a small widget at
   the top of the screen and the board stays fully interactive underneath, so
   resolving a fight and then starting another one within 2.9 seconds meant
   the first fight's outcome silently never applied: nobody pushed back,
   nobody removed, and because state.fought was never written the first
   attacker could attack again.

   The callback is now owned here rather than living only inside a closure on
   the timer. Cancelling the timer FLUSHES it instead of discarding it, so a
   resolution always applies exactly once — either when its timer expires, or
   the moment anything else tries to start a new roll.

   flushPendingSettle clears the reference before invoking, so it is safe to
   call from anywhere and can never double-apply a result.
--------------------------------------------------------------------- */
let pendingSettle = null;

export function flushPendingSettle(){
  const cb = pendingSettle;
  pendingSettle = null;
  if(cb) cb();
}

export function presentRollTrigger(groups, triggerSide, onTrigger, legendText){
  const overlay = document.getElementById('diceOverlay');
  const groupsEl = overlay.querySelector('.dice-groups');
  const resultEl = overlay.querySelector('.dice-result');
  const rollBtn = document.getElementById('diceRollBtn');
  const legendEl = document.getElementById('diceLegend');
  // Apply any still-pending resolution BEFORE this new roll takes the panel
  // over. Cancelling the timer without this is what voided the previous fight.
  clearTimeout(showDice._fadeT);
  flushPendingSettle();
  clearInterval(showDice._rollT);
  clearTimeout(presentRollTrigger._aiT);

  overlay.classList.add('show');
  resultEl.textContent = '';
  resultEl.className = 'dice-result';
  if(legendEl){ legendEl.textContent = legendText || ''; legendEl.style.display = legendText ? 'block' : 'none'; }
  groupsEl.innerHTML = groups.map((g,i)=>{
    // The pending frame: placeholder faces before anything is rolled, so there is
    // no kept die and no adjustment to show yet.
    const diceHTML = Array(g.diceCount||1).fill(0).map(()=>dieFaceHTML(null,'pending')).join('');
    const notesHTML = (g.notes && g.notes.length) ?
      `<div class="dice-notes">${g.notes.map(n=>`<span>${n}</span>`).join('')}</div>` : '';
    const sep = i<groups.length-1 ? '<div class="dice-vs">vs</div>' : '';
    return `<div class="dice-group"><div class="glabel">${g.label}</div><div class="dice-set">${diceHTML}</div>${notesHTML}</div>${sep}`;
  }).join('');

  const isHuman = !(state.mode==='ai' && triggerSide===state.aiSide);
  if(FAST_DICE_MODE){ onTrigger(); return; }
  if(isHuman){
    rollBtn.textContent = 'Roll'; // reset from any previous fight's re-roll offer — see showDiceRerollButton, which never resets this itself, only its own caller should decide what a *fresh* prompt says
    rollBtn.className = 'primary';
    rollBtn.style.display = 'inline-block';
    rollBtn.disabled = false;
    rollBtn.onclick = ()=>{ rollBtn.style.display='none'; onTrigger(); };
  } else {
    rollBtn.style.display = 'none';
    presentRollTrigger._aiT = setTimeout(onTrigger, 550);
  }
}

// groups: [{label, rolls:[1,4], keptValue:4, ...}] — rolls is every die actually
// rolled for that side (bonus/re-roll dice included), keptValue is the one that counts.
// The animation is purely cosmetic: the real values are already decided by the time
// this is called, so it briefly flickers random faces before settling on them.
// holdOpen=true skips the auto-fade-and-dismiss (used when a re-roll might still be
// offered) — the caller is then responsible for calling finishDice() once ready.
/* The kept die and the value it COUNTS AS are not the same number.

   resolveFight keeps the best die, then adds any value bonuses (attacking a
   turned-around unit, springing an ambush, infantry or cavalry against
   artillery) and caps the total at 6. It hands this panel the raw faces in
   `rolls` and that adjusted total in `keptValue`.

   So a die showing 3 could be compared as 5 with nothing on screen saying so:
   a player reading the faces saw a winning margin of 3 and got a pushback. The
   highlight made it worse, marking whichever face happened to equal the
   adjusted total, which could mark the opponent's die and leave the player's
   own unmarked.

   The best raw die is now highlighted as the one kept, and where bonuses have
   moved the value away from it the arithmetic is shown. The reasons were
   already listed underneath; only the sum was missing. */
function diceValueParts(g){
  const any = (g.rolls && g.rolls.length) ? g.rolls : null;
  // The die that COUNTS. Supplied explicitly by the caller, because it cannot be
  // inferred from the faces: a second die is keep-best, but a RE-ROLL replaces
  // the result outright. A Guard rolling 5, re-rolling to 2 and fighting on 2
  // was having its discarded 5 highlighted as kept and "5 -3 = 2" printed
  // underneath, which reads as the board ignoring the dice. Falls back to
  // keep-best only when no kept die is given (rally and artillery rolls, which
  // are single dice and cannot be re-rolled).
  const bestRaw = (typeof g.keptValue === 'number') ? g.keptValue
                : any ? Math.max(...any) : null;
  const counts  = (typeof g.finalValue === 'number') ? g.finalValue : bestRaw;
  return { bestRaw, counts, adjusted: bestRaw !== null && counts !== bestRaw };
}

function adjustmentHTML(g){
  const { bestRaw, counts, adjusted } = diceValueParts(g);
  if(!adjusted) return '';
  const delta = counts - bestRaw;
  return `<div class="dice-adjust">${bestRaw} ${delta>0?'+':''}${delta} = <b>${counts}</b></div>`;
}

export function showDice(groups, resultText, resultCls, onSettled, holdOpen){
  const overlay = document.getElementById('diceOverlay');
  const groupsEl = overlay.querySelector('.dice-groups');
  const resultEl = overlay.querySelector('.dice-result');
  const rollBtn = document.getElementById('diceRollBtn');
  const legendEl = document.getElementById('diceLegend');
  if(legendEl) legendEl.style.display = 'none';
  rollBtn.style.display = 'none';
  // Same guard as presentRollTrigger: this also cancels the fade timer, so a
  // second showDice inside the window would otherwise void the first result.
  clearTimeout(showDice._fadeT);
  flushPendingSettle();
  clearInterval(showDice._rollT);

  function renderFrame(final){
    groupsEl.innerHTML = groups.map((g,i)=>{
      const { bestRaw } = diceValueParts(g);
      const diceHTML = g.rolls.map(v=>{
        const shown = final ? v : (1+Math.floor(Math.random()*6));
        const cls = final ? (v===bestRaw ? 'kept' : (g.rolls.length>1 ? 'discard' : '')) : 'rolling';
        return dieFaceHTML(shown, cls);
      }).join('');
      const adjustHTML = final ? adjustmentHTML(g) : '';
      const notesHTML = (final && g.notes && g.notes.length) ?
        `<div class="dice-notes">${g.notes.map(n=>`<span>${n}</span>`).join('')}</div>` : '';
      const sep = i<groups.length-1 ? '<div class="dice-vs">vs</div>' : '';
      return `<div class="dice-group"><div class="glabel">${g.label}</div><div class="dice-set">${diceHTML}</div>${adjustHTML}${notesHTML}</div>${sep}`;
    }).join('');
  }

  overlay.classList.add('show');
  resultEl.textContent = '';
  resultEl.className = 'dice-result';
  if(FAST_DICE_MODE){
    renderFrame(true);
    resultEl.textContent = resultText || '';
    resultEl.className = 'dice-result ' + (resultCls||'');
    if(!holdOpen){ overlay.classList.remove('show'); if(onSettled) onSettled(); }
    return;
  }
  renderFrame(false);
  let ticks = 0;
  showDice._rollT = setInterval(()=>{
    ticks++;
    if(ticks>=4){
      clearInterval(showDice._rollT);
      renderFrame(true);
      resultEl.textContent = resultText || '';
      resultEl.className = 'dice-result ' + (resultCls||'');
      if(!holdOpen) finishDice(onSettled);
    } else {
      renderFrame(false);
    }
  }, 180);
}

// Instantly updates the dice already on screen — no flicker, no fade timer.
// Used after a re-roll (the die already "rolled", we're just showing the new
// value) and for the final settle once any re-roll decisions are done, so the
// flicker-in only ever plays once, on the very first reveal.
export function refreshDiceFrame(groups, resultText, resultCls){
  const overlay = document.getElementById('diceOverlay');
  const groupsEl = overlay.querySelector('.dice-groups');
  const resultEl = overlay.querySelector('.dice-result');
  groupsEl.innerHTML = groups.map((g,i)=>{
    const { bestRaw } = diceValueParts(g);
    const diceHTML = g.rolls.map(v=>{
      const cls = v===bestRaw ? 'kept' : (g.rolls.length>1 ? 'discard' : '');
      return dieFaceHTML(v, cls);
    }).join('');
    const adjustHTML = adjustmentHTML(g);
    const notesHTML = (g.notes && g.notes.length) ?
      `<div class="dice-notes">${g.notes.map(n=>`<span>${n}</span>`).join('')}</div>` : '';
    const sep = i<groups.length-1 ? '<div class="dice-vs">vs</div>' : '';
    return `<div class="dice-group"><div class="glabel">${g.label}</div><div class="dice-set">${diceHTML}</div>${adjustHTML}${notesHTML}</div>${sep}`;
  }).join('');
  resultEl.textContent = resultText || '';
  resultEl.className = 'dice-result ' + (resultCls||'');
}

// A button under the dice, not a separate modal — used for the re-roll offer.
// Auto-declines after a few seconds so the popup can't hang forever if the
// player just doesn't act on it.
export function showDiceRerollButton(label, onAccept, onDecline){
  const rollBtn = document.getElementById('diceRollBtn');
  clearTimeout(showDiceRerollButton._t);
  rollBtn.textContent = label;
  rollBtn.style.display = 'inline-block';
  rollBtn.disabled = false;
  rollBtn.className = 'primary';
  rollBtn.onclick = ()=>{
    clearTimeout(showDiceRerollButton._t);
    rollBtn.style.display = 'none';
    rollBtn.className = '';
    onAccept();
  };
  showDiceRerollButton._t = setTimeout(()=>{
    rollBtn.style.display = 'none';
    rollBtn.className = '';
    onDecline();
  }, 4500);
}

// Starts the normal fade-and-dismiss — call once the dice popup is showing its
// true final state (no more re-roll offers pending).
export function finishDice(onSettled){
  const overlay = document.getElementById('diceOverlay');
  clearTimeout(showDice._fadeT);
  // Anything still outstanding from an earlier fight applies now, before this
  // one takes its place. Only one resolution is ever pending at a time.
  flushPendingSettle();
  if(FAST_DICE_MODE){ overlay.classList.remove('show'); if(onSettled) onSettled(); return; }
  pendingSettle = onSettled || null;
  showDice._fadeT = setTimeout(()=>{
    overlay.classList.remove('show');
    flushPendingSettle();
  }, 2900);
}

