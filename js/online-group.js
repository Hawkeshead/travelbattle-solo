/* =========================================================
   ONLINE GROUP: 2v2 with a phone each.

   Up to four players join with a code and sit down at an army in the lobby:
   Britain I (south), Britain II (east), France I (north), France II (west).
   Seats can be swapped freely until the host starts. An army with nobody in
   its seat is commanded by its teammate, so three players works (and two,
   one a side). A member without a seat watches.

   HOW THE PHONES STAY IN STEP is the 1v1 scheme (js/online.js) with more
   listeners: the phone commanding the acting army runs the rules and sends
   the whole battle whenever it changes; every other phone animates what
   moved, follows the action with its camera, and adopts it. Only the phone
   that commands the acting army ever sends during the battle, so two phones
   can never send over each other. During setup the host alone runs things:
   it builds the map and, army by army, asks each army's commander to choose
   an army on their own phone, then places it.

   Each phone keeps its own view (its own army's edge at the bottom), its own
   record of the turns it ran, and its own presentation state; see LOCAL_ONLY.
========================================================= */
import { recOnlineMerged } from './telemetry/recorder.js';
import { state, setBoardMode } from './data-core.js';
import { setOnlineSession, setRemoteAsker } from './online-session.js';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './online-config.js';
import { ONLINE_VERSION } from './online.js';
import { animateUnitTo, CAMERA_ACTION_PAN_MS, cameraParkPlayerView, cameraRestorePlayerView, cameraToAction, cameraToUnits,
         draw, playBoardIntroAnimation, replayActionLine, replayGunfire, sizeCanvas } from './render-board.js';
import { ANSWER_WINDOW_MS } from './prompt-panel.js';
import { playMovementAudio, seededRandom, showLeadershipRollPrompt } from './engine-rules.js';
import { noteBrigadeBreaks, playTurnTheme, selectUnit, showAmbushChoice, startBattle, updateHeader } from './ui-battle.js';
import { log, syncPhaseButtons } from './engine-state.js';
import { endGame, renderEndButtons } from './engine-objectives.js';
import { deployGroupArmy } from './ai-deployment.js';
import { showGroupArmyPicker, startAmbientLayer } from './ui-menus.js';
import { replayDice, setDiceMirror, showDiceRerollButton } from './dice.js';
import { AudioManager } from './audio-manager.js';
import { GROUP_ARMIES, armyById, refreshGroupControl, rollTurnOrder } from './group.js';
import { prepareGroupBoard } from './ui-group.js';

const SEND_EVERY_MS = 250, SAVE_EVERY_MS = 3000;
const BATTLE_PHASES = new Set(['move', 'fire', 'fight']);
const LOCAL_ONLY = new Set(['mode', 'aiSide', 'spectate', 'selectedUnitId', 'aiDifficulty', 'viewEdge',
  'groupControlled', 'brokenSeen', '_dispatchUntil', '_endDeferred', 'replaying']);
const skipKey = k => k === 'matchLog' || k === 'replayStartUnits' || k.startsWith('_ai') || LOCAL_ONLY.has(k);
const pack = () => JSON.stringify(state, (k, v) => (k && skipKey(k)) ? undefined : (v instanceof Set ? { __isSet: true, items: [...v] } : v));
const unpack = s => JSON.parse(s, (k, v) => (v && v.__isSet) ? new Set(v.items) : v);
const SEAT_LABEL = { red1:'Britain I \u00b7 south', red2:'Britain II \u00b7 east', blue1:'France I \u00b7 north', blue2:'France II \u00b7 west' };
const TEAMMATE = { red1:'red2', red2:'red1', blue1:'blue2', blue2:'blue1' };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));

