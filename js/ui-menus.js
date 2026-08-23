import { showCampaignMenu } from './campaign.js';
import { SCENARIOS, SIDES, SIDE_LABEL, TB_DATA, TERRAIN, assignBuildingStyles, assignGrassStyles, buildExcludedRoadEdgeSet, buildExcludedRoadEdgeSetGrand, buildTerrainMap, buildTerrainMapGrand, COLS, ROWS, generateGrandQuadrants, setBoardMode, state } from './data-core.js';
import { FAST_DICE_MODE, showDice } from './dice.js';
import { rollD6 } from './engine-rules.js';
import { log } from './engine-state.js';
import { canvas, ctx, draw, sizeCanvas, sy, terrainColor } from './render-board.js';
import { AudioManager } from './audio-manager.js';
import { endMovePhase } from './ui-battle.js';
import { deployArmyComposition } from './ai-deployment.js';
import { initDeployment } from './ui-deployment.js';

export function showOverlay(title, html, btnLabel, onClick){
  document.getElementById('overlayTitle').textContent = title;
  const textEl = document.getElementById('overlayText');
  textEl.innerHTML = html;
  const btn = document.getElementById('overlayBtn');
  btn.style.display = btnLabel ? 'inline-block' : 'none';
  btn.textContent = btnLabel || '';
  btn.onclick = onClick || null;
  document.getElementById('overlay').classList.add('show');
}

// The row of buttons inside the overlay isn't in index.html — it's built the
// first time a menu needs it. Everything that fills it must go through here,
// because there are boot paths that reach a menu without ever passing through
// showModeSelect: resuming a saved campaign goes straight from boot.js to the
// campaign screens, and before this existed those screens crashed on a null
// element.
export function ensureModeChoices(){
  let extra = document.getElementById('modeChoices');
  if(!extra){
    extra = document.createElement('div');
    extra.id = 'modeChoices';
    extra.style.display = 'flex';
    extra.style.flexWrap = 'wrap';
    extra.style.gap = '8px';
    extra.style.justifyContent = 'center';
    document.querySelector('#overlay .box').appendChild(extra);
  }
  return extra;
}

export function showModeSelect(isSplash){
  const box = document.querySelector('#overlay .box');
  const titleEl = document.getElementById('overlayTitle');
  const subtitleEl = document.getElementById('overlaySubtitle');
  titleEl.textContent = 'TravelBattle';
  document.getElementById('overlayText').innerHTML = 'Full army, solo skirmish engine. Deploy 3 Brigades per side, alternating, across the first two rows of your board edge — then fight it out. Break 2 of the enemy\'s 3 Brigades to win.';
  document.getElementById('overlayBtn').style.display = 'none';
  subtitleEl.style.display = 'block';
  const extra = ensureModeChoices();
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
    // Strip the splash classes the moment each animation finishes, so they can
    // never linger and delay/blank-box a later, unrelated overlay (ambush,
    // leadership roll, etc.) that happens to reuse these same elements.
    [titleEl, subtitleEl, extra, document.getElementById('overlayText')].forEach(el=>{
      el.addEventListener('animationend', ()=> el.classList.remove('splash-title-group','splash-buttons-group'), { once:true });
    });
  }
  const aiBtn = document.createElement('button');
  aiBtn.className = 'primary';
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
  grandBtn.onclick = ()=>{ extra.style.display='none'; showGrandMatchTypeSelect(); };
  // Hotseat (2 players) removed from the home menu for now — beginBoardSetup()
  // and everything it needs is untouched, so this is just the one entry point
  // no longer being offered, easy to re-add later.
  extra.appendChild(aiBtn);
  extra.appendChild(opsBtn);
  extra.appendChild(campBtn);
  extra.appendChild(grandBtn);
  document.getElementById('overlay').classList.add('show');
}

