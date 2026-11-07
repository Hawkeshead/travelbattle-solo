# Sprite tool: 3D figures to sprite sheets

Renders the Iso Lab's "3D sprites" figure style (lab/iso.html, style B): every unit type of a nation,
seen from eight directions, a few frames per animation, into one sheet per type:

    lab/sprites3d/<nation>/<TYPE>.webp   the frames, in a grid
    lab/sprites3d/<nation>/<TYPE>.json   frameW, frameH, dirs, anchorY, displayScale, anims

Rows are animations times directions (for each animation in order, directions 0 to 7), columns are
frames. Direction 0 faces the camera; each step turns the figure 45 degrees to the viewer's right.

    node tools/sprites/render-sheets.mjs                 british french prussian spanish portuguese
    node tools/sprites/render-sheets.mjs french --preview   one nation, plus a contact sheet PNG to look at

Needs the devDependency `three` (0.128) and Playwright's Chromium (the session's preinstalled browser
is used when it is at /opt/pw-browsers/chromium). Nothing in the game reads these files.

## The figures

`figures.js` builds the figures from boxes, cylinders and spheres (a man, a man on a horse, a gun),
toon-shaded with a three-step gradient, and poses them by code for each frame: idle, march, fire or
serve or charge, melee and fall. Uniforms come from the palette table at the top of the file, one
line per nation (coat, facings, trousers, hat, plume, the cavalry's coats, the colour's colours, the
horses). Adding a nation is one line.

## Dropping in CC0 models

The brief asked for sprites rendered from CC0 soldier models (Quaternius, Kenney). The sandbox this
was built in could not reach their sites or any model host, so the tool builds its own figures. The
pipeline (pose, eight directions, outline, sheet, sidecar) does not care where the mesh came from:
to use a model, load it in `build()` in figures.js (three's GLTFLoader is in
node_modules/three/examples/js/loaders) and drive its animation clips from `pose()` instead of the
joint rotations. Keep the model under about 2,000 triangles so a frame renders quickly, and list it
with its licence in CREDITS.md.