/* ---------------------------------------------------------
   Transport: Supabase for real play; ?onlineTransport=local runs several
   tabs of one browser as separate players, for testing without the network.
--------------------------------------------------------- */
async function supabaseTransport(){
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm');
  const sb = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
  let me = null, channel = null;
  const rpc = async (fn, args) => { const { data, error } = await sb.rpc(fn, args); if(error) throw error; return data; };
  return {
    async signIn(){
      const { data: { session } } = await sb.auth.getSession();
      if(session){ me = session.user.id; return me; }
      const { data, error } = await sb.auth.signInAnonymously();
      if(error) throw new Error(error.message);
      me = data.user.id; return me;
    },
    create: name => rpc('create_group_match', { p_name: name, p_version: ONLINE_VERSION }),
    join: (code, name) => rpc('join_group_match', { p_code: code, p_name: name, p_version: ONLINE_VERSION }),
    seat: (matchId, seat) => rpc('take_group_seat', { p_match: matchId, p_seat: seat }),
    async save(matchId, fields){ await sb.from('group_matches').update(fields).eq('id', matchId); },
    async load(matchId){ const { data } = await sb.from('group_matches').select('*').eq('id', matchId).single(); return data; },
    async open(matchId, { onMessage, onPresence, onStatus }, presence){
      await sb.realtime.setAuth();
      channel = sb.channel(`group:${matchId}`, { config: { private: true, broadcast: { self: false }, presence: { key: me } } });
      channel
        .on('broadcast', { event: 'm' }, ({ payload }) => onMessage(payload))
        .on('presence', { event: 'sync' }, () => onPresence(Object.values(channel.presenceState()).flat()))
        .subscribe(async st => { onStatus(st); if(st === 'SUBSCRIBED') await channel.track(presence); });
    },
    send(payload){ if(channel) channel.send({ type: 'broadcast', event: 'm', payload }); },
  };
}

function localTransport(){
  const tabId = sessionStorage.getItem('fc-tab') || (sessionStorage.setItem('fc-tab', crypto.randomUUID()), sessionStorage.getItem('fc-tab'));
  const read = () => JSON.parse(localStorage.getItem('fc-local-groups') || '{}');
  const write = m => localStorage.setItem('fc-local-groups', JSON.stringify(m));
  let bc = null; const seen = {}; let presenceMe = null;
  return {
    async signIn(){ return tabId; },
    async create(name){
      const all = read(); const code = Math.random().toString(36).slice(2, 8).toUpperCase();
      const m = { id: crypto.randomUUID(), code, created_by: tabId, members: [tabId], names: { [tabId]: name },
                  seats: { red1:null, red2:null, blue1:null, blue2:null }, status: 'lobby', state: null };
      all[m.id] = m; write(all); return m;
    },
    async join(code, name){
      const all = read(); const m = Object.values(all).find(x => x.code === code.toUpperCase().trim());
      if(!m) throw new Error('no match with that code');
      if(!m.members.includes(tabId)){
        if(m.status !== 'lobby') throw new Error('that battle has already started');
        if(m.members.length >= 4) throw new Error('match is full');
        m.members.push(tabId);
      }
      m.names[tabId] = name; all[m.id] = m; write(all); return m;
    },
    async seat(matchId, seat){
      const all = read(); const m = all[matchId];
      if(seat && m.seats[seat] && m.seats[seat] !== tabId) throw new Error('that army is taken');
      for(const k of Object.keys(m.seats)) if(m.seats[k] === tabId) m.seats[k] = null;
      if(seat) m.seats[seat] = tabId;
      write(all); return m;
    },
    async save(matchId, fields){ const all = read(); Object.assign(all[matchId], fields); write(all); },
    async load(matchId){ return read()[matchId]; },
    async open(matchId, { onMessage, onPresence, onStatus }, presence){
      bc = new BroadcastChannel(`fcg-${matchId}`); presenceMe = presence;
      const list = () => [presenceMe, ...Object.values(seen).filter(p => Date.now() - p.at < 5000)];
      const beat = () => bc.postMessage({ kind: 'presence', from: tabId, presence: presenceMe });
      bc.onmessage = e => {
        const d = e.data;
        if(d.kind === 'presence'){ seen[d.from] = { ...d.presence, at: Date.now() }; onPresence(list()); }
        else if(d.kind === 'm') onMessage(d.payload);
      };
      setInterval(() => { beat(); onPresence(list()); }, 1500);
      onStatus('SUBSCRIBED'); beat();
    },
    send(payload){ if(bc) bc.postMessage({ kind: 'm', payload }); },
  };
}

let T = null, me = null, match = null;
let present = [];
let controllers = null;                 // { army id: user id } once the battle is set up
let lastShared = null, seq = 0, sendTimer = null, lastSave = 0;
let setupShown = false, inBattle = false, lastTurnArmy = null, endShown = false;

async function transport(){
  if(T) return T;
  T = new URLSearchParams(location.search).get('onlineTransport') === 'local' ? localTransport() : await supabaseTransport();
  return T;
}
const controls = armyId => !!controllers && controllers[armyId] === me;
const nameOf = uid => (match && match.names && match.names[uid]) || 'A player';

/* ---------------------------------------------------------
   Lobby: name, new game or join with a code
--------------------------------------------------------- */
let lobbyEl = null;
function closeLobby(){ if(lobbyEl){ lobbyEl.remove(); lobbyEl = null; } }
/* Reuses the open panel and leaves it alone when nothing has changed, so the
   presence updates that arrive every second or two never rebuild the buttons
   under someone's finger. */
