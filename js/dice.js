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
export function presentRollTrigger(groups, triggerSide, onTrigger, legendText){
  const overlay = document.getElementById('diceOverlay');
  const groupsEl = overlay.querySelector('.dice-groups');
  const resultEl = overlay.querySelector('.dice-result');
  const rollBtn = document.getElementById('diceRollBtn');
  const legendEl = document.getElementById('diceLegend');
  clearTimeout(showDice._fadeT);
  clearInterval(showDice._rollT);
  clearTimeout(presentRollTrigger._aiT);

  overlay.classList.add('show');
  resultEl.textContent = '';
  resultEl.className = 'dice-result';
  if(legendEl){ legendEl.textContent = legendText || ''; legendEl.style.display = legendText ? 'block' : 'none'; }
  groupsEl.innerHTML = groups.map((g,i)=>{
    const diceHTML = Array(g.diceCount||1).fill(0).map(()=>dieFaceHTML(null,'pending')).join('');
    const notesHTML = (g.notes && g.notes.length) ?
      `<div class="dice-notes">${g.notes.map(n=>`<span>${n}</span>`).join('')}</div>` : '';
    const sep = i<groups.length-1 ? '<div class="dice-vs">vs</div>' : '';
    return `<div class="dice-group"><div class="glabel">${g.label}</div><div class="dice-set">${diceHTML}</div>${notesHTML}</div>${sep}`;
  }).join('');

  const isHuman = !(state.mode==='ai' && triggerSide===state.aiSide);
  if(FAST_DICE_MODE){ onTrigger(); return; }
  if(isHuman){
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
export function showDice(groups, resultText, resultCls, onSettled, holdOpen){
  const overlay = document.getElementById('diceOverlay');
  const groupsEl = overlay.querySelector('.dice-groups');
  const resultEl = overlay.querySelector('.dice-result');
  const rollBtn = document.getElementById('diceRollBtn');
  const legendEl = document.getElementById('diceLegend');
  if(legendEl) legendEl.style.display = 'none';
  rollBtn.style.display = 'none';
  clearTimeout(showDice._fadeT);
  clearInterval(showDice._rollT);

  function renderFrame(final){
    groupsEl.innerHTML = groups.map((g,i)=>{
      const diceHTML = g.rolls.map(v=>{
        const shown = final ? v : (1+Math.floor(Math.random()*6));
        const cls = final ? (v===g.keptValue ? 'kept' : (g.rolls.length>1 ? 'discard' : '')) : 'rolling';
        return dieFaceHTML(shown, cls);
      }).join('');
      const notesHTML = (final && g.notes && g.notes.length) ?
        `<div class="dice-notes">${g.notes.map(n=>`<span>${n}</span>`).join('')}</div>` : '';
      const sep = i<groups.length-1 ? '<div class="dice-vs">vs</div>' : '';
      return `<div class="dice-group"><div class="glabel">${g.label}</div><div class="dice-set">${diceHTML}</div>${notesHTML}</div>${sep}`;
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
    const diceHTML = g.rolls.map(v=>{
      const cls = v===g.keptValue ? 'kept' : (g.rolls.length>1 ? 'discard' : '');
      return dieFaceHTML(v, cls);
    }).join('');
    const notesHTML = (g.notes && g.notes.length) ?
      `<div class="dice-notes">${g.notes.map(n=>`<span>${n}</span>`).join('')}</div>` : '';
    const sep = i<groups.length-1 ? '<div class="dice-vs">vs</div>' : '';
    return `<div class="dice-group"><div class="glabel">${g.label}</div><div class="dice-set">${diceHTML}</div>${notesHTML}</div>${sep}`;
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
  if(FAST_DICE_MODE){ overlay.classList.remove('show'); if(onSettled) onSettled(); return; }
  showDice._fadeT = setTimeout(()=>{
    overlay.classList.remove('show');
    if(onSettled) onSettled();
  }, 2900);
}

