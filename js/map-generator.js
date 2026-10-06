/* =========================================================
   RANDOM BOARD GENERATOR (Matthew, 6 Oct 2026)

   One 10 x 10 board at a time, from a seed, so a match's boards can always be
   rebuilt exactly. Pure: no DOM, no game state, nothing random but the seed.

   A board is two layers:
     terrain[y][x]  one of OPEN, PLOUGHED_FIELD, WOODS, HILL, BUILDING
     road[y][x]     true where a road runs, over whatever terrain is there
   (Roads are their own feature: a road can cross a hill, a wood, farmland or
   a village.)

   THE ROAD RULES, Matthew's:
   - one or two separate road networks per board;
   - a road leaves every edge at square 7, counted 0 to 9: row 7 down from the
     top on the left and right edges, column 7 from the left on the top and
     bottom edges. Every board is generated unrotated, so any board joins any
     other on any side with the roads meeting;
   - every built-up area has a road passing through it (in one side, out the
     other, never just touching it);
   - no dead ends, except at the board edge.

   HOW IT IS MADE
   1. Terrain: one or two hills and woods, a patch or two of farmland, placed
      as natural clumps (grown from a seed square), kept off the very edge
      rows where they would only get in the way of deployment.
   2. Roads: the four edge exits joined into one network (a cross-country
      tree) or two (left with top and right with bottom, or left with bottom
      and top with right: the only pairings that can stay apart, since a
      left-right road and a top-bottom road must cross). Routes are found
      with a cost map: open ground cheapest, then farmland, hills and woods,
      plus a little noise and a random waypoint so roads bend like country
      roads rather than ruling straight lines.
   3. Villages: grown on the roads, not the other way round, so every village
      has its road through it by construction: each starts on a road square
      that the road passes straight through (two road neighbours) and grows
      along and beside it to two to four buildings.
   4. Check: every rule above is tested (validateBoard); a board that fails is
      thrown away and the next seed in its sequence tried.
========================================================= */

export const BOARD = 10;
export const EXIT = 7;   // the edge square every road leaves by
export const EXITS = {
  left:   { x: 0, y: EXIT },
  right:  { x: BOARD - 1, y: EXIT },
  top:    { x: EXIT, y: 0 },
  bottom: { x: EXIT, y: BOARD - 1 },
};

/* A small seeded generator (mulberry32): the same seed always gives the same
   board, in any browser and in Node. */
export function rngFrom(seed){
  let a = (seed >>> 0) || 1;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: arr => arr[Math.floor(next() * arr.length)],
    chance: p => next() < p,
  };
}

const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const inB = (x, y) => x >= 0 && y >= 0 && x < BOARD && y < BOARD;
const grid = v => Array.from({ length: BOARD }, () => Array(BOARD).fill(v));

/* ---------- terrain ---------- */
/* Grows a clump of `size` squares of `kind` from a start square, only over
   open ground, preferring squares that touch the clump on more sides so it
   comes out rounded rather than stringy. */
function growClump(t, rng, kind, size, avoid){
  for(let tries = 0; tries < 30; tries++){
    const sx = rng.int(1, BOARD - 2), sy = rng.int(2, BOARD - 3);
    if(t[sy][sx] !== 'OPEN' || avoid(sx, sy)) continue;
    const cells = [[sx, sy]];
    t[sy][sx] = kind;
    while(cells.length < size){
      const cand = [];
      for(const [cx, cy] of cells) for(const [dx, dy] of N4){
        const x = cx + dx, y = cy + dy;
        if(!inB(x, y) || t[y][x] !== 'OPEN' || avoid(x, y)) continue;
        const touching = N4.filter(([ex, ey]) => inB(x + ex, y + ey) && t[y + ey][x + ex] === kind).length;
        for(let k = 0; k < touching * touching; k++) cand.push([x, y]);
      }
      if(!cand.length) break;
      const [x, y] = rng.pick(cand);
      t[y][x] = kind; cells.push([x, y]);
    }
    return cells;
  }
  return [];
}
/* Farmland comes in rectangular fields, two by two or two by three. */
function placeField(t, rng, avoid){
  for(let tries = 0; tries < 30; tries++){
    const w = rng.pick([2, 3, 2]), h = rng.pick([2, 2, 3]);
    const x0 = rng.int(0, BOARD - w), y0 = rng.int(1, BOARD - h - 1);
    let ok = true;
    for(let y = y0; y < y0 + h && ok; y++) for(let x = x0; x < x0 + w; x++) if(t[y][x] !== 'OPEN' || avoid(x, y)) ok = false;
    if(!ok) continue;
    for(let y = y0; y < y0 + h; y++) for(let x = x0; x < x0 + w; x++) t[y][x] = 'PLOUGHED_FIELD';
    return true;
  }
  return false;
}
/* Exit squares and their inward neighbour are kept open so a road can always
   reach the edge (it may still cross a hill or wood further in). */
