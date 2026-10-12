/* =========================================================
   ONLINE: SHARED ARMIES (two players command one army together)

   Behind a flag while it is reviewed: offered only with ?sharedArmies=1
   (remembered for the tab). Modes:
     coop  Co-op against the AI: two players share Britain, the AI plays France
     2v1   two players share Britain against one player as France
     2v2   both armies shared, two players to each
   The board and the rules are the standard one-against-one battle. Players
   sit at a seat (Britain 1st and 2nd commander, France 1st and 2nd); on a
   shared army the three Brigades are dealt between the two partners (one and
   two) and the host may swap them until the start. An empty seat's Brigades
   go to its partner.

   SEATS ARE BRIGADES. state.shared.commanders maps 'side:brigadeId' to a
   player. A phone may order only its own Brigades (online-session ownsUnit);
   a partner's units can be looked at, not ordered. aiSide on every phone is
   the side it is NOT on, permanently, so the board view and hidden ambushes
   are right for that player; what a partner may do at a given moment is
   decided here, not by aiSide.

   ONE WRITER AT A TIME. As in 1v1 and 2v2, one phone runs the rules and sends
   the whole battle; the others animate and adopt it. Who that is:
     setup and deployment            the host
     the AI's turn (Co-op)           the host, which runs the AI
     a one-player side's turn        that player
     a shared army's Move phase      the REFEREE (the host if they are on that
                                     army, otherwise its first partner present)
     a shared army's Fire and Fight  whoever holds the BATON
   MOVE PHASE: both partners move at once. A partner's phone does not run the
   move; it sends the order (move unit X to square Y, form square, lay ambush,
   march off, Done, Undo) to the referee and shows its own move at once. The
   referee carries orders out in the order they arrive through the very same
   code a tap runs (select the unit, tap the square), so legality, ambushes and
   their dice are exactly the rules; the dice are only ever rolled on the
   referee's phone and stay one sequence everywhere. An order that is no
   longer legal when it arrives (the square was taken a moment before) is
   refused, and the unit walks back with "Square taken". Undo takes back only
   your own last move. The phase ends when every partner present has pressed
   Done.
   FIRE AND FIGHT: one partner at a time holds the baton (synced), acts with
   their own Brigades and sends; Hand over passes it; Done passes it to a
   partner who has not finished, and when all have, the phase ends.
   QUESTIONS (re-roll, Leadership, ambush) go to the phone commanding the
   unit's Brigade.
   DROPOUT: a partner who is not present has their Brigades passed to their
   teammate (and the referee or the baton to the next phone present) until
   they come back.
   DEPLOYMENT: as in 1v1, the host places both armies; each army is chosen
   on the phone of its named partner (the host on their own army, otherwise
   the 1st commander).
========================================================= */
import { recOnlineMerged } from './telemetry/recorder.js';
import { COLS, ROWS, SIDES, SIDE_LABEL, setBoardMode, state } from './data-core.js';
import { setOnlineSession, setRemoteAsker, setRemoteDeployHandler } from './online-session.js';
import { localTransport, supabaseTransport } from './online-group.js';
import { animateUnitTo, CAMERA_ACTION_PAN_MS, cameraParkPlayerView, cameraRestorePlayerView, cameraToAction, cameraToUnits,
         canvas, cellFromClient, draw, fromScreen, playBoardIntroAnimation, replayActionLine, replayGunfire, sizeCanvas, toScreen } from './render-board.js';
import { highlightCells } from './render-units.js';
import { ANSWER_WINDOW_MS } from './prompt-panel.js';
import { playMovementAudio, showLeadershipRollPrompt } from './engine-rules.js';
import { endFightPhase, endFirePhase, endMovePhase, noteBrigadeBreaks, onCellClick, playTurnTheme, selectUnit,
         showAmbushChoice, unitLabel, updateHeader } from './ui-battle.js';
import { log, logReplay, syncPhaseButtons } from './engine-state.js';
import { endGame, renderEndButtons } from './engine-objectives.js';
import { deployArmyComposition } from './ai-deployment.js';
import { aiDoMovePhase, aiPlanTurn } from './ai-router.js';
import { maybeShowArmyPicker, showArmyPickerFor, startAmbientLayer } from './ui-menus.js';
import { replayDice, setDiceMirror, showDiceRerollButton } from './dice.js';
import { AudioManager } from './audio-manager.js';

/* ---------- the flag ---------- */
const FLAG_KEY = 'fc-shared-armies';
export function sharedArmiesEnabled(){
  try {
    if(new URLSearchParams(location.search).get('sharedArmies') === '1') sessionStorage.setItem(FLAG_KEY, '1');
    return sessionStorage.getItem(FLAG_KEY) === '1';
  } catch { return false; }
}

/* ---------- modes and seats ---------- */
export const MODES = {
  coop: { label: 'Co-op against the AI', note: 'Two of you share Britain against the AI.', seats: ['red1', 'red2'], aiSide: SIDES.BLUE },
  '2v1': { label: '2 against 1', note: 'Two of you share Britain against one player as France.', seats: ['red1', 'red2', 'blue1'], aiSide: null },
  '2v2': { label: '2 against 2, shared', note: 'Two players to each army.', seats: ['red1', 'red2', 'blue1', 'blue2'], aiSide: null },
};
const SEAT_SIDE = { red1: SIDES.RED, red2: SIDES.RED, blue1: SIDES.BLUE, blue2: SIDES.BLUE };
const SEAT_LABEL = { red1: 'Britain · 1st commander', red2: 'Britain · 2nd commander', blue1: 'France · 1st commander', blue2: 'France · 2nd commander' };
const SIDE_SEATS = { red: ['red1', 'red2'], blue: ['blue1', 'blue2'] };
/* Each partner's colour: the ring round their units on their teammate's
   screen, and their mark in the banner, the lobby and their pings. */
export const SEAT_COLOR = { red1: '#e8bd4f', red2: '#5cc8db', blue1: '#e8bd4f', blue2: '#5cc8db' };
const BRIGADE_NAME = ['1st', '2nd', '3rd'];
const AI_LEVELS = [['hard', 'Marshal'], ['medium', 'Colonel'], ['easy', 'Captain']];
const otherSide = s => (s === SIDES.RED ? SIDES.BLUE : SIDES.RED);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const BATTLE_PHASES = new Set(['move', 'fire', 'fight']);
const PHASE_ORDER = { setup: 0, orientation: 0, deploy: 1, move: 2, fire: 3, fight: 4 };
const SEND_EVERY_MS = 250, SAVE_EVERY_MS = 3000;
const LOCAL_ONLY = new Set(['mode', 'aiSide', 'spectate', 'selectedUnitId', 'aiDifficulty', 'viewEdge',
  'brokenSeen', '_dispatchUntil', '_endDeferred', 'replaying']);
const skipKey = k => k === 'matchLog' || k === 'replayStartUnits' || k.startsWith('_ai') || LOCAL_ONLY.has(k);
const pack = () => JSON.stringify(state, (k, v) => (k && skipKey(k)) ? undefined : (v instanceof Set ? { __isSet: true, items: [...v] } : v));
const unpack = s => JSON.parse(s, (k, v) => (v && v.__isSet) ? new Set(v.items) : v);
const find = id => state.units.find(u => u.id === id);

/* The lobby's choices, kept on the match (match.state.lobby) until the start:
   { kind: 'shared', mode, deal: { 'red:0': 'red1', ... }, ai: 'hard' }.
   One partner 1 Brigade, the other 2; an empty seat's go to its partner. */
