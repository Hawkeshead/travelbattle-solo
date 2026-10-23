/* =========================================================
   BRIGADE PERKS IN THE GAME (perks-core.js has the rules)

   The engine tells this file what happened (a fight, a volley, a gun's shot)
   and asks it for the perks' effects (a +1 in a fight, an easier rally). It
   counts the feats on state.perkState, so undo and saved games carry them,
   announces each perk as it is earned, and leaves the rest to perks-core.

   Off in online and real-time games for now: both phones would have to count
   every feat identically, which they have not been tested to do.
========================================================= */
import { SIDE_LABEL, state, UNIT_TYPES } from './data-core.js';
import { log, logReplay } from './engine-state.js';
import { isAdjacent, terrainAt, unitsAt } from './engine-rules.js';
import { animateUnitTo } from './render-board.js';
import { isOnline } from './online-session.js';
import { PERKS, addFeat, brigKey, commandingBrigadier, newPerkState, perkWorks, perksOf } from './perks-core.js';

export { PERKS };
export const perksOn = () => !isOnline() && !state.group && !state.rts;
/* A new battle (ui-battle startBattle): nothing earned yet. */
export function resetPerks(){ state.perkState = newPerkState(); }
const ps = () => (perksOn() ? state.perkState : null);
// One perk per Brigade; two in a battle of 12 rounds or more (every Quick Battle).
const cap = () => (!state.scenario || (state.scenario.turnLimit || 0) >= 12 ? 2 : 1);
const works = (u, id) => perkWorks(ps(), state.units, u, id, isAdjacent);
const t = u => UNIT_TYPES[u.type] || {};
const foot = u => u.type === 'INFANTRY' || u.type === 'GUARD';

export function brigadeName(side, brigadeId){
  const brig = state.units.find(o => o.side === side && o.brigadeId === brigadeId && o.type === 'BRIGADIER');
  return brig && brig.historicalName ? `${brig.historicalName}'s Brigade` : `${SIDE_LABEL[side]} Brigade ${Number(brigadeId) + 1}`;
}
/* The perks a Brigade holds, for the unit card and the export. */
export function brigadePerks(side, brigadeId){ return perksOf(state.perkState, brigKey(side, brigadeId)); }

function feat(unit, name){
  const p = ps();
  if(!p || !unit || unit.type === 'BRIGADIER') return;
  const key = brigKey(unit.side, unit.brigadeId);
  const id = addFeat(p, key, name, cap());
  if(!id) return;
  const perk = PERKS[id];
  log(`${brigadeName(unit.side, unit.brigadeId)} has ${perk.how} and earns a perk: ${perk.name} (${perk.text}, while in command).`, 'system');
  logReplay('perk', { side: unit.side, brigadeId: unit.brigadeId, perk: id });
  if(id === 'CHARMED'){
    const brig = state.units.find(o => !o.removed && o.side === unit.side && o.brigadeId === unit.brigadeId && o.type === 'BRIGADIER');
    if(brig) brig.leadershipUsed = false;
  }
}

/* ---------- what happened ---------- */
/* After a fight. winner is null for a drawn fight; ambush is the ambush mode, if one was sprung. */
export function perkFight(attacker, defender, outcome, winner, ambush){
  const p = ps();
  if(!p) return;
  // Old Moustaches' +1 is for one fight: spent now by whoever had it.
  for(const u of [attacker, defender]) if(p.avenge[brigKey(u.side, u.brigadeId)] && works(u, 'MOUSTACHES')) delete p.avenge[brigKey(u.side, u.brigadeId)];
  if(winner !== attacker) feat(defender, 'heldGround');
  if(ambush && winner === attacker) feat(attacker, 'ambushWins');
  if(winner && outcome === 'rout' && t(winner).isCavalry) feat(winner, 'cavalryRouts');
  if(winner && state.units.some(o => o.removed && !o.escaped && o.side === winner.side && o.brigadeId === winner.brigadeId && o.type !== 'BRIGADIER')) feat(winner, 'winsAfterLoss');
  if(winner){
    feat(winner, 'wins');
    const brig = state.units.find(o => o.side === winner.side && o.brigadeId === winner.brigadeId && o.type === 'BRIGADIER');
    if(brig && brig.leadershipUsed && !brig.removed) feat(winner, 'winsAfterLeadership');
    if(outcome === 'destroy') feat(winner, 'destroyed');
  }
  // Cavalry beaten off: infantry charged by cavalry that the cavalry did not beat.
  if(foot(defender) && t(attacker).isCavalry && winner !== attacker) feat(defender, 'cavRepelled');
  if(winner === defender && (terrainAt(defender.x, defender.y) || {}).key === 'BUILDING') feat(defender, 'villageHolds');
}
/* A unit of a Brigade is lost (removeUnit): Old Moustaches want revenge. */
export function perkUnitLost(u){
  const p = ps();
  if(p && u && u.type !== 'BRIGADIER' && perksOf(p, brigKey(u.side, u.brigadeId)).includes('MOUSTACHES')) p.avenge[brigKey(u.side, u.brigadeId)] = true;
}
export function perkVolley(shooter, outcome){ if(outcome === 'knockback') feat(shooter, 'knockbacks'); }
export function perkGunDestroyed(gun){ if(gun) feat(gun, 'destroyed'); }

