/* =========================================================
   REAL-TIME FIELD COMMAND: every timing and balance value.

   First guesses from the build plan, to be tuned in the simulator. All
   timings are in simulation ticks (TICKS_PER_SECOND of them to a second of
   play); the simulation never reads the wall clock.
========================================================= */
export const TICKS_PER_SECOND = 10;
export const TICK_MS = 1000 / TICKS_PER_SECOND;
const s = seconds => Math.round(seconds * TICKS_PER_SECOND);

// Command (built in Phase 2)
export const ORDER_REGEN_TICKS = s(10);          // one order per Brigadier every 10s; the pool starts full
export const COOLDOWN_TICKS = { INFANTRY: s(15), GUARD: s(15), LIGHT_CAV: s(10), HEAVY_CAV: s(10), ARTILLERY: s(15), BRIGADIER: s(8) };

// Movement: time to cross one square
export const TRAVEL_TICKS = { INFANTRY: s(5), GUARD: s(5), LIGHT_CAV: s(2.5), HEAVY_CAV: s(2.5), ARTILLERY: s(7), BRIGADIER: s(2.5) };
export const ROAD_TRAVEL_FACTOR = 2/3;           // about a third faster along a road
export const LIMBER_TICKS = s(5);                // artillery delay before it moves (Phase 4)
export const BLOCKED_WAIT_TICKS = s(1.5);        // a unit whose next square is taken waits this long, then finds another way
export const GROUP_SPREAD = 2;                   // a group order spreads its units over squares up to this far from the one tapped

// Combat (Phases 3 and 4)
export const MELEE_ROUND_TICKS = s(6);
export const ARTILLERY_RELOAD_TICKS = s(30);
export const FORM_TICKS = { SQUARE: s(8), COLUMN: s(5), AMBUSH: s(5) };
export const WOODS_OCCUPANCY_TICKS = s(10);
export const TURNED_AROUND_TICKS = s(12);
export const ROUT_TO_RALLY_TICKS = s(10);

// Clock
export const TURN_EQUIVALENT_TICKS = s(60);      // converts anything written in turns
export const MATCH_CLOCK_TICKS = s(30 * 60);

// AI (Phase 5)
export const AI_EVAL_TICKS = s(2);
export const AI_REACTION_TICKS = [s(1), s(2)];

// Rendering: never let a slow frame run more than this many ticks at once
export const MAX_TICKS_PER_FRAME = 20;
