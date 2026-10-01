/* =========================================================
   ONLINE PLAY

   Loaded only when someone opens the lobby or an invite link, so the Supabase
   client is never downloaded for an ordinary game.

   HOW THE TWO PHONES STAY IN STEP
   Whoever's turn it is, their phone runs the rules exactly as in a normal game.
   Every few hundred milliseconds each phone compares the battle with the last
   version both phones agreed on, and if its own copy has changed (because its
   player moved, fired, fought or rolled) it sends the whole battle across. The
   other phone animates any unit that moved, with its movement sound, and then
   adopts the battle as sent. Only one phone can change anything at a time,
   because the game already locks input on the side that is not yours, so the
   two never send over each other.

   The battle is sent without the match log and the AI's working notes, which
   are most of its bulk: about 50 KB mid-match against 830 KB with them.

   THE AI NEVER PLAYS. The session sets aiSide to the other player, so the game
   treats their side as it treats an AI side (locked input, flipped board,
   hidden ambushes), and online-session.js stops the AI acting for it.

   FIRST VERSION: the host's phone sets up the battle and picks both armies
   (the host's through the normal picker, the guest's automatically). Choosing
   and deploying your own army on your own phone comes next.
========================================================= */
import { state, SIDES, SIDE_LABEL } from './data-core.js';
import { setOnlineSession, onlineSession, setRemoteDeployHandler, setRemoteAsker } from './online-session.js';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './online-config.js';
import { animateUnitTo, CAMERA_ACTION_PAN_MS, cameraParkPlayerView, cameraRestorePlayerView, cameraToAction, cameraToUnits, draw, playBoardIntroAnimation, replayActionLine, replayGunfire, sizeCanvas } from './render-board.js';
import { ANSWER_WINDOW_MS } from './prompt-panel.js';
import { playMovementAudio, showLeadershipRollPrompt } from './engine-rules.js';
import { noteBrigadeBreaks, playTurnTheme, selectUnit, showAmbushChoice, updateHeader } from './ui-battle.js';
import { log, syncPhaseButtons } from './engine-state.js';
import { endGame, renderEndButtons } from './engine-objectives.js';
import { deployArmyComposition } from './ai-deployment.js';
import { maybeShowArmyPicker, showArmyPickerFor, startAmbientLayer } from './ui-menus.js';
import { replayDice, setDiceMirror, showDiceRerollButton } from './dice.js';
import { setBoardMode } from './data-core.js';
import { AudioManager } from './audio-manager.js';

export const ONLINE_VERSION = 'fc-online-1';
const SEND_EVERY_MS = 250;
const SAVE_EVERY_MS = 3000;
/* Only a battle under way is shared. Before that the host is still choosing the
   board's orientation or deploying, there is no side to move yet, and an early
   copy crashed the guest's header on a turn that did not exist. Deployment is
   handed across separately (deployRequest). */
const BATTLE_PHASES = new Set(['move', 'fire', 'fight']);

/* Keys never sent: the match log and AI caches are bulky and only matter on the
   phone that made them, and the rest are this phone's own view of the match. */
/* The last four are this phone's presentation of the match, never shared: which
   breaks it has announced, when its dispatch window ends, and whether it is
   waiting to show the result. Sharing them is what stopped the losing phone
   from ever showing the result (it adopted the winner's "already waiting"
   flag) and stopped breaks being announced on the phone that did not cause
   them. */
const LOCAL_ONLY = new Set(['mode', 'aiSide', 'spectate', 'selectedUnitId', 'aiDifficulty',
  'brokenSeen', '_dispatchUntil', '_endDeferred', 'replaying']);
const skipKey = k => k === 'matchLog' || k === 'replayStartUnits' || k.startsWith('_ai') || LOCAL_ONLY.has(k);

function pack(){
  return JSON.stringify(state, (k, v) => (k && skipKey(k)) ? undefined
    : (v instanceof Set ? { __isSet: true, items: [...v] } : v));
}
function unpack(s){
  return JSON.parse(s, (k, v) => (v && v.__isSet) ? new Set(v.items) : v);
}

