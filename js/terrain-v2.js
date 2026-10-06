/* =========================================================
   TERRAIN ART v2: the layout rules (which tile goes where), ported from
   docs/terrain-v2/reference/farms_reference.py and roads_reference.py.
   Pure: no canvas, no DOM, no game state; render-board.js does the drawing.
   Visual only: nothing here changes a terrain type, a rule or a move cost.

   Every pick is a function of board coordinates, so the board looks the same
   on every load and from every viewpoint; road GEOMETRY is laid out in screen
   coordinates (the caller passes toScreen), because the road has to curve
   through each square's face centre as the player sees it.
========================================================= */

/* The integer hash the reference picks use: h(x, y, salt). It is the one that
   reproduces docs/terrain-v2/reference/expected_1v1_result.json exactly (the
   reference files pass it in without defining it). */
export function h(x, y, salt){
  return ((x * 73856093) ^ (y * 19349663) ^ (salt * 83492791)) % 1000003;
}
const hPos = (x, y, s) => { const v = h(x, y, s); return v < 0 ? v + 1000003 : v; };

export const GRASS_PLAIN_COUNT = 6;
export const GRASS_DETAIL_COUNT = 16;           // grass/detail: grass_7 .. grass_22 (grass v4)
/* The share of eligible squares that get a detail, as a percentage of the
   h(x,y,7) range. A percentage scales predictably; the old "one in N" rule did
   not (one in 4 gave fewer details than one in 5 on the 1v1 map, because of
   where the hash lands). 30 gives 20 detail squares on the 1v1 map. */
export const GRASS_DETAIL_PERCENT = 30;
export const HILL_COUNT = 7;
export const WOODS_COUNT = 4;
export const FARM_COUNT = 4;
export const GRASS_DETAIL_FILES = ['grass_7_oak_single', 'grass_8_oak_pair', 'grass_9_oak_trio', 'grass_10_oak_pair_right',
  'grass_11_poplars_weeds', 'grass_12_poplars_oak', 'grass_13_hedge_solo', 'grass_14_hedge_solo_left', 'grass_15_campfire_oak',
  'grass_16_campfire_poplars_cart', 'grass_17_haystack_oak', 'grass_18_trough_oak', 'grass_19_pond_oak', 'grass_20_stump_weeds',
  'grass_21_cart_stump', 'grass_22_posts_oak'];   // index = detail number

/* ---------------------------------------------------------
   Farm overlay squares on the assembled map. Local board coordinates are
   rotated and placed exactly as boardATerrain/boardBTerrain are (rotatePoint
   is data-core's rotatePointCW), for the two-board map and the four-board one.
--------------------------------------------------------- */
export function farmOverlaySet(layouts, placements, half, rotatePoint){
  const out = new Set();
  for(const { board, rotation, colOffset, rowOffset } of placements){
    const list = (board === 'A' ? layouts.boardAFarmOverlay : layouts.boardBFarmOverlay) || [];
    for(const [lx, ly] of list){
      const [rx, ry] = rotatePoint(lx, ly, half, rotation);
      out.add((rx + colOffset) + ',' + (ry + rowOffset));
    }
  }
  return out;
}

/* ---------------------------------------------------------
   Grass. Plain: h(x,y,0) % 6, moved on to the next variant while it matches
   the square to the left or above. Detail (grass/detail, 16 files): only on
   OPEN squares that are not farm overlay squares, when h(x,y,7) % 100 is below
   GRASS_DETAIL_PERCENT, never beside another detail to the left, above,
   above-left or above-right; which detail by h(x,y,8) % GRASS_DETAIL_COUNT.
   Returns rows of { plain: 1..6, detail: 0..15 | -1 }.
--------------------------------------------------------- */
export function grassPicks(terrain, overlay){
  const rows = terrain.length, cols = terrain[0].length;
  const out = [];
  for(let y = 0; y < rows; y++){
    const row = [];
    for(let x = 0; x < cols; x++){
      let p = hPos(x, y, 0) % GRASS_PLAIN_COUNT;
      const left = x > 0 ? row[x - 1].plain - 1 : -1, above = y > 0 ? out[y - 1][x].plain - 1 : -1;
      for(let k = 0; k < GRASS_PLAIN_COUNT && (p === left || p === above); k++) p = (p + 1) % GRASS_PLAIN_COUNT;
      let detail = -1;
      if(terrain[y][x] === 'OPEN' && !overlay.has(x + ',' + y) && hPos(x, y, 7) % 100 < GRASS_DETAIL_PERCENT){
        const near = [[x - 1, y], [x, y - 1], [x - 1, y - 1], [x + 1, y - 1]].some(([nx, ny]) =>
          ny >= 0 && nx >= 0 && nx < cols && (ny === y ? row[nx] : out[ny][nx]).detail >= 0);
        if(!near) detail = hPos(x, y, 8) % GRASS_DETAIL_COUNT;
      }
      row.push({ plain: p + 1, detail });
    }
    out.push(row);
  }
  return out;
}
export const hillPick = (x, y) => 1 + hPos(x, y, 1) % HILL_COUNT;
export const woodsPick = (x, y) => 1 + hPos(x, y, 2) % WOODS_COUNT;
export const farmMirrored = (x, y) => ((x + y) % 2) === 1;

