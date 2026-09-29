# Real-Time variant: ruleset departures log

Branch `rts-variant` only. Every mechanic that is new, or converts a
turn-based rule to real time, is checked against the ruleset and the current
code before it is built and recorded here. If the build plan misdescribes a
current rule, the ruleset wins and the difference is flagged first.

Plan: https://claude.ai/code/artifact/ba2ad911-80ab-40db-9703-3998dd4a5038

| Mechanic | Type | Checked against | Ruleset / code says | Real-Time does | Phase | Status |
|---|---|---|---|---|---|---|
| Movement in real time along a grid path, one square at a time, no shared squares | Conversion | Movement rules | A move is instant within a turn | A unit crosses each square in its travel time (infantry 5s, cavalry 2.5s, artillery 7s; roads a third faster) and reserves the next square before entering it | 1 | Built (scaffold: no range cap, pool or cooldowns yet) |
| Order pool: 1 order per 10s per Brigadier, banked up to one per living unit under him (Brigadier not counted), starts full; the cap drops as units die | New | Brigadier command rules (ruleset: a Brigadier commands his Brigade; no order economy exists) | Any connected unit may move once per turn | Every order costs one from the pool; moving the Brigadier costs none | 2 | Built |
| Unit cooldown: infantry, Guard and artillery 15s, cavalry 10s, Brigadier 8s, from the moment of the order; no new order while still moving | New | Turn structure (one move per unit per turn) | One move per unit per turn | A unit can be ordered again once it has stopped and its cooldown has run out | 2 | Built |
| Per-order range cap | Conversion | legalMoves in engine-rules.js (move allowance, road +1 when starting and ending on road or building, terrain restrictions, ploughed fields, foot artillery escort, stacking) | As listed | One order may only target a square the turn-based legalMoves allows from where the unit stands. Read from the turn-based engine itself, not copied | 2 | Built |
| Chain check, continuous | Conversion | movableUnitsForSide in engine-rules.js (8-adjacency chain to the Brigadier within the Brigade; no Brigadier means independent) | Checked at the start of each move | Checked at the moment of every order, from the turn-based engine itself; an off-chain unit finishes its current move but gets nothing new | 2 | Built |
| Group orders | New | none | n/a | Several units, one order each, all or nothing; each takes the nearest free square (within 2) of the one tapped that its own range allows, by its own path | 2 | Built |
| Paths avoid enemy contact; contact is commitment | New | Movement rules (moving adjacent to an enemy does not stop a move in turn-based) | Units may pass enemies within a move | Paths keep off squares beside an enemy unless the destination is beside one; a unit that ends a square beside an enemy stops there | 2 | Built |
| Blocked squares: wait, then repath | New | none | n/a | A unit whose next square is taken waits 1.5s, then finds another route to its goal, or stops | 2 | Built |
