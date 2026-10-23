/* =========================================================
   CAMPAIGN (the single-player story mode, Matthew, 17 to 19 Oct 2026)

   Pick a nation, then a campaign, then fight its battles in order along that
   nation's route. Every couple of battles the route forks and you choose the
   next one. You pass a battle by meeting your nation's historical objective;
   fail and you fight it again. Fresh armies every battle. Allied Brigades of
   another nation are commanded by a friendly AI (operations.js).

   Progress is kept on the device (localStorage 'fc_story'). The battles come
   from data/story/<campaign>.json through js/story.js and the Operations
   engine (beginOperation in ui-menus.js).
========================================================= */
import { SIDES, TB_DATA, state } from './data-core.js';
import { getCard } from './scenario-cards.js';
import { FRENCH_SIDE } from './story.js';

const KEY = 'fc_story';
export const CAMPAIGNS = [
  { id: 'waterloo', name: 'The Waterloo Campaign', years: '1815', nations: ['Britain', 'Prussia', 'France'] },
  { id: 'peninsula', name: 'The Peninsula', years: '1808 to 1814', nations: ['Britain', 'Portugal', 'Spain', 'France'] },
  { id: 'flanders', name: 'Flanders', years: '1793 to 1795', nations: ['Britain', 'Austria', 'France'], soon: true },
];
const NATION_ORDER = ['Britain', 'Prussia', 'Austria', 'Portugal', 'Spain', 'France'];

export function loadStory(){ try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } }
function saveStory(p){ try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* private mode: progress lives for this visit */ } }
const file = id => (TB_DATA.story || {})[id];
const battleOf = (camp, id) => file(camp).battles.find(b => b.id === id);
const route = p => file(p.campaign).routes[p.nation];
/* The battle the player is on, or null if a fork is waiting for a choice. */
function currentBattle(p){
  const step = route(p)[p.step];
  if(step == null) return null;
  if(Array.isArray(step)) return p.choices[p.step] || null;
  return step;
}