/* ---------------------------------------------------------
   Farm fields (farms_reference.py): the farm set is every PLOUGHED_FIELD
   square plus every farm overlay square. Each contiguous block is split into
   fields of 2 (or 3) squares along each row; blocks of 3+ squares use all
   four tiles, smaller ones keep one pair; touching fields never share a tile.
   Returns Map "x,y" -> tile 1..4.
--------------------------------------------------------- */
export function farmPicks(cellsSet){
  const has = k => cellsSet.has(k);
  const cells = [...cellsSet].map(k => k.split(',').map(Number)).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const seen = new Set(), out = new Map();
  for(const [cx, cy] of cells){
    const ck = cx + ',' + cy;
    if(seen.has(ck)) continue;
    const blk = [], st = [[cx, cy]]; seen.add(ck);
    while(st.length){
      const [x, y] = st.pop(); blk.push([x, y]);
      for(const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]){
        const k = nx + ',' + ny;
        if(has(k) && !seen.has(k)){ seen.add(k); st.push([nx, ny]); }
      }
    }
    const B = new Set(blk.map(([x, y]) => x + ',' + y));
    const fid = new Map(); const fields = [];
    for(const y of [...new Set(blk.map(p => p[1]))].sort((a, b) => a - b)){
      const xs = blk.filter(p => p[1] === y).map(p => p[0]).sort((a, b) => a - b);
      const runs = []; let r = [xs[0]];
      for(const x of xs.slice(1)){ if(x === r[r.length - 1] + 1) r.push(x); else { runs.push(r); r = [x]; } }
      runs.push(r);
      for(const run of runs){
        if(run.length === 1){
          const x = run[0];
          if(fid.has(x + ',' + (y - 1))){ const j = fid.get(x + ',' + (y - 1)); fid.set(x + ',' + y, j); fields[j].push([x, y]); continue; }
          fields.push([[x, y]]); fid.set(x + ',' + y, fields.length - 1); continue;
        }
        const segs = [];
        for(let i = 0; i < run.length; i += 2) segs.push(run.slice(i, i + 2));
        if(segs[segs.length - 1].length === 1 && segs.length > 1){ const last = segs.pop(); segs[segs.length - 1] = segs[segs.length - 1].concat(last); }
        for(const sg of segs){ fields.push(sg.map(x => [x, y])); for(const x of sg) fid.set(x + ',' + y, fields.length - 1); }
      }
    }
    fields.forEach((f, i) => {
      if(f.length !== 1) return;
      const [x, y] = f[0], below = x + ',' + (y + 1);
      if(fid.has(below) && fid.get(below) !== i){ const j = fid.get(below); fields[j].push([x, y]); fid.set(x + ',' + y, j); fields[i] = []; }
    });
    const pal = B.size > 2 ? [0, 1, 2, 3] : [[0, 2], [1, 3]][hPos(blk[0][0], blk[0][1], 9) % 2];
    const tile = new Map();
    fields.forEach((f, i) => {
      if(!f.length) return;
      const nb = new Set();
      for(const [x, y] of f) for(const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]){
        const k = nx + ',' + ny;
        if(fid.has(k) && tile.has(fid.get(k)) && fid.get(k) !== i) nb.add(tile.get(fid.get(k)));
      }
      const opts = pal.filter(t => !nb.has(t));
      const use = opts.length ? opts : pal;
      tile.set(i, use[hPos(f[0][0], f[0][1], 11) % use.length]);
    });
    for(const k of B) out.set(k, tile.get(fid.get(k)) + 1);
  }
  return out;
}

