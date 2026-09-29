import { AudioManager } from './audio-manager.js';
import { assignBuildingStyles, assignGrassStyles, buildExcludedRoadEdgeSetGrand, buildTerrainMapGrand, generateGrandQuadrants, setBoardMode, state } from './data-core.js';
import { deployGroupArmy } from './ai-deployment.js';
import { seededRandom } from './engine-rules.js';
import { log, resetHistoricalIdentities, resetUndoStack } from './engine-state.js';
import { armyById, rollTurnOrder } from './group.js';
import { draw, sizeCanvas } from './render-board.js';
import { startBattle, updateHeader } from './ui-battle.js';
import { ensureModeChoices, showGroupArmyPicker, showModeSelect, startAmbientLayer } from './ui-menus.js';

/* =========================================================
   ONLINE GROUP: the four-army 2v2 mode's front door.

   Pass and Play (one phone handed round) is the first way in, so the whole
   mode can be played and tested before the four-phone online version, which
   reuses everything here and adds the lobby and the connection.
========================================================= */
export function showGroupMenu(){
  const box = document.querySelector('#overlay .box');
  if(box) box.classList.remove('as-folio');
  document.getElementById('overlayTitle').textContent = 'Online Group';
  document.getElementById('overlaySubtitle').style.display = 'none';
  document.getElementById('overlayText').innerHTML =
    'Two against two on the four-board map. Britain and her second army hold the south and east edges, France and hers the north and west. ' +
    'One army moves at a time, alternating sides. An army is broken when two of its three Brigades are; a side loses when both its armies are broken. ' +
    'With three players, one commands both armies of a side.';
  document.getElementById('overlayBtn').style.display = 'none';
  const extra = ensureModeChoices();
  extra.innerHTML = '';
  extra.style.display = 'flex';

  const local = document.createElement('button');
  local.className = 'primary';
  local.textContent = 'Pass and Play (one phone)';
  local.onclick = ()=>{ extra.style.display = 'none'; beginGroupMatch(); };

  const online = document.createElement('button');
  online.textContent = 'Online (a phone each)';
  online.onclick = ()=>{ extra.style.display = 'none'; document.getElementById('overlay').classList.remove('show');
    import('./online-group.js').then(m => m.openGroupLobby()); };

  const back = document.createElement('button');
  back.textContent = 'Back';
  back.onclick = ()=> showModeSelect();

  extra.appendChild(local);
  extra.appendChild(online);
  extra.appendChild(back);
  document.getElementById('overlay').classList.add('show');
}

export function beginGroupMatch(){
  prepareGroupBoard();
  // Armies choose in an alternating order too, so neither side always sees the
  // other's whole deployment before committing its own.
  const order = rollTurnOrder(seededRandom).map(armyById);
  deployNext(order, 0);
}

/* The four-board map and a clean slate, ready for deployment. Shared by Pass
   and Play and the online host. */
export function prepareGroupBoard(){
  state.scenario = null;
  state.campaign = null;
  state.spectate = false;
  state.mode = 'hotseat';
  state.group = true;
  state.groupArmyOut = {};
  setBoardMode('grand');
  AudioManager.stopMusic();
  const quadrants = generateGrandQuadrants();
  state.grandQuadrants = quadrants;
  state.terrain = buildTerrainMapGrand(quadrants);
  state.grassStyles = assignGrassStyles(state.terrain);
  state.buildingStyles = assignBuildingStyles(state.terrain);
  state.excludedRoadEdges = buildExcludedRoadEdgeSetGrand(quadrants);
  sizeCanvas();
  document.getElementById('overlay').classList.remove('show');
  startAmbientLayer();

  resetHistoricalIdentities();
  state.units.length = 0;
  state.turnNumber = 1;
  state.captureHoldCounter = { red:0, blue:0 };
  state.phase = 'deploy';
  resetUndoStack();
  document.getElementById('unitOverlay').classList.add('hidden');
  const dock = document.getElementById('phaseDock'); if(dock) dock.style.display = 'none';
  log('Online Group: four armies, two sides, on the four-board map.', 'system');
}

function deployNext(order, i){
  if(i >= order.length){
    state.viewEdge = null;
    draw();
    startBattle();
    return;
  }
  const army = order[i];
  state.deployTurn = army.side;
  updateHeader();
  showGroupArmyPicker(army, (composition)=>{
    deployGroupArmy(army, composition.id);
    log(`${army.label} deploys as ${composition.name}.`, 'system');
    draw();
    deployNext(order, i+1);
  });
}

