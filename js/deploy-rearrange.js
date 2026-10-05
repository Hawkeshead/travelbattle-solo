/* =========================================================
   REARRANGING YOUR DEPLOYMENT (Matthew, 4 Oct 2026)

   Once both armies are on the board and before Begin Battle, you can move
   your own units around within where they are allowed to stand: drag a unit
   (or tap it, then tap a square) onto an empty legal square to move it there,
   or onto another of your units to swap the two. Begin Battle is then the
   point where you are happy with it, rather than a second confirmation of
   something you could not change.

   Where a unit may stand:
   - a standard battle: your own deployment rows (two, three in Grand), on
     terrain the unit may deploy onto;
   - an Operation: the area its Brigade was placed in (the area it stands in
     now, for Beaumont's two outposts) or, for an edge placement, your own two
     rows.
   A swap needs both units legal in each other's squares. Not online or in
   Group: there a placement would need sending to the other phones.

   The board's pan gesture yields to a drag that starts on one of your units
   (render-board's pointer claim), so the board does not slide under the
   finger.
========================================================= */
import { ROWS, SIDES, UNIT_TYPES, state } from './data-core.js';
import { inBounds, terrainAt, unitsAt } from './engine-rules.js';
import { log, logReplay } from './engine-state.js';
import { cellFromClient, draw, fromScreen, setPointerClaim } from './render-board.js';
import { setHighlightCells } from './render-units.js';
import { isOnline } from './online-session.js';

let picked = null;          // unit id chosen (tap, or the start of a drag)
let drag = null;            // { id, pointerId, startX, startY, moved }

const playerSide = () => (state.mode === 'ai' && !state.spectate && !isOnline() && !state.group ? (state.aiSide === SIDES.RED ? SIDES.BLUE : SIDES.RED) : null);

/* Rearranging is open while deploying, once the player's army is complete:
   every unit placed (standard), or straight away in an Operation. */
export function rearrangeOpen(){
  if(state.phase !== 'deploy') return false;
  const me = playerSide();
  if(!me) return false;
  if(state.scenario && state.scenario.kind === 'operation') return true;
  if(state.mapBattle) return true;   // campaign map battle: placed for you, rearrange freely
  return state.deployBrigadeIndex && state.deployBrigadeIndex[me] >= 3;
}

function areaOf(u){
  const sc = state.scenario;
  if(!sc || sc.kind !== 'operation') return null;
  const areas = (sc.map && sc.map.areas) || {};
  for(const [name, cells] of Object.entries(areas)) if(cells.some(([x, y]) => x === u.x && y === u.y)) return name;
  return null;
}
/* Can unit u stand on (x, y)? homeArea pins an Operation unit to its area. */
function legalFor(u, x, y, homeArea){
  if(!inBounds(x, y)) return false;
  const terr = terrainAt(x, y);
  if(terr.restrictTo && !terr.restrictTo.includes(u.type)) return false;
  if(homeArea){
    const cells = state.scenario.map.areas[homeArea] || [];
    return cells.some(([ax, ay]) => ax === x && ay === y);
  }
  const rows = state.boardMode === 'grand' ? 3 : 2;
  return u.side === SIDES.RED ? y >= ROWS - rows : y < rows;
}
function legalSquares(u){
  const home = areaOf(u);
  const out = [];
  for(let y = 0; y < ROWS; y++) for(let x = 0; x < (state.terrain[0] || []).length; x++){
    if(x === u.x && y === u.y) continue;
    if(!legalFor(u, x, y, home)) continue;
    const there = unitsAt(x, y).filter(o => o.id !== u.id);
    if(there.length > 1) continue;
    if(there.length === 1){
      const o = there[0];
      if(o.side !== u.side || !legalFor(o, u.x, u.y, areaOf(o))) continue;
    }
    out.push({ x, y });
  }
  return out;
}
function show(u){ setHighlightCells(u ? legalSquares(u).map(c => ({ x: c.x, y: c.y, kind: 'move' })) : []); draw(); }

/* Moves u to (x, y), swapping with one of your units there. */
function moveOrSwap(u, x, y){
  if(!legalSquares(u).some(c => c.x === x && c.y === y)) return false;
  const other = unitsAt(x, y).find(o => o.id !== u.id);
  const from = { x: u.x, y: u.y };
  if(other){ other.x = from.x; other.y = from.y; }
  u.x = x; u.y = y;
  logReplay('deployRearrange', { unitId: u.id, from, to: { x, y }, swappedWith: other ? other.id : null });
  log(`${u.historicalName || UNIT_TYPES[u.type].label} ${other ? `swaps places with ${other.historicalName || UNIT_TYPES[other.type].label}` : `moves to (${x},${y})`}.`, 'system');
  return true;
}

/* A tap during deployment (ui-battle routes it here first): pick one of your
   units, then tap where it should go. Returns true if it used the tap. */
export function rearrangeTap(x, y){
  if(!rearrangeOpen()) return false;
  const me = playerSide();
  const here = unitsAt(x, y).find(o => o.side === me);
  if(picked){
    const u = state.units.find(o => o.id === picked);
    if(u && !(u.x === x && u.y === y) && moveOrSwap(u, x, y)){ picked = null; show(null); return true; }
    if(here && here.id !== picked){ picked = here.id; show(here); return true; }
    picked = null; show(null); return true;
  }
  if(here){ picked = here.id; show(here); return true; }
  return false;
}

/* Dragging: claimed from the board's pan gesture when it starts on your unit. */
function claim(e){
  if(!rearrangeOpen()) return false;
  const hit = cellFromClient(e.clientX, e.clientY);
  if(!hit) return false;
  const b = fromScreen(hit.x, hit.screenY);
  const me = playerSide();
  const u = unitsAt(b.x, b.y).find(o => o.side === me);
  if(!u) return false;
  drag = { id: u.id, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, moved: false };
  // Show where it can go; whether it is picked is the tap handler's call, so a
  // plain tap still picks (or, on a picked unit, drops) as a tap should.
  show(u);
  return true;
}
function onMove(e){
  if(!drag || e.pointerId !== drag.pointerId) return;
  if(Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 8) drag.moved = true;
}
function onUp(e){
  if(!drag || e.pointerId !== drag.pointerId) return;
  const d = drag; drag = null;
  if(!d.moved){ if(!picked) show(null); return; }   // a tap: the click handler takes it from here
  const hit = cellFromClient(e.clientX, e.clientY);
  const u = state.units.find(o => o.id === d.id);
  if(hit && u){
    const b = fromScreen(hit.x, hit.screenY);
    if(moveOrSwap(u, b.x, b.y)){ picked = null; show(null); suppressNextClick = true; return; }
  }
  suppressNextClick = true;            // a drag that went nowhere is not a tap either
}
let suppressNextClick = false;
export function swallowDragClick(){ if(suppressNextClick){ suppressNextClick = false; return true; } return false; }

export function initDeployRearrange(){
  setPointerClaim(claim);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', () => { drag = null; });
}
export function resetRearrange(){ picked = null; drag = null; }
