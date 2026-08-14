/* =========================================================
   DEPLOYMENT PHASE
   Rulebook: players alternate placing whole Brigades, not individual
   units, and choose freely which units go into each Brigade — the
   only constraint is a Brigadier first, then at least 2 more units.
   state.deployPool[side] holds every not-yet-placed unit type for
   that side (starts as the full 17-unit army). state.deployBrigadeIndex
   tracks which Brigade (0-2) a side is currently filling. Control only
   passes to the other side once the active side confirms their current
   Brigade (Brigadier + at least 2 more units).
========================================================= */
const FULL_ARMY_POOL = BRIGADE_COMPOSITIONS.flat(); // 3 Brigadier, 2 Guard, 6 Infantry, 2 Heavy Cav, 2 Light Cav, 2 Artillery
const FULL_ARMY_POOL_GRAND = TB_DATA.unitTypes.brigadeCompositionsGrand.flat(); // Grand Strategy: 3 Brigadier, 4 Guard, 12 Infantry, 4 Heavy Cav, 4 Light Cav, 4 Artillery

function initDeployment(){
  resetHistoricalIdentities();
  state.captureHoldCounter = { red:0, blue:0 };
  state.turnNumber = 1;
  if(state.scenario){
    state.deployPool = { red: [...state.scenario.sides.red.units], blue: [...state.scenario.sides.blue.units] };
  } else if(state.boardMode==='grand'){
    state.deployPool = { red: [...FULL_ARMY_POOL_GRAND], blue: [...FULL_ARMY_POOL_GRAND] };
  } else {
    state.deployPool = { red: [...FULL_ARMY_POOL], blue: [...FULL_ARMY_POOL] };
  }
  state.deployBrigadeIndex = { red: 0, blue: 0 };
  state.currentBrigadeHasBrigadier = { red: false, blue: false };
  state.currentBrigadeCount = { red: 0, blue: 0 };
  state._aiHardDeployRemaining = { red:{}, blue:{} };
  state.deployTurn = Math.random()<0.5 ? SIDES.RED : SIDES.BLUE;
  resetUndoStack();
  log(`Roll for first placement: ${SIDE_LABEL[state.deployTurn]} places their first Brigade.`, 'system');
  document.getElementById('sidebar').style.display='flex';
  document.getElementById('rosterPanel').style.display='flex';
  document.getElementById('unitOverlay').classList.add('hidden');
  renderRoster();
  updateHeader();
  if(state.mode==='ai' && state.deployTurn===state.aiSide){
    setTimeout(aiDeployStep, 500);
  }
}

function sideFullyDeployed(side){ return state.deployBrigadeIndex[side] >= 3; }

// How many more non-Brigadier units side may add to their CURRENT Brigade
// right now without leaving a future Brigade short of its 2-unit minimum.
function canAddMoreToCurrentBrigade(side){
  const bIdx = state.deployBrigadeIndex[side];
  const remainingBrigadesAfter = 2 - bIdx;
  const poolNonBrig = state.deployPool[side].filter(t=>t!=='BRIGADIER').length;
  return (poolNonBrig - 1) >= 2*remainingBrigadesAfter;
}

