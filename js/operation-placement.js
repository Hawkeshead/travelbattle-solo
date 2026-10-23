/* =========================================================
   OPERATIONS: PLACEMENT PLANNER, PURE (Operations and Campaigns brief, 2.2)
   See operations.js. No game state: given a card and the terrain grid, it
   returns where every unit of both sides starts, so the unit tests can check
   every ready card deploys on both sides.
========================================================= */
let COLS = 20, ROWS = 10;   // taken from the terrain each time a plan is made
const SIDE_OF = { british: 'red', french: 'blue' };
const PREF = { BUILDING: 0, HILL: 1, WOODS: 2 };
const unitType = u => (typeof u === 'string' ? u : u.type);
const unitFormation = u => (typeof u === 'string' ? null : u.formation || null);
const sideRows = side => (side === 'red' ? [ROWS - 2, ROWS - 1] : [1, 0]);   // front row first
let TERRAIN = null;

/* ---------- placement ---------- */
function areaCells(card, name){ return ((card.map.areas || {})[name] || []).map(([x, y]) => ({ x, y })); }
function centreOf(cells){
  const cx = cells.reduce((a, c) => a + c.x, 0) / cells.length, cy = cells.reduce((a, c) => a + c.y, 0) / cells.length;
  return { x: cx, y: cy };
}
/* ONE BRIGADE, ONE PIECE (23 Oct 2026). A unit not linked to its Brigadier
   through touching units of its Brigade is cut off and can never move, and
   30 of the 31 campaign battles started with a Brigade in pieces: an area made
   of three hamlets spread a Brigade across all three (Papelotte: two units at
   Smohain frozen all battle, seven squares from their Brigadier), and on an
   edge every Brigade's infantry filled the front row outwards from the centre
   while its Brigadier and guns filled the back row from the centre too, so a
   second Brigade's men stood on a flank and their Brigadier in the middle.
   Now the Brigadier is placed first and every other unit on a square touching
   one of its Brigade already placed, by the same preferences as before; only
   when no such square is left in the area does a unit take a legal square
   just outside it, still touching the Brigade. A deliberate split is a card's
   placement.split, and is kept. */
const LEGAL = { WOODS: ['INFANTRY', 'GUARD', 'BRIGADIER'], BUILDING: ['INFANTRY', 'GUARD', 'ARTILLERY', 'BRIGADIER'] };
const terrainOf = c => (TERRAIN && TERRAIN[c.y] ? TERRAIN[c.y][c.x] : null);
const legalFor = (t, c) => { const l = LEGAL[terrainOf(c)]; return !l || l.includes(t); };
const touches = (c, placed) => placed.some(p => p.x !== c.x || p.y !== c.y ? Math.max(Math.abs(p.x - c.x), Math.abs(p.y - c.y)) === 1 : false);
const onBoardCell = c => c.x >= 0 && c.y >= 0 && c.x < COLS && c.y < ROWS;
function neighboursOf(placed, taken){
  const out = [], seen = new Set();
  for(const p of placed) for(let dx = -1; dx <= 1; dx++) for(let dy = -1; dy <= 1; dy++){
    const c = { x: p.x + dx, y: p.y + dy }, k = c.x + ',' + c.y;
    if((dx || dy) && onBoardCell(c) && !taken.has(k) && !seen.has(k)){ seen.add(k); out.push(c); }
  }
  return out;
}
/* Fills cells with a Brigade's units: Brigadier at the most central cell, the
   guns at the cell nearest the enemy edge, everyone else by terrain preference,
   each touching the Brigade (above). */
