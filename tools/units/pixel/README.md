# Grognards pixel unit sprites (v1)

Generated from infantry.js, cavalry.js and artillery.js (drawn in code, pixel by pixel). preview.html shows every unit in formation and action.

Sheets live in assets/units-pixel/{nation}/{UNIT_TYPE}/{anim}_{facing}_v{variant}.webp, one horizontal strip of equal frames per file, with a sidecar {UNIT_TYPE}.json:
- frameWidth, frameHeight: one frame in sprite pixels
- displayScale: drawn height as a share of one board square (frameHeight / 100, so one sprite pixel = 1% of a square)
- anchorX 0.5, anchorY 1 (bottom centre); ARTILLERY_GUN uses anchorYByFacing because its ground line is above the bottom of the frame
- pixelArt: true, so draw with nearest-neighbour scaling
- variants: number of faces/horses per unit type (guns have 1)
- facings, anims {frameCount, fps, loop}

Unit types: INFANTRY, GUARD, GUARD_BEARER (Guard colour bearer, flag wave baked in), ARTILLERY (gunners), ARTILLERY_GUN, LIGHT_CAV, HEAVY_CAV.