/* ---------------------------------------------------------
   Transport: Supabase for real play; ?onlineTransport=local swaps in a
   same-browser stand-in (BroadcastChannel and localStorage) so two tabs can
   test the game side of this without the network.
--------------------------------------------------------- */
async function supabaseTransport(){
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm');
  const sb = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
  let me = null, channel = null;
  return {
    async signIn(){
      const { data: { session } } = await sb.auth.getSession();
      if(session){ me = session.user.id; return me; }
      const { data, error } = await sb.auth.signInAnonymously();
      if(error) throw new Error(error.message);
      me = data.user.id; return me;
    },
    async create(side, name){
      const { data, error } = await sb.rpc('create_match', { p_side: side, p_name: name, p_version: ONLINE_VERSION });
      if(error) throw error; return data;
    },
    async join(code, name){
      const { data, error } = await sb.rpc('join_match', { p_code: code, p_name: name, p_version: ONLINE_VERSION });
      if(error) throw error; return data;
    },
    async save(matchId, fields){ await sb.from('matches').update(fields).eq('id', matchId); },
    async load(matchId){ const { data } = await sb.from('matches').select('*').eq('id', matchId).single(); return data; },
    async open(matchId, { onMessage, onPresence, onStatus }, presence){
      await sb.realtime.setAuth();
      channel = sb.channel(`match:${matchId}`, { config: { private: true, broadcast: { self: false }, presence: { key: me } } });
      channel
        .on('broadcast', { event: 'm' }, ({ payload }) => onMessage(payload))
        .on('presence', { event: 'sync' }, () => onPresence(Object.values(channel.presenceState()).flat()))
        .subscribe(async st => {
          onStatus(st);
          if(st === 'SUBSCRIBED') await channel.track(presence);
        });
    },
    send(payload){ if(channel) channel.send({ type: 'broadcast', event: 'm', payload }); },
  };
}

function localTransport(){
  const tabId = sessionStorage.getItem('fc-tab') || (sessionStorage.setItem('fc-tab', crypto.randomUUID()), sessionStorage.getItem('fc-tab'));
  const read = () => JSON.parse(localStorage.getItem('fc-local-matches') || '{}');
  const write = m => localStorage.setItem('fc-local-matches', JSON.stringify(m));
  let bc = null, seen = {}, presenceMe = null;
  return {
    async signIn(){ return tabId; },
    async create(side, name){
      const all = read(); const code = Math.random().toString(36).slice(2, 8).toUpperCase();
      const m = { id: crypto.randomUUID(), code, red_player: side === 'red' ? tabId : null, blue_player: side === 'blue' ? tabId : null,
                  red_name: side === 'red' ? name : null, blue_name: side === 'blue' ? name : null, created_by: tabId, state: null };
      all[m.id] = m; write(all); return m;
    },
    async join(code, name){
      const all = read(); const m = Object.values(all).find(x => x.code === code.toUpperCase().trim());
      if(!m) throw new Error('no match with that code');
      if(![m.red_player, m.blue_player].includes(tabId)){
        if(!m.red_player){ m.red_player = tabId; m.red_name = name; } else if(!m.blue_player){ m.blue_player = tabId; m.blue_name = name; }
        else throw new Error('match is full');
      }
      all[m.id] = m; write(all); return m;
    },
    async save(matchId, fields){ const all = read(); Object.assign(all[matchId], fields); write(all); },
    async load(matchId){ return read()[matchId]; },
    async open(matchId, { onMessage, onPresence, onStatus }, presence){
      bc = new BroadcastChannel(`fc-${matchId}`); presenceMe = presence;
      const beat = () => bc.postMessage({ kind: 'presence', from: tabId, presence: presenceMe });
      bc.onmessage = e => {
        const d = e.data;
        if(d.kind === 'presence'){ seen[d.from] = { ...d.presence, at: Date.now() };
          onPresence([presenceMe, ...Object.values(seen).filter(p => Date.now() - p.at < 5000)]); }
        else if(d.kind === 'm') onMessage(d.payload);
      };
      setInterval(() => { beat(); onPresence([presenceMe, ...Object.values(seen).filter(p => Date.now() - p.at < 5000)]); }, 1500);
      onStatus('SUBSCRIBED'); beat();
    },
    send(payload){ if(bc) bc.postMessage({ kind: 'm', payload }); },
  };
}

/* ---------------------------------------------------------
   Keeping in step
--------------------------------------------------------- */
let T = null, lastShared = null, seq = 0, sendTimer = null, lastSave = 0, inBattle = false, lastTurn = null, endShown = false;

