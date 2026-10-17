import { COLS, ROWS, SIDES, state } from './data-core.js';
import { DEFAULT_GROUP_NATIONS, NATIONS, armyKeysFor, cannotField, groupPick } from './nations.js';

/* =========================================================
   GROUP: FOUR ARMIES, TWO TEAMS (2v2)

   Played on the 20x20 four-board map. Each army starts against one edge and
   the two armies of a team hold adjacent edges, so each team owns a corner:
   the Coalition the south-east, France the north-west.

   A unit's `side` stays its TEAM ('red' or 'blue'), which is why nearly every
   existing rule already treats an ally as friendly and an enemy as an enemy.
   What is new is `army`: which of the four armies it belongs to. That decides
   whose turn it may act on, which edge is home, and which army breaks.

   Brigade ids stay unique within a team: the first army's brigades are 0-2
   and the second army's 3-5, so a Brigadier's chain can never run through an
   ally.

   Turns go one army at a time, alternating teams (for example France 2,
   Britain 1, France 1, Britain 2), in an order rolled once at the start and
   kept for the match. state.turn is still the TEAM whose army is acting, so
   everything that asks "whose turn is it" keeps working; state.turnArmy says
   which of that team's armies it is.
========================================================= */

/* NATIONS. Each army's nation is chosen per match (state.groupNations, one
   pick per army, by seat): any Coalition nation for the south and east armies,
   any Imperial one for the north and west, within the limits in
   js/nations.js (one army per nation, Russia and France up to two). A
   nation's second army fights under its own roster ('france_2'). Where
   nobody picks it is Britain and Prussia against two French armies. Each
   army's units carry its nation (u.nation), so names, art and dice follow the
   army, not the side. Everything else about an army (its label, colour,
   recolour) is read from its pick, so every phone shows the same. */
export { DEFAULT_GROUP_NATIONS };
const SECOND_COLOR = { france: '#6a4a8c', russia: '#5e7d2c' };   // a nation's second army, told apart from its first
const pickOf = id => groupPick(state.groupNations, id);
function makeArmy(id, side, edge, brigadeOffset){
  const ids = side === SIDES.RED ? ['red1', 'red2'] : ['blue1', 'blue2'];
  const i = ids.indexOf(id);
  return { id, side, edge, brigadeOffset,
    get pick(){ return pickOf(id); },
    get nation(){ return armyKeysFor(ids.map(pickOf))[i]; },
    get twin(){ return pickOf(ids[0]) === pickOf(ids[1]); },              // both armies of the side are one nation
    get second(){ return this.twin && i === 1; },
    get label(){ const n = NATIONS[this.pick].name; return this.second ? `${n} (2nd Army)` : n; },
    get short(){ const n = NATIONS[this.pick].name; return this.twin ? `${n} ${i ? 'II' : 'I'}` : n; },
    get color(){ return this.second ? (SECOND_COLOR[this.pick] || NATIONS[this.pick].colours.dim) : NATIONS[this.pick].colours.main; },
    // A second army of a nation with classic icons has them recoloured (Classic models only).
    get skin(){ return this.second && NATIONS[this.pick].classic ? 2 : 1; } };
}
export const GROUP_ARMIES = [
  makeArmy('red1', SIDES.RED, 'S', 0),
  makeArmy('red2', SIDES.RED, 'E', 3),
  makeArmy('blue1', SIDES.BLUE, 'N', 0),
  makeArmy('blue2', SIDES.BLUE, 'W', 3),
];
export const TEAM_LABEL = { red:'the Coalition', blue:'the Imperial side' };
/* Why this army cannot take that nation, given the other army of its side
   (a short reason for a greyed-out choice), or null. */
export function groupNationProblem(picks, armyId, key){
  const mate = { red1: 'red2', red2: 'red1', blue1: 'blue2', blue2: 'blue1' }[armyId];
  const other = (picks && picks[mate]) || DEFAULT_GROUP_NATIONS[mate];
  return cannotField([other], key);
}

export function isGroup(){ return !!state.group; }
export function armyById(id){ return GROUP_ARMIES.find(a => a.id === id) || null; }
export function armyOf(u){ return u ? armyById(u.army) : null; }
export function actingArmy(){ return state.group ? armyById(state.turnArmy) : null; }

/* May this unit act now? Outside Group this is exactly the old test. */
export function isActing(u){
  return !!u && u.side === state.turn && (!state.group || u.army === state.turnArmy);
}
/* For code that is handed a side ("does SIDE owe a fight"): when that side is
   the one acting in Group, only the acting army's units count. Asking about the
   other team is unaffected. */
export function actsFor(u, side){
  return u.side === side && (!state.group || side !== state.turn || u.army === state.turnArmy);
}

