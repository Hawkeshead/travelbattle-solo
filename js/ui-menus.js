function showOverlay(title, html, btnLabel, onClick){
  document.getElementById('overlayTitle').textContent = title;
  const textEl = document.getElementById('overlayText');
  textEl.innerHTML = html;
  const btn = document.getElementById('overlayBtn');
  btn.style.display = btnLabel ? 'inline-block' : 'none';
  btn.textContent = btnLabel || '';
  btn.onclick = onClick || null;
  document.getElementById('overlay').classList.add('show');
}

function showModeSelect(isSplash){
  const box = document.querySelector('#overlay .box');
  const titleEl = document.getElementById('overlayTitle');
  const subtitleEl = document.getElementById('overlaySubtitle');
  titleEl.textContent = 'TravelBattle';
  document.getElementById('overlayText').innerHTML = 'Full army, solo skirmish engine. Deploy 3 Brigades per side, alternating, across the first two rows of your board edge — then fight it out. Break 2 of the enemy\'s 3 Brigades to win.';
  document.getElementById('overlayBtn').style.display = 'none';
  subtitleEl.style.display = 'block';
  let extra = document.getElementById('modeChoices');
  if(!extra){
    extra = document.createElement('div');
    extra.id = 'modeChoices';
    extra.style.display = 'flex';
    extra.style.gap = '8px';
    extra.style.justifyContent = 'center';
    box.appendChild(extra);
  }
  extra.innerHTML = '';
  extra.style.display = 'flex';
  // The title splash treatment only ever plays on the genuine first-load screen —
  // every other route back to this menu (back buttons, campaign-not-found
  // fallback) shows everything instantly, a re-run fade would just feel laggy.
  titleEl.classList.remove('splash-title-group');
  subtitleEl.classList.remove('splash-title-group');
  extra.classList.remove('splash-buttons-group');
  document.getElementById('overlayText').classList.remove('splash-buttons-group');
  if(isSplash){
    void box.offsetWidth; // restart animation cleanly if this ever re-runs
    titleEl.classList.add('splash-title-group');
    subtitleEl.classList.add('splash-title-group');
    extra.classList.add('splash-buttons-group');
    document.getElementById('overlayText').classList.add('splash-buttons-group');
  }
  const hotseatBtn = document.createElement('button');
  hotseatBtn.className = 'primary';
  hotseatBtn.textContent = 'Hotseat (2 players)';
  hotseatBtn.onclick = ()=>{ state.mode='hotseat'; state.scenario=null; state.campaign=null; extra.style.display='none'; document.getElementById('overlay').classList.remove('show'); beginBoardSetup(); };
  const aiBtn = document.createElement('button');
  aiBtn.textContent = 'vs AI Opponent';
  aiBtn.onclick = ()=>{ state.scenario=null; state.campaign=null; extra.style.display='none'; showSideSelect(); };
  const opsBtn = document.createElement('button');
  opsBtn.textContent = 'Operations';
  opsBtn.onclick = ()=>{ state.campaign=null; extra.style.display='none'; showOperationsMenu(); };
  const campBtn = document.createElement('button');
  campBtn.textContent = 'Campaigns';
  campBtn.onclick = ()=>{ extra.style.display='none'; showCampaignMenu(); };
  const grandBtn = document.createElement('button');
  grandBtn.textContent = 'Grand Strategy (4 boards)';
  grandBtn.onclick = ()=>{ extra.style.display='none'; beginGrandBoardSetup(); };
  extra.appendChild(hotseatBtn);
  extra.appendChild(aiBtn);
  extra.appendChild(opsBtn);
  extra.appendChild(campBtn);
  extra.appendChild(grandBtn);
  document.getElementById('overlay').classList.add('show');
}

