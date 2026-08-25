import { CELL, COLS, HALF_COLS, ROWS, SIDES, SIDE_LABEL, UNIT_TYPES, setCell, state } from './data-core.js';
import { inBounds, neighbors8, unitsAt } from './engine-rules.js';
import { log, logReplay } from './engine-state.js';
import { UNIT_IMAGES, drawColumnUnitPair, drawUnit, highlightCells } from './render-units.js';
import { renderAiDebugPanel } from './ui-battle.js';
import { dragState } from './ui-deployment.js';

/* =========================================================
   RENDERING
========================================================= */
// You always sit behind your own troops on screen, regardless of which
// side you're playing. Purely a rendering/input transform — internal
// board coordinates, movement, LOS, and board rotation are untouched.
// Self-inverse (flipping twice returns the original), so the same
// function converts board->screen and screen->board.
export function screenFlipActive(){
  return state.mode==='ai' && state.aiSide===SIDES.RED; // human is playing France (Blue), whose zone is internally "top"
}
export function sy(y){
  return screenFlipActive() ? (ROWS-1-y) : y;
}

/* =========================================================
   UNIT MOVEMENT ANIMATION
   Units jumped instantly to their new square, which made rapid AI
   turns hard to follow. animateUnitTo() updates the logical position
   immediately (game logic never waits on animation) but the VISUAL
   position eases toward it over a short duration; drawUnit reads the
   interpolated position instead of u.x/u.y directly.
========================================================= */
export let unitAnimations = {}; // unitId -> {fromX, fromY, toX, toY, startTime, duration}
export let activeActionLine = null; // {fromX, fromY, toX, toY, color, expiresAt} — who's firing/fighting whom
export let deathEffects = []; // {x, y, startTime} — skull for 2s, then smoke fades over another 2s
export let animFrameHandle = null;

// Undo and the replay player both need to wipe every in-flight visual effect.
// They used to assign to these three bindings directly from another file;
// under ES modules that throws, so the reset lives here instead.
export function clearUnitAnimations(){
  unitAnimations = {};
}

export function clearTransientRenderState(){
  unitAnimations = {};
  activeActionLine = null;
  deathEffects = [];
}

export const DEATH_SKULL_MS = 2000, DEATH_SMOKE_MS = 2000;
export function addDeathEffect(x, y){
  deathEffects.push({x, y, startTime: Date.now()});
  ensureAnimationLoopRunning();
}
export function addCrater(x, y){
  if(state.craters.some(c=>c.x===x && c.y===y)) return; // already scarred, don't stack markers
  state.craters.push({x, y});
}

export function getUnitVisualPos(u){
  const anim = unitAnimations[u.id];
  if(!anim) return {x:u.x, y:u.y};
  const elapsed = Date.now() - anim.startTime;
  const t = Math.min(1, elapsed/anim.duration);
  if(t>=1){ delete unitAnimations[u.id]; return {x:u.x, y:u.y}; }
  const eased = 1 - Math.pow(1-t, 2); // ease-out — starts fast, settles gently
  return { x: anim.fromX + (anim.toX-anim.fromX)*eased, y: anim.fromY + (anim.toY-anim.fromY)*eased };
}

// A Brigadier is never blocked from having an enemy move into his square —
// he's simply shoved 1-2 squares clear. Called right before completing a
// move onto a square a lone enemy Brigadier currently occupies.
export function displaceBrigadierIfPresent(x, y, fromX, fromY){
  const occupant = state.units.find(o=>!o.removed && o.x===x && o.y===y && o.type==='BRIGADIER');
  if(!occupant) return;
  const dx = Math.sign(x-fromX) || 0, dy = Math.sign(y-fromY) || 0;
  const candidates = [
    {x:x+dx*2, y:y+dy*2}, {x:x+dx, y:y+dy},
    {x:x+dx, y:y}, {x:x, y:y+dy},
    ...neighbors8(x,y)
  ];
  for(const c of candidates){
    if(inBounds(c.x,c.y) && unitsAt(c.x,c.y).length===0){
      occupant.x = c.x; occupant.y = c.y;
      log(`${SIDE_LABEL[occupant.side]}'s Brigadier is shoved clear.`, 'system');
      return;
    }
  }
}

// Single source of truth for how long a move animation actually takes —
// referenced by the AI's move-phase pacing (aiDoMovePhase in ai-strategy.js)
// so the two can never drift apart the way a duplicated magic number could.
export const UNIT_MOVE_ANIMATION_MS = 1040;

export function animateUnitTo(u, newX, newY){
  const start = getUnitVisualPos(u); // current rendered position, in case a prior animation was still mid-flight
  logReplay('move', { unitId:u.id, side:u.side, from:{x:u.x,y:u.y}, to:{x:newX,y:newY} });
  u.x = newX; u.y = newY; // logical position updates immediately — game rules never wait on animation
  if(FAST_ANIMATION_MODE){ delete unitAnimations[u.id]; return; } // test/simulation harnesses only — see setFastAnimationMode
  unitAnimations[u.id] = { fromX:start.x, fromY:start.y, toX:newX, toY:newY, startTime:Date.now(), duration:UNIT_MOVE_ANIMATION_MS };
  ensureAnimationLoopRunning();
}

// Mirrors FAST_DICE_MODE in dice.js exactly — never set by real gameplay, only
// by an automated harness that needs a full match to complete in a reasonable
// wall-clock time rather than waiting out 1040ms per unit move, many times a
// turn, many turns a match.
export let FAST_ANIMATION_MODE = false;
export function setFastAnimationMode(on){
  FAST_ANIMATION_MODE = !!on;
}
if(typeof window !== 'undefined'){
  window.__tbTest = Object.assign(window.__tbTest || {}, { setFastAnimationMode });
}

export function showActionLine(fromUnit, toUnit, color, durationMs, dashed){
  activeActionLine = { fromX:fromUnit.x, fromY:fromUnit.y, toX:toUnit.x, toY:toUnit.y, color, dashed:!!dashed, expiresAt: Date.now()+(durationMs||1800) };
  ensureAnimationLoopRunning();
}