export function showOperationsMenu(){
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

export function showOperationBrief(scenario){
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

export function showOperationModeSelect(scenario){
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

export function showSideSelect(){
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

export function showDifficultySelect(){
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
/* =========================================================
   BOARD ORIENTATION
   The two halves join left/right — Britain is always the left half,
   France always the right, only which physical board (A/B) lands on
   each side is randomised. The whole map is shown immediately, already
   at a random starting rotation for both halves — that's what either
   side keeps if they don't end up eligible (or don't go first) to
   change it. Then: a roll to see who goes first, a simultaneous roll
   for each side to see if they've earned the right to rotate at all,
   then whoever's eligible taps their own half of the already-visible
   map to cycle it, rather than a separate small preview modal.
========================================================= */
export function beginBoardSetup(){
  setBoardMode('standard');
  AudioManager.playMusic('audio/music/field-of-austerlitz.mp3');
  const keys = Math.random()<0.5 ? ['A','B'] : ['B','A'];
  state.boardAssignment = { red: keys[0], blue: keys[1] };
  state.boardRotation = { red: Math.floor(Math.random()*4), blue: Math.floor(Math.random()*4) };
  state.terrain = buildTerrainMap(state.boardAssignment, state.boardRotation);
  state.grassStyles = assignGrassStyles(state.terrain);
  state.buildingStyles = assignBuildingStyles(state.terrain);
  state.excludedRoadEdges = buildExcludedRoadEdgeSet(state.boardAssignment, state.boardRotation);
  sizeCanvas();
  document.getElementById('overlay').classList.remove('show');
  draw();
  rollOrientationOrder();
}

function rollOrientationOrder(){
  const redRoll = rollD6(), blueRoll = rollD6();
  const firstSide = redRoll===blueRoll ? null : (redRoll>blueRoll ? SIDES.RED : SIDES.BLUE);
  const resultText = firstSide===null ? 'Tied \u2014 rolling again' : `${SIDE_LABEL[firstSide]} goes first`;
  showDice([
    {label:'Britain', rolls:[redRoll], keptValue:redRoll},
    {label:'France', rolls:[blueRoll], keptValue:blueRoll}
  ], resultText, firstSide===null?'draw':'win', ()=>{
    if(firstSide===null){ rollOrientationOrder(); return; }
    log(`${SIDE_LABEL[firstSide]} rolls higher and goes first for table orientation.`, 'system');
    rollRotationEligibility(firstSide);
  });
}

function rollRotationEligibility(firstSide){
  const redRoll = rollD6(), blueRoll = rollD6();
  const redEligible = redRoll>=4, blueEligible = blueRoll>=4;
  const resultText = redEligible && blueEligible ? 'Both may rotate their board'
    : redEligible ? 'Only Britain may rotate their board'
    : blueEligible ? 'Only France may rotate their board'
    : 'Neither rolled high enough \u2014 both boards stay as they are';
  showDice([
    {label:'Britain', rolls:[redRoll], keptValue:redRoll},
    {label:'France', rolls:[blueRoll], keptValue:blueRoll}
  ], resultText, 'draw', ()=>{
    log(`Britain rolls ${redRoll}, France rolls ${blueRoll} for the right to rotate their board.`, 'system');
    const order = firstSide===SIDES.BLUE ? [SIDES.BLUE, SIDES.RED] : [SIDES.RED, SIDES.BLUE];
    const eligible = order.filter(s => (s===SIDES.RED ? redEligible : blueEligible));
    runRotationPicks(eligible, 0);
  });
}

function runRotationPicks(eligibleSides, i){
  if(i >= eligibleSides.length){
    state.phase = 'deploy'; // restore from 'orientation' — nothing else in the normal lifecycle ever sets this, it's just the state object's default at creation, which orientation-picking is the first thing to ever change away from it
    document.getElementById('overlay').classList.remove('show');
    initDeployment();
    return;
  }
  const side = eligibleSides[i];
  const isHumanControlled = !FAST_DICE_MODE && !(state.mode==='ai' && side===state.aiSide);
  if(!isHumanControlled){
    const chosen = Math.floor(Math.random()*4);
    state.boardRotation[side] = chosen;
    state.terrain = buildTerrainMap(state.boardAssignment, state.boardRotation);
    state.grassStyles = assignGrassStyles(state.terrain);
    state.buildingStyles = assignBuildingStyles(state.terrain);
    state.excludedRoadEdges = buildExcludedRoadEdgeSet(state.boardAssignment, state.boardRotation);
    draw();
    log(`${SIDE_LABEL[side]} (AI) rotates their board to ${chosen*90}\u00b0.`, 'system');
    runRotationPicks(eligibleSides, i+1);
    return;
  }
  startOrientationPickMode(side, ()=> runRotationPicks(eligibleSides, i+1));
}

// Tap directly on the real board — the dice fade away and the already-visible
// map (at its random starting rotation) becomes the picker itself, rather
// than a small separate preview. Only the current player's own half responds
// to taps (Britain = left, France = right — see buildTerrainMap).
function startOrientationPickMode(side, onDone){
  state.phase = 'orientation';
  state._orientationPick = { side, onDone };
  const badge = document.getElementById('turnBadge');
  badge.textContent = `${SIDE_LABEL[side]}: tap your half of the map to rotate it`;
  const confirmBtn = document.getElementById('endMoveBtn');
  confirmBtn.style.display = 'inline-block';
  confirmBtn.disabled = false;
  confirmBtn.textContent = 'Confirm This Orientation';
  confirmBtn.onclick = ()=>{
    confirmBtn.textContent = 'End Move'; // hand the button back to its normal battle-phase role
    confirmBtn.onclick = endMovePhase;   // its real handler — never gets re-bound after boot.js's one-time initBattleControls() call, so this must restore it explicitly
    log(`${SIDE_LABEL[side]} confirms a ${state.boardRotation[side]*90}\u00b0 rotation.`, 'system');
    state._orientationPick = null;
    onDone();
  };
}

// Called from onCellClick when state.phase==='orientation' — cycles the
// current picker's own half by one 90\u00b0 step per tap; taps on the other
// half (not theirs to touch) or anywhere once the phase has ended do nothing.
export function handleOrientationClick(x){
  const pick = state._orientationPick;
  if(!pick) return;
  const isLeftHalf = x < COLS/2;
  const tappedSide = isLeftHalf ? SIDES.RED : SIDES.BLUE;
  if(tappedSide !== pick.side) return;
  state.boardRotation[pick.side] = (state.boardRotation[pick.side]+1) % 4;
  state.terrain = buildTerrainMap(state.boardAssignment, state.boardRotation);
  state.grassStyles = assignGrassStyles(state.terrain);
  state.buildingStyles = assignBuildingStyles(state.terrain);
  state.excludedRoadEdges = buildExcludedRoadEdgeSet(state.boardAssignment, state.boardRotation);
  draw();
}

/* Grand Strategy board setup — hotseat only for now (no AI opponent yet, see
   ai-deployment.js/ai-strategy.js which still assume the standard 20x10 board).
   Board/rotation assignment is fully automatic here rather than the dice-roll
   ceremony beginBoardSetup() uses, to keep this phase focused on proving the
   bigger board and doubled army play correctly; the interactive per-quadrant
   rotation choice can be added later if wanted. */
/* Grand Strategy board setup — see beginGrandBoardSetup() below for the note
   on why quadrant assignment is fully automatic rather than the dice-roll
   ceremony beginBoardSetup() uses. */
export function showGrandMatchTypeSelect(){
  document.getElementById('overlayTitle').textContent = 'Grand Strategy';
  document.getElementById('overlayText').innerHTML =
    'Four boards combined into a 20x20 battlefield — the same two boards, each used twice, randomly placed and rotated. Every unit type except Brigadier is doubled.';
  let extra = document.getElementById('modeChoices');
  extra.innerHTML = '';
  extra.style.display = 'flex';
  const hotseatBtn = document.createElement('button');
  hotseatBtn.className = 'primary';
  hotseatBtn.textContent = 'Hotseat (2 players)';
  hotseatBtn.onclick = ()=>{ state.mode='hotseat'; extra.style.display='none'; beginGrandBoardSetup(); };
  const aiBtn = document.createElement('button');
  aiBtn.textContent = 'vs AI Opponent (Hard)';
  aiBtn.onclick = ()=>{ extra.style.display='none'; showGrandSideSelect(); };
  extra.appendChild(hotseatBtn);
  extra.appendChild(aiBtn);
  document.getElementById('overlay').classList.add('show');
}

// Only Hard is offered here — Easy/Medium's AI deployment relies on a fixed
// per-unit-type plan sized for the standard 17-unit army (see AI_DEPLOY_PLANS
// in ai-deployment.js); Hard's plan is dynamically scored instead, so it
// generalizes to the doubled Grand Strategy roster without a second data set.
export function showGrandSideSelect(){
  document.getElementById('overlayTitle').textContent = 'Choose Your Side';
  document.getElementById('overlayText').innerHTML = 'The AI takes the other Brigade and will deploy, move, fire and fight on its own turns, at Hard difficulty.';
  let extra = document.getElementById('modeChoices');
  extra.innerHTML = '';
  extra.style.display = 'flex';
  const redBtn = document.createElement('button');
  redBtn.className = 'primary';
  redBtn.textContent = 'Play Britain';
  redBtn.onclick = ()=>{ state.mode='ai'; state.aiSide=SIDES.BLUE; state.aiDifficulty='hard'; extra.style.display='none'; document.getElementById('overlay').classList.remove('show'); beginGrandBoardSetup(); };
  const blueBtn = document.createElement('button');
  blueBtn.textContent = 'Play France';
  blueBtn.onclick = ()=>{ state.mode='ai'; state.aiSide=SIDES.RED; state.aiDifficulty='hard'; extra.style.display='none'; document.getElementById('overlay').classList.remove('show'); beginGrandBoardSetup(); };
  extra.appendChild(redBtn);
  extra.appendChild(blueBtn);
}

export function beginGrandBoardSetup(){
  state.scenario = null;
  state.campaign = null;
  setBoardMode('grand');
  AudioManager.playMusic('audio/music/field-of-austerlitz.mp3');
  const quadrants = generateGrandQuadrants();
  state.grandQuadrants = quadrants;
  state.terrain = buildTerrainMapGrand(quadrants);
  state.grassStyles = assignGrassStyles(state.terrain);
  state.buildingStyles = assignBuildingStyles(state.terrain);
  state.excludedRoadEdges = buildExcludedRoadEdgeSetGrand(quadrants);
  sizeCanvas(); // ROWS just changed (10 -> 20) — canvas pixel size must be recomputed, it doesn't happen automatically
  document.getElementById('overlay').classList.remove('show');
  log(`Grand Strategy: top boards ${quadrants.topLeft.board}/${quadrants.topRight.board}, bottom boards ${quadrants.bottomLeft.board}/${quadrants.bottomRight.board}, each independently rotated.`, 'system');
  initDeployment();
}

/* =========================================================
   ARMY PICKER
   The fast-path deployment shortcut: pick one of the six named Armies
   (see data/army-compositions.json) and it auto-deploys in one go via
   deployArmyComposition, instead of placing all 17 units by hand.
   Standard matches only — Grand Strategy and scenario battles keep
   their own existing deployment untouched. Only offered once per
   human side, at the exact moment it first becomes their turn to
   deploy — see the maybeShowArmyPicker() calls in ui-deployment.js.
========================================================= */
const ARMY_ZONE_COLORS = ['#c66','#6ac','#7b6'];
const ARMY_COL_BANDS = [[0,6],[7,13],[14,19]];

export function maybeShowArmyPicker(){
  if(state._suppressArmyPicker) return false;
  if(state.scenario || state.boardMode==='grand') return false;
  const side = state.deployTurn;
  const isHumanControlled = !FAST_DICE_MODE && !(state.mode==='ai' && side===state.aiSide);
  if(!isHumanControlled) return false;
  if(!(state.deployBrigadeIndex[side]===0 && state.currentBrigadeCount[side]===0 && !state.currentBrigadeHasBrigadier[side])) return false;
  if(!state._armyPickerShown) state._armyPickerShown = { red:false, blue:false };
  if(state._armyPickerShown[side]) return false;
  state._armyPickerShown[side] = true;
  showArmyPicker(side);
  return true;
}

let armyPickerState = null; // { side, index, viewingMap }
let armyPickerSwipeAttached = false;

function goToArmy(delta){
  armyPickerState.index = (armyPickerState.index + TB_DATA.armyCompositions.length + delta) % TB_DATA.armyCompositions.length;
  renderArmyPickerCard();
}

// Swipe replaces the old prev/next arrow buttons — one horizontal drag on the
// card itself steps to the next/previous Army, which reads more naturally on
// a phone than two small circular buttons competing for thumb space at the
// bottom of an already busy bar. Attached once (idempotency guard below)
// since #armyPickerBody is a static element, not recreated per open.
function attachArmyPickerSwipe(){
  const el = document.getElementById('armyPickerBody');
  let startX = null, startY = null;
  el.addEventListener('touchstart', (e)=>{
    if(!armyPickerState || armyPickerState.viewingMap) return;
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY;
  }, { passive: true });
  el.addEventListener('touchend', (e)=>{
    if(!armyPickerState || armyPickerState.viewingMap || startX===null) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - startX, dy = t.clientY - startY;
    startX = null; startY = null;
    // Require a real horizontal swipe, not a vertical scroll of the card list
    if(Math.abs(dx) < 45 || Math.abs(dx) < Math.abs(dy) * 1.3) return;
    goToArmy(dx < 0 ? 1 : -1);
  }, { passive: true });
}

function showArmyPicker(side){
  armyPickerState = { side, index: 0, viewingMap: false };
  document.getElementById('sidebar').style.display = 'none';
  document.getElementById('rosterPanel').style.display = 'none';
  document.getElementById('armyPickerPanel').classList.remove('hidden');
  document.getElementById('armyPickerPanel').classList.remove('viewingMap');
  renderArmyPickerCard();
  if(!armyPickerSwipeAttached){ attachArmyPickerSwipe(); armyPickerSwipeAttached = true; }

  document.getElementById('armyPickerViewMapBtn').onclick = toggleArmyPickerMapView;
  document.getElementById('armyPickerDeployBtn').onclick = ()=>{
    const army = TB_DATA.armyCompositions[armyPickerState.index];
    deployArmyComposition(side, army.id);
    log(`${SIDE_LABEL[side]} deploys as ${army.name}.`, 'system');
    closeArmyPicker();
  };
  document.getElementById('armyPickerManualBtn').onclick = closeArmyPicker;
}

function renderArmyPickerCard(){
  const { index, viewingMap } = armyPickerState;
  const army = TB_DATA.armyCompositions[index];
  document.getElementById('armyPickerIndex').textContent = index+1;
  document.getElementById('armyPickerName').textContent = army.name;
  document.getElementById('armyPickerSummary').textContent = army.summary;
  const cardsEl = document.getElementById('armyPickerBrigadeCards');
  cardsEl.innerHTML = army.brigades.map((b,i)=>
    `<div class="apCard" style="border-left-color:${ARMY_ZONE_COLORS[i]};"><div class="apName">${b.name}</div><div class="apDoctrine">${b.doctrine}</div></div>`
  ).join('');
  const dotsEl = document.getElementById('armyPickerDots');
  dotsEl.innerHTML = TB_DATA.armyCompositions.map((_,i)=>
    `<div class="apDot${i===index?' active':''}"></div>`
  ).join('');
  drawArmyPickerMinimap();
  if(viewingMap) drawArmyZoneHighlights();
}

// Compact always-visible minimap sitting beside the brigade text — a quick
// "where do these zones actually fall on the real terrain" reference that
// doesn't require leaving the card, distinct from the full-detail "View Map"
// toggle below which swaps to the real interactive board.
function drawArmyPickerMinimap(){
  const cv = document.getElementById('armyPickerMinimap');
  const mctx = cv.getContext('2d');
  const cw = cv.width, ch = cv.height;
  mctx.clearRect(0,0,cw,ch);
  const cellW = cw/COLS, cellH = ch/ROWS;
  for(let y=0;y<ROWS;y++){
    for(let x=0;x<COLS;x++){
      mctx.fillStyle = terrainColor(TERRAIN[state.terrain[y][x]].key);
      mctx.fillRect(x*cellW, y*cellH, cellW+0.5, cellH+0.5);
    }
  }
  const { side, index } = armyPickerState;
  const army = TB_DATA.armyCompositions[index];
  const deployRows = 2;
  const rowStart = side===SIDES.RED ? ROWS-deployRows : 0;
  army.brigades.forEach((brig,i)=>{
    const [c0,c1] = ARMY_COL_BANDS[i];
    mctx.fillStyle = ARMY_ZONE_COLORS[i] + '80';
    mctx.strokeStyle = ARMY_ZONE_COLORS[i];
    mctx.lineWidth = 1;
    mctx.fillRect(c0*cellW, rowStart*cellH, (c1-c0+1)*cellW, deployRows*cellH);
    mctx.strokeRect(c0*cellW, rowStart*cellH, (c1-c0+1)*cellW, deployRows*cellH);
  });
  // seam line between the two halves of the joined board
  mctx.strokeStyle = 'rgba(255,255,255,0.4)';
  mctx.setLineDash([2,2]);
  mctx.beginPath(); mctx.moveTo(cw/2,0); mctx.lineTo(cw/2,ch); mctx.stroke();
  mctx.setLineDash([]);
}

function toggleArmyPickerMapView(){
  armyPickerState.viewingMap = !armyPickerState.viewingMap;
  const panel = document.getElementById('armyPickerPanel');
  const btn = document.getElementById('armyPickerViewMapBtn');
  if(armyPickerState.viewingMap){
    panel.classList.add('viewingMap');
    btn.textContent = 'Back to Army Selection';
    drawArmyZoneHighlights();
  } else {
    panel.classList.remove('viewingMap');
    btn.textContent = 'View Map';
    draw(); // clear the highlight overlay by redrawing the clean board
  }
}

// Draws each Brigade's column band (see HARD_DEPLOY_COL_BANDS in
// ai-deployment.js — the same bands the actual deployment engine uses)
// as a translucent colour-coded rectangle over the side's own two rows,
// directly on the real board so the real terrain underneath is what
// informs the choice, not a generic diagram.
function drawArmyZoneHighlights(){
  draw();
  const { side, index } = armyPickerState;
  const army = TB_DATA.armyCompositions[index];
  const deployRows = 2;
  const rowStart = side===SIDES.RED ? ROWS-deployRows : 0;
  const rowEnd = rowStart + deployRows - 1;
  const cellW = canvas.width/COLS, cellH = canvas.height/ROWS;
  const yTop = Math.min(sy(rowStart), sy(rowEnd)) * cellH;
  army.brigades.forEach((brig,i)=>{
    const [c0,c1] = ARMY_COL_BANDS[i];
    ctx.save();
    ctx.fillStyle = ARMY_ZONE_COLORS[i] + '3d';
    ctx.strokeStyle = ARMY_ZONE_COLORS[i];
    ctx.lineWidth = 3;
    ctx.fillRect(c0*cellW, yTop, (c1-c0+1)*cellW, deployRows*cellH);
    ctx.strokeRect(c0*cellW, yTop, (c1-c0+1)*cellW, deployRows*cellH);
    ctx.restore();
  });
}

function closeArmyPicker(){
  document.getElementById('armyPickerPanel').classList.add('hidden');
  document.getElementById('sidebar').style.display = 'flex';
  document.getElementById('rosterPanel').style.display = 'flex';
  armyPickerState = null;
  draw();
  // No extra AI-triggering needed here: "Deploy This Army" already ran
  // deployArmyComposition, which calls confirmCurrentBrigade() internally —
  // that already handles handing off to the AI correctly if it's now their
  // turn. "Deploy Manually Instead" hasn't changed deployTurn at all, so
  // it's still this human side's turn regardless.
}