function startSync(){
  if(sendTimer) return;
  sendTimer = setInterval(() => {
    const s = onlineSession(); if(!s) return;
    /* Once the battle is under way either phone may be the one acting. Before
       that only the host acts (it runs the setup), so only the host shares. */
    if(!BATTLE_PHASES.has(state.phase) && !(s.isHost && setupStarted)) return;
    if(state.gameOver) setTimeout(sendRecord, 1500);   // once, after the final battle has gone across
    const now = pack();
    if(now === lastShared) return;
    lastShared = now; seq += 1;
    T.send({ type: 'state', seq, battle: now });
    if(Date.now() - lastSave > SAVE_EVERY_MS){
      lastSave = Date.now();
      T.save(s.matchId, { state: { battle: now, seq }, seq, turn_side: state.turn || null,
                          status: state.gameOver ? 'finished' : (state.phase === 'deploy' ? 'deploy' : 'active') });
    }
    if(BATTLE_PHASES.has(state.phase)) enterBattleView();
    /* This phone's own turn changes play their theme through beginMovePhase as
       usual; noting them here stops the other phone's next update replaying it. */
    if(lastTurn !== state.turn && BATTLE_PHASES.has(state.phase)) showPillBriefly();
    lastTurn = state.turn;
    updatePill();
  }, SEND_EVERY_MS);
}

function applyBattle(json, incomingSeq){
  if(incomingSeq != null && incomingSeq <= seq && lastShared) return;   // stale or already applied
  /* While the dice are on screen, hold the battle back until they fade, so a
     unit is not removed or pushed back before its own roll has finished. */
  if(diceBusy){ deferred = { json, incomingSeq }; return; }
  const incoming = unpack(json);
  if(!BATTLE_PHASES.has(incoming.phase)){ applySetup(incoming, incomingSeq); return; }
  const s = onlineSession();

  /* Walk every unit that moved to its new square before adopting the battle,
     with its own movement sound. The animation is keyed by unit id, so it keeps
     running after the battle's unit objects are replaced a moment later. */
  if(inBattle){
    for(const nu of incoming.units || []){
      const lu = state.units.find(u => u.id === nu.id);
      if(!lu || lu.removed || nu.removed || (lu.x === nu.x && lu.y === nu.y)) continue;
      const steps = Math.max(Math.abs(nu.x - lu.x), Math.abs(nu.y - lu.y));
      const profile = nu.charged && !lu.charged ? 'charge' : 'march';
      animateUnitTo(lu, nu.x, nu.y, profile);
      playMovementAudio(lu, steps, profile);
    }
  }

  const prevLine = state.lastActionLine && state.lastActionLine.n;
  const prevGunfire = state.lastGunfire && state.lastGunfire.n;
  const prevFocus = state.focusUnitId;
  const moved = inBattle ? (incoming.units || []).filter(nu => {
    const lu = state.units.find(u => u.id === nu.id);
    return lu && !lu.removed && !nu.removed && (lu.x !== nu.x || lu.y !== nu.y);
  }) : [];
  for(const k of Object.keys(incoming)) state[k] = incoming[k];
  state.mode = 'ai'; state.aiSide = s.remoteSide; state.spectate = false;
  seq = Math.max(seq, incomingSeq || 0);
  lastShared = pack();

  enterBattleView();
  if(lastTurn !== state.turn){
    if(lastTurn !== null) playTurnTheme(state.turn);
    // Their turn: park this player's own view, as for the AI; ours: give it back.
    if(state.turn === s.mySide) cameraRestorePlayerView(); else cameraParkPlayerView();
    lastTurn = state.turn;
    showPillBriefly();
  }
  /* Follow the opponent like the AI: the unit they pick up, the units they
     move, and the line from an attacker to its target. Only on their turn. */
  // The opponent's shot: the same blast and smoke on this phone (render-gunfire.js).
  if(state.lastGunfire && state.lastGunfire.n !== prevGunfire) replayGunfire(state.lastGunfire);
  if(state.turn !== s.mySide){
    const line = state.lastActionLine;
    if(line && line.n !== prevLine){
      replayActionLine(line);
      cameraToAction([{ x:line.fromX, y:line.fromY }, { x:line.toX, y:line.toY }], { durationMs: CAMERA_ACTION_PAN_MS });
    } else if(moved.length){
      cameraToUnits(moved, { durationMs: CAMERA_ACTION_PAN_MS });
    } else if(state.focusUnitId && state.focusUnitId !== prevFocus){
      const fu = state.units.find(u => u.id === state.focusUnitId);
      if(fu && !fu.removed) cameraToUnits([fu], { durationMs: CAMERA_ACTION_PAN_MS });
    }
  }
  refreshUi();
  // Breaks are announced on this phone too, against its own record of what it
  // has already shown (brokenSeen is not shared).
  noteBrigadeBreaks();
  if(state.gameOver && !endShown){ endShown = true; endGame(state.winner); sendRecord(); }
}

