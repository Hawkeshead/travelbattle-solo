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

export function setupBattle(playerSide){
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

  // Army choice comes later; for now each side gets one at random.
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
  return createBattle({ seed: Math.floor(seededRandom() * 4294967296), terrain: state.terrain, road, units: state.units, playerSide });
}