function showOperationsMenu(){
  document.getElementById('overlayTitle').textContent = 'Operations';
  document.getElementById('overlayText').innerHTML =
    'Smaller, asymmetrical scenarios drawn from real actions of the period — different forces, different objectives, not always "break 2 of 3 Brigades."';
  let extra = document.getElementById('modeChoices');
  extra.innerHTML = '';
  extra.style.display = 'flex';
  extra.style.flexDirection = 'column';
  extra.style.gap = '6px';
  const campaigns = [...new Set(SCENARIOS.map(s=>s.campaign))];
  for(const camp of campaigns){
    const header = document.createElement('div');
    header.textContent = camp;
    header.style.cssText = 'font-family:Cinzel,serif;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:var(--brass-dim);margin-top:6px;text-align:left;';
    extra.appendChild(header);
    for(const s of SCENARIOS.filter(x=>x.campaign===camp)){
      const b = document.createElement('button');
      b.style.textAlign = 'left';
      b.textContent = `${s.title} — ${s.objectiveText}`;
      b.onclick = ()=>{ showOperationBrief(s); };
      extra.appendChild(b);
    }
  }
  const backBtn = document.createElement('button');
  backBtn.textContent = '← Back';
  backBtn.onclick = ()=>{ showModeSelect(); };
  extra.appendChild(backBtn);
  document.getElementById('overlay').classList.add('show');
}

function showOperationBrief(scenario){
  document.getElementById('overlayTitle').textContent = scenario.title;
  document.getElementById('overlayText').innerHTML =
    `<b>${scenario.date}</b><br><br>${scenario.brief}<br><br><b>Objective:</b> ${scenario.objectiveText}` +
    (scenario.turnLimit ? `<br><b>Turn limit:</b> ${scenario.turnLimit}` : '');
  let extra = document.getElementById('modeChoices');
  extra.innerHTML = '';
  extra.style.display = 'flex';
  extra.style.flexDirection = 'row';
  extra.style.gap = '8px';
  const beginBtn = document.createElement('button');
  beginBtn.className = 'primary';
  beginBtn.textContent = 'Begin Operation';
  beginBtn.onclick = ()=>{
    state.scenario = scenario;
    extra.style.display = 'none';
    showOperationModeSelect(scenario);
  };
  const backBtn = document.createElement('button');
  backBtn.textContent = '← Back';
  backBtn.onclick = ()=>{ showOperationsMenu(); };
  extra.appendChild(beginBtn);
  extra.appendChild(backBtn);
  document.getElementById('overlay').classList.add('show');
}

function showOperationModeSelect(scenario){
  document.getElementById('overlayTitle').textContent = 'How will you play this Operation?';
  document.getElementById('overlayText').innerHTML =
    'Note: the AI plays Operations with the same tactics as a standard battle — it isn\'t yet tuned specifically for objectives like holding a zone or escaping, so it may not defend an Operation\'s goal as sharply as it plays a normal fight.';
  let extra = document.getElementById('modeChoices');
  extra.innerHTML = '';
  extra.style.display = 'flex';
  const hotseatBtn = document.createElement('button');
  hotseatBtn.className = 'primary';
  hotseatBtn.textContent = 'Hotseat (2 players)';
  hotseatBtn.onclick = ()=>{ state.mode='hotseat'; extra.style.display='none'; document.getElementById('overlay').classList.remove('show'); beginBoardSetup(); };
  const aiBtn = document.createElement('button');
  aiBtn.textContent = 'vs AI Opponent';
  aiBtn.onclick = ()=>{ extra.style.display='none'; showSideSelect(); };
  extra.appendChild(hotseatBtn);
  extra.appendChild(aiBtn);
  document.getElementById('overlay').classList.add('show');
}

function showSideSelect(){
  const box = document.querySelector('#overlay .box');
  document.getElementById('overlayTitle').textContent = 'Choose Your Side';
  document.getElementById('overlayText').innerHTML = 'The AI takes the other Brigade and will deploy, move, fire and fight on its own turns.';
  let extra = document.getElementById('modeChoices');
  extra.innerHTML = '';
  extra.style.display = 'flex';
  const redBtn = document.createElement('button');
  redBtn.className = 'primary';
  redBtn.textContent = 'Play Britain';
  redBtn.onclick = ()=>{ state.mode='ai'; state.aiSide=SIDES.BLUE; extra.style.display='none'; showDifficultySelect(); };
  const blueBtn = document.createElement('button');
  blueBtn.textContent = 'Play France';
  blueBtn.onclick = ()=>{ state.mode='ai'; state.aiSide=SIDES.RED; extra.style.display='none'; showDifficultySelect(); };
  extra.appendChild(redBtn);
  extra.appendChild(blueBtn);
}

