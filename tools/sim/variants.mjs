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
  /* Recovery errands are ON by default, so the experiment is turning them OFF. */
  no_errands:  { BRIGADE_ERRANDS: 0 },
  /* The finishing rule is ON by default, so the experiment turns it OFF. */
  no_finishing: { FINISHING_RULE: 0 },
  no_shelter:  { SHELTER_MISSION: 0 },
  /* Stage B is ON as of Alexander, so the experiment turns it OFF. */
  no_army_plan: { ARMY_PLAN_ACTS: 0 },
  /* Brigade-level: the Brigade advances to a waypoint as a formation. */
  brigade_plan: { BRIGADE_PLAN: 1 },
  /* An attacking Brigade pays less to break its chain when the move closes on
     the enemy. 1.0 is today's behaviour. */
  press_half:  { CLOSE_PRESS: 0.5 },        // measured 39%: recreates stranded units
  /* The Brigadier leads a STUCK attacking Brigade forward. Off is 1.0. */
  no_lead:     { BRIGADIER_LEAD: 1.0 },
  lead_always: { LEAD_AFTER_TURNS: 0 },     // measured 55%: strands healthy Brigades
  /* The old behaviour: an army with no attacking Brigade stands there. */
  no_stall_break: { STALL_BREAK: 0 },
  /* The first settings tried: shelters at 40% and only on clearly favourable
     odds. Measured 13 points of win rate worse than the defaults. */
  shelter_early: { SHELTER_RATIO: 0.4, SHELTER_ENGAGE_FLOOR: 1.0 },

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

  /* THE PRE-AGGRESSION AI, kept so the change can still be run against what it
     replaced now that the new values are the defaults. Without this the old
     behaviour is only reachable by checking out an old commit. */
  pre_aggression: {
    THREAT_SCORE_MAX:       2.50,
    TERRAIN_SEEK_MAX:       Infinity,
    MAIN_ATTACK_PULL_MUL:   1,
    MAIN_ATTACK_RATIO:      1.15,
    GUN_PENALTY_TOTAL_CAP:  Infinity,
    GUN_HOLDS_FIRE_BONUS:   2.5,
  },

  /* Aggression tuning, six values, no new terms. NOW THE DEFAULTS, so this is
     identical to control and kept only as a record of what was changed.

     T1 IS NOT HERE. It asked to restore the engage ceiling to +5.00 and the
     ceiling is already +5.00: ENGAGE_CLAMP 5.0 x ENGAGE_WEIGHT 1.0. The -3.00
     to +3.00 in the export is the range the term REACHED in that match, not the
     range it is allowed. Raising anything would push it past a clamp that is
     doing its job, so nothing is changed. */
  aggression: {
    THREAT_SCORE_MAX:       1.80,   // T2: from 2.50
    TERRAIN_SEEK_MAX:       0.84,   // T3: from an effective 1.20 under defensive posture
    MAIN_ATTACK_PULL_MUL:   1.26,   // T4: 3.57 -> 4.50, MAIN_ATTACK only
    MAIN_ATTACK_RATIO:      1.00,   // T5: from 1.15, the gate on planning an attack at all
    GUN_PENALTY_TOTAL_CAP:  2.00,   // T6: from a two-group sum of 3.50
    GUN_HOLDS_FIRE_BONUS:   3.00,   // T6: from 2.50
  },

  /* The over-correction fallback named in the brief: step T2 back rather than
     touching engage. Ready so it does not need writing mid-run. */
  aggression_t2_back: {
    THREAT_SCORE_MAX:       2.10,
    TERRAIN_SEEK_MAX:       0.84,
    MAIN_ATTACK_PULL_MUL:   1.26,
    MAIN_ATTACK_RATIO:      1.00,
    GUN_PENALTY_TOTAL_CAP:  2.00,
    GUN_HOLDS_FIRE_BONUS:   3.00,
  },

  /* Aggression, with the Brigadier's rescue errand toned down. 0.9 was set to
     match BRIGADIER_TRAIL_WEIGHT because recovery REPLACES trailing; 0.45 keeps
     it decisive when nothing else is urgent and lets a real fight outbid it.
     The risk is measured, not assumed: too low and permanently frozen units come
     back, and with them the unendable matches. Watch the stall rate, not the
     win rate. */
  aggression_calm_rescue: {
    THREAT_SCORE_MAX:       1.80,
    TERRAIN_SEEK_MAX:       0.84,
    MAIN_ATTACK_PULL_MUL:   1.26,
    MAIN_ATTACK_RATIO:      1.00,
    GUN_PENALTY_TOTAL_CAP:  2.00,
    GUN_HOLDS_FIRE_BONUS:   3.00,
    STRANDED_RECOVERY_PULL: 0.45,
  },

  /* Phased tempo, step 1 of the build order: state machine and logging only, no
     multipliers. This is the validity check — confirm the transitions fire when
     expected before they are allowed to affect anything. It should measure as
     NOISE against control; if it does not, the state machine is doing something
     it should not. */
  tempo_v2_log_only: { TEMPO_V2: true },

  /* Steps 2 and 3 together: the full multiplier table live. Merged rather than
     run separately because the failure the brief warns about (an army that holds
     well and never commits) is directly measurable in tempo-report as "sides
     with no COMMIT" and "first COMMIT turn", so it does not need an isolating
     run to be caught. */
  tempo_v2: { TEMPO_V2: true },

  /* The old turn clock, for running the tempo system against what it replaced
     now that it is the default. */
  no_tempo: { TEMPO_V2: false },

  /* The stall experiment: let a cut-off unit move again and let the existing
     cohesion terms pull it home. A RULES change, so it is measured before it is
     discussed, never landed quietly. */
  stranded_may_rejoin: { STRANDED_MAY_REJOIN: true },

  /* Caution that wears off while nothing dies. Decays the avoidance rather than
     raising the pull, which is the side four previous attempts pushed on. */
  stale_decay: { STALE_DECAY: true },

  /* The reverse of stranded_may_rejoin: run with SIM_REVERSE=1 so the default
     is ON and this variant is the OLD behaviour. A real effect should lose here
     by about as much as it won the other way round. */
  no_rejoin: { STRANDED_MAY_REJOIN: false },
};

export function resolveVariant(name){
  if(!(name in VARIANTS)) throw new Error(`unknown variant '${name}' (have: ${Object.keys(VARIANTS).join(', ')})`);
  return VARIANTS[name];
}
