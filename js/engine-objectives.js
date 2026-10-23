import { quickPoints, quickRoundLimit } from './engine-rules.js';
import { exportAiMoveLog, summariseAiDecisions } from './ai-strategy.js';
import { campaignContext, campaignFinished, recordResult } from './campaign-play.js';
import { clearSave } from './match-save.js';
import { resolveEndOfRound, CONDITION_TABLE, areaHolders as coreAreaHolders, destroyedCount as coreDestroyed, listLatched as coreListLatched, conditionProgress as coreProgress, latchList as coreLatchList, listMet as coreListMet, marchedOff as coreMarchedOff, startingFighters as coreStartingFighters, useWorld } from './objective-core.js';
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

/* INDEPENDENT JUDGING (campaign battles, card.judging = 'independent').
   Each side's objective is what that side achieved historically, so both can
   be met in one game. Each side's objective is LATCHED the moment it is met
   (an instant condition at once, an end-of-round one at that round's end);
   the battle runs to its turn limit (or until one side has no units left),
   and then both results are shown. Ordinary Operations are unchanged. */
const independent = () => state.scenario && state.scenario.judging === 'independent';
function latchAchieved(ctx){
  const got = state.scenarioAchieved = state.scenarioAchieved || {};
  for(const side of [SIDES.RED, SIDES.BLUE]){
    world();
    const conds = (state.scenario.win && state.scenario.win[SIDE_KEY[side]] && state.scenario.win[SIDE_KEY[side]].conditions) || [];
    const before = conds.map((_, i) => !!state.scenarioStreaks[SIDE_KEY[side] + ':L:' + i]);
    const all = coreListLatched(side, ctx);
    // An objective in several parts says so as each part is done ("1 of 2"), not only at the end.
    if(conds.length > 1 && !got[side]) conds.forEach((c, i) => {
      if(before[i] || !state.scenarioStreaks[SIDE_KEY[side] + ':L:' + i]) return;
      const n = conds.filter((_, j) => state.scenarioStreaks[SIDE_KEY[side] + ':L:' + j]).length;
      if(state.scenario.win[SIDE_KEY[side]].combinator === 'all' && n < conds.length)
        log(`${SIDE_LABEL[side]}: part ${n} of ${conds.length} of the objective done (round ${ctx.round}).`, 'system');
    });
    if(got[side] || !all) continue;
    got[side] = ctx.round;
    log(`${SIDE_LABEL[side]} ${achieves(side)} ${its(side)} objective (round ${ctx.round}).`, 'system');
    logReplay('objectiveMet', { side, round: ctx.round });
  }
  // Allied nations' objectives: latched and logged the same way, deciding nothing.
  const allyGot = state.scenarioAllyAchieved = state.scenarioAllyAchieved || {};
  for(const side of [SIDES.RED, SIDES.BLUE]) for(const a of allyObjectives(side)){
    const key = allyKey(side, a);
    if(allyGot[key]) continue;
    world();
    if(!coreLatchList(side, a, key + ':', ctx)) continue;
    allyGot[key] = ctx.round;
    log(`${a.nation} (allied) achieves its objective (round ${ctx.round}).`, 'system');
    logReplay('allyObjectiveMet', { side, nation: a.nation, round: ctx.round });
  }
}
/* A side's allied nations' objectives (story.js card.allies), and the key their
   latches and result are kept under. */
export function allyObjectives(side){
  const sc = state.scenario;
  return (independent() && sc.allies && sc.allies[SIDE_KEY[side]]) || [];
}
const allyKey = (side, a) => `${SIDE_KEY[side]}:A:${a.nation}`;
/* "Britain and Prussia did not achieve its objective" read wrongly: a side
   named for two nations takes "their" (and "achieve", not "achieves"). */