/* ---------------------------------------------------------
   Setup, followed live on the guest's phone: the same map arrives the moment
   the host presses start, the falling-tiles intro plays, and from then the
   orientation rolls (through the dice mirror), any board rotation and the
   deployment follow as they happen.
--------------------------------------------------------- */
let setupStarted = false, setupShown = false;

function adopt(incoming){
  const s = onlineSession();
  for(const k of Object.keys(incoming)) state[k] = incoming[k];
  state.mode = 'ai'; state.aiSide = s.remoteSide; state.spectate = false;
}

function applySetup(incoming, incomingSeq){
  if(onlineSession().isHost) return;
  adopt(incoming);
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
  sizeCanvas();
  AudioManager.stopMusic();
  AudioManager.playAmbience('audio/ambience/countryside.mp3');
  playBoardIntroAnimation(() => { startAmbientLayer(); draw(); });
  updatePill();
}

/* ---------------------------------------------------------
   Dice on both phones
--------------------------------------------------------- */
let diceBusy = false, deferred = null, diceSafety = null;

function releaseDeferred(){
  diceBusy = false; clearTimeout(diceSafety);
  if(deferred){ const d = deferred; deferred = null; applyBattle(d.json, d.incomingSeq); }
}

function onDice(p){
  if(!setupShown && !inBattle) return;
  diceBusy = true;
  clearTimeout(diceSafety);
  diceSafety = setTimeout(releaseDeferred, 8000);     // never hold the battle back for long if a finish goes missing
  const a = p.kind === 'trigger' ? { ...p.args, watchSide: onlineSession().remoteSide } : p.args;
  replayDice(p.kind, a, releaseDeferred);
}

/* ---------------------------------------------------------
   Questions for the owner of a unit (re-roll, Leadership Roll, ambush)
--------------------------------------------------------- */
const pendingAsks = new Map();

function askOther(kind, data, fallback, timeoutMs){
  return new Promise(resolve => {
    const id = Math.random().toString(36).slice(2);
    const s = onlineSession();
    const name = s.names[s.remoteSide] || 'your opponent';
    const done = v => { clearTimeout(timer); pendingAsks.delete(id); updatePill(''); resolve(v); };
    const timer = setTimeout(() => done(fallback), timeoutMs);
    pendingAsks.set(id, done);
    T.send({ type: 'ask', id, kind, data });
    updatePill(`${name} is deciding`);
  });
}