/* ---------------------------------------------------------
   Roads (roads_reference.py). The rules and constants are final.
--------------------------------------------------------- */
export const ROAD = {
  FACE_CY: 0.469, EXIT_REACH: 1.1, DENSIFY: 12, SMOOTH_ITERS: 90,
  WOBBLE: [[0.045, 2.1], [0.025, 4.7], [0.012, 9.3]], WOBBLE_RAMP: 0.45,
  STROKES: [[0.26, 'rgba(78,54,32,0.784)'], [0.20, 'rgba(132,98,60,1)'], [0.12, 'rgba(152,116,74,1)']],
  RUTS: { offset: 0.045, width: 0.018, color: 'rgba(110,80,48,0.588)' },
};
const D4 = [[0, -1], [0, 1], [-1, 0], [1, 0]];

/* Node keys: 'c:x,y' road square, 'v:x,y' village square, 'e:x,y,dx,dy' exit. */
/* With a road layer (state.roads, generated maps, 6 Oct 2026), a road square
   is any square the layer marks, over any terrain, and EVERY building square
   counts as road too (Matthew's rule): so a road runs straight through a
   village as a plain run of road, drawn under the village art, instead of
   stopping at its edge and jumping to the nearest road on the far side (the
   jump is what made a loop on one sample board). Without a layer, the
   classic boards' rules below are unchanged. */
export function buildRoadGraph(terrain, excludedEdgeKey, roadLayer){
  const rows = terrain.length, cols = terrain[0].length;
  const inB = (x, y) => x >= 0 && y >= 0 && x < cols && y < rows;
  const isRoad = roadLayer
    ? (x, y) => inB(x, y) && (!!roadLayer[y][x] || terrain[y][x] === 'BUILDING')
    : (x, y) => inB(x, y) && terrain[y][x] === 'ROAD';
  const isBuilding = (x, y) => inB(x, y) && terrain[y][x] === 'BUILDING';
  const adj = new Map();
  const node = k => { if(!adj.has(k)) adj.set(k, new Set()); return adj.get(k); };
  const link = (a, b) => { node(a).add(b); node(b).add(a); };
  const cells = [];
  for(let x = 0; x < cols; x++) for(let y = 0; y < rows; y++) if(isRoad(x, y)) cells.push([x, y]);   // sorted as Python sorts (x, y)
  for(const [x, y] of cells){
    node(`c:${x},${y}`);
    for(const [dx, dy] of D4){
      const nx = x + dx, ny = y + dy;
      if(isRoad(nx, ny) && !excludedEdgeKey(x, y, nx, ny)) link(`c:${x},${y}`, `c:${nx},${ny}`);
    }
  }
  // Villages: a road that dead-ends (0 or 1 links) beside a village runs into
  // it, then on to the nearest other road square touching that village.
  // (Not with a road layer: there the village squares are road themselves.)
  for(const [x, y] of (roadLayer ? [] : cells)){
    if(adj.get(`c:${x},${y}`).size > 1) continue;
    for(const [dx, dy] of D4){
      const vx = x + dx, vy = y + dy;
      if(!isBuilding(vx, vy)) continue;
      link(`c:${x},${y}`, `v:${vx},${vy}`);
      const others = D4.map(([a, b]) => [vx + a, vy + b]).filter(([ox, oy]) => isRoad(ox, oy) && !(ox === x && oy === y));
      if(others.length){
        let best = others[0], bd = Infinity;
        for(const o of others){ const d = Math.hypot(o[0] - x, o[1] - y); if(d < bd){ bd = d; best = o; } }
        link(`v:${vx},${vy}`, `c:${best[0]},${best[1]}`);
      }
      break;
    }
  }
  // Map edge (the assembled map's outer edge, never a board seam): a road
  // square exits only if it has fewer than two links.
  for(const [x, y] of cells){
    if(adj.get(`c:${x},${y}`).size >= 2) continue;
    if(roadLayer && terrain[y][x] === 'BUILDING') continue;   // a village never runs off the map
    for(const [dx, dy] of D4) if(!inB(x + dx, y + dy)) link(`c:${x},${y}`, `e:${x},${y},${dx},${dy}`);
  }
  return adj;
}

