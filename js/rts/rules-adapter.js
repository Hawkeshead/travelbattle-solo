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
import { legalMoves, movableUnitsForSide } from '../engine-rules.js';

function syncShared(b){
  for(const su of b.units){
    const u = state.units.find(x => x.id === su.id);
    if(!u) continue;
    u.removed = su.removed;
    u.x = su.step ? su.step.toX : su.x;
    u.y = su.step ? su.step.toY : su.y;
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
};
