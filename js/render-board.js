/* =========================================================
   RENDERING
========================================================= */
// You always sit behind your own troops on screen, regardless of which
// side you're playing. Purely a rendering/input transform — internal
// board coordinates, movement, LOS, and board rotation are untouched.
// Self-inverse (flipping twice returns the original), so the same
// function converts board->screen and screen->board.
function screenFlipActive(){
  return state.mode==='ai' && state.aiSide===SIDES.RED; // human is playing France (Blue), whose zone is internally "top"
}
function sy(y){
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
let unitAnimations = {}; // unitId -> {fromX, fromY, toX, toY, startTime, duration}
let activeActionLine = null; // {fromX, fromY, toX, toY, color, expiresAt} — who's firing/fighting whom
let deathEffects = []; // {x, y, startTime} — skull for 2s, then smoke fades over another 2s
let animFrameHandle = null;

const DEATH_SKULL_MS = 2000, DEATH_SMOKE_MS = 2000;
function addDeathEffect(x, y){
  deathEffects.push({x, y, startTime: Date.now()});
  ensureAnimationLoopRunning();
}
function addCrater(x, y){
  if(state.craters.some(c=>c.x===x && c.y===y)) return; // already scarred, don't stack markers
  state.craters.push({x, y});
}

function getUnitVisualPos(u){
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
function displaceBrigadierIfPresent(x, y, fromX, fromY){
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

function animateUnitTo(u, newX, newY){
  const start = getUnitVisualPos(u); // current rendered position, in case a prior animation was still mid-flight
  logReplay('move', { unitId:u.id, side:u.side, from:{x:u.x,y:u.y}, to:{x:newX,y:newY} });
  u.x = newX; u.y = newY; // logical position updates immediately — game rules never wait on animation
  unitAnimations[u.id] = { fromX:start.x, fromY:start.y, toX:newX, toY:newY, startTime:Date.now(), duration:520 };
  ensureAnimationLoopRunning();
}

function showActionLine(fromUnit, toUnit, color, durationMs, dashed){
  activeActionLine = { fromX:fromUnit.x, fromY:fromUnit.y, toX:toUnit.x, toY:toUnit.y, color, dashed:!!dashed, expiresAt: Date.now()+(durationMs||1800) };
  ensureAnimationLoopRunning();
}

function ensureAnimationLoopRunning(){
  if(animFrameHandle) return;
  function tick(){
    draw();
    const stillAnimating = Object.keys(unitAnimations).length>0;
    const lineActive = activeActionLine && Date.now() < activeActionLine.expiresAt;
    if(!lineActive) activeActionLine = null;
    const now = Date.now();
    deathEffects = deathEffects.filter(d => now - d.startTime < DEATH_SKULL_MS + DEATH_SMOKE_MS);
    const deathActive = deathEffects.length>0;
    if(stillAnimating || lineActive || deathActive){
      animFrameHandle = requestAnimationFrame(tick);
    } else {
      animFrameHandle = null;
    }
  }
  animFrameHandle = requestAnimationFrame(tick);
}

const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');

function computeCellSize(){
  const wrap = document.getElementById('boardWrap');
  const viewportW = document.documentElement.clientWidth || window.innerWidth;
  const availW = Math.max(200, Math.min(wrap.clientWidth, viewportW) - 16);
  const availH = Math.max(200, wrap.clientHeight - 16);
  const byWidth = Math.floor(availW / COLS);
  const byHeight = Math.floor(availH / ROWS);
  return Math.max(22, Math.min(byWidth, byHeight, 68));
}

function sizeCanvas(){
  CELL = computeCellSize();
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = (COLS*CELL) + 'px';
  canvas.style.height = (ROWS*CELL) + 'px';
  canvas.width = COLS*CELL*dpr;
  canvas.height = ROWS*CELL*dpr;
  ctx.setTransform(dpr,0,0,dpr,0,0);
  draw();
}

function terrainColor(key){
  return { OPEN: '#3c4a34', FIELD:'#8a7d3f', PLOUGHED_FIELD:'#b89a3f', ROAD:'#8a7350', WOODS:'#26361f', BUILDING:'#6b5847', HILL:'#3c4a34' }[key];
}

/* =========================================================
   TERRAIN RENDERING HELPERS
   The map is meant to read as geomorphic and analogue, not a rigid
   grid — the grid only matters for movement/LOS/combat range. These
   helpers group same-type terrain into connected regions and render
   them as one organic shape rather than a tile-by-tile stamp.
========================================================= */
function findConnectedRegions(terrain, key){
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
function seededWobble(seed){
  const v = Math.sin(seed*12.9898)*43758.5453;
  return (v - Math.floor(v)) - 0.5; // -0.5..0.5
}
function roundedBlobPath(ctx, x, y, w, h, r){
  ctx.beginPath();
  ctx.moveTo(x+r,y);
  ctx.arcTo(x+w,y,x+w,y+h,r);
  ctx.arcTo(x+w,y+h,x,y+h,r);
  ctx.arcTo(x,y+h,x,y,r);
  ctx.arcTo(x,y,x+w,y,r);
  ctx.closePath();
}

function draw(){
  const debugPanel = document.getElementById('aiDebugPanel');
  if(debugPanel && debugPanel.style.display==='block') renderAiDebugPanel();
  const flip = screenFlipActive();
  ctx.clearRect(0,0,canvas.width,canvas.height);
  const terrain = state.terrain;

  // base fill — road cells fill as open ground; Hill matches Open (elevation is
  // shown by its border, not a colour change); the ploughed-field/woods passes
  // paint over their own cells next.
  for(let y=0;y<ROWS;y++){
    const sy_ = sy(y);
    for(let x=0;x<COLS;x++){
      const key = terrain[y][x];
      ctx.fillStyle = terrainColor(key==='ROAD' ? 'OPEN' : key);
      ctx.fillRect(x*CELL,sy_*CELL,CELL,CELL);
    }
  }

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

  // Woods: each cell is an inflated, jittered rounded blob; adjacent woods
  // cells overlap into one organic tree-mass instead of a grid of squares.
  const woodsRegions = findConnectedRegions(terrain, 'WOODS');
  ctx.fillStyle = terrainColor('WOODS');
  for(const region of woodsRegions){
    for(const [x,y] of region){
      const sy_ = sy(y);
      const jx = seededWobble(x*13+y*71+1) * CELL*0.12;
      const jy = seededWobble(x*47+y*19+2) * CELL*0.12;
      const pad = CELL*0.10, rad = CELL*0.34;
      roundedBlobPath(ctx, x*CELL-pad+jx, sy_*CELL-pad+jy, CELL+pad*2, CELL+pad*2, rad);
      ctx.fill();
    }
  }

  // Roads: one gently-curved stroke per unique connection, not filling the
  // whole square. 90-degree turns pull their anchor toward the inside corner
  // instead of routing dead-through the cell centre, softening the bend. A
  // small deterministic wobble per edge gives a hand-drawn feel rather than
  // rigid geometry, and stays stable across redraws (not re-randomized).
  function roadPoint(x,y){ return { x:x*CELL+CELL/2, y:sy(y)*CELL+CELL/2 }; }
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
  function roadAnchor(x,y){
    const list = roadConn[x+','+y] || [];
    const center = roadPoint(x,y);
    if(list.length !== 2) return center;
    const isOpposite = (list[0].x-x)===-(list[1].x-x) && (list[0].y-y)===-(list[1].y-y);
    if(isOpposite) return center; // straight through, no turn to soften
    const p1 = roadPoint(list[0].x,list[0].y), p2 = roadPoint(list[1].x,list[1].y);
    const midX=(p1.x+p2.x)/2, midY=(p1.y+p2.y)/2;
    const dirX=midX-center.x, dirY=midY-center.y;
    const len = Math.hypot(dirX,dirY) || 1;
    const pull = CELL*0.20;
    return { x:center.x+(dirX/len)*pull, y:center.y+(dirY/len)*pull };
  }
  ctx.strokeStyle = terrainColor('ROAD');
  ctx.lineWidth = Math.max(3, CELL*0.16);
  ctx.lineCap = 'round';
  const drawnEdges = new Set();
  for(let y=0;y<ROWS;y++){
    for(let x=0;x<COLS;x++){
      if(terrain[y][x]!=='ROAD') continue;
      const list = roadConn[x+','+y] || [];
      const a1 = roadAnchor(x,y);
      for(const n of list){
        const key = (x<n.x || (x===n.x && y<n.y)) ? `${x},${y}-${n.x},${n.y}` : `${n.x},${n.y}-${x},${y}`;
        if(drawnEdges.has(key)) continue;
        drawnEdges.add(key);
        const a2 = roadAnchor(n.x,n.y);
        const seed = x*17 + y*131 + n.x*29 + n.y*271;
        const wobble = seededWobble(seed) * CELL * 0.28;
        const dx=a2.x-a1.x, dy=a2.y-a1.y, len=Math.hypot(dx,dy)||1;
        const px=-dy/len, py=dx/len;
        const mx=(a1.x+a2.x)/2+px*wobble, my=(a1.y+a2.y)/2+py*wobble;
        ctx.beginPath(); ctx.moveTo(a1.x,a1.y); ctx.quadraticCurveTo(mx,my,a2.x,a2.y); ctx.stroke();
      }
      // a short stub into any adjacent Building, so roads visibly reach the buildings they serve
      for(const [dx,dy] of [[0,-1],[0,1],[-1,0],[1,0]]){
        const nx=x+dx, ny=y+dy;
        if(!inBounds(nx,ny) || terrain[ny][nx]!=='BUILDING') continue;
        const p1 = a1, p2 = roadPoint(nx,ny);
        ctx.beginPath();
        ctx.moveTo(p1.x + (p2.x-p1.x)*0.35, p1.y + (p2.y-p1.y)*0.35);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
      }
      if(list.length===0){ const c = roadPoint(x,y); ctx.beginPath(); ctx.arc(c.x,c.y,CELL*0.08,0,Math.PI*2); ctx.fillStyle=terrainColor('ROAD'); ctx.fill(); }
    }
  }
  ctx.lineCap = 'butt';

  // Hills: same grass fill as Open — elevation reads through a light rocky
  // border traced around the outer edge of each connected hill mass, not
  // per-tile, so a cluster reads as one landform (matches the real boards).
  const hillRegions = findConnectedRegions(terrain, 'HILL');
  ctx.strokeStyle = 'rgba(176,172,156,0.95)';
  ctx.lineWidth = Math.max(2, CELL*0.09);
  ctx.lineCap = 'round';
  for(const region of hillRegions){
    const cellSet = new Set(region.map(([x,y])=>x+','+y));
    for(const [x,y] of region){
      for(const {dx,dy} of [{dx:0,dy:-1},{dx:0,dy:1},{dx:-1,dy:0},{dx:1,dy:0}]){
        const nx=x+dx, ny=y+dy;
        if(inBounds(nx,ny) && cellSet.has(nx+','+ny)) continue; // interior edge, no border needed
        const sy0 = sy(y);
        let p1,p2;
        if(dy===-1){
          const nsy = sy(y-1);
          if(nsy<sy0){ p1=[x*CELL,sy0*CELL]; p2=[(x+1)*CELL,sy0*CELL]; }
          else { p1=[x*CELL,(sy0+1)*CELL]; p2=[(x+1)*CELL,(sy0+1)*CELL]; }
        } else if(dy===1){
          const nsy = sy(y+1);
          if(nsy<sy0){ p1=[x*CELL,sy0*CELL]; p2=[(x+1)*CELL,sy0*CELL]; }
          else { p1=[x*CELL,(sy0+1)*CELL]; p2=[(x+1)*CELL,(sy0+1)*CELL]; }
        } else if(dx===-1){ p1=[x*CELL,sy0*CELL]; p2=[x*CELL,(sy0+1)*CELL]; }
        else { p1=[(x+1)*CELL,sy0*CELL]; p2=[(x+1)*CELL,(sy0+1)*CELL]; }
        const seed = x*31 + y*57 + dx*211 + dy*97;
        const wobble = seededWobble(seed) * CELL * 0.22;
        const mx=(p1[0]+p2[0])/2, my=(p1[1]+p2[1])/2;
        const perpX=-(p2[1]-p1[1]), perpY=(p2[0]-p1[0]);
        const plen = Math.hypot(perpX,perpY) || 1;
        const cx_ = mx+(perpX/plen)*wobble, cy_ = my+(perpY/plen)*wobble;
        ctx.beginPath(); ctx.moveTo(p1[0],p1[1]); ctx.quadraticCurveTo(cx_,cy_,p2[0],p2[1]); ctx.stroke();
      }
    }
  }
  ctx.lineCap = 'butt';

  // terrain icons: quick at-a-glance recognition for hill/building (woods/field
  // are already visually distinct via their new shapes/colour, no icon needed)
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = Math.floor(CELL*0.46)+'px sans-serif';
  const ICONS = { HILL:'\u{26F0}', BUILDING:'\u{1F3E0}' };
  for(let y=0;y<ROWS;y++){
    for(let x=0;x<COLS;x++){
      const icon = ICONS[terrain[y][x]];
      if(!icon) continue;
      ctx.fillText(icon, x*CELL+CELL/2, sy(y)*CELL+CELL/2);
    }
  }

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

  // grid
  ctx.strokeStyle = 'rgba(184,147,79,0.18)';
  ctx.lineWidth = 1;
  for(let x=0;x<=COLS;x++){ ctx.beginPath(); ctx.moveTo(x*CELL,0); ctx.lineTo(x*CELL,ROWS*CELL); ctx.stroke(); }
  for(let y=0;y<=ROWS;y++){ ctx.beginPath(); ctx.moveTo(0,y*CELL); ctx.lineTo(COLS*CELL,y*CELL); ctx.stroke(); }

  // seam between the two physical boards
  ctx.strokeStyle = 'rgba(233,228,214,0.35)';
  ctx.lineWidth = 2;
  ctx.setLineDash([6,4]);
  ctx.beginPath(); ctx.moveTo(HALF_COLS*CELL,0); ctx.lineTo(HALF_COLS*CELL,ROWS*CELL); ctx.stroke();
  ctx.setLineDash([]);
  ctx.lineWidth = 1;

  // deployment zone tint during deploy phase (Blue = rows 0-1, Red = rows ROWS-2..ROWS-1)
  if(state.phase==='deploy'){
    const blueTop = Math.min(sy(0), sy(1));
    ctx.fillStyle = 'rgba(46,69,102,0.14)';
    ctx.fillRect(0, blueTop*CELL, COLS*CELL, 2*CELL);
    const redTop = Math.min(sy(ROWS-2), sy(ROWS-1));
    ctx.fillStyle = 'rgba(163,64,58,0.10)';
    ctx.fillRect(0, redTop*CELL, COLS*CELL, 2*CELL);
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
    ctx.lineWidth = Math.max(2, CELL*0.06);
    if(ln.dashed) ctx.setLineDash([CELL*0.12, CELL*0.10]);
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
}

