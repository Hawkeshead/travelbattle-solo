-- THE AI SCORECARD (7 Oct 2026): one row per match against the AI.
-- Lives in the database as the view telemetry.ai_scorecard (migration
-- telemetry_ai_scorecard_v1); read it with:
--
--   select * from telemetry.ai_scorecard order by finalised_at;
--
-- Columns, and which way is better for the AI:
--   fight_ratio            AI-started fights per player-started fight (up)
--   volley_ratio           AI volleys per player volley (up)
--   ai_turned_attacks      AI attacks with the "defender turned around" +1 (up)
--   ai_squares             squares the AI formed (up, against cavalry)
--   support_hold_pct       % of SUPPORT-mission decisions that were Hold (down)
--   dead_turns             Hold decisions under PRESERVE or SHELTER (down)
--   stuck_ambushes         AI ambushes still waiting 6 turns after being laid (down, ideally 0)
--   shelled_unanswered     an AI unit shot by guns on two enemy turns running without moving between (down)
--   repeat_ambush_walkins  AI units sprung on at a square where an ambush was already sprung (down)
--   brigade_hunts / brigades_broken_by_hunt   finishing hunts started, and how many broke a Brigade (up)
--
-- Quick comparison of the latest match with the average of the ones before:
select 'latest' as which, * from telemetry.ai_scorecard order by finalised_at desc limit 1;

select 'average before' as which,
  round(avg(fight_ratio), 2) fight_ratio, round(avg(volley_ratio), 2) volley_ratio,
  round(avg(ai_turned_attacks), 1) ai_turned_attacks, round(avg(ai_squares), 1) ai_squares,
  round(avg(support_hold_pct)) support_hold_pct, round(avg(dead_turns), 1) dead_turns,
  round(avg(stuck_ambushes), 1) stuck_ambushes, round(avg(shelled_unanswered), 1) shelled_unanswered,
  round(avg(repeat_ambush_walkins), 1) repeat_ambush_walkins
from (select * from telemetry.ai_scorecard order by finalised_at desc offset 1) s;
