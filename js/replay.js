import { COLS, ROWS, SIDES, SIDE_LABEL, UNIT_TYPES, state } from './data-core.js';
import { formatAiDecision } from './ai-strategy.js';
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

/* =========================================================
   UNIFIED MATCH REPORT

   Replaces the two overlapping exports. Sections 1, 2, 5 and 6 are new;
   section 3 is the existing turn log, which was already the best part of the
   old output and is kept intact.

   Sections 5 and 6 are computed at the end from the event stream rather than
   tracked as the match runs, so nothing new has to be maintained in the hot
   path and a crash still leaves sections 1 to 3 usable.

   SECTION 4 (full AI decision scores) IS NOT HERE. The scorer accumulates a
   single running total across 34 mutations and keeps no per-component values,
   so exposing them is a refactor of the scoring function rather than an export
   change. Flagged rather than half-built: a decision log that showed only final
   scores would answer none of the questions it exists to answer.
========================================================= */
const TERRAIN_GLYPH = { OPEN:'.', ROAD:'=', HILL:'^', WOODS:'*', BUILDING:'#', PLOUGH:':' };

function sectionMetadata(){
  const m = state._matchMeta;
  const out = ['=== SECTION 1: MATCH METADATA ==='];
  if(!m){ out.push('(not captured: this match began before metadata was recorded)'); return out; }
  const mins = Math.round((Date.now() - Date.parse(m.startedAt)) / 60000);
  out.push(`RNG seed        : ${m.seed}    <- reproduces this match's dice exactly`);
  out.push(`Started         : ${m.startedAt}   (about ${mins} min ago)`);
  out.push(`Mode            : ${m.mode}${m.difficulty!=='n/a' ? ', difficulty ' + m.difficulty : ''}`);
  out.push(`Board           : ${m.boardMode}, ${COLS}x${ROWS}`);
  if(m.aiSide!=null) out.push(`Sides           : player ${SIDE_LABEL[m.playerSide]}, AI ${SIDE_LABEL[m.aiSide]}`);
  out.push(`Turns played    : ${state.turnNumber}`);
  out.push(`Ended           : ${state.gameOver ? 'win condition met' : 'in progress / abandoned'}`);
  return out;
}

function sectionDeployment(){
  const m = state._matchMeta;
  const out = ['=== SECTION 2: DEPLOYMENT AND SETUP ==='];
  if(m && m.deployment){
    for(const side of [SIDES.RED, SIDES.BLUE]){
      const list = m.deployment.filter(u=>u.side===side);
      if(!list.length) continue;
      out.push(`${SIDE_LABEL[side]} — ${list.length} units`);
      const byBrigade = {};
      for(const u of list) (byBrigade[u.brigadeId] = byBrigade[u.brigadeId] || []).push(u);
      for(const b of Object.keys(byBrigade).sort()){
        out.push(`  Brigade ${b}`);
        for(const u of byBrigade[b]){
          out.push(`    ${String(u.type).padEnd(10)} ${String(u.name).padEnd(34)} (${u.x},${u.y})  ${u.formation}`);
        }
      }
      out.push('');
    }
  } else {
    out.push('(deployment not captured for this match)');
    out.push('');
  }
  /* Terrain map. Terrain was only ever visible when a bonus happened to fire in
     combat, so there was no way to tell whether a fight was decided by ground,
     or whether parts of the board were dead space. */
  out.push('Terrain map (row 0 at top):');
  out.push('   ' + Array.from({length:COLS}, (_,x)=> String(x%10)).join(''));
  for(let y=0;y<ROWS;y++){
    let row = '';
    for(let x=0;x<COLS;x++) row += (TERRAIN_GLYPH[state.terrain[y][x]] || '?');
    out.push(String(y).padStart(2) + ' ' + row);
  }
  out.push('   legend: . open  = road  ^ hill  * woods  # building  : ploughed');
  return out;
}


