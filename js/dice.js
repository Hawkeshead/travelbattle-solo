const PIP_LAYOUT = {1:[4],2:[0,8],3:[0,4,8],4:[0,2,6,8],5:[0,2,4,6,8],6:[0,2,3,5,6,8]};
function dieFaceHTML(value, extraClass){
  const active = PIP_LAYOUT[value] || [];
  let cells = '';
  for(let i=0;i<9;i++) cells += active.includes(i) ? '<span class="pip"></span>' : '<span></span>';
  return `<div class="die ${extraClass||''}">${cells}</div>`;
}

// Shows a dice group in PENDING state (labels + bonus notes visible, dice faces
// blank) and waits for the roll to actually be triggered — a tap for a human
// player, or a brief pause for the AI, so it doesn't look abruptly different
// from watching a human turn. Nothing is randomized until onTrigger fires.
let FAST_DICE_MODE = false; // test/simulation harnesses only — never set by real gameplay
function presentRollTrigger(groups, triggerSide, onTrigger, legendText){
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
// onSettled fires once the popup has fully faded — board consequences (push-backs,
// removals, retreats) are deferred until then, so they never animate behind
// dice you're still reading.
function showDice(groups, resultText, resultCls, onSettled){
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
    overlay.classList.remove('show');
    if(onSettled) onSettled();
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
    } else {
      renderFrame(false);
    }
  }, 180);
  showDice._fadeT = setTimeout(()=>{
    overlay.classList.remove('show');
    if(onSettled) onSettled();
  }, 2900); // was 3400 — trimmed 500ms per feedback
}

