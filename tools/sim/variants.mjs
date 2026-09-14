/* =========================================================
   VARIANTS

   A variant is an override table read by tune() and flag() in ai-strategy. An
   empty table is the current AI exactly, which is what makes 'control' below
   meaningful rather than a copy of the code that might drift from it.

   Add a variant here, run it against control, keep it or delete it. Nothing in
   js/ changes to run an experiment, which is the point: a rejected variant
   leaves no trace and an accepted one is a small, reviewable diff of defaults.
========================================================= */

export const VARIANTS = {
  control: {},

  /* Part B of the AI behaviour brief: five weight changes in one pass.
     Values are the brief's, not tuned here. */
  b_weights: {
    GUN_HOLDS_FIRE_BONUS:   3.00,   // B1: was reaching 1.55-2.07, sat at 3.10 when guns performed
    GUN_PENALTY_TOTAL_CAP:  2.00,   // B2: two groups at 1.75 each currently sum to 3.50
    SCREENS_GUN_WEIGHT:     3.00,   // B3: a MULTIPLIER on a 0.50 bonus, so the term reads +1.50
    COLUMN_BREAK_WEIGHT:    8,      // B4: was 4, at which a stacked pair one tile further is never chosen
    HEAVY_PAIR_BONUS:       2.00,   // B5: new, two heavy regiments within two tiles
  },

  /* Part C: two logic additions. C2 is not here — see the README. */
  c_logic: {
    CAVALRY_MAY_RANGE:       true,   // C1: slip the leash for a fight worth taking
    CAVALRY_RANGE_THRESHOLD: 3.0,
    VOLLEY_SETUP:            true,   // C3: score a volley by its follow-up
    VOLLEY_FLOOR:            1.0,
  },

  /* Parts B and C together, which is what the brief's run actually wants. */
  bc: {
    GUN_HOLDS_FIRE_BONUS:   3.00,
    GUN_PENALTY_TOTAL_CAP:  2.00,
    SCREENS_GUN_WEIGHT:     3.00,
    COLUMN_TARGET_BONUS:    8,
    HEAVY_PAIR_BONUS:       2.00,
    CAVALRY_MAY_RANGE:      true,
    CAVALRY_RANGE_THRESHOLD: 3.0,
    VOLLEY_SETUP:           true,
    VOLLEY_FLOOR:           1.0,
  },

  /* Part E items, each on its own so they can be tested one at a time as the
     brief intended rather than landing as one confounded block. */
  gun_raid:  { GUN_RAID: true, GUN_RAID_PULL: 0.15 },
  gun_raid_hard: { GUN_RAID: true, GUN_RAID_PULL: 0.35 },
  adaptive:  { ADAPT_TO_MATERIAL: true, ADAPT_MARGIN: 2.0 },
  adaptive_tight: { ADAPT_TO_MATERIAL: true, ADAPT_MARGIN: 1.0 },
};

export function resolveVariant(name){
  if(!(name in VARIANTS)) throw new Error(`unknown variant '${name}' (have: ${Object.keys(VARIANTS).join(', ')})`);
  return VARIANTS[name];
}