function onAsk(p){
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

function enterBattleView(){
  if(inBattle) return;
  inBattle = true;
  // Every phone keeps a record of the turns it runs (see sendRecord), including
  // the one that did not start the battle and so never had one made for it.
  if(!Array.isArray(state.matchLog)) state.matchLog = [];
  lastTurn = state.turn;
  setTimeout(() => showPillBriefly(), 0);
  closeLobby();
  document.getElementById('overlay').classList.remove('show');
  document.getElementById('sidebar').style.display = 'none';
  const uo = document.getElementById('unitOverlay'); uo.classList.remove('hidden'); uo.classList.remove('show');
  sizeCanvas();
}

function refreshUi(){
  const s = onlineSession();
  const theirs = state.turn !== s.mySide;
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
  updatePill();
}

/* ---------------------------------------------------------
   Deployment: each player chooses their own army.
   The host's phone runs deployment. When it reaches the guest's side, where it
   would normally let the AI choose, it asks the guest's phone instead and
   keeps asking every few seconds until the answer arrives (the guest may still
   be connecting). The guest sees the board as deployed so far and the same
   six armies; their choice is placed on the host's phone exactly as if chosen
   there, and deployment carries on.
--------------------------------------------------------- */
let pendingDeploy = null, deployRetry = null, pickerOpen = false, armySent = false;

function askGuestToDeploy(side){
  pendingDeploy = side;
  const ask = () => { if(pendingDeploy) T.send({ type: 'deployRequest', side: pendingDeploy, battle: pack() }); };
  ask();
  clearInterval(deployRetry);
  deployRetry = setInterval(ask, 3000);
  updatePill();
}

function onArmyChosen(p){
  if(!pendingDeploy || p.side !== pendingDeploy) return;
  pendingDeploy = null; clearInterval(deployRetry);
  deployArmyComposition(p.side, p.armyId);
  log(`${SIDE_LABEL[p.side]} deploys as ${p.armyName}.`, 'system');   // as the picker logs the host's own choice
  /* Placing a whole army suppresses the picker while it works, so the other
     side's picker cannot flash open mid-placement, and nothing reopens it
     afterwards. When the guest deploys first that left the host with no way
     to choose: offer it now if it is the host's turn and they have not. */
  maybeShowArmyPicker();
  const s = onlineSession();
  const them = present.find(x => x && x.side === p.side);
  const who = s.names[p.side] || (them && them.name) || 'Your opponent';
  flashPill(`${who} deployed as ${p.armyName}`);
}

function onDeployRequest(p){
  const s = onlineSession();
  if(p.side !== s.mySide || pickerOpen || armySent) return;
  adopt(unpack(p.battle));
  lastShared = pack();
  if(!setupShown) enterSetupView();
  closeLobby();
  document.getElementById('overlay').classList.remove('show');
  draw();
  pickerOpen = true;
  showArmyPickerFor(s.mySide, army => {
    pickerOpen = false; armySent = true;
    document.getElementById('sidebar').style.display = 'none';
    document.getElementById('rosterPanel').style.display = 'none';
    T.send({ type: 'armyChosen', side: s.mySide, armyId: army.id, armyName: army.name });
    lobbyShell(`<div style="font-family:'Petit Formal Script',cursive;font-size:24px">${esc(army.name)}</div>
      <p style="margin:8px 0 0">Army chosen. The battle appears here the moment ${esc(s.names[s.remoteSide] || 'your opponent')} starts it.</p>`);
  });
}

function onMessage(p){
  if(p.type === 'state') applyBattle(p.battle, p.seq);
  else if(p.type === 'setup'){ if(!onlineSession().isHost){ adopt(unpack(p.battle)); lastShared = pack(); if(!setupShown) enterSetupView(); } }
  else if(p.type === 'dice') onDice(p);
  else if(p.type === 'ask') onAsk(p);
  else if(p.type === 'answer'){ const f = pendingAsks.get(p.id); if(f) f(p.value); }
  else if(p.type === 'deployRequest') onDeployRequest(p);
  else if(p.type === 'record') onRecord(p);
  else if(p.type === 'armyChosen') onArmyChosen(p);
  else if(p.type === 'hello' && setupStarted && !BATTLE_PHASES.has(state.phase) && !pendingDeploy){
    T.send({ type: 'setup', battle: pack() });
  }
  else if(p.type === 'hello' && pendingDeploy){
    T.send({ type: 'deployRequest', side: pendingDeploy, battle: pack() });
  }
  else if(p.type === 'hello'){
    /* The other phone has just connected or come back: hand it the battle as
       it stands, if there is one to hand over. */
    if(BATTLE_PHASES.has(state.phase) && state.units && state.units.length){
      lastShared = pack(); T.send({ type: 'state', seq, battle: lastShared });
    }
  }
}

/* ---------------------------------------------------------
   Presence pill and lobby
--------------------------------------------------------- */
let present = [];
function onPresence(list){
  const before = present.some(p => p && p.side === (onlineSession() || {}).remoteSide);
  present = list; updatePill(); updateLobby();
  const after = present.some(p => p && p.side === (onlineSession() || {}).remoteSide);
  if(before !== after) showPillBriefly();   // a connection change is worth seeing
}

let pillNote = '', pillTimer = null;
/* A passing note (who deployed as what) clears itself; a standing one (waiting
   for a decision) stays until it is cleared by the code that set it. */
function flashPill(note){ clearTimeout(pillTimer); updatePill(note); showPillBriefly(6000); pillTimer = setTimeout(() => updatePill(''), 6000); }

/* THE PILL SHOWS, THEN GOES. It used to sit over the board all match; it now
   appears when the turn changes (and when a connection drops or returns, or a
   note is posted) and fades three seconds later. */
let pillHideTimer = null;
function showPillBriefly(ms = 3000){
  updatePill();
  const pill = document.getElementById('onlinePill'); if(!pill) return;
  pill.style.opacity = '1';
  clearTimeout(pillHideTimer);
  pillHideTimer = setTimeout(() => { pill.style.opacity = '0'; }, ms);
}
function updatePill(note){
  if(note !== undefined) pillNote = note;
  const s = onlineSession(); if(!s) return;
  let pill = document.getElementById('onlinePill');
  if(!pill){
    pill = document.createElement('div'); pill.id = 'onlinePill';
    pill.style.cssText = 'position:fixed;top:calc(env(safe-area-inset-top,0px) + 8px);left:50%;transform:translateX(-50%);z-index:28;' +
      'font:14px "IM Fell English",Georgia,serif;color:#fbf6ea;background:rgba(20,24,20,.72);padding:4px 12px;border-radius:14px;' +
      'pointer-events:none;white-space:nowrap;opacity:0;transition:opacity .4s';
    document.body.appendChild(pill);
  }
  const them = present.find(p => p && p.side === s.remoteSide);
  const name = s.names[s.remoteSide] || (them && them.name) || 'Opponent';
  const whose = pendingDeploy ? ` · ${name} is choosing an army` : pillNote ? ` · ${pillNote}`
    : !inBattle ? '' : (state.turn === s.mySide ? ' · Your turn' : ` · ${name}'s turn`);
  pill.innerHTML = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:1px;` +
    `background:${them ? '#7fd08a' : '#888'}"></span>${them ? `${esc(name)} is here` : `${esc(name)} is not connected`}${whose}`;
}

function esc(s){ return String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c])); }