export function ensureAnimationLoopRunning(){
  if(animFrameHandle) return;
  function tick(){
    draw();
    const stillAnimating = Object.keys(unitAnimations).length>0;
    const lineActive = activeActionLine && Date.now() < activeActionLine.expiresAt;
    if(!lineActive) activeActionLine = null;
    const now = Date.now();
    deathEffects = deathEffects.filter(d => now - d.startTime < DEATH_SKULL_MS + DEATH_SMOKE_MS);
    const deathActive = deathEffects.length>0;
    // British Line Infantry's sprite-sheet animation (see
    // drawBritishLineInfantryImage) needs continuous redraws to advance —
    // without this, it only re-renders (and so only appears to animate)
    // when some unrelated move/fight/death animation happens to be running,
    // freezing on whatever frame was current the rest of the time.
    const spriteAnimActive = state.units.some(u => !u.removed && (UNIT_TYPES[u.type].key==='INFANTRY' || UNIT_TYPES[u.type].key==='GUARD'));
    if(stillAnimating || lineActive || deathActive || spriteAnimActive){
      animFrameHandle = requestAnimationFrame(tick);
    } else {
      animFrameHandle = null;
    }
  }
  animFrameHandle = requestAnimationFrame(tick);
}

export const canvas = document.getElementById('board');
export const ctx = canvas.getContext('2d');

export function computeCellSize(){
  const wrap = document.getElementById('boardWrap');
  const viewportW = document.documentElement.clientWidth || window.innerWidth;
  const availW = Math.max(200, Math.min(wrap.clientWidth, viewportW) - 16);
  const availH = Math.max(200, wrap.clientHeight - 16);
  const byWidth = Math.floor(availW / COLS);
  const byHeight = Math.floor(availH / ROWS);
  return Math.max(22, Math.min(byWidth, byHeight, 68));
}

export function sizeCanvas(){
  setCell(computeCellSize());
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = (COLS*CELL) + 'px';
  canvas.style.height = (ROWS*CELL) + 'px';
  canvas.width = COLS*CELL*dpr;
  canvas.height = ROWS*CELL*dpr;
  ctx.setTransform(dpr,0,0,dpr,0,0);
  resetMapView(); // board dimensions just changed (new match, resize, mode switch) — any prior zoom/pan is stale
  draw();
}

/* =========================================================
   MAP ZOOM & PAN
   Pinch-to-zoom and single-finger pan, scoped to the board canvas only —
   #board has touch-action:none so the browser's own page-pinch-zoom never
   fires when a gesture starts here, leaving the rest of the page's native
   zoom untouched. Implemented as a CSS transform on the canvas element
   itself; every existing click/drag handler reads canvas.getBoundingClientRect(),
   which already reflects the transform automatically, so none of that code
   needed to change.
========================================================= */
export const MAP_MIN_ZOOM = 1, MAP_MAX_ZOOM = 3;
export let mapZoom = 1, mapPanX = 0, mapPanY = 0;
export let mapGesturePointers = new Map();
export let mapPinchStartDist = null, mapPinchStartZoom = 1;
export let mapPanStart = null;
// Finger drift, in CSS px, before a touch stops counting as a tap. 6px was well
// under any reasonable touch slop — a phone tap routinely wanders 8-10px between
// down and up, especially one-handed — so ordinary taps were being read as pans.
export const TAP_SLOP_PX = 12;
// Past this, treat it as a deliberate drag and suppress the tap even if the
// board could not move, because nobody drags 32px meaning to tap.
export const TAP_ABANDON_PX = 32;

export let mapGestureMoved = false; // true once the current gesture passed the tap threshold — the click handler checks this to avoid selecting a cell after a pan/pinch

// Read-and-clear, for the board click handler in ui-battle.js. It used to read
// mapGestureMoved and reset it directly; an imported binding is read-only under
// ES modules, so the write has to happen in the file that owns the variable.
export function consumeGestureFlag(){
  const moved = mapGestureMoved;
  mapGestureMoved = false;
  return moved;
}

export function resetMapView(){
  mapZoom = 1; mapPanX = 0; mapPanY = 0;
  mapGesturePointers.clear();
  mapPinchStartDist = null; mapPanStart = null; mapGestureMoved = false;
  applyMapTransform();
}

export function clampMapPan(){
  const wrap = document.getElementById('boardWrap');
  const scaledW = canvas.offsetWidth * mapZoom, scaledH = canvas.offsetHeight * mapZoom;
  const minX = Math.min(0, wrap.clientWidth - scaledW), maxX = 0;
  const minY = Math.min(0, wrap.clientHeight - scaledH), maxY = 0;
  mapPanX = Math.max(minX, Math.min(maxX, mapPanX));
  mapPanY = Math.max(minY, Math.min(maxY, mapPanY));
}

export function applyMapTransform(){
  clampMapPan();
  canvas.style.transform = `translate(${mapPanX}px, ${mapPanY}px) scale(${mapZoom})`;
}

canvas.addEventListener('pointerdown', (e)=>{
  try { canvas.setPointerCapture(e.pointerId); } catch(err) { /* not always available/needed — gesture tracking below still works without it */ }
  mapGesturePointers.set(e.pointerId, {x:e.clientX, y:e.clientY});
  mapGestureMoved = false;
  if(mapGesturePointers.size===1){
    mapPanStart = {x:e.clientX, y:e.clientY, panX:mapPanX, panY:mapPanY};
  } else if(mapGesturePointers.size===2){
    const pts = [...mapGesturePointers.values()];
    mapPinchStartDist = Math.hypot(pts[0].x-pts[1].x, pts[0].y-pts[1].y);
    mapPinchStartZoom = mapZoom;
    mapPanStart = null; // a second finger landed — hand off from pan to pinch
  }
});

canvas.addEventListener('pointermove', (e)=>{
  if(!mapGesturePointers.has(e.pointerId)) return;
  mapGesturePointers.set(e.pointerId, {x:e.clientX, y:e.clientY});
  if(mapGesturePointers.size===2 && mapPinchStartDist){
    const pts = [...mapGesturePointers.values()];
    const dist = Math.hypot(pts[0].x-pts[1].x, pts[0].y-pts[1].y);
    mapZoom = Math.max(MAP_MIN_ZOOM, Math.min(MAP_MAX_ZOOM, mapPinchStartZoom * (dist/mapPinchStartDist)));
    mapGestureMoved = true;
    applyMapTransform();
  } else if(mapGesturePointers.size===1 && mapPanStart){
    const dx = e.clientX-mapPanStart.x, dy = e.clientY-mapPanStart.y;
    const drift = Math.hypot(dx,dy);
    if(drift > TAP_SLOP_PX){
      // Suppress the tap only if the board ACTUALLY moved. The old code set the
      // flag the moment the finger passed 6px, before clampMapPan had its say —
      // and at the default zoom the canvas fits its container, so minX/maxX both
      // collapse to 0 and the pan is pinned straight back to zero. The board
      // stayed put AND the tap was swallowed: tap a unit, nothing happens, tap
      // again, nothing happens. Comparing before and after the clamp means a
      // gesture that changed nothing on screen no longer eats the tap.
      const beforeX = mapPanX, beforeY = mapPanY;
      mapPanX = mapPanStart.panX + dx;
      mapPanY = mapPanStart.panY + dy;
      applyMapTransform();
      if(mapPanX !== beforeX || mapPanY !== beforeY) mapGestureMoved = true;
      // A drag this long was never a tap, whatever the clamp did with it.
      else if(drift > TAP_ABANDON_PX) mapGestureMoved = true;
    }
  }
});