export function dealBrigades(seats, deal){
  const out = {};
  for(const side of [SIDES.RED, SIDES.BLUE]){
    const [a, b] = SIDE_SEATS[side];
    for(let i = 0; i < 3; i++){
      const key = `${side}:${i}`;
      let seat = (deal && deal[key]) || (i === 0 ? a : b);
      if(!seats[seat]) seat = seats[a] ? a : seats[b] ? b : null;
      out[key] = seat;
    }
  }
  return out;
}

/* ---------- the session's view of the match ---------- */
let T = null, me = null, match = null;
let present = new Set(), presenceKnown = false;
let lastShared = null, seq = 0, sendTimer = null, lastSave = 0;
let setupShown = false, inBattle = false, endShown = false, setupStarted = false;
let wasWriter = false, lastPhaseKey = null, lastTurnKey = null, lastReferee = null, aiKickedFor = null;
const S = () => state.shared || null;      // { mode, host, seats, names, commanders, chooser, aiSide }

const nameOf = uid => (uid === me ? 'You' : (S() && S().names && S().names[uid]) || (match && match.names && match.names[uid]) || 'A player');
const seatOf = uid => { const s = S(); if(!s || !uid) return null; return Object.keys(s.seats).find(k => s.seats[k] === uid) || null; };
const mySide = () => { const k = seatOf(me); return k ? SEAT_SIDE[k] : null; };
const isHere = uid => uid === me || !presenceKnown || present.has(uid);
const sidePlayers = side => { const s = S(); return s ? SIDE_SEATS[side].map(k => s.seats[k]).filter(Boolean) : []; };
const sideIsShared = side => sidePlayers(side).length === 2;
const sideIsAi = side => !!S() && S().aiSide === side;

/* Who commands a unit now: its Brigade's commander, or, while that player is
   away, their partner (if present). Null for the AI's units. */
function commanderOf(u){
  const s = S(); if(!s || !u) return null;
  const owner = s.commanders[`${u.side}:${u.brigadeId}`];
  if(!owner) return null;
  if(isHere(owner)) return owner;
  return sidePlayers(u.side).find(p => p !== owner && isHere(p)) || owner;
}
/* The phone that referees a shared army's Move phase. */
function refereeOf(side){
  const s = S(); if(!s) return null;
  const players = sidePlayers(side);
  if(players.includes(s.host) && isHere(s.host)) return s.host;
  return players.find(isHere) || players[0] || null;
}
const batonValid = side => !!state.baton && sidePlayers(side).includes(state.baton) && isHere(state.baton);
/* The one phone that runs the rules and sends the battle now. */
function writer(){
  const s = S(); if(!s) return null;
  if(!BATTLE_PHASES.has(state.phase) || state.gameOver) return s.host;
  const side = state.turn;
  if(sideIsAi(side)) return s.host;
  const here = sidePlayers(side).filter(isHere);
  if(!here.length) return sidePlayers(side)[0] || s.host;
  if(here.length === 1) return here[0];
  if(state.phase === 'move') return refereeOf(side);
  return batonValid(side) ? state.baton : refereeOf(side);
}
const amWriter = () => writer() === me;
/* Is the acting army shared between two players present right now? */
const sharedNow = () => inBattle && BATTLE_PHASES.has(state.phase) && !sideIsAi(state.turn) && sidePlayers(state.turn).filter(isHere).length > 1;

/* ---------- the hooks the game asks (online-session.js) ---------- */
let applying = false;            // the referee is carrying out an order: let the game run it
function ownsUnit(u){
  if(applying || !inBattle) return true;
  if(commanderOf(u) !== me) return false;
  if(u.side !== state.turn || state.phase === 'move' || !sharedNow()) return true;
  return state.baton === me;
}
const holdsAutoEnd = () => inBattle && BATTLE_PHASES.has(state.phase) && sideIsShared(state.turn);
function commanderNote(u){
  const c = commanderOf(u);
  if(!c) return sideIsAi(u.side) ? 'the AI' : null;
  return c === me ? 'your Brigade' : `${nameOf(c)}'s Brigade`;
}
function partnerRing(u){
  if(!inBattle) return null;
  const c = commanderOf(u);
  if(!c || c === me || u.side !== mySide()) return null;
  return SEAT_COLOR[seatOf(c)] || null;
}
function isRemote(side, unit){
  const c = unit ? commanderOf(unit) : null;
  return !!c && c !== me;
}

/* =========================================================
   ORDERS (a shared army's Move phase)
========================================================= */
let orderSeq = 0;
const pending = new Map();       // order id -> { unitId, fromX, fromY, x, y, at, order }
const queue = [];                // on the referee: orders waiting their turn
const history = {};              // on the referee: uid -> [{ unitId, before, after, dice }]
let diceCount = 0;               // rolls seen on this phone (an undo cannot reach back past one)
const newId = () => `${(me || 'x').slice(0, 6)}-${++orderSeq}-${Date.now() % 1000000}`;

function interceptOrder(kind, data){
  if(applying || !inBattle) return false;
  if(!sharedNow() || !sidePlayers(state.turn).includes(me)) return false;
  if(state.phase !== 'move'){
    // Fire and Fight: Done is the only order; the baton holder keeps the tally.
    if(kind !== 'done') return false;
    if(state.baton === me) markDone(me);
    else { send({ type: 'order', id: newId(), from: me, kind: 'done', phase: state.phase }); flash('Done: over to your partner'); }
    return true;
  }
  const order = { type: 'order', id: newId(), from: me, kind, ...data };
  const referee = refereeOf(state.turn);
  if(kind === 'move' && referee !== me){
    const u = find(data.unitId);
    if(!u) return true;
    // Shown at once here; the referee's answer confirms it or walks it back.
    pending.set(order.id, { unitId: u.id, fromX: u.x, fromY: u.y, x: data.x, y: data.y, at: Date.now(), order });
    const prof = data.moveKind === 'charge' ? 'charge' : 'march';
    playMovementAudio(u, Math.max(Math.abs(data.x - u.x), Math.abs(data.y - u.y)), prof);
    animateUnitTo(u, data.x, data.y, prof);
    state.moved.add(u.id);
    selectUnit(null);
  }
  if(kind === 'done') flash('Done: waiting for your partner');
  if(referee === me){ queue.push(order); pump(); }
  else send(order);
  updateBanner();
  return true;
}

/* The referee works through its queue one order at a time, and never while
   dice or a question are on screen (an ambush springing mid-move). */
let pumping = null;
function busy(){
  const dice = document.getElementById('diceOverlay');
  return !!(dice && dice.classList.contains('show'));
}
function pump(){
  if(pumping) return;
  const step = () => {
    pumping = null;
    if(!queue.length) return;
    if(busy()){ pumping = setTimeout(step, 150); return; }
    const o = queue.shift();
    try { applyOrder(o); } catch(e){ console.warn('order failed', e); answer(o, false, 'That order could not be carried out'); }
    pumping = setTimeout(step, 30);
  };
  pumping = setTimeout(step, 0);
}

function answer(o, ok, reason){
  sendNow();                       // the battle first, so the answer never arrives ahead of it
  const r = { type: 'result', id: o.id, to: o.from, ok, reason: reason || '', unitId: o.unitId, x: o.x, y: o.y };
  if(o.from === me) onResult(r); else send(r);
}