/* Runs between nodes whose degree is not 2 (ends, forks, exits). */
export function roadChains(adj){
  const stop = n => adj.get(n).size !== 2;
  const seen = new Set(), out = [];
  const ek = (a, b) => a < b ? a + '|' + b : b + '|' + a;
  for(const n of adj.keys()){
    if(!stop(n)) continue;
    for(const m of adj.get(n)){
      if(seen.has(ek(n, m))) continue;
      const ch = [n, m]; seen.add(ek(n, m));
      let prev = n, cur = m;
      while(!stop(cur)){
        const nxt = [...adj.get(cur)].find(k => k !== prev);
        seen.add(ek(cur, nxt)); ch.push(nxt); prev = cur; cur = nxt;
      }
      out.push(ch);
    }
  }
  return out;
}
export const parseNode = k => { const [t, rest] = k.split(':'); return { t, v: rest.split(',').map(Number) }; };

/* A stable seed per chain from its two end squares, so the wobble never
   changes between loads. The reference wobble phases come from numpy's
   generator; here they come from a small seeded generator of our own, so the
   curve shapes are the same kind but not bit-identical to the mockups. */
function chainSeed(ch){
  const ends = [parseNode(ch[0]).v.slice(0, 2), parseNode(ch[ch.length - 1]).v.slice(0, 2)].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const [a, b] = ends;
  const big = (BigInt(a[0]) * 73856093n) ^ (BigInt(a[1]) * 19349663n) ^ (BigInt(b[0]) * 83492791n) ^ (BigInt(b[1]) * 2654435761n);
  return Number(((big % 1000003n) + 1000003n) % 1000003n);
}
function mulberry(seed){ let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/* Screen-space polyline for one chain, in cell units. toScreen(x, y) maps
   board squares to screen squares (the viewpoint flip or turn). */
export function smoothChain(ch, toScreen){
  const pos = k => {
    const { t, v } = parseNode(k);
    const s = toScreen(v[0], v[1]);
    const fx = s.x + 0.5, fy = s.y + ROAD.FACE_CY;
    if(t !== 'e') return [fx, fy];
    const n = toScreen(v[0] + v[2], v[1] + v[3]);
    return [fx + (n.x - s.x) * ROAD.EXIT_REACH, fy + (n.y - s.y) * ROAD.EXIT_REACH];
  };
  const P = ch.map(pos);
  const pts = [P[0]];
  for(let i = 0; i < P.length - 1; i++){
    const [ax, ay] = P[i], [bx, by] = P[i + 1];
    const k = Math.max(2, Math.floor(Math.hypot(bx - ax, by - ay) * ROAD.DENSIFY));
    for(let j = 1; j <= k; j++){ const t = j / k; pts.push([ax + (bx - ax) * t, ay + (by - ay) * t]); }
  }
  let Q = pts.map(p => p.slice());
  for(let it = 0; it < ROAD.SMOOTH_ITERS; it++){
    const R = Q.map(p => p.slice());
    for(let i = 1; i < Q.length - 1; i++){
      R[i][0] = 0.25 * Q[i - 1][0] + 0.5 * Q[i][0] + 0.25 * Q[i + 1][0];
      R[i][1] = 0.25 * Q[i - 1][1] + 0.5 * Q[i][1] + 0.25 * Q[i + 1][1];
    }
    Q = R;
  }
  const s = [0];
  for(let i = 1; i < Q.length; i++) s.push(s[i - 1] + Math.hypot(Q[i][0] - Q[i - 1][0], Q[i][1] - Q[i - 1][1]));
  const L = s[s.length - 1];
  if(L > 0.3){
    const rnd = mulberry(chainSeed(ch));
    const ph = ROAD.WOBBLE.map(() => rnd() * Math.PI * 2);
    Q = Q.map((q, i) => {
      const a = Q[Math.max(0, i - 1)], b = Q[Math.min(Q.length - 1, i + 1)];
      let tx = b[0] - a[0], ty = b[1] - a[1];
      const n = Math.hypot(tx, ty) + 1e-9; tx /= n; ty /= n;
      const off = ROAD.WOBBLE.reduce((sum, [amp, f], k) => sum + amp * Math.sin(s[i] * f + ph[k]), 0);
      const env = Math.min(1, Math.max(0, Math.min(s[i], L - s[i]) / ROAD.WOBBLE_RAMP));
      return [q[0] - ty * off * env, q[1] + tx * off * env];
    });
  }
  return Q;
}
