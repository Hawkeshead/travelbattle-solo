# AI-vs-AI harness — status

## Done

`headless-env.mjs` runs the entire game outside a browser. All eleven modules
load, 272 exports between them. `verify-env.mjs` checks this and should be run
after any change to module imports.

Nothing in `js/` is modified or mocked. The shim supplies only the browser
globals the game reaches for at load: XMLHttpRequest (data-core loads its JSON
synchronously), Image (sprite preload), Audio/WebAudio, and canvas.getContext.

`floating-text.js` loads with no shim at all, which verifies the leaf-module
property rather than asserting it.

## Runner: complete, and it now runs Spectate rather than its own driver

`node tools/aivsai/run.mjs 40 --json out.json`

A full match runs headless in five to nine seconds and forty in about five
minutes. What it plays is Spectate mode from `js/`, unchanged: `state.spectate`
points `state.aiSide` at whichever side is acting, so the same scoring, weights
and doctrine play both sides. The runner sets the flag, starts the match, reads
the result.

The old runner's turn driver and its two kicks (re-arm the deploy chain, press
Start Battle) are gone. They existed because there was no in-game path to an
unattended match, and Spectate is that path. The harness now tests what the phone
runs instead of a parallel imitation of it.

### One match per process

The game's state is a module singleton and a finished match leaves residue: a
deferred `endGame` timer waiting out the brigade-break dispatch, the previous
roster, the undo stack. A second match in the same process produced instant
turn-1 "wins" off that residue. Rather than chase every field (and re-chase it
whenever a new one appears), each match gets a clean process. It costs about a
second of module loading and buys total isolation, and a crashed match now loses
one result rather than the batch.

### A seed now fixes the whole match

`seedRng(seed)` used to fix only the dice, so the same seed replayed the same
rolls on a different battle. Everything that decides what a match IS now comes
off the same stream: board assignment and both rotations, who deploys first, who
moves first, the AI's army choice, its counter-army pick and its deploy-cell
jitter, and the scoring tiebreak jitter. Verified by running seeds 900-902 twice
and getting identical winners, turn counts and survivors.

Cosmetic draws are deliberately left on `Math.random`: grass and building styles,
the ambient sky, narration wording, audio track choice. They change nothing about
play, and putting them on the stream would mean a purely visual tweak shifted
every roll after it.

This also fixes replay for real matches, which record `currentRngSeed()` in the
export metadata but could never reproduce the board from it.

### Reported per match

`finished` (win / timeout / crashed), `winner`, `turns`, wall time, board drawn,
survivors per side, broken brigades per side. Aggregate adds completion rate,
win split, turn spread, mean survivors, and a list of seeds that did not finish
cleanly with the command to reproduce each.

Note `turns` counts SIDE ACTIVATIONS, not full rounds. Halve it to compare with
a played match.

## First real run: 60 matches

    51 completed, 9 never resolved (15%)
    Britain 29, France 22 of the 51 decided (56.9% / 43.1%)
    turns: shortest 27, median 72, longest 252   (SIDE ACTIVATIONS, halve for rounds)
    mean survivors: Britain 6, France 5.6

The win split is not evidence of a biased side. 29-22 on 51 matches is well
inside chance, which is a useful result in itself: with identical scoring on both
sides, the board, the deployment and the rules come out symmetric.

### The 15% that never end

A standard match has NO TURN LIMIT. Only scenarios do (checkScenarioTurnLimit).
In a played match that never matters, because the human always commits eventually
and breaks the symmetry. Two identical cautious AIs do not. All nine ran past
turn 1500 with both armies still on the board, and they fall into two shapes.

**Frozen standoff, full armies.** Seed 21, turn 1807, no brigade broken on either
side, fifteen units alive. The entire log tail is two British Brigadiers
oscillating between (10,5), (10,6) and (10,7) while every other unit on both
sides does nothing at all. France logs "turn complete" with no action for
hundreds of turns.