export function mapPointerEnd(e){
  mapGesturePointers.delete(e.pointerId);
  if(mapGesturePointers.size<2) mapPinchStartDist = null;
  if(mapGesturePointers.size===0) mapPanStart = null;
}
canvas.addEventListener('pointerup', mapPointerEnd);
canvas.addEventListener('pointercancel', mapPointerEnd);
canvas.addEventListener('dblclick', resetMapView); // quick reset for anyone who finds pinch fiddly

export function terrainColor(key){
  return { OPEN: '#3c4a34', FIELD:'#8a7d3f', PLOUGHED_FIELD:'#b89a3f', ROAD:'#8a7350', WOODS:'#26361f', BUILDING:'#6b5847', HILL:'#5a5636' }[key];
}

// A faint, warm paper-grain texture, generated once and reused as a repeating
// pattern — gives the map a physical, aged-paper feel instead of a flat
// digital fill, at negligible per-frame cost since it's a single pattern fill.
export let PARCHMENT_TEXTURE_CACHE = null;
export function getParchmentTexturePattern(){
  if(PARCHMENT_TEXTURE_CACHE) return PARCHMENT_TEXTURE_CACHE;
  const tile = document.createElement('canvas');
  tile.width = 96; tile.height = 96;
  const tctx = tile.getContext('2d');
  const imgData = tctx.createImageData(96,96);
  for(let i=0;i<imgData.data.length;i+=4){
    const v = 210 + Math.floor((Math.random()-0.5)*70);
    imgData.data[i] = v; imgData.data[i+1] = v-6; imgData.data[i+2] = v-18; imgData.data[i+3] = 12;
  }
  tctx.putImageData(imgData,0,0);
  PARCHMENT_TEXTURE_CACHE = ctx.createPattern(tile, 'repeat');
  return PARCHMENT_TEXTURE_CACHE;
}

// Small hand-drawn map-symbol glyphs, in the ink/brass palette, standing in
// for the old emoji icons (which render inconsistently across platforms and
// read as a placeholder rather than a deliberate mark on an aged map).
export function drawHillGlyph(cx, cy, cell){
  // A soft double-peak contour, low-opacity — Hill already carries its own
  // fill colour and a rocky border around the whole landform, so this is a
  // light accent rather than the primary way hills read.
  ctx.save();
  ctx.translate(cx, cy);
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = '#e9e4d6';
  ctx.lineWidth = Math.max(1, cell*0.035);
  ctx.lineJoin = 'round';
  const w = cell*0.34, h = cell*0.22;
  ctx.beginPath();
  ctx.moveTo(-w, h*0.4);
  ctx.lineTo(-w*0.28, -h*0.7);
  ctx.lineTo(-w*0.02, -h*0.15);
  ctx.lineTo(w*0.32, -h);
  ctx.lineTo(w, h*0.4);
  ctx.stroke();
  ctx.restore();
}

/* =========================================================
   TERRAIN RENDERING HELPERS
   The map is meant to read as geomorphic and analogue, not a rigid
   grid — the grid only matters for movement/LOS/combat range. These
   helpers group same-type terrain into connected regions and render
   them as one organic shape rather than a tile-by-tile stamp.
========================================================= */
export function findConnectedRegions(terrain, key){
  const h = terrain.length, w = terrain[0].length;
  const regions = [];
  const visited = new Set();
  for(let y=0;y<h;y++){
    for(let x=0;x<w;x++){
      if(terrain[y][x]!==key) continue;
      const k = x+','+y;
      if(visited.has(k)) continue;
      const region = [];
      const stack = [[x,y]];
      visited.add(k);
      while(stack.length){
        const [cx,cy] = stack.pop();
        region.push([cx,cy]);
        for(const [dx,dy] of [[0,-1],[0,1],[-1,0],[1,0]]){
          const nx=cx+dx, ny=cy+dy;
          if(nx<0||nx>=w||ny<0||ny>=h) continue;
          const nk = nx+','+ny;
          if(visited.has(nk) || terrain[ny][nx]!==key) continue;
          visited.add(nk);
          stack.push([nx,ny]);
        }
      }
      regions.push(region);
    }
  }
  return regions;
}
export function seededWobble(seed){
  const v = Math.sin(seed*12.9898)*43758.5453;
  return (v - Math.floor(v)) - 0.5; // -0.5..0.5
}
export function seededRand(seed){ return seededWobble(seed) + 0.5; } // 0..1, same generator
// Deterministic per-cell pick from the 6 Forest tile styles — each Woods cell
// independently "rolls" its own style, but stays stable across redraws since
// it's a function of the cell's own coordinates rather than stored RNG state.
// How far the Woods art is drawn beyond its cell so the treetops overhang
// the tile above (see the drawing loop for why the art needs it).
export const WOODS_OVERSCAN = 1.3;
export function woodsStyleIndex(x,y){
  return 1 + Math.floor(seededRand(x*97+y*131+5) * 6);
}
// Same idea for Hill — each cell independently picks one of 6 hill-mound
// tiles. Unlike Woods this trades away the old connected-region outline that
// made a hill mass read as one landform (each tile is a complete standalone
// mound, not a modular hillside chunk) — a deliberate trade Matthew chose
// for richer art. Different seed offsets from woodsStyleIndex so the two
// don't correlate on cells that happen to share coordinates.
export function hillStyleIndex(x,y){
  return 1 + Math.floor(seededRand(x*151+y*211+37) * 6);
}

