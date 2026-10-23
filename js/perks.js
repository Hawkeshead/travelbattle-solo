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
import { isAdjacent, terrainAt } from './engine-rules.js';
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
/* After a fight. winner is null for a drawn fight. */
export function perkFight(attacker, defender, outcome, winner){
  if(!ps()) return;
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
  return out;
}
export const perkVolleyBonus = shooter => (ps() && works(shooter, 'MARKSMEN') ? 1 : 0);
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
