Terrain v2 goes live: new board art, map-wide road overlay, farm strips. Attached: field_command_terrain_v2_final.zip. Read terrain_v2/README.md in the zip first; it holds the canvas sizes, placement and draw order. Do not change any gameplay rules, terrain types or movement costs in this change. It is visual only.

STEP 1. SAVE V1 VISUALS BEFORE ANYTHING ELSE
- Tag the current main commit as visuals-v1 and push the tag.
- Copy every file in assets/terrain/ into assets/terrain/v1/ unchanged. Leave the originals where they are so nothing breaks.
- Keep the current terrain drawing code intact as the v1 path. Add one constant, TERRAIN_STYLE, set to 'v2', with 'v1' drawing the board exactly as it does today. Switching it back must fully restore today's look.

STEP 2. ADD THE ART
- Copy the zip's terrain_v2 folders (grass, grass/detail, hill, farm, woods, building, effects) into assets/terrain/v2/, keeping the same layout.
- Copy reference/ and mockups/ into docs/terrain-v2/ for the record. Do not load them in the game.
- Copy the README's canvas and draw order notes into a comment block at the top of the v2 section of render-board.js.
- Update check-assets.mjs if it needs to know about the new files. The v2 art is about 17MB across 38 images, so preload it the way the current terrain art is preloaded and flag if load time on mobile looks like a problem.

STEP 3. DATA
- Add boardAFarmOverlay and boardBFarmOverlay to data/terrain-layouts.json from reference/farm_overlay_additions.json. These are local board coordinates and must be rotated and flipped exactly the way boardATerrain and boardBTerrain are, including in Online Group on the four-board map.
- These squares draw farm art on top of their existing terrain. Their terrain type in play does not change (a ROAD square with farm art is still a road; an OPEN square with farm art still plays as open ground).

STEP 4. V2 RENDERING
Follow the README draw order exactly:
1. Fill the board with #34241A. No grid lines.
2. For each screen row, back to front: draw that row's ground tiles (hill tile on HILL, grass everywhere else), then that row's farm and woods overlays.
3. Draw the road layer.
4. For each screen row, back to front: draw building overlays.
5. Draw craters using effects/crater.webp in v2 (0.5 cell wide, centred on the face centre, which is 0.469 of a cell below the cell top). Then units and UI as today.

Every image is centred on its cell, top edge at cell top minus half a cell, always upright on screen. Sizes per set are in the README table. Keep WOODS_OVERSCAN untouched; it belongs to the v1 path.

Grass picking:
- Plain grass (grass_1..6): hash of (x,y) mod 6, bumped to the next variant if it matches the left or above neighbour.
- Detail grass (grass/detail, 16 files, grass v4 of 1 Oct 2026): only on OPEN squares that are not farm overlay squares. If hash(x,y,7) % 100 < GRASS_DETAIL_PERCENT (30) and none of the left, above, above-left or above-right squares already has a detail, use detail number hash(x,y,8) % 16 (GRASS_DETAIL_FILES order). Raise or lower GRASS_DETAIL_PERCENT for more or less detail; it scales predictably, where the old one-in-N rule did not. See docs/terrain-v2/grass-v4/.
- ROAD, WOODS, BUILDING and farm squares always get plain grass underneath.

Farm picking: port reference/farms_reference.py. The farm set is every PLOUGHED_FIELD square plus every farm overlay square, on the assembled map. Contiguous blocks are split into fields of 2 or 3 squares along each row; blocks of 3 or more squares use all four farm tiles, smaller blocks keep one set; touching fields never share a tile. Mirror the farm image horizontally on squares where x+y is odd. This replaces the old farm grouping rule.

STEP 5. ROADS
The old per-square road tiles are not used in v2. Roads become one continuous overlay drawn over the whole map, crossing the gaps between tiles. Port reference/roads_reference.py; the rules and constants in it are final:
- Build a graph from ROAD squares with 4-way neighbours, minus boardExcludedRoadEdges.
- Villages: a road square with 0 or 1 links that sits next to a BUILDING square runs into that village, then on to the nearest other road square touching the same village, if there is one.
- Map edge: a road square exits off the edge only if it has fewer than 2 links on the map. The edge is the outer edge of the assembled map. Board seams are not edges.
- Split the graph into chains between forks, ends and exits. Place each node at its square's face centre in SCREEN coordinates (after the board flip), densify to 12 points per cell, smooth 90 times with weights 0.25/0.5/0.25 keeping both ends fixed, then add the three-wave wobble seeded from the chain's end squares so it never changes between loads.
- Draw each chain as three round-capped strokes (widths 0.26, 0.20, 0.12 of a cell, colours in the reference file) plus two faint rut lines.
- Build the road layer once per layout and viewpoint into an offscreen canvas and reuse it. Do not recompute every frame.
- Check the port against reference/expected_1v1_result.json: on the 1v1 map with no flip you must get 11 chains, forks at (2,3) (2,7) (11,6) (12,2) (15,5), and 6 exits. The farm_tiles list in the same file is the expected farm picks.
- Road dust, road movement and anything else that uses roadConn stay exactly as they are.

STEP 6. VERIFY
- Playwright screenshots with TERRAIN_STYLE 'v2' and 'v1': 1v1 from the S and N viewpoints, and Online Group from all four viewpoints. v1 must match today's board exactly. v2 1v1 South should match docs/terrain-v2/mockups/target_full_map.jpg.
- On the flipped viewpoint, check depth: things nearer the viewer must overlap things behind them, and roads must still pass under the villages.
- Full check set before pushing: node --check on all JS files, check-assets.mjs, check-module-boundaries.mjs, eslint at the 8-warning / 0-error baseline, 15 tests passing with 1 skipped.
- Long commit message explaining what changed and why, including the visuals-v1 tag and how to switch back.

Flag anything in this brief that doesn't fit the code as it stands rather than working around it.
