import { CELL, SIDES, SIDE_COLOR, UNIT_TYPES, state } from './data-core.js';
import { isConcealedFromEnemy } from './engine-rules.js';
import { ctx, getUnitVisualPos, sy } from './render-board.js';

export const UNIT_IMAGE_DATA = {
  cannon_red: 'assets/icons/cannon_red.png',
  cannon_blue: 'assets/icons/cannon_blue.png',
  brig_wellington: 'assets/brigadiers/brig_wellington.jpg',
  brig_uxbridge: 'assets/brigadiers/brig_uxbridge.jpg',
  brig_thomasgraham: 'assets/brigadiers/brig_thomasgraham.jpg',
  brig_soult: 'assets/brigadiers/brig_soult.jpg',
  brig_murat: 'assets/brigadiers/brig_murat.jpg',
  brig_napoleon: 'assets/brigadiers/brig_napoleon.jpg'
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
// Square formation: the same 10 men, rearranged into an actual square perimeter.
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
  ctx.globalAlpha = concealed ? 0.55 : 1;
  ctx.fillStyle = col;
  ctx.strokeStyle = isSel ? '#f4e9c9' : 'rgba(0,0,0,0.4)';
  ctx.lineWidth = isSel ? 3 : 1.5;
  if(concealed) ctx.setLineDash([3,2]);

  if(t.key==='INFANTRY' || t.key==='GUARD'){
    if(u.formation==='square') drawInfantrySquareDots(size);
    else drawInfantryDots(size);
  } else if(t.key==='HEAVY_CAV' || t.key==='LIGHT_CAV'){
    drawCavalryChevrons(size);
  } else if(t.isArtillery){
    drawCannonImage(size, u.side);
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

// Attack Column: two Infantry/Guard units sharing a square, drawn as a single
// combined 20-man mass (4 ranks of 5) rather than two overlapping icons.
export function drawColumnUnitPair(u1, u2){
  const vp = getUnitVisualPos(u1);
  const cx = vp.x*CELL+CELL/2, cy = sy(vp.y)*CELL+CELL/2;
  const isSel = state.selectedUnitId===u1.id || state.selectedUnitId===u2.id;
  const col = SIDE_COLOR[u1.side];
  const size = CELL*0.66;
  const concealed = isConcealedFromEnemy(u1) || isConcealedFromEnemy(u2);

  ctx.save();
  ctx.translate(cx,cy);
  ctx.globalAlpha = concealed ? 0.55 : 1;
  ctx.fillStyle = col;
  ctx.strokeStyle = isSel ? '#f4e9c9' : 'rgba(0,0,0,0.4)';
  ctx.lineWidth = isSel ? 3 : 1.5;
  if(concealed) ctx.setLineDash([3,2]);
  drawColumnDots(size);
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.restore();

  if(u1.type==='GUARD' || u2.type==='GUARD'){
    drawGoldAsterisk(size, cx + size*0.34, cy - size*0.36);
  }
  if(u1.turnOnly || u2.turnOnly){
    ctx.fillStyle = '#c9a24a';
    ctx.beginPath(); ctx.arc(cx-size*0.34, cy-size*0.36, 5, 0, Math.PI*2); ctx.fill();
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