/* ---------- their effects ---------- */
/* Flat +1s for a fight, as the notes the dice panel shows. */
export function perkFightBonus(unit, opponent, defending){
  if(!ps()) return [];
  const out = [];
  if(defending && foot(unit) && t(opponent).isCavalry && works(unit, 'STEADY')) out.push('Steady Lads: +1 to roll');
  if(t(unit).isCavalry && works(unit, 'BLOODTHIRSTY')) out.push('Bloodthirsty: +1 to roll');
  if(defending && (terrainAt(unit.x, unit.y) || {}).key === 'BUILDING' && works(unit, 'STREET')) out.push('Street Fighters: +1 to roll');
  if(ps().avenge[brigKey(unit.side, unit.brigadeId)] && works(unit, 'MOUSTACHES')) out.push('Old Moustaches: +1 to roll');
  return out;
}
export const perkVolleyBonus = shooter => (ps() && works(shooter, 'MARKSMEN') ? 1 : 0);
/* Guerrillas: woods count as road for the road bonus (infantry only). */
export const perkWoodsAsRoad = u => !!(ps() && (u.type === 'INFANTRY' || u.type === 'GUARD') && works(u, 'GUERRILLAS'));
/* Stubborn: once a turn per Brigade, a unit that would be pushed back stands. */
export function perkStandsGround(loser){
  const p = ps();
  if(!p || !works(loser, 'STUBBORN')) return false;
  const key = brigKey(loser.side, loser.brigadeId);
  if(p.stoodTurn[key] === state.turnNumber) return false;
  p.stoodTurn[key] = state.turnNumber;
  log(`${loser.historicalName || loser.type} stands its ground (Stubborn).`, 'combat');
  logReplay('perkUsed', { perk: 'STUBBORN', unitId: loser.id, side: loser.side });
  return true;
}
/* Pursuers: after a rout, the winning cavalry ride into the square the enemy
   left, if it is empty, open to cavalry, next to them, and they stay in
   command there (a pursuit never cuts a unit off from its Brigadier). */
export function perkPursue(winner, x, y){
  if(!ps() || winner.removed || !t(winner).isCavalry || !works(winner, 'PURSUERS')) return;
  if(unitsAt(x, y).length || !isAdjacent(winner, { x, y })) return;
  const terr = terrainAt(x, y) || {};
  if(terr.restrictTo && !terr.restrictTo.includes(winner.type)) return;
  const was = { x: winner.x, y: winner.y };
  winner.x = x; winner.y = y;
  const stays = works(winner, 'PURSUERS');
  winner.x = was.x; winner.y = was.y;
  if(!stays) return;
  animateUnitTo(winner, x, y, 'advanceAfterCombat');
  log(`${winner.historicalName || winner.type} ride after them into the ground they left (Pursuers).`, 'combat');
  logReplay('perkUsed', { perk: 'PURSUERS', unitId: winner.id, side: winner.side, x, y });
}
/* Inspiring Presence: rally one better, never for guns. */
export const perkRallyBetter = unit => !!(ps() && unit.type !== 'ARTILLERY' && works(unit, 'INSPIRING'));
/* For the unit's sash: "★ Steady Lads", or "(out of command)" when it is cut off from its Brigadier. */
export function perkLine(u){
  if(!ps() || !u) return '';
  const held = brigadePerks(u.side, u.brigadeId);
  if(!held.length) return '';
  const inCommand = !!commandingBrigadier(state.units, u, isAdjacent);
  return '\u2605 ' + held.map(id => PERKS[id].name).join(', ') + (inCommand ? '' : ' (out of command)');
}
