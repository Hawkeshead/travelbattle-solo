Grass v4: new tufty grassland tiles and a richer set of grass details. Attached: grass_v4.zip. Visual only, no gameplay changes. TERRAIN_STYLE 'v1' must still restore the old board untouched.

1. ART
- Replace everything in assets/terrain/v2/grass/ with the zip's grass/ folder: 6 plain tiles (grass_1 to grass_6, same filenames and canvas as before) and 16 detail tiles in grass/detail/ (grass_7 to grass_22).
- Delete the 11 old detail files. They are not used by anything else.
- Copy the zip's docs/ folder into docs/terrain-v2/grass-v4/ for the record. Do not load it in the game.

2. CODE (js/terrain-v2.js)
- GRASS_DETAIL_COUNT = 16.
- GRASS_DETAIL_FILES, in this order (index = detail number):
  grass_7_oak_single, grass_8_oak_pair, grass_9_oak_trio, grass_10_oak_pair_right, grass_11_poplars_weeds, grass_12_poplars_oak, grass_13_hedge_solo, grass_14_hedge_solo_left, grass_15_campfire_oak, grass_16_campfire_poplars_cart, grass_17_haystack_oak, grass_18_trough_oak, grass_19_pond_oak, grass_20_stump_weeds, grass_21_cart_stump, grass_22_posts_oak
- Replace GRASS_DETAIL_ONE_IN = 5 with GRASS_DETAIL_PERCENT = 30, and change the test in grassPicks from hPos(x, y, 7) % GRASS_DETAIL_ONE_IN === 0 to hPos(x, y, 7) % 100 < GRASS_DETAIL_PERCENT. Keep the open-ground, farm-overlay and neighbour checks exactly as they are, and keep choosing which detail with hPos(x, y, 8) % GRASS_DETAIL_COUNT.
- Update the comment above grassPicks to match (percent instead of one-in-N, 16 details).
- Why the change of rule: "one in 4" was tried and actually gave fewer details than "one in 5" on this map because of where the hash lands. A percentage scales predictably. 30 gives 20 detail squares on the 1v1 map, up from 15.
- check-assets.mjs and render-units.js already read GRASS_DETAIL_FILES, so they should pick up the new list without changes. Confirm that.

3. VERIFY
- Add a test (or extend the grass test) that on the 1v1 map grassPicks produces exactly the detail squares and files in docs/terrain-v2/grass-v4/expected_grass_details_1v1.json (20 squares).
- Playwright screenshot 1v1 South and one Online Group view. Detail placement should match docs/terrain-v2/grass-v4/target_full_map.jpg. Plain grass variants may sit differently, that's fine.
- Screenshot once with TERRAIN_STYLE 'v1' to confirm the old board is unchanged.
- Full check set before pushing: node --check on all JS files, check-assets.mjs, check-module-boundaries.mjs, eslint at the 8-warning / 0-error baseline, all tests passing with the usual 1 skipped.
- Update docs/terrain-v2/HANDOVER.md's grass detail line so it describes the new rule.
- Long commit message explaining what changed and why.

Flag anything that doesn't fit the code as it stands rather than working around it.