const plural = side => / and /.test(SIDE_LABEL[side]);
const its = side => (plural(side) ? 'their' : 'its');
const achieves = side => (plural(side) ? 'achieve' : 'achieves');
function finishIndependent(round, how){
  const got = state.scenarioAchieved = state.scenarioAchieved || {};
  /* DESTROYING THE WHOLE ENEMY ARMY COUNTS (23 Oct 2026, Matthew): a side
     that leaves the enemy no units at all has done everything its objective
     could ask of the battle, so it is achieved, whatever round the objective
     named; the campaign then moves on as for any other success. */
  if(how === 'wiped'){
    const w = wipedOut();
    if(w && !got[w]){
      got[w] = round;
      log(`${SIDE_LABEL[w]} ${plural(w) ? 'destroy' : 'destroys'} the enemy army: objective achieved (round ${round}).`, 'system');
    }
  }
  const words = side => `${SIDE_LABEL[side]} ${got[side] ? `achieved ${its(side)} objective (round ${got[side]})` : `did not achieve ${its(side)} objective`}`;
  const allyGot = state.scenarioAllyAchieved || {};
  const allies = [SIDES.RED, SIDES.BLUE].flatMap(side => allyObjectives(side).map(a => ({ nation: a.nation, side, round: allyGot[allyKey(side, a)] || null })));
  const allyWords = allies.map(a => `; ${a.nation} (allied) ${a.round ? `achieved its objective (round ${a.round})` : 'did not achieve its objective'}`).join('');
  const reason = `${words(SIDES.RED)}; ${words(SIDES.BLUE)}${allyWords}${how === 'wiped' ? ', and the field is cleared' : how === 'early' ? `; the battle was ended in round ${round}` : ''}`;
  // The banner names a side: the one that met its objective while the other did
  // not; if both or neither did, the human player's side (or red) is named and
  // the result line says what happened to each.
  /* NEITHER MET ITS OBJECTIVE (23 Oct 2026, Papelotte): the banner read
     "Britain and Prussia Victory" over a result line saying both sides had
     failed. Now nobody is named; the screen says neither side prevailed. */
  const human = state.aiSide ? otherSide(state.aiSide) : SIDES.RED;
  const winner = got[SIDES.RED] && !got[SIDES.BLUE] ? SIDES.RED : got[SIDES.BLUE] && !got[SIDES.RED] ? SIDES.BLUE : got[SIDES.RED] ? human : null;
  state.scenarioResult = { winner, reason, round, achieved: { red: !!got[SIDES.RED], blue: !!got[SIDES.BLUE] }, allies };
  log(reason + '.', 'system');
  logReplay('scenarioResult', { winner, reason, round, achieved: state.scenarioResult.achieved });
  endGame(winner);
}

/* END BATTLE (23 Oct 2026, Matthew: the Cavalry at Genappe was won by round
   4 and then ran eight more rounds with nothing at stake for him). In a
   campaign battle, once the player's own objective is achieved, the player
   may end it there: both sides are judged as they stand, so whatever the
   enemy had not achieved by then it has not achieved. operation-panel.js
   offers the button. */
const humanSide = () => (state.mode === 'ai' && !state.spectate && state.aiSide ? otherSide(state.aiSide) : null);
export function canEndBattleEarly(){
  const me = humanSide();
  return !!(me && independent() && !state.gameOver && state.scenarioAchieved && state.scenarioAchieved[me]);
}
export function endBattleEarly(){
  if(!canEndBattleEarly()) return;
  log(`${SIDE_LABEL[humanSide()]} ${plural(humanSide()) ? 'end' : 'ends'} the battle (round ${currentRound()}).`, 'system');
  finishIndependent(currentRound(), 'early');
}

/* After a removal or a march off. */
export function checkScenarioObjective(){
  if(!state.scenario || state.gameOver || state.replaying) return;
  if(independent()){
    latchAchieved({ endOfRound: false, round: currentRound() });
    if(wipedOut()) finishIndependent(currentRound(), 'wiped');
    return;
  }
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
  if(independent()){
    latchAchieved(ctx);
    recordRoundStatus(round);
    if(wipedOut()) return finishIndependent(round, 'wiped');
    if(state.scenario.turnLimit && round >= state.scenario.turnLimit) return finishIndependent(round, 'time');
    return;
  }
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
export function objectiveStatusLine(side, ally = null){
  if(!state.scenario || !state.scenario.win) return '';
  const w = ally || state.scenario.win[SIDE_KEY[side]];
  const prefix = ally ? allyKey(side, ally) + ':' : SIDE_KEY[side] + ':L:';   // where each part's latch is kept
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
    } else if(c.type === 'COMMANDER' || c.type === 'COMMANDER_REMOVED'){
      parts.push(commanderStatus(side, c, prefix + w.conditions.indexOf(c)));
    } else if(coreProgressOf(side, c)){
      parts.push(countStatus(side, c, prefix + w.conditions.indexOf(c)));
    } else if(c.type === 'ENTERED'){
      const done = state.scenarioStreaks && state.scenarioStreaks[SIDE_KEY[side] + ':ENTERED:' + c.area];
      const late = !done && c.byRound && currentRound() > c.byRound;
      parts.push(`${areaName(c.area)}: ${done ? 'reached \u2713' : late ? `not reached by round ${c.byRound}` : 'not reached yet'}${!done && !late && c.byRound ? ` (by round ${c.byRound})` : ''}`);
    } else if(c.type === 'MARCH_OFF'){
      const gone = marchedOff(side);
      const need = c.count != null ? c.count : Math.ceil((c.fraction || 0) * startingFighters(side));
      const missing = (c.mustInclude || []).filter(t => !gone.some(u => u.type === t));
      parts.push(`Marched off: ${gone.filter(u => u.type !== 'BRIGADIER').length} of ${need}` +
        (missing.length ? `, ${missing.map(t => t === 'BRIGADIER' ? 'Brigadier' : t.toLowerCase()).join(' and ')} still on the field` : ''));
    }
  }
  /* A side whose only objective is to last (no conditions of its own, and the
     card gives it the win when time runs out): a campaign rearguard. */
  if(!(w.conditions || []).length && state.scenario.ifTimeExpires === SIDE_KEY[side]){
    const left = Math.max(0, state.scenario.turnLimit - currentRound() + 1);
    parts.push(`Hold on: ${left} round${left === 1 ? '' : 's'} to go`);
  }
  return [...new Set(parts)].join(' · ');
}
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const areaName = a => cap(String(a).replace(/_/g, ' '));
function coreProgressOf(side, c){ world(); return coreProgress(side, c); }
/* A count objective in plain words, with when it counts, and a warning in
   the last two rounds before it counts while it is short (Papelotte: two
   hamlet squares held of the three needed, and nothing on screen said so). */
