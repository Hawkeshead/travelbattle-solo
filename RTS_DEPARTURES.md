# Real-Time variant: ruleset departures log

Branch `rts-variant` only. Every mechanic that is new, or converts a
turn-based rule to real time, is checked against the ruleset and the current
code before it is built and recorded here. If the build plan misdescribes a
current rule, the ruleset wins and the difference is flagged first.

Plan: https://claude.ai/code/artifact/ba2ad911-80ab-40db-9703-3998dd4a5038

| Mechanic | Type | Checked against | Ruleset / code says | Real-Time does | Phase | Status |
|---|---|---|---|---|---|---|
| Movement in real time along a grid path, one square at a time, no shared squares | Conversion | Movement rules | A move is instant within a turn | A unit crosses each square in its travel time (infantry 5s, cavalry 2.5s, artillery 7s; roads a third faster) and reserves the next square before entering it | 1 | Built (scaffold: no range cap, pool or cooldowns yet) |
