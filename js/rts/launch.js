/* =========================================================
   REAL-TIME FIELD COMMAND: the launcher (the one file the rest of the game
   may import from js/rts/, through a dynamic import in battle setup).

   Builds a standard board and both armies with the turn-based game's own
   code (read-only use of the shared modules), hands them to the simulation
   (sim.js), then runs it: the simulation advances on a fixed 10-per-second
   tick, and every animation frame the units' drawn positions are placed
   between ticks so movement is smooth at any frame rate.

   Phase 1 scaffold: tap one of your units, then tap a square to send it.
========================================================= */
import { assignBuildingStyles, assignGrassStyles, buildExcludedRoadEdgeSet, buildTerrainMap, COLS, ROWS, SIDES,
         TB_DATA, setBoardMode, state } from '../data-core.js';
import { isRoadLike, seededRandom, terrainAt } from '../engine-rules.js';
import { newUnit, resetHistoricalIdentities } from '../engine-state.js';
import { planArmyDeployment } from '../ai-deployment.js';
import { canvas, cellFromClient, consumeGestureFlag, draw, fromScreen, MOVE_PROFILES, playBoardIntroAnimation, sizeCanvas, unitAnimations } from '../render-board.js';
import { startAmbientLayer } from '../ui-menus.js';
import { AudioManager } from '../audio-manager.js';
import { MAX_TICKS_PER_FRAME, TICK_MS, TICKS_PER_SECOND } from './constants.js';
import { createBattle, issueOrder, loadBattle, saveBattle, step } from './sim.js';

let battle = null;
let running = false, lastFrame = 0, acc = 0;
let selectedId = null;

/* For tests and tools: the live battle, and a way to put a saved one back. */
export const currentBattle = () => battle;
export function exportBattle(){ return battle ? saveBattle(battle) : null; }
export function importBattle(json){ battle = loadBattle(json); mirrorUnits(0); draw(); }

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
  requestAnimationFrame(frame);
}
function frame(now){
  if(!running) return;
  acc += Math.min(250, now - lastFrame);     // a long gap (tab hidden) never becomes a burst of ticks
  lastFrame = now;
  let n = 0;
  while(acc >= TICK_MS && n < MAX_TICKS_PER_FRAME){ step(battle); acc -= TICK_MS; n++; }
  mirrorUnits(acc / TICK_MS);
  draw();
  updateClock();
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
  state.selectedUnitId = selectedId;
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
  if(here && here.side === battle.playerSide){ selectedId = here.id; return; }
  if(!selectedId) return;
  const res = issueOrder(battle, { unitId: selectedId, type: 'move', target: { x, y } });
  if(!res.ok) toast(res.reason);
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