// A faint repeating grass-blade texture for Open/Hill ground — cheap (one
// pattern fill covering the whole board) rather than per-tile stroke calls,
// which matters once Grand Strategy's 400-cell board is in play.
export let GRASS_TEXTURE_CACHE = null;
export function getGrassTexturePattern(){
  if(GRASS_TEXTURE_CACHE) return GRASS_TEXTURE_CACHE;
  const tile = document.createElement('canvas');
  const size = 72;
  tile.width = size; tile.height = size;
  const tctx = tile.getContext('2d');
  for(let i=0;i<26;i++){
    const bx = seededRand(i*7+1)*size, by = seededRand(i*13+2)*size;
    const len = 4 + seededRand(i*19+3)*6;
    const lean = (seededWobble(i*23+4))*len*0.7;
    const dark = seededWobble(i*29+5) > 0;
    tctx.strokeStyle = dark ? 'rgba(18,24,14,0.16)' : 'rgba(150,165,118,0.14)';
    tctx.lineWidth = 1.1;
    tctx.beginPath();
    tctx.moveTo(bx, by);
    tctx.quadraticCurveTo(bx+lean*0.5, by-len*0.6, bx+lean, by-len);
    tctx.stroke();
  }
  GRASS_TEXTURE_CACHE = ctx.createPattern(tile, 'repeat');
  return GRASS_TEXTURE_CACHE;
}

export function roundedBlobPath(ctx, x, y, w, h, r){
  ctx.beginPath();
  ctx.moveTo(x+r,y);
  ctx.arcTo(x+w,y,x+w,y+h,r);
  ctx.arcTo(x+w,y+h,x,y+h,r);
  ctx.arcTo(x,y+h,x,y,r);
  ctx.arcTo(x,y,x+w,y,r);
  ctx.closePath();
}

// A cluster of small overlapping canopy shapes, standing in for a single flat
// tree-blob — a few individual tree crowns rather than one solid mass, in
// varied green tones for depth. Seeded per cell so it's stable across redraws.
export function drawTreeCanopyCluster(cx, cy, cellSize, seed){
  const shades = ['#33472a','#243318','#3d5230'];
  const n = 4 + Math.floor(seededRand(seed*3+1)*2); // 4-5 canopies
  for(let i=0;i<n;i++){
    const ang = seededRand(seed*11+i*17+1) * Math.PI*2;
    const dist = seededRand(seed*13+i*19+2) * cellSize*0.28;
    const px = cx + Math.cos(ang)*dist, py = cy + Math.sin(ang)*dist*0.8;
    const r = cellSize*(0.16 + seededRand(seed*7+i*23+3)*0.10);
    ctx.fillStyle = shades[i % shades.length];
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI*2);
    ctx.fill();
  }
}

// A loose cluster of small varied cottages standing in for one uniform
// building icon — a hamlet rather than a single house, roof tones and sizes
// jittered per building so no two tiles look identical. Base positions are
// fixed per cluster size (not fully random) so houses reliably separate
// rather than landing on top of each other, with a little seeded jitter on
// top for an organic, not-quite-uniform arrangement.
export function drawBuildingCluster(cx, cy, cellSize, seed){
  const roofColors = ['#8a4f36','#6b5847','#7a6248'];
  const n = 2 + Math.floor(seededRand(seed*5+1)*2); // 2-3 houses
  const basePositions = n===2
    ? [[-0.24,0.08],[0.24,-0.12]]
    : [[-0.28,0.16],[0.26,0.12],[0.02,-0.26]];
  for(let i=0;i<n;i++){
    const [bx,by] = basePositions[i];
    const jx = seededWobble(seed*9+i*29+1) * cellSize*0.06;
    const jy = seededWobble(seed*17+i*31+2) * cellSize*0.06;
    const px = cx + bx*cellSize + jx, py = cy + by*cellSize + jy;
    const scale = 0.60 + seededRand(seed*21+i*37+3)*0.24;
    const w = cellSize*0.30*scale, hWall = cellSize*0.20*scale, hRoof = cellSize*0.18*scale;
    ctx.save();
    ctx.translate(px, py);
    ctx.fillStyle = '#e9e4d6';
    ctx.globalAlpha = 0.9;
    ctx.fillRect(-w*0.55, -hWall*0.05, w*1.1, hWall*1.05);
    ctx.fillStyle = roofColors[(i+Math.floor(seed))%roofColors.length];
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.moveTo(-w*0.68, -hWall*0.05);
    ctx.lineTo(0, -hRoof-hWall*0.05);
    ctx.lineTo(w*0.68, -hWall*0.05);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#3a2f22';
    ctx.fillRect(-w*0.12, hWall*0.35, w*0.24, hWall*0.65);
    ctx.restore();
  }
}