let lobbyEl = null;
function closeLobby(){ if(lobbyEl){ lobbyEl.remove(); lobbyEl = null; } }

function lobbyShell(inner){
  closeLobby();
  lobbyEl = document.createElement('div');
  lobbyEl.style.cssText = 'position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:rgba(15,18,15,.7);padding:16px';
  lobbyEl.innerHTML = `<div style="max-width:420px;width:100%;background:#e8e0cb;color:#2a1e14;border-radius:6px;padding:18px 18px 16px;
    box-shadow:0 14px 34px rgba(0,0,0,.5);font:16px 'IM Fell English',Georgia,serif">${inner}</div>`;
  document.body.appendChild(lobbyEl);
  return lobbyEl;
}

const btn = (label, attrs = '', bg = '#2a1e14', fg = '#fbf6ea') =>
  `<button ${attrs} style="font:inherit;min-height:42px;padding:8px 14px;border:0;border-radius:4px;cursor:pointer;background:${bg};color:${fg}">${label}</button>`;

/* An iPhone opens every link in Safari, never in the home-screen app, and the
   app and Safari keep separate storage, so they count as different players.
   The code is therefore the main way in, and a phone that has opened an invite
   in the browser is told how to use it in the app instead. */
const inBrowserOnPhone = () => /iPhone|iPad|Android/i.test(navigator.userAgent)
  && !(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) && !navigator.standalone;

