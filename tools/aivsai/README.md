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

## Not done

The runner, the aggregate report, and the 200-match run. What remains:

1. **A side-agnostic turn driver.** The AI drives one side through
   `state.aiSide`. Running both sides means flipping it at each turn boundary.
   That is the brief's one permitted addition and it belongs in the harness, not
   in `js/`, so the human-vs-AI path cannot be affected.
2. **Deployment for both sides.** `ai-deployment.js` places the AI's army; the
   player's is placed through the UI. The harness needs to call the AI's
   deployment for both.
3. **Driving the async loop.** The turn loop is callback-and-setTimeout based.
   With `setFastDiceMode(true)` and `FAST_ANIMATION_MODE` the timers collapse,
   but the harness still has to await quiescence between turns rather than
   assume it.
4. **Aggregation.** Sections 4a-4j of the brief, over the run manifest.

## Findings so far, which the brief asked for

- **The AI is already side-agnostic.** `ai-strategy.js` and `ai-tactics.js`
  contain zero DOM references and address sides only through `state.aiSide` and
  `SIDES`. No France-specific assumption was found in the scoring layer. This is
  the precondition the brief was most worried about and it holds.
- **The turn loop lives in `ui-battle.js`**, not in the engine. That is the real
  obstacle to headless running, and it is why the shim is needed at all rather
  than the harness simply importing the rules.
- **`FAST_DICE_MODE` already exists** in `dice.js`, documented as "test and
  simulation harnesses only, never set by real gameplay".
