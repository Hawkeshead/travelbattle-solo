# Real-Time tuning log

Branch `rts-variant`. Measured with the headless simulator, AI against AI,
sides swapped every match, 24 matches per setting unless noted:

    node tools/sim/rts-run.mjs [matches] [firstSeed]
    node tools/sim/rts-sweep.mjs '{"ORDER_REGEN":[25,35],"ARTILLERY_RELOAD":[15,20,30]}' 24

Targets (build plan): matches average 20 to 30 minutes, and artillery's share
of kills near the turn-based figure.

## The turn-based reference (30 Sep 2026)

12 turn-based AI matches (tools/sim/run.mjs, now reporting how each unit was
destroyed): 88 of 239 units destroyed by artillery (including one Column
partner), **37%**.

## Findings

- **Melee round length barely moves match length** (6, 12, 20, 30 s: 9.4, 11.2,
  9.6, 9.5 min). Most contacts end in one round either way; the pace is set by
  how often units can be sent back in, not by the round timer.
- **Cooldowns barely move it either** (x1 and x2: 9.4 and 8.3 min at a 10 s regen).
- **Turned-around time and rally time barely move it** (all eight combinations
  of 12/45 s turned around, 6/20 s rounds, 10/40 s rally: 9.9 to 13.5 min).
- **The order regeneration rate is the pace.** At 10 / 20 / 30 / 40 s per order:
  9.4 / 14.3 / 17.6 / 21.5 min.
- **Artillery reload sets the artillery share**, once the pace is right: at a
  40 s regen, 20 s reload gives 36%, 25 s gives 34%, 30 s about 24% (at 35 s regen).

| Setting | Minutes | Artillery share | On the clock |
|---|---|---|---|
| Plan start: regen 10 s, reload 30 s | 9.4 | 16% | 3 of 24 |
| regen 35 s, reload 20 s | 18.0 | 38% | 3 of 24 |
| regen 40 s, reload 20 s | 21.5 | 36% | 8 of 24 |
| regen 45 s, reload 20 s | 20.9 | 36% | 4 of 24 |

## Chosen (30 Sep 2026)

ORDER_REGEN 40 s, ARTILLERY_RELOAD 20 s. Confirmed on 48 fresh seeds (500 to 547),
after the AI stopped queuing orders its pool could not pay for:
**20.6 min average, artillery 36.7% of kills**, 35 breaks, 13 on the clock
(7 of those drawn on points), none stalled.

The trade-off to judge in playtests: one order per Brigadier every 40 s is
four times scarcer than the plan's starting figure (about 37 orders per
Brigadier in a 25 minute battle, where the plan's pace check assumed 150).
The plan's two targets cannot both be met at 10 s with this AI.
