/* =========================================================
   THE DESPATCH CASE: ending a phase (assets/ui/despatch/, audio/effects/)

   One leather despatch case in the top corner of the camera-side strip takes
   the place of the three end-phase buttons (End Move, End Artillery, End
   Fight). It is a two-tap control, so a stray tap can never end a phase:

     tap one     the case opens: the flap swings up, a despatch rises out of it
                 naming the order ("End Move", "to Fire phase"), with sound
     tap two     on the open case: the order is sent. The phase ends at once,
                 exactly as the old button did (it calls that button), and the
                 despatch flies off as the case closes
     tap outside the case closes without sending; that tap is used up by the
                 close and never reaches the board

   The phase auto-end countdown (phase-autoend.js) drives it too: it opens the
   case by itself and counts on the despatch's small line ("to Fire phase in
   3"), and sends it at zero. A tap outside cancels the countdown.

   The three old buttons stay in the page, hidden, as the source of truth: the
   code that runs a turn still shows, hides, enables and relabels them as
   before, and the case mirrors whichever one is current (watched with a
   MutationObserver), so nothing else in the game had to learn about it. If any
   image fails to load, the case never appears and the buttons are used as
   before.

   Geometry is worked in the art's own pixels (the "stage") and scaled: the
   body's 362 px width is drawn at 44 CSS px closed and twice that open. The
   stage's y = FLAP_IN_H line is the hinge (the body's top edge); the flap
   that stands up behind when open sits above it, the body and the hanging
   flap below.
========================================================= */
import { AudioManager } from './audio-manager.js';
import { state } from './data-core.js';

const DIR = 'assets/ui/despatch/';
export const DESPATCH_ART = ['assets/ui/despatch/case_body.webp', 'assets/ui/despatch/case_flap_out.webp',
  'assets/ui/despatch/case_flap_in.webp', 'assets/ui/despatch/case_parchment.webp'];
export const DESPATCH_SOUNDS = { opening: 'audio/effects/despatch-opening.wav', loop: 'audio/effects/despatch-open-loop.wav',
  confirmed: 'audio/effects/despatch-confirmed.wav' };
const OPENING_MS = 1500;                   // despatch-opening's length: the loop follows it

const BODY = { w: 362, h: 589 }, FLAP_OUT = { w: 363, h: 442 }, FLAP_IN = { w: 367, h: 327 }, PARCH = { w: 337, h: 643 };
const STAGE_W = 367, HINGE = FLAP_IN.h;    // stage width (the widest piece); hinge line in stage pixels
const CLOSED_PX = 44, OPEN_PX = 88;        // the body's drawn width, closed and open
const S_CLOSED = CLOSED_PX / BODY.w, S_OPEN = OPEN_PX / BODY.w;
const RISE = 290, FLY = 400;               // the despatch rises this far above the mouth; flies this much further when sent
const PARCH_REST = HINGE + 12;             // closed: the despatch sits down inside the body
const TOP = 14, EDGE = 20, BOARD_INSET = 10;
const PHASES = { endMoveBtn: { phase: 'move', next: 'to Fire phase' }, endFireBtn: { phase: 'fire', next: 'to Fight phase' },
  endFightBtn: { phase: 'fight', next: 'to end the turn' } };

let root = null, stage = null, flapOut = null, flapIn = null, parch = null, label = null, shield = null;
let ready = false, isOpen = false, busy = false, closing = false, openAfterClose = false, countdown = null, outsideCloseHook = null;
let sounds = { opening: null, loop: null };
let current = null;      // the end button currently mirrored, or null

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const u = n => `${n}px`;

/* ---------- set-up ---------- */
export function initDespatch(){
  if(root || typeof document === 'undefined') return;
  let loaded = 0, failed = false;
  for(const src of DESPATCH_ART){
    const img = new Image();
    img.onload = () => { if(++loaded === DESPATCH_ART.length && !failed) build(); };
    img.onerror = () => { failed = true; };
    img.src = src;
  }
  if(AudioManager.preloadEffects) AudioManager.preloadEffects(Object.values(DESPATCH_SOUNDS));
}

