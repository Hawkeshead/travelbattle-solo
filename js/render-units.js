import { CELL, SIDES, SIDE_COLOR, TERRAIN_STYLE, UNIT_TYPES, state } from './data-core.js';
import { GRASS_DETAIL_FILES } from './terrain-v2.js';
import { armyOf } from './group.js';
import { isConcealedFromEnemy } from './engine-rules.js';
import { WOODS_OVERSCAN, ctx, getUnitVisualPos, routProbeSample, toScreen, unitGaitOffset, woodsStyleIndex } from './render-board.js';

export const UNIT_IMAGE_DATA = {
  cannon_red: 'assets/icons/cannon_red.png',
  cannon_blue: 'assets/icons/cannon_blue.png',
  artillery_red: 'assets/icons/artillery_red.png',
  artillery_blue: 'assets/icons/artillery_blue.png',
  cavalry_red: 'assets/icons/cavalry_red.png',
  cavalry_blue: 'assets/icons/cavalry_blue.png',
  infantry_red: 'assets/icons/infantry_red.png',
  infantry_blue: 'assets/icons/infantry_blue.png',
  infantry_line_british_animated: 'assets/icons/infantry_line_british_animated.png',
  infantry_line_french_animated: 'assets/icons/infantry_line_french_animated.png',
  brig_wellington: 'assets/brigadiers/brig_wellington.jpg',
  brig_uxbridge: 'assets/brigadiers/brig_uxbridge.jpg',
  brig_thomasgraham: 'assets/brigadiers/brig_thomasgraham.jpg',
  brig_soult: 'assets/brigadiers/brig_soult.jpg',
  brig_murat: 'assets/brigadiers/brig_murat.jpg',
  brig_napoleon: 'assets/brigadiers/brig_napoleon.jpg',
  forest_notroops_1: 'assets/terrain/forest_notroops_1.png',
  forest_notroops_2: 'assets/terrain/forest_notroops_2.png',
  forest_notroops_3: 'assets/terrain/forest_notroops_3.png',
  forest_notroops_4: 'assets/terrain/forest_notroops_4.png',
  forest_notroops_5: 'assets/terrain/forest_notroops_5.png',
  forest_notroops_6: 'assets/terrain/forest_notroops_6.png',
  forest_british_1: 'assets/terrain/forest_british_1.png',
  forest_british_2: 'assets/terrain/forest_british_2.png',
  forest_british_3: 'assets/terrain/forest_british_3.png',
  forest_british_4: 'assets/terrain/forest_british_4.png',
  forest_british_5: 'assets/terrain/forest_british_5.png',
  forest_british_6: 'assets/terrain/forest_british_6.png',
  forest_french_1: 'assets/terrain/forest_french_1.png',
  forest_french_2: 'assets/terrain/forest_french_2.png',
  forest_french_3: 'assets/terrain/forest_french_3.png',
  forest_french_4: 'assets/terrain/forest_french_4.png',
  forest_french_5: 'assets/terrain/forest_french_5.png',
  forest_french_6: 'assets/terrain/forest_french_6.png',
  grass_1: 'assets/terrain/grass_1.png',
  grass_2: 'assets/terrain/grass_2.png',
  grass_3: 'assets/terrain/grass_3.png',
  grass_4: 'assets/terrain/grass_4.png',
  grass_5: 'assets/terrain/grass_5.png',
  grass_6: 'assets/terrain/grass_6.png',
  hill_1: 'assets/terrain/hill_1.png',
  hill_2: 'assets/terrain/hill_2.png',
  hill_3: 'assets/terrain/hill_3.png',
  hill_4: 'assets/terrain/hill_4.png',
  hill_5: 'assets/terrain/hill_5.png',
  hill_6: 'assets/terrain/hill_6.png',
  road_straight_v: 'assets/terrain/road_straight_v.png',
  road_straight_h: 'assets/terrain/road_straight_h.png',
  road_cross: 'assets/terrain/road_cross.png',
  road_t_missing_up: 'assets/terrain/road_t_missing_up.png',
  road_t_missing_down: 'assets/terrain/road_t_missing_down.png',
  road_t_missing_left: 'assets/terrain/road_t_missing_left.png',
  road_t_missing_right: 'assets/terrain/road_t_missing_right.png',
  road_corner_tr: 'assets/terrain/road_corner_tr.png',
  road_corner_br: 'assets/terrain/road_corner_br.png',
  road_corner_bl: 'assets/terrain/road_corner_bl.png',
  road_corner_tl: 'assets/terrain/road_corner_tl.png',
  road_end_up: 'assets/terrain/road_end_up.png',
  road_end_down: 'assets/terrain/road_end_down.png',
  road_end_left: 'assets/terrain/road_end_left.png',
  road_end_right: 'assets/terrain/road_end_right.png',
  building_1: 'assets/terrain/building_1.png',
  building_2: 'assets/terrain/building_2.png',
  building_3: 'assets/terrain/building_3.png',
  building_4: 'assets/terrain/building_4.png',
  building_5: 'assets/terrain/building_5.png',
  building_6: 'assets/terrain/building_6.png'
};
export const UNIT_IMAGES = {};
export const BRIGADIER_PORTRAIT_KEY = {
  'Wellington': 'brig_wellington',
  'Uxbridge': 'brig_uxbridge',
  'Thomas Graham': 'brig_thomasgraham',
  'Napoleon': 'brig_napoleon',
  'Soult': 'brig_soult',
  'Murat': 'brig_murat',
};
/* Terrain art: only the style in use is downloaded. Under v2 the old per-square
   terrain images (grass, hills, villages, forests, road tiles) are not drawn,
   so they are skipped, and the v2 set (about 17 MB) is preloaded here instead,
   the same way. */