function sectionSummary(log, label){
  const out = ['=== SECTION 5: MATCH SUMMARY ==='];
  const fights = log.filter(e=>e.type==='fight');
  const fires  = log.filter(e=>e.type==='fire');
  const status = log.filter(e=>e.type==='status');

  // Casualties by cause, taken from the status stream rather than recounted.
  const lost = {};
  for(const e of status){
    if(!e.newStatus || !/destroy|Lost/i.test(e.newStatus)) continue;
    (lost[e.side] = lost[e.side] || []).push(e);
  }
  out.push('Casualties');
  for(const side of [SIDES.RED, SIDES.BLUE]){
    out.push(`  ${SIDE_LABEL[side]}: ${(lost[side]||[]).length} lost`);
  }
  out.push('');

  out.push(`Combat: ${fights.length} fights, ${fires.length} artillery shots`);
  const byResult = {};
  for(const f of fights) byResult[f.result] = (byResult[f.result]||0)+1;
  out.push('  outcomes: ' + (Object.entries(byResult).map(([k,v])=>`${k} ${v}`).join(', ') || 'none'));

  /* Every die rolled, per side, so the distribution can be audited. A run of
     bad luck and a biased generator look identical in a single match and only
     separate over the whole list. */
  const dice = { [SIDES.RED]: [], [SIDES.BLUE]: [] };
  for(const f of fights){
    if(!f.diag) continue;
    (dice[f.attackerSide]||[]).push(...(f.diag.aRolls||[]));
    (dice[f.defenderSide]||[]).push(...(f.diag.dRolls||[]));
  }
  for(const side of [SIDES.RED, SIDES.BLUE]){
    const d = dice[side]||[];
    if(!d.length) continue;
    const c = [0,0,0,0,0,0,0];
    for(const v of d) c[v]++;
    out.push(`  ${SIDE_LABEL[side]} dice (${d.length}): ` +
      c.slice(1).map((n,i)=>`${i+1}:${n}`).join(' ') +
      `   mean ${(d.reduce((a,b)=>a+b,0)/d.length).toFixed(2)}`);
  }

  // Which bonus fired how often, per side.
  const bonus = {};
  for(const f of fights){
    if(!f.diag) continue;
    for(const [side,list] of [[f.attackerSide,f.diag.aSources],[f.defenderSide,f.diag.dSources]]){
      for(const b of (list||[])){
        const k = SIDE_LABEL[side]+' | '+b;
        bonus[k] = (bonus[k]||0)+1;
      }
    }
  }
  if(Object.keys(bonus).length){
    out.push('');
    out.push('Bonuses applied');
    for(const [k,v] of Object.entries(bonus).sort((a,b)=>b[1]-a[1])) out.push(`  ${String(v).padStart(3)}  ${k}`);
  }

  // Per-unit record, for the after-action report and unit history later.
  out.push('');
  out.push('Per-unit record (fights / wins / losses)');
  const rec = {};
  for(const f of fights){
    for(const [id,won] of [[f.attackerId, f.aRoll>f.dRoll],[f.defenderId, f.dRoll>f.aRoll]]){
      const r = rec[id] = rec[id] || {n:0,w:0,l:0};
      r.n++; if(won) r.w++; else if(f.aRoll!==f.dRoll) r.l++;
    }
  }
  for(const [id,r] of Object.entries(rec).sort((a,b)=>b[1].n-a[1].n)){
    out.push(`  ${label(id).padEnd(36)} ${r.n} fought, ${r.w} won, ${r.l} lost`);
  }
  return out;
}