function applyOrder(o){
  if(state.phase !== 'move' || !sidePlayers(state.turn).includes(o.from)){ answer(o, false, 'The Move phase is over'); return; }
  if(o.kind === 'done'){ markDone(o.from); answer(o, true); return; }
  if(o.kind === 'undo'){ refereeUndo(o); return; }
  const u = find(o.unitId);
  if(!u || u.removed || u.side !== state.turn){ answer(o, false, 'That unit cannot move now'); return; }
  if(commanderOf(u) !== o.from){ answer(o, false, 'That is not your Brigade'); return; }
  unDone(o.from);
  const before = { x: u.x, y: u.y, formation: u.formation, hidden: !!u.hidden, moved: state.moved.has(u.id), charged: !!u.charged, noAction: !!u.noActionThisTurn };
  const prevSel = state.selectedUnitId;
  const dice0 = diceCount;
  let ok = false, reason = '';
  applying = true;
  try {
    selectUnit(u.id);                         // its legal squares, exactly as a tap would show them
    if(o.kind === 'move'){
      const charge = o.moveKind === 'charge';
      if(charge){ const cb = document.getElementById('chargeBtn'); if(cb && cb.onclick) cb.onclick(); }
      const kind = charge ? 'charge' : 'move';
      if(highlightCells.some(c => c.x === o.x && c.y === o.y && c.kind === kind)){ onCellClick(o.x, o.y); ok = true; }
      else reason = state.units.some(x => !x.removed && x.id !== u.id && x.x === o.x && x.y === o.y) ? 'Square taken' : 'That move is no longer possible';
    } else {
      const id = { square: 'squareBtn', ambush: 'ambushBtn', marchOff: 'marchOffBtn' }[o.kind];
      const b = id && document.getElementById(id);
      if(b && !b.disabled && b.style.display !== 'none'){ b.onclick(); ok = true; } else reason = 'Not possible now';
    }
  } finally { applying = false; }
  selectUnit(prevSel && prevSel !== u.id ? prevSel : null);
  if(ok) (history[o.from] = history[o.from] || []).push({ unitId: u.id, before, after: { x: u.x, y: u.y }, dice: dice0 });
  answer(o, ok, reason);
}

/* Undo: only the asker's own last order, and only if nothing has been rolled
   since and the unit still stands where it went. */
function refereeUndo(o){
  const h = history[o.from] || [];
  const last = h[h.length - 1];
  if(!last){ answer(o, false, 'Nothing of yours to take back'); return; }
  const u = find(last.unitId);
  if(!u || u.removed || u.x !== last.after.x || u.y !== last.after.y || diceCount !== last.dice){
    answer(o, false, 'That move cannot be taken back now'); return;
  }
  const b = last.before;
  if((b.x !== u.x || b.y !== u.y) && state.units.some(x => !x.removed && x.id !== u.id && x.x === b.x && x.y === b.y)){
    answer(o, false, 'Its old square is taken'); return;
  }
  h.pop();
  if(b.x !== u.x || b.y !== u.y) animateUnitTo(u, b.x, b.y, 'march');
  u.formation = b.formation; u.hidden = b.hidden; u.charged = b.charged; u.noActionThisTurn = b.noAction;
  if(!b.moved) state.moved.delete(u.id);
  log(`${unitLabel(u)}'s order is taken back.`, u.side);
  unDone(o.from);
  answer(o, true);
  draw();
}

function markDone(uid){
  state.sharedDone = [...new Set([...(state.sharedDone || []), uid])];
  const need = sidePlayers(state.turn).filter(isHere);
  const left = need.filter(p => !state.sharedDone.includes(p));
  if(!left.length){
    state.sharedDone = [];
    const phase = state.phase;
    // The phone that ends the phase carries on: it holds the baton next.
    if(phase === 'move'){ state.baton = me; endMovePhase(); }
    else if(phase === 'fire') endFirePhase();
    else if(phase === 'fight') endFightPhase();
  } else if(state.phase !== 'move' && uid === state.baton){
    state.baton = left[0];
    flash(`${nameOf(left[0])} has the baton`);
  }
  sendNow();
  updateBanner();
}
function unDone(uid){ if(state.sharedDone && state.sharedDone.includes(uid)) state.sharedDone = state.sharedDone.filter(x => x !== uid); }

function handOver(){
  if(state.baton !== me || !sharedNow()) return;
  const to = sidePlayers(state.turn).find(p => p !== me && isHere(p));
  if(!to) return;
  state.baton = to;
  selectUnit(null);
  sendNow();
  flash(`Baton to ${nameOf(to)}`);
  updateBanner();
}

/* The referee's answer to one of this phone's orders. */
function onResult(r){
  if(r.to !== me) return;
  const pd = pending.get(r.id);
  pending.delete(r.id);
  if(r.ok) { updateBanner(); return; }
  if(pd){
    const u = find(pd.unitId);
    if(u && (u.x !== pd.fromX || u.y !== pd.fromY)) animateUnitTo(u, pd.fromX, pd.fromY, 'march');
    if(u) state.moved.delete(u.id);
    bounce(pd.x, pd.y, r.reason || 'Not possible');
  } else if(r.reason) flash(r.reason);
  draw();
}
/* "Square taken": a short note where the move was refused. */
function bounce(x, y, text){
  flash(text);
  const el = markerAt(x, y, `<div style="font:600 13px 'IM Fell English',Georgia,serif;color:#fff;background:rgba(140,40,30,.92);
    padding:3px 8px;border-radius:10px;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.5)">${esc(text)}</div>`, 'shared-bounce');
  if(el) setTimeout(() => el.remove(), 2600);
}

/* =========================================================
   KEEPING IN STEP
========================================================= */
function send(payload){ if(T) T.send(payload); }
/* Before the writer sends: a new phase starts with nobody Done, and in a
   shared Fire or Fight someone present holds the baton. */
function normalise(){
  const key = `${state.turnNumber}|${state.turn}|${state.phase}`;
  if(key !== lastPhaseKey){
    lastPhaseKey = key;
    state.sharedDone = [];
    for(const k of Object.keys(history)) delete history[k];
  }
  if(BATTLE_PHASES.has(state.phase) && state.phase !== 'move' && sideIsShared(state.turn) && !batonValid(state.turn)){
    state.baton = sidePlayers(state.turn).includes(me) ? me : refereeOf(state.turn);
  }
}
function sendNow(){
  if(!T || !S()) return;
  if(amWriter()) normalise();
  const now = pack();
  if(now === lastShared) return;
  lastShared = now; seq += 1;
  send({ type: 'state', seq, battle: now });
  if(Date.now() - lastSave > SAVE_EVERY_MS){
    lastSave = Date.now();
    T.save(match.id, { state: { lobby: match.state && match.state.lobby, battle: now, seq }, seq, turn_army: state.turn || null,
                       status: state.gameOver ? 'finished' : (BATTLE_PHASES.has(state.phase) ? 'active' : 'deploy') });
  }
}
function startSync(){
  if(sendTimer) return;
  sendTimer = setInterval(() => {
    if(!S()) return;
    if(!BATTLE_PHASES.has(state.phase) && !(S().host === me && setupStarted)) return;
    const mine = amWriter();
    // The phone that has just stopped being the writer sends its last change
    // once (the turn or the baton passing on), then stops.
    if(mine || wasWriter) sendNow();
    if(state.gameOver && (mine || wasWriter)) setTimeout(sendRecord, 1500);
    wasWriter = mine;
    if(BATTLE_PHASES.has(state.phase)) enterBattleView();
    watchReferee();
    updateBanner();
  }, SEND_EVERY_MS);
}

/* Orders sent to a referee who has gone: send them again to the new one. */
function watchReferee(){
  if(!inBattle || state.phase !== 'move') { lastReferee = null; return; }
  const r = refereeOf(state.turn);
  if(lastReferee && r !== lastReferee && pending.size){
    for(const p of pending.values()){ if(r === me){ queue.push(p.order); pump(); } else send(p.order); }
  }
  lastReferee = r;
}