const V1_TERRAIN_KEY = /^(grass_|hill_|building_|forest_|road_)/;
if(TERRAIN_STYLE === 'v2'){
  const add = (key, path) => { UNIT_IMAGE_DATA[key] = path; };
  for(let i = 1; i <= 6; i++) add('v2_grass_' + i, `assets/terrain/v2/grass/grass_${i}.webp`);
  GRASS_DETAIL_FILES.forEach((f, i) => add('v2_detail_' + i, `assets/terrain/v2/grass/detail/${f}.webp`));
  for(let i = 1; i <= 7; i++) add('v2_hill_' + i, `assets/terrain/v2/hill/hill_${i}.webp`);
  for(let i = 1; i <= 4; i++) add('v2_farm_' + i, `assets/terrain/v2/farm/farm_${i}.webp`);
  for(let i = 1; i <= 4; i++) add('v2_woods_' + i, `assets/terrain/v2/woods/woods_${i}.webp`);
  for(let i = 1; i <= 6; i++) add('v2_building_' + i, `assets/terrain/v2/building/building_${i}.webp`);
  add('v2_crater', 'assets/terrain/v2/effects/crater.webp');
}
for(const key in UNIT_IMAGE_DATA){
  if(TERRAIN_STYLE === 'v2' && V1_TERRAIN_KEY.test(key)) continue;
  const img = new Image();
  img.src = UNIT_IMAGE_DATA[key];
  UNIT_IMAGES[key] = img;
}

// Regiment portraits imported from the TravelBattle Hub Archive (Infantry/Guard/Cavalry).
export const REGIMENT_IMAGE_DATA = {
  'b-guard-1': 'assets/portraits/b-guard-1.jpg',
  'b-guard-2': 'assets/portraits/b-guard-2.jpg',
  'b-inf-95rifles': 'assets/portraits/b-inf-95rifles.jpg',
  'b-inf-corsican': 'assets/portraits/b-inf-corsican.jpg',
  'b-inf-44th': 'assets/portraits/b-inf-44th.jpg',
  'b-inf-28th': 'assets/portraits/b-inf-28th.jpg',
  'b-inf-3rdfg': 'assets/portraits/b-inf-3rdfg.jpg',
  'b-inf-brunswick': 'assets/portraits/b-inf-brunswick.jpg',
  'b-hcav-greys': 'assets/portraits/b-hcav-greys.jpg',
  'b-hcav-blues': 'assets/portraits/b-hcav-blues.jpg',
  'b-lcav-10th': 'assets/portraits/b-lcav-10th.jpg',
  'b-lcav-15th': 'assets/portraits/b-lcav-15th.jpg',
  'f-guard-1er': 'assets/portraits/f-guard-1er.jpg',
  'f-guard-2e': 'assets/portraits/f-guard-2e.jpg',
  'f-inf-9elegere': 'assets/portraits/f-inf-9elegere.jpg',
  'f-inf-17elegere': 'assets/portraits/f-inf-17elegere.jpg',
  'f-inf-1erligne': 'assets/portraits/f-inf-1erligne.jpg',
  'f-inf-4eligne': 'assets/portraits/f-inf-4eligne.jpg',
  'f-inf-45eligne': 'assets/portraits/f-inf-45eligne.jpg',
  'f-inf-105eligne': 'assets/portraits/f-inf-105eligne.jpg',
  'f-hcav-cuirassiers': 'assets/portraits/f-hcav-cuirassiers.jpg',
  'f-hcav-carabiniers': 'assets/portraits/f-hcav-carabiniers.jpg',
  'f-lcav-7e': 'assets/portraits/f-lcav-7e.jpg',
  'f-lcav-11e': 'assets/portraits/f-lcav-11e.jpg'
};
for(const key in REGIMENT_IMAGE_DATA){
  const img = new Image();
  img.src = REGIMENT_IMAGE_DATA[key];
  UNIT_IMAGES[key] = img;
}
// Maps a unit's historicalName straight to its Hub Archive portrait id.
export const REGIMENT_PORTRAIT_KEY = {
  '42nd Black Watch': 'b-guard-1',
  '92nd Gordon Highlanders': 'b-guard-2',
  '95th Rifles': 'b-inf-95rifles',
  'Corsican Rangers': 'b-inf-corsican',
  '44th East Essex': 'b-inf-44th',
  '28th North Gloucestershire': 'b-inf-28th',
  '3rd Regiment of Foot Guards': 'b-inf-3rdfg',
  'Brunswick Oels Jägers': 'b-inf-brunswick',
  'Scots Greys': 'b-hcav-greys',
  'Royal Horse Guards – The Blues': 'b-hcav-blues',
  '10th Hussars': 'b-lcav-10th',
  '15th Hussars': 'b-lcav-15th',
  '1er Grenadiers à Pied': 'f-guard-1er',
  '2e Grenadiers à Pied': 'f-guard-2e',
  '9e Légère': 'f-inf-9elegere',
  '17e Légère': 'f-inf-17elegere',
  '1er Ligne': 'f-inf-1erligne',
  '4e Ligne': 'f-inf-4eligne',
  '45e Ligne': 'f-inf-45eligne',
  '105e Ligne': 'f-inf-105eligne',
  '5e Cuirassiers': 'f-hcav-cuirassiers',
  'Carabiniers-à-Cheval': 'f-hcav-carabiniers',
  '7e Hussards': 'f-lcav-7e',
  '11e Hussards': 'f-lcav-11e',
};

