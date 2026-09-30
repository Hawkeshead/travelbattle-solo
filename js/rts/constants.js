/* =========================================================
   REAL-TIME FIELD COMMAND: every timing and balance value.

   First guesses from the build plan, to be tuned in the simulator. All
   timings are in simulation ticks (TICKS_PER_SECOND of them to a second of
   play); the simulation never reads the wall clock.
========================================================= */
/* The simulator's tuning sweeps set globalThis.__RTS_TUNE = { NAME: seconds }
   before this file loads, to try other values without editing it. A played
   game never sets it, so every value below is exactly as written. */
const TUNE = (globalThis.__RTS_TUNE) || {};
const tuned = (name, v) => (name in TUNE ? TUNE[name] : v);

export const TICKS_PER_SECOND = 10;
export const TICK_MS = 1000 / TICKS_PER_SECOND;
const s = seconds => Math.round(seconds * TICKS_PER_SECOND);

// Command (built in Phase 2)
export const ORDER_REGEN_TICKS = s(tuned('ORDER_REGEN', 50));          // one order per Brigadier every 50s (tuned, see RTS_TUNING.md; plan start 10s); the pool starts full
const CD = tuned('COOLDOWN_SCALE', 1);
export const COOLDOWN_TICKS = { INFANTRY: s(15*CD), GUARD: s(15*CD), LIGHT_CAV: s(10*CD), HEAVY_CAV: s(10*CD), ARTILLERY: s(15*CD), BRIGADIER: s(8*CD) };

// Movement: time to cross one square
const TV = tuned('TRAVEL_SCALE', 1);
export const TRAVEL_TICKS = { INFANTRY: s(5*TV), GUARD: s(5*TV), LIGHT_CAV: s(2.5*TV), HEAVY_CAV: s(2.5*TV), ARTILLERY: s(7*TV), BRIGADIER: s(2.5*TV) };
export const ROAD_TRAVEL_FACTOR = 2/3;           // about a third faster along a road
export const LIMBER_TICKS = s(tuned('LIMBER', 5));                // artillery delay before it moves (Phase 4)
export const BLOCKED_WAIT_TICKS = s(1.5);        // a unit whose next square is taken waits this long, then finds another way
export const GROUP_SPREAD = 2;                   // a group order spreads its units over squares up to this far from the one tapped

// Combat (Phases 3 and 4)
export const MELEE_ROUND_TICKS = s(tuned('MELEE_ROUND', 6));
export const ARTILLERY_RELOAD_TICKS = s(tuned('ARTILLERY_RELOAD', 35));   // tuned (plan start 30s), see RTS_TUNING.md
export const FORM_TICKS = { SQUARE: s(8), COLUMN: s(5), AMBUSH: s(5), LINE: s(5) };   // LINE: back out of Square
export const MID_FORMATION_PENALTY = 1;         // a unit caught changing formation fights at -1
export const ARTILLERY_RANGE = 6;                // as turn-based hasLOS
export const WOODS_OCCUPANCY_TICKS = s(10);
export const TURNED_AROUND_TICKS = s(tuned('TURNED_AROUND', 12));
export const ROUT_TO_RALLY_TICKS = s(tuned('ROUT_TO_RALLY', 10));
export const PUSHBACK_TRAVEL_FACTOR = 0.5;       // a pushed-back unit crosses its square twice as fast
// Rally on a d6 (turn-based retreatAndRally): Guard and Heavy Cavalry 3+, Artillery 5+, the rest 4+
export const RALLY_ON = { INFANTRY: 4, LIGHT_CAV: 4, GUARD: 3, HEAVY_CAV: 3, ARTILLERY: 5, BRIGADIER: 4 };

// Clock
export const TURN_EQUIVALENT_TICKS = s(60);      // converts anything written in turns
export const MATCH_CLOCK_TICKS = s(30 * 60);
// Points when the clock runs out: the value of each enemy unit destroyed. The
// turn-based unit values (ai-tactics AI_UNIT_VALUE), with Light Cavalry raised
// to match Heavy, so Guard, cavalry and guns are all worth more than line infantry.
export const POINT_VALUE = { INFANTRY: 4, GUARD: 5, LIGHT_CAV: 5, HEAVY_CAV: 5, ARTILLERY: 6, BRIGADIER: 0 };

// AI (Phase 5)
export const AI_EVAL_TICKS = s(2);
export const AI_REACTION_TICKS = [s(1), s(2)];

// Rendering: never let a slow frame run more than this many ticks at once
export const MAX_TICKS_PER_FRAME = 20;