let selectedDeployType = null;
function renderRoster(){
  const list = document.getElementById('rosterList');
  const progress = document.getElementById('brigadeProgress');
  const confirmBtn = document.getElementById('confirmBrigadeBtn');
  list.innerHTML = '';
  const side = state.deployTurn;

  if(sideFullyDeployed(side)){
    document.getElementById('rosterTitle').textContent = `${SIDE_LABEL[side]}: fully deployed`;
    progress.textContent = '';
    confirmBtn.style.display = 'none';
    checkDeployAdvance();
    return;
  }

  const bIdx = state.deployBrigadeIndex[side];
  const hasBrig = state.currentBrigadeHasBrigadier[side];
  const count = state.currentBrigadeCount[side];
  document.getElementById('rosterTitle').textContent = `${SIDE_LABEL[side]}: Brigade ${bIdx+1} of 3`;
  progress.textContent = !hasBrig
    ? 'Place a Brigadier to start this Brigade'
    : `${count} unit${count===1?'':'s'} placed (minimum 2)`;

  const pool = state.deployPool[side];
  const showTypes = !hasBrig
    ? pool.filter(t=>t==='BRIGADIER')
    : pool.filter(t=>t!=='BRIGADIER');
  const capped = hasBrig && !canAddMoreToCurrentBrigade(side);

  // de-duplicate for display (e.g. 6x Infantry shows as one chip you can tap repeatedly)
  const seen = {};
  showTypes.forEach((typeKey)=>{
    if(seen[typeKey]) return;
    seen[typeKey] = true;
    const remainingOfType = showTypes.filter(t=>t===typeKey).length;
    const t = UNIT_TYPES[typeKey];
    const chip = document.createElement('div');
    const disabled = capped;
    chip.className = 'roster-chip' + (selectedDeployType===typeKey ? ' selected' : '') + (disabled ? ' placed' : '');
    chip.innerHTML = `<div class="swatch" style="background:${SIDE_COLOR[side]}"></div><div>${t.label} ${remainingOfType>1?`(${remainingOfType} left)`:''}</div>`;
    if(!disabled){
      chip.onclick = ()=>{ selectedDeployType = typeKey; renderRoster(); };
      chip.addEventListener('pointerdown', (e)=> startChipDrag(e, typeKey));
    }
    list.appendChild(chip);
  });
  if(capped){
    const note = document.createElement('div');
    note.style.cssText = 'color:var(--ink-dim);font-size:11px;padding:4px 2px;font-style:italic;';
    note.textContent = 'Remaining units are reserved for your other Brigades.';
    list.appendChild(note);
  }

  confirmBtn.style.display = hasBrig ? 'inline-block' : 'none';
  confirmBtn.disabled = !(hasBrig && count>=2);
  draw();
}

/* =========================================================
   DEPLOYMENT: DRAG AND DROP
   A roster chip can be tapped (existing select-then-tap-board flow,
   unchanged) or dragged straight onto the board. Movement past a small
   threshold counts as a drag; anything less falls through to a normal
   tap so short/imprecise taps still work.
========================================================= */
let dragState = null; // {typeKey, startX, startY, dragging, hoverCell}