/* The overlay box the menus use, with a title, text and a button column. */
function screen(title, html){
  const box = document.querySelector('#overlay .box');
  box.classList.add('as-folio', 'as-sides-screen'); box.classList.remove('as-victory');
  document.getElementById('overlayTitle').textContent = title;
  document.getElementById('overlaySubtitle').style.display = 'none';   // the title card's 'Field Command' line is not part of these screens
  document.getElementById('overlayText').innerHTML = html;
  document.getElementById('overlayBtn').style.display = 'none';
  const extra = document.getElementById('modeChoices');
  extra.innerHTML = ''; extra.className = 'as-ops'; extra.style.display = 'flex';
  document.getElementById('overlay').classList.add('show');
  return extra;
}
function button(extra, label, sub, onClick){
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'op-choice';
  b.innerHTML = '<span class="op-name"></span>' + (sub ? '<span class="op-arch"></span>' : '');
  b.querySelector('.op-name').textContent = label;
  if(sub) b.querySelector('.op-arch').textContent = sub;
  if(onClick) b.onclick = onClick; else b.disabled = true;
  extra.appendChild(b);
  return b;
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const back = extra => button(extra, 'Back', null, () => import('./ui-menus.js').then(m => m.showModeSelect && m.showModeSelect()));

/* Entry from the title menu: carry on, or start. */
export function showStoryCampaign(){
  const p = loadStory();
  if(p && file(p.campaign)) return showTheatre();
  showNationPick();
}

export function showNationPick(){
  const extra = screen('Campaign', 'Choose the nation you will command. Each campaign follows that nation through its own battles.');
  const nations = NATION_ORDER.filter(n => CAMPAIGNS.some(c => c.nations.includes(n)));
  for(const n of nations){
    const ready = CAMPAIGNS.filter(c => !c.soon && c.nations.includes(n)).map(c => c.name);
    button(extra, n, ready.length ? ready.join(', ') : 'campaigns coming', ready.length ? () => showCampaignPick(n) : null);
  }
  back(extra);
}

function showCampaignPick(nation){
  const extra = screen(`Campaign: ${nation}`, 'Choose a campaign.');
  for(const c of CAMPAIGNS.filter(c => c.nations.includes(nation))){
    button(extra, c.name, c.soon ? `${c.years} · coming` : `${c.years} · ${route({ campaign: c.id, nation }).length} battles`,
      c.soon ? null : () => { saveStory({ campaign: c.id, nation, step: 0, choices: {}, done: [], last: null }); showTheatre(); });
  }
  button(extra, 'Back', null, showNationPick);
}

/* The route: battles won, the one in hand, and those ahead, with forks. */
export function showTheatre(){
  const p = loadStory(); if(!p) return showNationPick();
  const f = file(p.campaign), r = route(p);
  const finished = p.step >= r.length;
  const nodes = r.map((step, i) => {
    const ids = Array.isArray(step) ? step : [step];
    const chosen = Array.isArray(step) ? p.choices[i] : step;
    const label = chosen ? battleOf(p.campaign, chosen).name : ids.map(id => battleOf(p.campaign, id).name).join(' or ');
    const state_ = i < p.step ? 'won' : i === p.step ? 'next' : 'ahead';
    return `<li class="story-node story-${state_}"><span class="story-dot">${state_ === 'won' ? '✓' : i + 1}</span><span>${esc(label)}</span></li>`;
  }).join('');
  const intro = p.step === 0 && !p.last ? `<p>${esc(f.intro || '')}</p>` : '';
  const last = p.last ? `<p><em>${esc(p.last.text)}</em></p>` : '';
  const extra = screen(`${f.name}: ${p.nation}`, `${intro}${last}<ol class="story-route">${nodes}</ol>`);
  if(finished){
    button(extra, 'Campaign complete', `You followed ${p.nation} through ${r.length} battles.`, null);
  } else {
    const step = r[p.step];
    if(Array.isArray(step) && !p.choices[p.step]){
      for(const id of step){
        const b = battleOf(p.campaign, id);
        button(extra, `Fight next: ${b.name}`, `${b.date} · ${b.kind}`, () => { p.choices[p.step] = id; saveStory(p); showBriefing(id); });
      }
    } else {
      const b = battleOf(p.campaign, currentBattle(p));
      button(extra, `Briefing: ${b.name}`, `${b.date} · ${b.kind}`, () => showBriefing(b.id));
    }
  }
  button(extra, 'Start a different campaign', null, () => { if(confirm('Leave this campaign? Its progress will be lost.')){ try { localStorage.removeItem(KEY); } catch { /* ignore */ } showNationPick(); } });
  back(extra);
}

function showBriefing(id){
  const p = loadStory(); const b = battleOf(p.campaign, id);
  const mine = b.sides[p.nation];
  const foes = Object.keys(b.sides).filter(n => FRENCH_SIDE.has(n) !== FRENCH_SIDE.has(p.nation));   // France and its allies (the Poles) against the rest
  const allies = Object.keys(b.sides).filter(n => n !== p.nation && !foes.includes(n));
  const foeLead = foes.slice().sort((a, c) => b.sides[c].brigades.length - b.sides[a].brigades.length)[0];
  const html = `<p><strong>${esc(b.date)}</strong> · ${esc(b.kind)} · ${b.turnLimit} rounds</p>
    <p>${esc(b.history)}</p>
    <p><strong>Your objective:</strong> ${esc(mine.objective.text)}</p>
    <p><strong>${esc(foeLead)}'s objective:</strong> ${esc(b.sides[foeLead].objective.text)}</p>
    ${allies.length ? `<p><strong>Allies:</strong> ${esc(allies.join(', '))}, commanded by the AI.</p>` : ''}
    ${b.special ? `<p><em>${esc(b.special)}</em></p>` : ''}`;
  const extra = screen(b.name, html);
  button(extra, 'To Battle', null, () => {
    const card = getCard(`${p.campaign}-${b.id}-${p.nation.toLowerCase()}`);
    state.storyRun = { campaign: p.campaign, battleId: b.id, nation: p.nation };
    import('./ui-menus.js').then(m => m.beginOperation(card, FRENCH_SIDE.has(p.nation) ? SIDES.BLUE : SIDES.RED));
  });
  button(extra, 'Back', null, showTheatre);
}

/* After a campaign battle (engine-objectives endGame): pass or fight again. */
export function recordStoryResult(){
  const run = state.storyRun; const p = loadStory();
  if(!run || !p) return null;
  const side = FRENCH_SIDE.has(run.nation) ? 'blue' : 'red';
  const passed = !!(state.scenarioResult && state.scenarioResult.achieved && state.scenarioResult.achieved[side]);
  const name = battleOf(p.campaign, run.battleId).name;
  if(passed){ p.done.push(run.battleId); p.step += 1; }
  p.last = { battleId: run.battleId, passed, text: passed ? `${name}: objective achieved.` : `${name}: objective not achieved. Fight it again.` };
  saveStory(p);
  state.storyRun = null;
  return p.last;
}
