/* =========================================================
   REAL-TIME FIELD COMMAND: the launcher (the one file the rest of the game
   may import from js/rts/, through a dynamic import in battle setup).

   Builds a standard board and both armies with the turn-based game's own
   code (read-only use of the shared modules), hands them to the simulation
   (sim.js), then runs it: the simulation advances on a fixed 10-per-second
   tick, and every animation frame the units' drawn positions are placed
   between ticks so movement is smooth at any frame rate.

   Phase 2: tap one of your units, then a square, and it goes if its
   Brigadier has an order to give, it is ready, on the chain and the square is
   in range. With Group on, tap several of your units, then a square, and
   they all go (or none do). Rings show each unit's cooldown and pips show
   each Brigadier's banked orders.
========================================================= */
import { SIDES, state } from '../data-core.js';
import { finishBattle, placeArmy, setupBoard } from './setup.js';
import { aiTick, createAi } from './ai.js';
import { canvas, cellFromClient, consumeGestureFlag, ctx, draw, fromScreen, getUnitVisualPos, MOVE_PROFILES, playBoardIntroAnimation, sizeCanvas, toScreen, unitAnimations } from '../render-board.js';
import { CELL, SIDE_LABEL } from '../data-core.js';
import { emitFloatingText } from '../floating-text.js';
import { showArmyPickerFor, startAmbientLayer } from '../ui-menus.js';
import { AudioManager } from '../audio-manager.js';
import { MATCH_CLOCK_TICKS, MAX_TICKS_PER_FRAME, TICK_MS, TICKS_PER_SECOND } from './constants.js';
import { columnLead, isBusy, issueGroupOrder, issueOrder, loadBattle, points, poolOf, readiness01, saveBattle, stackPartner, step } from './sim.js';
import { turnBasedRules } from './rules-adapter.js';

let battle = null;
let ai = null;                     // the opponent (ai.js)
let running = false, lastFrame = 0, acc = 0;
let selected = [];                 // unit ids, in the order they were picked
let groupMode = false;
let reachCache = null;             // { id, tick, cells } for the single selected unit's range
let paintGroupToggle = null;
let stackMode = false;             // after 'Stack', the next tap on one of your foot units marches onto it

/* For tests and tools: the live battle, and a way to put a saved one back. */
export const currentBattle = () => battle;
export function exportBattle(){ return battle ? saveBattle(battle) : null; }
export function importBattle(json){ battle = loadBattle(json); mirrorUnits(0); draw(); }
export const rtsSelection = () => selected.slice();
export function setGroupMode(on){ groupMode = !!on; if(paintGroupToggle) paintGroupToggle(); }

export function launchRealTime(){
  const playerSide = state.aiSide === SIDES.RED ? SIDES.BLUE : SIDES.RED;
  state.spectate = false;
  AudioManager.stopMusic();
  const aiSide = playerSide === SIDES.RED ? SIDES.BLUE : SIDES.RED;
  // The board, then the AI's army (chosen at random, as the turn-based AI
  // does); the player chooses theirs from the Army Picker once the board has
  // landed, previewed against the enemy already in place.
  setupBoard();
  placeArmy(aiSide, null);

  document.getElementById('overlay').classList.remove('show');
  document.getElementById('sidebar').style.display = 'none';
  const dock = document.getElementById('phaseDock'); if(dock) dock.style.display = 'none';
  // Turn-based undo has no meaning in real time (and would rewind shared state).
  const undo = document.getElementById('undoBtnBattle'); if(undo) undo.style.display = 'none';
  sizeCanvas();
  attachInput();
  AudioManager.playAmbience('audio/ambience/countryside.mp3');
  playBoardIntroAnimation(() => {
    startAmbientLayer();
    draw();
    showArmyPickerFor(playerSide, army => {
      placeArmy(playerSide, army.id);
      battle = finishBattle(playerSide);
      ai = createAi(aiSide);
      draw();
      start();
    });
  });
}