function showDifficultySelect(){
  document.getElementById('overlayTitle').textContent = 'Choose AI Difficulty';
  document.getElementById('overlayText').innerHTML =
    '<b>Easy</b>: straightforward, reactive tactics. <b>Medium</b>: prioritises finishing off weakened Brigades, uses Charge and Attack Column deliberately. <b>Hard</b>: all of Medium, plus looks a step past the immediate trade before committing to a fight, and can lay ambushes proactively.';
  let extra = document.getElementById('modeChoices');
  extra.innerHTML = '';
  extra.style.display = 'flex';
  extra.style.flexWrap = 'wrap';
  const mk = (label, value, primary)=>{
    const b = document.createElement('button');
    if(primary) b.className = 'primary';
    b.textContent = label;
    b.onclick = ()=>{
      state.aiDifficulty = value;
      extra.style.display='none';
      document.getElementById('overlay').classList.remove('show');
      beginBoardSetup();
    };
    return b;
  };
  extra.appendChild(mk('Easy', 'easy', false));
  extra.appendChild(mk('Medium', 'medium', true));
  extra.appendChild(mk('Hard', 'hard', false));
  document.getElementById('overlay').classList.add('show');
}

/* =========================================================
   BOARD SETUP: random board assignment + dice-roll orientation
   Each side is given one of the two boards at random. Each side then
   rolls 1d6 for that board's table orientation: 1-3 forces a rotation
   of that many 90° clockwise turns; 4-6 lets that side's player choose
   the rotation. A human-controlled side gets an on-screen choice; the
   AI picks for itself when it's the AI's board.
========================================================= */
function beginBoardSetup(){
  setBoardMode('standard'); // always reset in case the previous match was Grand Strategy
  const keys = Math.random()<0.5 ? ['A','B'] : ['B','A'];
  state.boardAssignment = { red: keys[0], blue: keys[1] };
  state.boardRotation = { red: 0, blue: 0 };
  processBoardRoll([SIDES.RED, SIDES.BLUE], 0);
}

/* Grand Strategy board setup — hotseat only for now (no AI opponent yet, see
   ai-deployment.js/ai-strategy.js which still assume the standard 20x10 board).
   Board/rotation assignment is fully automatic here rather than the dice-roll
   ceremony beginBoardSetup() uses, to keep this phase focused on proving the
   bigger board and doubled army play correctly; the interactive per-quadrant
   rotation choice can be added later if wanted. */
function beginGrandBoardSetup(){
  state.mode = 'hotseat';
  state.scenario = null;
  state.campaign = null;
  setBoardMode('grand');
  const quadrants = generateGrandQuadrants();
  state.grandQuadrants = quadrants;
  state.terrain = buildTerrainMapGrand(quadrants);
  state.excludedRoadEdges = buildExcludedRoadEdgeSetGrand(quadrants);
  sizeCanvas(); // ROWS just changed (10 -> 20) — canvas pixel size must be recomputed, it doesn't happen automatically
  document.getElementById('overlay').classList.remove('show');
  log(`Grand Strategy: top boards ${quadrants.topLeft.board}/${quadrants.topRight.board}, bottom boards ${quadrants.bottomLeft.board}/${quadrants.bottomRight.board}, each independently rotated.`, 'system');
  initDeployment();
}

function processBoardRoll(sides, i){
  if(i >= sides.length){
    document.getElementById('overlay').classList.remove('show');
    state.terrain = buildTerrainMap(state.boardAssignment, state.boardRotation);
    state.excludedRoadEdges = buildExcludedRoadEdgeSet(state.boardAssignment, state.boardRotation);
    sizeCanvas(); // in case the previous match was Grand Strategy (ROWS just changed 20 -> 10)
    initDeployment();
    return;
  }
  const side = sides[i];
  const roll = rollD6();
  log(`${SIDE_LABEL[side]} rolls a ${roll} for Board ${state.boardAssignment[side]}'s table orientation.`, 'system');
  if(roll <= 3){
    state.boardRotation[side] = roll;
    log(`${SIDE_LABEL[side]}'s board is rotated ${roll*90}\u00b0 clockwise.`, 'system');
    processBoardRoll(sides, i+1);
  } else {
    const isHumanControlled = !(state.mode==='ai' && side===state.aiSide);
    if(isHumanControlled){
      showRotationChoice(side, (chosen)=>{
        state.boardRotation[side] = chosen;
        log(`${SIDE_LABEL[side]} chooses a ${chosen*90}\u00b0 rotation for their board.`, 'system');
        processBoardRoll(sides, i+1);
      });
    } else {
      const chosen = Math.floor(Math.random()*4);
      state.boardRotation[side] = chosen;
      log(`${SIDE_LABEL[side]} (AI) chooses a ${chosen*90}\u00b0 rotation for their board.`, 'system');
      processBoardRoll(sides, i+1);
    }
  }
}

