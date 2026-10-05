import { exportAiMoveLog, summariseAiDecisions } from './ai-strategy.js';
import { campaignContext, campaignFinished, recordResult } from './campaign-play.js';
import { clearSave } from './match-save.js';
import { resolveEndOfRound, CONDITION_TABLE, areaHolders as coreAreaHolders, destroyedCount as coreDestroyed, listMet as coreListMet, marchedOff as coreMarchedOff, startingFighters as coreStartingFighters, useWorld } from './objective-core.js';
import { currentRecord, recAwaitOnlineMerge, recFinalise } from './telemetry/recorder.js';
import { isOnline } from './online-session.js';
import { AudioManager } from './audio-manager.js';
import { saveCampaignProgress } from './campaign.js';
import { SIDES, SIDE_LABEL, state } from './data-core.js';
import { log, logReplay } from './engine-state.js';
import { exportFullMatchLog, startReplay } from './replay.js';

/* =========================================================
   OPERATIONS: THE OBJECTIVE ENGINE (Operations and Campaigns brief, 2.4)

   state.scenario is a Scenario Card (js/scenario-cards.js). Each side has its
   own list of conditions with its own combinator ('any' or 'all'); the first
   side to complete its list wins.

   ROUNDS. A round is both sides having moved, fired and fought. The engine's
   state.turnNumber counts side-turns, so round = ceil(turnNumber / 2), and a
   round ends as the second side's fight phase ends (ui-battle calls
   scenarioRoundEnded then).

   WHEN THINGS ARE CHECKED
   - Instant conditions (DESTROY, MARCH_OFF) after every removal or march off
     (checkScenarioObjective, from checkWinCondition and marchOff). A list whose
     combinator is 'any' can win there; an 'all' list wins there only if every
     condition in it is instant.
   - Area conditions (HOLD_AREA, CLEAR_AREA, CONTROL_AREA) once at the end of
     each round, after both fight phases, when the whole of each list is
     evaluated. If both sides complete at the same check, ifBothMet decides.
   - At the end of round turnLimit with no winner, ifTimeExpires decides.
   - Then, at either check: a side with no non-Brigadier units left on the
     board (units that marched off are not lost) loses.
   The standard "break 2 of 3 Brigades" rule does not apply in Operations.

   Every result carries a reason ("British win: village cleared, round 6"),
   kept on state.scenarioResult for the log, the victory screen and the export.
   Step 8 adds condition types to CONDITIONS; nothing else should change.
========================================================= */
export function otherSide(side){ return side===SIDES.RED ? SIDES.BLUE : SIDES.RED; }
const SIDE_KEY = { [SIDES.RED]: 'british', [SIDES.BLUE]: 'french' };
const KEY_SIDE = { british: SIDES.RED, french: SIDES.BLUE };
export const sideKey = side => SIDE_KEY[side];
export const keySide = key => KEY_SIDE[key];
export const currentRound = () => Math.max(1, Math.ceil((state.turnNumber || 1) / 2));
/* The conditions themselves are in objective-core.js (pure); this file points
   them at the live game before each check. */
const world = () => useWorld({ units: state.units, card: state.scenario, streaks: (state.scenarioStreaks = state.scenarioStreaks || {}) });
const CONDITIONS = new Proxy({}, { get: (_t, k) => (world(), CONDITION_TABLE()[k]) });
export function areaHolders(name){ world(); return coreAreaHolders(name); }
export function destroyedCount(bySide, types){ world(); return coreDestroyed(bySide, types); }
export function marchedOff(side){ world(); return coreMarchedOff(side); }
function startingFighters(side){ world(); return coreStartingFighters(side); }
function listMet(side, ctx){ world(); return coreListMet(side, ctx); }
const fighters = side => state.units.filter(u => u.side === side && u.type !== 'BRIGADIER');
const onBoard = u => !u.removed;

