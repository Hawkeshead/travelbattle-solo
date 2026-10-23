/* =========================================================
   OPERATIONS: SETTING UP AND PLAYING A SCENARIO CARD
   (Operations and Campaigns brief, step 2: 2.1, 2.2, 2.3, 2.5, 2.7)

   An Operation is a Scenario Card (js/scenario-cards.js) played on a locked
   map with the card's own forces, placements and win conditions. This module
   sets one up and starts it; the objective engine itself lives in
   engine-objectives.js.

   LOCKED MAP (2.3). The card fixes which standard board goes on each half and
   its rotation; its overrides change single squares (a village extended, a
   road built over) before terrain v2 builds its layout. No orientation roll
   and no falling-tile intro.

   PLACEMENT (2.2). Both armies are placed for you, by the same planner the AI
   would use, then shown on the pre-battle brief:
   - "area": the Brigade fills the named area's squares, Buildings first, then
     Hills, then Woods; the Artillery takes the square nearest the enemy's
     edge, the Brigadier the most central square, so the Brigade starts in its
     chain. "split" divides one Brigade across two areas (Beaumont).
   - "edge": a compact block on the side's own two deployment rows, facing the
     objective: foot in the front rank (Guards first), cavalry on the flanks,
     Brigadier and guns behind.
   Placing your own units by hand (the brief's drag flow, illegal squares
   greyed) is the one part of 2.2 not built yet; see the commit message.

   MARCH OFF (2.5). A unit on its side's exit edge (the card's map.exits) that
   has not moved this phase and could legally move may march off: it spends
   its whole move and leaves the board, removed and escaped. Not a casualty:
   no skull, not counted by DESTROY or in losses.
========================================================= */
import { TERRAIN } from './data-core.js';
import { buildWater } from './engine-water.js';
import { ROWS, SIDES, assignBuildingStyles, assignGrassStyles, buildExcludedRoadEdgeSet, buildTerrainMap, setBoardMode, state, unitNationName } from './data-core.js';
import { getCard } from './scenario-cards.js';
import { log, logReplay, newUnit, resetHistoricalIdentities, resetUndoStack } from './engine-state.js';
import { movableUnitsForSide, seededRandom } from './engine-rules.js';
import { checkScenarioObjective, keySide, sideKey } from './engine-objectives.js';
import { draw, sizeCanvas } from './render-board.js';
import { planOperationPlacement } from './operation-placement.js';

const unitType = u => (typeof u === 'string' ? u : u.type);
export const exitRow = edge => (edge === 'britishEdge' ? ROWS - 1 : edge === 'frenchEdge' ? 0 : null);

/* ---------- the map ---------- */
/* AUTHORED MAPS (4 Oct 2026): an Operation can carry its own map, drawn for
   it, instead of two standard boards: map.type 'authored', map.terrain a list
   of rows, one character a square:
     .  open grass    :  farmland (ploughed)    *  woods
     ^  hill          #  buildings              =  road
   A 10 x 10 map is a single board (boardMode 'single'); 20 x 10 is the usual
   width. There are no physical boards to place, so no road-edge exclusions
   and no farm overlay beyond the farmland squares themselves. */
const GLYPH = { '.': 'OPEN', ':': 'PLOUGHED_FIELD', '*': 'WOODS', '^': 'HILL', '#': 'BUILDING', '=': 'ROAD' };
/* An authored map's road layer (map.roads, rows of '=' and '.', written by
   tools/maps/add-roads.mjs to the generated boards' rules), with every
   building square counted as road; null for a map without one. */
export function authoredRoads(m, t){
  if(!m || !Array.isArray(m.roads)) return null;
  return m.roads.map((row, y) => [...row].map((ch, x) => ch === '=' || t[y][x] === 'BUILDING'));
}
export function authoredTerrain(rows){ return rows.map(r => [...r].map(ch => GLYPH[ch] || 'OPEN')); }