let diceBusy = false, deferred = null, diceSafety = null;
function releaseDeferred(){
  diceBusy = false; clearTimeout(diceSafety);
  if(deferred){ const d = deferred; deferred = null; applyIncoming(d.json, d.seq); }
}
function onDice(p){
  if(p.kind === 'trigger') diceCount += 1;
  if(!inBattle && !setupShown) return;
  diceBusy = true;
  clearTimeout(diceSafety);
  diceSafety = setTimeout(releaseDeferred, 8000);
  const a = p.kind === 'trigger' ? { ...p.args, watchSide: state.aiSide } : p.args;
  replayDice(p.kind, a, releaseDeferred);
}

/* This phone's own settings: which side it is not on (for the view and for
   what is hidden from it), and never Spectate. */
function setLocal(){
  state.mode = 'ai';
  state.spectate = false;
  const side = mySide();
  state.aiSide = side ? otherSide(side) : (S() && S().aiSide) || SIDES.BLUE;
}

function applyIncoming(json, incomingSeq){
  if(incomingSeq != null && incomingSeq <= seq && lastShared) return;
  if(diceBusy){ deferred = { json, seq: incomingSeq }; return; }
  const incoming = unpack(json);
  if(!BATTLE_PHASES.has(incoming.phase)){ adoptSetup(incoming, incomingSeq); return; }
  if(!setupShown) enterSetupView();
  const prevLine = state.lastActionLine && state.lastActionLine.n;
  const prevGunfire = state.lastGunfire && state.lastGunfire.n;
  const prevFocus = state.focusUnitId;
  const mineMoving = new Set([...pending.values()].map(p => p.unitId));
  const moved = [];
  if(inBattle){
    for(const nu of incoming.units || []){
      const lu = find(nu.id);
      if(!lu || lu.removed || nu.removed || (lu.x === nu.x && lu.y === nu.y) || mineMoving.has(nu.id)) continue;
      const profile = nu.charged && !lu.charged ? 'charge' : 'march';
      animateUnitTo(lu, nu.x, nu.y, profile);
      playMovementAudio(lu, Math.max(Math.abs(nu.x - lu.x), Math.abs(nu.y - lu.y)), profile);
      moved.push(nu);
    }
  }
  for(const k of Object.keys(incoming)) state[k] = incoming[k];
  setLocal();
  seq = Math.max(seq, incomingSeq || 0);
  lastShared = pack();
  // Our own moves the referee has not answered yet stay where we put them.
  if(state.phase !== 'move') pending.clear();
  for(const [id, p] of pending){
    const u = find(p.unitId);
    if(!u || u.removed){ pending.delete(id); continue; }
    u.x = p.x; u.y = p.y; state.moved.add(u.id);
  }
  enterBattleView();
  const turnKey = `${state.turnNumber}|${state.turn}`;
  if(lastTurnKey !== turnKey){
    if(lastTurnKey !== null) playTurnTheme(state.turn);
    if(state.turn === mySide()) cameraRestorePlayerView(); else cameraParkPlayerView();
    lastTurnKey = turnKey;
    announceTurn();
  }
  if(state.lastGunfire && state.lastGunfire.n !== prevGunfire) replayGunfire(state.lastGunfire);
  // Follow what someone else is doing: the line from attacker to target, the units they moved.
  const line = state.lastActionLine;
  if(line && line.n !== prevLine){
    replayActionLine(line);
    if(state.turn !== mySide()) cameraToAction([{ x: line.fromX, y: line.fromY }, { x: line.toX, y: line.toY }], { durationMs: CAMERA_ACTION_PAN_MS });
  } else if(moved.length && state.turn !== mySide()){
    cameraToUnits(moved, { durationMs: CAMERA_ACTION_PAN_MS });
  } else if(state.focusUnitId && state.focusUnitId !== prevFocus && state.turn !== mySide()){
    const fu = find(state.focusUnitId);
    if(fu && !fu.removed) cameraToUnits([fu], { durationMs: CAMERA_ACTION_PAN_MS });
  }
  refreshUi();
  noteBrigadeBreaks();
  if(state.gameOver && !endShown){ endShown = true; endGame(state.winner); sendRecord(); }
  kickAi();
}

/* Co-op: the AI's turn arrives from a partner's phone (it ended Britain's
   turn); the host's phone, which runs the AI, takes it from here. */
function kickAi(){
  const s = S();
  if(!s || s.host !== me || !sideIsAi(state.turn) || state.phase !== 'move' || state.gameOver) return;
  const key = `${state.turnNumber}|${state.turn}`;
  if(aiKickedFor === key || (state.moved && state.moved.size)) return;
  aiKickedFor = key;
  aiPlanTurn(state.aiSide);
  setTimeout(aiDoMovePhase, 500);
}

function enterBattleView(){
  if(inBattle) return;
  inBattle = true;
  closeLobby();
  if(!Array.isArray(state.matchLog)) state.matchLog = [];
  document.getElementById('overlay').classList.remove('show');
  document.getElementById('sidebar').style.display = 'none';
  const uo = document.getElementById('unitOverlay'); uo.classList.remove('hidden'); uo.classList.remove('show');
  setLocal();
  sizeCanvas();
  lastTurnKey = `${state.turnNumber}|${state.turn}`;
  setTimeout(announceTurn, 0);
}

function refreshUi(){
  const players = sidePlayers(state.turn);
  const mineToEnd = players.includes(me) && !sideIsAi(state.turn);
  for(const id of ['endMoveBtn', 'endFireBtn', 'endFightBtn']){
    const b = document.getElementById(id); if(b) b.disabled = !mineToEnd;
  }
  syncPhaseButtons();
  if(state.selectedUnitId != null){
    const u = find(state.selectedUnitId);
    if(!u || u.removed) selectUnit(null);
  }
  updateHeader();
  draw();
  updateBanner();
}

/* =========================================================
   SETUP: the host builds the battle; each army is chosen on its partner's phone
========================================================= */
function adoptSetup(incoming, incomingSeq){
  if(S() && S().host === me) return;
  for(const k of Object.keys(incoming)) state[k] = incoming[k];
  setLocal();
  seq = Math.max(seq, incomingSeq || 0);
  lastShared = pack();
  if(!setupShown){ enterSetupView(); return; }
  if(state.phase === 'deploy') updateHeader();
  draw();
}
function enterSetupView(){
  setupShown = true;
  closeLobby();
  document.getElementById('overlay').classList.remove('show');
  document.getElementById('sidebar').style.display = 'none';
  setBoardMode('standard');
  setLocal();
  sizeCanvas();
  AudioManager.stopMusic();
  AudioManager.playAmbience('audio/ambience/countryside.mp3');
  playBoardIntroAnimation(() => { startAmbientLayer(); draw(); });
  updateBanner();
}

let pendingDeploy = null, deployRetry = null, pickerOpen = false;
const answeredDeploy = new Set();
/* The host's game wants the other side's army: ask that army's chooser. */
function askChooserToDeploy(side){
  const chooser = S() && S().chooser[side];
  pendingDeploy = side;
  const ask = () => { if(pendingDeploy) send({ type: 'deployRequest', side: pendingDeploy, to: chooser, seq, battle: pack() }); };
  ask(); clearInterval(deployRetry); deployRetry = setInterval(ask, 3000);
  flash(`${nameOf(chooser)} is choosing ${SIDE_LABEL[side]}'s army`, 6000);
}
function onDeployRequest(p){
  if(p.to !== me || pickerOpen || answeredDeploy.has(p.side)) return;
  adoptSetup(unpack(p.battle), p.seq);
  pickerOpen = true;
  showArmyPickerFor(p.side, army => {
    pickerOpen = false; answeredDeploy.add(p.side);
    document.getElementById('sidebar').style.display = 'none';
    document.getElementById('rosterPanel').style.display = 'none';
    send({ type: 'armyChosen', side: p.side, armyId: army.id, armyName: army.name });
    flash(`${army.name} chosen`, 4000);
  });
}
function onArmyChosen(p){
  if(!pendingDeploy || p.side !== pendingDeploy) return;
  pendingDeploy = null; clearInterval(deployRetry);
  deployArmyComposition(p.side, p.armyId);
  log(`${SIDE_LABEL[p.side]} deploys as ${p.armyName}.`, 'system');
  maybeShowArmyPicker();
}

