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
import { assignBuildingStyles, assignGrassStyles, buildExcludedRoadEdgeSet, buildTerrainMap, COLS, ROWS, SIDES,
         TB_DATA, setBoardMode, state } from '../data-core.js';
import { isRoadLike, seededRandom, terrainAt } from '../engine-rules.js';
import { newUnit, resetHistoricalIdentities } from '../engine-state.js';
import { planArmyDeployment } from '../ai-deployment.js';
import { canvas, cellFromClient, consumeGestureFlag, ctx, draw, fromScreen, getUnitVisualPos, MOVE_PROFILES, playBoardIntroAnimation, sizeCanvas, toScreen, unitAnimations } from '../render-board.js';
import { CELL, SIDE_LABEL } from '../data-core.js';
import { emitFloatingText } from '../floating-text.js';
import { startAmbientLayer } from '../ui-menus.js';
import { AudioManager } from '../audio-manager.js';
import { MAX_TICKS_PER_FRAME, TICK_MS, TICKS_PER_SECOND } from './constants.js';
import { createBattle, isBusy, issueGroupOrder, issueOrder, loadBattle, poolOf, readiness01, saveBattle, step } from './sim.js';
import { turnBasedRules } from './rules-adapter.js';

let battle = null;
let running = false, lastFrame = 0, acc = 0;
let selected = [];                 // unit ids, in the order they were picked
let groupMode = false;
let reachCache = null;             // { id, tick, cells } for the single selected unit's range
let paintGroupToggle = null;

/* For tests and tools: the live battle, and a way to put a saved one back. */
export const currentBattle = () => battle;
export function exportBattle(){ return battle ? saveBattle(battle) : null; }
export function importBattle(json){ battle = loadBattle(json); mirrorUnits(0); draw(); }
export const rtsSelection = () => selected.slice();
export function setGroupMode(on){ groupMode = !!on; if(paintGroupToggle) paintGroupToggle(); }

export function launchRealTime(){
  const playerSide = state.aiSide === SIDES.RED ? SIDES.BLUE : SIDES.RED;
  state.scenario = null; state.campaign = null; state.spectate = false;
  state.rts = true;                         // marks this page as a Real-Time battle; nothing in turn-based reads it
  setBoardMode('standard');
  AudioManager.stopMusic();

  const keys = seededRandom() < 0.5 ? ['A','B'] : ['B','A'];
  state.boardAssignment = { red: keys[0], blue: keys[1] };
  state.boardRotation = { red: Math.floor(seededRandom()*4), blue: Math.floor(seededRandom()*4) };
  state.terrain = buildTerrainMap(state.boardAssignment, state.boardRotation);
  state.grassStyles = assignGrassStyles(state.terrain);
  state.buildingStyles = assignBuildingStyles(state.terrain);
  state.excludedRoadEdges = buildExcludedRoadEdgeSet(state.boardAssignment, state.boardRotation);

  // Both armies placed by the standard auto-deploy, one after the other so the
  // second respects the first. Army choice comes later; for now each side
  // gets one at random.
  resetHistoricalIdentities();
  state.units.length = 0;
  state.deployBrigadeIndex = { red: 0, blue: 0 };
  state.phase = 'rts';
  const armies = TB_DATA.armyCompositions;
  for(const side of [SIDES.RED, SIDES.BLUE]){
    const army = armies[Math.floor(seededRandom() * armies.length)];
    for(const g of planArmyDeployment(side, army.id)) state.units.push(newUnit(side, g.type, g.x, g.y, g.brigadeId));
  }

  const road = [];
  for(let y=0; y<ROWS; y++){ road.push([]); for(let x=0; x<COLS; x++) road[y].push(isRoadLike(terrainAt(x,y))); }
  battle = createBattle({ seed: Math.floor(seededRandom() * 4294967296), terrain: state.terrain, road, units: state.units, playerSide });

  document.getElementById('overlay').classList.remove('show');
  document.getElementById('sidebar').style.display = 'none';
  const dock = document.getElementById('phaseDock'); if(dock) dock.style.display = 'none';
  sizeCanvas();
  attachInput();
  AudioManager.playAmbience('audio/ambience/countryside.mp3');
  playBoardIntroAnimation(() => { startAmbientLayer(); start(); });
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
function frame(now){
  if(!running) return;
  acc += Math.min(250, now - lastFrame);     // a long gap (tab hidden) never becomes a burst of ticks
  lastFrame = now;
  let n = 0;
  while(acc >= TICK_MS && n < MAX_TICKS_PER_FRAME && !battle.over){ step(battle, turnBasedRules); acc -= TICK_MS; n++; }
  mirrorUnits(acc / TICK_MS);
  draw();
  drawCommandOverlay();
  showNewEvents();
  updateClock();
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
  if(!battle) return;
  const here = battle.units.find(u => !u.removed && ((u.x === x && u.y === y) || (u.step && u.step.toX === x && u.step.toY === y)));
  if(here && here.side === battle.playerSide){
    if(groupMode){
      selected = selected.includes(here.id) ? selected.filter(id => id !== here.id) : [...selected, here.id];
    } else {
      selected = selected.length === 1 && selected[0] === here.id ? [] : [here.id];
    }
    reachCache = null;
    return;
  }
  if(here){ toast('That is the enemy'); return; }
  if(!selected.length) return;
  const res = (groupMode && selected.length > 1)
    ? issueGroupOrder(battle, { unitIds: selected, type: 'move', target: { x, y }, side: battle.playerSide }, turnBasedRules)
    : issueOrder(battle, { unitId: selected[0], type: 'move', target: { x, y }, side: battle.playerSide }, turnBasedRules);
  if(!res.ok){ toast(res.reason); return; }
  if(groupMode) selected = [];
  reachCache = null;
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
    if(e.kind === 'contact' || e.x == null) continue;
    const bad = e.side === battle.playerSide && /pushed|routed|destroyed|Fails|Destroyed/.test(e.text);
    emitFloatingText({ col: e.x, row: e.y, text: e.text, kind: bad ? 'penalty' : 'command' });
  }
}