export function draw(){
  const debugPanel = document.getElementById('aiDebugPanel');
  if(debugPanel && debugPanel.style.display==='block') renderAiDebugPanel();
  const flip = screenFlipActive();
  ctx.clearRect(0,0,canvas.width,canvas.height);
  const terrain = state.terrain;

  // base fill — road cells fill as open ground; Hill matches Open (elevation is
  // shown by its border, not a colour change); the ploughed-field/woods passes
  // paint over their own cells next. Kept as a fallback fill even for Open
  // cells (drawn over next, once the grass tile images are ready) so there's
  // no flash of blank canvas while those assets are still decoding.
  for(let y=0;y<ROWS;y++){
    const sy_ = sy(y);
    for(let x=0;x<COLS;x++){
      const key = terrain[y][x];
      ctx.fillStyle = terrainColor(key==='ROAD' ? 'OPEN' : key);
      ctx.fillRect(x*CELL,sy_*CELL,CELL,CELL);
    }
  }

  // Open ground: each cell independently shows one of 6 grassland tile
  // styles (assignGrassStyles, computed once per terrain generation — see
  // ui-menus.js) rather than a flat fill, patched together so same-style
  // cells clump into small "fields" instead of scattering as noise. These
  // tiles already fill their full square with real grass/flower detail, so
  // Road keeps the older flat-colour-plus-blade-texture treatment below
  // rather than doubling up on top of this.
  if(state.grassStyles){
    for(let y=0;y<ROWS;y++){
      const sy_ = sy(y);
      for(let x=0;x<COLS;x++){
        // BUILDING as well as OPEN — see assignGrassStyles. Drawn before the
        // hamlet pass below, so the village plate lands on real grassland
        // instead of the flat fallback fill.
        if(terrain[y][x]!=='OPEN' && terrain[y][x]!=='BUILDING') continue;
        const style = state.grassStyles[y][x];
        if(!style) continue;
        const img = UNIT_IMAGES['grass_'+style];
        if(img && img.complete && img.naturalWidth>0){
          ctx.drawImage(img, x*CELL, sy_*CELL, CELL, CELL);
        }
      }
    }
  }

  // Grass texture — a repeating blade pattern clipped to Road cells only
  // now; Open and Hill ground get their detail from the tile images above.
  ctx.save();
  ctx.beginPath();
  for(let y=0;y<ROWS;y++){
    for(let x=0;x<COLS;x++){
      const key = terrain[y][x];
      if(key==='ROAD') ctx.rect(x*CELL, sy(y)*CELL, CELL, CELL);
    }
  }
  ctx.clip();
  ctx.fillStyle = getGrassTexturePattern();
  ctx.fillRect(0, 0, COLS*CELL, ROWS*CELL);
  ctx.restore();

  // Ploughed fields: wheat yellow with furrow lines along the field's long axis,
  // computed per contiguous group so a whole field reads as one shape.
  const ploughRegions = findConnectedRegions(terrain, 'PLOUGHED_FIELD');
  for(const region of ploughRegions){
    ctx.save();
    ctx.beginPath();
    for(const [x,y] of region) ctx.rect(x*CELL, sy(y)*CELL, CELL, CELL);
    ctx.clip();
    const screenYs = region.map(([,y])=>sy(y));
    const minX=Math.min(...region.map(c=>c[0])), maxX=Math.max(...region.map(c=>c[0]));
    const minSY=Math.min(...screenYs), maxSY=Math.max(...screenYs);
    const widthPx = (maxX-minX+1)*CELL, heightPx = (maxSY-minSY+1)*CELL;
    const horizontal = widthPx >= heightPx;
    ctx.strokeStyle = 'rgba(120,88,32,0.55)';
    ctx.lineWidth = Math.max(1, CELL*0.045);
    const spacing = CELL*0.24;
    if(horizontal){
      for(let ly=minSY*CELL; ly<(maxSY+1)*CELL; ly+=spacing){
        ctx.beginPath(); ctx.moveTo(minX*CELL,ly); ctx.lineTo((maxX+1)*CELL,ly); ctx.stroke();
      }
    } else {
      for(let lx=minX*CELL; lx<(maxX+1)*CELL; lx+=spacing){
        ctx.beginPath(); ctx.moveTo(lx,minSY*CELL); ctx.lineTo(lx,(maxSY+1)*CELL); ctx.stroke();
      }
    }
    ctx.restore();
  }

  // Roads: tile art for genuine 2+ way connections (straight, corner, T,
  // cross), matching whichever cardinal directions are connected on SCREEN —
  // not logical grid direction, since the board can flip vertically for the
  // human player's side (screenFlipActive) while the tile art itself has a
  // fixed visual orientation. X never flips in this game, only Y. A cell
  // with 0 or 1 connections (an isolated stub, or a genuine dead-end from
  // excludedRoadEdges) has no matching tile, so it just shows the grass
  // backdrop with nothing drawn over it.
  const excluded = state.excludedRoadEdges || new Set();
  const roadConn = {};
  for(let y=0;y<ROWS;y++) for(let x=0;x<COLS;x++){
    if(terrain[y][x]!=='ROAD') continue;
    const list = [];
    for(const [dx,dy] of [[0,-1],[0,1],[-1,0],[1,0]]){
      const nx=x+dx, ny=y+dy;
      if(!inBounds(nx,ny) || terrain[ny][nx]!=='ROAD') continue;
      const ekey = (x<nx || (x===nx && y<ny)) ? `${x},${y}-${nx},${ny}` : `${nx},${ny}-${x},${y}`;
      if(excluded.has(ekey)) continue;
      list.push({x:nx,y:ny});
    }
    roadConn[x+','+y] = list;
  }
  function roadScreenDirs(x, y, list){
    const dirs = { up:false, down:false, left:false, right:false };
    const sy0 = sy(y);
    for(const n of list){
      if(n.x < x) dirs.left = true;
      else if(n.x > x) dirs.right = true;
      else if(sy(n.y) < sy0) dirs.up = true;
      else if(sy(n.y) > sy0) dirs.down = true;
    }
    return dirs;
  }
  function roadTileKey(dirs){
    const count = (dirs.up?1:0)+(dirs.down?1:0)+(dirs.left?1:0)+(dirs.right?1:0);
    if(count===4) return 'road_cross';
    if(count===3){
      if(!dirs.up) return 'road_t_missing_up';
      if(!dirs.down) return 'road_t_missing_down';
      if(!dirs.left) return 'road_t_missing_left';
      return 'road_t_missing_right';
    }
    if(count===2){
      if(dirs.up && dirs.down) return 'road_straight_v';
      if(dirs.left && dirs.right) return 'road_straight_h';
      if(dirs.up && dirs.right) return 'road_corner_tr';
      if(dirs.down && dirs.right) return 'road_corner_br';
      if(dirs.down && dirs.left) return 'road_corner_bl';
      if(dirs.up && dirs.left) return 'road_corner_tl';
    }
    return null;
  }
  for(let y=0;y<ROWS;y++){
    const sy_ = sy(y);
    for(let x=0;x<COLS;x++){
      if(terrain[y][x]!=='ROAD') continue;
      const list = roadConn[x+','+y] || [];
      const key = roadTileKey(roadScreenDirs(x, y, list));
      if(!key){
        // 0 or 1 connections — no matching tile art, so this cell would
        // otherwise sit on the plain dark Open-terrain fallback fill with
        // nothing to soften it, unlike an actual Open cell (which gets a
        // proper grass tile). Give it the same grass backdrop Woods/Hill
        // use for their own per-cell art — a deterministic hash, not the
        // constrained patchwork algorithm, since this is just a rare
        // fallback backdrop, not a real "grass square" needing that
        // clustering behaviour. Nothing is drawn over it.
        const gimg = UNIT_IMAGES['grass_'+woodsStyleIndex(x,y)];
        if(gimg && gimg.complete && gimg.naturalWidth>0){
          ctx.drawImage(gimg, x*CELL, sy_*CELL, CELL, CELL);
        }
        continue;
      }
      const img = UNIT_IMAGES[key];
      if(img && img.complete && img.naturalWidth>0){
        ctx.drawImage(img, x*CELL, sy_*CELL, CELL, CELL);
      }
    }
  }
  /* ---------------------------------------------------------------------
     RAISED FEATURES — one pass, ordered by SCREEN ROW.

     Hill, Building and Woods all draw at WOODS_OVERSCAN: 1.3 cells wide,
     1.69 tall, bottom-anchored, so each bleeds 15% of a cell to either side
     and 0.69 of a cell upward over whatever is behind it.

     They used to be three separate passes, run in type order with Ploughed,
     the road texture and the road tile art interleaved between them. That
     ordering has nothing to do with what is in front of what, so it produced
     two visible faults once the tiles started bleeding:

       - a Building on row 2 painted over a Hill on row 10, because the
         Building pass simply ran later than the Hill pass
       - Roads and Ploughed fields, running after Buildings, painted their
         full CELL x CELL square straight over any village bleeding into
         them, cutting a hard rectangular seam across the artwork

     The second is why enlarging the hamlets appeared to fix some tiles and
     not others: a village surrounded by Open grass looked right, because
     grass draws before it. One touching a road or a field got a square
     stamped over its corner.

     Sorting by sy(y) rather than y is load-bearing. screenFlipActive()
     inverts the board for the second player, and sorting on the raw row
     would invert the entire depth order for them — everything in front
     drawn behind — which is a hard fault to spot because it only appears on
     a flipped board.

     Ground passes (base fill, grass, road texture, Ploughed, road art) all
     draw exactly CELL x CELL and stay where they are, above. Only these
     three bleed, so only these three need ordering.
  --------------------------------------------------------------------- */
  const raisedFeatures = [];
  for(let y=0;y<ROWS;y++){
    for(let x=0;x<COLS;x++){
      const key = terrain[y][x];
      if(key==='HILL' || key==='BUILDING' || key==='WOODS'){
        raisedFeatures.push({ x, y, key, sy_: sy(y) });
      }
    }
  }
  // Lower screen row last, so it lands on top of anything behind it. The x
  // tiebreak only keeps the order deterministic within a row; nothing in a
  // single row can overlap anything else in that row by more than the 15%
  // side bleed, so it has no visual consequence.
  raisedFeatures.sort((a,b) => a.sy_ - b.sy_ || a.x - b.x);

  for(const f of raisedFeatures){
    const { x, y, key, sy_ } = f;

    if(key === 'HILL'){
      const img = UNIT_IMAGES['hill_'+hillStyleIndex(x,y)];
      if(img && img.complete && img.naturalWidth>0){
        // The source art fits its whole composition (ground platform plus
        // trees) inside its bottom 1000x1000 square, leaving the 300px
        // overflow band empty — so drawn at exactly one cell wide the trees
        // stop dead at the cell's top edge and never overlap the tile above.
        const w = CELL*WOODS_OVERSCAN;
        const h = w*(img.naturalHeight/img.naturalWidth);
        ctx.drawImage(img, x*CELL-(w-CELL)/2, sy_*CELL+CELL-h, w, h);
      }

    } else if(key === 'BUILDING'){
      const style = state.buildingStyles && state.buildingStyles[y][x];
      if(!style) continue;
      const img = UNIT_IMAGES['building_'+style];
      if(img && img.complete && img.naturalWidth>0){
        // Drawn at WOODS_OVERSCAN like Hill and Woods. It used to draw at
        // exactly one cell wide while every other feature drew at 1.3, which
        // rendered hamlets at 77% the size of the terrain beside them. The old
        // height clamp went with it: at one cell wide min(CELL*1.3, w*ratio)
        // was a no-op because the art is exactly 1.3:1, but at 1.3 cells wide
        // the natural height is 1.69 cells and the clamp would have squashed
        // every hamlet by 23% instead of enlarging it.
        const w = CELL*WOODS_OVERSCAN;
        const h = w*(img.naturalHeight/img.naturalWidth);
        ctx.drawImage(img, x*CELL-(w-CELL)/2, sy_*CELL+CELL-h, w, h);
      }

    } else { // WOODS
      const imgKey = 'forest_notroops_' + woodsStyleIndex(x,y);
      const img = UNIT_IMAGES[imgKey];
      if(img && img.complete && img.naturalWidth>0){
        // Lay a grass tile down first. The forest art's own base doesn't quite
        // reach the cell's top corners (the treeline curves inward there), and
        // unlike an Open cell a Woods cell otherwise has nothing underneath —
        // so those corners showed the plain dark fallback fill. Confined to
        // this cell, so it cannot disturb anything already drawn beside it.
        const gimg = UNIT_IMAGES['grass_'+woodsStyleIndex(x,y)];
        if(gimg && gimg.complete && gimg.naturalWidth>0){
          ctx.drawImage(gimg, x*CELL, sy_*CELL, CELL, CELL);
        }
        const w = CELL*WOODS_OVERSCAN;
        const h = w*(img.naturalHeight/img.naturalWidth);
        ctx.drawImage(img, x*CELL-(w-CELL)/2, sy_*CELL+CELL-h, w, h);
      } else {
        // fallback while the image decodes: the old flat fill, no canopy detail
        ctx.fillStyle = terrainColor('WOODS');
        ctx.fillRect(x*CELL, sy_*CELL, CELL, CELL);
      }
    }
  }

  // Road and building connections are entirely tile art now — the old
  // hand-drawn brown strokes (per-edge curved road lines, the dot for an
  // isolated road cell, and the building-to-road connector lines) have all
  // been removed. Road cells that don't match one of the 11 tile patterns
  // (an isolated stub or a genuine dead-end from excludedRoadEdges) just
  // show the grass backdrop laid down above, with no stroke over it.

  // craters: every square Artillery has hit this match, above terrain, below units
  for(const c of state.craters){
    const cx = c.x*CELL+CELL/2, cy = sy(c.y)*CELL+CELL/2;
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = '#1a1710';
    ctx.beginPath(); ctx.arc(cx, cy, CELL*0.20, 0, Math.PI*2); ctx.fill();
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = '#3a332a';
    ctx.beginPath(); ctx.arc(cx, cy, CELL*0.30, 0, Math.PI*2); ctx.fill();
    ctx.restore();
  }

  // grid — always visible during deployment (placing units needs the whole
  // board legible); during battle it stays hidden until a unit is selected,
  // then only draws on the cells that unit can actually act on (so the board
  // reads as a clean map rather than permanent graph paper). Move squares
  // keep the standard gold, squares that would trigger a fight (a target or
  // a charge's resulting contact) draw in red so the consequence of tapping
  // that square is visible before you commit to it.
  const showFullGrid = state.phase==='deploy';
  const showSelectionGrid = !showFullGrid && state.selectedUnitId && highlightCells && highlightCells.length;
  if(showFullGrid){
    ctx.strokeStyle = 'rgba(184,147,79,0.18)';
    ctx.lineWidth = 1;
    for(let x=0;x<=COLS;x++){ ctx.beginPath(); ctx.moveTo(x*CELL,0); ctx.lineTo(x*CELL,ROWS*CELL); ctx.stroke(); }
    for(let y=0;y<=ROWS;y++){ ctx.beginPath(); ctx.moveTo(0,y*CELL); ctx.lineTo(COLS*CELL,y*CELL); ctx.stroke(); }
  } else if(showSelectionGrid){
    ctx.lineWidth = 1.5;
    for(const c of highlightCells){
      ctx.strokeStyle = c.kind==='move' ? 'rgba(184,147,79,0.55)' : 'rgba(181,69,63,0.75)';
      ctx.strokeRect(c.x*CELL, sy(c.y)*CELL, CELL, CELL);
    }
    ctx.lineWidth = 1;
  }

  // seam between the two physical boards — only relevant while still picking
  // orientation; once that's settled and deployment begins, the seam is no
  // longer meaningful and just clutters the board.
  if(state.phase==='orientation'){
    ctx.strokeStyle = 'rgba(233,228,214,0.35)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6,4]);
    ctx.beginPath(); ctx.moveTo(HALF_COLS*CELL,0); ctx.lineTo(HALF_COLS*CELL,ROWS*CELL); ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
  }

  // deployment zone tint during deploy phase (Blue = top rows, Red = bottom rows;
  // depth is 2 for a standard match, 3 for Grand Strategy — see attemptDeployAt)
  if(state.phase==='deploy'){
    const deployRows = state.boardMode==='grand' ? 3 : 2;
    const blueTop = Math.min(sy(0), sy(deployRows-1));
    ctx.fillStyle = 'rgba(46,69,102,0.14)';
    ctx.fillRect(0, blueTop*CELL, COLS*CELL, deployRows*CELL);
    const redTop = Math.min(sy(ROWS-deployRows), sy(ROWS-1));
    ctx.fillStyle = 'rgba(163,64,58,0.10)';
    ctx.fillRect(0, redTop*CELL, COLS*CELL, deployRows*CELL);
  }

  // movement / target highlights
  if(highlightCells && highlightCells.length){
    for(const c of highlightCells){
      ctx.fillStyle = c.kind==='move' ? 'rgba(184,147,79,0.35)' : c.kind==='charge' ? 'rgba(224,110,30,0.5)' : 'rgba(181,69,63,0.4)';
      ctx.fillRect(c.x*CELL+3, sy(c.y)*CELL+3, CELL-6, CELL-6);
    }
  }

  // drag-and-drop hover cell during deployment
  if(dragState && dragState.dragging && dragState.hoverCell){
    ctx.fillStyle = 'rgba(184,147,79,0.5)';
    ctx.fillRect(dragState.hoverCell.x*CELL+2, sy(dragState.hoverCell.y)*CELL+2, CELL-4, CELL-4);
    ctx.strokeStyle = 'rgba(253,246,227,0.9)'; ctx.lineWidth=2;
    ctx.strokeRect(dragState.hoverCell.x*CELL+2, sy(dragState.hoverCell.y)*CELL+2, CELL-4, CELL-4);
  }

  // who's firing/fighting whom — fades out on its own after a couple of seconds
  if(activeActionLine && Date.now() < activeActionLine.expiresAt){
    const ln = activeActionLine;
    const fx = ln.fromX*CELL+CELL/2, fy = sy(ln.fromY)*CELL+CELL/2;
    const tx = ln.toX*CELL+CELL/2, ty = sy(ln.toY)*CELL+CELL/2;
    const remaining = (ln.expiresAt - Date.now()) / 3800;
    const alpha = Math.max(0, Math.min(1, remaining*2.2)); // hold steady, then fade in the last stretch
    ctx.save();
    ctx.strokeStyle = ln.color;
    ctx.globalAlpha = alpha;
    if(ln.dashed){
      // Artillery firing line specifically — much bolder than the plain fight
      // line so it reads clearly across the board, not just up close.
      ctx.lineWidth = Math.max(5, CELL*0.16);
      ctx.setLineDash([CELL*0.18, CELL*0.09]);
    } else {
      ctx.lineWidth = Math.max(2, CELL*0.06);
    }
    ctx.beginPath(); ctx.moveTo(fx,fy); ctx.lineTo(tx,ty); ctx.stroke();
    ctx.setLineDash([]);
    // arrowhead at the target end
    const ang = Math.atan2(ty-fy, tx-fx);
    const ah = CELL*0.16;
    ctx.beginPath();
    ctx.moveTo(tx,ty);
    ctx.lineTo(tx-ah*Math.cos(ang-Math.PI/7), ty-ah*Math.sin(ang-Math.PI/7));
    ctx.lineTo(tx-ah*Math.cos(ang+Math.PI/7), ty-ah*Math.sin(ang+Math.PI/7));
    ctx.closePath();
    ctx.fillStyle = ln.color;
    ctx.fill();
    ctx.restore();
  }

  // units — stacked squares (doubled infantry) are offset so both are visible
  const stackGroups = {};
  for(const u of state.units){
    if(u.removed) continue;
    const key = u.x+','+u.y;
    (stackGroups[key] = stackGroups[key] || []).push(u);
  }
  const STACK_OFFSETS = [{dx:-0.15,dy:-0.15,scale:0.72},{dx:0.15,dy:0.15,scale:0.72}];
  for(const key in stackGroups){
    const list = stackGroups[key];
    if(list.length===1){ drawUnit(list[0]); }
    else if(list.length===2 && (list[0].type==='INFANTRY'||list[0].type==='GUARD') && (list[1].type==='INFANTRY'||list[1].type==='GUARD')){
      drawColumnUnitPair(list[0], list[1]);
    }
    else { list.forEach((u,i)=> drawUnit(u, STACK_OFFSETS[i % STACK_OFFSETS.length])); }
  }

  // muzzle smoke: lingers around a gun from the moment it fires until its side's next turn
  for(const u of state.units){
    if(u.removed || !u.smokeActive) continue;
    const vp = getUnitVisualPos(u);
    const cx = vp.x*CELL+CELL/2, cy = sy(vp.y)*CELL+CELL/2;
    ctx.save();
    ctx.fillStyle = '#f4f1e8';
    [[-0.22,-0.30,0.16],[0.10,-0.36,0.13],[0.28,-0.18,0.11]].forEach(([ox,oy,r])=>{
      ctx.globalAlpha = 0.45;
      ctx.beginPath(); ctx.arc(cx+ox*CELL, cy+oy*CELL, r*CELL, 0, Math.PI*2); ctx.fill();
    });
    ctx.restore();
  }

  // death markers: skull holds for a beat, then fades into drifting smoke
  const now = Date.now();
  for(const d of deathEffects){
    const elapsed = now - d.startTime;
    const cx = d.x*CELL+CELL/2, cy = sy(d.y)*CELL+CELL/2;
    if(elapsed < DEATH_SKULL_MS){
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.font = Math.floor(CELL*0.5)+'px sans-serif';
      ctx.fillText('\u{1F480}', cx, cy);
      ctx.restore();
    } else {
      const smokeT = (elapsed - DEATH_SKULL_MS) / DEATH_SMOKE_MS; // 0..1
      const fade = 1 - smokeT;
      ctx.save();
      ctx.fillStyle = '#d8d4c8';
      [[-0.15,-0.1,0.18],[0.15,-0.15,0.15],[0,0.05,0.20]].forEach(([ox,oy,r])=>{
        ctx.globalAlpha = 0.4*fade;
        const drift = smokeT*0.25;
        ctx.beginPath(); ctx.arc(cx+ox*CELL, cy+(oy-drift)*CELL, (r+smokeT*0.15)*CELL, 0, Math.PI*2); ctx.fill();
      });
      ctx.restore();
    }
  }

  // vignette: a soft darkening toward the board's outer edge, so the map reads
  // as a physical object sitting on a table rather than a flat filled rectangle
  const vw = COLS*CELL, vh = ROWS*CELL;
  ctx.fillStyle = getParchmentTexturePattern();
  ctx.fillRect(0, 0, vw, vh);
  const vignette = ctx.createRadialGradient(vw/2, vh/2, Math.min(vw,vh)*0.35, vw/2, vh/2, Math.hypot(vw,vh)*0.62);
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(10,8,4,0.30)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, vw, vh);

  // Kick the animation loop if it isn't already running and British Line
  // Infantry are on the board — draw() itself gets called from plenty of
  // places that aren't already inside that loop (unit selection, menu
  // toggles...), and without this the sprite sheet would only start
  // advancing once some unrelated move/fight animation happened to trigger
  // it first, sitting frozen on frame 0 until then.
  if(!animFrameHandle && state.units.some(u => !u.removed && (UNIT_TYPES[u.type].key==='INFANTRY' || UNIT_TYPES[u.type].key==='GUARD'))){
    ensureAnimationLoopRunning();
  }
}

