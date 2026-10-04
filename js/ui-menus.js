import { offerBeginBattle } from './ui-deployment.js';
import { abandonCampaign, aiChooses, applyBattleMap, campaignFinished, cardForStep, choose, chooserFor, flowById, flowReady, loadCampaign, startCampaign, tally } from './campaign-play.js';
import { getCard, readyCards } from './scenario-cards.js';
import { operationBriefHTML, redrawOperation, setupOperation } from './operations.js';
import { showObjectivePanel } from './operation-panel.js';
import { abandonSave, loadSave, resumeSave } from './match-save.js';
import { isOnline } from './online-session.js';
import { SIDES, SIDE_COLOR, SIDE_LABEL, TB_DATA, assignBuildingStyles, assignGrassStyles, buildExcludedRoadEdgeSet, buildExcludedRoadEdgeSetGrand, buildTerrainMap, buildTerrainMapGrand, COLS, ROWS, generateGrandQuadrants, setBoardMode, state, UNIT_TYPES, UNIT_ARCHIVE } from './data-core.js';
import { FAST_DICE_MODE, showDice } from './dice.js';
import { rollD6, seededRandom } from './engine-rules.js';
import { log, resetUndoStack, syncPhaseButtons } from './engine-state.js';
import { beginDiagramMode, clearTransientRenderState, draw, endDiagramMode, playBoardIntroAnimation, sizeCanvas, sy, toScreen } from './render-board.js';
import { AmbientLayer } from './ambient-layer.js';
import { AudioManager } from './audio-manager.js';
import { beginFightPhase, beginFirePhase, beginMovePhase, endMovePhase, renderBrigadeStatus, selectUnit, updateHeader } from './ui-battle.js';
import { maybeStartAutoEnd } from './phase-autoend.js';
import { deployArmyComposition, planArmyDeployment, planGroupArmy } from './ai-deployment.js';
import { initDeployment, showRosterIfNeeded } from './ui-deployment.js';

/* THE BATTLE SCORE. Two tracks, played in turn rather than one on repeat, and
   the opening track rotates between battles so two matches in a row do not start
   with the same bars. Declared once here because both entry points into a battle
   (standard and grand) must use the same score; two literals drifted apart is
   exactly how the menu ends up playing something the battle does not. */
/* NO BATTLE SCORE. Battles are played without music, by request. Starting a
   battle stops the menu tune rather than replacing it. The tracks are still on
   disk (field-of-austerlitz.mp3, battle-score-1/2.m4a): to bring a score back,
   replace stopMusic() at both battle starts below with
   playMusicSequence([...files]). */

