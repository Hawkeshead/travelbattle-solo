# Field Command terrain art v2

Replaces the square-plate terrain tiles with 2.5D tiles that sit on a dark earth board with shadow gaps between squares. All art is WebP.

## Canvas conventions

Every image is portrait. The bottom 1024x1024 of the canvas is one grid cell; the space above is overhang room for features that rise into the square behind.

Grass square (the "face"): 960x960 rounded square, radius 56, inset 32px each side, flush with the top of the cell square. This leaves a 64px shadow gap between neighbouring squares. Below the face is a 64px turf and earth drop-off that faces the viewer.

Colour target for grass: about #7B730C. Everything is colour-matched to this.

| Set | Files | Canvas | Draw width | Draw height | Notes |
|---|---|---|---|---|---|
| grass | grass_1 to 6 | 1024x1536 | CELL | CELL x 1.5 | Full tile, opaque face, transparent elsewhere. Pick per cell by a stable hash of (x,y). |
| hill | hill_1 to 7 | 1024x1536 | CELL | CELL x 1.5 | Full tile, grass face already included; do not draw a grass tile under a Hill cell. Rise 0.19 to 0.29 of a cell into the square behind. |
| building | building_1 to 6 | 1152x1536 | CELL x 1.125 | CELL x 1.5 | Transparent overlay only. Draw a normal grass tile under it first. The cell square is centred (face at x 96 to 1056). Overhangs neighbours by 64px each side and rises 0.22 to 0.33 of a cell. |

Draw rule for all three: bottom-anchored to the cell's front edge, centred horizontally on the cell, always upright in screen space (never rotated with the board), so the drop-off faces the player from every viewpoint.

## Draw order

Back to front by screen row. Within a row, two passes: first every grass and hill tile, then every building overlay. This stops a neighbour's grass painting over a village's overhang.

Board background behind the tiles: dark earth, about #34241A. Grid lines are removed; the shadow gaps do that job.

## Building set

1 church village, 2 mill village, 3 manor village, 4 street village, 5 walled farm, 6 crossroads village. Building 4 has no lane leaving the front edge.

## Not yet in this pack

Woods, farmland and road overlays are still on the old art and will follow in the same format.