function shell(inner){
  if(lobbyEl && lobbyEl.dataset.inner === inner) return lobbyEl;
  if(!lobbyEl){
    lobbyEl = document.createElement('div');
    lobbyEl.style.cssText = 'position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:rgba(15,18,15,.7);padding:12px';
    document.body.appendChild(lobbyEl);
  }
  lobbyEl.dataset.inner = inner;
  lobbyEl.innerHTML = `<div style="max-width:460px;width:100%;max-height:100%;overflow:auto;background:#e8e0cb;color:#2a1e14;border-radius:6px;padding:16px;
    box-shadow:0 14px 34px rgba(0,0,0,.5);font:16px 'IM Fell English',Georgia,serif">${inner}</div>`;
  lobbyEl.dataset.fresh = '1';
  return lobbyEl;
}
const btn = (label, attrs = '', bg = '#2a1e14', fg = '#fbf6ea') =>
  `<button ${attrs} style="font:inherit;min-height:42px;padding:8px 14px;border:0;border-radius:4px;cursor:pointer;background:${bg};color:${fg}">${label}</button>`;
function friendly(e){
  const m = (e && e.message) || String(e);
  if(/version mismatch/i.test(m)) return 'You are on different versions of the game. Everyone reload the page, then try again.';
  if(/no match/i.test(m)) return 'No game with that code. Check the letters and try again.';
  if(/full/i.test(m)) return 'That game already has four players.';
  if(/already started/i.test(m)) return 'That battle has already started.';
  if(/taken/i.test(m)) return 'Someone has just taken that army.';
  return m;
}

export function openGroupLobby({ joinCode } = {}){
  const name = localStorage.getItem('fc-name') || '';
  const last = localStorage.getItem('fc-last-group') || '';
  const el = shell(`
    <div style="font-family:'Petit Formal Script',cursive;font-size:26px;margin-bottom:6px">Online: 3 or 4 players</div>
    <p style="margin:0 0 8px;font-size:14px">Two against two, a phone each. Up to four players; with three, one commands both armies of a side.</p>
    ${last && !joinCode ? `<div style="margin:0 0 10px">${btn(`Rejoin game ${esc(last)}`, 'id="ogRejoin"', '#5b6b3a')}</div>` : ''}
    <label style="display:block;margin:4px 0">Your name</label>
    <input id="ogName" value="${esc(name)}" maxlength="40" style="font:inherit;width:100%;padding:8px;border:1px solid #9a8b6c;border-radius:4px">
    <div style="margin-top:12px">${btn('New group game', 'id="ogNew"', '#5b6b3a')}</div>
    <label style="display:block;margin:14px 0 4px">Or join with a code</label>
    <div style="display:flex;gap:8px"><input id="ogCode" maxlength="6" value="${esc(joinCode || '')}"
      style="font:inherit;flex:1;min-width:8ch;padding:8px;border:1px solid #9a8b6c;border-radius:4px;text-transform:uppercase">${btn('Join', 'id="ogJoin"')}</div>
    <p id="ogStatus" style="min-height:1.4em;margin:12px 0 0;font-style:italic"></p>
    <div style="text-align:right;margin-top:6px">${btn('Close', 'id="ogClose"', 'transparent', '#2a1e14')}</div>`);
  const status = (t, bad) => { const p = el.querySelector('#ogStatus'); p.textContent = t; p.style.color = bad ? '#9b1c1c' : '#2a1e14'; };
  const getName = () => {
    const n = el.querySelector('#ogName').value.trim();
    if(!n){ status('Put your name in first.', true); return null; }
    localStorage.setItem('fc-name', n); return n;
  };
  el.querySelector('#ogClose').onclick = () => { closeLobby(); history.replaceState(null, '', location.pathname); };
  el.querySelector('#ogNew').onclick = async () => {
    const n = getName(); if(!n) return;
    try { status('Connecting...'); const t = await transport(); me = await t.signIn(); await start(await t.create(n), n); }
    catch(e){ status(friendly(e), true); }
  };
  const doJoin = async () => {
    const n = getName(); if(!n) return;
    try { status('Joining...'); const t = await transport(); me = await t.signIn(); await start(await t.join(el.querySelector('#ogCode').value, n), n); }
    catch(e){ status(friendly(e), true); }
  };
  el.querySelector('#ogJoin').onclick = doJoin;
  const rejoin = el.querySelector('#ogRejoin');
  if(rejoin) rejoin.onclick = () => { el.querySelector('#ogCode').value = last; doJoin(); };
  if(joinCode && name) doJoin();
}