/* The result, once an army breaks. */
function showResult(){
  const won = battle.winner === battle.playerSide;
  document.getElementById('overlayTitle').textContent = won ? 'Victory' : 'Defeat';
  const secs = Math.floor(battle.tick / TICKS_PER_SECOND);
  document.getElementById('overlayText').innerHTML =
    `${SIDE_LABEL[battle.winner]} carries the field after ${Math.floor(secs/60)} min ${secs%60} s. ` +
    `Units lost: ${SIDE_LABEL.red} ${battle.stats.destroyed.red || 0}, ${SIDE_LABEL.blue} ${battle.stats.destroyed.blue || 0}.`;
  const btn = document.getElementById('overlayBtn');
  btn.style.display = ''; btn.textContent = 'New Battle'; btn.onclick = () => location.reload();
  const extra = document.getElementById('modeChoices'); if(extra){ extra.innerHTML = ''; extra.style.display = 'none'; }
  document.getElementById('overlay').classList.add('show');
}

/* The Group switch: off, a tap on your unit picks it alone; on, taps add and
   remove units, and a tap on the ground sends them all. */
function showGroupToggle(){
  const btn = document.createElement('button');
  btn.id = 'rtsGroupToggle';
  btn.type = 'button';
  btn.style.cssText = 'position:fixed;right:calc(env(safe-area-inset-right,0px) + 10px);bottom:calc(env(safe-area-inset-bottom,0px) + 10px);z-index:28;' +
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
  const secs = Math.floor(battle.tick / TICKS_PER_SECOND);
  clockEl.textContent = `Real-Time \u00b7 ${String(Math.floor(secs/60)).padStart(2,'0')}:${String(secs%60).padStart(2,'0')}`;
}
let toastTimer = null;
function toast(text){
  let el = document.getElementById('rtsToast');
  if(!el){
    el = document.createElement('div'); el.id = 'rtsToast';
    el.style.cssText = 'position:fixed;bottom:calc(env(safe-area-inset-bottom,0px) + 14px);left:50%;transform:translateX(-50%);z-index:28;' +
      'font:14px "IM Fell English",Georgia,serif;color:#fbf6ea;background:rgba(90,30,24,.85);padding:4px 12px;border-radius:12px;pointer-events:none;transition:opacity .3s';
    document.body.appendChild(el);
  }
  el.textContent = text; el.style.opacity = '1';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 1800);
}