/* ---------------------------------------------------------
   The loop: fixed ticks, smooth frames
--------------------------------------------------------- */
function start(){
  running = true; lastFrame = performance.now(); acc = 0;
  showClock();
  showGroupToggle();
  requestAnimationFrame(frame);
}
/* FOCUS-LOSS AUTO-PAUSE (solo only). A notification, another app or a locked
   phone stops the clock until the battle is back on screen. Not a tactical
   pause: no orders are taken while it is paused. */
let paused = false;
function setPaused(p){
  if(paused === p) return;
  paused = p;
  let el = document.getElementById('rtsPaused');
  if(!el){
    el = document.createElement('div'); el.id = 'rtsPaused';
    el.style.cssText = 'position:fixed;inset:0;z-index:29;display:none;align-items:center;justify-content:center;background:rgba(10,10,8,.45);' +
      'font:22px "IM Fell English",Georgia,serif;color:#fbf6ea;pointer-events:none';
    el.textContent = 'Paused';
    document.body.appendChild(el);
  }
  el.style.display = p ? 'flex' : 'none';
  if(!p){ lastFrame = performance.now(); acc = 0; }
}
document.addEventListener('visibilitychange', () => { if(running) setPaused(document.hidden); });
window.addEventListener('blur', () => { if(running) setPaused(true); });
window.addEventListener('focus', () => { if(running && !document.hidden) setPaused(false); });

function frame(now){
  if(!running) return;
  if(paused){ lastFrame = now; requestAnimationFrame(frame); return; }
  acc += Math.min(250, now - lastFrame);     // a long gap never becomes a burst of ticks
  lastFrame = now;
  let n = 0;
  while(acc >= TICK_MS && n < MAX_TICKS_PER_FRAME && !battle.over){ step(battle, turnBasedRules); if(ai) aiTick(ai, battle, turnBasedRules); acc -= TICK_MS; n++; }
  mirrorUnits(acc / TICK_MS);
  draw();
  drawCommandOverlay();
  showNewEvents();
  updateClock();
  if(battle.tick % 5 === 0) updateActionBar();
  if(battle.over){ running = false; showResult(); return; }
  requestAnimationFrame(frame);
}

/* The board is drawn by the turn-based renderer from state.units. Those units
   keep whole-square positions (the renderer looks terrain up by position),
   and the smooth part goes through the renderer's own animation table: each
   frame, a unit crossing a square gets an entry whose start time is set so
   the renderer's ease-out lands exactly on the simulation's position. That
   keeps the shared renderer untouched and the motion tied to the ticks. */
function mirrorUnits(alpha){
  const now = Date.now();
  for(const su of battle.units){
    const u = state.units.find(x => x.id === su.id);
    if(!u) continue;
    u.removed = su.removed;
    u.hidden = !!su.hidden;
    u.formation = su.formation === 'square' ? 'square' : 'line';
    if(su.removed){ delete unitAnimations[su.id]; continue; }
    if(!su.step){
      u.x = su.x; u.y = su.y;
      delete unitAnimations[su.id];
      continue;
    }
    u.x = su.step.toX; u.y = su.step.toY;
    const p = Math.min(0.999, (su.step.elapsed + alpha) / su.step.total);
    const t = 1 - Math.sqrt(1 - p);                    // inverse of the renderer's 1-(1-t)^2
    unitAnimations[su.id] = { fromX: su.step.fromX, fromY: su.step.fromY, toX: su.step.toX, toY: su.step.toY,
                              startTime: now - t * 1000, duration: 1000, profile: MOVE_PROFILES.march };
  }
  state.selectedUnitId = selected.length === 1 ? selected[0] : null;
}