function build(){
  root = document.createElement('div');
  root.id = 'despatch';
  root.setAttribute('role', 'button');
  root.setAttribute('tabindex', '0');
  root.innerHTML = `
    <div class="dp-stage" style="width:${u(STAGE_W)};height:${u(HINGE + BODY.h)}">
      <div class="dp-flapin-wrap"><img class="dp-flapin" src="${DIR}case_flap_in.webp" alt="" draggable="false"></div>
      <div class="dp-parch-clip" style="height:${u(HINGE + BODY.h + 2000)};top:${u(-2000)}">
        <div class="dp-parch" style="width:${u(PARCH.w)};height:${u(PARCH.h)}">
          <img src="${DIR}case_parchment.webp" alt="" draggable="false">
          <div class="dp-label"><span class="dp-l1"></span><span class="dp-l2"></span><span class="dp-small"></span></div>
        </div>
      </div>
      <img class="dp-body" src="${DIR}case_body.webp" alt="" draggable="false">
      <div class="dp-flapout-wrap"><img class="dp-flapout" src="${DIR}case_flap_out.webp" alt="" draggable="false"></div>
    </div>`;
  document.body.appendChild(root);
  shield = document.createElement('div');
  shield.id = 'despatchShield';
  document.body.appendChild(shield);
  stage = root.querySelector('.dp-stage');
  flapOut = root.querySelector('.dp-flapout-wrap');
  flapIn = root.querySelector('.dp-flapin-wrap');
  parch = root.querySelector('.dp-parch');
  label = root.querySelector('.dp-label');
  layoutStatic();
  setClosedPose();

  root.addEventListener('click', e => { e.stopPropagation(); e.preventDefault(); onTap(); });
  root.addEventListener('keydown', e => { if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); onTap(); } });
  // Any tap outside the open case closes it, and is spent doing so.
  const outside = e => { e.stopPropagation(); e.preventDefault(); if(e.type === 'pointerdown') closeWithoutSending(); };
  for(const t of ['pointerdown', 'pointerup', 'click', 'touchstart', 'touchend', 'mousedown', 'mouseup']) shield.addEventListener(t, outside, { passive: false });

  const dock = document.getElementById('phaseDock');
  if(dock) new MutationObserver(sync).observe(dock, { subtree: true, attributes: true, childList: true, characterData: true });
  new MutationObserver(() => { place(); sync(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  addEventListener('resize', place);
  addEventListener('orientationchange', () => setTimeout(place, 250));
  ready = true;
  place();
  sync();
  // A safety net for state changes that touch nothing in the dock (the game
  // ending, a phase set while the dock was already in that shape).
  setInterval(sync, 500);
}

/* Pieces placed in stage pixels: everything centred on the body. */
function layoutStatic(){
  const cx = STAGE_W / 2;
  const at = (el, w, h, top) => { el.style.left = u(cx - w / 2); el.style.top = u(top); el.style.width = u(w); el.style.height = u(h); };
  at(root.querySelector('.dp-body'), BODY.w, BODY.h, HINGE);
  at(flapOut, FLAP_OUT.w, FLAP_OUT.h, HINGE);
  at(flapIn, FLAP_IN.w, FLAP_IN.h, 0);
  const clip = root.querySelector('.dp-parch-clip');
  clip.style.left = '0'; clip.style.width = u(STAGE_W);
  parch.style.left = u(cx - PARCH.w / 2);
  parch.style.top = u(2000 + PARCH_REST);   // inside the clip, which starts 2000 above the stage
}

/* ---------- where it sits ---------- */
function side(){
  const c = document.documentElement.classList;
  if(c.contains('island-left')) return 'left';
  if(c.contains('island-right')) return 'right';
  return null;
}
function place(){
  if(!root) return;
  const s = side();
  root.style.left = root.style.right = '';
  if(s === 'left'){ root.style.left = u(EDGE); root.style.top = u(TOP); stage.style.transformOrigin = 'left top'; }
  else if(s === 'right'){ root.style.right = u(EDGE); root.style.top = u(TOP); stage.style.transformOrigin = 'right top'; }
  else {
    // No camera strip: the board's top-right corner, inset.
    const wrap = document.getElementById('board') || document.getElementById('boardWrap');
    const r = wrap ? wrap.getBoundingClientRect() : { right: innerWidth, top: 0 };
    root.style.right = u(Math.max(4, innerWidth - r.right + BOARD_INSET));
    root.style.top = u(Math.max(4, r.top + BOARD_INSET));
    stage.style.transformOrigin = 'right top';
  }
  root.dataset.side = s || 'board';
  if(!isOpen && !busy) setClosedPose();
}
const posePose = scale => `translateY(${u(scale === S_OPEN ? 0 : -HINGE * S_CLOSED)}) scale(${scale})`;
function setClosedPose(){
  stage.style.transform = posePose(S_CLOSED);
  flapOut.style.transform = 'rotateX(0deg)'; flapOut.style.visibility = 'visible';
  flapIn.style.transform = 'rotateX(90deg)'; flapIn.style.visibility = 'hidden';
  parch.style.transform = 'translateY(0)'; parch.style.opacity = '1';
  label.style.opacity = '0';
  root.style.width = u(CLOSED_PX); root.style.height = u((BODY.h) * S_CLOSED);
}

/* ---------- mirroring the hidden end buttons ---------- */
const BUTTON_FOR_PHASE = { move: 'endMoveBtn', fire: 'endFireBtn', fight: 'endFightBtn' };
function sync(){
  if(!ready) return;
  const dock = document.getElementById('phaseDock');
  // The case is for the battle's three phases only; setup (orientation's
  // Confirm, Begin Battle) keeps its own buttons.
  const id = BUTTON_FOR_PHASE[state.phase];
  const btn = id ? document.getElementById(id) : null;
  const inBattle = !!btn && !state.gameOver;
  document.documentElement.classList.toggle('despatch-on', inBattle);
  root.style.display = inBattle ? 'block' : 'none';
  if(!inBattle){ if(isOpen) closeWithoutSending(true); current = null; return; }
  current = btn;
  const dockHidden = !dock || dock.style.display === 'none';
  const disabled = dockHidden || btn.disabled;
  root.classList.toggle('disabled', disabled);
  root.setAttribute('aria-disabled', String(disabled));
  root.setAttribute('aria-label', (btn.dataset.label || btn.textContent || '').trim());
  if(disabled && isOpen && !busy) closeWithoutSending(true);
  if(!countdown) writeLabel();
}
function words(){
  const t = ((current && (current.dataset.label || current.textContent)) || '').replace(/\s*\(\d+\)\s*$/, '').trim();
  const w = t.split(/\s+/).filter(Boolean);
  if(w.length <= 1) return ['', w[0] || ''];
  if(w.length === 2) return w;
  return [w[0], w.slice(1).join(' ')];
}
function writeLabel(small){
  const [a, b] = words();
  const l1 = label.querySelector('.dp-l1'), l2 = label.querySelector('.dp-l2'), sm = label.querySelector('.dp-small');
  l1.textContent = a; l2.textContent = b;
  sm.textContent = small != null ? small : (current ? PHASES[current.id].next : '');
  // A five-letter word fills about 70% of the despatch; longer words shrink to fit.
  fit(l1, 63); fit(l2, 63); fit(sm, 47);
}
/* Sets a line's size, then shrinks it if it would run past the despatch's
   edges (a long word like ARTILLERY, or the countdown's "to Fight phase in 3"). */
function fit(el, base){
  const cs = getComputedStyle(el);
  const text = cs.textTransform === 'uppercase' ? el.textContent.toUpperCase() : el.textContent;
  const g = (fit.c || (fit.c = document.createElement('canvas'))).getContext('2d');
  g.font = `${cs.fontWeight} ${base}px ${cs.fontFamily}`;
  const w = g.measureText(text).width, max = PARCH.w * 0.86;
  el.style.fontSize = u(w > max ? base * max / w : base);
}

/* ---------- taps ---------- */
function onTap(){
  if(!ready || busy || root.classList.contains('disabled')) return;
  if(!isOpen) open(); else send();
}

/* ---------- motion ---------- */
function anim(el, frames, ms, delay, easing){
  if(reducedMotion()) { ms = 1; delay = 0; }
  return el.animate(frames, { duration: ms, delay: delay || 0, easing: easing || 'linear', fill: 'forwards' });
}
function open(fromCountdown){
  if(isOpen) return;
  // Still closing from the last send (the next phase's countdown can start in
  // that moment): open as soon as the close has finished, not over the top of it.
  if(closing){ openAfterClose = true; return; }
  isOpen = true; busy = true;
  shield.classList.add('on');
  root.classList.add('open');
  root.style.width = u(OPEN_PX); root.style.height = u((HINGE + BODY.h) * S_OPEN);
  playOpeningSounds();
  writeLabel(countdown != null ? countdownText(countdown) : undefined);
  if(reducedMotion()){
    stage.animate([{ opacity: 0.3 }, { opacity: 1 }], { duration: 160, fill: 'none' });
  }
  anim(stage, [{ transform: posePose(S_CLOSED) }, { transform: posePose(S_OPEN) }], 225, 0, 'ease-in-out');
  flapIn.style.visibility = 'visible';
  anim(flapOut, [{ transform: 'rotateX(0deg)' }, { transform: 'rotateX(90deg)' }], 125, 0, 'ease-in');
  anim(flapIn, [{ transform: 'rotateX(90deg)' }, { transform: 'rotateX(0deg)' }], 125, 125, 'ease-out');
  setTimeout(() => { if(isOpen) flapOut.style.visibility = 'hidden'; }, reducedMotion() ? 0 : 125);
  anim(parch, [{ transform: 'translateY(0)' }, { transform: `translateY(${u(-(PARCH_REST - HINGE + RISE))})` }], 270, 180, 'ease-out');
  const lab = anim(label, [{ opacity: 0 }, { opacity: 1 }], 110, 340);
  lab.finished.then(() => { busy = false; }).catch(() => { busy = false; });
  if(reducedMotion()) busy = false;
}
function closeMotion(ms, then){
  busy = true; closing = true;
  anim(label, [{ opacity: getComputedStyle(label).opacity }, { opacity: 0 }], ms * 0.25, 0);
  anim(parch, [{ transform: getComputedStyle(parch).transform === 'none' ? 'translateY(0)' : getComputedStyle(parch).transform }, { transform: 'translateY(0)' }], ms * 0.6, 0, 'ease-in');
  flapOut.style.visibility = 'visible';
  anim(flapIn, [{ transform: 'rotateX(0deg)' }, { transform: 'rotateX(90deg)' }], ms * 0.28, ms * 0.45, 'ease-in');
  anim(flapOut, [{ transform: 'rotateX(90deg)' }, { transform: 'rotateX(0deg)' }], ms * 0.28, ms * 0.72, 'ease-out');
  const st = anim(stage, [{ transform: posePose(S_OPEN) }, { transform: posePose(S_CLOSED) }], ms * 0.5, ms * 0.5, 'ease-in-out');
  const done = () => {
    for(const el of [stage, flapIn, flapOut, parch, label]) el.getAnimations().forEach(a => a.cancel());
    setClosedPose();
    root.classList.remove('open');
    busy = false; closing = false;
    if(then) then();
    if(openAfterClose){ openAfterClose = false; if(countdown != null && despatchAvailable()) open(true); }
  };
  if(reducedMotion()) done(); else st.finished.then(done).catch(done);
}
/* Tap two, or the countdown reaching zero: the phase ends now, then the
   despatch flies off and the case closes. */
function send(byCountdown){
  if(!isOpen || !current) return;
  const btn = current;
  busy = true;
  // Closed from this moment, as far as anything else is concerned: ending the
  // phase below can start the next phase's countdown at once, and that must
  // wait for this close rather than find the case still "open".
  isOpen = false; closing = true;
  shield.classList.remove('on');
  playConfirmedSounds();
  const finish = countdown != null && countdownFinish ? countdownFinish : null;
  countdown = null; countdownFinish = null;
  // End the phase exactly as the old button did.
  if(byCountdown && finish) finish(); else if(!btn.disabled) btn.click();
  const from = -(PARCH_REST - HINGE + RISE);
  anim(parch, [{ transform: `translateY(${u(from)})`, opacity: 1 }, { transform: `translateY(${u(from - FLY)})`, opacity: 0 }], 350, 0, 'ease-in');
  anim(label, [{ opacity: 1 }, { opacity: 0 }], 350, 0);
  setTimeout(() => {
    closeMotion(350, () => { parch.style.opacity = '1'; sync(); });
  }, reducedMotion() ? 0 : 350);
}
/* A tap outside (or the turn being taken away): close without sending. */
export function closeWithoutSending(silentHook){
  if(!isOpen) return;
  isOpen = false;
  shield.classList.remove('on');
  stopOpenSounds(250);
  const wasCountdown = countdown != null;
  countdown = null; countdownFinish = null;
  for(const el of [stage, flapIn, flapOut, parch, label]) el.getAnimations().forEach(a => a.finish());
  closeMotion(450);
  if(wasCountdown && outsideCloseHook && !silentHook) outsideCloseHook();
}

/* ---------- sound (AudioManager: Web Audio buffers, settings respected) ---------- */
function playOpeningSounds(){
  stopOpenSounds(30);
  try {
    sounds.opening = AudioManager.playEffect('despatch-opening', DESPATCH_SOUNDS.opening, 'ui', { volumeScale: 0.7 }) || null;
    sounds.loop = AudioManager.playEffect('despatch-open-loop', DESPATCH_SOUNDS.loop, 'ui', { loop: true, delayMs: OPENING_MS, fadeInMs: 30 }) || null;
  } catch(_e) { /* a missing sound is silence, never an error */ }
}
function stopOpenSounds(ms){
  for(const k of ['opening', 'loop']){ const h = sounds[k]; if(h && h.fadeOut) { try { h.fadeOut(ms); } catch(_e) { /* gone */ } } sounds[k] = null; }
}
function playConfirmedSounds(){
  stopOpenSounds(80);
  try { AudioManager.playEffect('despatch-confirmed', DESPATCH_SOUNDS.confirmed, 'ui', { volumeScale: 0.7 }); } catch(_e) { /* silent */ }
}

/* ---------- the auto-end countdown (phase-autoend.js) ---------- */
let countdownFinish = null;
const countdownText = n => `${current ? PHASES[current.id].next : ''} in ${n}`;
export function despatchActive(){ return ready && !!root && root.style.display !== 'none'; }
export function despatchAvailable(){ return despatchActive() && !root.classList.contains('disabled'); }
/* Opens the case (if it is not already) and counts on its small line. */
export function despatchCountdown(seconds, finish){
  if(!despatchAvailable()) return false;
  countdown = seconds; countdownFinish = finish;
  if(!isOpen) open(true); else writeLabel(countdownText(seconds));
  return true;
}
export function despatchCountdownTick(seconds){
  if(countdown == null) return;
  countdown = seconds;
  const sm = label.querySelector('.dp-small');
  sm.textContent = countdownText(seconds);
  fit(sm, 47);
}
/* At zero: send, as tap two would. */
export function despatchCountdownFire(){
  if(countdown == null) return false;
  send(true);
  return true;
}
/* Undo, or the phase moving on: the countdown stops and the case closes. */
export function despatchCountdownStop(){
  if(countdown == null) return;
  countdown = null; countdownFinish = null;
  if(isOpen && !busy) closeWithoutSending(true);
  else if(isOpen){ isOpen = false; shield.classList.remove('on'); stopOpenSounds(250); closeMotion(450); }
}
/* phase-autoend.js registers what an outside tap during a countdown should do (cancel it). */
export function onDespatchOutsideClose(fn){ outsideCloseHook = fn; }
export const despatchIsOpen = () => isOpen;
