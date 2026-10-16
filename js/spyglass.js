/* =========================================================
   THE SPYGLASS: follow the AI's thinking (solo games against the AI)

   A brass dial beside the others on the board edge. Each tap cycles:
     Off      the board exactly as before (the default, remembered per device)
     Orders   at the start of each AI turn, every Brigade's order: its units
              ringed in the Brigade's colour, a dashed line from the Brigadier
              to the square it is making for, that square outlined, and a
              small flag with the order ("Assault", "Site guns, wait 2")
     Full     the orders, and as each unit acts, how it chose: every square it
              weighed tinted in its Brigade's colour (darker scored higher),
              the best three numbered, an arrow to the square it took (or
              "held"), and for a shot or a fight an arrow to the target with
              crossed sabres or a roundshot. The AI waits after each unit for
              a tap ("Tap to continue"), so it can be followed at any pace.

   DISPLAY ONLY. Everything drawn comes from the AI's decision trace
   (js/ai-trace.js), which the AI writes and never reads; switching the
   Spyglass on starts the trace, and tools/sim/spyglass-check.mjs proves a
   match plays the same with it on or off. The Full view's pause only delays
   the AI's next unit; what it then does is already fixed.

   Where things are drawn: the tints, rings and square outlines on the
   board itself, above the terrain and below the units (render-board's
   underlay). Lines, arrows, numbers, flags and markers on a layer of their
   own above the units and below the cockade, placed in the corners and
   edges of squares and moved off any square a unit stands on, so they never
   sit over unit art, its badges or the cockade.

   Hidden in every online game and in Spectate.
========================================================= */
import { COLS, ROWS, state } from './data-core.js';
import { isOnline } from './online-session.js';
import { canvas as boardCanvas, draw, getUnitVisualPos, setBoardUnderlay, toScreen } from './render-board.js';
import { currentTrace, onTrace, setStepGate, setTraceCapture } from './ai-trace.js';
import { isConcealedFromEnemy } from './engine-rules.js';

const MODES = ['off', 'orders', 'full'];
const MODE_LABEL = { off: 'Off', orders: 'Orders', full: 'Full' };
const STORE = 'fc-spyglass';
/* One colour per Brigade (magenta, cyan, orange): flat, strong against the
   yellow-green grass and the dark woods alike, and away from both armies'
   own reds and blues. */
const BRIGADE_COLOUR = ['#ff4fa8', '#2fd3ff', '#ff8a1f'];
const colourOf = id => BRIGADE_COLOUR[((id % 3) + 3) % 3];

let mode = 'off';
try { const m = localStorage.getItem(STORE); if(MODES.includes(m)) mode = m; } catch { /* storage blocked: off */ }
let btn = null, layer = null, g = null, pausePill = null;
let decision = null;             // the unit decision being shown (Full)
let waiting = null;              // the AI's next step, held for a tap (Full)
let lastSig = '';

export const spyglassMode = () => mode;
/* Solo against the AI, in battle: the only place the Spyglass exists. */
function available(){
  return !!(state.mode === 'ai' && !state.spectate && !state.replaying && !isOnline() && state.aiSide && !state.rts);
}
function aiActing(){
  return available() && ['move', 'fire', 'fight'].includes(state.phase) && state.turn === state.aiSide && !state.gameOver;
}
/* The trace for the turn being played now, if there is one. */
function liveTrace(){
  const t = currentTrace();
  return t && t.side === state.aiSide && t.turn === state.turnNumber ? t : null;
}

