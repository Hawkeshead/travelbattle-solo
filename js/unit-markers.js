/* =========================================================
   UNIT MARKERS (Matthew, 12 Oct 2026: the cockade option)

   A small cockade hovers over the heads of the unit you have selected, and
   over the enemy unit acting on its turn (the AI, or the other player
   online). No ring at the feet (Matthew, 12 Oct 2026: the cockade only):
   - British: a black cockade with a silver button;
   - French: the tricolour cockade (blue, white, red).
   An acting enemy unit also gets a word for what it is doing ("Advancing",
   "Charging", "Firing", "Volley", "Attacking", "Forming Square"), in the
   white slanted lettering of the battle dice, for a moment after it acts.

   Drawn on its own layer over the board and above the clouds (the clouds
   are at z-index 10), below the dice and the cards. The cockade keeps the
   same size on screen at every zoom and follows a unit while it moves. Hidden units (in ambush)
   are never marked. Visual only: nothing here is saved, synced or replayed.
========================================================= */
import { COLS, humanOwns, state } from './data-core.js';
import { canvas as boardCanvas, getUnitVisualPos, toScreen } from './render-board.js';

const ACT_MS = 2200;           // how long an enemy unit stays marked after acting
const COCKADE_R = 9;           // cockade radius, CSS px, at every zoom
let layer = null, g = null, lastLogLen = 0, dirty = true;
let acting = null;             // { id, word, until }

export function initUnitMarkers(){
  if(layer || typeof document === 'undefined') return;
  const wrap = document.getElementById('boardWrap');
  if(!wrap) return;
  layer = document.createElement('canvas');
  layer.id = 'unitMarkers';
  layer.setAttribute('aria-hidden', 'true');
  layer.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;z-index:12;';
  wrap.appendChild(layer);
  g = layer.getContext('2d');
  const tick = () => { requestAnimationFrame(tick); frame(); };
  requestAnimationFrame(tick);
}

/* What an enemy unit is doing, from the newest match-log entries. */
function readLog(){
  const log = state.matchLog || [];
  if(log.length < lastLogLen) lastLogLen = 0;          // a new match
  for(let i = lastLogLen; i < log.length; i++){
    const ev = log[i];
    let id = null, word = null, side = null;
    if(ev.type === 'move' && (ev.kind === 'march' || ev.kind === 'charge' || !ev.kind)){
      id = ev.unitId; side = ev.side; word = ev.kind === 'charge' ? 'Charging' : advancingOrMoving(ev);
    } else if(ev.type === 'fire' && ev.gunId){ id = ev.gunId; side = ev.gunSide; word = 'Firing'; }
    else if(ev.type === 'fire' && ev.volley && ev.shooterId){ id = ev.shooterId; side = ev.shooterSide; word = 'Volley'; }
    else if(ev.type === 'fight' && ev.attackerId){ id = ev.attackerId; side = ev.attackerSide; word = 'Attacking'; }
    else if(ev.type === 'formation' && ev.by === 'ai'){ id = ev.unitId; side = ev.side; word = ev.to === 'square' ? 'Forming Square' : 'Forming Line'; }
    if(id && side && !humanOwns(side)) acting = { id, word, until: performance.now() + ACT_MS };
  }
  lastLogLen = log.length;
}
/* "Advancing" if the move brought it nearer the enemy, otherwise "Moving". */
function advancingOrMoving(ev){
  if(!ev.from || !ev.to) return 'Moving';
  const foes = state.units.filter(u => !u.removed && u.side !== ev.side && u.type !== 'BRIGADIER');
  if(!foes.length) return 'Moving';
  const d = p => Math.min(...foes.map(f => Math.max(Math.abs(f.x - p.x), Math.abs(f.y - p.y))));
  return d(ev.to) < d(ev.from) ? 'Advancing' : 'Moving';
}

