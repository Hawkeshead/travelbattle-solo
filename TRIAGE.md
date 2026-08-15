# Known issues

Findings from a full review of the codebase at commit `9ea94c2` (15 Aug 2026).

Every item marked **verified** was reproduced by reading the exact code path and
confirming the logic, not inferred. File and line references are to that commit.

Severity uses the standard triage rule: **CRITICAL/HIGH fix now, MEDIUM gets a
deadline, LOW gets tracked.**

---

## CRITICAL

### C1. Eleven of the fourteen Operations cannot be played — verified

**Where:** `js/ui-deployment.js:47-52` (`canAddMoreToCurrentBrigade`), `:238`
(`confirmCurrentBrigade`), `:43` (`sideFullyDeployed`)

Deployment requires each side to field exactly 3 Brigades, and refuses to
confirm a Brigade holding fewer than 2 non-Brigadier units. A playable roster
therefore needs at least 3 Brigadiers and 6 other units.

The Operation rosters in `data/scenarios.json` are much smaller than the
standard 17-unit army. **12 of the 28 side-rosters fall below the threshold**,
making 11 of the 14 Operations unplayable. Only `op-caesars-camp`,
`op-beaumont` and `op-sabugal` are deployable on both sides.

The failure is silent and unrecoverable. Once the reservation maths caps the
current Brigade, `renderRoster` draws no unit chips at all and the Confirm
button stays disabled. Nothing on screen responds. The only way out is a page
reload.

The AI path fails the same way: `aiDeployStepHard` (`js/ai-deployment.js:61`)
calls `confirmCurrentBrigade()`, which returns early, and nothing reschedules
the next step — the AI simply stops mid-deployment with no log entry.

| Scenario | Side | Brigadiers | Others |
|---|---|---:|---:|
| op-lincelles | blue | 3 | 4 |
| op-garcia-hernandez | red | 3 | 5 |
| op-willems | blue | 3 | 5 |
| op-coa | red | 3 | 5 |
| op-barba-del-puerco | red | **2** | 4 |
| op-barba-del-puerco | blue | **2** | 4 |
| op-el-bodon | red | 3 | 5 |
| op-arroyo-dos-molinos | blue | 3 | 5 |
| op-hougoumont | red | 3 | 5 |
| op-la-haye-sainte | red | 3 | 5 |
| op-papelotte | red | 3 | 5 |
| op-frischermont | red | 3 | 5 |

`op-barba-del-puerco` is worse still: with only 2 Brigadiers it can never reach
3 Brigades, whatever the fix to the reservation maths.

**Two possible fixes, and they are a game-design decision, not a technical one:**

1. **Data** — top the short rosters up to 3 Brigadiers + 6 others. Keeps the
   3-Brigade structure intact, but changes the historical force sizes Matt
   chose for each engagement.
2. **Code** — let a scenario declare a smaller Brigade count, and relax the
   2-unit minimum when the roster is small. Preserves the historical rosters
   and is the better long-term answer, but touches the deployment flow.

Guarded by `test/scenarios.test.js`.

---

## HIGH

### H2. A second dice roll within 2.9 seconds silently voids the first combat — verified

**Where:** `js/dice.js:20` vs `js/dice.js:104-107`

Every consequence of a resolved fight — pushback, retreat, unit removal,
recording the attacker in `state.fought`, the replay log entry, clearing
`charged` — runs inside `showDice`'s `onSettled` callback, fired by a timer at
2900 ms.

`presentRollTrigger` opens with `clearTimeout(showDice._fadeT)`, which cancels
that pending callback. The dice panel is a small widget at the top of the
screen and the board stays fully interactive underneath it.

**To reproduce:** in the fight phase, resolve a combat, then within 2.9 seconds
select another unit, pick a target and roll again. The first fight's outcome
never applies. The loser is not pushed back, not routed and not removed, and
because `state.fought` was never updated the first attacker can attack again.

The same path affects artillery, where `fireArtillery` chains two roll
presentations — the effect roll can be cancelled after the hit was already
logged.

There is no re-entrancy guard anywhere in the roll pipeline.