function fillArea(side, units, cells, taken){
  const free = cells.filter(c => !taken.has(c.x + ',' + c.y));
  const enemyRow = side === 'red' ? 0 : ROWS - 1;
  const ctr = centreOf(free.length ? free : cells);
  const out = [];
  const order = [...units].sort((a, b) => rank(unitType(a)) - rank(unitType(b)));
  const score = t => (t === 'BRIGADIER' ? c2 => Math.hypot(c2.x - ctr.x, c2.y - ctr.y)
    : t === 'ARTILLERY' ? c2 => Math.abs(c2.y - enemyRow) * 10 + Math.abs(c2.x - ctr.x)
    : c2 => (PREF[terrainOf(c2)] ?? 3) * 10 + Math.hypot(c2.x - ctr.x, c2.y - ctr.y));
  const take = c => { taken.add(c.x + ',' + c.y); const i = free.findIndex(f => f.x === c.x && f.y === c.y); if(i >= 0) free.splice(i, 1); return c; };
  const best = (list, f) => list.slice().sort((a, b) => f(a) - f(b))[0];
  for(const u of order){
    const t = unitType(u), f = score(t);
    let c = null;
    if(!out.length){
      /* The Brigadier: the central cell of the largest connected stretch of
         free area cells, so the most of his Brigade fits round him. */
      const comp = cell => { const seen = new Set([cell.x + ',' + cell.y]), q = [cell]; while(q.length){ const a = q.shift(); for(const o of free){ const k = o.x + ',' + o.y; if(!seen.has(k) && Math.max(Math.abs(o.x - a.x), Math.abs(o.y - a.y)) === 1){ seen.add(k); q.push(o); } } } return seen.size; };
      const room = Math.min(units.length, Math.max(0, ...free.map(comp)));
      c = best(free.filter(x => comp(x) >= room && legalFor(t, x)), f) || best(free, f);
    } else {
      const placed = out.map(o => ({ x: o.x, y: o.y }));
      c = best(free.filter(x => touches(x, placed) && legalFor(t, x)), f)                                   // in the area, touching the Brigade
        || best(neighboursOf(placed, taken).filter(x => legalFor(t, x)), x => Math.min(...cells.map(a => Math.hypot(a.x - x.x, a.y - x.y))) * 10 + f(x))   // just outside it, touching
        || best(free.filter(x => legalFor(t, x)), f) || best(free, f);                                    // as before, as a last resort
    }
    if(!c) throw new Error(`${side}: not enough squares to place ${t}`);
    take(c);
    out.push({ u, x: c.x, y: c.y });
  }
  return out;
}
const rank = t => ({ BRIGADIER: 0, ARTILLERY: 1, GUARD: 2, INFANTRY: 3, HEAVY_CAV: 4, LIGHT_CAV: 5 }[t] ?? 6);

/* A compact block on the side's own rows, centred on the objective's column:
   infantry and cavalry in the front row, the Brigadier and guns behind, every
   unit touching its Brigade (ONE BRIGADE, ONE PIECE, above). The Brigadier
   takes the back-row square nearest the centre with free front squares beside
   it, and his Brigade grows from him. */
function fillEdge(side, units, centreX, taken){
  const [front, back] = sideRows(side);
  const cols = [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 7, -7, 8, -8, 9, -9, 10, -10].map(d => Math.round(centreX) + d).filter(x => x >= 0 && x < COLS);
  const free = c => !taken.has(c.x + ',' + c.y);
  const centreDist = c => Math.abs(c.x - centreX);
  const out = [];
  const take = (u, c) => { taken.add(c.x + ',' + c.y); out.push({ u, x: c.x, y: c.y }); };
  const brig = units.find(u => unitType(u) === 'BRIGADIER');
  const others = units.filter(u => u !== brig).sort((a, b) => rank(unitType(a)) - rank(unitType(b)));
  const fronts = others.filter(u => !['ARTILLERY'].includes(unitType(u))).length;
  if(brig){
    // Room beside him: free front squares within the Brigade's width of his column.
    const room = x => cols.filter(cx => Math.abs(cx - x) <= Math.ceil(fronts / 2) + 1 && free({ x: cx, y: front })).length;
    const spot = cols.map(x => ({ x, y: back })).filter(free).sort((a, b) => (room(b.x) >= fronts ? 1 : 0) - (room(a.x) >= fronts ? 1 : 0) || centreDist(a) - centreDist(b))[0]
      || cols.map(x => ({ x, y: front })).find(free);
    if(spot) take(brig, spot);
  }
  for(const u of others){
    const t = unitType(u), rear = t === 'ARTILLERY';
    const rows = rear ? [back, front] : [front, back];
    const placed = out.map(o => ({ x: o.x, y: o.y }));
    let c = null;
    for(const row of rows){
      const cand = cols.map(x => ({ x, y: row })).filter(free);
      c = cand.filter(x => !placed.length || touches(x, placed)).sort((a, b) => centreDist(a) - centreDist(b))[0];
      if(c) break;
    }
    if(!c) for(const row of rows){ c = cols.map(x => ({ x, y: row })).find(free); if(c) break; }   // as before, as a last resort
    if(c) take(u, c);
  }
  return out;
}

