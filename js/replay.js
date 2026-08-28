import { COLS, ROWS, SIDE_LABEL, state } from './data-core.js';
import { removeUnit } from './engine-rules.js';
import { animateUnitTo, canvas, clearUnitAnimations, draw, sy } from './render-board.js';
import { setHighlightCells } from './render-units.js';

/* =========================================================
   BATTLE REPLAY — playback
   Steps through state.matchLog against a fresh copy of state.units
   restored from replayStartUnits. Reuses animateUnitTo/removeUnit so
   positions and Brigade-withdrawal cascades render exactly as they
   did live; log()/logReplay()/checkWinCondition() are all no-op'd
   while state.replaying is true (see their guards earlier in the file).
========================================================= */
export let replayIdx = 0;
export let replayTimer = null;
export let replaySavedUnits = null; // the real, final game state — restored on exit
export let replaySavedMeta = null;

export function startReplay(){
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

export function replayEventDelay(ev){
  if(ev.type==='fight' || ev.type==='fire') return 1500;
  if(ev.type==='status' && ev.newStatus==='Destroyed') return 1600;
  if(ev.type==='turnStart') return 500;
  return 320; // moves — fast auto-play, per the agreed pacing
}

export function replayEventCaption(ev){
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

export function showReplayHitRing(x,y){
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

export function applyReplayEvent(ev){
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

export function playReplayStep(){
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

export function replayPlayPauseToggle(){
  if(replayTimer){
    clearTimeout(replayTimer); replayTimer = null;
    document.getElementById('replayPlayPauseBtn').textContent = 'Play';
  } else {
    document.getElementById('replayPlayPauseBtn').textContent = 'Pause';
    playReplayStep();
  }
}

export function finishReplay(){
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

export function exitReplay(){
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

// Plain-text, copy-pasteable transcript of the whole match — both sides,
// every move, fight, artillery shot, and status change — pulled straight from
// state.matchLog (the same data the Battle Replay plays back visually). Unlike
// the AI Move Log, this covers a human player's own moves too, so it's the
// right export for "what did I actually do differently" style analysis.
export function exportFullMatchLog(){
  if(!state.matchLog || state.matchLog.length===0) return 'No match log recorded — matchLog is only captured once a battle has actually started.';
  const label = id => {
    const u = state.units.find(o=>o.id===id);
    return u ? ((u.historicalName) || u.type) : id;
  };
  const lines = [];
  lines.push('=== FULL MATCH LOG (both sides) ===');
  lines.push(`Total events: ${state.matchLog.length}`);
  lines.push('');

  let lastTurn = null;
  for(const ev of state.matchLog){
    if(ev.turn !== lastTurn){
      lines.push(`--- Turn ${ev.turn} ---`);
      lastTurn = ev.turn;
    }
    if(ev.type==='turnStart'){
      lines.push(`[${SIDE_LABEL[ev.side]}'s turn begins]`);
    } else if(ev.type==='move'){
      lines.push(`${label(ev.unitId)} (${SIDE_LABEL[ev.side]}): (${ev.from.x},${ev.from.y}) -> (${ev.to.x},${ev.to.y})`);
    } else if(ev.type==='fight'){
      lines.push(`FIGHT at (${ev.x},${ev.y}): ${label(ev.attackerId)} (${SIDE_LABEL[ev.attackerSide]}) vs ${label(ev.defenderId)} (${SIDE_LABEL[ev.defenderSide]}) — rolls ${ev.aRoll} v ${ev.dRoll} — ${ev.result}`);
      // Diagnostic line: what the PANEL was built from, beside what the engine
      // resolved on. Only emitted when the two could disagree (a re-roll, a
      // second die, a value bonus or a tie-break), so ordinary fights stay
      // readable.
      if(ev.diag){
        const d = ev.diag;
        const tie = Object.entries(d.ties||{}).filter(([,v])=>v).map(([k])=>k).join(',') || 'none';
        // Emitted for every fight now, not only interesting ones: the report is
        // that outcomes disagree with the dice, and deciding in advance which
        // fights are worth recording is how the interesting one gets missed.
        lines.push(`    A: dice[${d.aRolls}] x${d.aDice} kept ${d.aKept} bonus +${d.aBonus||0} -> ${ev.aRoll}`);
        lines.push(`    D: dice[${d.dRolls}] x${d.dDice} kept ${d.dKept} bonus +${d.dBonus||0} -> ${ev.dRoll}`);
        // The bonus SOURCES in order. First grants a second die, each later one
        // grants +1, so a repeated entry here is a doubled bonus.
        if(d.aSources && d.aSources.length) lines.push(`    A bonuses: ${d.aSources.join(' | ')}`);
        if(d.dSources && d.dSources.length) lines.push(`    D bonuses: ${d.dSources.join(' | ')}`);
        lines.push(`    panel "${d.panelText}" (${d.panelA} v ${d.panelD})` +
                   ` -> settle (${d.settleA} v ${d.settleD}) margin ${d.margin} = ${ev.result}` +
                   ` | tie-break ${tie}${d.drift ? '   *** VALUES DRIFTED BETWEEN PANEL AND BOARD ***' : ''}`);
        if(d.build && (!d.build.keptDie || !d.build.sources)){
          lines.push(`    *** STALE BUILD: running code is missing ` +
            `${!d.build.keptDie?'keptDie ':''}${!d.build.sources?'bonus-sources ':''}— hard-refresh needed ***`);
        }
      }
    } else if(ev.type==='fire'){
      lines.push(`ARTILLERY on ${label(ev.targetId)} (${SIDE_LABEL[ev.side]}) at (${ev.x},${ev.y}): rolled ${ev.roll} — ${ev.effect}`);
    } else if(ev.type==='status'){
      lines.push(`${label(ev.unitId)} (${SIDE_LABEL[ev.side]}) at (${ev.x},${ev.y}): ${ev.newStatus}${ev.reason?' — '+ev.reason:''}`);
    }
  }
  return lines.join('\n');
}