### H3. Forming an Attack Column starts a redraw loop that never stops — verified

**Where:** `js/render-units.js:285-287`, `js/render-board.js:44`, `:87`, `:698`

Animation records are cleaned up lazily, only inside `getUnitVisualPos`, and
only when the unit is actually drawn. When two Infantry double up into a Column,
`draw()` routes them to `drawColumnUnitPair(u1, u2)`, which calls
`getUnitVisualPos(u1)` — and never queries `u2`. Nothing else queries it either.

`u2`'s animation entry is therefore orphaned forever. The animation loop's
continue condition is `Object.keys(unitAnimations).length > 0`, so it stays true
and `requestAnimationFrame` reschedules for the rest of the match.

This is not a cheap idle loop. Every frame, `draw()` rebuilds the road adjacency
map from scratch, runs `findConnectedRegions` three times (each allocating a Set
of up to 400 strings plus region arrays) and rebuilds the stack groups — several
thousand allocations per frame, at 60 fps, on a phone.

Forming a Column is a core tactic the AI actively seeks, so this fires in most
games.

### H4. The AI never deliberately forms an Attack Column — verified

**Where:** `js/ai-strategy.js:353-356`

The scoring loop temporarily moves the unit onto the candidate square
(`u.x=c.x; u.y=c.y` at `:320-321`) before evaluating it. The Column check then
calls `unitsAt(c.x, c.y)` without excluding the unit itself, so the count is 1
for an **empty** square and 2 when a friendly Infantry is genuinely there.

The condition is `occ.length === 1`, so the +1.4 "form a Column" bonus fires for
empty squares and never for actual doubling — the exact inverse of its intent.

The correct pattern, with an `o.id !== u.id` filter, appears 55 lines further
down at `:409`. This is a copy-paste slip, not a design choice.

### H5. On a phone, any tap that drifts more than 6px does nothing — verified

**Where:** `js/render-board.js:188-196`, `js/ui-battle.js:429`

A pointer movement of more than 6px sets `mapGestureMoved`, and the board's
click handler discards the next click when that flag is set. 6px is well below
normal touch slop, which is usually around 10px minimum.

The flag is set even at `mapZoom === 1`, the default, where `clampMapPan` pins
the pan back to zero because the canvas is smaller than its container. So the
board does not move *and* the tap is swallowed: the player taps a unit, nothing
happens, taps again, nothing happens.

The suppression should require an actually-applied pan delta, or a larger
threshold combined with `mapZoom > 1`.

### H6. `endFightPhase` can run twice and advance the turn twice — verified

**Where:** `js/ui-battle.js:304-319`, `:489`, `:184`

`endFightPhase` guards on `state.gameOver` but never checks `state.phase`. After
the last fight resolves, `onCellClick` schedules `setTimeout(endFightPhase, 500)`
while the End Fight button is still enabled. Pressing it inside that window runs
the function immediately; the queued call then runs again, after the opponent's
move phase has already begun.

The result is that the opponent's turn is aborted about 200ms in, the turn flips
back, and `state.turnNumber` jumps by two.

### H7. Objectives are only checked when a unit dies — verified

**Where:** `js/engine-objectives.js:10-28`, `js/engine-rules.js:661`, `:665-667`

`checkScenarioObjective` has exactly two callers: `checkWinCondition`, which is
only ever called from `removeUnit`, and `checkScenarioTurnLimit`, which only
fires when a turn limit exists and is reached.

Two consequences:

- `op-lincelles`, `op-willems` and `op-frischermont` have a CAPTURE_ZONE
  objective and **no turn limit**. A player can hold the zone indefinitely and
  never win. If both sides stop taking casualties, the match cannot end at all.
- `state.captureHoldCounter` is documented as counting *turns* held, but is
  incremented once per evaluation — that is, once per death. Three casualties in
  one turn increment it three times, so a `holdForTurns: 2` objective can be
  satisfied inside a single turn of heavy fighting.

A pure objective check should not be a mutating function invoked from a death
handler.

Guarded by `test/scenarios.test.js`.