export function openLobby({ joinCode } = {}){
  const name = localStorage.getItem('fc-name') || '';
  const last = localStorage.getItem('fc-last-code') || '';
  const appHint = joinCode && inBrowserOnPhone()
    ? `<div style="background:#f6efd9;border-left:4px solid #5b6b3a;padding:8px 10px;margin:0 0 12px;font-size:15px">
         Playing from the Field Command app on your home screen? Open it, tap <b>Play Online</b> and enter
         <b style="letter-spacing:.06em">${esc(joinCode.toUpperCase())}</b>. Or carry on here in the browser.</div>` : '';
  const el = lobbyShell(`
    <div style="font-family:'Petit Formal Script',cursive;font-size:26px;margin-bottom:6px">Play online</div>
    ${appHint}
    ${last && !joinCode ? `<div style="margin:0 0 10px">${btn(`Rejoin game ${esc(last)}`, 'id="olRejoin"', '#5b6b3a')}</div>` : ''}
    <label style="display:block;margin:4px 0">Your name</label>
    <input id="olName" value="${esc(name)}" maxlength="40" style="font:inherit;width:100%;padding:8px;border:1px solid #9a8b6c;border-radius:4px">
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
      ${btn('New game as Britain', 'data-side="red"', '#a3403a')}
      ${btn('New game as France', 'data-side="blue"', '#2e4566')}
    </div>
    <label style="display:block;margin:14px 0 4px">Or join with a code</label>
    <div style="display:flex;gap:8px"><input id="olCode" maxlength="6" value="${esc(joinCode || '')}"
      style="font:inherit;flex:1;min-width:8ch;padding:8px;border:1px solid #9a8b6c;border-radius:4px;text-transform:uppercase">${btn('Join', 'id="olJoin"')}</div>
    <p id="olStatus" style="min-height:1.4em;margin:12px 0 0;font-style:italic"></p>
    <div style="text-align:right;margin-top:6px">${btn('Close', 'id="olClose"', 'transparent', '#2a1e14')}</div>`);
  const status = (t, bad) => { const p = el.querySelector('#olStatus'); p.textContent = t; p.style.color = bad ? '#9b1c1c' : '#2a1e14'; };
  const getName = () => {
    const n = el.querySelector('#olName').value.trim();
    if(!n){ status('Put your name in first.', true); return null; }
    localStorage.setItem('fc-name', n); return n;
  };
  el.querySelector('#olClose').onclick = () => { closeLobby(); history.replaceState(null, '', location.pathname); };
  el.querySelectorAll('[data-side]').forEach(b => b.onclick = async () => {
    const n = getName(); if(!n) return;
    try { status('Connecting...'); await start(await (await transport()).create(b.dataset.side, n), n, true); }
    catch(e){ status(friendly(e), true); }
  });
  const doJoin = async () => {
    const n = getName(); if(!n) return;
    try { status('Joining...'); const t = await transport(); await start(await t.join(el.querySelector('#olCode').value, n), n, false); }
    catch(e){ status(friendly(e), true); }
  };
  el.querySelector('#olJoin').onclick = doJoin;
  const rejoin = el.querySelector('#olRejoin');
  if(rejoin) rejoin.onclick = () => { el.querySelector('#olCode').value = last; doJoin(); };
  if(joinCode && name) doJoin();
}

function friendly(e){
  const m = (e && e.message) || String(e);
  if(/version mismatch/i.test(m)) return 'You are on different versions of the game. Both of you reload the page, then try again.';
  if(/no match/i.test(m)) return 'No game with that code. Check the letters and try again.';
  if(/full/i.test(m)) return 'That game already has two players.';
  if(/anonymous/i.test(m)) return 'Guest sign-in is switched off in Supabase.';
  return m;
}

async function transport(){
  if(T) return T;
  T = new URLSearchParams(location.search).get('onlineTransport') === 'local' ? localTransport() : await supabaseTransport();
  await T.signIn();
  return T;
}

async function start(match, myName, createdHere){
  const me = await T.signIn();
  const mySide = match.red_player === me ? SIDES.RED : SIDES.BLUE;
  const remoteSide = mySide === SIDES.RED ? SIDES.BLUE : SIDES.RED;
  const isHost = match.created_by ? match.created_by === me : createdHere;
  localStorage.setItem('fc-last-code', match.code);
  setOnlineSession({ matchId: match.id, code: match.code, mySide, remoteSide, isHost,
    names: { red: match.red_name, blue: match.blue_name, [mySide]: myName } });
  history.replaceState(null, '', `${location.pathname}?join=${match.code}${location.search.includes('onlineTransport=local') ? '&onlineTransport=local' : ''}`);

  await T.open(match.id, { onMessage, onPresence, onStatus: st => {
    if(st === 'SUBSCRIBED') T.send({ type: 'hello' });
  } }, { name: myName, side: mySide });

  /* Coming back to a match already under way: pick up the saved battle. */
  const saved = (await T.load(match.id)) || match;
  if(saved && saved.state && saved.state.battle) applyBattle(saved.state.battle, saved.state.seq || 0);

  setRemoteDeployHandler(askGuestToDeploy);
  setRemoteAsker(askOther);
  setDiceMirror((kind, args) => T.send({ type: 'dice', kind, args }));
  startSync();
  if(!inBattle) waitingRoom();
  updatePill();
}