/* The artwork for a unit, resolved once so the selection panel and the fight
   panel can never drift apart. Order matters and is the panel's existing order:
   a Brigadier's own portrait, then the cannon icon for artillery (which have no
   regimental artwork), then the regimental portrait, then a glyph.

   Returns markup rather than a URL because the artillery case sizes differently
   (the cannon is a wide icon, the portraits are square crops) and the fallback
   is text, not an image at all. */
export function unitPortraitHTML(u){
  const t = UNIT_TYPES[u.type];
  if(t.key==='BRIGADIER' && BRIGADIER_PORTRAIT_KEY[u.historicalName]){
    return `<img src="${UNIT_IMAGE_DATA[BRIGADIER_PORTRAIT_KEY[u.historicalName]]}" class="portrait-img">`;
  }
  if(t.isArtillery){
    return `<img src="${UNIT_IMAGE_DATA[u.side===SIDES.RED?'cannon_red':'cannon_blue']}" class="portrait-icon">`;
  }
  if(REGIMENT_PORTRAIT_KEY[u.historicalName]){
    return `<img src="${REGIMENT_IMAGE_DATA[REGIMENT_PORTRAIT_KEY[u.historicalName]]}" class="portrait-img">`;
  }
  const glyph = (t.key==='HEAVY_CAV'||t.key==='LIGHT_CAV') ? '\u25B2\u25B2\u25B2'
    : (t.key==='BRIGADIER' ? '\u2605' : '\u25CF\u25CF\u25CF\u25CF\u25CF');
  return `<span class="portrait-glyph" style="color:${SIDE_COLOR[u.side]};">${glyph}</span>`;
}



// Small gold asterisk badge, positioned in a unit's corner — marks Guard Infantry
// and Heavy Cavalry as the "upgraded" tier, replacing the old ring/reroll-star convention.
export function drawGoldAsterisk(size, ox, oy){
  ctx.save();
  ctx.translate(ox, oy);
  ctx.strokeStyle = '#c9a227';
  ctx.lineWidth = Math.max(1.4, size*0.045);
  ctx.lineCap = 'round';
  const r = size*0.13;
  for(let i=0;i<3;i++){
    const a = (i/3)*Math.PI;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a)*r, Math.sin(a)*r);
    ctx.lineTo(-Math.cos(a)*r, -Math.sin(a)*r);
    ctx.stroke();
  }
  ctx.restore();
}