---

## MEDIUM

| # | Finding | Where |
|---|---|---|
| M1 | `op-beaumont`'s escape edge (row 9) is red's own deployment row, so the escape condition is satisfied at deployment. The `all` combinator with PROTECT_UNIT stops it being an instant win, but red still wins at the turn limit by doing nothing. Conversely, blue destroying red's artillery produces two *different* winners, which the `all` combinator treats as no winner — so that path wins blue nothing either. | `data/scenarios.json`; `js/ui-deployment.js:178`; `js/engine-objectives.js:79` |
| M2 | Undo after a resolved roll is a free re-roll. `pushUndoSnapshot` runs before the fight, and Undo re-enables once the dice popup fades. Save-scumming is fully supported. | `js/ui-battle.js:475`, `:485` |
| M3 | `state._aiPlanUsed` holds a Set of *object references* into `AI_DEPLOY_PLANS`. The undo snapshot JSON round-trip revives them as fresh objects, so `.has()` is permanently false afterwards and the AI re-walks plan entries it already used. | `js/ai-deployment.js:82`, `:94`; `js/engine-state.js:12-17` |
| M4 | Charge can be granted through a pivot. `computeChargeDestinations` never checks `m.steps`, and `isCleanChargeRun` checks midpoint terrain but not occupancy, so BFS can route around a friendly unit in 3 steps and still qualify. | `js/engine-rules.js:119-140` |
| M5 | `checkEscapeZone`'s impossible-to-win test double-counts: escaped units are still on the board and already inside `remaining`, so subtracting `escaped` from the threshold is wrong. It also counts Brigadiers on one side of the comparison but not the other. | `js/engine-objectives.js:41-45` |
| M6 | `checkEliminateTarget` counts withdrawn Brigadiers as kills — `removeUnit` marks a Brigadier `removed` when its Brigade breaks, so each break contributes 2 toward the target count. | `js/engine-objectives.js:50` |
| M7 | Each of the 50 retained undo snapshots holds a full serialised copy of `state`, including the monotonically growing `matchLog`. Late in a long match this is tens of megabytes of retained strings on a phone. | `js/engine-state.js:12-22` |
| M8 | No `pointercancel` handler in the roster drag. Cancellation is common on mobile; the document listeners leak, `dragState` stays non-null so the board keeps painting a hover cell, and the drag ghost is stranded. | `js/ui-deployment.js:122-159` |
| M9 | `draw()` recomputes static terrain data — connected regions three times, the full road adjacency map, the parchment and vignette overlays — on every single frame, though none of it depends on unit state. | `js/render-board.js:426`, `:456`, `:482-493`, `:555` |
| M10 | Every viewport resize calls `resetMapView()`, destroying the player's zoom. On mobile the URL bar collapsing fires `resize`, so scrolling wipes a pinch-zoom. Undebounced, so each event also triggers a full canvas reallocation. | `js/render-board.js:123`; `js/ui-battle.js:683` |
| M11 | `clampMapPan` assumes the canvas sits at the wrap's origin, but the wrap is flex-centred. When zoomed in, part of the board is unreachable and the opposite edge over-pans by the same amount. | `js/render-board.js:151-158` |
| M12 | The board is rendered horizontally squashed on phones. `computeCellSize` floors the cell at 22px, so the canvas is styled wider than its container, and `max-width:100%` compresses it while the inline height survives — roughly 15% distortion in portrait. | `js/render-board.js:105-125`; `index.html:78` |
| M13 | Tap targets are below the 44px minimum throughout (HUD buttons 38px, dropping to 32px in landscape; roster chips ~28px; log tabs ~22px), and combat information is set at 8–10.5px. | `index.html:84`, `:187`, `:213`, `:263`, `:318` |
| M14 | No ARIA, no keyboard path, no focus management in any of the three modals. The canvas is the whole game surface and has no accessible name or text alternative. `#logOverlay` stays focusable and screen-reader-visible when "closed" — it is hidden by transform only. | `index.html` (throughout); `js/ui-battle.js:604-609` |
| M15 | `apple-mobile-web-app-status-bar-style` is `black-translucent` with no `viewport-fit=cover` and no safe-area insets anywhere. On a notched iPhone added to the home screen, the top bar renders under the status bar. | `index.html:5-7` |