export function applyLockedMap(card){
  const m = card.map;
  if(m.type === 'authored'){
    const t = authoredTerrain(m.terrain);
    setBoardMode(t[0].length === 10 && t.length === 10 ? 'single' : t[0].length === 10 && t.length === 20 ? 'corridor' : 'standard');
    state.boardAssignment = null;
    state.boardRotation = null;
    state.terrain = t;
    state.roads = authoredRoads(m, t); state.mapSeeds = null; state.water = buildWater(m.river); state.places = Array.isArray(m.places) ? m.places : null;   // its own road layer (tools/maps/add-roads.mjs), buildings as road
    state.grassStyles = assignGrassStyles(state.terrain);
    state.buildingStyles = assignBuildingStyles(state.terrain);
    state.excludedRoadEdges = new Set();
    return;
  }
  setBoardMode('standard');
  state.boardAssignment = { red: m.boards.red, blue: m.boards.blue };
  state.boardRotation = { red: m.rotation.red, blue: m.rotation.blue };
  const t = buildTerrainMap(state.boardAssignment, state.boardRotation);
  for(const o of (m.overrides || [])) if(t[o.y]) t[o.y][o.x] = o.terrain;
  state.terrain = t;
  state.roads = null; state.mapSeeds = null; state.water = null; state.places = null;   // a fixed map: roads are its ROAD squares (no road layer)
  state.grassStyles = assignGrassStyles(state.terrain);
  state.buildingStyles = assignBuildingStyles(state.terrain);
  state.excludedRoadEdges = buildExcludedRoadEdgeSet(state.boardAssignment, state.boardRotation);
}

/* Placement: js/operation-placement.js (pure). */
/* ---------- starting an Operation ---------- */
/* playerSide: the side the person plays (SIDES.RED or BLUE); null for AI
   against AI (the simulator, Spectate). */
export function setupOperation(cardOrId, playerSide){
  const card = typeof cardOrId === 'string' ? getCard(cardOrId) : cardOrId;
  if(!card || card.kind !== 'operation' || card.status !== 'ready') throw new Error('not a ready Operation: ' + (card && card.id));
  state.scenario = Object.assign(JSON.parse(JSON.stringify(card)), {
    _startFighters: Object.fromEntries(['british', 'french'].map(k => [k, card.forces[k].brigades.reduce((n, b) => n + b.units.filter(u => unitType(u) !== 'BRIGADIER').length, 0)])),
  });
  state.campaign = null;
  state.mapBattle = null;   // an Operation is never a campaign map battle
  state.scenarioResult = null; state.scenarioRounds = []; state.scenarioStreaks = {}; state.scenarioAchieved = {};
  state.gameOver = false; state.winner = null;
  state.turnNumber = 1;
  if(playerSide){ state.mode = 'ai'; state.spectate = false; state.aiSide = playerSide === SIDES.RED ? SIDES.BLUE : SIDES.RED; }
  state.aiDifficulty = 'hard';
  applyLockedMap(card);
  resetHistoricalIdentities();
  resetUndoStack();
  /* A nation per Brigade, and the player's allied Brigades handed to a
     friendly AI commander (campaign battles: brigade.nation, brigade.ai; the
     Quick Battle machinery in friendly-ai.js runs them). Cleared otherwise. */
  const SIDE_OF_KEY = { british: SIDES.RED, french: SIDES.BLUE };
  const nationKey = n => n ? String(n).toLowerCase() : null;
  const anyNation = ['british', 'french'].some(k => card.forces[k].brigades.some(b => b.nation));
  state.brigadeNations = anyNation ? { red: card.forces.british.brigades.map(b => nationKey(b.nation)), blue: card.forces.french.brigades.map(b => nationKey(b.nation)) } : null;
  state.friendlyAi = null;
  if(playerSide){
    const key = playerSide === SIDES.RED ? 'british' : 'french';
    const ai = card.forces[key].brigades.map((b, i) => b.ai ? `${SIDE_OF_KEY[key]}:${i}` : null).filter(Boolean);
    state.friendlyAi = ai.length ? ai : null;
  }
  state.units = [];
  state.reserves = [];
  state._wavesSent = 0;
  for(const p of planOperationPlacement(card, state.terrain)){
    const u = newUnit(p.side, p.type, p.reserve ? -1 : p.x, p.reserve ? -1 : p.y, p.brigadeId);
    if(p.formation) u.formation = p.formation;
    if(p.tag) u.storyTag = p.tag;   // a campaign Brigade's tag, for its objectives (objective-core.js)
    if(p.name) u.historicalName = p.name;   // a campaign battle names its own units and commanders
    if(p.locked) u._lockedUntil = p.locked;   // a Brigade held back until this round (engine-rules isLocked)
    const cardB = card.forces[p.side === SIDES.RED ? 'british' : 'french'].brigades[p.brigadeId];
    if(p.type === 'BRIGADIER' && cardB && cardB.vip){ u.captureRule = 'enterSquare'; u.historicalName = u.historicalName || cardB.name; }   // a hunted commander: taken by a unit ending its move in his square
    if(p.reserve) state.reserves.push({ unit: u, round: p.reserve.round, area: p.reserve.area });
    else state.units.push(u);
  }
  regroupBrigades(card);

  state.phase = 'deploy';
  state.deployPool = { red: [], blue: [] };
  state.deployBrigadeIndex = { red: card.forces.british.brigades.length, blue: card.forces.french.brigades.length };
  log(`Operation: ${card.name}, ${card.date}. ${card.turnLimit} rounds.`, 'system');
  return state.scenario;
}