const nearExit = (x, y) => Object.values(EXITS).some(e => Math.abs(e.x - x) + Math.abs(e.y - y) <= 1);

function makeTerrain(rng){
  const t = grid('OPEN');
  const hills = rng.int(1, 2), woods = rng.int(1, 2), fields = rng.int(1, 2);
  for(let i = 0; i < hills; i++) growClump(t, rng, 'HILL', rng.int(4, 8), nearExit);
  for(let i = 0; i < woods; i++) growClump(t, rng, 'WOODS', rng.int(3, 6), nearExit);
  for(let i = 0; i < fields; i++) placeField(t, rng, nearExit);
  return t;
}

/* ---------- roads ---------- */
const COST = { OPEN: 1, PLOUGHED_FIELD: 1.6, HILL: 3.2, WOODS: 3.6, BUILDING: 1 };
/* Cheapest 4-connected route from a to any square in `goal`, through a cost
   map. Road squares already laid cost almost nothing, so a branch joins the
   network rather than running alongside it. `blocked` squares cannot be used
   (the other network, to keep two networks apart). */
function route(cost, a, goal, road, blocked){
  /* Direction-aware: the search state is (square, heading, squares run
     straight), so a road that keeps going straight pays STRAIGHT_STEP for each
     square past STRAIGHT_FREE. Country roads wander (Matthew, 6 Oct 2026: no
     long straight stretches, as on the classic boards). */
  const key = (x, y, d, r) => ((y * BOARD + x) * 5 + d) * 8 + r;
  const start = key(a.x, a.y, 4, 0);
  const dist = new Map([[start, 0]]), prev = new Map(), at = new Map([[start, [a.x, a.y]]]);
  const open = [[0, a.x, a.y, 4, 0]];
  while(open.length){
    open.sort((p, q) => p[0] - q[0]);
    const [d, x, y, dir, run] = open.shift();
    const k0 = key(x, y, dir, run);
    if(d > (dist.get(k0) ?? Infinity)) continue;
    if(goal(x, y) && !(x === a.x && y === a.y)){
      const path = [[x, y]];
      let k = k0;
      while(prev.has(k)){ k = prev.get(k); path.push(at.get(k)); }
      return path.reverse();
    }
    N4.forEach(([dx, dy], nd) => {
      const nx = x + dx, ny = y + dy;
      if(!inB(nx, ny) || (blocked && blocked[ny][nx])) return;
      if(dir !== 4 && dx === -N4[dir][0] && dy === -N4[dir][1]) return;   // no doubling back
      const nrun = nd === dir ? Math.min(run + 1, 7) : 1;
      /* Off the road, two things cost extra so the network reads as roads
         rather than paving: running alongside an existing road (a square
         with road beside it that is not the one we came from, which makes
         parallel tracks and 2 x 2 blocks), and running along the board's
         outer ring (only the exit squares themselves belong there). */
      let step = road[ny][nx] ? 0.15 : cost[ny][nx];
      if(!road[ny][nx]){
        const besideRoad = N4.some(([ex, ey]) => { const qx = nx + ex, qy = ny + ey;
          return inB(qx, qy) && road[qy][qx] && !(qx === x && qy === y); });
        if(besideRoad) step += 2.5;
        const ring = nx === 0 || ny === 0 || nx === BOARD - 1 || ny === BOARD - 1;
        if(ring && !Object.values(EXITS).some(e => e.x === nx && e.y === ny)) step += 4;
        if(nrun > STRAIGHT_FREE) step += STRAIGHT_STEP * (nrun - STRAIGHT_FREE);
      }
      const k = key(nx, ny, nd, nrun), ndist = d + step;
      if(ndist < (dist.get(k) ?? Infinity)){ dist.set(k, ndist); prev.set(k, k0); at.set(k, [nx, ny]); open.push([ndist, nx, ny, nd, nrun]); }
    });
  }
  return null;
}
const STRAIGHT_FREE = 2;     // squares a road may run straight before it starts to cost
const STRAIGHT_STEP = 1.1;   // extra cost for each straight square beyond that
export const MAX_STRAIGHT = 5;   // the longest straight run validateBoard accepts