/* ---------------------------------------------------------
   Input: tap a unit of yours, then tap where it should go
--------------------------------------------------------- */
let inputAttached = false;
function attachInput(){
  if(inputAttached) return;
  inputAttached = true;
  // Capture phase, so the turn-based board handler never sees these taps.
  canvas.addEventListener('click', e => {
    if(!state.rts) return;
    e.stopImmediatePropagation();
    if(consumeGestureFlag()) return;
    const hit = cellFromClient(e.clientX, e.clientY);
    if(!hit) return;
    const c = fromScreen(hit.x, hit.screenY);
    onTap(c.x, c.y);
  }, true);
}
function onTap(x, y){
  if(!battle || paused) return;
  const allHere = battle.units.filter(u => !u.removed && ((u.x === x && u.y === y) || (u.step && u.step.toX === x && u.step.toY === y)));
  let here = allHere[0];
  // Two of yours stacked in one square: a Column is picked by its lead unit;
  // an unformed stack cycles between its two units on repeated taps.
  if(here && here.side === battle.playerSide && allHere.length > 1){
    if(here.column) here = columnLead(battle, here);
    else if(selected.length === 1 && allHere.some(u => u.id === selected[0])){
      const other = allHere.find(u => u.id !== selected[0]);
      if(other && !groupMode){ selected = [other.id]; reachCache = null; updateActionBar(); return; }
    }
  }
  if(here && here.side === battle.playerSide && stackMode && selected.length === 1 && here.id !== selected[0]){
    stackMode = false;
    const res = issueOrder(battle, { unitId: selected[0], type: 'move', target: { x: here.x, y: here.y }, side: battle.playerSide }, turnBasedRules);
    toast(res.ok ? 'Stacking' : res.reason);
    updateActionBar();
    return;
  }
  stackMode = false;
  if(here && here.side === battle.playerSide){
    AudioManager.playEffect('unit-select', 'audio/effects/chess-piece-placed.wav', 'ui');
    if(groupMode){
      selected = selected.includes(here.id) ? selected.filter(id => id !== here.id) : [...selected, here.id];
    } else {
      selected = selected.length === 1 && selected[0] === here.id ? [] : [here.id];
    }
    reachCache = null;
    updateActionBar();
    return;
  }
  if(here){
    const gun = selected.length === 1 ? battle.units.find(u => u.id === selected[0]) : null;
    if(gun && gun.type === 'ARTILLERY'){
      const res = issueOrder(battle, { unitId: gun.id, type: 'fire', targetId: here.id, side: battle.playerSide }, turnBasedRules);
      if(!res.ok) toast(res.reason); else toast('Target locked');
      return;
    }
    toast('That is the enemy');
    return;
  }
  if(!selected.length) return;
  const res = (groupMode && selected.length > 1)
    ? issueGroupOrder(battle, { unitIds: selected, type: 'move', target: { x, y }, side: battle.playerSide }, turnBasedRules)
    : issueOrder(battle, { unitId: selected[0], type: 'move', target: { x, y }, side: battle.playerSide }, turnBasedRules);
  if(!res.ok){ toast(res.reason); return; }
  if(groupMode) selected = [];
  reachCache = null;
  updateActionBar();
}

/* A one-line status for the selected unit: what it is, and why it can or
   cannot take an order right now (the same reasons the gate would give). */
function unitStatus(u){
  const name = (state.units.find(x => x.id === u.id) || {}).historicalName || u.type.replace('_', ' ').toLowerCase();
  const { pool, cap } = poolOf(battle, u);
  let why = 'Ready';
  if(u.routing) why = 'Routing';
  else if(battle.tick < u.rallyUntil) why = 'Rallying';
  else if(battle.tick < u.turnedUntil) why = 'Turned around';
  else if(u.forming) why = 'Changing formation';
  else if(isBusy(u)) why = 'Moving';
  else if(battle.tick < u.cooldownUntil) why = `Ready in ${Math.ceil((u.cooldownUntil - battle.tick) / TICKS_PER_SECOND)}s`;
  else if(!turnBasedRules.inChain(battle, u)) why = 'Out of the chain';
  const orders = u.type === 'BRIGADIER' ? 'moves free' : `${pool.orders}/${cap} orders`;
  return `${name}: ${why} \u00b7 ${orders}`;
}

/* Formation buttons for the one unit selected: Square or Line for infantry
   and Guard, Lay Ambush in woods. Each costs an order and takes time. */