// 10 men, 2 ranks of 5 — the standard Infantry/Guard footprint.
export function drawInfantryDots(size){
  size *= 1.4; // enlarged for legibility
  const dotR = size*0.062, spX = size*0.155, spY = size*0.20;
  for(let row=0; row<2; row++) for(let col=0; col<5; col++){
    const dx=(col-2)*spX, dy=(row-0.5)*spY;
    ctx.beginPath(); ctx.arc(dx,dy,dotR,0,Math.PI*2); ctx.fill(); ctx.stroke();
  }
}
// Square formation fallback (used only while the Infantry image is still
// decoding): same 10 men arranged into a square perimeter. Rotation is
// applied by the caller, not here, so it stays correct whichever path draws.
export function drawInfantrySquareDots(size){
  size *= 1.4; // enlarged for legibility
  const dotR = size*0.062, half = size*0.25;
  const pos = [];
  for(let i=0;i<4;i++) pos.push([-half + i*(half*2/3), -half]);
  for(let i=0;i<4;i++) pos.push([-half + i*(half*2/3), half]);
  pos.push([-half,0]); pos.push([half,0]);
  pos.forEach(([dx,dy])=>{
    ctx.beginPath(); ctx.arc(dx,dy,dotR,0,Math.PI*2); ctx.fill(); ctx.stroke();
  });
}
// Attack Column: 20 men, 4 ranks of 5 — two Infantry/Guard units fighting as one mass.
export function drawColumnDots(size){
  size *= 1.4; // enlarged for legibility
  const dotR = size*0.052, spX = size*0.15, spY = size*0.15;
  for(let row=0; row<4; row++) for(let col=0; col<5; col++){
    const dx=(col-2)*spX, dy=(row-1.5)*spY;
    ctx.beginPath(); ctx.arc(dx,dy,dotR,0,Math.PI*2); ctx.fill(); ctx.stroke();
  }
}
// Cavalry: 3 chevrons, one per horseman in the unit.
export function drawCavalryChevrons(size){
  size *= 1.4; // enlarged for legibility
  const chevR = size*0.15;
  const pts = [[-size*0.20,size*0.05],[size*0.20,size*0.05],[0,-size*0.20]];
  pts.forEach(([dx,dy])=>{
    ctx.save(); ctx.translate(dx,dy);
    ctx.beginPath();
    ctx.moveTo(0,-chevR); ctx.lineTo(chevR*0.85,chevR*0.7); ctx.lineTo(0,chevR*0.25); ctx.lineTo(-chevR*0.85,chevR*0.7);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
  });
}
/* SECOND ARMIES (Group, 2v2). Until they have art of their own, each side's
   second army is its first army's figures with the coats recoloured: the
   saturated red of the British coats turned green, the French blue turned
   violet. Done once per image, on a canvas, the first time it is needed, and
   only the strongly coloured pixels move, so faces, horses, metal and the
   ground under the figures keep their own colours. drawUnit sets UNIT_SKIN for
   the unit being drawn and puts it back afterwards. */
let UNIT_SKIN = 1;
export function setUnitSkin(n){ UNIT_SKIN = n || 1; }
const SKIN_CACHE = {};
const SKIN_RULES = {
  red:  { match: h => h >= 340 || h <= 14, to: 128 },
  blue: { match: h => h >= 195 && h <= 250, to: 282 },
};
function skinnedImage(key){
  const img = UNIT_IMAGES[key];
  if(UNIT_SKIN !== 2 || !(img && img.complete && img.naturalWidth>0)) return img;
  if(SKIN_CACHE[key]) return SKIN_CACHE[key];
  const rule = /british|_red/.test(key) ? SKIN_RULES.red : /french|_blue/.test(key) ? SKIN_RULES.blue : null;
  if(!rule) return img;
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  try {
    const data = g.getImageData(0, 0, c.width, c.height), d = data.data;
    for(let i=0; i<d.length; i+=4){
      if(d[i+3] < 8) continue;
      const r = d[i]/255, gg = d[i+1]/255, b = d[i+2]/255;
      const max = Math.max(r,gg,b), min = Math.min(r,gg,b), delta = max-min;
      if(max < 0.12 || delta/max < 0.35) continue;          // dark or greyish: leave alone
      let h = max===r ? 60*(((gg-b)/delta)%6) : max===gg ? 60*((b-r)/delta+2) : 60*((r-gg)/delta+4);
      if(h < 0) h += 360;
      if(!rule.match(h)) continue;
      const s = delta/max, v = max, hh = rule.to/60, f = hh - Math.floor(hh);
      const p = v*(1-s), q = v*(1-s*f), t = v*(1-s*(1-f));
      const [R,G,B] = [[v,t,p],[q,v,p],[p,v,t],[p,q,v],[t,p,v],[v,p,q]][Math.floor(hh)%6];
      d[i] = R*255; d[i+1] = G*255; d[i+2] = B*255;
    }
    g.putImageData(data, 0, 0);
  } catch { return img; }   // a tainted canvas (never expected for our own assets) keeps the original look
  c.complete = true; c.naturalWidth = c.width; c.naturalHeight = c.height;
  SKIN_CACHE[key] = c;
  return c;
}