function lay(road, path){ for(const [x, y] of path) road[y][x] = true; }

/* Joins a list of exits into one network: the first two through a random
   waypoint (so the road bends), the rest branched onto it. Returns false if a
   route could not be found (the board is then discarded). */
function buildNetwork(t, rng, exits, road, blocked){
  const cost = t.map(row => row.map(k => COST[k] + rng.next() * 1.4));
  const [a, b, ...rest] = exits;
  const wp = { x: rng.int(2, BOARD - 3), y: rng.int(2, BOARD - 3) };
  if(blocked && blocked[wp.y][wp.x]) return false;
  const p1 = route(cost, a, (x, y) => x === wp.x && y === wp.y, road, blocked);
  if(!p1) return false; lay(road, p1);
  const p2 = route(cost, b, (x, y) => road[y][x], road, blocked);
  if(!p2) return false; lay(road, p2);
  for(const e of rest){
    const p = route(cost, e, (x, y) => road[y][x] && !(x === e.x && y === e.y), road, blocked);
    if(!p) return false; lay(road, p);
  }
  return true;
}

/* Trims any dead end that is not an edge exit (a waypoint left as a stub). */
function pruneDeadEnds(road){
  const isExit = (x, y) => Object.values(EXITS).some(e => e.x === x && e.y === y);
  let changed = true;
  while(changed){
    changed = false;
    for(let y = 0; y < BOARD; y++) for(let x = 0; x < BOARD; x++){
      if(!road[y][x] || isExit(x, y)) continue;
      if(roadDegree(road, x, y) <= 1){ road[y][x] = false; changed = true; }
    }
  }
}
export function roadDegree(road, x, y){
  return N4.filter(([dx, dy]) => inB(x + dx, y + dy) && road[y + dy][x + dx]).length;
}

function makeRoads(t, rng){
  const road = grid(false);
  const E = EXITS;
  if(rng.chance(0.5)){
    // One network joining all four exits.
    if(!buildNetwork(t, rng, rng.chance(0.5) ? [E.left, E.right, E.top, E.bottom] : [E.top, E.bottom, E.left, E.right], road, null)) return null;
  } else {
    // Two networks that never touch: left with top and right with bottom, or
    // left with bottom and top with right.
    const pairs = rng.chance(0.5) ? [[E.left, E.top], [E.right, E.bottom]] : [[E.left, E.bottom], [E.top, E.right]];
    const first = grid(false);
    if(!buildNetwork(t, rng, pairs[0], first, null)) return null;
    // The second network may not touch the first, not even side by side.
    const blocked = grid(false);
    for(let y = 0; y < BOARD; y++) for(let x = 0; x < BOARD; x++) if(first[y][x]){
      blocked[y][x] = true;
      for(const [dx, dy] of N4) if(inB(x + dx, y + dy)) blocked[y + dy][x + dx] = true;
    }
    for(const e of pairs[1]) if(blocked[e.y][e.x]) return null;
    const second = grid(false);
    if(!buildNetwork(t, rng, pairs[1], second, blocked)) return null;
    for(let y = 0; y < BOARD; y++) for(let x = 0; x < BOARD; x++) road[y][x] = first[y][x] || second[y][x];
  }
  pruneDeadEnds(road);
  return road;
}

