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

### What a seed does and does not fix

`seedRng(seed)` fixes the dice. It does NOT fix the map: `beginBoardSetup` draws
board assignment and rotation from `Math.random` directly. Two runs of the same
seed therefore play the same dice on different ground. The board drawn is
recorded on each result so a match stays identifiable, but exact replay would
need those two draws routed through the seeded generator.

### Reported per match

`finished` (win / timeout / crashed), `winner`, `turns`, wall time, board drawn,
survivors per side, broken brigades per side. Aggregate adds completion rate,
win split, turn spread, mean survivors, and a list of seeds that did not finish
cleanly with the command to reproduce each.

Note `turns` counts SIDE ACTIVATIONS, not full rounds. Halve it to compare with
a played match.

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