let actionBar = null;
let actionSig = '';
function updateActionBar(){
  if(!actionBar){
    actionBar = document.createElement('div'); actionBar.id = 'rtsActions';
    // At the top: your own army always sits at the bottom of the screen, so the bar
    // would otherwise cover it; the far side is the enemy's rear.
    actionBar.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:calc(env(safe-area-inset-top,0px) + 34px);z-index:28;' +
      'display:none;flex-direction:column;align-items:center;gap:4px;max-width:calc(100vw - 260px)';
    actionBar.innerHTML = '<div id="rtsStatus" style="font:13px \'IM Fell English\',Georgia,serif;color:#fbf6ea;background:rgba(20,24,20,.75);padding:2px 10px;border-radius:10px;white-space:nowrap;pointer-events:none"></div>' +
      '<div id="rtsButtons" style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center"></div>';
    document.body.appendChild(actionBar);
  }
  const u = selected.length === 1 ? battle.units.find(x => x.id === selected[0]) : null;
  const status = actionBar.querySelector('#rtsStatus'), row = actionBar.querySelector('#rtsButtons');
  if(!u || u.removed){ actionBar.style.display = 'none'; actionSig = ''; return; }
  const foot = u.type === 'INFANTRY' || u.type === 'GUARD';
  const stacked = foot && !u.step && stackPartner(battle, u);
  const opts = [];
  if(foot && u.column) opts.push(['line', 'Split Column']);
  else if(stacked) opts.push(['column', 'Form Column']);
  else if(foot) opts.push(u.formation === 'square' ? ['line', 'Form Line'] : ['square', 'Form Square']);
  if(foot && !stacked && !u.column && u.formation !== 'square') opts.push(['stack', stackMode ? 'Tap a unit to stack on' : 'Stack']);
  if(foot && !stacked && !u.column && u.formation !== 'square' && battle.terrain[u.y][u.x] === 'WOODS' && !u.hidden) opts.push(['ambush', 'Lay Ambush']);
  if(u.type === 'ARTILLERY') opts.push(['hint', u.lock ? 'Firing: tap an enemy to switch' : 'Tap an enemy to fire']);
  // The status line updates in place; the buttons are only rebuilt when they
  // change, so a button is never replaced under a finger.
  status.textContent = unitStatus(u);
  actionBar.style.display = 'flex';
  const sig = u.id + '|' + JSON.stringify(opts);
  if(sig === actionSig) return;
  actionSig = sig;
  row.innerHTML = '';
  for(const [k, label] of opts){
    const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
    b.style.cssText = 'font:15px "IM Fell English",Georgia,serif;min-height:40px;padding:6px 14px;border-radius:20px;border:1px solid #b8963f;' +
      (k === 'hint' ? 'background:rgba(20,24,20,.75);color:#fbf6ea;pointer-events:none' : 'background:#e0b85a;color:#2a1e14;cursor:pointer');
    if(k === 'stack') b.onclick = () => { stackMode = !stackMode; updateActionBar(); };
    else if(k !== 'hint') b.onclick = () => {
      const res = issueOrder(battle, { unitId: u.id, type: 'form', formation: k, side: battle.playerSide }, turnBasedRules);
      if(!res.ok) toast(res.reason);
      updateActionBar();
    };
    row.appendChild(b);
  }
}

