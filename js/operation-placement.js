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
/* Fills cells with a Brigade's units: Brigadier at the most central cell, the
   guns at the cell nearest the enemy edge, everyone else by terrain preference. */
function fillArea(side, units, cells, taken){
  const free = cells.filter(c => !taken.has(c.x + ',' + c.y));
  const enemyRow = side === 'red' ? 0 : ROWS - 1;
  const ctr = centreOf(free.length ? free : cells);
  const pick = (score) => { free.sort((a, b) => score(a) - score(b)); const c = free.shift(); taken.add(c.x + ',' + c.y); return c; };
  const out = [];
  const order = [...units].sort((a, b) => rank(unitType(a)) - rank(unitType(b)));
  for(const u of order){
    if(!free.length) throw new Error(`${side}: not enough squares to place ${unitType(u)}`);
    const t = unitType(u);
    const c = t === 'BRIGADIER' ? pick(c2 => Math.hypot(c2.x - ctr.x, c2.y - ctr.y))
      : t === 'ARTILLERY' ? pick(c2 => Math.abs(c2.y - enemyRow) * 10 + Math.abs(c2.x - ctr.x))
      : pick(c2 => (PREF[(TERRAIN && TERRAIN[c2.y] ? TERRAIN[c2.y][c2.x] : null)] ?? 3) * 10 + Math.hypot(c2.x - ctr.x, c2.y - ctr.y));
    out.push({ u, x: c.x, y: c.y });
  }
  return out;
}
const rank = t => ({ BRIGADIER: 0, ARTILLERY: 1, GUARD: 2, INFANTRY: 3, HEAVY_CAV: 4, LIGHT_CAV: 5 }[t] ?? 6);

/* A compact block on the side's own rows, centred on the objective's column. */
function fillEdge(side, units, centreX, taken){
  const [front, back] = sideRows(side);
  const cols = [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 7, -7].map(d => Math.round(centreX) + d).filter(x => x >= 0 && x < COLS);
  const slot = row => { for(const x of cols) if(!taken.has(x + ',' + row)){ taken.add(x + ',' + row); return { x, y: row }; } return null; };
  const foot = units.filter(u => ['GUARD', 'INFANTRY'].includes(unitType(u))).sort((a, b) => rank(unitType(a)) - rank(unitType(b)));
  const cav = units.filter(u => ['HEAVY_CAV', 'LIGHT_CAV'].includes(unitType(u)));
  const rear = units.filter(u => ['BRIGADIER', 'ARTILLERY'].includes(unitType(u))).sort((a, b) => rank(unitType(a)) - rank(unitType(b)));
  const out = [];
  for(const u of foot) out.push(Object.assign({ u }, slot(front) || slot(back)));
  for(const u of cav) out.push(Object.assign({ u }, slot(front) || slot(back)));   // the next free front squares are the flanks
  for(const u of rear) out.push(Object.assign({ u }, slot(back) || slot(front)));
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
    let placed;
    if(p.type === 'area'){
      const groups = p.split || [{ area: p.area, count: j.b.units.length }];
      const units = [...j.b.units].sort((a, b) => rank(unitType(a)) - rank(unitType(b)));
      placed = [];
      let at = 0;
      for(const g of groups){ placed.push(...fillArea(j.side, units.slice(at, at + g.count), areaCells(card, g.area), taken)); at += g.count; }
    } else placed = fillEdge(j.side, j.b.units, objectiveX, taken);
    for(const pl of placed) plan.push({ side: j.side, type: unitType(pl.u), x: pl.x, y: pl.y, brigadeId: j.i, formation: unitFormation(pl.u) || (typeof j.b.formation === 'string' ? j.b.formation : null) });
  }
  return plan;
}

