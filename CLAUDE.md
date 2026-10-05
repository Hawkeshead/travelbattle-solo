# Grognards (Field Command)
Solo browser Napoleonic wargame. Owner is new to game design: explain decisions in gameplay/balance terms, not jargon. Never use em dashes in copy; use round brackets.

## Before every commit
- Run `npm run check` (check-assets.mjs, check-module-boundaries.mjs, eslint clean at 0 warnings/0 errors, 85 passing tests in test/*.test.js); run `npm ci` first in a fresh container
- Visual changes: Playwright screenshots on the real game with real assets
- Long, explanatory commit messages (what changed and why)
- Commit and push WIP on long tasks

## Simulator (tools/sim)
- AI changes are kept only if they measure better than control; revert otherwise
- Sides always swapped; stalled matches excluded from win rate, reported separately
- Batch cap: ~5 matches if consistent, 10 if inconsistent, never more
- Board favours the northern deployer (France) ~61/39: never read the per-side split as evidence
- Fixed opponents: Cerberus, Saladin, Alexander (tagged)

## Rules that must not be bent
- Brigadier cohesion is core; never let cut-off units move again
- Columns that lose melee retreat one unit at a time; only artillery hits both halves
- Cavalry into woods: one die, no compensating bonus
- Napoleon as Brigadier escorts, does not engage

## Gotchas
- Never scale down baseState
- `isolation: isolate` on #overlay is load-bearing (candle layer blend mode)
- Regenerate ambient-lab-standalone.html whenever js/ambient-layer.js changes
- HTML files contain 5MB+ base64 lines: always use line-length guards when scanning
- iOS Safari fixed modals: align-items:flex-start + padding-top, not bottom-anchored
- Terrain art light source is upper right, late afternoon
