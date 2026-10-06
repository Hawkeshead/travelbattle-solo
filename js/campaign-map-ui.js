/* =========================================================
   CAMPAIGN MAP, PHASE 1: THE SCREEN

   The map screen a player actually uses: tap an army, tap a highlighted town
   to march, split and merge, End Turn, then watch the French march. Every
   battle goes to the tactical board and comes back here.

   The rules are in campaign-map-core.js and the drawing in
   campaign-map-art.js; this file is only the screen and the saving.

   SAVING. The whole campaign is one JSON object in localStorage
   (fc_campaign_map_v1), written after every action, every turn and every
   battle, always inside try/catch: with storage refused, the campaign simply
   lasts as long as the page.

   FRESH PAGE PER BATTLE. A battle is started, and the map is returned to, on
   a reloaded page (a one-shot note in sessionStorage tells boot.js where to
   land), the same clean slate "New Battle" has always used. The battle in
   progress is saved by match-save.js like any other, so Resume Battle on the
   title screen still works for a campaign battle.
========================================================= */
import { TB_DATA, state } from './data-core.js';
import * as cm from './campaign-map-core.js';
import { renderMapSVG } from './campaign-map-art.js';
import { launchMapBattle, readBattleOutcome } from './campaign-map-battle.js';
import { currentRecord } from './telemetry/recorder.js';

const KEY = 'fc_campaign_map_v1';
const LANDING = 'fc_cmap_launch';
const AI_STEP_MS = 650;

export const defaultMap = () => TB_DATA.campaignMaps.flanders;
const mapFor = c => (TB_DATA.campaignMaps && TB_DATA.campaignMaps[c.mapId]) || defaultMap();

/* ---------- saving ---------- */
export function loadCampaignMap(){
  try { const t = localStorage.getItem(KEY); return t ? cm.restoreCampaign(t) : null; } catch { return null; }
}
export function saveCampaignMap(c){
  try { localStorage.setItem(KEY, cm.serialiseCampaign(c)); return true; } catch { return false; }
}
export function describeSave(c){
  const map = mapFor(c);
  if(c.result) return `finished: ${c.result.winner === 'draw' ? 'a draw' : c.result.winner === 'british' ? 'British victory' : 'French victory'}`;
  return `turn ${c.turn} of ${c.totalTurns} · ${cm.dateForTurn(map, c.turn)}${c.pendingBattle ? ' · a battle is waiting' : ''}`;
}

/* ---------- screen state ---------- */
let C = null;                   // the campaign
let view = { selectedArmyId: null, mode: null, message: '', showBattle: null, aiRunning: false };

function reloadInto(where){
  try { sessionStorage.setItem(LANDING, where); } catch { /* no session storage: the title screen */ }
  location.reload();
}

/* ---------- entry points ---------- */
export function newCampaignMap(){
  const map = defaultMap();
  C = cm.createCampaign(map, TB_DATA.armyCompositions, TB_DATA.unitArchive);
  saveCampaignMap(C);
  view = { selectedArmyId: null, mode: null, message: 'Turn 1. Tap your army (the red flag at Ostend) to see where it can march.', showBattle: null, aiRunning: false };
  open();
}
export function showCampaignMap(){
  C = loadCampaignMap();
  if(!C){ newCampaignMap(); return; }
  view = { selectedArmyId: null, mode: null, message: '', showBattle: null, aiRunning: false };
  open();
}
/* boot.js, after a reload: 'battle' starts the pending battle; 'map' or
   'map-after-battle' opens the map (the latter showing what the battle did). */
export function landAfterReload(where){
  C = loadCampaignMap();
  if(!C){ location.reload(); return; }
  if(where === 'battle' && C.pendingBattle){
    import('./ui-menus.js').then(m => launchMapBattle(C, mapFor(C), m.startAmbientLayer));
    return;
  }
  view = { selectedArmyId: null, mode: null, message: '', showBattle: where === 'map-after-battle' ? C.battles[C.battles.length - 1] || null : null, aiRunning: false };
  open();
}

/* ---------- after a battle (engine-objectives endGame) ---------- */
let recorded = null;
/* Writes the battle's result into the campaign and saves, once. Called the
   moment the battle ends, so closing the app on the victory screen loses
   nothing. */
export function recordMapBattle(winner){
  if(recorded) return recorded;
  const c = loadCampaignMap();
  const mb = state.mapBattle;
  if(!c || !mb || c.id !== mb.campaignId || !c.pendingBattle || c.pendingBattle.id !== mb.battleId) return null;
  const outcome = readBattleOutcome(winner);
  const rec = currentRecord();
  outcome.matchUid = (rec && rec.matchUid) || null;
  recorded = c.pendingBattle.stage === 'rearguard' ? cm.applyRearguardResult(c, mapFor(c), outcome) : cm.applyBattleResult(c, mapFor(c), outcome);
  saveCampaignMap(c);
  return recorded;
}
export function returnToMapAfterBattle(winner){
  recordMapBattle(winner);
  reloadInto('map-after-battle');
}

/* ---------- the screen ---------- */
function open(){
  ensureScreen();
  document.documentElement.classList.add('title-away');
  const ov = document.getElementById('overlay'); if(ov) ov.classList.remove('show');
  document.getElementById('cmap').classList.add('show');
  render();
  centreOn(cm.armiesOf(C, C.playerSide)[0]);
  // A French phase interrupted by a battle carries on by itself.
  if(C.phase === C.aiSide && !C.pendingBattle && !C.result) setTimeout(runAi, view.showBattle ? 1200 : 400);
}