function startChipDrag(e, typeKey){
  if(state.phase!=='deploy') return;
  dragState = { typeKey, startX:e.clientX, startY:e.clientY, dragging:false, hoverCell:null };
  const move = (ev)=>{
    if(!dragState) return;
    const dx = ev.clientX-dragState.startX, dy = ev.clientY-dragState.startY;
    if(!dragState.dragging && Math.hypot(dx,dy) > 8){
      dragState.dragging = true;
      const ghost = document.getElementById('dragGhost');
      ghost.classList.add('show');
      ghost.style.background = SIDE_COLOR[state.deployTurn];
      ghost.textContent = UNIT_TYPES[typeKey].label;
    }
    if(dragState.dragging){
      const ghost = document.getElementById('dragGhost');
      ghost.style.left = (ev.clientX-22)+'px';
      ghost.style.top = (ev.clientY-22)+'px';
      updateDragHoverCell(ev.clientX, ev.clientY);
      draw();
    }
  };
  const up = (ev)=>{
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    if(dragState && dragState.dragging){
      document.getElementById('dragGhost').classList.remove('show');
      if(dragState.hoverCell){
        pushUndoSnapshot();
        const placed = attemptDeployAt(dragState.typeKey, dragState.hoverCell.x, dragState.hoverCell.y);
        if(!placed) undoStack.pop();
      }
    }
    dragState = null;
    draw();
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

function updateDragHoverCell(clientX, clientY){
  const rect = canvas.getBoundingClientRect();
  if(clientX<rect.left || clientX>rect.right || clientY<rect.top || clientY>rect.bottom){
    dragState.hoverCell = null; return;
  }
  const cellPxX = rect.width / COLS, cellPxY = rect.height / ROWS;
  const x = Math.floor((clientX-rect.left)/cellPxX);
  const screenY = Math.floor((clientY-rect.top)/cellPxY);
  const y = sy(screenY);
  dragState.hoverCell = inBounds(x,y) ? {x,y} : null;
}

// Shared deployment-placement validation, used by both tap-to-place and drag-and-drop.
// Returns true on success, false if the attempt was rejected (and logs why).
function attemptDeployAt(typeKey, x, y){
  const side = state.deployTurn;
  const deployRows = state.boardMode==='grand' ? 3 : 2; // Grand Strategy gets a deeper zone for its doubled army
  const zoneOk = side===SIDES.RED ? (y>=ROWS-deployRows) : (y<deployRows);
  if(!zoneOk){ log(`Deployment must be within your first ${deployRows} rows.`, 'system'); return false; }
  const terr = terrainAt(x,y);
  if(terr.restrictTo && !terr.restrictTo.includes(typeKey)){ log(`${UNIT_TYPES[typeKey].label} cannot deploy there.`, 'system'); return false; }
  const occ = unitsAt(x,y);
  if(occ.length>0){ log('Square already occupied.', 'system'); return false; }
  placeUnit(side, typeKey, x, y);
  return true;
}

function checkDeployAdvance(){
  if(sideFullyDeployed(SIDES.RED) && sideFullyDeployed(SIDES.BLUE)){
    document.getElementById('endDeployBtn').disabled = false;
  }
}

function handleDeployClick(x,y){
  const side = state.deployTurn;
  if(state.mode==='ai' && side===state.aiSide) return; // not human's turn to click
  if(selectedDeployType===null){ log('Select a unit from the roster first, or drag it onto the board.', 'system'); return; }
  const typeKey = selectedDeployType;
  pushUndoSnapshot();
  const placed = attemptDeployAt(typeKey, x, y);
  if(placed) selectedDeployType = null;
  else undoStack.pop(); // nothing happened — don't leave a no-op snapshot in the undo stack
}

// Shared by human clicks and the AI: places one unit of `typeKey` from
// side's pool at (x,y), into their currently in-progress Brigade.
function placeUnit(side, typeKey, x, y){
  const bIdx = state.deployBrigadeIndex[side];
  const pool = state.deployPool[side];
  const poolIdx = pool.indexOf(typeKey);
  if(poolIdx===-1) return; // none left of that type
  const t = UNIT_TYPES[typeKey];
  const u = newUnit(side, typeKey, x, y, bIdx);
  state.units.push(u);
  pool.splice(poolIdx,1);
  log(`${SIDE_LABEL[side]} deploys ${unitLabel(u)} (Brigade ${bIdx+1}) at (${x},${y}).`);

  if(typeKey==='BRIGADIER'){
    state.currentBrigadeHasBrigadier[side] = true;
  } else {
    state.currentBrigadeCount[side]++;
  }

  renderRoster();
  updateHeader();
  draw();

  if(state.mode==='ai' && state.deployTurn===state.aiSide && !sideFullyDeployed(state.aiSide)){
    setTimeout(aiDeployStep, 450);
  }
}

// Called when a side confirms their current Brigade is done (Brigadier +
// at least 2 more units placed). Advances to the next Brigade and passes
// the turn to the other side, matching the alternate-Brigade rule.
function confirmCurrentBrigade(){
  const side = state.deployTurn;
  if(!(state.currentBrigadeHasBrigadier[side] && state.currentBrigadeCount[side]>=2)) return;
  const bIdx = state.deployBrigadeIndex[side];
  log(`${SIDE_LABEL[side]}'s Brigade ${bIdx+1} is fully deployed.`, 'system');
  state.deployBrigadeIndex[side]++;
  state.currentBrigadeHasBrigadier[side] = false;
  state.currentBrigadeCount[side] = 0;
  selectedDeployType = null;

  const other = side===SIDES.RED ? SIDES.BLUE : SIDES.RED;
  if(!sideFullyDeployed(other)){
    state.deployTurn = other;
  } // else: other side already finished all 3 — this side keeps going on its own remaining Brigades
  resetUndoStack(); // confirming is a commit point — the next Brigade starts with a clean undo slate

  renderRoster();
  updateHeader();
  draw();

  if(state.mode==='ai' && state.deployTurn===state.aiSide && !sideFullyDeployed(state.aiSide)){
    setTimeout(aiDeployStep, 450);
  }
}