async function hostBegin(){
  const fresh = await T.load(match.id); if(fresh) match = fresh;
  const L = match.state.lobby;
  const mode = MODES[L.mode];
  const seats = {};
  for(const k of mode.seats) seats[k] = match.seats[k] || null;
  const deal = dealBrigades(seats, L.deal);
  const commanders = {};
  for(const [key, seat] of Object.entries(deal)) if(seat && seats[seat]) commanders[key] = seats[seat];
  const chooser = {};
  for(const side of [SIDES.RED, SIDES.BLUE]){
    const ps = SIDE_SEATS[side].map(k => seats[k]).filter(Boolean);
    chooser[side] = ps.includes(me) ? me : (ps[0] || null);
  }
  const names = {};
  for(const u of Object.values(seats)) if(u) names[u] = (match.names || {})[u] || 'A player';
  state.shared = { mode: L.mode, host: me, seats, names, commanders, chooser, aiSide: mode.aiSide };
  await T.save(match.id, { status: 'deploy' });
  send({ type: 'begin', shared: state.shared });
  closeLobby();
  state.scenario = null; state.campaign = null;
  setLocal();
  state.aiDifficulty = L.ai || 'hard';
  const { beginBoardSetup } = await import('./ui-menus.js');
  beginBoardSetup();
  state.shared = state.shared || { mode: L.mode, host: me, seats, names, commanders, chooser, aiSide: mode.aiSide };
  // The match record notes who commanded each Brigade.
  logReplay('commanders', { mode: L.mode, commanders: Object.fromEntries(Object.entries(commanders).map(([k, u]) => [k, names[u]])) });
  setupStarted = true;
  setupShown = true;
  lastShared = pack(); seq += 1;
  send({ type: 'state', seq, battle: lastShared });
  updateBanner();
}

/* =========================================================
   QUESTIONS for the commander of a unit
========================================================= */
const pendingAsks = new Map();
function askUnit(kind, data, fallback, timeoutMs){
  const u = data && find(data.unitId || data.loserId || data.ambId);
  const to = u ? commanderOf(u) : null;
  if(!to || to === me) return Promise.resolve(fallback);
  return new Promise(resolve => {
    const id = Math.random().toString(36).slice(2);
    const done = v => { clearTimeout(timer); pendingAsks.delete(id); resolve(v); };
    const timer = setTimeout(() => done(fallback), timeoutMs);
    pendingAsks.set(id, done);
    send({ type: 'ask', id, to, kind, data });
    flash(`${nameOf(to)} is deciding`, Math.min(timeoutMs, 8000));
  });
}
function onAsk(p){
  if(p.to !== me) return;
  const reply = value => send({ type: 'answer', id: p.id, value });
  if(p.kind === 'reroll') showDiceRerollButton(p.data.label, () => reply(true), () => reply(false));
  else if(p.kind === 'leadership'){
    const loser = find(p.data.loserId), brig = find(p.data.brigId);
    if(loser && brig) showLeadershipRollPrompt(loser, brig, reply, { answerMs: ANSWER_WINDOW_MS });
  } else if(p.kind === 'ambush'){
    const amb = find(p.data.ambId), target = find(p.data.targetId);
    if(amb && target) showAmbushChoice(amb, target, reply, { answerMs: ANSWER_WINDOW_MS });
  }
}

/* =========================================================
   MESSAGES AND PRESENCE
========================================================= */
function onMessage(p){
  if(p.type === 'lobby') refreshLobby();
  else if(p.type === 'begin'){ if(!S()) state.shared = p.shared; closeLobby(); flash('The battle is being set up'); }
  else if(p.type === 'state') applyIncoming(p.battle, p.seq);
  else if(p.type === 'dice') onDice(p);
  else if(p.type === 'order'){ if(amWriter()) { if(p.kind === 'done' && state.phase !== 'move') markDone(p.from); else { queue.push(p); pump(); } } }
  else if(p.type === 'result') onResult(p);
  else if(p.type === 'ask') onAsk(p);
  else if(p.type === 'answer'){ const f = pendingAsks.get(p.id); if(f) f(p.value); }
  else if(p.type === 'deployRequest') onDeployRequest(p);
  else if(p.type === 'armyChosen'){ if(S() && S().host === me) onArmyChosen(p); }
  else if(p.type === 'ping') onPing(p);
  else if(p.type === 'record') onRecord(p);
  else if(p.type === 'hello'){
    if(!S()){ refreshLobby(); return; }
    // Someone connected or came back: whoever is running things hands them the game as it stands.
    if(!amWriter()) return;
    if(!BATTLE_PHASES.has(state.phase)) send({ type: 'begin', shared: S() });
    if(pendingDeploy) send({ type: 'deployRequest', side: pendingDeploy, to: S().chooser[pendingDeploy], seq, battle: pack() });
    lastShared = pack(); send({ type: 'state', seq, battle: lastShared });
  }
}

function onPresence(list){
  const before = new Set(present);
  present = new Set(list.filter(Boolean).map(p => p.uid));
  presenceKnown = true;
  if(!S()){ if(lobbyEl) waitingRoom(); return; }
  for(const u of Object.values(S().seats)){
    if(!u || u === me) continue;
    if(before.has(u) && !present.has(u)) flash(`${nameOf(u)} has lost connection: their Brigades pass to their partner`, 4000);
    else if(!before.has(u) && present.has(u) && before.size) flash(`${nameOf(u)} is back`);
  }
  updateBanner();
}

