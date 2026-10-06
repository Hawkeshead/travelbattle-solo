import { AudioManager } from './audio-manager.js';
import { humanOwns } from './data-core.js';
import { DICE_FACES, DICE_NATION, DICE_TUMBLE_FRAMES, diceArtPaths, diceFacePath, diceTumblePath } from './dice-art.js';

export const PIP_LAYOUT = {1:[4],2:[0,8],3:[0,4,8],4:[0,2,6,8],5:[0,2,4,6,8],6:[0,2,3,5,6,8]};

/* =========================================================
   DICE ART. Each die is drawn with the rolling side's own dice (js/dice-art.js):
   red with silver pips for Britain, blue with gold for France. The art is
   preloaded here; any die whose images are not ready yet falls back to the
   old pip grid, so a die never shows blank.
========================================================= */
const DICE_IMG = {};
if(typeof Image !== 'undefined'){
  for(const path of diceArtPaths()){ const img = new Image(); img.src = path; DICE_IMG[path] = img; }
}
const imgReady = path => { const i = DICE_IMG[path]; return !!(i && i.complete && i.naturalWidth > 0); };
const nationOf = side => (side && DICE_NATION[side]) || null;
/* Every face and every tumble frame of that nation is ready. */
function artReady(nation){
  if(!nation) return false;
  for(let v = 1; v <= DICE_FACES; v++) if(!imgReady(diceFacePath(nation, v))) return false;
  for(let i = 1; i <= DICE_TUMBLE_FRAMES; i++) if(!imgReady(diceTumblePath(nation, i))) return false;
  return true;
}