/* KEEP BRIGADES IN COMMAND AT THE START (found with the sparring server,
   19 Oct 2026). The placement plan spreads a Brigade's units over its
   starting squares, and in most Waterloo battles a third to two thirds of the
   units began cut off from their Brigadier, unable to move. After placement,
   each cut-off unit is moved to the nearest free square of its own starting
   squares (its area, or its side's home rows, three deep) that brings it back into
   its Brigadier's chain, nearest its Brigadier first. */
function regroupBrigades(card){
  const rows = state.terrain.length, cols = state.terrain[0].length;
  const areas = (card.map && card.map.areas) || {};
  const free = (x, y) => !state.units.some(o => !o.removed && o.x === x && o.y === y);
  const passable = (u, x, y) => { const t = TERRAIN[state.terrain[y][x]] || {}; return !(t.restrictTo && !t.restrictTo.includes(u.type)); };
  for(const side of [SIDES.RED, SIDES.BLUE]){
    const key = side === SIDES.RED ? 'british' : 'french';
    const home = side === SIDES.RED ? [rows - 3, rows - 2, rows - 1] : [0, 1, 2];   // a third row if the two home rows are full
    /* First, each Brigadier to the free starting square nearest the middle
       of his own units (the Guard's Brigadier at Ligny had been placed among
       another Brigade, with his battalions out on both flanks). */
    for(const brig of state.units.filter(o => !o.removed && o.side === side && o.type === 'BRIGADIER')){
      const own = state.units.filter(o => !o.removed && o.side === side && o.type !== 'BRIGADIER' && o.brigadeId === brig.brigadeId);
      if(!own.length) continue;
      const cx = own.reduce((n, o) => n + o.x, 0) / own.length, cy = own.reduce((n, o) => n + o.y, 0) / own.length;
      const b = card.forces[key].brigades[brig.brigadeId] || {};
      const p = b.placement || { type: 'edge' };
      const names = p.type === 'area' ? (p.split ? p.split.map(g => g.area) : [p.area]) : [];
      if(names.length) continue;   // a placed commander (Blucher, Wellington) stays where the battle puts him
      const spots = home.flatMap(y => Array.from({ length: cols }, (_, x) => ({ x, y }))).filter(c => free(c.x, c.y) && passable(brig, c.x, c.y));
      spots.sort((a2, c) => Math.hypot(a2.x - cx, a2.y - cy) - Math.hypot(c.x - cx, c.y - cy));
      if(spots.length && Math.hypot(spots[0].x - cx, spots[0].y - cy) < Math.hypot(brig.x - cx, brig.y - cy)){ brig.x = spots[0].x; brig.y = spots[0].y; }
    }
    for(let pass = 0; pass < 3; pass++){
      const movable = movableUnitsForSide(side);
      const cut = state.units.filter(u => !u.removed && u.side === side && u.type !== 'BRIGADIER' && !movable.has(u.id));
      if(!cut.length) break;
      for(const u of cut){
        const b = card.forces[key].brigades[u.brigadeId] || {};
        const p = b.placement || { type: 'edge' };
        if(p.split) continue;   // placed square by square on purpose (the 92nd at the crossroads, Blucher's escort, the Brye rearguard): left where the battle puts them
        const names = p.type === 'area' ? (p.split ? p.split.map(g => g.area) : [p.area]) : [];
        let squares = names.flatMap(n => (areas[n] || []).map(([x, y]) => ({ x, y })));
        if(!squares.length) squares = home.flatMap(y => Array.from({ length: cols }, (_, x) => ({ x, y })));
        const brig = state.units.find(o => !o.removed && o.side === side && o.type === 'BRIGADIER' && o.brigadeId === u.brigadeId);
        if(!brig) continue;
        const cands = squares.filter(c => free(c.x, c.y) && passable(u, c.x, c.y))
          .sort((a, c) => Math.max(Math.abs(a.x - brig.x), Math.abs(a.y - brig.y)) - Math.max(Math.abs(c.x - brig.x), Math.abs(c.y - brig.y)));
        const was = { x: u.x, y: u.y };
        for(const c of cands){
          u.x = c.x; u.y = c.y;
          if(movableUnitsForSide(side).has(u.id)) break;
          u.x = was.x; u.y = was.y;
        }
      }
    }
  }
}

