/* =========================================================
   SCENARIO CARDS (Operations and Campaigns brief, step 1)

   One card per engagement, Battles and Operations alike, in
   data/scenario-cards.json: the single source of scenario content, built from
   the Hub's campaigns.json. The old data/scenarios.json is kept unchanged in
   data/legacy/ and no longer loaded.

   This module loads the cards, maps the cards' 'british'/'french' to the
   engine's SIDES.RED/BLUE, validates every card, and exposes getCard(id) and
   readyCards(). A card that fails validation logs a clear error naming the
   card and the fault, and is never offered as ready.

   Conventions on a card:
   - turnLimit counts FULL ROUNDS (both sides have moved, fired and fought).
     The engine's state.turnNumber counts side-turns, so the old "turn 8"
     limits were really four rounds.
   - Map coordinates are [x, y] on the 20 x 10 board, x across, y down;
     Britain deploys on rows 8-9, France on rows 0-1.
   - A unit in a Brigade list is a type string, or { type, formation } for a
     unit that starts in a formation (step 8 uses this).
========================================================= */
import { SIDES, TB_DATA } from './data-core.js';
import { validateCard } from './scenario-validate.js';

export const SIDE_OF = { british: SIDES.RED, french: SIDES.BLUE };
export { CARD_SIDES, CONDITION_TYPES, SPECIAL_RULES_ALLOWED, UNIT_TYPES_ALLOWED, validateCard } from './scenario-validate.js';

/* ---------- loading ---------- */
const FILE = TB_DATA.scenarioCards || { cards: [] };
const CARDS = Array.isArray(FILE.cards) ? FILE.cards : [];
const FAULTS = new Map();
for(const c of CARDS){
  const errs = validateCard(c);
  if(errs.length){
    FAULTS.set(c.id, errs);
    if(typeof console !== 'undefined') console.error('[scenario-cards] ' + errs.join('\n[scenario-cards] '));
  }
}

export const allCards = () => CARDS.slice();
export const getCard = id => CARDS.find(c => c.id === id) || null;
export const cardFaults = id => FAULTS.get(id) || [];
/* Playable cards: status ready and no validation faults. kind optional. */
export const readyCards = kind => CARDS.filter(c => c.status === 'ready' && !FAULTS.has(c.id) && (!kind || c.kind === kind));

/* The campaign flows (data/campaigns.json): every step and branch option is a
   card id. Returns every id a flow names that has no card. */
export function missingFlowCards(flows = TB_DATA.campaigns || []){
  const missing = [];
  for(const f of flows) for(const s of (f.steps || [])){
    const ids = s.type === 'branch' ? (s.options || []) : [s.card];
    for(const id of ids) if(!getCard(id)) missing.push(`${f.id}/${s.id}: ${id}`);
  }
  return missing;
}
