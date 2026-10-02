/* =========================================================
   MATCH TELEMETRY: THE GAME-SIDE HOOKS FOR THE MISSED-OPPORTUNITY CHECKS

   Called from ui-battle at three moments of a side's turn, for HUMAN sides
   only: as its move phase begins (reach sets), as its move phase ends, and as
   its fight phase ends. Each wraps the dry-run checks in telemetry/missed.js
   with the game's own rules, and hands any flags to the recorder. Nothing here
   rolls a die or changes the game; any error is swallowed (and recorded).
========================================================= */
import { state } from '../data-core.js';
import { legalMoves, computeChargeDestinations, hasLOS, chebyshev, stackPartner, isAdjacent } from '../engine-rules.js';
import { checksAfterFight, checksAfterMove, reachAtTurnStart } from './missed.js';
import { recActive, recEventsSince, recMissed, recSeq, sideIsHuman } from './recorder.js';

const RULES = { legalMoves, computeChargeDestinations, hasLOS, chebyshev, stackPartner, isAdjacent,
  terrainAt: (x, y) => (state.terrain && state.terrain[y] ? state.terrain[y][x] : null) };

let reach = null, reachSide = null, fightFrom = 0;
const ok = side => { try { return recActive() && sideIsHuman(side); } catch { return false; } };

export function telemetryMoveBegins(side){
  reach = null; reachSide = null;
  if(!ok(side)) return;
  try { reach = reachAtTurnStart(state.units, side, RULES); reachSide = side; } catch { reach = null; }
}
export function telemetryMoveEnds(side){
  if(!ok(side)) return;
  try { recMissed(side, checksAfterMove(state.units, side, reachSide === side ? reach : null, RULES)); } catch { /* recorded nothing */ }
  fightFrom = recSeq();
}
export function telemetryFightEnds(side){
  if(!ok(side)) return;
  try {
    const fights = recEventsSince(fightFrom, 'fight').filter(e => e.payload.attackerSide === side)
      .map(e => ({ attackerId: e.payload.attackerId, defenderId: e.payload.defenderId }));
    recMissed(side, checksAfterFight(state.units, side, fights, reachSide === side ? reach : null, RULES));
  } catch { /* recorded nothing */ }
}