/* ---------- the dial ---------- */
const TELESCOPE = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" style="position:relative;z-index:1">
  <g fill="none" stroke="#3A2C0D" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <path d="M3.5 13.5l12.8-6.4 1.6 3.2-12.8 6.4z" fill="rgba(58,44,13,.18)"/>
    <path d="M16.3 7.1l2.3-1.1 1.9 3.8-2.3 1.1"/><path d="M6.6 15.4l-1.3.6"/>
    <path d="M10.2 14.6l-2.6 6.2M10.9 14.3l3 6.1"/></g></svg>`;
function ensureButton(){
  if(btn || typeof document === 'undefined') return;
  const hud = document.getElementById('hudIcons');
  if(!hud) return;
  btn = document.createElement('button');
  btn.id = 'spyglassBtn';
  btn.type = 'button';
  btn.innerHTML = `${TELESCOPE}<span class="sg-state"></span>`;
  const style = document.createElement('style');
  style.textContent = `#spyglassBtn .sg-state{position:absolute;left:50%;bottom:-7px;transform:translateX(-50%);z-index:2;
    font:700 8.5px/1 'IBM Plex Mono',monospace;letter-spacing:.04em;text-transform:uppercase;white-space:nowrap;
    padding:2px 4px;border-radius:6px;color:#f3e6c3;background:#3a2c14;border:1px solid #6b5320;pointer-events:none}
    #spyglassBtn.sg-on .sg-state{background:#5b6b3a;border-color:#a9c27a}
    #spyglassPause{position:fixed;left:50%;bottom:calc(env(safe-area-inset-bottom,0px) + 14px);transform:translateX(-50%);z-index:40;display:none;
      font:600 15px 'IM Fell English',Georgia,serif;color:#fbf6ea;background:rgba(20,24,20,.86);border:1px solid #c8a85a;
      padding:7px 16px;border-radius:16px;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.5)}`;
  document.head.appendChild(style);
  // Next to the field report dial, so it reads as one of the instruments.
  const log = document.getElementById('logIconBtn');
  hud.insertBefore(btn, log ? log.nextSibling : null);
  btn.onclick = () => setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length]);
  paintButton();
}
function paintButton(){
  if(!btn) return;
  btn.querySelector('.sg-state').textContent = MODE_LABEL[mode];
  btn.title = `Spyglass: ${MODE_LABEL[mode]}`;
  btn.setAttribute('aria-label', `Spyglass, ${MODE_LABEL[mode]}. Tap to change.`);
  btn.classList.toggle('sg-on', mode !== 'off');
}
export function setMode(m){
  if(!MODES.includes(m)) return;
  mode = m;
  try { localStorage.setItem(STORE, m); } catch { /* not remembered */ }
  paintButton();
  syncCapture();
  if(mode !== 'full') releasePause();
  draw();
}
function syncCapture(){
  const on = mode !== 'off' && available();
  setTraceCapture(on);
  setStepGate(on && mode === 'full' ? holdForTap : null);
}

/* ---------- the pause (Full) ---------- */
function holdForTap(next){
  if(mode !== 'full' || !aiActing()){ next(); return; }
  waiting = next; waitingFor = `${state.turnNumber}|${state.turn}|${state._matchStartStamp}`;
  if(!pausePill){
    pausePill = document.createElement('button');
    pausePill.id = 'spyglassPause'; pausePill.type = 'button';
    pausePill.textContent = 'Tap to continue';
    pausePill.onclick = e => { e.stopPropagation(); releasePause(); };
    document.body.appendChild(pausePill);   // at the foot of the screen, below the board in portrait
    // A tap on the board itself also carries on, and is not taken as a click on a unit.
    let swallow = false;
    boardCanvas.addEventListener('pointerdown', e => {
      if(!waiting) return;
      swallow = true; e.stopPropagation(); releasePause();
    }, true);
    boardCanvas.addEventListener('click', e => { if(swallow){ swallow = false; e.stopImmediatePropagation(); e.preventDefault(); } }, true);
  }
  pausePill.style.display = 'block';
}
function releasePause(){
  if(pausePill) pausePill.style.display = 'none';
  const n = waiting; waiting = null;
  // Only into the turn it was holding: a match left or restarted meanwhile drops it.
  if(n && waitingFor === `${state.turnNumber}|${state.turn}|${state._matchStartStamp}`) n();
}
let waitingFor = null;

/* ---------- the trace arriving ---------- */
onTrace((kind, item) => {
  if(kind === 'turn') decision = null;
  if(kind === 'decision') decision = item;
  if(mode !== 'off') draw();
});

/* ---------- geometry ---------- */
function rects(){
  const wrap = layer.parentElement;
  return { wr: wrap.getBoundingClientRect(), cr: boardCanvas.getBoundingClientRect() };
}
/* A square's centre and size on the overlay layer (CSS px). */
function sq(x, y, R){
  const cell = R.cr.width / COLS, s = toScreen(x, y);
  return { x: R.cr.left - R.wr.left + (s.x + 0.5) * cell, y: R.cr.top - R.wr.top + (s.y + 0.5) * cell, cell };
}
/* What the player cannot see stays unseen: an AI unit in a wood or lying in
   ambush is not drawn on the board, so the Spyglass neither rings it nor
   shows its decision (where it went, or that it stayed). */
const concealed = u => !!u && u.side === state.aiSide && isConcealedFromEnemy(u);
function decisionHidden(d){
  if(!d) return true;
  const u = state.units.find(o => o.id === d.unitId);
  if(!u || concealed(u)) return true;
  if(d.from && isConcealedFromEnemy({ hidden: false, x: d.from.x, y: d.from.y })) return d.phase === 'move';
  return false;
}
const occupied = (x, y) => state.units.some(u => !u.removed && !u.hidden && u.x === x && u.y === y);
/* Sizes follow the square, so a phone in portrait (squares of about 19 px)
   gets small chips and a desktop (45 px) full-size ones. */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const onBoard = (x, y) => x >= 0 && y >= 0 && x < COLS && y < ROWS;

/* ---------- the ground layer (on the board, under the units) ---------- */
setBoardUnderlay((ctx, CELL, at) => {
  if(mode === 'off' || !available()) return;
  const t = liveTrace();
  if(!t || state.turn !== state.aiSide) return;
  const full = mode === 'full' && decision && decision.side === t.side && !decisionHidden(decision);
  ctx.save();
  // Each Brigade's units ringed in its colour (its acting Brigade only, once a unit is being shown).
  for(const b of t.brigades){
    if(b.order === 'none') continue;   // no single objective: not drawn (see the report on these)
    const faint = full && decision.brigadeId !== b.id;
    ctx.strokeStyle = colourOf(b.id); ctx.globalAlpha = faint ? 0.35 : 0.9; ctx.lineWidth = Math.max(2, CELL * 0.05);
    for(const id of b.units){
      const u = state.units.find(o => o.id === id && !o.removed);
      if(!u || concealed(u)) continue;
      const v = getUnitVisualPos(u), p = at(v.x, v.y);   // where it is drawn, mid-move included
      ctx.beginPath(); ctx.ellipse(p.x + CELL / 2, p.y + CELL * 0.8, CELL * 0.4, CELL * 0.13, 0, 0, Math.PI * 2); ctx.stroke();
    }
    // The objective square, outlined (faint and dashed while a unit is shown).
    if(b.objective){
      const p = at(b.objective.x, b.objective.y);
      ctx.globalAlpha = full ? (decision.brigadeId === b.id ? 0.6 : 0.25) : 0.95;
      ctx.setLineDash(full ? [CELL * 0.12, CELL * 0.08] : []);
      ctx.lineWidth = Math.max(2, CELL * (full ? 0.04 : 0.06));
      ctx.strokeRect(p.x + 3, p.y + 3, CELL - 6, CELL - 6);
      ctx.setLineDash([]);
    }
  }
  // Full: every square the acting unit weighed, darker for a higher score.
  if(full && decision.candidates && decision.candidates.length){
    const col = colourOf(decision.brigadeId);
    const scores = decision.candidates.map(c => c.score);
    const hi = Math.max(...scores), lo = Math.min(...scores), span = hi - lo || 1;
    ctx.fillStyle = col;
    for(const c of decision.candidates){
      const p = at(c.x, c.y);
      ctx.globalAlpha = 0.07 + 0.5 * ((c.score - lo) / span);
      ctx.fillRect(p.x + 2, p.y + 2, CELL - 4, CELL - 4);
    }
    const dest = decision.target || decision.to;
    if(dest && decision.phase === 'move'){
      const p = at(dest.x, dest.y);
      ctx.globalAlpha = 1; ctx.strokeStyle = '#fff8e6'; ctx.lineWidth = Math.max(2.5, CELL * 0.06);
      ctx.strokeRect(p.x + 2, p.y + 2, CELL - 4, CELL - 4);
    }
  }
  ctx.restore();
});

/* ---------- the top layer (lines, arrows, numbers, flags) ---------- */
function ensureLayer(){
  if(layer || typeof document === 'undefined') return;
  const wrap = document.getElementById('boardWrap');
  if(!wrap) return;
  layer = document.createElement('canvas');
  layer.id = 'spyglassLayer';
  layer.setAttribute('aria-hidden', 'true');
  // Above the units and the clouds (10), below the cockade (12).
  layer.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;z-index:11;';
  wrap.appendChild(layer);
  g = layer.getContext('2d');
}
function frame(){
  requestAnimationFrame(frame);
  ensureButton(); ensureLayer();
  if(btn) btn.style.display = available() ? '' : 'none';
  if(waiting && !aiActing()){ waiting = null; if(pausePill) pausePill.style.display = 'none'; }
  const avail = `${mode}|${available()}`;
  if(avail !== lastSig){ lastSig = avail; syncCapture(); }
  if(!layer) return;
  const wrap = layer.parentElement, W = wrap.clientWidth, H = wrap.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
  if(layer.width !== Math.round(W * dpr) || layer.height !== Math.round(H * dpr)){
    layer.width = Math.round(W * dpr); layer.height = Math.round(H * dpr);
    layer.style.width = W + 'px'; layer.style.height = H + 'px';
  }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const t = (mode === 'off' || !aiActing()) ? null : liveTrace();
  const R = t ? rects() : null;
  /* Redrawn only when something it shows has changed: the camera, a unit
     moving, a new decision. A still frame costs one comparison. */
  const sig = t ? drawSignature(t, R) : '';
  if(sig === drawnSig) return;
  drawnSig = sig;
  g.clearRect(0, 0, W, H);
  // Nothing to show: the layer leaves the page's compositing altogether.
  layer.style.display = t ? '' : 'none';
  if(!t) return;
  const full = mode === 'full' && decision && decision.side === t.side && !decisionHidden(decision);
  const placed = [];   // label boxes already on the layer, so they do not pile up
  // Layer one: the orders.
  for(const b of t.brigades){
    if(b.order === 'none' || !b.objective) continue;
    const dim = full && decision.brigadeId !== b.id;
    const col = colourOf(b.id);
    const o = sq(b.objective.x, b.objective.y, R);
    g.save(); g.globalAlpha = dim ? 0.3 : (full ? 0.55 : 1);
    // From where the Brigadier stands now: he may have moved since the orders were given.
    const brig = b.brigadierId && state.units.find(u => u.id === b.brigadierId && !u.removed);
    const from = brig ? getUnitVisualPos(brig) : b.brigadier;
    if(from){
      const s = sq(from.x, from.y, R);
      dashedLine(s, o, col, s.cell);
    }
    if(!full || !dim) flagLabel(b.timer ? `${b.order}, ${b.timer}` : b.order, b.objective, col, R, placed);
    g.restore();
  }
  // Layer two: the acting unit.
  if(full) drawDecision(decision, R, placed);
}

let drawnSig = null;
function drawSignature(t, R){
  const parts = [mode, t.turn, t.decisions.length, Math.round(R.cr.left), Math.round(R.cr.top), Math.round(R.cr.width), Math.round(R.wr.left), Math.round(R.wr.top)];
  for(const b of t.brigades){
    parts.push(b.objective ? `${b.objective.x},${b.objective.y}` : '-');
    const brig = b.brigadierId && state.units.find(u => u.id === b.brigadierId && !u.removed);
    if(brig){ const v = getUnitVisualPos(brig); parts.push(v.x.toFixed(2), v.y.toFixed(2)); }
  }
  if(decision){ const u = state.units.find(o => o.id === decision.unitId); if(u){ const v = getUnitVisualPos(u); parts.push(u.x, u.y, v.x.toFixed(2), v.y.toFixed(2)); } }
  // Labels step aside for units, so where every unit stands is part of it too.
  parts.push(state.units.reduce((h, u) => (h * 31 + (u.removed ? 7 : u.x * 10 + u.y)) | 0, 0));
  return parts.join('|');
}
function dashedLine(a, b, col, cell){
  // From the edge of the Brigadier's square to the edge of the objective: never over either square's art.
  const ang = Math.atan2(b.y - a.y, b.x - a.x), r = cell * 0.5;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if(len < cell * 1.1) return;
  g.save();
  g.strokeStyle = 'rgba(0,0,0,.45)'; g.lineWidth = 4; g.setLineDash([7, 6]);
  g.beginPath(); g.moveTo(a.x + Math.cos(ang) * r, a.y + Math.sin(ang) * r); g.lineTo(b.x - Math.cos(ang) * r, b.y - Math.sin(ang) * r); g.stroke();
  g.strokeStyle = col; g.lineWidth = 2;
  g.stroke();
  g.restore();
}
function arrow(a, b, col, cell, stopShort = 0.46){
  // From just inside the unit's own square to the near edge of the square it is going to.
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const fx = a.x + Math.cos(ang) * cell * 0.3, fy = a.y + Math.sin(ang) * cell * 0.3;
  // Stops at the edge of the destination (a target's square is its art: kept clear).
  const k = stopShort / Math.max(Math.abs(Math.cos(ang)), Math.abs(Math.sin(ang)));
  const tx = b.x - Math.cos(ang) * cell * Math.min(k, 0.75), ty = b.y - Math.sin(ang) * cell * Math.min(k, 0.75);
  const len = Math.hypot(tx - fx, ty - fy);
  g.save();
  const head = clamp(cell * 0.25, 6, 12);
  if(len > 4){
    g.lineCap = 'round';
    g.strokeStyle = 'rgba(0,0,0,.55)'; g.lineWidth = 6; g.beginPath(); g.moveTo(fx, fy); g.lineTo(tx, ty); g.stroke();
    g.strokeStyle = col; g.lineWidth = 3.2; g.beginPath(); g.moveTo(fx, fy); g.lineTo(tx, ty); g.stroke();
  }
  g.fillStyle = col; g.strokeStyle = 'rgba(0,0,0,.6)'; g.lineWidth = 1.2;
  g.beginPath(); g.moveTo(tx, ty);
  g.lineTo(tx - head * Math.cos(ang - 0.45), ty - head * Math.sin(ang - 0.45));
  g.lineTo(tx - head * Math.cos(ang + 0.45), ty - head * Math.sin(ang + 0.45));
  g.closePath(); g.fill(); g.stroke();
  g.restore();
  return { x: (fx + tx) / 2, y: (fy + ty) / 2 };
}
/* A rounded chip of text, placed beside a square on whichever side is free:
   above it first, then below, right and left, never over a square a unit
   stands on or over another chip, and always inside the board. */
function flagLabel(text, cellXY, col, R, placed){
  const o = sq(cellXY.x, cellXY.y, R);
  g.save();
  const fs = Math.round(clamp(o.cell * 0.32, 9, 14));
  g.font = `600 ${fs}px 'IBM Plex Sans', system-ui, sans-serif`;
  const pen = fs * 1.2;   // room for the pennant
  const w = g.measureText(text).width + pen + 10, h = fs + 8;
  const tries = [[0, -1], [0, 1], [1, 0], [-1, 0], [0, -2], [1, -1], [-1, -1]];
  // Inside the part of the board that is on screen (zoomed in, the board runs past its frame).
  const bx = { l: Math.max(R.cr.left, R.wr.left) - R.wr.left + 2, t: Math.max(R.cr.top, R.wr.top) - R.wr.top + 2,
               r: Math.min(R.cr.right, R.wr.right) - R.wr.left - 2, b: Math.min(R.cr.bottom, R.wr.bottom) - R.wr.top - 2 };
  let best = null;
  for(const [dx, dy] of tries){
    const nx = cellXY.x + dx, ny = cellXY.y + dy;
    let cx = o.x + dx * o.cell * (dx ? 0.5 + w / (2 * o.cell) : 0), cy = o.y + dy * (o.cell * 0.5 + h / 2 + 2);
    if(dy && !dx){ /* above or below the square's edge */ }
    let x = cx - w / 2, y = cy - h / 2;
    // Nudged in off the board edge.
    x = Math.max(bx.l, Math.min(bx.r - w, x)); y = Math.max(bx.t, Math.min(bx.b - h, y));
    const box = { x, y, w, h };
    const hitsUnit = onBoard(nx, ny) && occupied(nx, ny) && overlapsSquare(box, nx, ny, R);
    const hitsOwn = occupied(cellXY.x, cellXY.y) && overlapsSquare(box, cellXY.x, cellXY.y, R);
    const hitsChip = placed.some(p => p.x < x + w && x < p.x + p.w && p.y < y + h && y < p.y + p.h);
    if(!hitsUnit && !hitsOwn && !hitsChip){ best = box; break; }
    if(!best) best = box;
  }
  placed.push(best);
  const { x, y } = best;
  g.fillStyle = 'rgba(0,0,0,.35)'; roundRect(x + 1, y + 2, w, h, h / 2); g.fill();   // a flat drop shadow (a blur costs every redraw)
  g.fillStyle = 'rgba(22,20,16,.9)'; roundRect(x, y, w, h, h / 2); g.fill();
  g.strokeStyle = col; g.lineWidth = 1.5; roundRect(x, y, w, h, h / 2); g.stroke();
  // A pennant in the Brigade's colour, then the order.
  const px = x + h * 0.42;
  g.fillStyle = col; g.beginPath(); g.moveTo(px, y + 4); g.lineTo(px + fs * 0.55, y + h / 2 - 1); g.lineTo(px, y + h / 2 + 2); g.closePath(); g.fill();
  g.fillRect(px - 1, y + 4, 1.6, h - 8);
  g.fillStyle = '#fbf6ea'; g.textBaseline = 'middle'; g.fillText(text, x + pen + 4, y + h / 2 + 0.5);
  g.restore();
}
function overlapsSquare(box, x, y, R){
  const c = sq(x, y, R), hw = c.cell / 2;
  return box.x < c.x + hw && c.x - hw < box.x + box.w && box.y < c.y + hw && c.y - hw < box.y + box.h;
}
function roundRect(x, y, w, h, r){
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

function drawDecision(d, R, placed){
  const col = colourOf(d.brigadeId);
  /* The best three squares, numbered in the bottom left corner: the one corner
     of a square nothing of a unit's uses (badges run down the right, the
     Brigadier's portrait sits top left, the cockade above). */
  if(d.phase === 'move' && d.candidates && d.candidates.length){
    const top = [...d.candidates].sort((a, b) => b.score - a.score).slice(0, 3);
    top.forEach((c, i) => {
      const p = sq(c.x, c.y, R), r = clamp(p.cell * 0.2, 6, 10);
      const x = p.x - p.cell / 2 + r + 3, y = p.y + p.cell / 2 - r - 3;
      g.save();
      g.fillStyle = i === 0 ? '#fff8e6' : 'rgba(22,20,16,.88)'; g.strokeStyle = col; g.lineWidth = 1.6;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); g.stroke();
      g.fillStyle = i === 0 ? '#1d1a14' : '#fbf6ea';
      g.font = `700 ${Math.round(r * 1.25)}px 'IBM Plex Mono', monospace`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(i + 1), x, y + 0.5);
      g.restore();
      placed.push({ x: x - r, y: y - r, w: 2 * r, h: 2 * r });
    });
  }
  const from = sq(d.from.x, d.from.y, R);
  if(d.phase === 'fire' || d.phase === 'fight'){
    if(!d.target) return;
    const mid = arrow(from, sq(d.target.x, d.target.y, R), col, from.cell, 0.52);
    if(d.phase === 'fire') roundshot(mid.x, mid.y, from.cell); else sabres(mid.x, mid.y, from.cell);
    return;
  }
  const held = !d.to || (d.to.x === d.from.x && d.to.y === d.from.y);
  if(held){
    // "held" in the bottom right corner of the unit's square: clear of its badges (left) and cockade (above).
    const unit = state.units.find(u => u.id === d.unitId);
    const at = unit ? sq(unit.x, unit.y, R) : from;
    const word = { square: 'square', ambush: 'in ambush' }[actionKind(d.action)] || 'held';
    if(at.cell < 64){ pauseMark(at.x + at.cell / 2 - 7, at.y + at.cell / 2 - 7, Math.max(5, at.cell * 0.2), col); return; }
    g.save();
    const fs = Math.round(clamp(at.cell * 0.28, 8, 13));
    g.font = `700 ${fs}px 'IBM Plex Sans', system-ui, sans-serif`;
    const w = g.measureText(word).width + 10, h = fs + 6;
    const x = at.x + at.cell / 2 - w - 2, y = at.y + at.cell / 2 - h - 2;
    g.fillStyle = 'rgba(22,20,16,.9)'; roundRect(x, y, w, h, 4); g.fill();
    g.strokeStyle = col; g.lineWidth = 1.4; roundRect(x, y, w, h, 4); g.stroke();
    g.fillStyle = '#fbf6ea'; g.textBaseline = 'middle'; g.fillText(word, x + 5, y + h / 2 + 0.5);
    g.restore();
    return;
  }
  arrow(from, sq(d.to.x, d.to.y, R), col, from.cell);
}
/* "Held": a pause mark in the bottom right corner (the word only on a big
   square, where it fits beside the rank number without covering the men). */
function pauseMark(x, y, r, col){
  g.save();
  g.fillStyle = 'rgba(22,20,16,.92)'; g.strokeStyle = col; g.lineWidth = 1.4;
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); g.stroke();
  g.fillStyle = '#fbf6ea'; g.fillRect(x - r * 0.42, y - r * 0.45, r * 0.28, r * 0.9); g.fillRect(x + r * 0.14, y - r * 0.45, r * 0.28, r * 0.9);
  g.restore();
}
const actionKind = a => /Square/.test(a) ? 'square' : /Ambush/.test(a) ? 'ambush' : 'hold';
/* Crossed sabres and a roundshot, flat placeholders on a dark disc. */
function marker(x, y, cell, paint){
  const r = clamp(cell * 0.3, 7, 14);
  g.save(); g.translate(x, y);
  g.fillStyle = 'rgba(22,20,16,.9)'; g.strokeStyle = '#fff8e6'; g.lineWidth = 1.5;
  g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.fill(); g.stroke();
  paint(r); g.restore();
}
function sabres(x, y, cell){
  marker(x, y, cell, r => {
    g.strokeStyle = '#f1e7cf'; g.lineWidth = 2; g.lineCap = 'round';
    for(const s of [1, -1]){
      g.beginPath(); g.moveTo(-r * 0.55 * s, r * 0.55); g.quadraticCurveTo(0, -r * 0.1, r * 0.55 * s, -r * 0.6); g.stroke();
      g.beginPath(); g.moveTo(-r * 0.7 * s, r * 0.32); g.lineTo(-r * 0.32 * s, r * 0.72); g.stroke();   // the guard
    }
  });
}
function roundshot(x, y, cell){
  marker(x, y, cell, r => {
    const grad = g.createRadialGradient(-r * 0.2, -r * 0.2, 1, 0, 0, r * 0.55);
    grad.addColorStop(0, '#9aa0a6'); grad.addColorStop(1, '#2b2f33');
    g.fillStyle = grad; g.beginPath(); g.arc(0, 0, r * 0.55, 0, Math.PI * 2); g.fill();
  });
}

if(typeof window !== 'undefined' && typeof requestAnimationFrame === 'function') requestAnimationFrame(frame);