/* The plain-words reason for a side's win. */
function reasonFor(side, ctx, how){
  const label = SIDE_LABEL[side];
  if(how === 'time') return `${label} win: time ran out, round ${ctx.round}`;
  if(how === 'wiped') return `${label} win: no enemy units left on the field, round ${ctx.round}`;
  const w = state.scenario.win[SIDE_KEY[side]];
  const met = (w.conditions || []).filter(c => CONDITIONS[c.type](side, c, Object.assign({}, ctx, { countRound: false })));
  const words = met.map(c => ({
    HOLD_AREA: `${c.area} held`, CLEAR_AREA: `${c.area} cleared`, CONTROL_AREA: `${c.area} taken`,
    DESTROY: `${c.count} ${c.unitTypes && c.unitTypes.length ? c.unitTypes.map(t => t.toLowerCase().replace('_cav', ' cavalry')).join('/') + ' ' : ''}destroyed`,
    MARCH_OFF: 'marched off the field',
  }[c.type])).filter(Boolean);
  return `${label} win: ${words.join(' and ') || 'objective complete'}, round ${ctx.round}${how === 'both' ? ' (both sides met their objectives)' : ''}`;
}
function decide(winner, reason, round){
  state.scenarioResult = { winner, reason, round };
  log(reason + '.', 'system');
  logReplay('scenarioResult', { winner, reason, round });
  endGame(winner);
}
function wipedOut(){
  for(const side of [SIDES.RED, SIDES.BLUE]) if(!fighters(side).some(onBoard)) return otherSide(side);
  return null;
}

/* After a removal or a march off. */
export function checkScenarioObjective(){
  if(!state.scenario || state.gameOver || state.replaying) return;
  const ctx = { endOfRound: false, round: currentRound() };
  const met = [SIDES.RED, SIDES.BLUE].filter(s => listMet(s, ctx));
  if(met.length === 1) return decide(met[0], reasonFor(met[0], ctx), ctx.round);
  if(met.length === 2){
    const w = state.scenario.ifBothMet ? KEY_SIDE[state.scenario.ifBothMet] : state.turn;
    return decide(w, reasonFor(w, ctx, 'both'), ctx.round);
  }
  const lost = wipedOut();
  if(lost) decide(lost, reasonFor(lost, ctx, 'wiped'), ctx.round);
}

/* The end of a round (ui-battle, after the second side's fight phase). */
export function scenarioRoundEnded(round){
  if(!state.scenario || state.gameOver) return;
  const ctx = { endOfRound: true, round, countRound: true };
  const met = [SIDES.RED, SIDES.BLUE].filter(s => listMet(s, ctx));
  recordRoundStatus(round);
  const r = resolveEndOfRound(state.scenario, met, round, wipedOut());
  if(r) decide(r.winner, reasonFor(r.winner, ctx, r.how), round);
}
/* Kept for the old call site: the round check now happens in scenarioRoundEnded. */
export function checkScenarioTurnLimit(){}

/* One line of objective status per round, for the export (2.9). */
function recordRoundStatus(round){
  const areas = Object.keys((state.scenario.map && state.scenario.map.areas) || {});
  const holders = areas.map(a => { const h = areaHolders(a); return `${a}: British ${h.british}, French ${h.french}`; });
  const line = `Round ${round}: ${holders.join('; ')}${holders.length ? '; ' : ''}destroyed by Britain ${destroyedCount(SIDES.RED)}, by France ${destroyedCount(SIDES.BLUE)}; ` +
    `marched off British ${marchedOff(SIDES.RED).length}, French ${marchedOff(SIDES.BLUE).length}`;
  (state.scenarioRounds = state.scenarioRounds || []).push(line);
}