/* ---------------------------------------------------------
   LOCAL FRAME: the board as seen from an army's own edge, home rows at the
   bottom (local row ROWS-1 is the home edge). The same mapping the screen view
   uses, kept here so the engine never has to import the renderer.
--------------------------------------------------------- */
export function toLocal(edge, x, y){
  switch(edge){
    case 'N': return { x, y: ROWS-1-y };
    case 'E': return { x: ROWS-1-y, y: x };
    case 'W': return { x: y, y: COLS-1-x };
    default:  return { x, y };
  }
}
export function fromLocal(edge, lx, ly){
  switch(edge){
    case 'N': return { x: lx, y: ROWS-1-ly };
    case 'E': return { x: ly, y: ROWS-1-lx };
    case 'W': return { x: COLS-1-ly, y: lx };
    default:  return { x: lx, y: ly };
  }
}

const TEAM_CORNER = { red:{ x:COLS-1, y:ROWS-1 }, blue:{ x:0, y:0 } };

/* DEPLOYMENT ZONE, in the army's local frame: its two home rows, trimmed at
   both ends. The corner squares belong to two edges, so each strip stops two
   squares short of its own team's corner (the allies' shared rear), and five
   short of the contested corner where it meets an enemy edge, so the two
   enemy armies there do not start within a turn of each other. */
export const GROUP_DEPLOY_ROWS = 2;
const FRIENDLY_CORNER_TRIM = 2, ENEMY_CORNER_TRIM = 5;
export function deployZoneLocal(army){
  const c = TEAM_CORNER[army.side];
  const cornerLocal = toLocal(army.edge, c.x, c.y);
  const cornerOnRight = cornerLocal.x > COLS/2;
  const cols = cornerOnRight
    ? [ENEMY_CORNER_TRIM, COLS-1-FRIENDLY_CORNER_TRIM]
    : [FRIENDLY_CORNER_TRIM, COLS-1-ENEMY_CORNER_TRIM];
  return { cols, frontRow: ROWS-GROUP_DEPLOY_ROWS, backRows: [ROWS-1] };
}
export function inDeployZone(army, x, y){
  const l = toLocal(army.edge, x, y), z = deployZoneLocal(army);
  return l.y >= ROWS-GROUP_DEPLOY_ROWS && l.x >= z.cols[0] && l.x <= z.cols[1];
}

/* Board squares along an army's home edge, in local left-to-right order. */
export function homeEdgeCells(army){
  const out = [];
  for(let lx=0; lx<COLS; lx++) out.push(fromLocal(army.edge, lx, ROWS-1));
  return out;
}

/* ---------------------------------------------------------
   TURN ORDER
--------------------------------------------------------- */
export function rollTurnOrder(rng){
  const first = rng() < 0.5 ? SIDES.RED : SIDES.BLUE;
  const second = first === SIDES.RED ? SIDES.BLUE : SIDES.RED;
  const pick = side => {
    const two = GROUP_ARMIES.filter(a => a.side === side).map(a => a.id);
    return rng() < 0.5 ? two : two.reverse();
  };
  const a = pick(first), b = pick(second);
  return [a[0], b[0], a[1], b[1]];
}

/* ---------------------------------------------------------
   BREAKING. An army is broken when 2 of its 3 Brigades are. A team is beaten
   when both its armies are.
--------------------------------------------------------- */
export function armyBrigadeIds(army){ return [0,1,2].map(i => army.brigadeOffset + i); }
export function armyBrokenCount(army){
  let broken = 0;
  for(const bId of armyBrigadeIds(army)){
    const group = state.units.filter(u => u.side === army.side && u.brigadeId === bId);
    if(group.length === 0) continue;
    if(!group.some(u => !u.removed && u.type !== 'BRIGADIER')) broken++;
  }
  return broken;
}
export function isArmyOut(army){
  return !!(state.groupArmyOut && state.groupArmyOut[army.id]);
}

/* The next army to act after the current one, skipping any that are out. */
export function nextTurnArmy(){
  const order = state.groupTurnOrder || [];
  const i = order.indexOf(state.turnArmy);
  for(let k=1; k<=order.length; k++){
    const id = order[(i + k) % order.length];
    if(!isArmyOut(armyById(id))) return { id, wrapped: (i + k) >= order.length };
  }
  return null;
}

/* ONLINE GROUP: which armies this phone commands (state.groupControlled, never
   shared). The game already treats "the AI side" as the one whose input is
   locked and whose dice roll themselves, so each phone points aiSide at the
   other team when one of its own armies is acting, and at the acting team
   otherwise (nothing to touch, and the AI never acts while online). Called
   whenever the acting army changes. Does nothing outside online Group. */
export function refreshGroupControl(){
  if(!state.group || !Array.isArray(state.groupControlled)) return;
  const mine = state.groupControlled.includes(state.turnArmy);
  state.mode = 'ai';
  state.aiSide = mine ? (state.turn === SIDES.RED ? SIDES.BLUE : SIDES.RED) : state.turn;
}