export const CANNON_SILHOUETTE_CACHE = {};
// Builds (and caches) a solid-white silhouette of a cannon image, used to paint a thin
// outline around it — the PNG has transparency so a normal stroke() has nothing to grab.
export function getCannonSilhouette(img, key){
  const cached = CANNON_SILHOUETTE_CACHE[key];
  if(cached && cached.width===img.naturalWidth) return cached;
  const off = document.createElement('canvas');
  off.width = img.naturalWidth; off.height = img.naturalHeight;
  const octx = off.getContext('2d');
  octx.drawImage(img, 0, 0);
  octx.globalCompositeOperation = 'source-in';
  octx.fillStyle = '#ffffff';
  octx.fillRect(0, 0, off.width, off.height);
  CANNON_SILHOUETTE_CACHE[key] = off;
  return off;
}
// Shared draw routine for every image-backed board icon (artillery crew,
// cavalry, infantry). sizeRatio lets a taller (portrait-oriented cavalry
// crop) or wider (cannon) source scale sensibly against the common cell size.
function drawSilhouetteIconImage(size, key, sizeRatio){
  const img = skinnedImage(key);
  if(img && img.complete && img.naturalWidth>0){
    const h = size*sizeRatio, w = h*(img.naturalWidth/img.naturalHeight);
    ctx.drawImage(img, -w/2, -h/2, w, h);
    return true;
  }
  return false;
}
// Bottom-anchored variant for the side-profile depth art (cavalry, artillery):
// width is capped at one full cell so there's never horizontal or downward
// bleed into a neighbouring square, but height can run up to 1.3 cells,
// anchored to the cell's bottom edge so all of the extra height bleeds
// upward into the square above — never sideways, never down — suggesting the
// standing/mounted figure's real height on a top-down board.
function drawBottomAnchoredImage(cellSize, key, maxHeightRatio, overscan){
  const img = skinnedImage(key);
  if(!(img && img.complete && img.naturalWidth>0)) return false;
  const aspect = img.naturalWidth/img.naturalHeight;
  // overscan (default 1, i.e. unchanged) lets Woods draw past its cell so the
  // treetops overhang the tile above; cavalry and artillery keep 1.
  const k = overscan || 1;
  let w = cellSize*k, h = w/aspect;
  const maxH = cellSize*maxHeightRatio*k;
  if(h>maxH){ h = maxH; w = h*aspect; }
  ctx.drawImage(img, -w/2, cellSize/2-h, w, h);
  return true;
}
export function drawArtilleryImage(size, side){
  const key = side===SIDES.RED ? 'artillery_red' : 'artillery_blue';
  if(!drawBottomAnchoredImage(CELL, key, 1.3)){
    // fallback while the image decodes
    ctx.beginPath(); ctx.moveTo(0,-size*0.35); ctx.lineTo(size*0.35,0); ctx.lineTo(0,size*0.35); ctx.lineTo(-size*0.35,0);
    ctx.closePath(); ctx.fill(); ctx.stroke();
  }
}
// One shared side-profile image for both Heavy and Light Cavalry now — the
// gold asterisk (drawn separately, unchanged) is what actually distinguishes
// Heavy from Light on the board, not a different crop.
export function drawCavalryImage(size, side){
  const key = side===SIDES.RED ? 'cavalry_red' : 'cavalry_blue';
  if(!drawBottomAnchoredImage(CELL, key, 1.3)){
    drawCavalryChevrons(size); // fallback while the image decodes
  }
}
// Ten figures in the same footprint as cavalry's two or three means Infantry
// needs more of the cell than the sizeRatio used elsewhere — a touch of edge
// bleed reads better than a crisp inset icon that's too small to read at all.
export function drawInfantryImage(size, side){
  const key = side===SIDES.RED ? 'infantry_red' : 'infantry_blue';
  return drawSilhouetteIconImage(size, key, 1.08);
}
// Animated Line Infantry sprites, one per side. Canvas drawImage() never
// animates a GIF on its own — this is the workaround: the GIF's frames are
// pre-extracted into a single horizontal sprite sheet at build time, and
// the current frame is sliced out by shifting the source rectangle each
// call, cycled by wall-clock time so it loops continuously rather than
// freezing on whichever frame happened to be current at the last redraw.
// Each side's GIF was authored separately, so frame count and pace differ
// per side and are tracked here rather than hardcoded. render-board.js
// keeps the animation loop alive for as long as a unit needing this exists
// on the board (see ensureAnimationLoopRunning), otherwise it would only
// advance when some other animation (a move, a fight) happened to trigger
// a redraw anyway.
const LINE_INFANTRY_SPRITES = {
  [SIDES.RED]:  { key:'infantry_line_british_animated', frames:6, frameMs:180 },
  [SIDES.BLUE]: { key:'infantry_line_french_animated',  frames:4, frameMs:220 },
};
export function drawLineInfantryImage(size, side){
  const spec = LINE_INFANTRY_SPRITES[side];
  if(!spec) return false;
  const img = skinnedImage(spec.key);
  if(!(img && img.complete && img.naturalWidth>0)) return false;
  const frameW = img.naturalWidth / spec.frames;
  const frameH = img.naturalHeight;
  const frame = Math.floor(Date.now() / spec.frameMs) % spec.frames;
  // 1.62 = the original 1.08 scaled up 50%. Infantry deliberately overflow
  // their cell — the models are narrow enough that the overlap reads as
  // depth rather than clutter, and the extra size makes them legible at
  // phone-sized cells. Every infantry presentation (open order, Square,
  // both ranks of an Attack Column) routes through here, so they all scale
  // together from this one number.
  const h = size*1.62, w = h*(frameW/frameH);
  ctx.drawImage(img, frame*frameW, 0, frameW, frameH, -w/2, -h/2, w, h);
  return true;
}
// A unit actually standing in a Woods cell swaps to that exact cell's
// troops-hidden Forest tile (same style index the background terrain layer
// picked for that cell — see woodsStyleIndex) rather than its normal icon,
// bottom-anchored the same way the plain terrain tile is.
function drawWoodsHiddenImage(cellSize, side, x, y){
  const style = woodsStyleIndex(x, y);
  const key = (side===SIDES.RED ? 'forest_british_' : 'forest_french_') + style;
  return drawBottomAnchoredImage(cellSize, key, 1.3, WOODS_OVERSCAN);
}
export function drawCannonImage(size, side){
  const key = side===SIDES.RED ? 'cannon_red' : 'cannon_blue';
  const img = skinnedImage(key);
  if(img && img.complete && img.naturalWidth>0){
    const h = size*0.95*0.85, w = h*(img.naturalWidth/img.naturalHeight); // 15% smaller
    const silhouette = getCannonSilhouette(img, key);
    const outlinePx = Math.max(1, size*0.02);
    const offsets = [[-1,0],[1,0],[0,-1],[0,1],[-0.7,-0.7],[0.7,-0.7],[-0.7,0.7],[0.7,0.7]];
    offsets.forEach(([ox,oy])=>{
      ctx.drawImage(silhouette, -w/2+ox*outlinePx, -h/2+oy*outlinePx, w, h);
    });
    ctx.drawImage(img, -w/2, -h/2, w, h);
  } else {
    // fallback while the image decodes (rare — local base64 data URIs resolve almost immediately)
    ctx.beginPath(); ctx.moveTo(0,-size*0.35); ctx.lineTo(size*0.35,0); ctx.lineTo(0,size*0.35); ctx.lineTo(-size*0.35,0);
    ctx.closePath(); ctx.fill(); ctx.stroke();
  }
}
export function drawBrigadierPortrait(size, u, isSel){
  const key = BRIGADIER_PORTRAIT_KEY[u.historicalName];
  const img = key ? UNIT_IMAGES[key] : null;
  if(img && img.complete && img.naturalWidth>0){
    const s = size*0.92, r = s*0.12;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(-s/2+r,-s/2); ctx.arcTo(s/2,-s/2,s/2,s/2,r); ctx.arcTo(s/2,s/2,-s/2,s/2,r);
    ctx.arcTo(-s/2,s/2,-s/2,-s/2,r); ctx.arcTo(-s/2,-s/2,s/2,-s/2,r); ctx.closePath();
    ctx.clip();
    ctx.drawImage(img, -s/2,-s/2,s,s);
    ctx.restore();
    if(isSel){
      ctx.strokeStyle = '#f4e9c9'; ctx.lineWidth = Math.max(2, size*0.09);
      ctx.beginPath();
      ctx.moveTo(-s/2+r,-s/2); ctx.arcTo(s/2,-s/2,s/2,s/2,r); ctx.arcTo(s/2,s/2,-s/2,s/2,r);
      ctx.arcTo(-s/2,s/2,-s/2,-s/2,r); ctx.arcTo(-s/2,-s/2,s/2,-s/2,r); ctx.closePath();
      ctx.stroke();
    }
    ctx.strokeStyle = u.side===SIDES.RED ? '#b9c2c9' : '#c9a227'; ctx.lineWidth = Math.max(1.5, size*0.05);
    ctx.beginPath();
    ctx.moveTo(-s/2+r,-s/2); ctx.arcTo(s/2,-s/2,s/2,s/2,r); ctx.arcTo(s/2,s/2,-s/2,s/2,r);
    ctx.arcTo(-s/2,s/2,-s/2,-s/2,r); ctx.arcTo(-s/2,-s/2,s/2,-s/2,r); ctx.closePath();
    ctx.stroke();
    return true; // portrait drawn
  }
  return false; // no match or not yet loaded — caller falls back to the star
}