/* A one-line live status of a side's objective, for the objective panel. */
export function objectiveStatusLine(side){
  if(!state.scenario || !state.scenario.win) return '';
  const w = state.scenario.win[SIDE_KEY[side]];
  const parts = [];
  for(const c of (w.conditions || [])){
    if(/AREA$/.test(c.type)){
      const h = areaHolders(c.area);
      const b = h.squaresBritish, f = h.squaresFrench;
      const name = c.area.replace(/^outpost/, 'outpost ');
      parts.push(b && f ? `${cap(name)}: contested` : b ? `${cap(name)}: British hold ${b} square${b > 1 ? 's' : ''}` :
        f ? `${cap(name)}: French hold ${f} square${f > 1 ? 's' : ''}` : `${cap(name)}: empty`);
    } else if(c.type === 'DESTROY'){
      parts.push(`Destroyed: ${destroyedCount(side, c.unitTypes)} of ${c.count}${c.unitTypes && c.unitTypes.length ? ' ' + c.unitTypes.map(t => t.toLowerCase().replace('_cav', ' cavalry')).join('/') : ''}`);
    } else if(c.type === 'MARCH_OFF'){
      const gone = marchedOff(side);
      const need = c.count != null ? c.count : Math.ceil((c.fraction || 0) * startingFighters(side));
      const missing = (c.mustInclude || []).filter(t => !gone.some(u => u.type === t));
      parts.push(`Marched off: ${gone.filter(u => u.type !== 'BRIGADIER').length} of ${need}` +
        (missing.length ? `, ${missing.map(t => t === 'BRIGADIER' ? 'Brigadier' : t.toLowerCase()).join(' and ')} still on the field` : ''));
    }
  }
  return [...new Set(parts)].join(' · ');
}
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