/* =========================================================
   BATTLE INTRO ANIMATION
   Plays once at the start of a standard (non-campaign) AI-opponent match,
   right when the board first becomes visible — every grid tile drops in
   from above and bounce-settles into place, top-left to bottom-right,
   left-to-right across each row. Cannot be skipped; the caller is expected
   to hold off anything else (the orientation dice roll, in practice) until
   the onComplete callback fires.

   Implementation: rather than threading a per-cell animated offset through
   every existing terrain-drawing pass (grass, hill, road, building, woods,
   craters, road-to-building connectors...), which would mean touching a
   lot of delicate, already-working code — this renders the final board
   exactly once with the normal draw(), captures that as a snapshot, then
   animates cropped per-cell fragments of that snapshot into place. The
   live terrain-rendering pipeline itself is never touched.
========================================================= */
export function playBoardIntroAnimation(onComplete){
  draw(); // render the true final board once, to capture as the source for every tile fragment
  const snapshot = document.createElement('canvas');
  snapshot.width = canvas.width;
  snapshot.height = canvas.height;
  snapshot.getContext('2d').drawImage(canvas, 0, 0);

  const dpr = window.devicePixelRatio || 1;
  const fallDistance = window.innerHeight; // always starts fully off the top of the current viewport, whatever the phone's orientation
  const FALL_MS = 300, BOUNCE1_MS = 150, BOUNCE2_MS = 100, STAGGER_MS = 50;
  const DUST_MS = 200;

  const tiles = [];
  for(let y=0;y<ROWS;y++){
    for(let x=0;x<COLS;x++){
      tiles.push({ x, y, startDelay:(y*COLS+x)*STAGGER_MS, dustSpawned:false });
    }
  }
  const dustParticles = []; // {x, y, startTime}
  const startTime = performance.now();

  function tileOffset(elapsed){
    if(elapsed < 0) return { offset:-fallDistance, phase:'waiting' };
    if(elapsed < FALL_MS){
      const t = elapsed/FALL_MS;
      const eased = 1 - Math.pow(1-t, 2); // ease-out, matching the codebase's existing move-animation easing
      return { offset:-fallDistance*(1-eased), phase:'falling' };
    }
    const b1 = elapsed - FALL_MS;
    if(b1 < BOUNCE1_MS){
      const t = b1/BOUNCE1_MS;
      return { offset:-CELL*0.15*Math.sin(Math.PI*t), phase:'bounce1' };
    }
    const b2 = b1 - BOUNCE1_MS;
    if(b2 < BOUNCE2_MS){
      const t = b2/BOUNCE2_MS;
      return { offset:-CELL*0.05*Math.sin(Math.PI*t), phase:'bounce2' };
    }
    return { offset:0, phase:'settled' };
  }

  function tick(){
    const now = performance.now();
    const elapsedGlobal = now - startTime;
    ctx.clearRect(0, 0, COLS*CELL, ROWS*CELL);

    let allSettled = true;
    for(const tile of tiles){
      const localElapsed = elapsedGlobal - tile.startDelay;
      const { offset, phase } = tileOffset(localElapsed);
      if(phase!=='settled') allSettled = false;
      if(phase!=='waiting'){
        const dx = tile.x*CELL, dy = tile.y*CELL + offset;
        const sx = tile.x*CELL*dpr, sy = tile.y*CELL*dpr;
        ctx.drawImage(snapshot, sx, sy, CELL*dpr, CELL*dpr, dx, dy, CELL, CELL);
      }
      if(!tile.dustSpawned && localElapsed >= FALL_MS){
        tile.dustSpawned = true;
        dustParticles.push({ x: tile.x*CELL+CELL/2, y: (tile.y+1)*CELL, startTime: now });
      }
    }

    let dustActive = false;
    for(let i=dustParticles.length-1; i>=0; i--){
      const p = dustParticles[i];
      const age = now - p.startTime;
      if(age > DUST_MS){ dustParticles.splice(i,1); continue; }
      dustActive = true;
      const t = age/DUST_MS;
      ctx.save();
      ctx.globalAlpha = 0.30*(1-t);
      ctx.fillStyle = '#c9b98a';
      const r = CELL*0.16*(0.4+0.6*t);
      ctx.beginPath(); ctx.ellipse(p.x, p.y, r, r*0.45, 0, 0, Math.PI*2); ctx.fill();
      ctx.restore();
    }

    if(!allSettled || dustActive){
      requestAnimationFrame(tick);
    } else {
      draw(); // one final normal render, guaranteed pixel-identical to live state
      onComplete();
    }
  }
  requestAnimationFrame(tick);
}