/* ---------------------------------------------------------
   The command overlay, drawn over the board each frame:
   - a ring round each of your units: a thin full ring when it is ready, an
     arc filling up while it cools down (and it is not ready while moving);
   - pips over each of your Brigadiers: filled for orders banked, hollow for
     the rest of the cap;
   - a red mark on any of your units off its Brigadier's chain;
   - the selection, and for one ready unit, the squares one order can reach.
--------------------------------------------------------- */
function unitScreen(u){
  const vp = getUnitVisualPos(u);
  const p = toScreen(vp.x, vp.y);
  return { cx: (p.x + 0.5) * CELL, cy: (p.y + 0.5) * CELL };
}
function drawCommandOverlay(){
  const mine = battle.units.filter(u => !u.removed && u.side === battle.playerSide);
  drawFightMarkers();
  drawLocks();
  drawThreats(mine);
  const byId = id => state.units.find(x => x.id === id);
  const chainOk = new Set(mine.filter(u => turnBasedRules.inChain(battle, u)).map(u => u.id));
  ctx.save();

  // Range of the one selected unit, if it could take an order now.
  if(selected.length === 1){
    const su = battle.units.find(u => u.id === selected[0]);
    if(su && !su.removed && !isBusy(su) && readiness01(battle, su) >= 1 && chainOk.has(su.id)){
      if(!reachCache || reachCache.id !== su.id || reachCache.tick !== battle.tick) reachCache = { id: su.id, tick: battle.tick, cells: turnBasedRules.reachable(battle, su) };
      ctx.fillStyle = 'rgba(235,200,110,0.22)';
      for(const c of reachCache.cells){ const p = toScreen(c.x, c.y); ctx.fillRect(p.x*CELL + 2, p.y*CELL + 2, CELL - 4, CELL - 4); }
    }
  }

  for(const su of mine){
    const u = byId(su.id); if(!u) continue;
    const { cx, cy } = unitScreen(u);
    const r = CELL * 0.46;
    const ready = readiness01(battle, su);
    ctx.lineWidth = Math.max(2, CELL * 0.05);
    if(ready >= 1){
      ctx.strokeStyle = 'rgba(240,220,150,0.55)';
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI*2); ctx.stroke();
    } else {
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI*2); ctx.stroke();
      ctx.strokeStyle = 'rgba(240,200,90,0.95)';
      ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI/2, -Math.PI/2 + Math.PI*2*ready); ctx.stroke();
    }
    if(selected.includes(su.id)){
      ctx.strokeStyle = '#fff6d8'; ctx.lineWidth = Math.max(2, CELL * 0.07);
      ctx.strokeRect((toScreen(getUnitVisualPos(u).x, getUnitVisualPos(u).y).x)*CELL + 1, (toScreen(getUnitVisualPos(u).x, getUnitVisualPos(u).y).y)*CELL + 1, CELL - 2, CELL - 2);
    }
    if(su.forming){
      ctx.setLineDash([4, 4]); ctx.strokeStyle = '#fff6d8'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cx, cy, r * 0.8, 0, Math.PI*2); ctx.stroke(); ctx.setLineDash([]);
    }
    if(su.column && !su.column.lead) continue;          // one label and ring for the pair
    if(su.formation === 'square' || su.hidden || su.column){
      ctx.font = `${Math.round(CELL*0.26)}px "IM Fell English",Georgia,serif`; ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(20,16,10,0.75)'; ctx.fillRect(cx - CELL*0.32, cy + r*0.55, CELL*0.64, CELL*0.26);
      ctx.fillStyle = '#f3d27a'; ctx.fillText(su.hidden ? 'Hidden' : su.column ? 'Column' : 'Square', cx, cy + r*0.55 + CELL*0.2);
    }
    if(!chainOk.has(su.id)){
      ctx.fillStyle = '#b3261e'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(cx + r*0.72, cy - r*0.72, CELL*0.09, 0, Math.PI*2); ctx.fill(); ctx.stroke();
    }
    if(su.type === 'BRIGADIER'){
      const { pool, cap } = poolOf(battle, su);
      const pr = Math.max(2.5, CELL * 0.055), gap = pr * 2.6;
      const x0 = cx - (cap - 1) * gap / 2, y0 = cy - r - pr * 2;
      for(let i = 0; i < cap; i++){
        ctx.beginPath(); ctx.arc(x0 + i*gap, y0, pr, 0, Math.PI*2);
        ctx.fillStyle = i < pool.orders ? '#f3d27a' : 'rgba(20,20,20,0.55)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 1; ctx.stroke();
      }
    }
  }
  ctx.restore();
}

/* THREAT WARNINGS: enemy cavalry within two squares of one of your guns (the
   plan's example of a threat worth an alarm). The gun gets a pulsing red
   ring; if it is off screen (the map zoomed in), a red marker sits on the
   screen edge in its direction; and a note says so, at most once a gun every
   20 s. */