/* =========================================================
   THE BANNER, NOTES AND PINGS
========================================================= */
let pillTimer = null;
function flash(text, ms = 3000){
  let pill = document.getElementById('onlinePill');
  if(!pill){
    pill = document.createElement('div'); pill.id = 'onlinePill';
    pill.style.cssText = 'position:fixed;top:calc(env(safe-area-inset-top,0px) + 44px);left:50%;transform:translateX(-50%);z-index:29;' +
      'font:14px "IM Fell English",Georgia,serif;color:#fbf6ea;background:rgba(20,24,20,.82);padding:4px 12px;border-radius:14px;' +
      'pointer-events:none;white-space:nowrap;opacity:0;transition:opacity .4s';
    document.body.appendChild(pill);
  }
  pill.textContent = text;
  pill.style.opacity = '1';
  clearTimeout(pillTimer);
  pillTimer = setTimeout(() => { pill.style.opacity = '0'; }, ms);
}
function announceTurn(){
  if(!S() || !BATTLE_PHASES.has(state.phase)) return;
  const side = state.turn;
  if(sideIsAi(side)) flash(`${SIDE_LABEL[side]}: the AI's turn`);
  else if(sidePlayers(side).includes(me)) flash(sideIsShared(side) ? 'Your army: move together, then Done' : 'Your turn');
  else flash(`${SIDE_LABEL[side]}: ${sidePlayers(side).map(nameOf).join(' and ')}`);
}
function brigadesOf(uid, side){
  const c = S() ? S().commanders : {};
  return [0, 1, 2].filter(i => c[`${side}:${i}`] === uid).map(i => BRIGADE_NAME[i]);
}
/* Who is acting and who commands what, along the top of the board. */
let bannerEl = null, bannerHtml = '';
function updateBanner(){
  if(!S() || !inBattle){ if(bannerEl) bannerEl.style.display = 'none'; return; }
  if(!bannerEl){
    bannerEl = document.createElement('div'); bannerEl.id = 'sharedBanner';
    bannerEl.style.cssText = 'position:fixed;top:calc(env(safe-area-inset-top,0px) + 6px);left:50%;transform:translateX(-50%);z-index:28;' +
      'display:flex;align-items:center;gap:8px;max-width:calc(100vw - 150px);font:13px "IM Fell English",Georgia,serif;color:#fbf6ea;' +
      'background:rgba(20,24,20,.78);padding:3px 10px;border-radius:14px;white-space:nowrap;overflow:hidden;';
    bannerEl.addEventListener('click', e => { if(e.target.closest('[data-handover]')) handOver(); });
    document.body.appendChild(bannerEl);
  }
  bannerEl.style.display = 'flex';
  const side = state.turn;
  const phase = { move: 'Move', fire: 'Fire', fight: 'Fight' }[state.phase] || '';
  let html;
  if(sideIsAi(side)) html = `<b>${esc(SIDE_LABEL[side])}</b> · ${phase} · the AI`;
  else {
    const chips = sidePlayers(side).map(uid => {
      const seat = seatOf(uid), here = isHere(uid);
      const done = (state.sharedDone || []).includes(uid);
      const baton = state.phase !== 'move' && sharedNow() && state.baton === uid;
      const br = brigadesOf(uid, side);
      return `<span style="display:inline-flex;align-items:center;gap:4px;opacity:${here ? 1 : .55}">` +
        `<span style="width:9px;height:9px;border-radius:50%;background:${SEAT_COLOR[seat]}"></span>` +
        `${baton ? '⚑ ' : ''}${esc(nameOf(uid))}${br.length ? ` <span style="opacity:.75">(${br.join(', ')})</span>` : ''}${done ? ' ✓' : ''}${here ? '' : ' · away'}</span>`;
    }).join('<span style="opacity:.5">|</span>');
    html = `<b>${esc(SIDE_LABEL[side])}</b> · ${phase} · ${chips}`;
    if(state.phase !== 'move' && sharedNow() && state.baton === me && sidePlayers(side).some(p => p !== me && isHere(p))){
      html += ` <button data-handover style="font:inherit;font-size:12px;padding:2px 8px;border:1px solid #c8a85a;border-radius:10px;background:#3a2c14;color:#f3e6c3;cursor:pointer;pointer-events:auto">Hand over</button>`;
    }
  }
  if(html !== bannerHtml){ bannerHtml = html; bannerEl.innerHTML = html; }
}

/* A square on the board, as a point on the page. */
function pagePoint(x, y){
  const r = canvas.getBoundingClientRect();
  const s = toScreen(x, y), cw = r.width / COLS, ch = r.height / ROWS;
  return { x: r.left + (s.x + 0.5) * cw, y: r.top + (s.y + 0.5) * ch, cell: cw };
}
function markerAt(x, y, inner, cls){
  const p = pagePoint(x, y);
  const el = document.createElement('div');
  el.className = cls;
  el.style.cssText = `position:fixed;left:${p.x}px;top:${p.y}px;transform:translate(-50%,-50%);z-index:27;pointer-events:none;`;
  el.innerHTML = inner;
  document.body.appendChild(el);
  return el;
}
/* PINGS: a long press on the board drops a marker every teammate sees for a
   few seconds, with a soft sound. */