function ensureScreen(){
  if(document.getElementById('cmap')) return;
  const style = document.createElement('style');
  style.id = 'cmapStyle';
  style.textContent = CSS;
  document.head.appendChild(style);
  const el = document.createElement('div');
  el.id = 'cmap';
  el.innerHTML = `
    <header class="cmap-head"><div class="cmap-title"></div><div class="cmap-date"></div><div class="cmap-gold"></div></header>
    <div class="cmap-view"><div class="cmap-canvas"></div></div>
    <section class="cmap-panel"></section>
    <div class="cmap-modal hidden"><div class="cmap-card"></div></div>`;
  document.body.appendChild(el);
  el.querySelector('.cmap-canvas').addEventListener('click', onMapClick);
  el.querySelector('.cmap-panel').addEventListener('click', onPanelClick);
  el.querySelector('.cmap-modal').addEventListener('click', onPanelClick);
}

function centreOn(army){
  const v = document.querySelector('#cmap .cmap-view');
  const svg = v && v.querySelector('svg');
  if(!army || !svg) return;
  const t = cm.townById(mapFor(C), army.townId);
  const w = svg.getBoundingClientRect().width;
  v.scrollLeft = Math.max(0, t.x / mapFor(C).width * w - v.clientWidth / 2);
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const SIDE_NAME = { british: 'Britain', french: 'France' };
const TYPE_NAME = { BRIGADIER: 'Brigadier', GUARD: 'Guard', INFANTRY: 'Infantry', LIGHT_CAV: 'Light Cav', HEAVY_CAV: 'Heavy Cav', ARTILLERY: 'Artillery' };

function render(){
  const map = mapFor(C);
  const root = document.getElementById('cmap');
  const sel = C.armies.find(a => a.id === view.selectedArmyId) || null;
  if(!sel) view.selectedArmyId = null;
  const moves = sel && sel.side === C.playerSide ? cm.validMoves(C, map, sel) : [];
  root.querySelector('.cmap-title').textContent = map.name;
  const phase = C.result ? 'Campaign over' : C.phase === C.playerSide ? 'Your move' : 'The French march';
  const purse = cm.incomeOf(C, map, C.playerSide);
  root.querySelector('.cmap-date').textContent = `Turn ${C.turn} of ${C.totalTurns} · ${cm.dateForTurn(map, C.turn)} · ${phase}`;
  root.querySelector('.cmap-gold').textContent = `Gold ${C.gold[C.playerSide]} (${purse.net >= 0 ? '+' : ''}${purse.net} a turn)`;
  const last = C.battles[C.battles.length - 1];
  root.querySelector('.cmap-canvas').innerHTML = renderMapSVG(map, C, { selectedArmyId: view.selectedArmyId, moves, lastBattleTownId: last && last.turn === C.turn ? last.townId : null });
  root.querySelector('.cmap-panel').innerHTML = panelHTML(map, sel, moves);
  fitMap(map);
  renderModal(map);
}

/* The map fills the height between the header and the panel, keeping its
   shape; on a phone held upright it is then wider than the screen and
   scrolls sideways, which keeps every town big enough to tap. */
function fitMap(map){
  const v = document.querySelector('#cmap .cmap-view');
  const svg = v && v.querySelector('svg');
  if(!svg) return;
  const h = v.clientHeight;
  const w = Math.max(v.clientWidth, Math.round(h * map.width / map.height));
  svg.style.height = Math.round(w * map.height / map.width) + 'px';
  svg.style.width = w + 'px';
}
window.addEventListener('resize', () => { if(C && document.getElementById('cmap')) fitMap(mapFor(C)); });

function armyCard(map, a, opts = {}){
  const brigades = a.brigades.map(b => {
    const units = b.units.map(u => `<li class="${u.type === 'BRIGADIER' ? 'brig' : ''}"><span class="u-type">${TYPE_NAME[u.type] || u.type}</span> ${esc(u.name)}</li>`).join('');
    const check = opts.split ? `<label class="cmap-check"><input type="checkbox" data-split-brigade="${b.id}"> detach</label>` : '';
    return `<div class="cmap-brigade"><div class="b-name">${esc(b.name)} ${check}</div><ul>${units}</ul></div>`;
  }).join('');
  const rest = cm.restPending(a) ? (cm.isResting(C, a) ? ' · withdrew: cannot march this turn' : ' · withdrew: cannot march next turn') : '';
  return `<div class="cmap-army-card side-${a.side}"><div class="a-name">${esc(a.name)} <span class="a-where">at ${esc(cm.townName(map, a.townId))}${a.hasMoved && C.phase === a.side && !rest ? ' · has marched' : ''}${rest}</span></div>${brigades}</div>`;
}

function panelHTML(map, sel, moves){
  const out = [];
  if(view.message) out.push(`<p class="cmap-msg">${esc(view.message)}</p>`);
  const mine = C.phase === C.playerSide && !C.result && !C.pendingBattle && !view.aiRunning;
  if(sel){
    if(view.mode === 'split'){
      out.push(`<p class="cmap-hint">Choose one or two brigades to detach into a new army here.</p>`);
      out.push(armyCard(map, sel, { split: true }));
      out.push(`<div class="cmap-actions"><button data-act="split-go">Detach</button><button data-act="cancel" class="ghost">Cancel</button></div>`);
      return out.join('');
    }
    if(view.mode === 'recruit') return recruitHTML(map);
    if(view.mode === 'merge'){
      const others = cm.armiesAt(C, sel.townId, sel.side).filter(a => a.id !== sel.id);
      out.push(`<p class="cmap-hint">Fold another army in ${esc(cm.townName(map, sel.townId))} into ${esc(sel.name)} (three brigades at most).</p>`);
      for(const o of others) out.push(`<button class="cmap-wide" data-act="merge-go" data-army="${o.id}" ${cm.canMerge(C, sel, o) ? '' : 'disabled'}>Merge ${esc(o.name)} (${o.brigades.length} brigade${o.brigades.length === 1 ? '' : 's'})</button>`);
      out.push(`<div class="cmap-actions"><button data-act="cancel" class="ghost">Cancel</button></div>`);
      return out.join('');
    }
    out.push(armyCard(map, sel));
    if(sel.side === C.playerSide && mine){
      if(moves.length) out.push(`<p class="cmap-hint">Tap a highlighted town to march there. Red means an enemy army holds it: marching in is an attack.</p>`);
      else if(cm.isResting(C, sel)) out.push(`<p class="cmap-hint">This army withdrew from a fight and must rest this turn.</p>`);
      else if(sel.hasMoved) out.push(`<p class="cmap-hint">This army has marched this turn.</p>`);
      const others = cm.armiesAt(C, sel.townId, sel.side).filter(a => a.id !== sel.id);
      out.push(`<div class="cmap-actions">` +
        (cm.canRecruitAt(C, map, sel.side, sel.townId) ? `<button data-act="recruit">Recruit</button>` : '') +
        (cm.canSplit(C, sel) ? `<button data-act="split">Split</button>` : '') +
        (others.length ? `<button data-act="merge">Merge</button>` : '') +
        `<button data-act="deselect" class="ghost">Close</button></div>`);
    }
  } else if(mine && view.mode === 'recruit'){
    return recruitHTML(map);
  } else if(mine){
    out.push(`<p class="cmap-hint">Tap one of your armies (red flags) to command it. Each army may march one town along a road each turn.</p>`);
  } else if(view.aiRunning){
    out.push(`<p class="cmap-hint">The French are on the march…</p>`);
  }
  const purse = cm.incomeOf(C, map, C.playerSide);
  const score = `<div class="cmap-score">Gold ${C.gold[C.playerSide]} · towns ${purse.towns}${purse.subsidy ? ` + subsidy ${purse.subsidy}` : ''} − upkeep ${purse.upkeep} = ${purse.net >= 0 ? '+' : ''}${purse.net} a turn<br>Enemy value destroyed: Britain ${C.destroyedValue.british} · France ${C.destroyedValue.french}</div>`;
  out.push(score);
  out.push(`<div class="cmap-actions bottom">` +
    (mine ? `<button data-act="end-turn" class="primary">End Turn</button>` : '') +
    (mine && !sel && cm.canRecruitAt(C, map, C.playerSide, (cm.homeDepot(map, C.playerSide) || {}).id) ? `<button data-act="recruit">Recruit at ${esc(cm.homeDepot(map, C.playerSide).name)}</button>` : '') +
    (C.pendingBattle && !view.aiRunning && (C.pendingBattle.stage === 'battle' || C.pendingBattle.stage === 'rearguard') ? `<button data-act="to-battle" class="primary">To Battle</button>` : '') +
    `<button data-act="log" class="ghost">Campaign Log</button><button data-act="menu" class="ghost">Main Menu</button></div>`);
  return out.join('');
}

function renderModal(map){
  const modal = document.querySelector('#cmap .cmap-modal');
  const card = modal.querySelector('.cmap-card');
  let html = '';
  if(view.mode === 'log'){
    html = `<h3>Campaign Log</h3><textarea class="cmap-log" readonly>${esc(cm.campaignLogText(C, map))}</textarea>
      <div class="cmap-actions"><button data-act="log-copy">Copy</button><button data-act="log-download">Download</button><button data-act="cancel" class="ghost">Close</button></div>`;
  } else if(C.result){
    const r = C.result;
    const title = r.winner === 'draw' ? 'A Drawn Campaign' : r.winner === C.playerSide ? 'British Victory' : 'French Victory';
    html = `<h3>${title}</h3><p>${esc(r.reason)}.</p>
      <table class="cmap-tally"><tr><th></th><th>Britain</th><th>France</th></tr>
      <tr><td>Enemy value destroyed</td><td>${C.destroyedValue.british}</td><td>${C.destroyedValue.french}</td></tr>
      <tr><td>Units lost</td><td>${C.unitsLost.british}</td><td>${C.unitsLost.french}</td></tr>
      <tr><td>Armies in the field</td><td>${cm.armiesOf(C, 'british').length}</td><td>${cm.armiesOf(C, 'french').length}</td></tr></table>
      <p class="cmap-small">${C.battles.length} battle${C.battles.length === 1 ? '' : 's'} fought · ended on turn ${r.turn}, ${esc(cm.dateForTurn(map, r.turn))}</p>
      <div class="cmap-actions"><button data-act="log">Campaign Log</button><button data-act="new" class="primary">New Campaign</button><button data-act="menu" class="ghost">Main Menu</button></div>`;
  } else if(C.pendingBattle && !view.aiRunning){
    html = pendingHTML(map, C.pendingBattle);
  } else if(view.showBattle){
    const b = view.showBattle, s = b.summary;
    const lostList = k => s.lostUnits[k].length ? s.lostUnits[k].map(u => `${esc(u.name)} (${TYPE_NAME[u.type] || u.type})`).join(', ') : 'none';
    const heading = b.kind === 'rearguard'
      ? (b.winner === b.withdrawal.side ? 'The rearguard holds' : 'The rearguard is broken') + ` at ${esc(cm.townName(map, b.townId))}`
      : `${b.winner === C.playerSide ? 'Victory' : 'Defeat'} at ${esc(cm.townName(map, b.townId))}`;
    html = `<h3>${heading}</h3>
      <p><b>British losses:</b> ${lostList('british')}</p><p><b>French losses:</b> ${lostList('french')}</p>
      ${s.brokenBrigades.british.length + s.brokenBrigades.french.length ? `<p class="cmap-small">Brigades broken: ${[...s.brokenBrigades.british, ...s.brokenBrigades.french].map(x => esc(x.name + ' of ' + x.army)).join(', ')}</p>` : ''}
      ${s.retreat ? `<p>${esc(s.retreat.armies.join(' and '))} fall${s.retreat.armies.length === 1 ? 's' : ''} back to ${esc(cm.townName(map, s.retreat.to))}.</p>` : ''}
      ${s.destroyedArmies.length ? `<p>${esc(s.destroyedArmies.map(a => a.name).join(' and '))}, with nowhere to retreat, ${s.destroyedArmies.length === 1 ? 'is' : 'are'} destroyed.</p>` : ''}
      <div class="cmap-actions"><button data-act="dismiss" class="primary">Continue</button></div>`;
  }
  card.innerHTML = html;
  modal.classList.toggle('hidden', !html);
}

/* ---------- recruiting at the home depot ---------- */
const RECRUIT_TYPES = ['INFANTRY', 'GUARD', 'LIGHT_CAV', 'HEAVY_CAV', 'ARTILLERY'];
function recruitHTML(map){
  const side = C.playerSide, depot = cm.homeDepot(map, side), rules = cm.economyRules(map), gold = C.gold[side];
  const here = cm.armiesAt(C, depot.id, side);
  const out = [`<p class="cmap-hint"><b>Recruit at ${esc(depot.name)}</b> · gold ${gold}. New men join at once. Every fighting unit costs ${rules.upkeepPerUnit} gold a turn in upkeep.</p>`];
  for(const a of here){
    out.push(`<div class="cmap-army-card side-${a.side}"><div class="a-name">${esc(a.name)}</div>`);
    for(const b of a.brigades){
      const n = cm.fightingUnits(b).length, full = n >= rules.maxFightingUnitsPerBrigade;
      out.push(`<div class="cmap-brigade"><div class="b-name">${esc(b.name)} <span class="a-where">${n} of ${rules.maxFightingUnitsPerBrigade}${full ? ', full strength' : ''}</span></div>` +
        (full ? '' : `<div class="cmap-recruit">${RECRUIT_TYPES.map(t => `<button data-act="recruit-unit" data-army="${a.id}" data-brigade="${b.id}" data-type="${t}" ${gold < rules.unitCost[t] ? 'disabled' : ''}>+ ${TYPE_NAME[t]} ${rules.unitCost[t]}</button>`).join('')}</div>`) + `</div>`);
    }
    out.push(`</div>`);
  }
  if(!here.length) out.push(`<p class="cmap-hint">No army stands at ${esc(depot.name)}: a new brigade will form a new army here.</p>`);
  out.push(`<div class="cmap-actions"><button data-act="raise" class="primary" ${gold < rules.newBrigadeCost ? 'disabled' : ''}>Raise a new brigade (${rules.newBrigadeCost})</button><button data-act="cancel" class="ghost">Done</button></div>`);
  out.push(`<p class="cmap-small">A new brigade is a Brigadier and two infantry; top it up as gold allows.</p>`);
  return out.join('');
}

/* ---------- an engagement in progress (Phase 2 stages) ---------- */
const brigadeLine = (b, army) => `${esc(b.name)}${army ? ' of ' + esc(army.name) : ''}: ${b.units.filter(u => u.type !== 'BRIGADIER').map(u => TYPE_NAME[u.type] || u.type).join(', ')}`;
function pendingHTML(map, b){
  const town = esc(cm.townName(map, b.townId));
  const side = s => cm.battleBrigades(C, b, s);
  const list = s => side(s).map(x => `${esc(x.brigade.name)} of ${esc(x.army.name)} (${cm.fightingUnits(x.brigade).length} units)`).join('<br>');
  const sides = `<div class="cmap-sides"><div class="side-british"><b>Britain</b><br>${list('british')}</div><div class="side-french"><b>France</b><br>${list('french')}</div></div>`;
  const defender = cm.defenderSideOf(b);
  const attackerArmy = cm.armyById(C, b.attackerArmyId);

  if(b.stage === 'decide'){
    // Only ever the player's choice: the AI's is made the moment it is attacked.
    if(view.mode === 'withdraw'){
      const opts = cm.withdrawOptions(C, map, b, defender);
      return `<h3>Withdraw from ${town}</h3><p>Choose the town to fall back to. ${esc(attackerArmy.name)} will hold ${town}, and your army cannot march on its next turn.</p>
        ${opts.map(t => `<button class="cmap-wide" data-act="withdraw-to" data-town="${t}">Withdraw to ${esc(cm.townName(map, t))}</button>`).join('')}
        <p class="cmap-small">If the French pursue, your weakest brigade turns to fight a rearguard action.</p>
        <div class="cmap-actions"><button data-act="cancel" class="ghost">Back</button></div>`;
    }
    return `<h3>${SIDE_NAME[b.attackerSide]} attacks ${town}</h3><p>${esc(attackerArmy.name)} marches on ${town}. Stand and fight, or refuse battle and withdraw?</p>${sides}
      <div class="cmap-actions"><button data-act="fight" class="primary">Fight</button><button data-act="withdraw">Withdraw</button></div>`;
  }
  if(b.stage === 'pursuit'){
    const w = b.withdrawal;
    const rgArmy = w.rearguard && cm.armyById(C, w.rearguard.armyId);
    const rg = rgArmy && rgArmy.brigades.find(x => x.id === w.rearguard.brigadeId);
    const choice = cm.pursuitChoices(C, map);
    const turns = cm.withdrawalRules(map).rearguardTurns;
    const pen = cm.withdrawalRules(map).pursuitInfantryDicePenalty;
    return `<h3>The French withdraw</h3><p>${esc(w.armyIds.map(id => (cm.armyById(C, id) || {}).name).join(' and '))} refuse${w.armyIds.length === 1 ? 's' : ''} battle and fall${w.armyIds.length === 1 ? 's' : ''} back to ${esc(cm.townName(map, w.to))}. ${esc(attackerArmy.name)} holds ${town}.</p>
      ${rg ? `<p class="cmap-small">Their rearguard would be ${brigadeLine(rg, rgArmy)}. To win, break it within ${turns} rounds.</p>` : ''}
      <p class="cmap-hint">${choice.onFoot ? `<b>No cavalry.</b> You may pursue on foot, but your pursuing units attack with ${pen} die fewer (never below one) for the whole fight.` : 'Pursue with one brigade. You have cavalry, so it must be a brigade with horse.'}</p>
      ${choice.brigades.map(br => `<button class="cmap-wide" data-act="pursue" data-brigade="${br.id}">Pursue with ${brigadeLine(br)}${choice.onFoot ? ' (on foot)' : ''}</button>`).join('')}
      <div class="cmap-actions"><button data-act="let-go" class="ghost">Let them go</button></div>`;
  }
  if(b.stage === 'rearguard'){
    const pu = side(b.attackerSide)[0], rg = side(b.withdrawal.side)[0];
    const mine = b.withdrawal.side === C.playerSide;
    return `<h3>Rearguard action at ${town}</h3>
      <p>${mine ? 'Your' : 'The French'} army falls back to ${esc(cm.townName(map, b.withdrawal.to))} while ${rg ? brigadeLine(rg.brigade, rg.army) : 'its rearguard'} holds off ${pu ? brigadeLine(pu.brigade, pu.army) : 'the pursuit'}.</p>
      <p><b>Rearguard:</b> survive ${b.rearguardTurns} rounds. <b>Pursuit:</b> break the rearguard brigade.</p>
      ${b.pursuit.onFoot ? `<p class="cmap-small">The pursuit has no cavalry: its units attack with ${b.pursuit.dicePenalty} die fewer (never below one).</p>` : ''}
      <p class="cmap-small">The 10 x 10 board. The rearguard stands on the edge toward its retreat. Losses are permanent.</p>
      <div class="cmap-actions"><button data-act="to-battle" class="primary">To Battle</button></div>`;
  }
  // A battle: chosen, or forced on a cornered army.
  const reserves = cm.armiesAt(C, b.townId, defender).reduce((n, a) => n + a.brigades.length, 0) - b.participants[defender].length;
  return `<h3>Battle at ${town}</h3>
    ${b.cornered ? `<p class="cmap-cornered">Cornered: no line of retreat</p>` : ''}
    <p>${SIDE_NAME[b.attackerSide]} attacks. ${b.boardMode === 'single' ? 'One brigade on the larger side: the 10 x 10 board.' : 'The full battlefield.'}</p>${sides}
    ${reserves > 0 ? `<p class="cmap-small">${reserves} more defending brigade${reserves === 1 ? ' stands' : 's stand'} by: a battle fields three brigades a side at most, and they share the defence's fate.</p>` : ''}
    <p class="cmap-small">Losses are permanent. The loser falls back one town.</p>
    <div class="cmap-actions"><button data-act="to-battle" class="primary">To Battle</button></div>`;
}

/* Lets the AI make any choice that is its own, saves, and carries on: back
   into the French march if the engagement has ended there. */
function afterChoice(){
  const map = mapFor(C);
  cm.resolveAiChoices(C, map);
  saveCampaignMap(C);
  view.mode = null;
  if(!C.pendingBattle && C.phase === C.aiSide && !C.result){ render(); setTimeout(runAi, AI_STEP_MS); return; }
  render();
}

/* ---------- input ---------- */
function onMapClick(e){
  if(view.aiRunning || C.result || C.pendingBattle) return;
  const map = mapFor(C);
  const armyEl = e.target.closest('[data-army]');
  const townEl = e.target.closest('[data-town]');
  const sel = C.armies.find(a => a.id === view.selectedArmyId);
  // A highlighted town takes priority: that is the march.
  const townId = townEl ? townEl.getAttribute('data-town') : armyEl ? (C.armies.find(a => a.id === armyEl.getAttribute('data-army')) || {}).townId : null;
  if(sel && townId && sel.side === C.playerSide && cm.validMoves(C, map, sel).includes(townId)){ march(sel, townId); return; }
  view.mode = null;
  if(armyEl){
    const a = C.armies.find(x => x.id === armyEl.getAttribute('data-army'));
    if(a && a.side === C.playerSide){ view.selectedArmyId = view.selectedArmyId === a.id ? null : a.id; view.message = ''; }
    else if(a){ view.selectedArmyId = null; view.message = `${a.name} (France): ${a.brigades.length} brigade${a.brigades.length === 1 ? '' : 's'} at ${cm.townName(map, a.townId)}.`; }
    render(); return;
  }
  if(townId){
    const own = cm.armiesAt(C, townId, C.playerSide);
    if(own.length){
      const i = own.findIndex(a => a.id === view.selectedArmyId);
      view.selectedArmyId = own[(i + 1) % own.length].id;
      view.message = '';
    } else {
      view.selectedArmyId = null;
      const t = cm.townById(map, townId);
      view.message = `${t.name}${t.isDepot ? ` (${t.depotSide === 'british' ? 'British' : 'French'} home depot)` : ''}${t.historicalSiteId ? ', a battlefield of 1793-94' : ''}.`;
    }
    render();
  }
}

function march(army, townId){
  const map = mapFor(C);
  const r = cm.moveArmy(C, map, army.id, townId);
  if(r.kind === 'battle') cm.resolveAiChoices(C, map);   // the French decide at once whether to stand
  saveCampaignMap(C);
  view.selectedArmyId = r.kind === 'moved' ? army.id : null;
  view.message = r.kind === 'moved' ? `${army.name} marches to ${cm.townName(map, townId)}.`
    : !C.pendingBattle ? `The French withdrew and ${army.name} holds ${cm.townName(map, townId)}.` : '';
  render();
}

function onPanelClick(e){
  const b = e.target.closest('button[data-act]');
  if(!b) return;
  const act = b.getAttribute('data-act');
  const map = mapFor(C);
  const sel = C.armies.find(a => a.id === view.selectedArmyId);
  try {
    if(act === 'deselect'){ view.selectedArmyId = null; view.mode = null; }
    else if(act === 'cancel'){ view.mode = null; }
    else if(act === 'split') view.mode = 'split';
    else if(act === 'recruit'){ view.mode = 'recruit'; view.selectedArmyId = null; }
    else if(act === 'recruit-unit'){
      const u = cm.recruitUnit(C, map, TB_DATA.unitArchive, b.getAttribute('data-army'), b.getAttribute('data-brigade'), b.getAttribute('data-type'));
      saveCampaignMap(C);
      view.message = `${u.name} recruited.`;
    }
    else if(act === 'raise'){
      const r = cm.raiseBrigade(C, map, TB_DATA.unitArchive, C.playerSide);
      saveCampaignMap(C);
      view.message = `${r.brigade.name} raised; it joins ${r.army.name}.`;
    }
    else if(act === 'merge') view.mode = 'merge';
    else if(act === 'split-go'){
      const ids = [...document.querySelectorAll('#cmap [data-split-brigade]:checked')].map(x => x.getAttribute('data-split-brigade'));
      const fresh = cm.splitArmy(C, map, sel.id, ids);
      saveCampaignMap(C);
      view.mode = null; view.selectedArmyId = fresh.id;
      view.message = `${fresh.name} formed at ${cm.townName(map, fresh.townId)}.`;
    }
    else if(act === 'merge-go'){
      const other = C.armies.find(a => a.id === b.getAttribute('data-army'));
      // The older army keeps its name and identity, whichever was tapped first.
      const age = a => C.armies.indexOf(a);
      const [into, from] = age(sel) <= age(other) ? [sel, other] : [other, sel];
      cm.mergeArmies(C, map, into.id, from.id);
      saveCampaignMap(C);
      view.mode = null; view.selectedArmyId = into.id;
      view.message = `${from.name} joins ${into.name}.`;
    }
    else if(act === 'end-turn'){ endTurn(); return; }
    else if(act === 'fight'){ cm.chooseFight(C, map); afterChoice(); return; }
    else if(act === 'withdraw'){ view.mode = 'withdraw'; }
    else if(act === 'withdraw-to'){ cm.chooseWithdraw(C, map, b.getAttribute('data-town')); afterChoice(); return; }
    else if(act === 'pursue'){ cm.choosePursue(C, map, b.getAttribute('data-brigade')); afterChoice(); return; }
    else if(act === 'let-go'){ cm.chooseLetGo(C, map); afterChoice(); return; }
    else if(act === 'to-battle'){ saveCampaignMap(C); reloadInto('battle'); return; }
    else if(act === 'dismiss'){ view.showBattle = null; }
    else if(act === 'log') view.mode = 'log';
    else if(act === 'log-copy'){ try { navigator.clipboard.writeText(cm.campaignLogText(C, map)); view.message = 'Campaign log copied.'; } catch { /* no clipboard */ } view.mode = null; }
    else if(act === 'log-download'){ download(`campaign-${C.id}-turn${C.turn}.txt`, cm.campaignLogText(C, map)); return; }
    else if(act === 'new'){ newCampaignMap(); return; }
    else if(act === 'menu'){ location.reload(); return; }
  } catch(err){
    view.message = String(err && err.message || err);
  }
  render();
}

function download(name, text){
  try {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch { /* nothing to save with */ }
}

/* ---------- the turn ---------- */
function endTurn(){
  cm.endPlayerPhase(C, mapFor(C));
  cm.aiRecruit(C, mapFor(C), TB_DATA.unitArchive);   // France pays and spends at Lille as its phase begins
  view.selectedArmyId = null; view.mode = null; view.message = '';
  saveCampaignMap(C);
  runAi();
}
function runAi(){
  const map = mapFor(C);
  if(C.result || C.pendingBattle || C.phase !== C.aiSide){ view.aiRunning = false; render(); return; }
  view.aiRunning = true;
  const r = cm.aiStep(C, map);
  saveCampaignMap(C);
  if(r.kind === 'done'){
    cm.endAiPhase(C, map);
    saveCampaignMap(C);
    view.aiRunning = false;
    view.message = C.result ? '' : `Turn ${C.turn}: ${cm.dateForTurn(map, C.turn)}. Your move.`;
    render();
    return;
  }
  if(r.kind === 'battle'){
    cm.resolveAiChoices(C, map);
    saveCampaignMap(C);
    view.aiRunning = false;
    view.message = `${r.army.name} attacks ${cm.townName(map, r.battle.townId)}!`;
    render();
    return;
  }
  view.message = r.kind === 'moved' ? `${r.army.name} marches to ${cm.townName(map, r.army.townId)}.` : `${r.army.name} holds.`;
  render();
  setTimeout(runAi, AI_STEP_MS);
}

/* ---------- testing hooks (Playwright screenshots) ---------- */
export const _test = {
  campaign: () => C,
  save: () => saveCampaignMap(C),
  rerender: () => render(),
};

/* THE MENUS' LOOK (index.html: the Campaigns folio, html.panel-art). The
   screen is the desk; the map and the command panel are each set in the
   walnut frame with brass corners (assets/ui/panel_frame.webp) on the map
   parchment (assets/ui/panel_map_centre.webp); titles are brass plaques;
   main actions are walnut buttons with cream lettering, the rest parchment
   buttons, exactly as on the Campaigns and Operations screens. */
const FRAME = `border:12px solid #3b2416;border-radius:0;border-image:url(assets/ui/panel_frame.webp) 75 / 12px stretch;`;
const PARCHMENT = `background:#e3d4ae url(assets/ui/panel_map_centre.webp) center / 230% auto no-repeat;background-clip:padding-box;`;
const PLAQUE = `position:relative;display:inline-block;font-family:'Cinzel',serif;font-weight:700;color:#3A2C0D;letter-spacing:.14em;text-transform:uppercase;
  background:linear-gradient(168deg,#CBAA5C 0%,#9A7A36 34%,#C0A050 62%,#7C6229 100%);border-radius:2px;text-shadow:0 1px 0 rgba(255,240,200,.42);
  box-shadow:inset 0 1px 0 rgba(255,240,200,.6),inset 0 -2px 4px rgba(0,0,0,.5),0 3px 7px rgba(0,0,0,.62);`;
const CSS = `
#cmap{position:fixed;inset:0;z-index:70;display:none;flex-direction:column;color:#3B3020;font-family:'Cormorant Garamond',serif;
  background:radial-gradient(ellipse 90% 55% at 50% 22%,rgba(255,196,120,.16),transparent 70%),linear-gradient(180deg,#2c1c0e,#1a1008 60%,#120b05);
  padding:var(--sa-top,0) var(--sa-right,0) var(--sa-bottom,0) var(--sa-left,0);}
#cmap.show{display:flex;}
#cmap .cmap-head{flex:0 0 auto;text-align:center;padding:10px 12px 6px;}
#cmap .cmap-title{${PLAQUE}font-size:15px;padding:8px 20px 7px;}
#cmap .cmap-title::after{content:"";position:absolute;inset:4px;border:1px solid rgba(62,47,17,.5);border-radius:1px;pointer-events:none;}
#cmap .cmap-gold{font-family:'Cinzel',serif;font-weight:700;font-size:13px;letter-spacing:.08em;color:#e2c47a;margin-top:2px;text-shadow:0 1px 2px rgba(0,0,0,.6);}
#cmap .cmap-recruit{display:flex;flex-wrap:wrap;gap:5px;margin:4px 0 2px;}
#cmap .cmap-recruit button{min-height:36px;padding:6px 8px;font-size:11px;letter-spacing:.04em;}
#cmap .cmap-date{font-family:'Cormorant Garamond',serif;font-style:italic;font-weight:600;font-size:15px;color:#e9d9b0;margin-top:6px;text-shadow:0 1px 2px rgba(0,0,0,.6);}
#cmap .cmap-view{flex:1 1 auto;min-height:0;overflow:auto;-webkit-overflow-scrolling:touch;margin:2px 8px 6px;${FRAME}background:#e3d4ae;box-shadow:0 10px 24px rgba(0,0,0,.6);}
#cmap .cmap-canvas{width:max-content;min-width:100%;min-height:100%;display:flex;align-items:center;}
#cmap .cmap-svg{display:block;flex:0 0 auto;margin:0 auto;touch-action:pan-x pan-y;}
#cmap .cmap-hit,#cmap .cmap-army{cursor:pointer;}
#cmap .cmap-panel{flex:0 0 auto;max-height:38vh;overflow:auto;margin:0 8px 8px;padding:8px 12px 10px;${FRAME}${PARCHMENT}box-shadow:0 10px 24px rgba(0,0,0,.6);}
#cmap .cmap-msg{margin:0 0 6px;font-style:italic;font-size:16px;color:#3B3020;}
#cmap .cmap-hint{margin:4px 0 8px;font-size:15px;color:#4d3f27;}
#cmap .cmap-score{font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:.04em;color:#6b5636;margin:6px 0 2px;}
#cmap .cmap-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;justify-content:center;}
#cmap button{font-family:'Cinzel',serif;font-weight:600;font-size:12.5px;letter-spacing:.08em;padding:9px 14px;min-height:44px;border-radius:4px;cursor:pointer;
  background:rgba(240,228,198,.85);color:#2e2010;border:1px solid #9a7a36;text-shadow:none;
  box-shadow:0 2px 4px rgba(0,0,0,.25),inset 0 1px 0 rgba(255,255,255,.5);transition:transform .12s,filter .15s;}
#cmap button:hover{filter:brightness(1.06);}
#cmap button:active{transform:translateY(1px) scale(.98);}
#cmap button.primary{background:linear-gradient(180deg,#4a2e1a,#2f1c10);color:#f2e3c0;border:1px solid #b8913f;
  box-shadow:0 3px 7px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,220,160,.18);}
#cmap button.ghost{background:rgba(240,228,198,.55);}
#cmap button:disabled{opacity:.45;cursor:default;}
/* A list of choices (retreat towns, pursuing brigades, merges): the menus'
   op-choice buttons, parchment and left-aligned. */
#cmap .cmap-wide{display:block;width:100%;margin:6px 0;padding:10px 14px;text-align:left;line-height:1.3;font-size:13px;}
#cmap .cmap-army-card{border-left:4px solid #8c2f2f;padding:2px 0 2px 10px;margin:4px 0;}
#cmap .cmap-army-card.side-french{border-left-color:#2c3e63;}
#cmap .a-name{font-family:'Cinzel',serif;font-weight:700;font-size:15px;letter-spacing:.06em;}
#cmap .a-where{font-family:'Cormorant Garamond',serif;font-style:italic;font-weight:600;font-size:14px;color:#6b5636;letter-spacing:0;}
#cmap .cmap-brigade{margin-top:6px;}
#cmap .b-name{font-family:'Cinzel',serif;font-weight:600;font-size:12.5px;letter-spacing:.06em;display:flex;justify-content:space-between;align-items:center;}
#cmap .cmap-brigade ul{list-style:none;margin:2px 0 0;padding:0;columns:2;column-gap:12px;font-size:14px;line-height:1.2;}
#cmap .cmap-brigade li.brig{font-weight:700;}
#cmap .u-type{font-family:'Cinzel',serif;font-size:9.5px;letter-spacing:.06em;color:#6b5636;}
#cmap .cmap-check{font-family:'Cormorant Garamond',serif;font-size:15px;display:flex;gap:6px;align-items:center;}
#cmap .cmap-check input{width:22px;height:22px;accent-color:#4a2e1a;}
#cmap .cmap-modal{position:absolute;inset:0;background:rgba(18,10,4,.62);display:flex;align-items:flex-start;justify-content:center;padding:calc(var(--sa-top,0px) + 64px) 12px 14px;overflow:auto;}
#cmap .cmap-modal.hidden{display:none;}
#cmap .cmap-card{width:100%;max-width:440px;box-sizing:border-box;${FRAME}border-width:14px;border-image-width:14px;${PARCHMENT}background-size:cover;padding:14px 14px 14px;text-align:center;box-shadow:0 16px 34px rgba(0,0,0,.7);}
#cmap .cmap-card h3{${PLAQUE}font-size:15px;padding:9px 18px 8px;margin:0 0 10px;}
#cmap .cmap-card h3::after{content:"";position:absolute;inset:4px;border:1px solid rgba(62,47,17,.5);border-radius:1px;pointer-events:none;}
#cmap .cmap-card p{margin:6px 0;font-size:16px;line-height:1.35;text-align:left;}
#cmap .cmap-small{font-size:14px!important;color:#4d3f27;}
#cmap .cmap-sides{display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:14px;margin:8px 0;text-align:left;}
#cmap .cmap-sides b{font-family:'Cinzel',serif;font-weight:700;letter-spacing:.06em;font-size:13px;}
#cmap .cmap-sides .side-british{border-left:4px solid #8c2f2f;padding-left:8px;}
#cmap .cmap-sides .side-french{border-left:4px solid #2c3e63;padding-left:8px;}
#cmap .cmap-tally{width:100%;border-collapse:collapse;font-size:15px;margin:8px 0;}
#cmap .cmap-tally th{font-family:'Cinzel',serif;font-size:12px;letter-spacing:.06em;text-align:right;}
#cmap .cmap-tally td{padding:3px 0;border-bottom:1px solid rgba(154,122,54,.45);text-align:left;}
#cmap .cmap-tally td+td{text-align:right;font-weight:700;}
#cmap .cmap-cornered{font-family:'Cinzel',serif;font-weight:700;letter-spacing:.1em;text-transform:uppercase;font-size:13px!important;color:#7a1f1f;text-align:center!important;border:2px solid #7a1f1f;border-radius:2px;padding:6px;background:rgba(122,31,31,.07);transform:rotate(-1.2deg);}
#cmap .cmap-log{width:100%;box-sizing:border-box;height:50vh;font-family:'IBM Plex Mono',monospace;font-size:11px;background:rgba(247,239,217,.9);border:1px solid #9a7a36;color:#2e2010;}
`;
