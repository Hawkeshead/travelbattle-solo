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
import { ROWS, SIDES, SIDE_LABEL, assignBuildingStyles, assignGrassStyles, buildExcludedRoadEdgeSet, buildTerrainMap, setBoardMode, state } from './data-core.js';
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
export function authoredTerrain(rows){ return rows.map(r => [...r].map(ch => GLYPH[ch] || 'OPEN')); }

export function applyLockedMap(card){
  const m = card.map;
  if(m.type === 'authored'){
    const t = authoredTerrain(m.terrain);
    setBoardMode(t[0].length === 10 && t.length === 10 ? 'single' : 'standard');
    state.boardAssignment = null;
    state.boardRotation = null;
    state.terrain = t;
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
  state.scenarioResult = null; state.scenarioRounds = []; state.scenarioStreaks = {};
  state.gameOver = false; state.winner = null;
  state.turnNumber = 1;
  if(playerSide){ state.mode = 'ai'; state.spectate = false; state.aiSide = playerSide === SIDES.RED ? SIDES.BLUE : SIDES.RED; }
  state.aiDifficulty = 'hard';
  applyLockedMap(card);
  resetHistoricalIdentities();
  resetUndoStack();
  state.units = [];
  for(const p of planOperationPlacement(card, state.terrain)){
    const u = newUnit(p.side, p.type, p.x, p.y, p.brigadeId);
    if(p.formation) u.formation = p.formation;
    state.units.push(u);
  }
  state.phase = 'deploy';
  state.deployPool = { red: [], blue: [] };
  state.deployBrigadeIndex = { red: card.forces.british.brigades.length, blue: card.forces.french.brigades.length };
  log(`Operation: ${card.name}, ${card.date}. ${card.turnLimit} rounds.`, 'system');
  return state.scenario;
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
  log(`${u.historicalName || u.type} (${SIDE_LABEL[u.side]}) marches off the field.`, 'system');
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