/* ---------- villages ---------- */
/* Each village starts on a road square the road passes straight through and
   grows to 2 to 4 buildings along and beside the road. Never in the two
   edge rows on each side, where the armies deploy. */
function makeVillages(t, road, rng){
  const want = rng.int(1, 3);
  const villages = [];
  const usable = (x, y) => y >= 2 && y <= BOARD - 3 && t[y][x] !== 'BUILDING' &&
    !villages.some(v => v.some(([vx, vy]) => Math.abs(vx - x) <= 2 && Math.abs(vy - y) <= 2));
  for(let i = 0; i < want; i++){
    const starts = [];
    for(let y = 2; y <= BOARD - 3; y++) for(let x = 1; x < BOARD - 1; x++)
      if(road[y][x] && roadDegree(road, x, y) >= 2 && usable(x, y)) starts.push([x, y]);
    if(!starts.length) break;
    const [sx, sy] = rng.pick(starts);
    const cells = [[sx, sy]]; t[sy][sx] = 'BUILDING';
    const size = rng.int(2, 4);
    while(cells.length < size){
      const cand = [];
      for(const [cx, cy] of cells) for(const [dx, dy] of N4){
        const x = cx + dx, y = cy + dy;
        if(!inB(x, y) || y < 2 || y > BOARD - 3 || x === 0 || x === BOARD - 1 || t[y][x] === 'BUILDING') continue;   // never on the edge squares
        // Villages stay separate: never grow into touching another one.
        if(N4.some(([ex, ey]) => inB(x + ex, y + ey) && t[y + ey][x + ex] === 'BUILDING' && !cells.some(([qx, qy]) => qx === x + ex && qy === y + ey))) continue;
        // Along the road first, then beside it.
        const w = road[y][x] ? 3 : 1;
        for(let k = 0; k < w; k++) cand.push([x, y]);
      }
      if(!cand.length) break;
      const [x, y] = rng.pick(cand);
      t[y][x] = 'BUILDING'; cells.push([x, y]);
    }
    villages.push(cells);
  }
  return villages;
}