async function start(m, name){
  match = m;
  localStorage.setItem('fc-last-group', m.code);
  const local = location.search.includes('onlineTransport=local');
  history.replaceState(null, '', `${location.pathname}?group=${m.code}${local ? '&onlineTransport=local' : ''}`);
  setOnlineSession({ group: true, matchId: m.id, code: m.code, isHost: m.created_by === me,
    isRemote: (side, unit) => unit && unit.army ? !controls(unit.army) : true });
  await T.open(m.id, { onMessage, onPresence, onStatus: st => { if(st === 'SUBSCRIBED') T.send({ type: 'hello' }); } },
               { uid: me, name });
  setRemoteAsker(askArmy);
  setDiceMirror((kind, args) => { if(sending()) T.send({ type: 'dice', kind, args }); });
  startSync();
  // Coming back to a battle already under way: pick up the saved copy.
  const saved = await T.load(m.id);
  if(saved){ match = saved; }
  if(saved && saved.state && saved.state.battle){
    const b = unpack(saved.state.battle);
    if(b.groupControllers) setControllers(b.groupControllers);
    applyIncoming(saved.state.battle, saved.state.seq || 0);
  } else {
    waitingRoom();
  }
}

/* ---------------------------------------------------------
   The waiting room: four army seats, tap to sit or stand up
--------------------------------------------------------- */
function waitingRoom(){
  if(controllers) return;
  const host = match.created_by === me;
  const url = `${location.origin}${location.pathname}?group=${match.code}`;
  const seatBtn = k => {
    const who = match.seats[k];
    const mine = who === me;
    const a = armyById(k);
    const label = who ? (mine ? 'You' : esc(nameOf(who))) : 'Empty: tap to take';
    return `<button data-seat="${k}" style="font:inherit;text-align:left;min-height:54px;padding:6px 10px;border-radius:5px;cursor:pointer;
      border:${mine ? '3px solid #b8963f' : '1px solid #9a8b6c'};background:${a.color};color:#fbf6ea">
      <div style="font-size:14px;opacity:.9">${SEAT_LABEL[k]}</div><div style="font-size:17px">${label}</div></button>`;
  };
  const seated = new Set(Object.values(match.seats).filter(Boolean));
  const watchers = (match.members || []).filter(u => !seated.has(u));
  const online = u => present.some(p => p && p.uid === u);
  const redOk = match.seats.red1 || match.seats.red2, blueOk = match.seats.blue1 || match.seats.blue2;
  const el = shell(`
    <div style="font-family:'Petit Formal Script',cursive;font-size:26px">Game ${esc(match.code)}</div>
    <p style="margin:2px 0 8px;font-size:14px">Friends enter this code under <b>Online</b> (3 or 4 players), or tap your invite. Tap an army to command it; tap it again to stand up.</p>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">${['red1','blue1','red2','blue2'].map(seatBtn).join('')}</div>
    <p style="margin:10px 0 4px;font-size:14px">${(match.members || []).map(u =>
      `<span style="white-space:nowrap;margin-right:10px"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px;background:${online(u) ? '#5fae6a' : '#999'}"></span>${esc(u === me ? 'You' : nameOf(u))}</span>`).join('')}</p>
    ${watchers.length ? `<p style="margin:0 0 4px;font-size:13px;font-style:italic">Not seated (will watch): ${watchers.map(u => esc(u === me ? 'you' : nameOf(u))).join(', ')}</p>` : ''}
    <p style="margin:4px 0;font-size:13px">An empty army is commanded by its teammate.</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
      ${btn('Send invite link', 'id="ogShare"')}
      ${host ? btn('Start the battle', `id="ogStart" ${redOk && blueOk ? '' : 'disabled'}`, redOk && blueOk ? '#5b6b3a' : '#9a9a8a') : ''}
    </div>
    <p id="ogWho" style="min-height:1.2em;margin:8px 0 0;font-size:14px;font-style:italic">${host
      ? (redOk && blueOk ? '' : 'Each side needs at least one commander before you can start.')
      : 'The host starts the battle when everyone is seated.'}</p>`);
  if(el.dataset.fresh !== '1') return;
  el.dataset.fresh = '';
  el.querySelectorAll('[data-seat]').forEach(b => b.onclick = async () => {
    const k = b.dataset.seat;
    try { match = await T.seat(match.id, match.seats[k] === me ? null : k); T.send({ type: 'lobby' }); waitingRoom(); }
    catch(e){ el.querySelector('#ogWho').textContent = friendly(e); refreshLobby(); }
  });
  el.querySelector('#ogShare').onclick = async () => {
    const text = `Join my Field Command group battle. Code: ${match.code}\n\nIn the Field Command app, tap Online, choose 3 or 4 players and enter the code. Or open this link:`;
    if(navigator.share){ try { await navigator.share({ title: 'Field Command', text, url }); return; } catch { /* dismissed */ } }
    try { await navigator.clipboard.writeText(`${text} ${url}`); el.querySelector('#ogWho').textContent = 'Invite copied.'; } catch { /* no clipboard */ }
  };
  const startBtn = el.querySelector('#ogStart');
  if(startBtn) startBtn.onclick = () => { if(redOk && blueOk) hostBegin(); };
}
async function refreshLobby(){
  if(controllers || !T || !match) return;
  const m = await T.load(match.id);
  if(m){ match = m; waitingRoom(); }
}

/* ---------------------------------------------------------
   Starting: who commands what, then the host sets up the battle
--------------------------------------------------------- */
function computeControllers(seats){
  const c = {};
  for(const a of GROUP_ARMIES) c[a.id] = seats[a.id] || seats[TEAMMATE[a.id]] || null;
  return c;
}
function setControllers(c){
  controllers = c;
  state.groupControlled = GROUP_ARMIES.filter(a => c[a.id] === me).map(a => a.id);
}
function myEdge(){
  const mine = GROUP_ARMIES.find(a => controls(a.id) && match.seats[a.id] === me) || GROUP_ARMIES.find(a => controls(a.id));
  return mine ? mine.edge : 'S';
}

async function hostBegin(){
  const fresh = await T.load(match.id); if(fresh) match = fresh;
  const c = computeControllers(match.seats);
  if(!Object.values(c).every(Boolean)) return;
  await T.save(match.id, { status: 'deploy' });
  setControllers(c);
  T.send({ type: 'begin', controllers: c, seats: match.seats });
  closeLobby();
  prepareGroupBoard();
  state.groupControllers = c;
  state.groupControlled = GROUP_ARMIES.filter(a => c[a.id] === me).map(a => a.id);
  state.viewEdge = myEdge();
  sizeCanvas(); draw();
  sendSetup();
  const order = rollTurnOrder(seededRandom).map(armyById);
  hostDeploy(order, 0);
}
function sendSetup(){ lastShared = pack(); seq += 1; T.send({ type: 'setup', seq, battle: lastShared }); }

let pendingDeploy = null, deployRetry = null;
function hostDeploy(order, i){
  if(i >= order.length){
    pendingDeploy = null;
    state.viewEdge = myEdge();
    startBattle();                       // rolls the turn order; aiSide set for this phone
    // Sent once from here whoever moves first: the sync loop only sends for the
    // acting army's commander, which may not be the host.
    lastShared = pack(); seq += 1;
    T.send({ type: 'state', seq, battle: lastShared });
    enterBattleView();
    return;
  }
  const army = order[i];
  state.deployTurn = army.side;          // the header names who is deploying
  const place = comp => {
    deployGroupArmy(army, comp.id);
    log(`${army.label} deploys as ${comp.name}.`, 'system');
    state.viewEdge = myEdge();
    draw();
    sendSetup();
    hostDeploy(order, i + 1);
  };
  if(controls(army.id)){
    showGroupArmyPicker(army, place);
  } else {
    pendingDeploy = { army: army.id, place };
    flash(`${nameOf(controllers[army.id])} is choosing for ${army.label}`);
    const ask = () => { if(pendingDeploy) T.send({ type: 'deployRequest', army: army.id, seq, battle: pack() }); };
    ask(); clearInterval(deployRetry); deployRetry = setInterval(ask, 4000);
  }
}

/* A non-host phone asked to choose an army: show the picker over the board as
   it stands, send the choice back, and wait for the host to place it. */
const answeredDeploy = new Set();
let pickerFor = null;
function onDeployRequest(p){
  if(!controls(p.army) || answeredDeploy.has(p.army) || pickerFor === p.army) return;
  adoptSetup(p.battle, p.seq);
  pickerFor = p.army;
  const army = armyById(p.army);
  showGroupArmyPicker(army, comp => {
    pickerFor = null; answeredDeploy.add(p.army);
    state.viewEdge = myEdge(); draw();
    T.send({ type: 'armyChosen', army: p.army, compId: comp.id, compName: comp.name });
  });
}
function onArmyChosen(p){
  if(!pendingDeploy || pendingDeploy.army !== p.army) return;
  const place = pendingDeploy.place;
  pendingDeploy = null; clearInterval(deployRetry);
  place({ id: p.compId, name: p.compName });
}

function adoptSetup(json, incomingSeq){
  const incoming = unpack(json);
  for(const k of Object.keys(incoming)) state[k] = incoming[k];
  seq = Math.max(seq, incomingSeq || 0);
  lastShared = pack();
  if(incoming.groupControllers && !controllers) setControllers(incoming.groupControllers);
  if(!setupShown) enterSetupView();
  else { updateHeader(); draw(); }
}
function enterSetupView(){
  setupShown = true;
  closeLobby();
  document.getElementById('overlay').classList.remove('show');
  document.getElementById('sidebar').style.display = 'none';
  setBoardMode('grand');
  state.group = true;
  state.viewEdge = myEdge();
  sizeCanvas();
  AudioManager.stopMusic();
  AudioManager.playAmbience('audio/ambience/countryside.mp3');
  playBoardIntroAnimation(() => { startAmbientLayer(); draw(); });
}

/* ---------------------------------------------------------
   The battle, kept in step
--------------------------------------------------------- */
// This phone may send only while it commands the acting army (or, before the
// battle, if it is the host running the setup).
function sending(){
  if(!controllers) return false;
  if(BATTLE_PHASES.has(state.phase)) return controls(state.turnArmy);
  return match && match.created_by === me;
}

function startSync(){
  if(sendTimer) return;
  sendTimer = setInterval(() => {
    if(!BATTLE_PHASES.has(state.phase)) return;
    /* The phone that has just ended its army's turn must still send that last
       change (the turn passing on), even though it no longer commands the
       acting army: without it nobody else would ever learn the turn is theirs. */
    const handingOver = lastTurnArmy && lastTurnArmy !== state.turnArmy && controls(lastTurnArmy);
    if(!sending() && !handingOver) return;
    if(state.gameOver) setTimeout(sendRecord, 1500);
    const now = pack();
    if(now === lastShared) return;
    lastShared = now; seq += 1;
    T.send({ type: 'state', seq, battle: now });
    if(Date.now() - lastSave > SAVE_EVERY_MS){
      lastSave = Date.now();
      T.save(match.id, { state: { battle: now, seq }, seq, turn_army: state.turnArmy || null,
                         status: state.gameOver ? 'finished' : 'active' });
    }
    enterBattleView();
    if(lastTurnArmy !== state.turnArmy){ lastTurnArmy = state.turnArmy; announceTurn(); }
  }, SEND_EVERY_MS);
}

let diceBusy = false, deferred = null, diceSafety = null;
function releaseDeferred(){
  diceBusy = false; clearTimeout(diceSafety);
  if(deferred){ const d = deferred; deferred = null; applyIncoming(d.json, d.seq); }
}
function onDice(p){
  if(!inBattle && !setupShown) return;
  diceBusy = true;
  clearTimeout(diceSafety);
  diceSafety = setTimeout(releaseDeferred, 8000);
  const a = p.kind === 'trigger' ? { ...p.args, watchSide: state.aiSide } : p.args;
  replayDice(p.kind, a, releaseDeferred);
}

function applyIncoming(json, incomingSeq){
  if(incomingSeq != null && incomingSeq <= seq && lastShared) return;
  if(diceBusy){ deferred = { json, seq: incomingSeq }; return; }
  const incoming = unpack(json);
  if(!BATTLE_PHASES.has(incoming.phase)){ adoptSetup(json, incomingSeq); return; }
  if(incoming.groupControllers && !controllers) setControllers(incoming.groupControllers);
  if(!setupShown) enterSetupView();

  const prevLine = state.lastActionLine && state.lastActionLine.n;
  const prevGunfire = state.lastGunfire && state.lastGunfire.n;
  const prevFocus = state.focusUnitId;
  const moved = [];
  if(inBattle){
    for(const nu of incoming.units || []){
      const lu = state.units.find(u => u.id === nu.id);
      if(!lu || lu.removed || nu.removed || (lu.x === nu.x && lu.y === nu.y)) continue;
      const profile = nu.charged && !lu.charged ? 'charge' : 'march';
      animateUnitTo(lu, nu.x, nu.y, profile);
      playMovementAudio(lu, Math.max(Math.abs(nu.x - lu.x), Math.abs(nu.y - lu.y)), profile);
      moved.push(nu);
    }
  }
  for(const k of Object.keys(incoming)) state[k] = incoming[k];
  refreshGroupControl();
  seq = Math.max(seq, incomingSeq || 0);
  lastShared = pack();
  enterBattleView();

  if(lastTurnArmy !== state.turnArmy){
    if(lastTurnArmy !== null) playTurnTheme(state.turn);
    if(controls(state.turnArmy)) cameraRestorePlayerView(); else cameraParkPlayerView();
    lastTurnArmy = state.turnArmy;
    announceTurn();
  }
  // The opponent's shot: the same blast and smoke on this phone (render-gunfire.js).
  if(state.lastGunfire && state.lastGunfire.n !== prevGunfire) replayGunfire(state.lastGunfire);
  if(!controls(state.turnArmy)){
    const line = state.lastActionLine;
    if(line && line.n !== prevLine){
      replayActionLine(line);
      cameraToAction([{ x: line.fromX, y: line.fromY }, { x: line.toX, y: line.toY }], { durationMs: CAMERA_ACTION_PAN_MS });
    } else if(moved.length){
      cameraToUnits(moved, { durationMs: CAMERA_ACTION_PAN_MS });
    } else if(state.focusUnitId && state.focusUnitId !== prevFocus){
      const fu = state.units.find(u => u.id === state.focusUnitId);
      if(fu && !fu.removed) cameraToUnits([fu], { durationMs: CAMERA_ACTION_PAN_MS });
    }
  }
  refreshUi();
  noteBrigadeBreaks();
  if(state.gameOver && !endShown){ endShown = true; endGame(state.winner); sendRecord(); }
}

function enterBattleView(){
  if(inBattle) return;
  inBattle = true;
  closeLobby();
  if(!Array.isArray(state.matchLog)) state.matchLog = [];
  document.getElementById('overlay').classList.remove('show');
  document.getElementById('sidebar').style.display = 'none';
  const uo = document.getElementById('unitOverlay'); uo.classList.remove('hidden'); uo.classList.remove('show');
  state.viewEdge = myEdge();
  refreshGroupControl();
  sizeCanvas();
  lastTurnArmy = state.turnArmy;
  setTimeout(announceTurn, 0);
}

function refreshUi(){
  const theirs = !controls(state.turnArmy);
  for(const id of ['endMoveBtn', 'endFireBtn', 'endFightBtn']){
    const b = document.getElementById(id); if(b) b.disabled = theirs;
  }
  syncPhaseButtons();
  if(state.selectedUnitId != null){
    const u = state.units.find(x => x.id === state.selectedUnitId);
    if(!u || u.removed) selectUnit(null);
  }
  updateHeader();
  draw();
}

/* ---------------------------------------------------------
   Questions for the commander of an army (re-roll, Leadership, ambush)
--------------------------------------------------------- */
const pendingAsks = new Map();
function askArmy(kind, data, fallback, timeoutMs){
  return new Promise(resolve => {
    const id = Math.random().toString(36).slice(2);
    const done = v => { clearTimeout(timer); pendingAsks.delete(id); resolve(v); };
    const timer = setTimeout(() => done(fallback), timeoutMs);
    pendingAsks.set(id, done);
    T.send({ type: 'ask', id, kind, data });
    const who = data && data.army && controllers ? nameOf(controllers[data.army]) : 'The other side';
    flash(`${who} is deciding`);
  });
}
function onAsk(p){
  if(!p.data || !controls(p.data.army)) return;       // only the army's own commander answers
  const reply = value => T.send({ type: 'answer', id: p.id, value });
  const find = id => state.units.find(u => u.id === id);
  if(p.kind === 'reroll') showDiceRerollButton(p.data.label, () => reply(true), () => reply(false));
  else if(p.kind === 'leadership'){
    const loser = find(p.data.loserId), brig = find(p.data.brigId);
    if(loser && brig) showLeadershipRollPrompt(loser, brig, reply, { answerMs: ANSWER_WINDOW_MS });
  } else if(p.kind === 'ambush'){
    const amb = find(p.data.ambId), target = find(p.data.targetId);
    if(amb && target) showAmbushChoice(amb, target, reply, { answerMs: ANSWER_WINDOW_MS });
  }
}

/* ---------------------------------------------------------
   Messages
--------------------------------------------------------- */
function onMessage(p){
  if(p.type === 'lobby') refreshLobby();
  else if(p.type === 'begin'){ if(!controllers){ setControllers(p.controllers); match.seats = p.seats || match.seats; closeLobby(); flash('The battle is being set up'); } }
  else if(p.type === 'setup'){ if(match.created_by !== me) adoptSetup(p.battle, p.seq); }
  else if(p.type === 'state') applyIncoming(p.battle, p.seq);
  else if(p.type === 'dice') onDice(p);
  else if(p.type === 'ask') onAsk(p);
  else if(p.type === 'answer'){ const f = pendingAsks.get(p.id); if(f) f(p.value); }
  else if(p.type === 'deployRequest') onDeployRequest(p);
  else if(p.type === 'armyChosen') onArmyChosen(p);
  else if(p.type === 'record') onRecord(p);
  else if(p.type === 'hello'){
    // Someone connected or came back: whoever is running things hands them the game as it stands.
    if(!controllers){ refreshLobby(); return; }
    if(!sending()) return;
    if(BATTLE_PHASES.has(state.phase)){ lastShared = pack(); T.send({ type: 'state', seq, battle: lastShared }); }
    else { T.send({ type: 'begin', controllers, seats: match.seats }); sendSetup(); }
  }
}

function onPresence(list){
  const before = new Set(present.filter(Boolean).map(p => p.uid));
  present = list;
  const after = new Set(present.filter(Boolean).map(p => p.uid));
  if(!controllers){ if(lobbyEl) waitingRoom(); return; }
  for(const u of Object.values(controllers)){
    if(u === me) continue;
    if(before.has(u) && !after.has(u)) flash(`${nameOf(u)} has lost connection`);
    else if(!before.has(u) && after.has(u) && before.size) flash(`${nameOf(u)} is back`);
  }
}

/* ---------------------------------------------------------
   The note at the top: shows, then goes (3 seconds)
--------------------------------------------------------- */
let pillTimer = null;
function flash(text, ms = 3000){
  let pill = document.getElementById('onlinePill');
  if(!pill){
    pill = document.createElement('div'); pill.id = 'onlinePill';
    pill.style.cssText = 'position:fixed;top:calc(env(safe-area-inset-top,0px) + 8px);left:50%;transform:translateX(-50%);z-index:28;' +
      'font:14px "IM Fell English",Georgia,serif;color:#fbf6ea;background:rgba(20,24,20,.78);padding:4px 12px;border-radius:14px;' +
      'pointer-events:none;white-space:nowrap;opacity:0;transition:opacity .4s';
    document.body.appendChild(pill);
  }
  pill.textContent = text;
  pill.style.opacity = '1';
  clearTimeout(pillTimer);
  pillTimer = setTimeout(() => { pill.style.opacity = '0'; }, ms);
}
function announceTurn(){
  if(!state.turnArmy || !controllers) return;
  const a = armyById(state.turnArmy);
  flash(controls(a.id) ? `Your turn: ${a.label}` : `${a.label}: ${nameOf(controllers[a.id])}'s turn`);
}

/* ---------------------------------------------------------
   The match record: each phone recorded the turns it ran; at the end each
   sends its half to the others (in pieces) and every phone merges by turn.
--------------------------------------------------------- */
const RECORD_PIECE = 60000;
let recordSent = false;
const recordPieces = {}, recordMerged = new Set();
function sendRecord(){
  if(recordSent || !T) return;
  recordSent = true;
  const body = JSON.stringify({ from: me, log: state.matchLog || [], start: state.replayStartUnits || null });
  const id = Math.random().toString(36).slice(2);
  const n = Math.max(1, Math.ceil(body.length / RECORD_PIECE));
  for(let i = 0; i < n; i++) setTimeout(() => T.send({ type: 'record', id, i, n, part: body.slice(i * RECORD_PIECE, (i + 1) * RECORD_PIECE) }), i * 150);
}
function onRecord(p){
  const parts = recordPieces[p.id] = recordPieces[p.id] || [];
  parts[p.i] = p.part;
  if(parts.filter(x => x != null).length < p.n) return;
  delete recordPieces[p.id];
  let rec; try { rec = JSON.parse(parts.join('')); } catch { return; }
  if(recordMerged.has(rec.from)) return;
  recordMerged.add(rec.from);
  const all = (state.matchLog || []).map((e, i) => ({ e, i, src: 0 }))
    .concat((rec.log || []).map((e, i) => ({ e, i, src: recordMerged.size })));
  all.sort((a, b) => (a.e.turn || 0) - (b.e.turn || 0) || a.src - b.src || a.i - b.i);
  state.matchLog = all.map(x => x.e);
  if(!state.replayStartUnits && rec.start) state.replayStartUnits = rec.start;
  renderEndButtons();
  recOnlineMerged(recordMerged.size, 3);   // match telemetry: whole once all three other halves are in
  sendRecord();
}