function renderMiniTerrainPreview(canvas, grid){
  const ctx2 = canvas.getContext('2d');
  const n = grid.length;
  const cell = canvas.width / n;
  ctx2.clearRect(0,0,canvas.width,canvas.height);
  for(let y=0;y<n;y++){
    for(let x=0;x<n;x++){
      const key = grid[y][x];
      ctx2.fillStyle = terrainColor(key==='ROAD' ? 'OPEN' : key);
      ctx2.fillRect(x*cell,y*cell,cell,cell);
    }
  }
  // roads as thin connected lines, same treatment as the main board
  ctx2.strokeStyle = terrainColor('ROAD');
  ctx2.lineWidth = Math.max(2, cell*0.16);
  ctx2.lineCap = 'round';
  for(let y=0;y<n;y++){
    for(let x=0;x<n;x++){
      if(grid[y][x]!=='ROAD') continue;
      const cx = x*cell+cell/2, cy = y*cell+cell/2;
      [[0,-1],[0,1],[-1,0],[1,0]].forEach(([dx,dy])=>{
        const nx=x+dx, ny=y+dy;
        if(nx>=0 && nx<n && ny>=0 && ny<n && grid[ny][nx]==='ROAD'){
          ctx2.beginPath(); ctx2.moveTo(cx,cy); ctx2.lineTo(x*cell+cell/2+dx*cell/2, y*cell+cell/2+dy*cell/2); ctx2.stroke();
        }
      });
    }
  }
  ctx2.lineCap = 'butt';
  const ICONS2 = { FIELD:'\u{1F33E}', WOODS:'\u{1F332}', HILL:'\u{26F0}', BUILDING:'\u{1F3E0}' };
  ctx2.textAlign = 'center'; ctx2.textBaseline = 'middle';
  ctx2.font = Math.floor(cell*0.55)+'px sans-serif';
  for(let y=0;y<n;y++){
    for(let x=0;x<n;x++){
      const icon = ICONS2[grid[y][x]];
      if(icon) ctx2.fillText(icon, x*cell+cell/2, y*cell+cell/2);
    }
  }
  ctx2.strokeStyle = 'rgba(0,0,0,0.15)'; ctx2.lineWidth = 1;
  for(let i=0;i<=n;i++){
    ctx2.beginPath(); ctx2.moveTo(i*cell,0); ctx2.lineTo(i*cell,canvas.height); ctx2.stroke();
    ctx2.beginPath(); ctx2.moveTo(0,i*cell); ctx2.lineTo(canvas.width,i*cell); ctx2.stroke();
  }
}

function showRotationChoice(side, callback){
  const boardKey = state.boardAssignment[side];
  let previewRotation = 0;
  const canvas = document.getElementById('rotationPreviewCanvas');

  function render(){
    canvas.style.display = 'block';
    renderMiniTerrainPreview(canvas, boardTerrainFor(boardKey, previewRotation));
    document.getElementById('overlayText').innerHTML =
      `You rolled a 4, 5 or 6 — you may choose which way Board ${boardKey} faces. Currently: <b>${previewRotation*90}\u00b0</b>`;
  }

  document.getElementById('overlayTitle').textContent = `${SIDE_LABEL[side]}: Choose Board Orientation`;
  document.getElementById('overlayBtn').style.display = 'none';
  let extra = document.getElementById('modeChoices');
  extra.innerHTML = '';
  extra.style.display = 'flex';
  extra.style.flexWrap = 'wrap';

  const rotateBtn = document.createElement('button');
  rotateBtn.textContent = 'Rotate \u21bb';
  rotateBtn.onclick = ()=>{ previewRotation = (previewRotation+1)%4; render(); };
  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'primary';
  confirmBtn.textContent = 'Confirm This Orientation';
  confirmBtn.onclick = ()=>{
    extra.style.display='none';
    canvas.style.display='none';
    document.getElementById('overlay').classList.remove('show');
    callback(previewRotation);
  };
  extra.appendChild(rotateBtn);
  extra.appendChild(confirmBtn);

  render();
  document.getElementById('overlay').classList.add('show');
}