function frame(){
  if(!layer) return;
  readLog();
  const wrap = layer.parentElement;
  const W = wrap.clientWidth, H = wrap.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
  if(layer.width !== Math.round(W * dpr) || layer.height !== Math.round(H * dpr)){
    layer.width = Math.round(W * dpr); layer.height = Math.round(H * dpr);
    layer.style.width = W + 'px'; layer.style.height = H + 'px';
  }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  if(dirty){ g.clearRect(0, 0, W, H); dirty = false; }
  if(state.replaying || state.gameOver || !state.units || !state.units.length) return;
  const marks = [];
  const sel = state.selectedUnitId && state.units.find(u => u.id === state.selectedUnitId && !u.removed);
  if(sel && !sel.hidden) marks.push({ u: sel, word: null });
  if(acting && performance.now() < acting.until){
    const a = state.units.find(u => u.id === acting.id && !u.removed);
    if(a && !a.hidden && (!sel || a.id !== sel.id)) marks.push({ u: a, word: acting.word });
  } else acting = null;
  if(!marks.length) return;
  dirty = true;   // something drawn this frame: clear it next frame (nothing to clear when idle)
  const wr = wrap.getBoundingClientRect(), cr = boardCanvas.getBoundingClientRect();
  const cell = cr.width / COLS;
  const t = performance.now() / 1000;
  for(const { u, word } of marks){
    const v = getUnitVisualPos(u), s = toScreen(v.x, v.y);
    const x = cr.left - wr.left + (s.x + 0.5) * cell, y = cr.top - wr.top + (s.y + 0.5) * cell;
    const british = u.side === 'red';
    const bob = Math.sin(t * 2.4) * 2;
    const top = y - cell * 0.62 + bob;
    cockade(x, Math.max(COCKADE_R + 2, top), british);
    if(word) label(word, x, Math.max(14, top - COCKADE_R - 8));
  }
}

/* A pleated rosette: the outer folds, a middle ring and a button. */
function cockade(x, y, british){
  const r = COCKADE_R;
  const [outer, middle, button] = british ? ['#151515', '#2b2b2b', '#d9dee4'] : ['#c8191e', '#f6f3ea', '#1f3a8a'];
  g.save(); g.translate(x, y);
  g.shadowColor = 'rgba(0,0,0,.55)'; g.shadowBlur = 5; g.shadowOffsetY = 2;
  g.fillStyle = outer; g.beginPath();
  const n = 22;
  for(let i = 0; i <= n * 2; i++){ const a = i / (n * 2) * Math.PI * 2, rr = i % 2 ? r : r * 0.86; g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); }
  g.fill(); g.shadowColor = 'transparent';
  g.strokeStyle = british ? 'rgba(255,255,255,.12)' : 'rgba(0,0,0,.22)'; g.lineWidth = 0.8;
  for(let i = 0; i < n; i++){ const a = i / n * Math.PI * 2; g.beginPath(); g.moveTo(Math.cos(a) * r * 0.5, Math.sin(a) * r * 0.5); g.lineTo(Math.cos(a) * r * 0.95, Math.sin(a) * r * 0.95); g.stroke(); }
  g.fillStyle = middle; g.beginPath(); g.arc(0, 0, r * 0.62, 0, Math.PI * 2); g.fill();
  g.fillStyle = button; g.beginPath(); g.arc(0, 0, r * 0.34, 0, Math.PI * 2); g.fill();
  const hl = g.createRadialGradient(-r * 0.12, -r * 0.12, 0.5, 0, 0, r * 0.34);
  hl.addColorStop(0, 'rgba(255,255,255,.75)'); hl.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = hl; g.beginPath(); g.arc(0, 0, r * 0.34, 0, Math.PI * 2); g.fill();
  g.restore();
}
function label(text, x, y){
  g.save();
  g.font = "italic 700 17px 'Cormorant Garamond', Georgia, serif";
  g.textAlign = 'center'; g.lineJoin = 'round';
  g.lineWidth = 4; g.strokeStyle = 'rgba(0,0,0,.8)'; g.strokeText(text, x, y);
  g.fillStyle = '#fff'; g.fillText(text, x, y);
  g.restore();
}