function sectionFlags(log, label){
  /* Automatic anomaly detection, so a bug surfaces without anyone having to
     spot it by eye. Every one of these corresponds to a fault that was actually
     found in a log by hand, at some cost. */
  const out = ['=== SECTION 6: DIAGNOSTIC FLAGS ==='];
  const flags = [];
  const cheb = (a,b)=>Math.max(Math.abs(a.x-b.x), Math.abs(a.y-b.y));
  const ALLOW = { BRIGADIER:2, GUARD:1, INFANTRY:1, LIGHT_CAV:2, HEAVY_CAV:2, ARTILLERY:1 };

  for(const e of log){
    if(e.type!=='move') continue;
    const u = state.units.find(o=>o.id===e.unitId);
    const cap = u ? (ALLOW[UNIT_TYPES[u.type].key] ?? 2) + 1 : 3;   // +1 for a road
    const d = cheb(e.from, e.to);
    /* A rout legitimately crosses the board, so long moves to the unit's own
       edge are exempt. But only if the move actually TRAVELS to that edge: a
       unit already standing on its edge row and sliding along it is not
       routing, and that is exactly the shape of the eight-tile pushback bug
       ((8,0) -> (0,0), both on row 0). Requiring the row to change keeps genuine
       routs quiet and still catches it. */
    const edgeRow = u ? (u.side===SIDES.RED ? ROWS-1 : 0) : null;
    const routingToEdge = u && e.to.y === edgeRow && e.from.y !== e.to.y;
    if(d > cap && !routingToEdge){
      flags.push(`T${e.turn}  ${label(e.unitId)}: moved ${d} tiles (allowance ${cap-1} +1 road)`);
    }
    if(d === 0){
      flags.push(`T${e.turn}  ${label(e.unitId)}: move resolved to its own tile (${e.to.x},${e.to.y})`);
    }
  }

  // The same pair fighting repeatedly in one turn: the fight-commitment guard.
  const pair = {};
  for(const e of log){
    if(e.type!=='fight') continue;
    const k = `${e.turn}|${e.attackerId}|${e.defenderId}`;
    pair[k] = (pair[k]||0)+1;
  }
  for(const [k,n] of Object.entries(pair)){
    if(n <= 2) continue;
    const [t,a,d] = k.split('|');
    flags.push(`T${t}  ${label(a)} vs ${label(d)}: fought ${n} times in one turn`);
  }

  /* One ATTACKER fighting repeatedly, against anyone. The pair check above missed
     the 10th Hussars attacking four different units in turn 31, because no single
     pairing repeated more than twice. Defending is mandatory and can legitimately
     happen several times a turn, so only the attacking side is counted. */
  const aggressor = {};
  for(const e of log){
    if(e.type!=='fight') continue;
    const k = `${e.turn}|${e.attackerId}`;
    aggressor[k] = (aggressor[k]||0)+1;
  }
  for(const [k,n] of Object.entries(aggressor)){
    if(n <= 2) continue;
    const [t,a] = k.split('|');
    flags.push(`T${t}  ${label(a)}: initiated ${n} fights in one turn (a unit may fight once)`);
  }

  // An ambush that never resolves. The bonus only appears when one springs, so
  // its absence across a whole match is the signal.
  /* Only meaningful if an ambush was actually LAID. The flag fired on a match
     where none was set at all, and reported it as "set but never triggered",
     which is a false alarm that costs the flag its credibility. */
  const anySet = log.some(e => e.type==='ambush' && e.phase==='set');
  const sprung = log.some(e => (e.type==='ambush' && e.phase==='sprung')) ||
    log.some(e => e.type==='fight' && e.diag &&
      [...(e.diag.aSources||[]), ...(e.diag.aNotes||[])].some(x=>/ambush/i.test(x)));
  if(anySet && !sprung){
    flags.push('MATCH  ambushes were laid but none ever resolved');
  }

  if(!flags.length) out.push('No anomalies detected.');
  else out.push(...flags);
  return out;
}