/* REINFORCEMENTS ARRIVE at the start of their side's turn in their round (or
   later, if every arrival square is taken): on the squares of their arrival
   area, or else their side's home row, nearest the middle first. */
export function bringReinforcements(side){
  if(!state.reserves || !state.reserves.length) return;
  const round = Math.max(1, Math.ceil((state.turnNumber || 1) / 2));
  const due = state.reserves.filter(r => r.unit.side === side && r.round <= round);
  if(!due.length) return;
  const rows = state.terrain.length, cols = state.terrain[0].length;
  const areas = (state.scenario && state.scenario.map && state.scenario.map.areas) || {};
  const free = (x, y) => x >= 0 && y >= 0 && x < cols && y < rows && !state.units.some(o => !o.removed && o.x === x && o.y === y);
  let arrived = 0;
  /* A Brigade arrives TOGETHER (found 21 Oct 2026: Kellermann's cuirassiers at
     Quatre Bras spent 14 to 25 decisions a match cut off). Its Brigadier comes
     on first, then each of his units takes the free arrival square nearest
     him, so the chain is whole from the first turn. Units whose Brigadier is
     already on the field (arrivals joining a Brigade) close on him too. */
  due.sort((a, b) => (a.unit.type === 'BRIGADIER' ? 0 : 1) - (b.unit.type === 'BRIGADIER' ? 0 : 1));
  for(const r of due){
    const home = side === SIDES.RED ? rows - 1 : 0;
    const brig = r.unit.type === 'BRIGADIER' ? null
      : state.units.find(o => !o.removed && o.side === side && o.type === 'BRIGADIER' && o.brigadeId === r.unit.brigadeId);
    const near = c => brig ? Math.max(Math.abs(c.x - brig.x), Math.abs(c.y - brig.y)) * 100 + Math.abs(c.x - cols / 2) : Math.abs(c.x - cols / 2);
    const cells = (r.area && areas[r.area] ? areas[r.area].map(([x, y]) => ({ x, y })) : Array.from({ length: cols }, (_, x) => ({ x, y: home })))
      .filter(c => free(c.x, c.y)).sort((a, b) => near(a) - near(b));
    if(!cells.length) continue;
    r.unit.x = cells[0].x; r.unit.y = cells[0].y;
    r.unit._arrivedRound = round;   // the round it came on (mistaken identity, engine-rules)
    state.units.push(r.unit);
    state.reserves.splice(state.reserves.indexOf(r), 1);
    logReplay('arrive', { unitId: r.unit.id, side, x: r.unit.x, y: r.unit.y, round });
    arrived++;
  }
  if(arrived) log(`Reinforcements arrive: ${arrived} unit${arrived === 1 ? '' : 's'} for ${side === SIDES.RED ? 'the Coalition' : 'France'}.`, 'system');
}

