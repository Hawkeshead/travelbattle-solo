import { showCampaignMenu } from './campaign.js';
import { SCENARIOS, SIDES, SIDE_LABEL, buildExcludedRoadEdgeSet, buildExcludedRoadEdgeSetGrand, buildTerrainMap, buildTerrainMapGrand, COLS, generateGrandQuadrants, setBoardMode, state } from './data-core.js';
import { showDice } from './dice.js';
import { rollD6 } from './engine-rules.js';
import { log } from './engine-state.js';
import { draw, sizeCanvas } from './render-board.js';
import { endMovePhase } from './ui-battle.js';
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
  const keys = Math.random()<0.5 ? ['A','B'] : ['B','A'];
  state.boardAssignment = { red: keys[0], blue: keys[1] };
  state.boardRotation = { red: Math.floor(Math.random()*4), blue: Math.floor(Math.random()*4) };
  state.terrain = buildTerrainMap(state.boardAssignment, state.boardRotation);
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
  const isHumanControlled = !(state.mode==='ai' && side===state.aiSide);
  if(!isHumanControlled){
    const chosen = Math.floor(Math.random()*4);
    state.boardRotation[side] = chosen;
    state.terrain = buildTerrainMap(state.boardAssignment, state.boardRotation);
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
  confirmBtn.textContent = 'Confirm Orientation';
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
  const quadrants = generateGrandQuadrants();
  state.grandQuadrants = quadrants;
  state.terrain = buildTerrainMapGrand(quadrants);
  state.excludedRoadEdges = buildExcludedRoadEdgeSetGrand(quadrants);
  sizeCanvas(); // ROWS just changed (10 -> 20) — canvas pixel size must be recomputed, it doesn't happen automatically
  document.getElementById('overlay').classList.remove('show');
  log(`Grand Strategy: top boards ${quadrants.topLeft.board}/${quadrants.topRight.board}, bottom boards ${quadrants.bottomLeft.board}/${quadrants.bottomRight.board}, each independently rotated.`, 'system');
  initDeployment();
}
