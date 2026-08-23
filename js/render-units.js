import { CELL, SIDES, SIDE_COLOR, UNIT_TYPES, state } from './data-core.js';
import { isConcealedFromEnemy } from './engine-rules.js';
import { ctx, getUnitVisualPos, sy, woodsStyleIndex } from './render-board.js';

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
for(const key in UNIT_IMAGE_DATA){
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
  const img = UNIT_IMAGES[key];
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
function drawBottomAnchoredImage(cellSize, key, maxHeightRatio){
  const img = UNIT_IMAGES[key];
  if(!(img && img.complete && img.naturalWidth>0)) return false;
  const aspect = img.naturalWidth/img.naturalHeight;
  let w = cellSize, h = w/aspect;
  const maxH = cellSize*maxHeightRatio;
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
// British Line Infantry only (not Guard, not French) — an animated sprite
// sheet built from a 6-frame GIF, cycled by wall-clock time at the GIF's own
// 180ms-per-frame pace so it loops continuously rather than freezing on
// whichever frame happened to be current at the last redraw. Canvas
// drawImage() never animates a GIF on its own — this is the workaround:
// frames pre-extracted into one PNG at build time, sliced out by shifting
// the source rectangle each call. render-board.js keeps the animation loop
// alive for as long as a unit needing this exists on the board (see
// ensureAnimationLoopRunning), otherwise it would only advance when some
// other animation (a move, a fight) happened to trigger a redraw anyway.
const BRITISH_LINE_INFANTRY_FRAME_COUNT = 6;
const BRITISH_LINE_INFANTRY_FRAME_MS = 180;
export function drawBritishLineInfantryImage(size){
  const img = UNIT_IMAGES['infantry_line_british_animated'];
  if(!(img && img.complete && img.naturalWidth>0)) return false;
  const frameW = img.naturalWidth / BRITISH_LINE_INFANTRY_FRAME_COUNT;
  const frameH = img.naturalHeight;
  const frame = Math.floor(Date.now() / BRITISH_LINE_INFANTRY_FRAME_MS) % BRITISH_LINE_INFANTRY_FRAME_COUNT;
  const h = size*1.08, w = h*(frameW/frameH);
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
  return drawBottomAnchoredImage(cellSize, key, 1.3);
}
export function drawCannonImage(size, side){
  const key = side===SIDES.RED ? 'cannon_red' : 'cannon_blue';
  const img = UNIT_IMAGES[key];
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

export function drawUnit(u, off){
  off = off || {dx:0, dy:0, scale:1};
  const vp = getUnitVisualPos(u);
  const cx = vp.x*CELL+CELL/2 + off.dx*CELL, cy = sy(vp.y)*CELL+CELL/2 + off.dy*CELL;
  const t = UNIT_TYPES[u.type];
  const isSel = state.selectedUnitId===u.id;
  const col = SIDE_COLOR[u.side];
  const size = CELL*0.62*off.scale; // common scale basis for the new marker drawing functions
  const r = CELL*0.30*off.scale;    // legacy radius, still used by the Brigadier star fallback

  const concealed = isConcealedFromEnemy(u);
  // Only Infantry/Guard can ever be on Woods terrain (terrain restriction),
  // so "concealed" in practice always means exactly this case. Rather than
  // dimming the normal icon, swap to the matching side's troops-hidden
  // Forest tile — same tile the background already shows, so the unit reads
  // as genuinely tucked into that specific stand of trees. Square formation
  // keeps its own dedicated treatment even while in woods (rare, but a real
  // tactical state that shouldn't quietly disappear into the tree art).
  const inWoodsHiding = concealed && (t.key==='INFANTRY' || t.key==='GUARD') && u.formation!=='square';

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
  ctx.globalAlpha = (concealed && !inWoodsHiding) ? 0.55 : 1;
  ctx.fillStyle = col;
  ctx.strokeStyle = isSel ? '#f4e9c9' : 'rgba(0,0,0,0.4)';
  ctx.lineWidth = isSel ? 3 : 1.5;
  if(concealed && !inWoodsHiding) ctx.setLineDash([3,2]);

  if(inWoodsHiding){
    if(!drawWoodsHiddenImage(CELL, u.side, u.x, u.y)) drawInfantryDots(size); // fallback while the image decodes
  } else if((t.key==='INFANTRY' || t.key==='GUARD') && u.side===SIDES.RED && u.formation!=='square'){
    // British Line Infantry and Guard both use the animated sprite now —
    // the gold asterisk (drawn separately below) is what distinguishes
    // Guard, not a different image. French Infantry/Guard keep the
    // existing static art below, untouched.
    if(!drawBritishLineInfantryImage(size)) drawInfantryDots(size); // fallback while the image decodes
  } else if((t.key==='INFANTRY' || t.key==='GUARD') && u.formation!=='square'){
    if(!drawInfantryImage(size, u.side)) drawInfantryDots(size); // fallback while the image decodes
  } else if(t.key==='INFANTRY' || t.key==='GUARD'){
    // Square formation still stays visually distinct from open-order Infantry —
    // real art now instead of dots, but rotated 45° so the tactical state
    // (formed square) still reads at a glance rather than looking identical
    // to a normal line. Kept on the static art even for British Line Infantry —
    // the animated flag-and-drummer scene isn't composed to read sensibly
    // rotated, and Square already has its own dedicated visual language.
    ctx.save();
    ctx.rotate(Math.PI/4);
    if(!drawInfantryImage(size, u.side)) drawInfantrySquareDots(size);
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
  const vp = getUnitVisualPos(u1);
  const cx = vp.x*CELL+CELL/2, cy = sy(vp.y)*CELL+CELL/2;
  const isSel = state.selectedUnitId===u1.id || state.selectedUnitId===u2.id;
  const side = u1.side;
  const size = CELL*0.62;
  const concealed = isConcealedFromEnemy(u1) || isConcealedFromEnemy(u2);
  // Woods doesn't allow two units sharing a square (allowDouble: false), so
  // this is unreachable in practice — handled anyway for safety, matching
  // the single-unit swap in drawUnit.

  ctx.save();
  ctx.translate(cx,cy);
  ctx.globalAlpha = 1;

  if(concealed){
    if(!drawWoodsHiddenImage(CELL, side, u1.x, u1.y)) drawInfantryDots(size);
  } else {
    ctx.save();
    ctx.translate(size*0.15, -size*0.15);
    if(!drawInfantryImage(size*1.15, side)) drawInfantryDots(size*1.15);
    ctx.restore();

    if(!drawInfantryImage(size, side)) drawInfantryDots(size);
  }

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

