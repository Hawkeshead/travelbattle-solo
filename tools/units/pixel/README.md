# Grognards pixel unit sprites (v1)

Generated from infantry.js, cavalry.js and artillery.js (drawn in code, pixel by pixel). preview.html shows every unit in formation and action.

Sheets live in assets/units-pixel/{nation}/{UNIT_TYPE}/{anim}_{facing}_v{variant}.webp, one horizontal strip of equal frames per file, with a sidecar {UNIT_TYPE}.json:
- frameWidth, frameHeight: one frame in sprite pixels
- displayScale: drawn height as a share of one board square (frameHeight / 100, so one sprite pixel = 1% of a square)
- anchorX 0.5, anchorY 1 (bottom centre); ARTILLERY_GUN uses anchorYByFacing because its ground line is above the bottom of the frame
- pixelArt: true, so draw with nearest-neighbour scaling
- variants: number of faces/horses per unit type (guns have 1)
- facings, anims {frameCount, fps, loop}

Unit types: INFANTRY, GUARD, GUARD_BEARER (Guard colour bearer, flag wave baked in), ARTILLERY (gunners), ARTILLERY_GUN, LIGHT_CAV, HEAVY_CAV, BRIGADIER (a mounted general officer: cavalry.js 'general' specs, bicorne, epaulettes, sash; exported by `node tools/units/pixel/export-brigadier.mjs`, then converted to lossless webp).

Every type for a whole nation (17 Oct 2026): `node tools/units/pixel/export-nation.mjs prussian` writes the png strips and copies the sidecars; convert them to lossless webp after. `--verify` (with `npx http-server . -p 4173` running) draws the sheets and compares them pixel for pixel with the ones in assets/ instead of writing: British and French reproduce exactly (bar 1 or 2 colour values in the cavalry falls, from webp rounding), so a new nation exported this way matches the shipped rigs. A new nation needs its own branches in infantry.js (NAT, NATG, NATA, headgear, torso, flag), cavalry.js (SPECS with its prefix) and artillery.js (PAL), its 'art' folder in js/nations.js, and its dice in js/dice-art.js.

All nations (17 Oct 2026): Russia (russian, russian2 for its second army), Austria (austrian), Spain (spanish), Portugal (portuguese), France's second army (french2), Poland (polish), the Confederation of the Rhine (confederation) and Italy & Naples (italian) are drawn from a style table in infantry.js (ST: palettes, headgear types shako, barretina, bicorne, czapka, raupe and bearskin, lapels or crossbelts, the Guard's flag) and SPECS entries in cavalry.js (new headgear colpack, czapka, bearskin and Cossack cap; lances with pennons; cuirasses in any colour, front-only for Austria), so the British, French and Prussian branches are untouched (export-nation --verify still matches them). One look per unit type per nation.
