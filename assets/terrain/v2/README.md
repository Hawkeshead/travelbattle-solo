# Field Command terrain art v2 (final pack, 30 Sep 2026)

All art is WebP. Every image is portrait; the bottom square of the canvas is one grid cell, the space above is overhang room.

## Folders

| Folder | Files | Canvas | Draw width | Draw height | Notes |
|---|---|---|---|---|---|
| grass | grass_1..6 | 1024x1536 | CELL | CELL x 1.5 | Plain grass. Face 960x960, radius 56, inset 32px, flush with the top of the cell; 64px earth drop-off below the front edge. |
| grass/detail | grass_7..17 | 1024x1536 | CELL | CELL x 1.5 | Plain grass with one small feature at the back or a side (oak, hawthorn, poplars, weeds, campfire, reed pond, stump, cart, haystack, fallen posts, trough). Centre kept clear for units. |
| hill | hill_1..7 | 1024x1536 | CELL | CELL x 1.5 | Full tile, grass included. Rises 0.19 to 0.29 cell into the square behind. |
| farm | farm_1..4 | 1152x1536 | CELL x 1.125 | CELL x 1.5 | Overlay. 1 ploughed, 2 wheat with cart track, 3 young crop with wall, 4 hay meadow. |
| woods | woods_1..4 | 1152x1536 | CELL x 1.125 | CELL x 1.5 | Overlay. One set for both sides. |
| building | building_1..6 | 1152x1536 | CELL x 1.125 | CELL x 1.5 | Overlay. 1 church, 2 mill, 3 manor, 4 street, 5 walled farm, 6 crossroads. |
| effects | crater.webp | 501x394 | CELL x 0.5 | to aspect | Cannon blast crater, transparent. Centred on the face centre. |
| reference | *.py, *.json | | | | Rules for roads and farm fields, the farm overlay data, and the expected result on the 1v1 map. Port the rules; do not ship the Python. |
| mockups | *.jpg | | | | The target look. |

Placement for every image: centred horizontally on the cell, top edge at cellTop - 0.5 x CELL (so the canvas bottom sits on the bottom of the cell), always upright in screen space.

Board background: #34241A. No grid lines. Face centre is 0.469 of a cell below the cell top.

## Draw order

1. Background fill.
2. By screen row, back to front: that row's ground tiles (grass or hill), then that row's farm and woods overlays.
3. Road layer (one image for the whole map).
4. By screen row, back to front: building overlays.
5. Craters, then units and UI as today.

## Picking rules

- Plain grass: hash(x,y) % 6, bumped to the next variant if it matches the left or above neighbour.
- Detail grass: only on OPEN squares that are not farm overlay squares. If hash(x,y,7) % 5 == 0 and no detail on the left, above, above-left or above-right square, use detail hash(x,y,8) % 11. Keep the 5 as a constant; density will go up later.
- Road, woods, building and farm squares get plain grass underneath.
- Hills, woods, buildings: hash % count as before.
- Farms: see reference/farms_reference.py (fields of 2 to 3 squares per row, all four tiles in blocks of 3+ squares, mirror on odd x+y).
- Roads: see reference/roads_reference.py.