export function endGame(winner){
  state.gameOver = true;
  clearSave();   // match-save.js: a finished match has nothing to resume
  // Match telemetry: closes the record, with the export and the AI move log as
  // the game prints them and the AI's term table (spec 2.5). A record exists
  // only while a match is being recorded, so these are not built otherwise.
  if(currentRecord() && isOnline()){
    // Online: the record waits for the other phone's half of the match log.
    recAwaitOnlineMerge(winner, () => ({ exportText: exportFullMatchLog() }));
  } else if(currentRecord()){
    const aiSide = state.spectate ? SIDES.BLUE : state.aiSide;
    recFinalise({ winner, endReason: 'win_condition', campaign: campaignContext(), exportText: exportFullMatchLog(),
      moveLog: aiSide ? exportAiMoveLog() : null, termSummary: aiSide ? summariseAiDecisions(aiSide) : null });
  }
  // A turn theme still playing when the match ends fades rather than running on.
  AudioManager.fadeOutEffects('turn-theme-', 800);
  /* Recorded on state as well as shown on screen. The victory screen is the only
     place the result existed, which is fine for a person reading it and no use
     to anything that needs the outcome without a DOM (the AI-vs-AI runner, a
     future campaign tally). One field, set at the same instant as gameOver. */
  state.winner = winner;
  /* THE LAST BRIGADE TO BREAK STILL GETS ANNOUNCED.

     The second break is the one that wins, so the dispatch and this overlay want
     the screen at the same instant. Rather than let the overlay swallow it, the
     victory screen waits out the dispatch window and then opens.

     gameOver is set FIRST, before the wait, so nothing else can take a turn in
     the gap. Only the presentation is deferred, never the result. */
  const wait = (state._dispatchUntil || 0) - Date.now();
  if(wait > 0){
    // Guarded against re-entry: removeUnit can call checkWinCondition more than
    // once while the dispatch is up (a Column loses both units, then the
    // Brigadier withdraws), and without this each call would queue its own
    // overlay and they would stack.
    if(!state._endDeferred){
      state._endDeferred = true;
      setTimeout(()=>{
        /* An undo during the wait rewinds _endDeferred, because it lives on
           `state` and snapshotState serialises the whole object. If the flag is
           gone, this timer is orphaned: the break that triggered it has been
           undone and the match is live again. Abandon rather than ending a game
           that is back in play. */
        if(!state._endDeferred) return;
        state._endDeferred = false;
        endGame(winner);
      }, wait + 120);
    }
    return;
  }
  document.getElementById('overlayTitle').textContent = `${SIDE_LABEL[winner]} Victory`;
  showVictoryDressing(winner);
  const outcome = state.scenario && state.scenario.outcomes ? state.scenario.outcomes[winner === SIDES.RED ? 'britishWin' : 'frenchWin'] : null;
  const bodyText = state.scenario
    ? `${(state.scenarioResult && state.scenarioResult.reason) || SIDE_LABEL[winner] + ' achieves the objective'}.${outcome ? ' ' + outcome : ''}`
    : state.mapBattle
      ? `The enemy's Brigades are broken. ${SIDE_LABEL[winner]} holds the field at ${state.mapBattle.townName}.`
      : `Two of the enemy's three Brigades are broken. ${SIDE_LABEL[winner]} holds the field.`;
  document.getElementById('overlayText').textContent = bodyText;
  const modeChoices = document.getElementById('modeChoices');
  if(modeChoices) modeChoices.style.display = 'none';
  document.getElementById('overlayBtn').style.display = 'inline-block';
  if(state.campaign){
    state.campaignLastWinner = winner;
    state.campaignRecord.push(winner);
    document.getElementById('overlayBtn').textContent = 'Continue Campaign';
    document.getElementById('overlayBtn').onclick = ()=>{
      state.campaignFlowIndex++;
      saveCampaignProgress();
      location.reload();
    };
  } else if(state.campaignRun){
    /* A campaign step (campaign-play.js): the result is recorded, and the
       button goes back to the campaign rather than to a new battle. */
    const p = recordResult(winner);
    const done = p && campaignFinished(p);
    document.getElementById('overlayBtn').textContent = done ? 'Campaign Result' : 'Continue Campaign';
    document.getElementById('overlayBtn').onclick = ()=> import('./ui-menus.js').then(m => m.showCampaignScreen());
  } else if(state.mapBattle){
    /* A campaign MAP battle: the result goes back to the map now (losses
       permanent, the loser retreats, autosaved), and the button returns there. */
    const mapUi = import('./campaign-map-ui.js');
    mapUi.then(m => m.recordMapBattle(winner));
    document.getElementById('overlayBtn').textContent = 'Return to Campaign Map';
    document.getElementById('overlayBtn').onclick = ()=> mapUi.then(m => m.returnToMapAfterBattle(winner));
  } else {
    document.getElementById('overlayBtn').textContent = 'New Battle';
    document.getElementById('overlayBtn').onclick = ()=> location.reload();
  }
  const box = document.querySelector('#overlay .box');
  let extra = document.getElementById('modeChoices');
  if(!extra){
    extra = document.createElement('div');
    extra.id = 'modeChoices';
    extra.style.gap = '8px';
    extra.style.justifyContent = 'center';
    box.appendChild(extra);
  }
  renderEndButtons();
  document.getElementById('overlay').classList.add('show');
}

/* THE VICTORY SCREEN'S DRESSING (index.html, MAP PANELS): the map panel, a wax
   seal in the winner's colour under the plaque, and a row of what the match
   cost, using only what the game already tracks: side-turns played
   (state.turnNumber, the same count the match log calls "Turn"), Brigades
   broken on each side (a Brigade with every unit under its Brigadier gone,
   the test checkWinCondition uses), and units lost on each side. */
