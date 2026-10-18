/* =========================================================
   A RIVER FOR A RANDOM MAP (Matthew, 18 October 2026)

   Pure: no DOM, no game state. Given the two generated boards side by side
   (20 x 10: terrain names and the road layer, buildings counted as road) and a
   seed, returns a river spec for js/water-core.js, or null for no river.

   The joining rule: a river enters and leaves a board only at the centre gap
   of an edge, between squares 5 and 6 (grid line 5 on a 10 x 10 board), just
   as every road leaves by square 8. Whichever way boards are put together,
   rivers then line up across the seams like roads do. Roads leave at square 8,
   so the two never meet at an edge.

   Shapes (one per river, picked by the seed):
     across      the full width along line 5: a front line between the armies
     left, right top to bottom through one board, between the two armies
     bend        down from the top of the left board, out through the seam,
                 and on along line 5 to the right edge
   The course wanders by a square or two between its fixed ends and never runs
   along the outer edge; a river across the board keeps between lines 4 and 6,
   clear of both armies' deployment rows.

   Crossings: wherever a road crosses the river, that edge is a bridge (the
   two road squares either side). One or two fords are added on open ground,
   and enough to make sure there are at least two crossings in all.
========================================================= */
import { rngFrom } from './map-generator.js';
import { buildWater } from './water-core.js';

export const RIVER_CHANCE = 0.4;            // the share of random maps that get a river
const COLS = 20, ROWS = 10;
const BRIDGE_ARTS = ['single-arch', 'single-arch', 'three-arch', 'wooden'];

/* A walk along grid lines from (x0, y) to (x1, y), drifting up or down by at
   most `drift` lines from y and never outside [lo, hi]; returns vertices. */
function wanderH(rng, x0, x1, y, lo, hi, drift){
  const v = [[x0, y]]; let cy = y; const step = Math.sign(x1 - x0);
  for(let x = x0 + step; step > 0 ? x <= x1 : x >= x1; x += step){
    const left = Math.abs(x1 - x);
    if(left > Math.abs(cy - y) && rng.chance(0.28)){
      const ny = cy + (rng.chance(0.5) ? 1 : -1);
      if(ny >= lo && ny <= hi && Math.abs(ny - y) <= drift){ v.push([x - step, ny]); cy = ny; }
    }
    if(left <= Math.abs(cy - y) && cy !== y){ v.push([x - step, y]); cy = y; }
    v.push([x, cy]);
  }
  return v;
}
function wanderV(rng, y0, y1, x, lo, hi, drift){
  return wanderH(rng, y0, y1, x, lo, hi, drift).map(([a, b]) => [b, a]);
}
/* Merge straight runs so the course is a short list of corners. */
function corners(v){
  const out = [v[0]];
  for(let i = 1; i < v.length; i++){
    const [px, py] = out[out.length - 1];
    if(px === v[i][0] && py === v[i][1]) continue;
    if(out.length >= 2){
      const [qx, qy] = out[out.length - 2];
      if((qx === px && px === v[i][0]) || (qy === py && py === v[i][1])){ out[out.length - 1] = v[i]; continue; }
    }
    out.push(v[i]);
  }
  return out;
}

export function generateRiver(terrain, road, seed, chance = RIVER_CHANCE){
  const rng = rngFrom(seed);
  if(!rng.chance(chance)) return null;
  const isRoad = (x, y) => !!(road[y] && road[y][x]) || (terrain[y] && terrain[y][x] === 'BUILDING');
  const isBuilding = (x, y) => terrain[y] && terrain[y][x] === 'BUILDING';
  /* Tidy crossings: a road that runs beside the river can hop over it again
     and again, leaving bridges bunched together. Courses with more than three
     bridges, or two bridges within two squares of each other, are kept only as
     a fallback; the tidiest course found is used if no attempt is clean. */
  let fallback = null;
  for(let attempt = 0; attempt < 40; attempt++){
    const shape = rng.pick(['across', 'left', 'right', 'bend']);
    let v;
    if(shape === 'across') v = wanderH(rng, 0, 20, 5, 4, 6, 1);
    else if(shape === 'left') v = wanderV(rng, 0, 10, 5, 3, 7, 2);
    else if(shape === 'right') v = wanderV(rng, 0, 10, 15, 13, 17, 2);
    else {
      const down = wanderV(rng, 0, 5, 5, 3, 7, 2);           // the top of the left board to line 5
      const turn = down[down.length - 1];
      v = [...down, ...wanderH(rng, turn[0], 20, 5, 4, 6, 1).slice(1)];
    }
    const course = corners(v);
    course[0] = course[0].map((c, i) => c === 0 ? -0.2 : c === (i ? ROWS : COLS) ? c + 0.2 : c);
    const last = course[course.length - 1];
    course[course.length - 1] = last.map((c, i) => c === 0 ? -0.2 : c === (i ? ROWS : COLS) ? c + 0.2 : c);
    // Bridges where roads cross; a crossing beside a village is no good (the
    // bridge would be drawn over the houses), so that course is thrown away.
    const water = buildWater({ course }, COLS, ROWS);
    const edges = Object.keys(water.edges).map(k => k.split('|').map(s => s.split(',').map(Number)));
    const bridges = []; let bad = false;
    for(const [a, b] of edges){
      if(isRoad(a[0], a[1]) && isRoad(b[0], b[1])){
        if(isBuilding(a[0], a[1]) || isBuilding(b[0], b[1])){ bad = true; break; }
        bridges.push({ squares: [a, b], art: rng.pick(BRIDGE_ARTS) });
      }
    }
    if(bad) continue;
    // Fords: one or two on open edges away from villages and bridges, more if
    // the river would otherwise have fewer than two crossings.
    const open = edges.filter(([a, b]) => !isRoad(a[0], a[1]) && !isRoad(b[0], b[1]) && !isBuilding(a[0], a[1]) && !isBuilding(b[0], b[1]));
    const want = Math.max(rng.int(1, 2), 2 - bridges.length);
    const fords = [];
    for(let i = 0; i < want && open.length; i++){
      const [a, b] = open.splice(rng.int(0, open.length - 1), 1)[0];
      const mx = (a[0] + b[0]) / 2 + 0.5, my = (a[1] + b[1]) / 2 + 0.5;
      fords.push([mx - 1.1, mx + 1.1, my - 1.1, my + 1.1]);   // the edge and up to one either side along the course
    }
    if(bridges.length + fords.length < 2) continue;
    const spec = { kind: 'river', shape, course, fords, bridges };
    const near = bridges.some((p, i) => bridges.some((q, j) => j > i &&
      Math.max(Math.abs(p.squares[0][0] - q.squares[0][0]), Math.abs(p.squares[0][1] - q.squares[0][1])) <= 2));
    if(bridges.length <= 3 && !near) return spec;
    if(!fallback || bridges.length < fallback.bridges.length) fallback = spec;
  }
  return fallback;
}
