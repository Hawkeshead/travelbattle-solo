/* =========================================================
   BATTLE REPLAY — playback
   Steps through state.matchLog against a fresh copy of state.units
   restored from replayStartUnits. Reuses animateUnitTo/removeUnit so
   positions and Brigade-withdrawal cascades render exactly as they
   did live; log()/logReplay()/checkWinCondition() are all no-op'd
   while state.replaying is true (see their guards earlier in the file).
========================================================= */
let replayIdx = 0;
let replayTimer = null;
let replaySavedUnits = null; // the real, final game state — restored on exit
let replaySavedMeta = null;

function startReplay(){
  if(!state.matchLog || state.matchLog.length===0 || !state.replayStartUnits) return;
  document.getElementById('overlay').classList.remove('show');
  replaySavedUnits = state.units;
  replaySavedMeta = { phase:state.phase, turn:state.turn, turnNumber:state.turnNumber, selectedUnitId:state.selectedUnitId };
  state.units = JSON.parse(JSON.stringify(state.replayStartUnits));
  state.selectedUnitId = null;
  setHighlightCells([]);
  clearUnitAnimations();
  state.replaying = true;
  replayIdx = 0;
  document.getElementById('unitOverlay').classList.remove('show');
  document.getElementById('replayOverlay').classList.remove('hidden');
  document.getElementById('replayPlayPauseBtn').textContent = 'Pause';
  document.getElementById('replayPlayPauseBtn').onclick = replayPlayPauseToggle;
  draw();
  playReplayStep();
}

function replayEventDelay(ev){
  if(ev.type==='fight' || ev.type==='fire') return 1500;
  if(ev.type==='status' && ev.newStatus==='Destroyed') return 1600;
  if(ev.type==='turnStart') return 500;
  return 320; // moves — fast auto-play, per the agreed pacing
}

function replayEventCaption(ev){
  if(ev.type==='fight'){
    const labels = {stalemate:'Held — drawn', pushback:'Pushed back', rout:'Routed', destroy:'Destroyed'};
    return `Fighting at the line: ${labels[ev.result]||ev.result}`;
  }
  if(ev.type==='fire'){
    const labels = {none:'No effect', disrupt:'Shaken', rout:'Falls back', destroy:'Destroyed'};
    return `Artillery fires: ${labels[ev.effect]||ev.effect}`;
  }
  if(ev.type==='status' && ev.newStatus==='Destroyed') return 'A unit is lost.';
  return '';
}

function showReplayHitRing(x,y){
  const wrap = document.getElementById('boardWrap');
  const rect = canvas.getBoundingClientRect();
  const wrapRect = wrap.getBoundingClientRect();
  const cellPxX = rect.width/COLS, cellPxY = rect.height/ROWS;
  const sy_ = sy(y);
  const ring = document.createElement('div');
  ring.className = 'replay-hit-ring';
  ring.style.left = (rect.left - wrapRect.left + x*cellPxX) + 'px';
  ring.style.top = (rect.top - wrapRect.top + sy_*cellPxY) + 'px';
  ring.style.width = cellPxX + 'px';
  ring.style.height = cellPxY + 'px';
  wrap.appendChild(ring);
  setTimeout(()=> ring.remove(), 1400);
}

function applyReplayEvent(ev){
  if(ev.type==='turnStart'){
    state.turn = ev.side;
    state.turnNumber = ev.turn;
    document.getElementById('replayTurnLabel').textContent = `Turn ${ev.turn} — ${SIDE_LABEL[ev.side]}`;
    return;
  }
  if(ev.type==='move'){
    const u = state.units.find(x=>x.id===ev.unitId);
    if(u && !u.removed) animateUnitTo(u, ev.to.x, ev.to.y);
    return;
  }
  if(ev.type==='fight'){
    showReplayHitRing(ev.x, ev.y);
    return;
  }
  if(ev.type==='fire'){
    showReplayHitRing(ev.x, ev.y);
    const u = state.units.find(x=>x.id===ev.targetId);
    if(u && ev.effect==='disrupt') u.turnOnly = true;
    return;
  }
  if(ev.type==='status'){
    const u = state.units.find(x=>x.id===ev.unitId);
    if(u && ev.newStatus==='Destroyed' && !u.removed){
      showReplayHitRing(ev.x, ev.y);
      removeUnit(u, ev.reason||'destroyed');
    }
    return;
  }
}

function playReplayStep(){
  if(!state.replaying) return; // exited mid-playback
  if(replayIdx >= state.matchLog.length){ finishReplay(); return; }
  const ev = state.matchLog[replayIdx];
  applyReplayEvent(ev);
  const caption = replayEventCaption(ev);
  if(caption) document.getElementById('replayEventLabel').textContent = caption;
  draw();
  replayIdx++;
  replayTimer = setTimeout(playReplayStep, replayEventDelay(ev));
}

function replayPlayPauseToggle(){
  if(replayTimer){
    clearTimeout(replayTimer); replayTimer = null;
    document.getElementById('replayPlayPauseBtn').textContent = 'Play';
  } else {
    document.getElementById('replayPlayPauseBtn').textContent = 'Pause';
    playReplayStep();
  }
}

function finishReplay(){
  document.getElementById('replayEventLabel').textContent = 'Replay complete.';
  document.getElementById('replayPlayPauseBtn').textContent = 'Watch Again';
  document.getElementById('replayPlayPauseBtn').onclick = ()=>{
    state.units = JSON.parse(JSON.stringify(state.replayStartUnits));
    state.selectedUnitId = null;
    clearUnitAnimations();
    document.querySelectorAll('.replay-hit-ring').forEach(el=>el.remove());
    replayIdx = 0;
    document.getElementById('replayEventLabel').textContent = '';
    document.getElementById('replayPlayPauseBtn').textContent = 'Pause';
    document.getElementById('replayPlayPauseBtn').onclick = replayPlayPauseToggle;
    draw();
    playReplayStep();
  };
}

function exitReplay(){
  if(replayTimer){ clearTimeout(replayTimer); replayTimer = null; }
  state.replaying = false;
  state.units = replaySavedUnits;
  state.phase = replaySavedMeta.phase;
  state.turn = replaySavedMeta.turn;
  state.turnNumber = replaySavedMeta.turnNumber;
  state.selectedUnitId = replaySavedMeta.selectedUnitId;
  clearUnitAnimations();
  document.getElementById('replayOverlay').classList.add('hidden');
  document.querySelectorAll('.replay-hit-ring').forEach(el=>el.remove());
  draw();
  document.getElementById('overlay').classList.add('show'); // back to the victory dialog
}
document.getElementById('replayExitBtn').onclick = exitReplay;