**Endgame attrition stall.** Seeds 8, 54, 55, 57. Both sides down to four or five
units, one brigade broken each, and what is left is Brigadiers and guns. Seed 55
is the clearest: France has two Artillery and two Brigadiers and NOTHING that can
attack, Britain has a Guard eleven squares away, and neither moves for two
thousand turns. Britain only has to walk over and take one gun to break the
second brigade and win.

Brigadiers are 42 of the 108 units alive across the nine stalls, about 39%,
against roughly 18% of a full army. They escort rather than engage by design, so
a brigade reduced to its Brigadier plus a gun has nothing that will start a
fight and nothing the enemy is drawn to attack.

Both shapes say the same thing: there is no pressure that rises with time. Left
to itself the scoring has a stable do-nothing equilibrium. Not a bug in any one
term, and not fixable by nudging weights, because the two sides are running the
SAME weights.

### Also worth noting

The oscillating Brigadier in seed 21 is a smaller defect in its own right: moving
to (10,5) apparently makes (10,7) score best and vice versa, so the escort
position has no stable optimum and the unit shuffles forever.

Which side deploys first is not currently recorded per match. Worth adding before
drawing any conclusion about first-move advantage.

## What running it found

Three places stop the game and ask a question only a person can answer: the
combat re-roll offer, the Leadership Roll offer, and the ambush Hold/Advance
choice. Each decided with its own copy of `!(state.mode==='ai' && side===state.aiSide)`,
and every copy was wrong in Spectate for the same reason: `aiSide` points at the
side ACTING, while all three questions are asked of the side that is NOT acting
(the ambusher is being moved against, the defender re-rolls first per p.6, and
the unit that fails to rally is usually the one that just lost). So all three
read as human-owned and opened a modal with nobody there to dismiss it.

Headless this threw; on the phone it would hang the match. The three copies are
now one `humanOwns(side)` in `data-core.js`, so a fourth prompt added later
inherits the right answer instead of repeating the bug.

Also added, both one line and both inert in real play: `FAST_ANIMATION_MODE` now
skips the falling-tile intro (it measures real elapsed time, so it costs ten and
a half seconds per match however fast frames are served), and `endGame` records
`state.winner` alongside `state.gameOver`, which previously existed only as text
on the victory screen.

## Environment

`headless-env.mjs` runs the whole game outside a browser. All modules load,
nothing in `js/` is modified or mocked. The shim supplies only the globals the
game reaches for: XMLHttpRequest (data-core loads its JSON synchronously), Image,
Audio/WebAudio, canvas.getContext, MutationObserver (dice.js watches the battle
bed), and a few observers jsdom does not expose as globals.

`performance` is deliberately left as Node's own. Swapping in jsdom's
`window.performance` is a separate clock and it stalled the board intro, which
measures real elapsed time.

`verify-env.mjs` re-checks the whole load and should be run after any change to
module imports. `floating-text.js` loads with no shim at all, which verifies the
leaf-module property rather than asserting it.

## Corrections to earlier notes in this file

The Army picker was NEVER the blocker. `maybeShowArmyPicker` already returns
false under `FAST_DICE_MODE`, so it is correctly suppressed headless.

The first "stall at three units" was also wrong. Deployment was progressing at
about 300ms per placement, which is the deliberate human pacing, and a 1500ms
sample caught it early. The later "intro stall" was the same mistake a second
time: the intro takes ten and a half seconds and the sample ran for eight.

## Findings that still stand

- **The AI is already side-agnostic.** `ai-strategy.js` and `ai-tactics.js`
  contain zero DOM references and address sides only through `state.aiSide` and
  `SIDES`. No France-specific assumption exists in the scoring layer.
- **The turn loop lives in `ui-battle.js`**, not the engine, which is why a DOM
  shim is needed at all rather than the harness simply importing the rules.
- **`FAST_DICE_MODE` already existed** in `dice.js`, documented as harness-only.