/* value: the face (null before the roll: face 1, dimmed); side: who rolled. */
export function dieFaceHTML(value, extraClass, side){
  const nation = nationOf(side);
  if(nation && artReady(nation)){
    return `<div class="die die-art ${extraClass||''}"><img src="${diceFacePath(nation, value || 1)}" alt="${value || ''}" draggable="false"></div>`;
  }
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

/* BATTLE BED: sound under the dice while a fight is being resolved.

   Driven by a MutationObserver on the overlay's class rather than by the
   callers. The panel is closed from three separate places (showDice when it is
   not held open, finishDice's timer, and the fast-dice path), and a re-roll
   keeps it open for an unknown extra span. Asking every one of those to remember
   to stop the sound is exactly the arrangement that failed for the desk folio,
   where a shared box was left in the wrong state because one caller forgot.
   Watching the thing itself cannot fall out of step.

   ARMED ONLY FOR MELEE. Artillery uses the same panel and must stay silent under
   it: the gun has its own report and its own shell. resolveFight arms this before
   it opens the panel; nothing else does, so artillery never triggers it. */
let battleBedArmed = false;
let battleBedObserver = null;

export function armBattleBed(){
  battleBedArmed = true;
  ensureBattleBedObserver();
  /* The bed is also started from presentRollTrigger, which is the single place
     the panel is opened for a fight. Starting here as well covers the ordinary
     case and costs nothing, since startLoop is a no-op when already running. */
  /* START HERE rather than waiting for the observer to see the panel open.

     The caller arms this immediately before opening the panel, so the sound can
     begin now. Relying on the open-mutation was fragile: when panels chain back
     to back, as they do all through an AI turn, classList.add('show') on an
     overlay that is already showing changes nothing and fires no mutation, so
     the bed never started for AI-initiated fights.

     The observer still owns the STOP, which is the half that has to be reliable:
     the panel closes from three different places and none of them can be trusted
     to remember. Starting explicitly and stopping by observation gives each job
     to whichever is actually dependable at it. */
  AudioManager.startLoop('battle-resolve', 'audio/effects/battle-resolve.wav', 'effects');
}

function ensureBattleBedObserver(){
  if(battleBedObserver) return;
  const overlay = document.getElementById('diceOverlay');
  if(!overlay) return;
  battleBedObserver = new MutationObserver(()=>{
    const open = overlay.classList.contains('show');
    if(open && battleBedArmed){
      AudioManager.startLoop('battle-resolve', 'audio/effects/battle-resolve.wav', 'effects');  // no-op if already running
    } else if(!open){
      // Sharp rather than gentle: the dice are gone, so should the noise be.
      AudioManager.stopLoop('battle-resolve', 140);
      battleBedArmed = false;
    }
  });
  battleBedObserver.observe(overlay, { attributes:true, attributeFilter:['class'] });
}

/* =========================================================
   MIRRORING FOR ONLINE PLAY

   The phone whose player is acting runs every roll. Each time the panel opens,
   rolls, refreshes or finishes, it reports what it showed through mirrorOut,
   and online.js sends that across. The other phone calls replayDice, which runs
   the same four functions with the same numbers and no consequences: its
   callbacks do nothing, because the rules only run on the rolling phone.
   `replaying` stops a mirrored call being reported straight back.
========================================================= */
let mirrorOut = null, replaying = false;
export function setDiceMirror(fn){ mirrorOut = fn; }
function emit(kind, args){ if(mirrorOut && !replaying) mirrorOut(kind, args); }
export function replayDice(kind, a, onFinished){
  replaying = true;
  try {
    if(kind === 'trigger') presentRollTrigger(a.groups, a.watchSide, ()=>{}, a.legendText);
    else if(kind === 'show') showDice(a.groups, a.resultText, a.resultCls, ()=>{}, a.holdOpen);
    else if(kind === 'refresh') refreshDiceFrame(a.groups, a.resultText, a.resultCls);
    else if(kind === 'finish') finishDice(onFinished);
  } finally { replaying = false; }
}

export function presentRollTrigger(groups, triggerSide, onTrigger, legendText){
  emit('trigger', { groups, legendText });
  const overlay = document.getElementById('diceOverlay');
  const groupsEl = overlay.querySelector('.dice-groups');
  const resultEl = overlay.querySelector('.dice-result');
  const rollBtn = document.getElementById('diceRollBtn');
  const legendEl = document.getElementById('diceLegend');
  // Apply any still-pending resolution BEFORE this new roll takes the panel
  // over. Cancelling the timer without this is what voided the previous fight.
  clearTimeout(showDice._fadeT);
  flushPendingSettle();
  clearInterval(showDice._rollT); clearTimeout(showDice._rollEndT);
  clearTimeout(presentRollTrigger._aiT);
  unlockDicePanel();   // a new question sizes itself; the roll that follows then holds that size or grows once

  /* THE BED STARTS HERE, in the one function that opens the panel for a fight.

     armBattleBed starts it too, and that is enough for a straightforward melee.
     But that depends on the arm and the open happening together, and they do
     not always: a cavalry charge and an ambush both reach resolveFight through
     extra steps, and the observer cannot cover the gap because classList.add on
     an overlay that is already showing fires no mutation.

     presentRollTrigger runs for EVERY fight without exception, so starting from
     here cannot be missed. Guarded by the armed flag, so artillery keeps the
     same panel and stays silent under it (it has its own report and shell), and
     so does the rally roll. */
  if(battleBedArmed){
    AudioManager.startLoop('battle-resolve', 'audio/effects/battle-resolve.wav', 'effects');
  }
  overlay.classList.add('show');
  resultEl.textContent = '';
  resultEl.className = 'dice-result';
  if(legendEl){ legendEl.textContent = legendText || ''; legendEl.style.display = legendText ? 'block' : 'none'; }
  groupsEl.innerHTML = groups.map((g,i)=>{
    // The pending frame: placeholder faces before anything is rolled, so there is
    // no kept die and no adjustment to show yet.
    // The pending frame carries the portraits too, so the fight is legible as
    // "who against whom" while the player is still deciding whether to roll.
    const faceHTML = g.portrait ? `<div class="dice-face">${g.portrait}</div>` : '';
    const whoHTML = g.unitName ? `<div class="dice-who">${g.unitName}</div>` : '';
    const diceHTML = Array(g.diceCount||1).fill(0).map(()=>dieFaceHTML(null,'pending', g.side)).join('');
    const notesHTML = (g.notes && g.notes.length) ?
      `<div class="dice-notes">${g.notes.map(n=>`<span>${n}</span>`).join('')}</div>` : '';
    const sep = i<groups.length-1 ? '<div class="dice-vs">vs</div>' : '';
    return `<div class="dice-group">${faceHTML}<div class="glabel">${g.label}</div>${whoHTML}<div class="dice-set">${diceHTML}</div>${notesHTML}</div>${sep}`;
  }).join('');

  /* humanOwns, not "is it the AI's side": in Spectate state.aiSide follows
     whichever side is acting, so a roll that belongs to the other side (the
     defender's, a rally) read as a person's and waited for a Roll tap that
     nobody was there to give. humanOwns answers no for every side in Spectate. */
  const isHuman = humanOwns(triggerSide);
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

/* ONE PANEL SIZE PER ROLL. The panel used to grow when the dice landed (the
   notes and the result line only appear then), so it jumped in size between
   the tumble and the result. Now, before the tumble starts, the final frame is
   laid out once in the same tick (never painted), its size measured, and the
   panel held at that size (or the size it already had, if larger) until it
   closes or the next question takes it over. min-height rather than height, so
   a re-roll that adds a note can still grow it rather than spill. */
export function unlockDicePanel(){
  const panel = document.querySelector('#diceOverlay .dice-panel');
  if(!panel) return;
  panel.style.width = ''; panel.style.minHeight = ''; panel.style.boxSizing = '';
  panel.classList.remove('size-locked');
}
function lockDicePanelTo(layoutFinal){
  const panel = document.querySelector('#diceOverlay .dice-panel');
  const before = panel.classList.contains('size-locked') || document.getElementById('diceOverlay').classList.contains('show')
    ? { w: panel.offsetWidth, h: panel.offsetHeight } : { w: 0, h: 0 };
  panel.style.width = ''; panel.style.minHeight = '';
  layoutFinal();
  const w = Math.max(before.w, panel.offsetWidth), h = Math.max(before.h, panel.offsetHeight);
  panel.style.boxSizing = 'border-box';
  panel.style.width = w + 'px';
  panel.style.minHeight = h + 'px';
  panel.classList.add('size-locked');
}

export function showDice(groups, resultText, resultCls, onSettled, holdOpen){
  emit('show', { groups, resultText, resultCls, holdOpen });
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
  clearInterval(showDice._rollT); clearTimeout(showDice._rollEndT);

  function renderFrame(final, settling){
    let k = 0;
    groupsEl.innerHTML = groups.map((g,i)=>{
      const { bestRaw } = diceValueParts(g);
      const diceHTML = g.rolls.map(v=>{
        const shown = final ? v : (1+Math.floor(Math.random()*6));
        const cls = final ? (v===bestRaw ? 'kept' : (g.rolls.length>1 ? 'discard' : '')) : 'rolling';
        const settle = final && settling && settling.has(k) ? ' settle' : '';
        k++;
        return dieFaceHTML(shown, cls + settle, g.side);
      }).join('');
      const adjustHTML = final ? adjustmentHTML(g) : '';
      // Portrait and regiment name, so a fight reads as "who against whom"
      // rather than just "Britain vs France". Absent for rally and artillery
      // rolls, which are not unit-against-unit.
      const faceHTML = g.portrait ? `<div class="dice-face">${g.portrait}</div>` : '';
      const whoHTML = g.unitName ? `<div class="dice-who">${g.unitName}</div>` : '';
      const notesHTML = (final && g.notes && g.notes.length) ?
        `<div class="dice-notes">${g.notes.map(n=>`<span>${n}</span>`).join('')}</div>` : '';
      const sep = i<groups.length-1 ? '<div class="dice-vs">vs</div>' : '';
      return `<div class="dice-group">${faceHTML}<div class="glabel">${g.label}</div>${whoHTML}<div class="dice-set">${diceHTML}</div>${adjustHTML}${notesHTML}</div>${sep}`;
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
  // Held at the size the result will need, so it does not jump when the dice land.
  lockDicePanelTo(() => {
    renderFrame(true);
    resultEl.textContent = resultText || '';
    resultEl.className = 'dice-result ' + (resultCls||'');
  });
  resultEl.textContent = '';
  resultEl.className = 'dice-result';
  const settleNow = settling => {
    clearInterval(showDice._rollT); clearTimeout(showDice._rollEndT);
    renderFrame(true, settling);
    resultEl.textContent = resultText || '';
    resultEl.className = 'dice-result ' + (resultCls||'');
    if(!holdOpen) finishDice(onSettled);
  };
  if(groups.every(g => artReady(nationOf(g.side)))){ tumble(settleNow); return; }
  // Without the art: the old flicker of random faces.
  renderFrame(false);
  let ticks = 0;
  showDice._rollT = setInterval(()=>{
    ticks++;
    if(ticks>=4) settleNow(null);
    else renderFrame(false);
  }, 180);

  /* THE TUMBLE. Each die cycles its own nation's tumble frames (never the same
     frame twice running) every TUMBLE_FRAME_MS, each frame turned up to 25
     degrees and nudged a few pixels, so every die moves on its own. The dice
     land one after another, TUMBLE_STAGGER_MS apart, the last exactly when
     the old flicker ended (ROLL_MS), so the result appears at the same moment
     as before and the pace of play is unchanged. A die lands on its real face
     with a quick settle (1.08 back to 1 over 120 ms). */
  function tumble(done){
    renderFrame(false);
    const dieEls = [...groupsEl.querySelectorAll('.die')];
    const nations = [];
    groups.forEach(g => g.rolls.forEach(() => nations.push(nationOf(g.side))));
    const values = [];
    groups.forEach(g => g.rolls.forEach(v => values.push(v)));
    const n = dieEls.length;
    const landAt = dieEls.map((_, k) => Math.max(TUMBLE_FRAME_MS * 3, ROLL_MS - (n - 1 - k) * TUMBLE_STAGGER_MS));
    const lastFrame = dieEls.map(() => 0);
    const landed = new Set();
    const t0 = performance.now();
    const step = () => {
      const el = performance.now() - t0;
      dieEls.forEach((d, k) => {
        const img = d.querySelector('img');
        if(!img || landed.has(k)) return;
        if(el >= landAt[k]){
          landed.add(k);
          img.src = diceFacePath(nations[k], values[k]);
          img.style.transform = '';
          d.classList.remove('rolling');
          d.classList.add('settle');
          return;
        }
        let f;
        do { f = 1 + Math.floor(Math.random() * DICE_TUMBLE_FRAMES); } while(f === lastFrame[k] && DICE_TUMBLE_FRAMES > 1);
        lastFrame[k] = f;
        img.src = diceTumblePath(nations[k], f);
        const rot = (Math.random() * 2 - 1) * TUMBLE_MAX_TURN_DEG;
        const dx = (Math.random() * 2 - 1) * TUMBLE_MAX_NUDGE_PX, dy = (Math.random() * 2 - 1) * TUMBLE_MAX_NUDGE_PX;
        img.style.transform = `translate(calc(-50% + ${dx.toFixed(1)}px), calc(-50% + ${dy.toFixed(1)}px)) rotate(${rot.toFixed(1)}deg)`;
      });
    };
    step();
    showDice._rollT = setInterval(step, TUMBLE_FRAME_MS);
    // The end is timed on its own, not on the 70 ms beat, so the result shows at
    // exactly ROLL_MS as before (a beat would land it up to 70 ms late).
    showDice._rollEndT = setTimeout(() => {
      // The last die lands now: it is still settling in the final frame.
      const settling = new Set(dieEls.map((_, k) => k).filter(k => ROLL_MS - landAt[k] < TUMBLE_SETTLE_MS));
      done(settling);
    }, ROLL_MS);
  }
}
const ROLL_MS = 720;                // 4 x 180 ms: when the old flicker ended and the result appeared
const TUMBLE_FRAME_MS = 70;
const TUMBLE_STAGGER_MS = 80;
const TUMBLE_SETTLE_MS = 120;
const TUMBLE_MAX_TURN_DEG = 25;
const TUMBLE_MAX_NUDGE_PX = 3;

// Instantly updates the dice already on screen — no flicker, no fade timer.
// Used after a re-roll (the die already "rolled", we're just showing the new
// value) and for the final settle once any re-roll decisions are done, so the
// flicker-in only ever plays once, on the very first reveal.
export function refreshDiceFrame(groups, resultText, resultCls){
  emit('refresh', { groups, resultText, resultCls });
  const overlay = document.getElementById('diceOverlay');
  const groupsEl = overlay.querySelector('.dice-groups');
  const resultEl = overlay.querySelector('.dice-result');
  groupsEl.innerHTML = groups.map((g,i)=>{
    const { bestRaw } = diceValueParts(g);
    const diceHTML = g.rolls.map(v=>{
      const cls = v===bestRaw ? 'kept' : (g.rolls.length>1 ? 'discard' : '');
      return dieFaceHTML(v, cls, g.side);
    }).join('');
    const adjustHTML = adjustmentHTML(g);
    const faceHTML = g.portrait ? `<div class="dice-face">${g.portrait}</div>` : '';
    const whoHTML = g.unitName ? `<div class="dice-who">${g.unitName}</div>` : '';
    const notesHTML = (g.notes && g.notes.length) ?
      `<div class="dice-notes">${g.notes.map(n=>`<span>${n}</span>`).join('')}</div>` : '';
    const sep = i<groups.length-1 ? '<div class="dice-vs">vs</div>' : '';
    return `<div class="dice-group">${faceHTML}<div class="glabel">${g.label}</div>${whoHTML}<div class="dice-set">${diceHTML}</div>${adjustHTML}${notesHTML}</div>${sep}`;
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
  emit('finish', {});
  const overlay = document.getElementById('diceOverlay');
  clearTimeout(showDice._fadeT);
  // Anything still outstanding from an earlier fight applies now, before this
  // one takes its place. Only one resolution is ever pending at a time.
  flushPendingSettle();
  if(FAST_DICE_MODE){ overlay.classList.remove('show'); if(onSettled) onSettled(); return; }
  pendingSettle = onSettled || null;
  showDice._fadeT = setTimeout(()=>{
    overlay.classList.remove('show');
    setTimeout(()=>{ if(!overlay.classList.contains('show')) unlockDicePanel(); }, 400);   // after the slide-out, and only if nothing new has opened
    flushPendingSettle();
  }, 2900);
}

