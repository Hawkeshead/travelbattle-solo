/* =========================================================
   CAMPAIGN PLAY (Operations and Campaigns brief, step 6; first version, 4 Oct 2026)

   A campaign is played on this phone against the AI, as one side, step by
   step through its flow in data/campaigns.json: a Battle, then an Operation
   chosen from two, a Battle, an Operation chosen from two, a final Battle.

   - BATTLES are full three-Brigade matches with equal armies, as a standard
     match, on the Battle's own map (an authored 20 x 10 map on its card),
     with no orientation roll: straight to choosing your army and deploying.
   - OPERATIONS are played exactly as from the Operations menu.
   - A CHOICE ("Winner of Famars chooses which Operation to play next"): if
     you won the step before, you pick; if the AI won, it picks, and you are
     told which and why.
   - THE CAMPAIGN is won by the side with more engagements won (five steps,
     so never a tie).

   Progress is kept on the phone (localStorage, fc_campaign_v2) after every
   step, so a campaign survives closing the app; the battle in progress
   itself is saved by match-save.js and resumed from the start screen. Every
   match's record also carries the campaign, the step and the choice made
   (telemetry derived.campaign), so the campaign can be read back from the
   records.

   Not in this first version: regiments keeping their names from one step to
   the next, and carrying a campaign across devices.
========================================================= */
import { SIDES, SIDE_LABEL, TB_DATA, setBoardMode, assignBuildingStyles, assignGrassStyles, state } from './data-core.js';
import { getCard } from './scenario-cards.js';
import { authoredTerrain } from './operations.js';
import { seededRandom } from './engine-rules.js';

const KEY = 'fc_campaign_v2';
const flows = () => TB_DATA.campaigns || [];
export const flowById = id => flows().find(f => f.id === id) || null;

/* A flow is playable when every card it can reach is ready. */
export function flowReady(flow){
  return flow.steps.every(s => (s.type === 'branch' ? s.options : [s.card]).every(id => { const c = getCard(id); return c && c.status === 'ready'; }));
}

/* ---------- progress ---------- */
export function loadCampaign(){
  try { const p = JSON.parse(localStorage.getItem(KEY) || 'null'); return p && p.v === 1 ? p : null; } catch { return null; }
}
function saveCampaign(p){ try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* no storage: the campaign lasts this session */ } }
export function abandonCampaign(){ try { localStorage.removeItem(KEY); } catch { /* nothing kept */ } }

export function startCampaign(flowId, playerSide){
  const p = { v: 1, id: flowId, playerSide, step: 0, results: [], choices: {}, startedAt: new Date().toISOString() };
  saveCampaign(p);
  return p;
}

/* The card for step i, once any choice has been made; null for a branch
   still waiting for its choice. */
export function cardForStep(p, i){
  const s = flowById(p.id).steps[i];
  if(!s) return null;
  if(s.type === 'branch') return p.choices[s.id] ? getCard(p.choices[s.id]) : null;
  return getCard(s.card);
}
/* Who chooses at a branch: the winner of the step before ("either" side). */
export function chooserFor(p, i){
  const prev = p.results[i - 1];
  return prev ? prev.winner : null;
}
/* The AI's pick: the Operation that suits its side better, decided by which
   side the option's own win conditions favour on time (who wins if the clock
   runs out), else the first; a coin decides between two equal ones. */
export function aiChooses(p, i){
  const s = flowById(p.id).steps[i];
  const aiKey = p.playerSide === SIDES.RED ? 'french' : 'british';
  const scored = s.options.map(id => { const c = getCard(id); return { id, good: c && c.ifTimeExpires === aiKey ? 1 : 0 }; });
  const best = Math.max(...scored.map(o => o.good));
  const pool = scored.filter(o => o.good === best);
  return pool[Math.floor(seededRandom() * pool.length)].id;
}
export function choose(p, i, cardId){
  const s = flowById(p.id).steps[i];
  p.choices[s.id] = cardId;
  saveCampaign(p);
}

/* The match just ended (engine-objectives endGame calls this). Returns the
   updated progress, or null when no campaign step was being played. */
export function recordResult(winner){
  const run = state.campaignRun;
  if(!run) return null;
  const p = loadCampaign();
  if(!p || p.id !== run.id || p.step !== run.step) return null;
  p.results[p.step] = { stepId: run.stepId, cardId: run.cardId, winner, at: new Date().toISOString() };
  p.step += 1;
  saveCampaign(p);
  return p;
}
export function campaignFinished(p){ return p && p.step >= flowById(p.id).steps.length; }
export function tally(p){
  const t = { [SIDES.RED]: 0, [SIDES.BLUE]: 0 };
  for(const r of p.results) if(r && t[r.winner] != null) t[r.winner]++;
  return t;
}

/* What the match record should say about the campaign (telemetry). */
export function campaignContext(){
  /* A campaign MAP battle (campaign-map-battle.js) is tagged with the campaign,
     the map turn and the town, so its match record can be found from the map. */
  const mb = state.mapBattle;
  if(mb) return { kind: 'campaign-map', battleType: mb.kind || 'battle', rearguard: mb.kind === 'rearguard', campaignId: mb.campaignId, battleId: mb.battleId, turn: mb.turn, date: mb.date, townId: mb.townId, town: mb.townName };
  const run = state.campaignRun;
  return run ? { id: run.id, step: run.step, stepId: run.stepId, card: run.cardId, chosenBy: run.chosenBy || null } : null;
}

/* ---------- a Battle on its own map ---------- */
/* Sets up the board for a campaign Battle: the card's authored map, no
   orientation roll. The caller then starts deployment as a standard match. */
export function applyBattleMap(card){
  state.mapBattle = null;   // a scripted campaign Battle, not a campaign map battle
  const m = card.map;
  if(m && m.type === 'authored'){
    const t = authoredTerrain(m.terrain);
    setBoardMode(t[0].length === 10 ? 'single' : 'standard');
    state.boardAssignment = null; state.boardRotation = null;
    state.terrain = t;
    state.grassStyles = assignGrassStyles(t);
    state.buildingStyles = assignBuildingStyles(t);
    state.excludedRoadEdges = new Set();
    return true;
  }
  return false;
}
export const sideName = s => SIDE_LABEL[s];