function showPing(x, y, uid){
  const color = SEAT_COLOR[seatOf(uid)] || '#f0d27a';
  const p = pagePoint(x, y);
  const size = Math.max(28, p.cell * 0.9);
  const el = markerAt(x, y, `<div style="position:relative;width:${size}px;height:${size}px">
      <div style="position:absolute;inset:0;border:3px solid ${color};border-radius:50%;animation:fcPing 1s ease-out infinite"></div>
      <div style="position:absolute;inset:30%;background:${color};border-radius:50%;box-shadow:0 0 8px ${color}"></div>
      <div style="position:absolute;top:100%;left:50%;transform:translateX(-50%);margin-top:2px;font:600 12px 'IM Fell English',Georgia,serif;
        color:#fff;text-shadow:0 1px 3px #000;white-space:nowrap">${esc(nameOf(uid))}</div></div>`, 'shared-ping');
  if(!document.getElementById('fcPingStyle')){
    const st = document.createElement('style'); st.id = 'fcPingStyle';
    st.textContent = '@keyframes fcPing{0%{transform:scale(.6);opacity:1}100%{transform:scale(1.7);opacity:0}}';
    document.head.appendChild(st);
  }
  try { AudioManager.playEffect('ping', 'audio/ui/switch12.wav', 'ui'); } catch { /* no sound */ }
  setTimeout(() => el.remove(), 4000);
}
function onPing(p){ if(p.side && p.side === mySide()) showPing(p.x, p.y, p.from); }
let pingSwallow = false;
function wirePings(){
  let timer = null, start = null;
  const cancel = () => { clearTimeout(timer); timer = null; };
  canvas.addEventListener('pointerdown', e => {
    if(!inBattle || !mySide() || !e.isPrimary) return;
    start = { x: e.clientX, y: e.clientY };
    cancel();
    timer = setTimeout(() => {
      timer = null;
      const hit = cellFromClient(start.x, start.y);
      if(!hit) return;
      const b = fromScreen(hit.x, hit.screenY);
      pingSwallow = true;                                   // the tap that ends this press is not an order
      showPing(b.x, b.y, me);
      send({ type: 'ping', x: b.x, y: b.y, from: me, side: mySide() });
    }, 550);
  });
  canvas.addEventListener('pointermove', e => { if(timer && start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel(); });
  for(const ev of ['pointerup', 'pointercancel', 'pointerleave']) canvas.addEventListener(ev, cancel);
  canvas.addEventListener('click', e => { if(pingSwallow){ pingSwallow = false; e.stopImmediatePropagation(); e.preventDefault(); } }, true);
}
/* For the tests and the screenshots: a ping without a finger. */
export function pingAt(x, y){ if(!mySide()) return; showPing(x, y, me); send({ type: 'ping', x, y, from: me, side: mySide() }); }

/* =========================================================
   THE MATCH RECORD: each phone recorded what it ran; at the end each sends
   its part and every phone merges them in the order of play.
========================================================= */
const RECORD_PIECE = 60000;
let recordSent = false;
const recordPieces = {}, recordMerged = new Set();
function sendRecord(){
  if(recordSent || !T) return;
  recordSent = true;
  const body = JSON.stringify({ from: me, log: state.matchLog || [], start: state.replayStartUnits || null });
  const id = Math.random().toString(36).slice(2);
  const n = Math.max(1, Math.ceil(body.length / RECORD_PIECE));
  for(let i = 0; i < n; i++) setTimeout(() => send({ type: 'record', id, i, n, part: body.slice(i * RECORD_PIECE, (i + 1) * RECORD_PIECE) }), i * 150);
}
export function mergeShared(mine, theirs){
  const all = mine.map((e, i) => ({ e, i, src: 0 })).concat(theirs.map((e, i) => ({ e, i, src: 1 })));
  const seen = new Set();
  const out = [];
  all.sort((a, b) => (a.e.turn || 0) - (b.e.turn || 0) || (PHASE_ORDER[a.e.phase] || 0) - (PHASE_ORDER[b.e.phase] || 0)
    || (a.e.at || 0) - (b.e.at || 0) || a.src - b.src || a.i - b.i);
  for(const x of all){ const k = JSON.stringify(x.e); if(seen.has(k)) continue; seen.add(k); out.push(x.e); }
  return out;
}
function onRecord(p){
  const parts = recordPieces[p.id] = recordPieces[p.id] || [];
  parts[p.i] = p.part;
  if(parts.filter(x => x != null).length < p.n) return;
  delete recordPieces[p.id];
  let rec; try { rec = JSON.parse(parts.join('')); } catch { return; }
  if(recordMerged.has(rec.from)) return;
  recordMerged.add(rec.from);
  state.matchLog = mergeShared(state.matchLog || [], rec.log || []);
  if(!state.replayStartUnits && rec.start) state.replayStartUnits = rec.start;
  renderEndButtons();
  recOnlineMerged(recordMerged.size, Math.max(1, Object.values((S() || {}).seats || {}).filter(Boolean).length - 1));
  sendRecord();
}

/* =========================================================
   THE LOBBY
========================================================= */
let lobbyEl = null;
function closeLobby(){ if(lobbyEl){ lobbyEl.remove(); lobbyEl = null; } }
function shell(inner){
  if(lobbyEl && lobbyEl.dataset.inner === inner) return lobbyEl;
  if(!lobbyEl){
    lobbyEl = document.createElement('div'); lobbyEl.id = 'sharedLobby';
    lobbyEl.style.cssText = 'position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:rgba(15,18,15,.7);padding:10px';
    document.body.appendChild(lobbyEl);
  }
  lobbyEl.dataset.inner = inner;
  lobbyEl.innerHTML = `<div style="max-width:560px;width:100%;max-height:100%;overflow:auto;background:#e8e0cb;color:#2a1e14;border-radius:6px;padding:14px 16px;
    box-shadow:0 14px 34px rgba(0,0,0,.5);font:15px 'IM Fell English',Georgia,serif">${inner}</div>`;
  lobbyEl.dataset.fresh = '1';
  return lobbyEl;
}
const btn = (label, attrs = '', bg = '#2a1e14', fg = '#fbf6ea') =>
  `<button ${attrs} style="font:inherit;min-height:40px;padding:6px 12px;border:0;border-radius:4px;cursor:pointer;background:${bg};color:${fg}">${label}</button>`;
function friendly(e){
  const m = (e && e.message) || String(e);
  if(/version mismatch/i.test(m)) return 'You are on different versions of the game. Everyone reload the page, then try again.';
  if(/no match/i.test(m)) return 'No game with that code. Check the letters and try again.';
  if(/full/i.test(m)) return 'That game already has four players.';
  if(/already started/i.test(m)) return 'That battle has already started.';
  if(/taken/i.test(m)) return 'Someone has just taken that seat.';
  return m;
}
async function transport(){
  if(T) return T;
  T = new URLSearchParams(location.search).get('onlineTransport') === 'local' ? localTransport() : await supabaseTransport();
  return T;
}

export function openSharedLobby({ joinCode } = {}){
  const name = localStorage.getItem('fc-name') || '';
  const el = shell(`
    <div style="font-family:'Petit Formal Script',cursive;font-size:26px;margin-bottom:4px">Shared armies</div>
    <p style="margin:0 0 8px;font-size:14px">Two players command one army together, each with their own Brigades: Co-op against the AI, 2 against 1, or 2 against 2.</p>
    <label style="display:block;margin:4px 0">Your name</label>
    <input id="osName" value="${esc(name)}" maxlength="40" style="font:inherit;width:100%;padding:8px;border:1px solid #9a8b6c;border-radius:4px">
    <div style="margin-top:10px">${btn('New shared game', 'id="osNew"', '#5b6b3a')}</div>
    <label style="display:block;margin:12px 0 4px">Or join with a code</label>
    <div style="display:flex;gap:8px"><input id="osCode" maxlength="6" value="${esc(joinCode || '')}"
      style="font:inherit;flex:1;min-width:8ch;padding:8px;border:1px solid #9a8b6c;border-radius:4px;text-transform:uppercase">${btn('Join', 'id="osJoin"')}</div>
    <p id="osStatus" style="min-height:1.4em;margin:10px 0 0;font-style:italic"></p>
    <div style="text-align:right">${btn('Close', 'id="osClose"', 'transparent', '#2a1e14')}</div>`);
  const status = (t, bad) => { const p = el.querySelector('#osStatus'); p.textContent = t; p.style.color = bad ? '#9b1c1c' : '#2a1e14'; };
  const getName = () => {
    const n = el.querySelector('#osName').value.trim();
    if(!n){ status('Put your name in first.', true); return null; }
    localStorage.setItem('fc-name', n); return n;
  };
  el.querySelector('#osClose').onclick = () => { closeLobby(); history.replaceState(null, '', location.pathname); };
  el.querySelector('#osNew').onclick = async () => {
    const n = getName(); if(!n) return;
    try {
      status('Connecting...');
      const t = await transport(); me = await t.signIn();
      const m = await t.create(n);
      m.state = { lobby: { kind: 'shared', mode: 'coop', deal: {}, ai: 'hard' } };
      await t.save(m.id, { state: m.state });
      await start(m, n);
    } catch(e){ status(friendly(e), true); }
  };
  const doJoin = async () => {
    const n = getName(); if(!n) return;
    try {
      status('Joining...');
      const t = await transport(); me = await t.signIn();
      const m = await t.join(el.querySelector('#osCode').value, n);
      const full = (await t.load(m.id)) || m;
      if(!(full.state && full.state.lobby && full.state.lobby.kind === 'shared')){ status('That code is for a different kind of game.', true); return; }
      await start(full, n);
    } catch(e){ status(friendly(e), true); }
  };
  el.querySelector('#osJoin').onclick = doJoin;
  if(joinCode && name) doJoin();
}

async function start(m, name){
  match = m;
  localStorage.setItem('fc-last-shared', m.code);
  const local = location.search.includes('onlineTransport=local');
  history.replaceState(null, '', `${location.pathname}?shared=${m.code}&sharedArmies=1${local ? '&onlineTransport=local' : ''}`);
  setOnlineSession({
    shared: true, group: false, matchId: m.id, code: m.code, isHost: m.created_by === me,
    isRemote, ownsUnit, interceptOrder, holdsAutoEnd, commanderNote, partnerRing,
    runsAi: side => !!S() && S().host === me && sideIsAi(side),
  });
  await T.open(m.id, { onMessage, onPresence, onStatus: st => { if(st === 'SUBSCRIBED') send({ type: 'hello' }); } }, { uid: me, name });
  setRemoteAsker(askUnit);
  setRemoteDeployHandler(askChooserToDeploy);
  setDiceMirror((kind, args) => {
    if(kind === 'trigger') diceCount += 1;
    if(amWriter() || wasWriter) send({ type: 'dice', kind, args });
  });
  wirePings();
  startSync();
  // Coming back to a battle already under way: pick up the saved copy.
  const saved = await T.load(m.id);
  if(saved) match = saved;
  if(saved && saved.state && saved.state.battle){
    const b = unpack(saved.state.battle);
    if(b.shared) state.shared = b.shared;
    applyIncoming(saved.state.battle, saved.state.seq || 0);
  } else waitingRoom();
}
async function refreshLobby(){
  if(S() || !T || !match) return;
  const m = await T.load(match.id);
  if(m){ match = m; waitingRoom(); }
}
async function saveLobby(change){
  const L = { ...match.state.lobby, ...change };
  match.state = { ...match.state, lobby: L };
  await T.save(match.id, { state: match.state });
  send({ type: 'lobby' });
  waitingRoom();
}

/* Seats, the mode, the Brigades each partner commands, the AI's level. */
function waitingRoom(){
  if(S() || !match || !match.state || !match.state.lobby) return;
  const L = match.state.lobby, mode = MODES[L.mode] || MODES.coop;
  const host = match.created_by === me;
  const seats = match.seats || {};
  const allowed = new Set(mode.seats);
  const online = u => present.has(u) || u === me;
  const seatBtn = k => {
    const who = seats[k], mine = who === me, open = allowed.has(k);
    const label = !open ? (mode.aiSide === SEAT_SIDE[k] ? 'The AI' : 'Not in this mode') : who ? (mine ? 'You' : esc((match.names || {})[who] || 'A player')) : 'Empty: tap to sit';
    return `<button data-seat="${k}" ${open ? '' : 'disabled'} style="font:inherit;text-align:left;min-height:50px;padding:5px 9px;border-radius:5px;cursor:${open ? 'pointer' : 'default'};
      border:${mine ? '3px solid #b8963f' : '1px solid #9a8b6c'};background:${SEAT_SIDE[k] === 'red' ? '#a3403a' : '#2e4566'};color:#fbf6ea;opacity:${open ? 1 : .45}">
      <div style="font-size:13px;opacity:.9"><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${SEAT_COLOR[k]};margin-right:4px"></span>${SEAT_LABEL[k]}</div>
      <div style="font-size:16px">${label}</div></button>`;
  };
  const seated = {};
  for(const k of mode.seats) seated[k] = seats[k] || null;
  const deal = dealBrigades(seated, L.deal);
  const dealRow = side => {
    const [a, b] = SIDE_SEATS[side];
    if(!(seated[a] && seated[b])) return '';
    const who = seat => seat ? esc(seated[seat] === me ? 'You' : ((match.names || {})[seated[seat]] || 'A player')) : '?';
    return `<div style="margin:6px 0 0;font-size:14px"><b>${SIDE_LABEL[side]}</b>: ${[0, 1, 2].map(i => {
      const seat = deal[`${side}:${i}`];
      return `<button data-swap="${side}:${i}" ${host ? '' : 'disabled'} style="font:inherit;font-size:13px;margin:2px 3px;padding:3px 8px;border-radius:12px;
        border:2px solid ${SEAT_COLOR[seat] || '#999'};background:#f6efd9;color:#2a1e14;cursor:${host ? 'pointer' : 'default'}">${BRIGADE_NAME[i]} Brigade: ${who(seat)}</button>`;
    }).join('')}</div>`;
  };
  const redOk = mode.seats.filter(k => SEAT_SIDE[k] === 'red').some(k => seats[k]);
  const blueOk = mode.aiSide === SIDES.BLUE || mode.seats.filter(k => SEAT_SIDE[k] === 'blue').some(k => seats[k]);
  const hostSeated = mode.seats.some(k => seats[k] === me) || !host;
  const canStart = redOk && blueOk && hostSeated;
  const el = shell(`
    <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
      <div style="font-family:'Petit Formal Script',cursive;font-size:24px">Game ${esc(match.code)}</div>
      <div style="font-size:13px">${(match.members || []).map(u => `<span style="white-space:nowrap;margin-left:8px"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:3px;background:${online(u) ? '#5fae6a' : '#999'}"></span>${esc(u === me ? 'You' : (match.names || {})[u] || 'A player')}</span>`).join('')}</div>
    </div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin:6px 0">${Object.entries(MODES).map(([k, md]) =>
      `<button data-mode="${k}" ${host ? '' : 'disabled'} style="font:inherit;font-size:14px;padding:5px 10px;border-radius:14px;cursor:${host ? 'pointer' : 'default'};
        border:2px solid ${k === L.mode ? '#5b6b3a' : '#b9ab8c'};background:${k === L.mode ? '#5b6b3a' : '#f6efd9'};color:${k === L.mode ? '#fbf6ea' : '#2a1e14'}">${md.label}</button>`).join('')}</div>
    <p style="margin:0 0 6px;font-size:13px;font-style:italic">${mode.note} Tap a seat to sit; tap it again to stand up.</p>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">${['red1', 'blue1', 'red2', 'blue2'].map(seatBtn).join('')}</div>
    ${dealRow(SIDES.RED)}${mode.aiSide ? '' : dealRow(SIDES.BLUE)}
    ${host && (seated.red1 && seated.red2 || seated.blue1 && seated.blue2) ? '<p style="margin:2px 0 0;font-size:12px">Tap a Brigade to give it to the other partner.</p>' : ''}
    ${mode.aiSide ? `<div style="margin:8px 0 0;font-size:14px">The AI: ${AI_LEVELS.map(([v, lab]) =>
      `<button data-ai="${v}" ${host ? '' : 'disabled'} style="font:inherit;font-size:13px;margin:0 3px;padding:3px 9px;border-radius:12px;border:2px solid ${L.ai === v ? '#5b6b3a' : '#b9ab8c'};
        background:${L.ai === v ? '#5b6b3a' : '#f6efd9'};color:${L.ai === v ? '#fbf6ea' : '#2a1e14'};cursor:${host ? 'pointer' : 'default'}">${lab}</button>`).join('')}</div>` : ''}
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
      ${btn('Send invite link', 'id="osShare"')}
      ${host ? btn('Start the battle', `id="osStart" ${canStart ? '' : 'disabled'}`, canStart ? '#5b6b3a' : '#9a9a8a') : ''}
    </div>
    <p id="osWho" style="min-height:1.2em;margin:6px 0 0;font-size:13px;font-style:italic">${host
      ? (canStart ? 'Each army is chosen on its 1st commander\'s phone (yours, if you are on it).' : !hostSeated ? 'Take a seat to start.' : 'Each side needs a commander before you can start.')
      : 'The host chooses the mode and starts the battle.'}</p>`);
  if(el.dataset.fresh !== '1') return;
  el.dataset.fresh = '';
  el.querySelectorAll('[data-seat]').forEach(b => b.onclick = async () => {
    const k = b.dataset.seat;
    try { match = await T.seat(match.id, seats[k] === me ? null : k); send({ type: 'lobby' }); waitingRoom(); }
    catch(e){ el.querySelector('#osWho').textContent = friendly(e); refreshLobby(); }
  });
  if(host){
    el.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => saveLobby({ mode: b.dataset.mode }));
    el.querySelectorAll('[data-ai]').forEach(b => b.onclick = () => saveLobby({ ai: b.dataset.ai }));
    el.querySelectorAll('[data-swap]').forEach(b => b.onclick = () => {
      const key = b.dataset.swap, side = key.split(':')[0], [a, c] = SIDE_SEATS[side];
      const nd = { ...deal, [key]: deal[key] === a ? c : a };
      // Each partner keeps at least one Brigade.
      const count = s => [0, 1, 2].filter(i => nd[`${side}:${i}`] === s).length;
      if(!count(a) || !count(c)) return;
      saveLobby({ deal: nd });
    });
    const st = el.querySelector('#osStart');
    if(st) st.onclick = () => { if(canStart) hostBegin(); };
  }
  el.querySelector('#osShare').onclick = async () => {
    const url = `${location.origin}${location.pathname}?shared=${match.code}&sharedArmies=1`;
    const text = `Join my Field Command battle (shared armies). Code: ${match.code}`;
    if(navigator.share){ try { await navigator.share({ title: 'Field Command', text, url }); return; } catch { /* dismissed */ } }
    try { await navigator.clipboard.writeText(`${text} ${url}`); el.querySelector('#osWho').textContent = 'Invite copied.'; } catch { /* no clipboard */ }
  };
}

/* For the tests: this phone's view of who does what. */
export const _sharedDebug = () => ({ me, writer: writer(), referee: inBattle ? refereeOf(state.turn) : null, baton: state.baton || null,
  done: state.sharedDone || [], pending: pending.size, queue: queue.length, dice: diceCount, present: [...present], mySide: mySide() });
export { handOver, markDone };