/* Every unit of both sides placed, as { side, type, x, y, brigadeId, formation }. */
export function planOperationPlacement(card, terrain){
  TERRAIN = terrain;
  if(terrain && terrain.length){ ROWS = terrain.length; COLS = terrain[0].length; }
  const taken = new Set();
  const plan = [];
  // Area placements first, then edge placements (2.2).
  const jobs = [];
  for(const key of ['british', 'french']){
    const side = SIDE_OF[key];
    card.forces[key].brigades.forEach((b, i) => jobs.push({ side, key, b, i, area: b.placement && b.placement.type === 'area' }));
  }
  jobs.sort((a, b) => (b.area ? 1 : 0) - (a.area ? 1 : 0));
  const objectiveX = (() => {
    const all = Object.values(card.map.areas || {}).flat();
    return all.length ? all.reduce((a, c) => a + c[0], 0) / all.length : COLS / 2;
  })();
  for(const j of jobs){
    const p = j.b.placement || { type: 'edge' };
    const base = { side: j.side, brigadeId: j.i, tag: j.b.tag || null, locked: j.b.lockedUntil || null };
    /* REINFORCEMENTS (campaign battles): a Brigade that 'arrives' is held off
       the board until its round; 'arrivals' holds back some of a Brigade's
       units the same way. They are planned as reserves (no square). */
    if(j.b.arrives){
      for(const u of j.b.units) plan.push(Object.assign({}, base, { type: unitType(u), formation: unitFormation(u), reserve: { round: j.b.arrives.round, area: j.b.arrives.area || null } }));
      continue;
    }
    let units0 = j.b.units.slice();
    for(const a of (j.b.arrivals || [])){
      for(const t of a.units){
        const k = units0.map(unitType).lastIndexOf(t);
        if(k < 0) continue;
        units0.splice(k, 1);
        plan.push(Object.assign({}, base, { type: t, formation: null, reserve: { round: a.round, area: a.area || null } }));
      }
    }
    j.b = Object.assign({}, j.b, { units: units0 });
    let placed;
    if(p.type === 'area'){
      const groups = p.split || [{ area: p.area, count: j.b.units.length }];
      const units = [...j.b.units].sort((a, b) => rank(unitType(a)) - rank(unitType(b)));
      placed = [];
      let at = 0;
      for(const g of groups){ placed.push(...fillArea(j.side, units.slice(at, at + g.count), areaCells(card, g.area), taken)); at += g.count; }
    } else placed = fillEdge(j.side, j.b.units, objectiveX, taken);
    for(const pl of placed) plan.push({ side: j.side, type: unitType(pl.u), x: pl.x, y: pl.y, brigadeId: j.i, formation: unitFormation(pl.u) || (typeof j.b.formation === 'string' ? j.b.formation : null), tag: j.b.tag || null,
      name: (pl.u && typeof pl.u === 'object' && pl.u.name) || (unitType(pl.u) === 'BRIGADIER' && j.b.commander) || null,   // a campaign battle's own names (the 92nd, the Duke of Brunswick)
      locked: j.b.lockedUntil || (unitType(pl.u) === 'BRIGADIER' && j.b.pinCommanderUntil) || null });   // a pinned commander (Blucher under his horse) is held like a locked Brigade
  }
  return plan;
}