function waitingRoom(){
  const s = onlineSession();
  const url = `${location.origin}${location.pathname}?join=${s.code}`;
  const el = lobbyShell(`
    <div style="font-family:'Petit Formal Script',cursive;font-size:26px">Game ${esc(s.code)}</div>
    <p style="margin:2px 0 6px;font-size:14px">Your opponent enters this code under <b>Play Online</b>, or taps your invite.</p>
    <p style="margin:6px 0">You are <b>${SIDE_LABEL[s.mySide]}</b>.</p>
    <p id="olWho" style="margin:6px 0;font-style:italic"></p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
      ${btn('Send invite link', 'id="olShare"')}
      ${s.isHost ? btn('Set up the battle', 'id="olStart"', '#5b6b3a') : ''}
    </div>
    <p style="margin:12px 0 0;font-size:14px">${s.isHost
      ? 'You set up the battle. You each choose your own army when your turn to deploy comes; your opponent chooses on their phone.'
      : 'Your opponent is setting up the battle. When it is your turn to deploy, the armies appear here for you to choose from.'}</p>`);
  el.querySelector('#olShare').onclick = async () => {
    const text = `Join my Field Command battle. Code: ${s.code}\n\nIn the Field Command app, tap Play Online and enter the code. Or open this link:`;
    if(navigator.share){ try { await navigator.share({ title: 'Field Command', text, url }); return; } catch {} }
    try { await navigator.clipboard.writeText(`${text} ${url}`); el.querySelector('#olWho').textContent = 'Invite copied.'; } catch {}
  };
  const startBtn = el.querySelector('#olStart');
  if(startBtn) startBtn.onclick = async () => {
    closeLobby();
    state.scenario = null; state.campaign = null;
    state.mode = 'ai'; state.spectate = false; state.aiDifficulty = 'hard';
    state.aiSide = s.remoteSide;
    const { beginBoardSetup } = await import('./ui-menus.js');
    beginBoardSetup();
    /* The map is generated synchronously inside beginBoardSetup, so it can go
       across at once and the guest's intro plays alongside the host's. */
    setupStarted = true;
    lastShared = pack();
    T.send({ type: 'setup', battle: lastShared });
  };
  updateLobby();
}

function updateLobby(){
  const s = onlineSession(); if(!s || !lobbyEl) return;
  const who = lobbyEl.querySelector('#olWho'); if(!who) return;
  const them = present.find(p => p && p.side === s.remoteSide);
  who.textContent = them ? `${them.name} is here.` : 'Waiting for your opponent to join...';
}

/* ---------------------------------------------------------
   THE MATCH RECORD. Each phone records only the turns it ran (the record is
   too big to send with every update), so when the match ends each sends its
   half to the other and both merge them by turn. That is what makes Watch
   Replay and Export Full Match Log complete on both phones. Sent in pieces,
   since a whole match can run to hundreds of kilobytes.
--------------------------------------------------------- */
const RECORD_PIECE = 60000;
let recordSent = false;
const recordPieces = {};
function sendRecord(){
  if(recordSent || !T) return;
  recordSent = true;
  const body = JSON.stringify({ log: state.matchLog || [], start: state.replayStartUnits || null });
  const id = Math.random().toString(36).slice(2);
  const n = Math.max(1, Math.ceil(body.length / RECORD_PIECE));
  for(let i=0; i<n; i++){
    setTimeout(() => T.send({ type:'record', id, i, n, part: body.slice(i*RECORD_PIECE, (i+1)*RECORD_PIECE) }), i*150);
  }
}
function onRecord(p){
  const parts = recordPieces[p.id] = recordPieces[p.id] || [];
  parts[p.i] = p.part;
  if(parts.filter(x => x != null).length < p.n) return;
  delete recordPieces[p.id];
  let rec; try { rec = JSON.parse(parts.join('')); } catch { return; }
  mergeRecord(rec);
  sendRecord();   // if this phone has not sent its half yet, it does now
}
let recordMerged = false;
export function mergeRecord(rec){
  if(recordMerged) return;
  recordMerged = true;
  const mine = (state.matchLog || []).map((e, i) => ({ e, i, src:0 }));
  const theirs = (rec.log || []).map((e, i) => ({ e, i, src:1 }));
  const all = mine.concat(theirs);
  // Every event of a turn was recorded on the one phone that ran that turn, so
  // sorting by turn (keeping each phone's own order within it) rebuilds the match.
  all.sort((a, b) => (a.e.turn || 0) - (b.e.turn || 0) || a.src - b.src || a.i - b.i);
  state.matchLog = all.map(x => x.e);
  if(!state.replayStartUnits && rec.start) state.replayStartUnits = rec.start;
  renderEndButtons();
}