export function exportFullMatchLog(){
  if(!state.matchLog || state.matchLog.length===0) return 'No match log recorded — matchLog is only captured once a battle has actually started.';
  const label = id => {
    const u = state.units.find(o=>o.id===id);
    return u ? ((u.historicalName) || u.type) : id;
  };
  const lines = [];
  /* One sectioned file replacing the two overlapping exports. Sections 1, 2, 5
     and 6 are assembled around the existing turn log, which was already the
     most useful part of the old output and is kept unchanged as section 3. */
  lines.push(...sectionMetadata());
  lines.push('');
  lines.push(...sectionDeployment());
  lines.push('');
  lines.push('=== SECTION 3: TURN LOG ===');
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
      /* The move line now carries who moved, in what shape, and whether it ended
         on its Brigadier's chain, for BOTH sides. Older logs lack these fields,
         so each is printed only when present rather than as empty columns. */
      const bits = [];
      if(ev.unitType) bits.push(ev.unitType);
      if(ev.brigadeId!=null) bits.push(`Bde ${ev.brigadeId}`);
      if(ev.formation && ev.formation!=='line') bits.push(ev.formation.toUpperCase());
      if(ev.status && ev.status!=='Active') bits.push(ev.status);
      const tag = bits.length ? `  [${bits.join(' · ')}]` : '';
      const disc = (ev.connected===false) ? '  \u26A0 DISCONNECTED' : '';
      lines.push(`${label(ev.unitId)} (${SIDE_LABEL[ev.side]}): (${ev.from.x},${ev.from.y}) -> (${ev.to.x},${ev.to.y})${tag}${disc}`);
    } else if(ev.type==='formation'){
      lines.push(`FORMATION: ${label(ev.unitId)} (${SIDE_LABEL[ev.side]}) at (${ev.x},${ev.y}) -> ${ev.to.toUpperCase()}`);
    } else if(ev.type==='rally'){
      const who = ev.brigadierInRange ? `${ev.brigadier} in range` : 'NO Brigadier in range';
      const lead = ev.leadershipAvailable ? ', Leadership Roll still available' : ', no Leadership Roll left';
      lines.push(`RALLY: ${label(ev.unitId)} (${SIDE_LABEL[ev.side]}) at (${ev.x},${ev.y}) ` +
        `rolled ${ev.roll}, needs ${ev.threshold}+ -> ${ev.success ? 'RALLIES' : 'FAILS'}`);
      lines.push(`    ${who}${lead}${ev.note ? '  (' + ev.note + ')' : ''}`);
    } else if(ev.type==='ambush'){
      const extra = ev.phase==='sprung' ? ` on ${label(ev.targetId)} (${ev.mode})`
        : ev.reason ? ` — ${ev.reason}` : '';
      lines.push(`AMBUSH ${ev.phase}: ${label(ev.unitId)} (${SIDE_LABEL[ev.side]}) at (${ev.x},${ev.y})${extra}`);
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
        // Notes carry any modifier not in the sources list, so nothing is
        // unaccounted for when someone is checking the arithmetic by hand.
        if(d.aNotes && d.aNotes.length) lines.push(`    A notes: ${d.aNotes.join(' / ')}`);
        if(d.dNotes && d.dNotes.length) lines.push(`    D notes: ${d.dNotes.join(' / ')}`);
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
  lines.push('');
  lines.push('=== SECTION 4: AI DECISION LOG ===');
  lines.push('Every AI decision with its score broken down by contribution, and the next');
  lines.push('best alternatives it beat. Movement itself is in section 3; this is why.');
  lines.push('');
  for(const side of [SIDES.RED, SIDES.BLUE]){
    const hist = (state._aiMoveHistory && state._aiMoveHistory[side]) || [];
    if(!hist.length) continue;
    lines.push(`--- ${SIDE_LABEL[side]} ---`);
    let lastTurn = null;
    for(const h of hist){
      if(h.turn !== lastTurn){ lines.push(``); lines.push(`Turn ${h.turn}`); lastTurn = h.turn; }
      const to = h.to ? ` -> (${h.to.x},${h.to.y})` : '';
      lines.push(`  ${h.unit} [${h.type}] Bde ${h.brigadeId} · ${h.mission || 'no mission'} · ${h.action}${to}`);
      lines.push(...formatAiDecision(h, '      '));
    }
    lines.push('');
  }
  lines.push('');
  lines.push(...sectionSummary(state.matchLog, label));
  lines.push('');
  lines.push(...sectionFlags(state.matchLog, label));
  lines.push('');
  return lines.join('\n');
}