function showVictoryDressing(winner){
  const box = document.querySelector('#overlay .box');
  box.classList.remove('as-folio');
  box.classList.add('as-victory');
  let seal = box.querySelector('.victory-seal');
  if(!seal){ seal = document.createElement('div'); seal.setAttribute('aria-hidden', 'true'); box.insertBefore(seal, document.getElementById('overlaySubtitle')); }
  seal.className = 'victory-seal ' + (winner === SIDES.BLUE ? 'blue' : 'red');
  let stats = box.querySelector('.victory-stats');
  if(!stats){ stats = document.createElement('div'); stats.className = 'victory-stats'; document.getElementById('overlayText').after(stats); }
  const sides = [SIDES.RED, SIDES.BLUE];
  const broken = side => {
    const keys = new Set(state.units.filter(u => u.side === side).map(u => (u.army || '') + ':' + u.brigadeId));
    let n = 0;
    for(const k of keys){
      const group = state.units.filter(u => u.side === side && (u.army || '') + ':' + u.brigadeId === k && u.type !== 'BRIGADIER');
      if(group.length && group.every(u => u.removed)) n++;
    }
    return n;
  };
  const lost = side => state.units.filter(u => u.side === side && u.removed && !u.escaped && u.type !== 'BRIGADIER').length;   // marching off is not a loss
  /* A small two-column table, one column a side, so each number says whose it
     is (3 Oct 2026: "6 · 13 units lost / Britain · France" read as a puzzle).
     Operations show what they are decided by: units lost and units marched
     off, not Brigades broken. The length is given in rounds, both sides'
     turns together, which is what an Operation's limit counts too. */
  const ops = !!(state.scenario && state.scenario.kind === 'operation');
  const escaped = side => state.units.filter(u => u.side === side && u.escaped).length;
  const row = (label, f) => `<tr><th>${label}</th>${sides.map(s => `<td>${f(s)}</td>`).join('')}</tr>`;
  const rounds = ops && state.scenarioResult ? state.scenarioResult.round : Math.ceil((state.turnNumber || 0) / 2);
  stats.innerHTML = `<table><thead><tr><th></th>${sides.map(s => `<th class="${s}">${SIDE_LABEL[s]}</th>`).join('')}</tr></thead><tbody>` +
    (ops ? '' : row('Brigades broken', broken)) +
    row('Units lost', lost) +
    (ops && sides.some(escaped) ? row('Marched off', escaped) : '') +
    `</tbody></table><div class="victory-length">The battle lasted ${rounds} round${rounds === 1 ? '' : 's'}</div>`;
}

/* The victory screen's buttons. Split out so an online match can rebuild them
   once the other phone's half of the match record has arrived (each phone only
   records the turns it ran), which is what makes Watch Replay and the full
   export complete on both phones. */
export function renderEndButtons(){
  const extra = document.getElementById('modeChoices');
  if(!extra || !state.gameOver) return;
  extra.innerHTML = ''; // always rebuilt fresh here — no dependency on what an earlier menu left behind
  const endScreenButtons = [];
  if(state.matchLog && state.matchLog.length>0 && state.replayStartUnits){
    const replayBtn = document.createElement('button');
    replayBtn.textContent = 'Watch Replay';
    replayBtn.onclick = startReplay;
    endScreenButtons.push(replayBtn);
  }
  /* No separate "Export AI Move Log" button any more (telemetry spec 7): the
     move log is already appended to the full export below, and it is saved
     with every match record (telemetry.texts.move_log). */
  if(state.matchLog && state.matchLog.length>0){
    const fullExportBtn = document.createElement('button');
    fullExportBtn.textContent = 'Export Full Match Log';
    fullExportBtn.onclick = ()=>{
      document.getElementById('aiLogExportTitle').textContent = 'Full Match Log';
      /* The AI move log used to be a separate button, so a full export could
         arrive without it: seed 1141694745 came back with sections 1 to 6 and
         no move log, no disconnection figures and no missions by turn, which
         read as a broken export when it was one of two buttons not pressed.
         With an AI in the match, it is now always appended. */
      document.getElementById('aiLogExportText').value = exportFullMatchLog() +
        (state.aiSide && !isOnline() ? '\n\n' + exportAiMoveLog() : '');
      // Tells the dialog to snapshot the untouched text before any filtering.
      document.dispatchEvent(new CustomEvent('tb:logShown'));
      document.getElementById('aiLogExportPanel').classList.remove('hidden');
    };
    endScreenButtons.push(fullExportBtn);
  }
  extra.style.display = endScreenButtons.length ? 'flex' : 'none';
  endScreenButtons.forEach(b=>extra.appendChild(b));
}