/* ---------- the rules, checked ---------- */
export function roadNetworks(road){
  const seen = grid(false), nets = [];
  for(let y = 0; y < BOARD; y++) for(let x = 0; x < BOARD; x++){
    if(!road[y][x] || seen[y][x]) continue;
    const net = [], stack = [[x, y]]; seen[y][x] = true;
    while(stack.length){
      const [cx, cy] = stack.pop(); net.push([cx, cy]);
      for(const [dx, dy] of N4){
        const nx = cx + dx, ny = cy + dy;
        if(inB(nx, ny) && road[ny][nx] && !seen[ny][nx]){ seen[ny][nx] = true; stack.push([nx, ny]); }
      }
    }
    nets.push(net);
  }
  return nets;
}
export function villagesOf(t){
  const seen = grid(false), out = [];
  for(let y = 0; y < BOARD; y++) for(let x = 0; x < BOARD; x++){
    if(t[y][x] !== 'BUILDING' || seen[y][x]) continue;
    const v = [], stack = [[x, y]]; seen[y][x] = true;
    while(stack.length){
      const [cx, cy] = stack.pop(); v.push([cx, cy]);
      for(const [dx, dy] of N4){
        const nx = cx + dx, ny = cy + dy;
        if(inB(nx, ny) && t[ny][nx] === 'BUILDING' && !seen[ny][nx]){ seen[ny][nx] = true; stack.push([nx, ny]); }
      }
    }
    out.push(v);
  }
  return out;
}
/* Returns the list of broken rules (empty when the board is good). */
export function validateBoard(board){
  const { terrain: t, road } = board;
  const errors = [];
  const nets = roadNetworks(road);
  if(nets.length < 1 || nets.length > 2) errors.push(`${nets.length} road networks (1 or 2 allowed)`);
  for(const [name, e] of Object.entries(EXITS)) if(!road[e.y][e.x]) errors.push(`no road at the ${name} exit`);
  const isExit = (x, y) => Object.values(EXITS).some(e => e.x === x && e.y === y);
  // (A building at the end of a run is the village, not a dead end.)
  for(let y = 0; y < BOARD; y++) for(let x = 0; x < BOARD; x++)
    if(road[y][x] && t[y][x] !== 'BUILDING' && !isExit(x, y) && roadDegree(road, x, y) <= 1) errors.push(`dead end at (${x},${y})`);
  for(let y = 0; y < BOARD - 1; y++) for(let x = 0; x < BOARD - 1; x++)
    if(road[y][x] && road[y][x + 1] && road[y + 1][x] && road[y + 1][x + 1] &&
       [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]].some(([a, b]) => t[b][a] !== 'BUILDING')) errors.push(`road block at (${x},${y})`);
  // No long straight stretches: count runs along rows and columns.
  for(let y = 0; y < BOARD; y++){ let r = 0; for(let x = 0; x < BOARD; x++){ r = road[y][x] && (x === 0 || road[y][x - 1]) ? r + 1 : (road[y][x] ? 1 : 0);
    if(r > MAX_STRAIGHT){ errors.push(`straight road along row ${y}`); break; } } }
  for(let x = 0; x < BOARD; x++){ let r = 0; for(let y = 0; y < BOARD; y++){ r = road[y][x] && (y === 0 || road[y - 1][x]) ? r + 1 : (road[y][x] ? 1 : 0);
    if(r > MAX_STRAIGHT){ errors.push(`straight road along column ${x}`); break; } } }
  const villages = villagesOf(t);
  if(!villages.length) errors.push('no village');
  villages.forEach((v, i) => {
    // A road passes through when the village joins at least two road squares
    // that are not part of it (in one side, out the other).
    const inV = new Set(v.map(([x, y]) => x + ',' + y));
    const outside = new Set();
    for(const [x, y] of v) for(const [dx, dy] of N4){ const nx = x + dx, ny = y + dy;
      if(inB(nx, ny) && road[ny][nx] && !inV.has(nx + ',' + ny)) outside.add(nx + ',' + ny); }
    const through = outside.size >= 2;
    if(!through) errors.push(`village ${i + 1} has no road through it`);
  });
  return errors;
}

/* ---------- one board ---------- */
/* The board for `seed`. If a candidate fails a rule, the next one in the
   seed's own sequence is tried, so the result is still fixed by the seed. */
export function generateBoard(seed){
  const rng = rngFrom(seed);
  for(let attempt = 0; attempt < 200; attempt++){
    const terrain = makeTerrain(rng);
    const road = makeRoads(terrain, rng);
    if(!road) continue;
    makeVillages(terrain, road, rng);
    // Every building square counts as road (Matthew's rule): mark them on the
    // road layer too, so the rules and the drawing need look only at it.
    for(let y = 0; y < BOARD; y++) for(let x = 0; x < BOARD; x++) if(terrain[y][x] === 'BUILDING') road[y][x] = true;
    const board = { terrain, road, seed, attempt };
    if(validateBoard(board).length === 0) return board;
  }
  throw new Error(`no valid board for seed ${seed}`);
}

/* ASCII for logs and tests: terrain letter, upper case where a road runs. */
export function boardToText(board){
  const L = { OPEN: '.', PLOUGHED_FIELD: 'f', WOODS: 'w', HILL: 'h', BUILDING: 'b' };
  return board.terrain.map((row, y) => row.map((k, x) => {
    const c = L[k] || '?';
    return board.road[y][x] ? (c === '.' ? '=' : c.toUpperCase()) : c;
  }).join('')).join('\n');
}