const threatNoted = new Map();
function drawThreats(mine){
  const guns = mine.filter(u => u.type === 'ARTILLERY');
  const cav = battle.units.filter(u => !u.removed && !u.hidden && u.side !== battle.playerSide && (u.type === 'LIGHT_CAV' || u.type === 'HEAVY_CAV'));
  const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 180);
  const rect = canvas.getBoundingClientRect();
  for(const g of guns){
    if(!cav.some(c => Math.max(Math.abs(c.x - g.x), Math.abs(c.y - g.y)) <= 2)) continue;
    const u = state.units.find(x => x.id === g.id); if(!u) continue;
    const { cx, cy } = unitScreen(u);
    ctx.save();
    ctx.strokeStyle = `rgba(210,40,30,${0.45 + 0.5 * pulse})`; ctx.lineWidth = Math.max(2.5, CELL * 0.08);
    ctx.beginPath(); ctx.arc(cx, cy, CELL * (0.52 + 0.06 * pulse), 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
    // Where that is on the screen, through the map's zoom and pan.
    const px = rect.left + cx / (COLS_PX()) * rect.width, py = rect.top + cy / (ROWS_PX()) * rect.height;
    const off = px < 0 || py < 0 || px > innerWidth || py > innerHeight;
    edgeMarker(g.id, off ? Math.min(innerWidth - 14, Math.max(14, px)) : null, off ? Math.min(innerHeight - 14, Math.max(14, py)) : null);
    const last = threatNoted.get(g.id) || -Infinity;
    if(battle.tick - last > 20 * TICKS_PER_SECOND){ threatNoted.set(g.id, battle.tick); toast('Cavalry closing on your guns'); }
  }
  for(const [id, el] of edgeMarkers) if(!guns.some(g => g.id === id && cav.some(c => Math.max(Math.abs(c.x - g.x), Math.abs(c.y - g.y)) <= 2))){ el.remove(); edgeMarkers.delete(id); }
}
const COLS_PX = () => battle.cols * CELL, ROWS_PX = () => battle.rows * CELL;
const edgeMarkers = new Map();
function edgeMarker(id, x, y){
  let el = edgeMarkers.get(id);
  if(x === null){ if(el){ el.style.display = 'none'; } return; }
  if(!el){
    el = document.createElement('div');
    el.style.cssText = 'position:fixed;z-index:29;width:20px;height:20px;margin:-10px 0 0 -10px;border-radius:50%;background:#c8281e;box-shadow:0 0 10px #c8281e;pointer-events:none';
    document.body.appendChild(el); edgeMarkers.set(id, el);
  }
  el.style.display = 'block'; el.style.left = x + 'px'; el.style.top = y + 'px';
}

/* A faint line from each of your guns to the unit it is locked on. */
function drawLocks(){
  const byId = id => state.units.find(x => x.id === id);
  ctx.save();
  ctx.setLineDash([CELL*0.12, CELL*0.1]);
  ctx.lineWidth = Math.max(1.5, CELL*0.035);
  for(const g of battle.units){
    if(g.removed || !g.lock) continue;
    const a = byId(g.id), t = byId(g.lock);
    if(!a || !t || t.removed) continue;
    const p = unitScreen(a), q = unitScreen(t);
    ctx.strokeStyle = g.side === battle.playerSide ? 'rgba(243,210,122,0.55)' : 'rgba(200,70,60,0.55)';
    ctx.beginPath(); ctx.moveTo(p.cx, p.cy); ctx.lineTo(q.cx, q.cy); ctx.stroke();
  }
  ctx.restore();
}

