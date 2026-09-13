/* =========================================================
   FLOATING COMBAT TEXT

   Short labels above the square where a rule resolved, drifting up and fading.
   Player and AI alike. Purely presentational: this module changes no state and
   knows no rules.

   A LEAF MODULE BY CONSTRUCTION. It imports nothing at all — not state, not
   rules, not the renderer. It is handed a layer element and a square-to-pixel
   function at init and receives coordinates and strings thereafter. Rules code
   calls in; nothing here calls out. That is what keeps a presentation layer
   from quietly becoming a place where game logic accumulates.
========================================================= */

const LIFETIME_MS     = 1100;
const RISE_PX         = 22;
const STAGGER_MS      = 180;
const AI_HOLD_MS      = 400;
const STACK_OFFSET_PX = 20;
const MAX_QUEUE       = 12;
const TURN_BUDGET_MS  = 4000;

const DROPPABLE = new Set(['bonus', 'formation']);   // never 'penalty' or 'command'
const COLLAPSE_WINDOW_MS = 250;

let layer = null;
let squareToPixel = null;
let enabled = true;

let queue = [];
let draining = false;
let idleResolvers = [];
let live = 0;

/* Per drain cycle, so two labels on one square in the same burst stack rather
   than overlap. Reset when the queue empties, not per label. */
let stackCounts = new Map();
/* text+square -> timestamp, for the 250ms collapse. */
let recent = new Map();
/* Accrued AI hold for the current turn, against TURN_BUDGET_MS. */
let turnHoldMs = 0;

export function initFloatingText(layerEl, squareToPixelFn){
  layer = layerEl;
  squareToPixel = squareToPixelFn;
  clearFloatingText();
}

export function setFloatingTextEnabled(v){
  enabled = !!v;
  if(!enabled) clearFloatingText();
}

export function isFloatingTextEnabled(){ return enabled; }

/* Called at the start of each AI turn so the budget is per turn, not per match. */
export function resetFloatingTextTurnBudget(){ turnHoldMs = 0; }

export function emitFloatingText({ col, row, text, kind, hold }){
  /* Disabled must be a no-op that costs nothing, including for the AI: the
     gating below resolves instantly when there is nothing queued, so a turn
     with labels off runs at exactly its previous speed. */
  if(!enabled || !layer || !squareToPixel) return;
  if(typeof col !== 'number' || typeof row !== 'number' || !text) return;

  const key = `${col},${row}|${text}`;
  const now = Date.now();
  const last = recent.get(key);
  if(last !== undefined && now - last < COLLAPSE_WINDOW_MS) return;  // same label, same square, same instant
  recent.set(key, now);

  queue.push({ col, row, text: String(text), kind: kind || 'formation', hold: hold || 0 });

  /* Over the cap, shed the least important first and OLDEST first within that,
     so a long burst loses its early flourishes rather than its outcome. A
     penalty or a command is never dropped: those are the ones that tell the
     player what actually happened to the unit. */
  while(queue.length > MAX_QUEUE){
    const i = queue.findIndex(e => DROPPABLE.has(e.kind));
    if(i === -1) break;        // nothing droppable left; let it run long rather than lose an outcome
    queue.splice(i, 1);
  }

  if(!draining) drain();
}

/* Resolves when the queue has drained AND the last label has been released.
   Resolves immediately when disabled or already idle, so the AI controller can
   await it unconditionally without a branch at the call site. */
export function floatingTextIdle(){
  if(!enabled || (queue.length === 0 && !draining)) return Promise.resolve();
  return new Promise(res => idleResolvers.push(res));
}

export function clearFloatingText(){
  queue = [];
  draining = false;
  stackCounts = new Map();
  recent = new Map();
  live = 0;
  if(layer) layer.replaceChildren();
  const rs = idleResolvers; idleResolvers = [];
  for(const r of rs) r();
}

function settleIdle(){
  if(queue.length === 0 && !draining){
    const rs = idleResolvers; idleResolvers = [];
    for(const r of rs) r();
  }
}

function drain(){
  draining = true;
  const next = queue.shift();
  if(!next){
    draining = false;
    stackCounts = new Map();   // burst over: the next one starts stacking from zero again
    settleIdle();
    return;
  }

  render(next);

  /* The hold is what gives the player time to read an AI action before the next
     one starts. Over the per-turn budget it is dropped for the rest of the turn
     and the stagger alone carries the pacing, so a heavy turn compresses instead
     of dragging. */
  let hold = next.hold;
  if(hold > 0){
    if(turnHoldMs + hold > TURN_BUDGET_MS) hold = 0;
    else turnHoldMs += hold;
  }
  setTimeout(drain, STAGGER_MS + hold);
}

function render(entry){
  const px = squareToPixel(entry.col, entry.row);
  if(!px) return;

  const key = `${entry.col},${entry.row}`;
  const depth = stackCounts.get(key) || 0;
  stackCounts.set(key, depth + 1);

  const el = document.createElement('div');
  el.className = `fct-label fct-${entry.kind}`;
  el.textContent = entry.text;

  /* Row 0 has nothing above it, so its labels render BELOW the unit instead.
     `below` is decided by the caller's coordinate space via squareToPixel,
     which reports whether this row is at the top edge as drawn — the board can
     be screen-flipped, so "row 0" and "top of the screen" are not the same
     question. */
  if(px.atTopEdge){
    el.classList.add('fct-below');
    el.style.top = (px.bottom + 4 + depth * STACK_OFFSET_PX) + 'px';
  } else {
    el.style.top = (px.top - 6 - depth * STACK_OFFSET_PX) + 'px';
  }
  el.style.left = px.centreX + 'px';

  layer.appendChild(el);
  live++;
  setTimeout(() => {
    el.remove();
    live--;
  }, LIFETIME_MS + 60);
}

export const FCT_AI_HOLD_MS = AI_HOLD_MS;
export const FCT_RISE_PX = RISE_PX;
export function floatingTextLiveCount(){ return live; }