---

## LOW

| # | Finding | Where |
|---|---|---|
| L1 | Three elements share `id="actionRow"` — invalid HTML. Nothing calls `getElementById('actionRow')` today, so nothing breaks yet. | `index.html:366`, `:370`, `:380` |
| L2 | The re-roll prompt reports `rolls[0]` rather than the kept best die, so a unit that rolled [2,5] and kept 5 is described as having "rolled a 2". | `js/engine-rules.js:340` |
| L3 | Menu buttons come back stacked vertically after backing out of Operations or Campaigns — the shared `#modeChoices` has its `flexDirection` set but never reset. | `js/ui-menus.js:77`; `js/campaign.js:36` |
| L4 | The action-line fade divides by a hard-coded 3800ms while the default duration is 1800ms, so a default line begins fading after about 73ms. | `js/render-board.js:665` |
| L5 | Unreachable branch: `minRoll` is clamped to ≤6 on the line above, so the "Out of range" message can never print. | `js/ui-battle.js:510-511` |
| L6 | Overlay portraits are injected as `<img src>` with no `onerror`, so a missing file leaves a broken-image icon in the unit panel. | `js/ui-battle.js:388-392` |
| L7 | `rallying` is set on a routed unit and never cleared, so the "Rallying" tag is permanent from the first rout onward. | `js/engine-rules.js:546` |
| L8 | Replay exit leaves stale brigade pips in the top bar — `renderBrigadeStatus` runs during replay but is never re-run on exit. | `js/replay.js:140-153` |
| L9 | `audio.pan` is dead code; `HTMLAudioElement` has no `pan` property, so the guard is always false. | `js/audio-manager.js:96` |
| L10 | Dead state fields never read or written: `state.deployQueue`, `state.pendingTurnarounds`, `state.log`, and the unit field `pushed`. The unit-shape comment documents `hp`, `mustTurnOnly` and `facing`, none of which exist. | `js/data-core.js:254`, `:257`, `:262`, `:264` |
| L11 | Stale comment states both boards have no HILL squares and asks for that to be flagged. They now have 21 and 11 respectively, and hills drive two real rules (defender tie-win, overhead artillery fire). | `js/data-core.js:53-57` |
| L12 | Three orphaned files: `js/audio-catalog.js`, `js/audio-hooks.js`, `js/audio-manager.js` remain on disk after the audio system was unplugged in `9ea94c2`, referenced by nothing. | `js/` |
| L13 | Two authored Operations, `op-barba-del-puerco` and `op-frischermont`, exist in `scenarios.json` with full objectives but are referenced by no campaign branch. They are reachable only from the standalone Operations menu. | `data/campaigns.json` |
| L14 | Five of the ten declared AI plan types can never be produced by `updateOperationalPlan`, though `assignBrigadeMissions` and `missionMoveBonus` both have live branches for them. | `js/ai-strategy.js:10-11`, `:113-129` |

---

## Not bugs — checked and sound

- **Data loading error handling.** `js/data-core.js:11-38` wraps every request in
  try/catch and renders a specific, genuinely helpful failure page naming the
  file and the likely cause. Better than most production code.
- **localStorage handling.** Both `campaign.js` and `audio-manager.js` wrap
  `getItem`/`setItem`/`JSON.parse` in try/catch. The one gap is the absence of a
  schema version field.
- **Listener hygiene.** UI handlers use `.onclick =`, which is idempotent;
  module-scope `addEventListener` calls run once; Pointer Events are used
  throughout, so there is no touch/mouse double-firing.
- **Audio degradation.** Failures fall back to silence at three independent
  levels, and the 8-second release safety net correctly prevents a stuck
  counter from permanently muting a sound.
- **Strict-mode cleanliness.** All 19 files parse under strict mode. No `var`
  anywhere, no implicit globals, no `eval`, no `with`, no string `setTimeout`.