/* Crossed sabres between every pair in contact. */
function drawFightMarkers(){
  const byId = id => state.units.find(x => x.id === id);
  ctx.save();
  ctx.font = `${Math.round(CELL * 0.42)}px serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for(const f of Object.values(battle.fights)){
    const a = byId(f.a), d = byId(f.d);
    if(!a || !d || a.removed || d.removed) continue;
    const p = unitScreen(a), q = unitScreen(d);
    const mx = (p.cx + q.cx) / 2, my = (p.cy + q.cy) / 2;
    ctx.fillStyle = 'rgba(20,16,10,0.7)';
    ctx.beginPath(); ctx.arc(mx, my, CELL * 0.24, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#f3d27a';
    ctx.fillText('\u2694', mx, my + 1);
  }
  ctx.restore();
}

/* Dice results as pop-ups over the fight, never pausing the battle. */
let lastEventShown = 0;
function showNewEvents(){
  for(const e of battle.events){
    if(e.n <= lastEventShown) continue;
    lastEventShown = e.n;
    soundFor(e);
    if(e.kind === 'contact' || e.x == null) continue;
    const bad = e.side === battle.playerSide && /pushed|routed|destroyed|Fails|Destroyed/.test(e.text);
    emitFloatingText({ col: e.x, row: e.y, text: e.text, kind: bad ? 'penalty' : 'command' });
  }
}

/* SOUND, from the same files turn-based uses: the clash of a melee round,
   the gun and its impact, the death cry, a British rally. Melee clashes are
   spaced out so a busy line does not become a wall of noise. */
let lastClash = 0;
function soundFor(e){
  const now = performance.now();
  if(e.kind === 'melee' && now - lastClash > 1500){ lastClash = now; AudioManager.playEffect('battle-resolve', 'audio/effects/battle-resolve.wav', 'majorCombat'); }
  else if(e.kind === 'shot'){
    AudioManager.playEffect('artillery-fire', 'audio/effects/artillery-fire.wav', 'cannon');
    if(/Shaken|routed|destroyed/.test(e.text)) setTimeout(() => AudioManager.playEffect('artillery-impact', 'audio/effects/artillery-impact.wav', 'majorCombat'), 350);
  }
  else if(e.kind === 'destroyed') AudioManager.playEffect('unit-destroyed', 'audio/effects/unit-destroyed.wav', 'majorCombat');
  else if(e.kind === 'rally' && e.side === 'red' && /Rallies|saves/.test(e.text)) AudioManager.playEffect('rally-red', 'audio/effects/rally-british-1.m4a', 'majorCombat');
}

/* THE BATTLE RECORD for analysis, like the turn-based Full Match Log: what
   happened, every order both sides gave, every dice result, and the AI's own
   counters, as JSON. */
export function battleRecord(){
  if(!battle) return null;
  const secs = Math.floor(battle.tick / TICKS_PER_SECOND);
  return JSON.stringify({
    kind: 'field-command-realtime-record', version: battle.version,
    seed: battle.seed, playerSide: battle.playerSide, board: { assignment: state.boardAssignment, rotation: state.boardRotation },
    result: battle.result, winner: battle.winner, seconds: secs,
    points: { red: points(battle, 'red'), blue: points(battle, 'blue') },
    stats: battle.stats, ai: ai ? ai.stats : null,
    units: battle.units.map(u => ({ id: u.id, side: u.side, type: u.type, brigadeId: u.brigadeId, x: u.x, y: u.y, removed: u.removed })),
    orders: battle.orderLog, events: battle.events,
  }, null, 1);
}

/* The result, once an army breaks. */
function showResult(){
  const won = battle.winner === battle.playerSide;
  document.getElementById('overlayTitle').textContent = !battle.winner ? 'Drawn' : won ? 'Victory' : 'Defeat';
  const secs = Math.floor(battle.tick / TICKS_PER_SECOND);
  const how = battle.result === 'clock'
    ? (battle.winner ? `Time is up: ${SIDE_LABEL[battle.winner]} ahead on points (${points(battle, battle.winner)} to ${points(battle, battle.winner === 'red' ? 'blue' : 'red')}). ` : 'Time is up, level on points. ')
    : `${SIDE_LABEL[battle.winner]} carries the field after ${Math.floor(secs/60)} min ${secs%60} s. `;
  document.getElementById('overlayText').innerHTML = how +
    `Units lost: ${SIDE_LABEL.red} ${battle.stats.destroyed.red || 0}, ${SIDE_LABEL.blue} ${battle.stats.destroyed.blue || 0}. ` +
    `Orders given: ${battle.orderLog.filter(o => o.side === battle.playerSide).length} by you, ${battle.orderLog.filter(o => o.side !== battle.playerSide).length} by the enemy. ` +
    `Guns fired ${battle.stats.shots || 0} times.`;
  const btn = document.getElementById('overlayBtn');
  btn.style.display = ''; btn.textContent = 'New Battle'; btn.onclick = () => location.reload();
  const extra = document.getElementById('modeChoices');
  if(extra){
    extra.innerHTML = ''; extra.style.display = 'flex';
    const exp = document.createElement('button');
    exp.textContent = 'Export Battle Record';
    exp.onclick = () => {
      document.getElementById('aiLogExportTitle').textContent = 'Real-Time Battle Record';
      document.getElementById('aiLogExportText').value = battleRecord();
      document.getElementById('aiLogExportPanel').classList.remove('hidden');
    };
    extra.appendChild(exp);
  }
  document.getElementById('overlay').classList.add('show');
}

/* The Group switch: off, a tap on your unit picks it alone; on, taps add and
   remove units, and a tap on the ground sends them all. */
function showGroupToggle(){
  const btn = document.createElement('button');
  btn.id = 'rtsGroupToggle';
  btn.type = 'button';
  btn.style.cssText = 'position:fixed;right:calc(env(safe-area-inset-right,0px) + 10px);top:calc(env(safe-area-inset-top,0px) + 6px);z-index:28;' +
    'font:15px "IM Fell English",Georgia,serif;min-height:40px;padding:6px 14px;border-radius:20px;border:1px solid #b8963f;cursor:pointer';
  const paint = () => {
    btn.textContent = groupMode ? 'Group: On' : 'Group: Off';
    btn.style.background = groupMode ? '#e0b85a' : 'rgba(20,24,20,.75)';
    btn.style.color = groupMode ? '#2a1e14' : '#fbf6ea';
  };
  btn.onclick = () => { groupMode = !groupMode; selected = groupMode ? selected : selected.slice(-1); reachCache = null; paint(); };
  paintGroupToggle = paint;
  paint();
  document.body.appendChild(btn);
}

/* ---------------------------------------------------------
   Clock and short notes
--------------------------------------------------------- */
let clockEl = null;
function showClock(){
  clockEl = document.createElement('div');
  clockEl.id = 'rtsClock';
  clockEl.style.cssText = 'position:fixed;top:calc(env(safe-area-inset-top,0px) + 6px);left:50%;transform:translateX(-50%);z-index:28;' +
    'font:14px "IM Fell English",Georgia,serif;color:#fbf6ea;background:rgba(20,24,20,.7);padding:3px 12px;border-radius:12px;pointer-events:none';
  document.body.appendChild(clockEl);
  updateClock();
}
function updateClock(){
  if(!clockEl) return;
  const secs = Math.max(0, Math.ceil((MATCH_CLOCK_TICKS - battle.tick) / TICKS_PER_SECOND));
  clockEl.textContent = `${String(Math.floor(secs/60)).padStart(2,'0')}:${String(secs%60).padStart(2,'0')} left`;
}
let toastTimer = null;
function toast(text){
  let el = document.getElementById('rtsToast');
  if(!el){
    el = document.createElement('div'); el.id = 'rtsToast';
    el.style.cssText = 'position:fixed;top:calc(env(safe-area-inset-top,0px) + 120px);left:50%;transform:translateX(-50%);z-index:29;' +
      'font:14px "IM Fell English",Georgia,serif;color:#fbf6ea;background:rgba(90,30,24,.85);padding:4px 12px;border-radius:12px;pointer-events:none;transition:opacity .3s';
    document.body.appendChild(el);
  }
  el.textContent = text; el.style.opacity = '1';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 1800);
}