export function showOverlay(title, html, btnLabel, onClick){
  const b = document.querySelector('#overlay .box');
  if(b) b.classList.remove('as-folio', 'as-victory');
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
/* =========================================================
   THE TITLE SCREEN (Matthew, 4 Oct 2026)

   The game opens on the map: a random battlefield falls into place (the board
   intro), the clouds come in, and the menu appears as a row of buttons along
   the bottom, under the "Grognards" title, instead of the old parchment
   panel. Every other screen (choosing a side, Operations, Campaigns, the
   lobbies) still uses the map panels; going back from them returns here.

   Each button is an object of the period (art by Matthew, briefs in the chat
   of 4 Oct): it shows assets/ui/menu/<id>.webp when that file exists, and a
   plain brass disc with the label until then. The title likewise shows
   assets/ui/title_grognards.webp when it exists, a lettered title until then.
========================================================= */
/* Which pieces of art are in the repo. Only those are requested, so a missing
   file never shows a broken image or logs a 404: add an id here (and the
   title flag) when its file lands in assets/ui/menu/ (assets/ui/). */
const MENU_ART_READY = new Set(['ai', 'online', 'group', 'spectate', 'operations', 'campaigns', 'resume', 'again']);   // all eight, 4 Oct 2026
const TITLE_ART_READY = true;   // Matthew's Grognards title, 4 Oct 2026
export const MENU_ART = {
  ai: 'cuirass', online: 'despatch', group: 'drum', spectate: 'spyglass',
  operations: 'cannonballs', campaigns: 'campaign-map', resume: 'pocket-watch', again: 'shako',
};
/* A random battlefield for the title (Math.random, never the dice generator,
   so a match's seed still replays the same match). */
export function prepareTitleBoard(){
  setBoardMode('standard');
  const keys = Math.random() < 0.5 ? ['A','B'] : ['B','A'];
  state.boardAssignment = { red: keys[0], blue: keys[1] };
  state.boardRotation = { red: Math.floor(Math.random()*4), blue: Math.floor(Math.random()*4) };
  state.terrain = buildTerrainMap(state.boardAssignment, state.boardRotation);
  state.grassStyles = assignGrassStyles(state.terrain);
  state.buildingStyles = assignBuildingStyles(state.terrain);
  state.excludedRoadEdges = buildExcludedRoadEdgeSet(state.boardAssignment, state.boardRotation);
  state.units = [];
}
function ensureTitleMenu(){
  let bar = document.getElementById('titleMenu');
  if(!bar){
    bar = document.createElement('nav');
    bar.id = 'titleMenu';
    bar.setAttribute('aria-label', 'Main menu');
    document.body.appendChild(bar);
    const mark = document.createElement('div');
    mark.id = 'titleMark';
    const titleArt = 'assets/ui/title_grognards.webp';
    mark.innerHTML = (TITLE_ART_READY ? `<img alt="Grognards" src="${titleArt}">` : '') + '<span class="tm-text">Grognards</span>';
    const img = mark.querySelector('img');
    if(img){ img.onload = ()=> mark.classList.add('has-art'); img.onerror = ()=> img.remove(); }
    document.body.appendChild(mark);
    // Any screen that takes the overlay (side select, Operations, a lobby...)
    // puts the title away; coming back to the menu brings it out again.
    new MutationObserver(()=>{
      const shown = document.getElementById('overlay').classList.contains('show');
      document.documentElement.classList.toggle('title-hidden', shown);
    }).observe(document.getElementById('overlay'), { attributes:true, attributeFilter:['class'] });
  }
  return bar;
}
/* Dresses a menu button as its object: the art if there is any, the label
   under it either way. */
function menuItem(btn, id){
  const label = btn.textContent;
  btn.classList.remove('primary', 'same-again');   // the object is the button; no panel-button styling
  btn.classList.add('title-item');
  /* Every screen these lead to is drawn in the overlay panel, which the title
     screen keeps hidden: bring it back before the button's own handler runs
     (those that start a battle hide it again themselves). */
  /* Leaving the title screen: the title and the row go away for good (until
     showModeSelect brings them back), whether the next thing is a panel or
     straight into a battle. 4 Oct 2026: they were tied to the panel being
     hidden, so a battle (which hides the panel) brought them back over the
     board. */
  btn.addEventListener('click', ()=>{
    document.documentElement.classList.add('title-away');
    document.getElementById('overlay').classList.add('show');
  }, { capture: true });
  btn.dataset.item = id;
  const art = MENU_ART_READY.has(id) ? `<img alt="" src="assets/ui/menu/${MENU_ART[id]}.webp">` : '';
  btn.innerHTML = `<span class="ti-art">${art}</span><span class="ti-label"></span>`;
  btn.querySelector('.ti-label').textContent = label;
  const img = btn.querySelector('img');
  if(img){ img.onload = ()=> btn.classList.add('has-art'); img.onerror = ()=> img.remove(); }
  return btn;
}

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

/* Operations and Campaigns are parked.
   TRIAGE.md C1: 12 of the 28 Operation side-rosters are too small to field the
   3 Brigades of 2+ units that deployment demands, which makes 11 of the 14
   Operations unreachable. The failure is silent and unrecoverable — no unit
   chips render, Confirm stays disabled, and only a page reload gets out. The
   AI path stalls mid-deployment with no log entry. Rather than leave a menu
   entry that dead-ends the game, the entry points are withdrawn until the
   roster question is settled.

   Nothing downstream is deleted. Flip this to true to bring both back. */
// Remembers the last completed setup so the start screen can offer it back as a
// single tap. Three taps to reach a battle is fine the first time and tiresome by
// the tenth. Stored under the fc: prefix used by the other display preferences.
const LAST_SETUP_KEY = 'fc:lastSetup';

function saveLastSetup(){
  try {
    localStorage.setItem(LAST_SETUP_KEY, JSON.stringify({
      aiSide: state.aiSide, difficulty: state.aiDifficulty,
    }));
  } catch { /* private mode — the seal simply will not appear next time */ }
}

function loadLastSetup(){
  try {
    const raw = localStorage.getItem(LAST_SETUP_KEY);
    if(!raw) return null;
    const v = JSON.parse(raw);
    // Guard the shape rather than trusting it: a stale or hand-edited entry must
    // not be able to start a battle with a nonsense side or difficulty.
    const okSide = v && (v.aiSide === SIDES.RED || v.aiSide === SIDES.BLUE);
    const okDiff = v && ['easy','medium','hard'].includes(v.difficulty);
    return (okSide && okDiff) ? v : null;
  } catch { return null; }
}

export const OPERATIONS_ENABLED = true;    // Operations: the ready Scenario Cards (Operations and Campaigns brief, step 2)
/* Campaigns stay hidden until step 6 (campaign play from the logs). This gates
   the Campaigns button and the boot-time resume path. */
export const CAMPAIGNS_ENABLED = true;   // Campaigns: Flanders playable end to end (4 Oct 2026); flows not ready show as coming
// Grand Strategy joins Operations and Campaigns in being parked for the
// Commander's Desk pass. Same treatment: the entry point is simply not
// offered, showGrandMatchTypeSelect and everything downstream are untouched
// and still exported, so restoring it is flipping this to true.
export const GRAND_STRATEGY_ENABLED = false;

export function showModeSelect(isSplash){
  /* The menu theme, every time the mode select is shown. That covers the first
     load AND returning here after a battle, when the field score would
     otherwise still be playing over the menus. Putting it on the screen itself
     rather than on each of the routes into it means a new route cannot forget.
  
     Harmless when it is already playing: playMusic only replaces the element if
     the source has changed, so moving between the mode, side and difficulty
     screens never interrupts the track. */
  AudioManager.fadeOutEffects('turn-theme-', 800);   // leaving a battle mid-theme
  AudioManager.playMusic('audio/music/menu-musket-tango.mp3');
  const box = document.querySelector('#overlay .box');
  // The folio backing is start-screen only. Every other overlay reuses this
  // same .box, so the class has to be removed by whoever leaves — done in
  // clearFolio() below, called from each screen that takes over the box.
  box.classList.remove('as-victory');
  box.classList.add('as-folio');
  const titleEl = document.getElementById('overlayTitle');
  const subtitleEl = document.getElementById('overlaySubtitle');
  titleEl.textContent = 'TravelBattle';
  document.getElementById('overlayText').innerHTML = 'Full army, solo skirmish engine. Deploy 3 Brigades per side, alternating, across the first two rows of your board edge, then fight it out. Break 2 of the enemy\'s 3 Brigades to win.';
  document.getElementById('overlayBtn').style.display = 'none';
  subtitleEl.style.display = 'block';
  // The menu is the row of objects on the title screen, not the panel.
  document.getElementById('overlay').classList.remove('show');
  document.documentElement.classList.remove('title-hidden', 'title-away');
  // The panel's own button area still exists for every other screen to fill.
  const panelChoices = ensureModeChoices(); panelChoices.innerHTML = ''; panelChoices.style.display = 'none';
  const extra = ensureTitleMenu();
  extra.innerHTML = '';
  extra.style.display = '';   // shown by the stylesheet, hidden by html.title-away / title-hidden
  extra.classList.toggle('arriving', !!isSplash);
  // The title splash treatment only ever plays on the genuine first-load screen —
  // every other route back to this menu (back buttons, campaign-not-found
  // fallback) shows everything instantly, a re-run fade would just feel laggy.
  titleEl.classList.remove('splash-title-group');
  subtitleEl.classList.remove('splash-title-group');
  extra.classList.remove('splash-buttons-group');
  document.getElementById('overlayText').classList.remove('splash-buttons-group');
  // (The old panel's splash fade is gone: the title screen has its own arrival, CSS .arriving.)
  const aiBtn = document.createElement('button');
  aiBtn.className = 'primary';
  aiBtn.textContent = 'vs AI Opponent';
  aiBtn.onclick = ()=>{ state.scenario=null; state.campaign=null; state.spectate=false; extra.style.display='none'; showSideSelect(); };
  /* SPECTATE. Sets mode 'ai' like a normal match, plus state.spectate, which is
     the only thing that distinguishes it: everywhere the game asks "is the side
     to act the AI's side", spectate answers yes by pointing aiSide at whoever is
     acting. The AI then deploys both armies, picks both board orientations and
     plays both sides, using the same scoring for each. */
  const spectateBtn = document.createElement('button');
  spectateBtn.textContent = 'Spectate (AI vs AI)';
  spectateBtn.onclick = ()=>{
    state.scenario = null; state.campaign = null;
    state.mode = 'ai';
    state.spectate = true;
    state.aiDifficulty = 'hard';
    state.aiSide = SIDES.RED;   // re-pointed at the acting side from here on
    extra.style.display = 'none';
    beginBoardSetup();
  };
  const opsBtn = document.createElement('button');
  opsBtn.textContent = 'Operations';
  opsBtn.onclick = ()=>{ state.campaign=null; state.spectate=false; extra.style.display='none'; showOperationsMenu(); };
  const campBtn = document.createElement('button');
  campBtn.textContent = 'Campaigns';
  campBtn.onclick = ()=>{ state.spectate=false; showCampaignsList(); };
  const grandBtn = document.createElement('button');
  grandBtn.textContent = 'Grand Strategy (4 boards)';
  grandBtn.onclick = ()=>{ state.spectate=false; extra.style.display='none'; showGrandMatchTypeSelect(); };
  // Hotseat (2 players) removed from the home menu for now — beginBoardSetup()
  // and everything it needs is untouched, so this is just the one entry point
  // no longer being offered, easy to re-add later.
  extra.appendChild(menuItem(aiBtn, 'ai'));
  /* ONLINE. Loaded on demand, so the Supabase client is only ever downloaded
     by someone who chooses to play online. */
  const onlineBtn = document.createElement('button');
  onlineBtn.className = 'primary';
  onlineBtn.textContent = 'Play Online';
  onlineBtn.onclick = ()=>{ import('./online.js').then(m => m.openLobby()); };
  extra.appendChild(menuItem(onlineBtn, 'online'));
  /* ONLINE GROUP: the four-army 2v2 mode. Loaded on demand like Play Online. */
  const groupBtn = document.createElement('button');
  groupBtn.textContent = 'Online Group';
  groupBtn.onclick = ()=>{ state.spectate=false; extra.style.display='none'; import('./ui-group.js').then(m => m.showGroupMenu()); };
  extra.appendChild(menuItem(groupBtn, 'group'));
  extra.appendChild(menuItem(spectateBtn, 'spectate'));
  // Operations and Campaigns are parked — see OPERATIONS_ENABLED. Same treatment
  // as Hotseat above: the entry point is simply not offered. showOperationsMenu,
  // showCampaignMenu and everything downstream are untouched and still exported,
  // so restoring them is deleting one line.
  // Campaigns and Operations sit next to vs AI: the solo games first.
  if(CAMPAIGNS_ENABLED) extra.insertBefore(menuItem(campBtn, 'campaigns'), extra.children[1] || null);
  if(OPERATIONS_ENABLED) extra.insertBefore(menuItem(opsBtn, 'operations'), extra.children[2] || null);
  if(GRAND_STRATEGY_ENABLED) extra.appendChild(grandBtn);

  /* RESUME (match-save.js): a battle against the AI left unfinished on this
     phone goes back to where it was. Read from storage after the screen is
     built (it is asynchronous), and added at the top only if the start screen
     is still the one showing by then. */
  loadSave().then(save => {
    if(!save || document.documentElement.classList.contains('title-hidden') || extra.querySelector('.resume-battle')) return;
    const sm = save.summary || {};
    const you = sm.playerSide === SIDES.BLUE ? 'France' : 'Britain';
    const mins = Math.max(0, Math.round((Date.now() - save.savedAt) / 60000));
    const ago = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} d ago`;
    // The first object in the row: the pocket watch. Its line under the label
    // says where the battle stands; the small cross beside it discards it.
    const wrap = document.createElement('div');
    wrap.className = 'resume-battle';
    const go = document.createElement('button');
    go.type = 'button';
    go.textContent = 'Resume Battle';
    menuItem(go, 'resume');
    const sub = document.createElement('span');
    sub.className = 'ti-sub';
    sub.textContent = `${sm.operation ? sm.operation + ' · ' : ''}round ${sm.round || 1} · ${you} · ${ago}`;
    go.appendChild(sub);
    go.title = `${sm.alive ? `${sm.alive.red}–${sm.alive.blue} units standing, ` : ''}saved ${ago}`;
    go.onclick = ()=> resumeBattle(save);
    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'resume-drop';
    drop.setAttribute('aria-label', 'Discard the saved battle');
    drop.textContent = '\u00d7';
    drop.onclick = ()=>{ abandonSave().then(()=> wrap.remove()); };
    wrap.appendChild(go); wrap.appendChild(drop);
    extra.insertBefore(wrap, extra.firstChild);
  });

  // Same Again: one tap back into the last setup. Deliberately smaller and lower
  // than the primary action so it never competes with it, and absent entirely on
  // a first run when there is nothing to repeat.
  const last = loadLastSetup();
  if(last){
    const side = last.aiSide === SIDES.BLUE ? 'Britain' : 'France';
    const again = document.createElement('button');
    again.textContent = 'Same Again \u00B7 ' + side;
    menuItem(again, 'again');
    again.onclick = ()=>{
      state.scenario = null; state.campaign = null;
      state.mode = 'ai';
      state.aiSide = last.aiSide;
      state.aiDifficulty = 'hard';      // one AI level for now (see showSideSelect)
      extra.style.display = 'none';
      document.getElementById('overlay').classList.remove('show');
      beginBoardSetup();
    };
    extra.appendChild(again);
  }
  // The title screen: the board shows, the panel does not.
  document.getElementById('overlay').classList.remove('show');
  document.documentElement.classList.remove('title-hidden', 'title-away');
}

/* Puts a saved battle back on the board (match-save.js does the state; this
   does the screen, as startBattle and beginOperation do for a new one). */
export function resumeBattle(save){
  document.documentElement.classList.add('title-away');   // a battle is starting: the title screen goes
  resumeSave(save, {
    prepare(){
      AudioManager.stopMusic();
      clearFolio();
      document.getElementById('overlay').classList.remove('show');
      document.getElementById('sidebar').style.display = 'none';
      const uo = document.getElementById('unitOverlay');
      uo.classList.remove('hidden'); uo.classList.remove('show');
      clearTransientRenderState();
      resetUndoStack();
      redrawOperation();
      startAmbientLayer();
      renderBrigadeStatus();
      if(state.scenario && state.scenario.kind === 'operation') showObjectivePanel();
      log(`Battle resumed: round ${Math.max(1, Math.ceil((state.turnNumber || 1) / 2))}.`, 'system');
    },
    beginMove: ()=> beginMovePhase(),
    beginFire: ()=> beginFirePhase(),
    beginFight: ()=> beginFightPhase(),
    continueHere(){
      selectUnit(null);
      syncPhaseButtons();
      updateHeader();
      draw();
      maybeStartAutoEnd();
    },
  });
}

/* =========================================================
   CAMPAIGNS (campaign-play.js holds the progress and the rules of the flow;
   these are its screens). Playable on this phone against the AI.
========================================================= */
function campaignBox(title, html){
  clearFolio();
  const box = document.querySelector('#overlay .box');
  box.classList.add('as-folio', 'as-sides-screen');
  document.getElementById('overlayTitle').textContent = title;
  document.getElementById('overlayText').innerHTML = html;
  document.getElementById('overlayBtn').style.display = 'none';   // the victory screen's own button, if we came from one
  box.classList.remove('as-victory');
  const extra = document.getElementById('modeChoices');
  extra.innerHTML = ''; extra.className = 'as-ops'; extra.style.display = 'flex';
  document.getElementById('overlay').classList.add('show');
  return extra;
}
function campBtn(extra, label, sub, onClick, cls = 'op-choice'){
  const b = document.createElement('button');
  b.type = 'button'; b.className = cls;
  b.innerHTML = '<span class="op-name"></span>' + (sub ? '<span class="op-arch"></span>' : '');
  b.querySelector('.op-name').textContent = label;
  if(sub) b.querySelector('.op-arch').textContent = sub;
  if(onClick) b.onclick = onClick; else b.disabled = true;
  extra.appendChild(b);
  return b;
}
export function showCampaignsList(){
  const extra = campaignBox('Campaigns', 'A run of Battles and Operations, played in order. The winner of each Battle chooses the Operation that follows; the side that wins more of the five takes the campaign.');
  const p = loadCampaign();
  if(p && flowById(p.id)){
    const f = flowById(p.id);
    campBtn(extra, `Continue: ${f.name}`, campaignFinished(p) ? 'finished, see the result' : `step ${Math.min(p.step + 1, f.steps.length)} of ${f.steps.length} · you are ${p.playerSide === SIDES.RED ? 'Britain' : 'France'}`, ()=> showCampaignScreen());
  }
  for(const f of (TB_DATA.campaigns || [])){
    const ready = flowReady(f);
    campBtn(extra, f.name, ready ? `${f.years} · ${f.steps.length} engagements` : `${f.years} · coming soon`, ready ? ()=> showCampaignSide(f) : null);
  }
  campBtn(extra, 'Back', null, ()=> showModeSelect(), 'op-back');
}
function showCampaignSide(f){
  campaignBox(f.name, `<div class="op-brief"><div class="op-date">${f.years}</div><p class="op-intro">${f.brief}</p>` +
    (loadCampaign() ? '<p class="op-limit">Starting this replaces the campaign in progress.</p>' : '') + '<div class="op-pick">Choose your side</div></div>');
  const extra = document.getElementById('modeChoices');
  extra.className = 'as-sides';
  const side = (svg, name, mine) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'side-flag'; b.setAttribute('aria-label', name); b.innerHTML = svg;
    b.onclick = ()=>{ startCampaign(f.id, mine); showCampaignScreen(); }; extra.appendChild(b); };
  side(FLAG_BRITAIN, 'Britain', SIDES.RED); side(FLAG_FRANCE, 'France', SIDES.BLUE);
  const back = document.createElement('button'); back.type = 'button'; back.className = 'op-back'; back.textContent = 'Back'; back.onclick = ()=> showCampaignsList(); extra.appendChild(back);
}
/* The campaign's own page: every step with its result, the score, and what
   comes next (play it, or choose it). */
export function showCampaignScreen(){
  const p = loadCampaign();
  if(!p || !flowById(p.id)){ showCampaignsList(); return; }
  const f = flowById(p.id);
  const t = tally(p);
  const me = p.playerSide, you = me === SIDES.RED ? 'Britain' : 'France';
  const rows = f.steps.map((s, i) => {
    const r = p.results[i];
    const c = cardForStep(p, i);
    const name = c ? c.name : (s.type === 'branch' ? s.options.map(id => getCard(id).name.replace(/^Battle of /, '')).join(' or ') : s.card);
    const mark = r ? `<b class="${r.winner}">${SIDE_LABEL[r.winner]} won</b>` : i === p.step ? '<b>next</b>' : '';
    return `<li class="${i === p.step ? 'now' : ''}"><span>${i + 1}. ${name}</span><span>${mark}</span></li>`;
  }).join('');
  const done = campaignFinished(p);
  const head = done
    ? `<p class="camp-result">${t.red === t.blue ? 'The campaign is drawn.' : `${t.red > t.blue ? 'Britain' : 'France'} wins the campaign, ${Math.max(t.red, t.blue)} engagements to ${Math.min(t.red, t.blue)}.`}</p>`
    : `<p class="op-date">You are ${you} · Britain ${t.red}, France ${t.blue}</p>`;
  const extra = campaignBox(f.name, `<div class="op-brief">${head}<ol class="camp-steps">${rows}</ol></div>`);
  if(done){
    campBtn(extra, 'New campaign', null, ()=>{ abandonCampaign(); showCampaignsList(); }, 'op-choice');
  } else {
    const s = f.steps[p.step];
    if(s.type === 'branch' && !p.choices[s.id]){
      const chooser = chooserFor(p, p.step);
      if(chooser === me){
        const sideOfCard = id => getCard(id);
        for(const id of s.options){ const c = sideOfCard(id); campBtn(extra, `Choose: ${c.name}`, `${c.archetype} · ${c.turnLimit} rounds`, ()=>{ choose(p, p.step, id); showCampaignScreen(); }); }
      } else {
        const id = aiChooses(p, p.step);
        choose(p, p.step, id);
        log(`${SIDE_LABEL[chooser]} won the last engagement and chooses ${getCard(id).name}.`, 'system');
        showCampaignScreen();
        return;
      }
    } else {
      const c = cardForStep(p, p.step);
      const chosenBy = s.type === 'branch' ? chooserFor(p, p.step) : null;
      campBtn(extra, `Play: ${c.name}`, `${c.kind === 'battle' ? 'Battle, three Brigades a side' : c.archetype + ' · ' + c.turnLimit + ' rounds'}${chosenBy ? ` · chosen by ${SIDE_LABEL[chosenBy]}` : ''}`, ()=> playCampaignStep(p, c, chosenBy));
    }
    campBtn(extra, 'Abandon campaign', null, ()=>{ abandonCampaign(); showCampaignsList(); }, 'op-back');
  }
  campBtn(extra, 'Back', null, ()=> showModeSelect(), 'op-back');
}
function playCampaignStep(p, card, chosenBy){
  document.documentElement.classList.add('title-away');   // a battle is starting: the title screen goes
  const f = flowById(p.id);
  state.campaignRun = { id: p.id, step: p.step, stepId: f.steps[p.step].id, cardId: card.id, chosenBy };
  state.campaign = null;
  if(card.kind === 'operation'){ beginOperation(card, p.playerSide); return; }
  // A Battle: equal armies, the Battle's own map, straight to deployment.
  abandonSave();
  AudioManager.stopMusic();
  state.scenario = null;
  state.mode = 'ai'; state.spectate = false; state.aiDifficulty = 'hard';
  state.aiSide = p.playerSide === SIDES.RED ? SIDES.BLUE : SIDES.RED;
  state.gameOver = false; state.winner = null;
  if(!applyBattleMap(card)){ setBoardMode('standard'); }
  sizeCanvas();
  document.getElementById('overlay').classList.remove('show');
  draw();
  startAmbientLayer();
  log(`${card.name}, ${card.date}. ${card.intro || ''}`, 'system');
  initDeployment();
}

/* OPERATIONS (Operations and Campaigns brief, 2.7): the ready Operation
   cards, then a pre-battle brief (name, date, intro, both sides' objectives,
   the round limit) where the player picks a side. One AI level (Marshal), so
   there is no difficulty step. */
export function showOperationsMenu(){
  clearFolio();
  const box = document.querySelector('#overlay .box');
  box.classList.add('as-folio', 'as-sides-screen');
  document.getElementById('overlayTitle').textContent = 'Operations';
  document.getElementById('overlayText').innerHTML =
    'Smaller actions from the period: unequal forces, each side with its own objective, a fixed number of rounds.';
  const extra = document.getElementById('modeChoices');
  extra.innerHTML = '';
  extra.className = 'as-ops';
  extra.style.display = 'flex';
  for(const card of readyCards('operation')){
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'op-choice';
    b.innerHTML = '<span class="op-name"></span><span class="op-arch"></span>';
    b.querySelector('.op-name').textContent = card.name;
    b.querySelector('.op-arch').textContent = `${card.archetype || 'Operation'} · ${card.date}`;
    b.onclick = ()=> showOperationBrief(card);
    extra.appendChild(b);
  }
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'op-back';
  back.textContent = 'Back';
  back.onclick = ()=> showModeSelect();
  extra.appendChild(back);
  document.getElementById('overlay').classList.add('show');
}

export function showOperationBrief(card){
  clearFolio();
  const box = document.querySelector('#overlay .box');
  box.classList.add('as-folio', 'as-sides-screen');
  document.getElementById('overlayTitle').textContent = card.name;
  document.getElementById('overlayText').innerHTML = operationBriefHTML(card, null) + '<div class="op-pick">Choose your side</div>';
  const extra = document.getElementById('modeChoices');
  extra.innerHTML = '';
  extra.className = 'as-sides';
  extra.style.display = 'flex';
  const side = (flagSvg, name, mine) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'side-flag';
    b.setAttribute('aria-label', name);
    b.innerHTML = flagSvg;
    b.onclick = ()=>{ state.campaignRun = null; beginOperation(card, mine); };   // from the menu: not a campaign step
    return b;
  };
  extra.appendChild(side(FLAG_BRITAIN, 'Britain', SIDES.RED));
  extra.appendChild(side(FLAG_FRANCE, 'France', SIDES.BLUE));
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'op-back';
  back.textContent = 'Back';
  back.onclick = ()=> showOperationsMenu();
  extra.appendChild(back);
  document.getElementById('overlay').classList.add('show');
}

/* Sets the Operation up (locked map, both armies placed) and starts it: no
   orientation roll, no falling-tile intro, no deployment screen. */
export function beginOperation(card, playerSide){
  document.documentElement.classList.add('title-away');   // a battle is starting: the title screen goes
  if(isOnline() || state.group || state.rts) return;   // Online, Group and Real-Time never take a card
  AudioManager.stopMusic();
  abandonSave();   // a new battle replaces any saved one
  setupOperation(card, playerSide);
  document.getElementById('overlay').classList.remove('show');
  redrawOperation();
  startAmbientLayer();
  /* Not straight into battle any more (4 Oct 2026): both armies stand in
     their places, you can drag or tap your units to other squares in their
     area (or your own rows) or swap two, and Begin Battle starts it. */
  showObjectivePanel();
  offerBeginBattle();
  log('Arrange your units if you wish: drag one to another square in its area, or onto another of your units to swap them. Then Begin Battle.', 'system');
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


export function clearFolio(){
  const box = document.querySelector('#overlay .box');
  if(box) box.classList.remove('as-folio', 'as-victory');
}

/* CHOOSE YOUR SIDE, on the map panel like the start screen (Matthew, 1 Oct).
   It also carries the battle mode (Turn-Based or Real-Time), and choosing a
   side starts the battle: there is one AI level for now, the one all the AI
   work has gone into (Marshal, 'hard'), until it beats Matthew regularly
   enough to become the top of a ladder of easier levels. The old rank
   screen (showDifficultySelect) is kept below for that day, but is no longer
   reached. */
const FLAG_BRITAIN = '<svg viewBox="0 0 60 30" preserveAspectRatio="none" aria-hidden="true"><clipPath id="ujc"><path d="M0,0 v30 h60 v-30 z"/></clipPath><clipPath id="ujt"><path d="M30,15 h30 v15 z v15 h-30 z h-30 v-15 z v-15 h30 z"/></clipPath><g clip-path="url(#ujc)"><path d="M0,0 v30 h60 v-30 z" fill="#012169"/><path d="M0,0 L60,30 M60,0 L0,30" stroke="#fff" stroke-width="6"/><path d="M0,0 L60,30 M60,0 L0,30" clip-path="url(#ujt)" stroke="#C8102E" stroke-width="4"/><path d="M30,0 v30 M0,15 h60" stroke="#fff" stroke-width="10"/><path d="M30,0 v30 M0,15 h60" stroke="#C8102E" stroke-width="6"/></g></svg>';
const FLAG_FRANCE = '<svg viewBox="0 0 3 2" preserveAspectRatio="none" aria-hidden="true"><rect width="1" height="2" x="0" fill="#002395"/><rect width="1" height="2" x="1" fill="#fff"/><rect width="1" height="2" x="2" fill="#ED2939"/></svg>';
export function showSideSelect(){
  clearFolio();
  const box = document.querySelector('#overlay .box');
  box.classList.add('as-folio', 'as-sides-screen');   // as-sides-screen: no strapline (index.html)
  document.getElementById('overlayTitle').textContent = 'Choose Your Side';
  document.getElementById('overlayText').innerHTML =
    'The AI takes the other side and will deploy, move, fire and fight on its own turns.' + modeToggleHtml();
  wireModeToggle();
  let extra = document.getElementById('modeChoices');
  extra.innerHTML = '';
  extra.className = 'as-sides';
  extra.style.display = 'flex';
  /* Each side is just its flag (Matthew, 1 Oct): the Union Flag and the
     tricolour, drawn as SVG so they stay crisp at any size. The name is there
     for screen readers. */
  const side = (flagSvg, name, aiSide) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'side-flag';
    b.setAttribute('aria-label', name);
    b.innerHTML = flagSvg;
    b.onclick = ()=>{
      state.mode = 'ai'; state.aiSide = aiSide; state.aiDifficulty = 'hard';
      saveLastSetup();
      extra.style.display = 'none';
      document.getElementById('overlay').classList.remove('show');
      if(battleMode === 'rts'){ import('./rts/launch.js').then(m => m.launchRealTime()); return; }
      beginBoardSetup();
    };
    return b;
  };
  extra.appendChild(side(FLAG_BRITAIN, 'Britain', SIDES.BLUE));
  extra.appendChild(side(FLAG_FRANCE, 'France', SIDES.RED));
  // Back to the title screen (the menu is no longer a panel to fall back to).
  const back = document.createElement('button');
  back.type = 'button'; back.className = 'op-back'; back.textContent = 'Back';
  back.onclick = ()=> showModeSelect();
  extra.appendChild(back);
}

// Difficulty is presented as the opponent's rank on a service record. Chevrons
// read as a scale at a glance without being read, and Lieutenant/Colonel/Marshal
// is vocabulary from the game's own world rather than generic menu language.
// The stored values are unchanged, so nothing downstream of state.aiDifficulty
// needs to know this happened.
const RANKS = [
  { value:'easy',   rank:'Lieutenant', old:'Easy',
    line:'Straightforward and reactive. Takes the fight put in front of him.', chevrons:1 },
  { value:'medium', rank:'Colonel',    old:'Medium',
    line:'Finishes off weakened Brigades. Uses Charge and Attack Column deliberately.', chevrons:2 },
  { value:'hard',   rank:'Marshal',    old:'Hard',
    line:'Looks a step past the immediate trade, and lays ambushes proactively.', chevrons:3 },
];

function chevronSvg(n){
  const rows = [];
  const top = n === 1 ? 30 : (n === 2 ? 22 : 16);
  const gap = n === 3 ? 14 : 16;
  for(let i = 0; i < n; i++){
    const y = top + i*gap;
    rows.push(`M12 ${y}l18 -12 18 12`);
  }
  return `<svg viewBox="0 0 60 52" aria-hidden="true"><g fill="none" stroke="currentColor"
    stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round">
    <path d="${rows.join(' ')}"/></g></svg>`;
}

/* BATTLE MODE (rts-variant branch): Turn-Based, as always, or Real-Time.
   Turn-Based is the default and nothing about it changes. Real-Time lives
   entirely in js/rts/, reached through the one dynamic import below.

   REAL-TIME IS OFF THE LIVE GAME for now (Matthew, 4 Oct 2026): the switch is
   not shown and every battle is Turn-Based. The code stays in js/rts/ and on
   the rts-variant branch; set RTS_ENABLED back to true to offer it again. */
export const RTS_ENABLED = false;
let battleMode = 'turn';
function modeToggleHtml(){
  if(!RTS_ENABLED) return '';
  const b = (v, label) => `<button type="button" class="mode-btn${battleMode === v ? ' on' : ''}" data-mode="${v}" aria-pressed="${battleMode === v}">${label}</button>`;
  return `<span id="battleModeToggle" class="mode-toggle"><span class="mode-label">Battle</span>${b('turn','Turn-Based')}${b('rts','Real-Time')}</span>`;
}
function wireModeToggle(){
  document.querySelectorAll('#battleModeToggle [data-mode]').forEach(btn => btn.onclick = () => {
    battleMode = btn.dataset.mode;
    document.getElementById('battleModeToggle').outerHTML = modeToggleHtml();
    wireModeToggle();
  });
}

export function showDifficultySelect(){
  clearFolio();
  document.getElementById('overlayTitle').textContent = 'Your Opponent';
  document.getElementById('overlayText').innerHTML = modeToggleHtml();
  wireModeToggle();
  let extra = document.getElementById('modeChoices');
  extra.innerHTML = '';
  extra.className = 'as-records';
  extra.style.display = 'flex';
  extra.style.flexWrap = 'wrap';
  for(const r of RANKS){
    const b = document.createElement('button');
    b.className = 'record';
    b.innerHTML =
      '<span class="r-chev">' + chevronSvg(r.chevrons) + '</span>' +
      '<span class="r-name"></span><span class="r-old"></span><span class="r-line"></span>';
    b.querySelector('.r-name').textContent = r.rank;
    b.querySelector('.r-old').textContent  = r.old;
    b.querySelector('.r-line').textContent = r.line;
    b.onclick = ()=>{
      state.aiDifficulty = r.value;
      saveLastSetup();
      extra.style.display='none';
      document.getElementById('overlay').classList.remove('show');
      if(battleMode === 'rts'){ import('./rts/launch.js').then(m => m.launchRealTime()); return; }
      beginBoardSetup();
    };
    extra.appendChild(b);
  }
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
  document.documentElement.classList.add('title-away');   // a battle is starting: the title screen goes
  state.campaignRun = null;   // a standard match is not a campaign step
  // A new battle against the AI replaces any saved one (its record goes as an
  // incomplete match). Online and Group matches leave a saved AI battle alone.
  if(state.mode === 'ai' && !state.spectate && !isOnline() && !state.group) abandonSave();
  setBoardMode('standard');
  AudioManager.stopMusic();
  const keys = seededRandom()<0.5 ? ['A','B'] : ['B','A'];
  state.boardAssignment = { red: keys[0], blue: keys[1] };
  state.boardRotation = { red: Math.floor(seededRandom()*4), blue: Math.floor(seededRandom()*4) };
  state.terrain = buildTerrainMap(state.boardAssignment, state.boardRotation);
  state.grassStyles = assignGrassStyles(state.terrain);
  state.buildingStyles = assignBuildingStyles(state.terrain);
  state.excludedRoadEdges = buildExcludedRoadEdgeSet(state.boardAssignment, state.boardRotation);
  sizeCanvas();
  document.getElementById('overlay').classList.remove('show');
  // The falling-tile intro plays only for a standard (non-campaign) AI
  // match — not hotseat, not campaign/Operations restarts. It has to run
  // to completion before the orientation dice roll appears, since the
  // whole point is that it can't be skipped or interrupted.
  if(state.mode==='ai' && !state.campaign){
    /* Countryside ambience starts WITH the board reveal, so it comes in as the
       tiles land rather than a beat before or after them. Deliberately a
       separate stream from the score rather than a replacement: it plays over
       the music on its own volume category, so either can be turned down
       without touching the other.

       Started here rather than inside the renderer, which has no business
       knowing about audio. */
    AudioManager.playAmbience('audio/ambience/countryside.mp3');
    playBoardIntroAnimation(()=>{ startAmbientLayer(); rollOrientationOrder(); });
  } else {
    draw();
    startAmbientLayer();
    rollOrientationOrder();
  }
}

/* Ambient sky: clouds, their shadows, and birds.

   Started in BOTH branches on purpose: the falling-tile intro only plays for a
   standard non-campaign AI match, so hanging the layer off its onComplete alone
   would mean campaign battles never got any ambient motion at all. init() is
   idempotent (it returns early if its canvases already exist), so calling this
   again on a later board setup is harmless.

   boardEl is passed explicitly rather than left to the module's
   getElementById('board') default. The shadow pass clips to that element so
   nothing falls on the tabletop around the map, which makes it a load-bearing
   argument rather than an optional one — worth stating at the call site so
   renaming the board canvas breaks here loudly instead of silently spilling
   shadows onto the desk.

   The module creates two canvases in #boardWrap (#ambientShadows at z-index 9
   with mix-blend-mode:multiply, #ambientLayer at 10) and sets isolation:isolate
   on #boardWrap itself, so the blend has an explicit group to work against and
   cannot darken the app chrome. No CSS in index.html is required. */
export function startAmbientLayer(){
  const host = document.getElementById('boardWrap');
  if(!host) return;
  AmbientLayer.init(host, { boardEl: document.getElementById('board') }).start();
}

function rollOrientationOrder(){
  const redRoll = rollD6(), blueRoll = rollD6();
  const firstSide = redRoll===blueRoll ? null : (redRoll>blueRoll ? SIDES.RED : SIDES.BLUE);
  const resultText = firstSide===null ? 'Tied \u2014 rolling again' : `${SIDE_LABEL[firstSide]} goes first`;
  showDice([
    {label:'Britain', side:SIDES.RED, rolls:[redRoll], keptValue:redRoll},
    {label:'France', side:SIDES.BLUE, rolls:[blueRoll], keptValue:blueRoll}
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
    {label:'Britain', side:SIDES.RED, rolls:[redRoll], keptValue:redRoll},
    {label:'France', side:SIDES.BLUE, rolls:[blueRoll], keptValue:blueRoll}
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
  /* Spectate: point the AI at the side being asked, so it picks the board
     orientation for both rather than waiting on a person for one of them. */
  if(state.spectate) state.aiSide = side;
  const isHumanControlled = !FAST_DICE_MODE && !(state.mode==='ai' && side===state.aiSide);
  if(!isHumanControlled){
    const chosen = Math.floor(seededRandom()*4);
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
/* A line of instruction over the top of the board. The orientation step used
   to write its instruction into the top bar's turn badge; with the bar retired
   it needs its own place, or the player is never told to tap the map. */
function showBoardHint(text){
  let el = document.getElementById('boardHint');
  if(!el){
    el = document.createElement('div');
    el.id = 'boardHint';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add('show');
}
function hideBoardHint(){ const el = document.getElementById('boardHint'); if(el) el.classList.remove('show'); }

function startOrientationPickMode(side, onDone){
  state.phase = 'orientation';
  state._orientationPick = { side, onDone };
  showBoardHint(`${SIDE_LABEL[side]}: tap your half of the map to rotate it, then confirm`);
  /* The phase seal doubles as the Confirm button here, in the side's colour. */
  const dock = document.getElementById('phaseDock');
  if(dock){
    dock.style.display = 'flex';
    dock.style.setProperty('--side', SIDE_COLOR[side]);
    const lab = document.getElementById('phaseSide'); if(lab) lab.textContent = SIDE_LABEL[side];
  }
  const confirmBtn = document.getElementById('endMoveBtn');
  confirmBtn.style.display = 'inline-block';
  confirmBtn.disabled = false;
  confirmBtn.textContent = 'Confirm';   // the banner over the board says what is being confirmed
  confirmBtn.onclick = ()=>{
    confirmBtn.textContent = 'End Move'; // hand the button back to its normal battle-phase role
    confirmBtn.onclick = endMovePhase;   // its real handler — never gets re-bound after boot.js's one-time initBattleControls() call, so this must restore it explicitly
    hideBoardHint();
    if(dock) dock.style.display = 'none';
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
  AudioManager.stopMusic();
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

let armyPickerState = null; // { side, index }
/* Group (2v2): the army the picker is choosing for. Set only by
   showGroupArmyPicker; everywhere else it is null and the picker behaves as
   before. */
let pickerGroupArmy = null;
export function showGroupArmyPicker(armyDef, onChosen){
  pickerGroupArmy = armyDef;
  state.viewEdge = armyDef.edge;
  draw();
  showArmyPickerFor(armyDef.side, (composition)=>{
    pickerGroupArmy = null;
    onChosen(composition);
  });
}
let armyPickerSwipeAttached = false;

function goToArmy(delta){
  armyPickerState.index = (armyPickerState.index + TB_DATA.armyCompositions.length + delta) % TB_DATA.armyCompositions.length;
  renderArmyPickerCard();
}

/* Left and right arrow keys browse the armies while the picker is open, for a
   laptop; registered once, inert whenever the picker is closed. */
document.addEventListener('keydown', e => {
  if(!armyPickerState) return;
  if(e.key === 'ArrowLeft'){ goToArmy(-1); e.preventDefault(); }
  else if(e.key === 'ArrowRight'){ goToArmy(1); e.preventDefault(); }
});

// One horizontal drag on the card steps to the next/previous Army. Attached
// once (idempotency guard in showArmyPicker) since #armyPickerCardBody is a
// static element, not recreated per open.
function attachArmyPickerSwipe(){
  const el = document.getElementById('armyPickerCardBody');
  let startX = null, startY = null;
  el.addEventListener('touchstart', (e)=>{
    if(!armyPickerState) return;
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY;
  }, { passive: true });
  el.addEventListener('touchend', (e)=>{
    if(!armyPickerState || startX===null) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - startX, dy = t.clientY - startY;
    startX = null; startY = null;
    // Require a real horizontal swipe, not a vertical scroll of the card
    if(Math.abs(dx) < 45 || Math.abs(dx) < Math.abs(dy) * 1.3) return;
    goToArmy(dx < 0 ? 1 : -1);
  }, { passive: true });
}

/* Online: the guest's phone shows the same picker for its own side, but the
   choice is sent back to the host's phone to be placed, so "Deploy This Army"
   reports the army instead of deploying it, and manual placement is hidden
   (it would need every placement sent across; not yet built). */
export function showArmyPickerFor(side, onChosen){
  showArmyPicker(side);
  const manual = document.getElementById('armyPickerManualBtn');
  manual.style.display = 'none';
  document.getElementById('armyPickerDeployBtn').onclick = ()=>{
    const army = TB_DATA.armyCompositions[armyPickerState.index];
    closeArmyPicker();
    manual.style.display = '';
    onChosen(army);
  };
}

function showArmyPicker(side){
  armyPickerState = { side, index: 0 };
  document.getElementById('sidebar').style.display = 'none';
  document.getElementById('rosterPanel').style.display = 'none';
  document.getElementById('armyPickerPanel').classList.remove('hidden');
  renderArmyPickerCard();
  if(!armyPickerSwipeAttached){ attachArmyPickerSwipe(); armyPickerSwipeAttached = true; }

  document.getElementById('armyPickerPrev').onclick = ()=> goToArmy(-1);
  document.getElementById('armyPickerNext').onclick = ()=> goToArmy(1);
  document.getElementById('armyPickerDeployBtn').onclick = ()=>{
    const army = TB_DATA.armyCompositions[armyPickerState.index];
    deployArmyComposition(side, army.id);
    log(`${SIDE_LABEL[side]} deploys as ${army.name}.`, 'system');
    closeArmyPicker();
    if(!maybeShowArmyPicker()) showRosterIfNeeded();   // a second human (hotseat) gets their own choice
  };
  document.getElementById('armyPickerManualBtn').onclick = ()=> closeArmyPicker(true);
}

/* Each brigade as a short list of what is in it ("2 × Infantry"), in the order
   the units first appear. The Brigadier is left out: every brigade has one. */
function brigadeUnitLines(brig){
  const counts = new Map();
  for(const e of brig.units){
    if(e.type === 'BRIGADIER') continue;
    counts.set(e.type, (counts.get(e.type) || 0) + 1);
  }
  return [...counts].map(([type, n]) => {
    const label = (UNIT_TYPES[type] && UNIT_TYPES[type].label) || type;
    return n > 1 ? `${n} &times; ${label}` : label;
  });
}

function renderArmyPickerCard(){
  const { side, index } = armyPickerState;
  const army = TB_DATA.armyCompositions[index];
  document.getElementById('armyPickerIndex').textContent = index+1;
  const forEl = document.getElementById('armyPickerFor');
  if(forEl) forEl.textContent = pickerGroupArmy ? pickerGroupArmy.label + ' \u00b7 ' : '';
  document.getElementById('armyPickerName').textContent = army.name;
  document.getElementById('armyPickerSummary').textContent = army.summary;
  const cardsEl = document.getElementById('armyPickerBrigadeCards');
  cardsEl.innerHTML = army.brigades.map((b,i)=>
    `<div class="apCard" style="border-top-color:${ARMY_ZONE_COLORS[i]};"><div class="apName">${b.name}</div><ul class="apUnits">${brigadeUnitLines(b).map(l=>`<li>${l}</li>`).join('')}</ul></div>`
  ).join('');
  const dotsEl = document.getElementById('armyPickerDots');
  dotsEl.innerHTML = TB_DATA.armyCompositions.map((_,i)=>
    `<div class="apDot${i===index?' active':''}"></div>`
  ).join('');
  drawArmyPreview(side, army);
}

/* THE ARMY AS IT WILL LAND. The real board, drawn offscreen with the army's
   planned units added as ghosts (planArmyDeployment makes the same choices the
   real deployment will), then cropped to this side's deployment rows plus one
   row towards the enemy. A coloured line under each brigade marks its width. */
const PREVIEW_CELL = 44;
const PREVIEW_BAR = 6;
function drawArmyPreview(side, army){
  const out = document.getElementById('armyPickerPreview');
  if(!out || !state.terrain) return;
  const ghosts = pickerGroupArmy ? planGroupArmy(pickerGroupArmy, army.id) : planArmyDeployment(side, army.id);
  for(const g of ghosts){
    const list = (UNIT_ARCHIVE[side] && UNIT_ARCHIVE[side][g.type]) || [];
    g.historicalName = list.length ? list[0].name : null;
  }
  const off = document.createElement('canvas');
  off.width = COLS * PREVIEW_CELL;
  off.height = ROWS * PREVIEW_CELL;
  try {
    beginDiagramMode(off, PREVIEW_CELL, { units: [...state.units, ...ghosts], selectedUnitId: null });
    draw();
  } finally {
    endDiagramMode();
  }
  const deployRows = 2;
  let rows, top;
  if(pickerGroupArmy){
    // Group: the board is already turned to this army's edge, so its home rows
    // are the bottom rows of the screen whichever edge it is.
    rows = [0,1,2];
    top = ROWS - rows.length;
  } else {
    rows = side===SIDES.RED
      ? Array.from({length: deployRows+1}, (_,i)=>ROWS-1-i)
      : Array.from({length: deployRows+1}, (_,i)=>i);
    top = Math.min(...rows.map(r => sy(r)));
  }
  const h = rows.length * PREVIEW_CELL;
  out.width = off.width;
  out.height = h + PREVIEW_BAR;
  const octx = out.getContext('2d');
  octx.clearRect(0, 0, out.width, out.height);
  octx.drawImage(off, 0, top*PREVIEW_CELL, off.width, h, 0, 0, off.width, h);
  army.brigades.forEach((_, i)=>{
    const xs = ghosts.filter(g => g.brigadeIndex === i).map(g => toScreen(g.x, g.y).x);
    if(!xs.length) return;
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    octx.fillStyle = ARMY_ZONE_COLORS[i];
    octx.fillRect(x0*PREVIEW_CELL + 3, h + 1, (x1-x0+1)*PREVIEW_CELL - 6, PREVIEW_BAR - 1);
  });
  draw(); // the live board, untouched
}

function closeArmyPicker(manual){
  document.getElementById('armyPickerPanel').classList.add('hidden');
  /* Only "Deploy Manually" opens the roster: an army deployed from the
     picker is already on the board, and the roster would just squeeze it. */
  if(manual === true){
    document.getElementById('sidebar').style.display = 'flex';
    document.getElementById('rosterPanel').style.display = 'flex';
  }
  armyPickerState = null;
  draw();
  // No extra AI-triggering needed here: "Deploy This Army" already ran
  // deployArmyComposition, which calls confirmCurrentBrigade() internally —
  // that already handles handing off to the AI correctly if it's now their
  // turn. "Deploy Manually" hasn't changed deployTurn at all, so
  // it's still this human side's turn regardless.
}
