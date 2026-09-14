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
};

export function resolveVariant(name){
  if(!(name in VARIANTS)) throw new Error(`unknown variant '${name}' (have: ${Object.keys(VARIANTS).join(', ')})`);
  return VARIANTS[name];
}