const skinFor = u => (state.group && armyOf(u) && armyOf(u).skin === 2) ? 2 : 1;
export function drawUnit(u, off){
  setUnitSkin(skinFor(u));
  try { drawUnitInner(u, off); } finally { setUnitSkin(1); }
}
function drawUnitInner(u, off){
  off = off || {dx:0, dy:0, scale:1};
  const vp = getUnitVisualPos(u);
  // Gait added here rather than inside getUnitVisualPos, because that value also
  // feeds the depth sort and a bobbing sort key would flicker against terrain.
  const sp = toScreen(vp.x, vp.y);
  const cx = sp.x*CELL+CELL/2 + off.dx*CELL,
        cy = (sp.y + unitGaitOffset(u))*CELL + CELL/2 + off.dy*CELL;
  // Sampled here, at the exact coordinates the unit is about to be drawn at, so
  // the probe records what the renderer saw rather than what it was told.
  routProbeSample(u, vp, cx, cy);
  const t = UNIT_TYPES[u.type];
  const isSel = state.selectedUnitId===u.id;
  const col = (state.group && armyOf(u)) ? armyOf(u).color : SIDE_COLOR[u.side];
  const size = CELL*0.62*off.scale; // common scale basis for the new marker drawing functions
  const r = CELL*0.30*off.scale;    // legacy radius, still used by the Brigadier star fallback

  /* CONCEALMENT IS ALL-OR-NOTHING NOW.
  
     A unit in woods used to be redrawn as a troops-hidden forest tile. That was
     meant to read as "tucked into the trees", but in play it reads as the unit
     turning into a bush: your own infantry appear to vanish and be replaced by
     scenery, which is worse than either showing them or not.
  
     Your own units now always draw as themselves, in woods or out. A concealed
     ENEMY unit is not drawn at all, which is what concealment actually means:
     the woods tile is already there, so the square simply looks like empty
     woods, exactly as it should to someone who cannot see into it.
  
     Only applied against the AI, since in a shared-screen game hiding one
     side's units from the other would make the game unplayable. */
  const concealed = isConcealedFromEnemy(u);
  if(concealed && state.mode==='ai' && u.side===state.aiSide) return;
  const inWoodsHiding = false;   // retained below; the tile swap is gone
  // Only Infantry/Guard can ever be on Woods terrain (terrain restriction),
  // so "concealed" in practice always means exactly this case. Rather than
  // dimming the normal icon, swap to the matching side's troops-hidden
  // Forest tile — same tile the background already shows, so the unit reads
  // as genuinely tucked into that specific stand of trees. Square formation
  // keeps its own dedicated treatment even while in woods (rare, but a real
  // tactical state that shouldn't quietly disappear into the tree art).
  // (old tile-swap flag removed; see the note above)

  // Brigadier: portrait photo instead of a drawn shape (falls back to the star below if unmatched).
  if(t.key==='BRIGADIER'){
    ctx.save();
    ctx.translate(cx,cy);
    ctx.globalAlpha = concealed ? 0.55 : 1;
    const drew = drawBrigadierPortrait(size, u, isSel);
    ctx.globalAlpha = 1;
    ctx.restore();
    if(drew) return;
    // fall through to the star shape below if no portrait was available
  }

  // Infantry/Guard/Cavalry always use the dots/chevrons on the board — regiment
  // portraits are shown only in the unit overlay panel (see unitPortrait rendering
  // below), not here. Kept that way deliberately: the historical portraits are a
  // nice touch on selection, but on the board the dot/chevron silhouette is what
  // actually reads at a glance, especially once units are stacked or mid-formation.

  ctx.save();
  ctx.translate(cx,cy);
  ctx.globalAlpha = 1;   // own units in cover stay fully legible; the dashed outline is the cue
  ctx.fillStyle = col;
  ctx.strokeStyle = isSel ? '#f4e9c9' : 'rgba(0,0,0,0.4)';
  ctx.lineWidth = isSel ? 3 : 1.5;
  if(concealed && !inWoodsHiding) ctx.setLineDash([3,2]);

  if(inWoodsHiding){
    if(!drawWoodsHiddenImage(CELL, u.side, u.x, u.y)) drawInfantryDots(size); // fallback while the image decodes
  } else if((t.key==='INFANTRY' || t.key==='GUARD') && u.formation!=='square'){
    // Line Infantry and Guard, both sides, use the animated sprite — the gold
    // asterisk (drawn separately below) is what distinguishes Guard, not a
    // different image.
    if(!drawLineInfantryImage(size, u.side)) drawInfantryDots(size); // fallback while the image decodes
  } else if(t.key==='INFANTRY' || t.key==='GUARD'){
    // Square formation: same animated sprite, rotated 45° so the tactical
    // state still reads at a glance rather than looking identical to a
    // normal line. Rotated anticlockwise, for both armies.
    ctx.save();
    ctx.rotate(-Math.PI/4);   // anticlockwise, both armies
    if(!drawLineInfantryImage(size, u.side)) drawInfantrySquareDots(size);
    ctx.restore();
  } else if(t.key==='HEAVY_CAV' || t.key==='LIGHT_CAV'){
    drawCavalryImage(size, u.side);
  } else if(t.isArtillery){
    drawArtilleryImage(size, u.side);
  } else if(t.key==='BRIGADIER'){
    // star fallback (no historical portrait match)
    ctx.beginPath();
    for(let i=0;i<5;i++){
      const ang = -Math.PI/2 + i*(2*Math.PI/5);
      const ang2 = ang + Math.PI/5;
      ctx.lineTo(Math.cos(ang)*r, Math.sin(ang)*r);
      ctx.lineTo(Math.cos(ang2)*r*0.45, Math.sin(ang2)*r*0.45);
    }
    ctx.closePath(); ctx.fill(); ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.restore();

  // Guard / Heavy Cavalry tier marker — gold asterisk in the corner
  if((t.key==='GUARD') || (t.key==='HEAVY_CAV')){
    drawGoldAsterisk(size, cx + size*0.36, cy - size*0.34);
  }

  // status pip: turned-around indicator, kept clear of the guard/heavy asterisk corner
  if(u.turnOnly){
    ctx.fillStyle = '#c9a24a';
    ctx.beginPath(); ctx.arc(cx-size*0.36, cy-size*0.34, 5, 0, Math.PI*2); ctx.fill();
  }
}

// Attack Column: two Infantry/Guard units sharing a square. Drawn as the same
// Infantry art twice — a slightly larger copy set back and to the right
// suggesting a second rank behind the first, rather than the old abstracted
// 20-dot mass.
export function drawColumnUnitPair(u1, u2){
  setUnitSkin(skinFor(u1));
  try { drawColumnUnitPairInner(u1, u2); } finally { setUnitSkin(1); }
}
function drawColumnUnitPairInner(u1, u2){
  const vp = getUnitVisualPos(u1);
  const sp = toScreen(vp.x, vp.y);
  const cx = sp.x*CELL+CELL/2, cy = sp.y*CELL+CELL/2;
  const isSel = state.selectedUnitId===u1.id || state.selectedUnitId===u2.id;
  const side = u1.side;
  const size = CELL*0.62;
  /* NO CONCEALMENT BRANCH HERE, and the comment that used to justify one was
     wrong in a way worth recording.

     It read: "Woods doesn't allow two units sharing a square (allowDouble:
     false), so this is unreachable in practice". That is true of the TERRAIN
     half of isConcealedFromEnemy, but the function also returns true for
     unit.hidden, and a hidden unit can stand on a road, where doubling is
     perfectly legal. So the branch was reachable, and a Column formed by units
     that had just left an ambush drew as a woods tile instead of infantry.

     Concealment for the single-unit path was already reduced to all-or-nothing
     (own units draw as themselves, concealed enemies are not drawn at all); this
     brings the pair into line. Enemy concealment is handled by the caller, which
     does not group units it is not drawing. */

  ctx.save();
  ctx.translate(cx,cy);
  ctx.globalAlpha = 1;

  // Layered depth of rank: a slightly larger copy set back and to the right for
  // the rear rank, then the front rank drawn over it.
  ctx.save();
  ctx.translate(size*0.15, -size*0.15);
  if(!drawLineInfantryImage(size*1.15, side)) drawInfantryDots(size*1.15);
  ctx.restore();

  if(!drawLineInfantryImage(size, side)) drawInfantryDots(size);

  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.restore();

  if(isSel){
    ctx.save();
    ctx.translate(cx,cy);
    ctx.strokeStyle = '#f4e9c9';
    ctx.lineWidth = 3;
    ctx.strokeRect(-size*0.7, -size*0.7, size*1.4, size*1.4);
    ctx.restore();
  }

  if(u1.type==='GUARD' || u2.type==='GUARD'){
    drawGoldAsterisk(size, cx + size*0.5, cy - size*0.5);
  }
  if(u1.turnOnly || u2.turnOnly){
    ctx.fillStyle = '#c9a24a';
    ctx.beginPath(); ctx.arc(cx-size*0.5, cy-size*0.5, 5, 0, Math.PI*2); ctx.fill();
  }
}

// Selection highlights. Written from ui-battle.js, engine-state.js and
// replay.js, so the write goes through a function rather than reassigning the
// binding from another file — an imported binding is read-only under ES
// modules and a cross-file `highlightCells = ...` would throw.
export let highlightCells = [];

export function setHighlightCells(cells){
  highlightCells = cells;
}