/* Who moves first (2.4 / the card's firstPlayer): british, french, or a die. */
export function operationFirstMover(){
  const f = state.scenario && state.scenario.firstPlayer;
  if(f === 'british' || f === 'french') return keySide(f);
  return seededRandom() < 0.5 ? SIDES.RED : SIDES.BLUE;
}

/* Brigades a side actually has (pips, AI): 1 to 3 in an Operation, 3 otherwise. */
export function brigadeIdsFor(side){
  if(state.scenario && state.scenario.forces && state.scenario.forces[sideKey(side)]) return state.scenario.forces[sideKey(side)].brigades.map((_, i) => i);
  return [0, 1, 2];
}

/* chainWaivedTurn1 (2.6): the side's units may move without Brigadier contact
   during its first turn only. */
export function chainWaived(side){
  const sr = state.scenario && state.scenario.specialRules;
  if(!sr || !Array.isArray(sr.chainWaivedTurn1) || !sr.chainWaivedTurn1.includes(sideKey(side))) return false;
  return (state.turnNumber || 1) <= 2 && state.phase !== 'deploy';
}

/* ---------- March Off ---------- */
export function exitEdgeRow(side){
  const ex = state.scenario && state.scenario.map && state.scenario.map.exits;
  return ex && ex[sideKey(side)] ? exitRow(ex[sideKey(side)]) : null;
}
export function canMarchOff(u){
  if(!u || u.removed || !state.scenario || state.phase !== 'move' || u.side !== state.turn) return false;
  const row = exitEdgeRow(u.side);
  if(row == null || u.y !== row) return false;
  if(state.moved && state.moved.has(u.id)) return false;
  if(u.turnOnly || u.formation === 'square' || u.noActionThisTurn) return false;
  return movableUnitsForSide(u.side).has(u.id) || chainWaived(u.side);
}
export function marchOff(u){
  if(!canMarchOff(u)) return false;
  u.removed = true;
  u.escaped = true;
  u.removedTurn = state.turnNumber;
  if(state.moved) state.moved.add(u.id);
  logReplay('status', { unitId: u.id, side: u.side, x: u.x, y: u.y, newStatus: 'MarchedOff', reason: 'marched off the field' });
  log(`${u.historicalName || u.type} (${unitNationName(u)}) marches off the field.`, 'system');
  try { draw(); } catch { /* headless */ }
  checkScenarioObjective();
  return true;
}

/* ---------- the pre-battle brief (2.7) ---------- */
export function operationBriefHTML(card, playerSide){
  const you = playerSide ? sideKey(playerSide) : null;
  const obj = k => `<div class="op-obj${k === you ? ' you' : ''}"><b>${k === 'british' ? 'Britain' : 'France'}${k === you ? ' (you)' : ''}:</b> ${card.win[k].text}</div>`;
  return `<div class="op-brief">
    <div class="op-date">${card.date} · ${card.archetype || 'Operation'}</div>
    ${card.intro ? `<p class="op-intro">${card.intro}</p>` : ''}
    ${obj('british')}${obj('french')}
    <div class="op-limit">${card.turnLimit} rounds. ${card.ifTimeExpires ? `If time runs out, ${card.ifTimeExpires === 'british' ? 'Britain' : 'France'} wins.` : ''}</div>
  </div>`;
}
export function redrawOperation(){ try { sizeCanvas(); draw(); } catch { /* headless */ } }
