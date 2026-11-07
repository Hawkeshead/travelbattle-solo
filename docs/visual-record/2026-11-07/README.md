# The game's look on 7 November 2026 (before any 3D board)

A record of the 2D game as it stood before the Iso Lab prototype (lab/iso.html) was considered
for the live game, so it can be compared with or restored later.

- **Branch `visuals-2d-2026-11-07`** (commit 3b2c4eb) marks the exact state; it is a record, never
  to be pushed to or merged. To restore the old look, check out the game's files from it
  (`git checkout origin/visuals-2d-2026-11-07 -- index.html js assets data`) or branch from it.
- The screenshots are the real game at a phone's landscape size (852 x 393 at 2x), taken headless:
  1. the title screen
  2. the side choice (Quick Battle)
  3. the battlefield during deployment (painted v2 terrain tiles, pixel figures)
  4. the Army Picker over the board

What the look is made of at this tag: the v2 painted terrain tiles (assets/terrain/v2), the pixel
unit figures (assets/units-pixel, drawn by js/render-figures.js), the board drawn in 2D canvas by
js/render-board.js, the painted bridges and smoke, and the Commander's Desk frame.
