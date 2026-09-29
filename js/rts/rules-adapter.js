/* The turn-based rules the simulation borrows, read straight from the
   turn-based engine so the two games can never disagree about them:
   - inChain: is the unit on its Brigadier's chain (movableUnitsForSide)?
   - reachable: where one order may take it (legalMoves: its move allowance,
     the road bonus, terrain it cannot enter, ploughed fields, stacking).

   Those functions read the shared game state, so the board's units are first
   put on the squares the simulation holds them on (a unit crossing a square
   counts as on the square it is entering), with nothing marked as having
   moved. Read-only use of the shared modules: nothing in them is changed. */
import { state } from '../data-core.js';
import { canAttackTarget, canRerollFight, combatBonuses, legalMoves, movableUnitsForSide, terrainAt } from '../engine-rules.js';

function syncShared(b){
  for(const su of b.units){
    const u = state.units.find(x => x.id === su.id);
    if(!u) continue;
    u.removed = su.removed;
    u.x = su.step ? su.step.toX : su.x;
    u.y = su.step ? su.step.toY : su.y;
    u.turnOnly = b.tick < su.turnedUntil;     // turned around: the turn-based name for it
    u.charged = false;                         // the charge arrives in Phase 4
  }
  state.moved = new Set();
}
const shared = su => state.units.find(x => x.id === su.id);

export const turnBasedRules = {
  inChain(b, su){
    syncShared(b);
    return movableUnitsForSide(su.side).has(su.id);
  },
  reachable(b, su){
    syncShared(b);
    const u = shared(su);
    return u ? legalMoves(u).map(c => ({ x: c.x, y: c.y, steps: c.steps })) : [];
  },
  /* Melee, from the same engine: who may attack whom (a Brigadier never; cavalry
     never into a village), and the dice and flat bonuses each side brings
     (terrain, Square against cavalry, cavalry against open infantry, and the
     rest of combatBonuses). Whether each may re-roll, and whether the defender
     stands higher, which wins it a tie. Positions as the fight sees them: a
     unit's actual square, not the one it is heading for. */
  canAttack(b, sa, sd){
    syncFight(b);
    const a = shared(sa), d = shared(sd);
    return !!(a && d && canAttackTarget(a, d));
  },
  fightDice(b, sa, sd){
    syncFight(b);
    const a = shared(sa), d = shared(sd);
    const ab = combatBonuses(a, d, false, []), db = combatBonuses(d, a, true, []);
    return {
      aDice: ab.dice, dDice: db.dice,
      aBonus: ab.valueBonus || 0, dBonus: db.valueBonus || 0,
      aReroll: canRerollFight(a, { value: 0 }), dReroll: canRerollFight(d, { value: 0 }),
      defenderHigher: terrainAt(d.x, d.y).elevation > terrainAt(a.x, a.y).elevation,
    };
  },
};
function syncFight(b){
  syncShared(b);
  for(const su of b.units){ const u = shared(su); if(u){ u.x = su.x; u.y = su.y; } }
}
