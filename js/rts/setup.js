/* A fresh Real-Time battle: a standard board (random boards and turns, as
   turn-based does) and both armies placed by the turn-based auto-deploy, one
   after the other so the second respects the first. Shared by the browser
   launcher and the headless simulator, so both start battles the same way.
   Read-only use of the shared modules. */
import { assignBuildingStyles, assignGrassStyles, buildExcludedRoadEdgeSet, buildTerrainMap, COLS, ROWS, SIDES,
         TB_DATA, setBoardMode, state } from '../data-core.js';
import { isRoadLike, seededRandom, terrainAt } from '../engine-rules.js';
import { newUnit, resetHistoricalIdentities } from '../engine-state.js';
import { planArmyDeployment } from '../ai-deployment.js';
import { createBattle } from './sim.js';

/* The board on its own, with no armies yet. */
export function setupBoard(){
  state.scenario = null; state.campaign = null;
  state.rts = true;                         // marks a Real-Time battle; nothing in turn-based reads it
  setBoardMode('standard');
  const keys = seededRandom() < 0.5 ? ['A','B'] : ['B','A'];
  state.boardAssignment = { red: keys[0], blue: keys[1] };
  state.boardRotation = { red: Math.floor(seededRandom()*4), blue: Math.floor(seededRandom()*4) };
  state.terrain = buildTerrainMap(state.boardAssignment, state.boardRotation);
  state.grassStyles = assignGrassStyles(state.terrain);
  state.buildingStyles = assignBuildingStyles(state.terrain);
  state.excludedRoadEdges = buildExcludedRoadEdgeSet(state.boardAssignment, state.boardRotation);
  resetHistoricalIdentities();
  state.units.length = 0;
  state.deployBrigadeIndex = { red: 0, blue: 0 };
  state.phase = 'rts';
}

/* One side's army, placed by the turn-based auto-deploy around whatever is
   already on the board. armyId null: one at random (the AI's way). */
export function placeArmy(side, armyId){
  const armies = TB_DATA.armyCompositions;
  const army = armyId ? armies.find(a => a.id === armyId) : armies[Math.floor(seededRandom() * armies.length)];
  for(const g of planArmyDeployment(side, army.id)) state.units.push(newUnit(side, g.type, g.x, g.y, g.brigadeId));
  return army;
}

/* The battle itself, from the board and armies as they stand. */
export function finishBattle(playerSide){
  const road = [];
  for(let y=0; y<ROWS; y++){ road.push([]); for(let x=0; x<COLS; x++) road[y].push(isRoadLike(terrainAt(x,y))); }
  return createBattle({ seed: Math.floor(seededRandom() * 4294967296), terrain: state.terrain, road, units: state.units, playerSide });
}

/* All at once, both armies at random: the simulator's way. */
export function setupBattle(playerSide){
  setupBoard();
  for(const side of [SIDES.RED, SIDES.BLUE]) placeArmy(side, null);
  return finishBattle(playerSide);
}