function countStatus(side, c, latch){
  const { have, need } = coreProgressOf(side, c);
  const n = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`;
  const [label, held] = {
    HOLD_COUNT: () => [areaName(c.area), n(have, 'square') + ' held'],
    IN_AREA: () => [areaName(c.area), n(have, 'unit') + ' there'],
    NEXT_TO: () => [`${cap(c.tag)} beside ${cap(c.nextTo)}`, n(have, 'unit')],
    HOLD_AREAS: () => ['Places held', String(have)],
    BRIGADES_UNBROKEN: () => ['Brigades unbroken', String(have)],
    BREAK_BRIGADES: () => ['Enemy Brigades broken', String(have)],
  }[c.type]();
  const done = !!(independent() && state.scenarioStreaks && state.scenarioStreaks[latch]);
  if(done) return `${label}: ${held} \u2713`;
  const round = currentRound(), at = c.atRound;
  if(at && round > at) return `${label}: ${held}, ${need} needed (counted at round ${at}: not met)`;
  const left = at ? at - round : c.byRound ? c.byRound - round : null;
  if(have < need && left != null && left <= 1)
    return `\u26A0 ${label}: ${held}, ${need - have} short (${at ? 'counts' : 'due'} at the end of ${left === 0 ? 'this' : 'next'} round)`;
  const when = at ? ` (counts at the end of round ${at})` : c.byRound ? ` (by round ${c.byRound})` : '';
  return `${label}: ${held}, ${need} needed${when}`;
}
/* A named commander's part of an objective, in plain words (19 Oct 2026: the
   Duke's Narrow Escape showed nothing at all, so Wellington reaching the 92nd
   in time looked as if it had not counted). A part already achieved in an
   independently judged battle is ticked. */
const commanderOf = tag => state.units.find(u => u.storyTag === tag && u.type === 'BRIGADIER');
const commanderName = tag => { const u = commanderOf(tag); return (u && u.historicalName) || cap(tag); };
function commanderStatus(side, c, latch){
  const done = !!(state.scenarioStreaks && state.scenarioStreaks[latch]);
  const u = commanderOf(c.tag), name = commanderName(c.tag), alive = !!u && !u.removed;
  if(c.type === 'COMMANDER_REMOVED') return alive ? `${name}: still in the field` : `${name}: taken \u2713`;
  if(!alive) return `${name}: lost`;
  const round = currentRound();
  if(c.area){
    const there = (state.scenario.map && state.scenario.map.areas && state.scenario.map.areas[c.area] || []).some(([x, y]) => u.x === x && u.y === y);
    if(done) return `${name} in place by round ${c.atRound || round} \u2713`;
    if(c.atRound && round > c.atRound) return `${name} was not in place at round ${c.atRound}`;
    return `${name}: ${there ? 'in place' : 'not in place yet'}${c.atRound ? ` (counts at the end of round ${c.atRound})` : ''}`;
  }
  return c.atRound ? `${name} in play until the end of round ${c.atRound}${done ? ' \u2713' : ''}` : `${name}: in play${done ? ' \u2713' : ''}`;
}

/* The Quick Battle round limit is reached (engine-rules QUICK_ROUND_LIMIT). */
export function endOnPoints(){
  const red = quickPoints(SIDES.RED), blue = quickPoints(SIDES.BLUE);
  state.pointsResult = { red, blue, rounds: quickRoundLimit() };
  log(`Round ${quickRoundLimit()} is over: ${SIDE_LABEL[SIDES.RED]} ${red} points, ${SIDE_LABEL[SIDES.BLUE]} ${blue}.`, 'system');
  logReplay('pointsResult', { red, blue });
  endGame(red > blue ? SIDES.RED : blue > red ? SIDES.BLUE : null);
}
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
  const pr = state.pointsResult;
  const noneMet = !winner && state.scenarioResult && state.scenarioResult.achieved && !state.scenarioResult.achieved.red && !state.scenarioResult.achieved.blue;
  document.getElementById('overlayTitle').textContent = winner ? `${SIDE_LABEL[winner]} Victory` : noneMet ? 'Neither Side Prevails' : 'A Drawn Battle';
  if(winner) showVictoryDressing(winner);
  const outcome = state.scenario && state.scenario.outcomes ? state.scenario.outcomes[winner === SIDES.RED ? 'britishWin' : 'frenchWin'] : null;
  const bodyText = pr
    ? `Round ${pr.rounds} is over and neither army is broken. On points (enemy units destroyed, and 5 for each Brigade broken): ${SIDE_LABEL[SIDES.RED]} ${pr.red}, ${SIDE_LABEL[SIDES.BLUE]} ${pr.blue}. ${winner ? SIDE_LABEL[winner] + ' holds the field.' : 'Both armies hold their ground.'}`
    : state.scenario
    ? `${(state.scenarioResult && state.scenarioResult.reason) || SIDE_LABEL[winner] + ' achieves the objective'}.${outcome ? ' ' + outcome : ''}`
    : state.mapBattle
      ? `The enemy's Brigades are broken. ${SIDE_LABEL[winner]} holds the field at ${state.mapBattle.townName}.`
      : `Two of the enemy's three Brigades are broken. ${SIDE_LABEL[winner]} holds the field.`;
  document.getElementById('overlayText').textContent = bodyText;
  const modeChoices = document.getElementById('modeChoices');
  if(modeChoices) modeChoices.style.display = 'none';
  document.getElementById('overlayBtn').style.display = 'inline-block';
  // Kept for Replay Battle: recordStoryResult clears state.storyRun.
  replayStory = state.storyRun ? Object.assign({}, state.storyRun) : null;
  if(state.storyRun){
    /* A story campaign battle (story-ui.js): passed if the player's nation met
       its objective; the button goes back to the campaign's route. */
    const story = import('./story-ui.js');
    story.then(m => { const r = m.recordStoryResult(); if(r) document.getElementById('overlayText').textContent += ' ' + r.text; });
    document.getElementById('overlayBtn').textContent = 'Back to the Campaign';
    document.getElementById('overlayBtn').onclick = ()=> story.then(m => m.showTheatre());
  } else if(state.campaign){
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
/* REPLAY BATTLE (23 Oct 2026, Matthew, after Papelotte): the same battle
   again from its start, on a fresh page so nothing of the match just played
   carries over (the way New Battle has always worked); boot.js reads the note
   and starts it (ui-menus replayBattleFromNote). A campaign battle not yet
   passed still counts for the campaign when replayed; one already passed is
   replayed as practice, so it cannot be passed twice. Battles with their own
   campaign bookkeeping (the campaign map, campaign steps) and shared games
   go back through their own screens instead. */
export const REPLAY_NOTE = 'fc_replay_battle';
let replayStory = null;
function canReplayBattle(){
  return !!(state.scenario && state.scenario.id && humanSide() && !isOnline() && !state.group && !state.rts &&
    !state.campaign && !state.campaignRun && !state.mapBattle);
}
function replayBattle(){
  const side = humanSide();
  const passed = !!(state.scenarioResult && state.scenarioResult.achieved && state.scenarioResult.achieved[side]);
  const note = { cardId: state.scenario.id, side, storyRun: replayStory && !passed ? replayStory : null };
  try { sessionStorage.setItem(REPLAY_NOTE, JSON.stringify(note)); } catch { /* no session storage: the title screen */ }
  location.reload();
}

export function renderEndButtons(){
  const extra = document.getElementById('modeChoices');
  if(!extra || !state.gameOver) return;
  extra.innerHTML = ''; // always rebuilt fresh here — no dependency on what an earlier menu left behind
  const endScreenButtons = [];
  if(canReplayBattle()){
    const again = document.createElement('button');
    again.textContent = 'Replay Battle';
    again.onclick = replayBattle;
    endScreenButtons.push(again);
  }
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

