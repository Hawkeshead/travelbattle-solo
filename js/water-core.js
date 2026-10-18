/* The pure half of the rivers (engine-water.js has the rules and the game
   state): building a map's water from its river spec, and asking what lies
   between two squares. No DOM, no game state, so the tests load it directly. */
const sq = (x, y) => x + ',' + y;
/* An edge between two orthogonally adjacent squares, the same whichever way
   round they are given. */
export function edgeKey(a, b){
  const k1 = sq(a.x, a.y), k2 = sq(b.x, b.y);
  return k1 < k2 ? k1 + '|' + k2 : k2 + '|' + k1;
}

/* The water for a map, built once from its river spec (null for no river). */
export function buildWater(spec, COLS, ROWS){
  if(!spec || !Array.isArray(spec.course) || spec.course.length < 2) return null;
  const edges = {};   // edgeKey -> 'river' | 'ford' | 'bridge' (a plain object, so saves, undo and online copies carry it)
  const inB = (x, y) => x >= 0 && y >= 0 && x < COLS && y < ROWS;
  const add = (a, b) => { if(inB(a.x, a.y) && inB(b.x, b.y)) edges[edgeKey(a, b)] = 'river'; };
  const c = spec.course.map(([x, y]) => [Math.round(x), Math.round(y)]);
  for(let i = 0; i < c.length - 1; i++){
    const [x0, y0] = c[i], [x1, y1] = c[i + 1];
    if(y0 === y1){                       // along a horizontal grid line: the squares above and below it
      for(let x = Math.min(x0, x1); x < Math.max(x0, x1); x++) add({ x, y: y0 - 1 }, { x, y: y0 });
    } else if(x0 === x1){                // along a vertical grid line: the squares left and right of it
      for(let y = Math.min(y0, y1); y < Math.max(y0, y1); y++) add({ x: x0 - 1, y }, { x: x0, y });
    }
  }
  for(const [x0, x1, y0, y1] of (spec.fords || [])){
    for(const [k, t] of Object.entries(edges)){
      if(t !== 'river') continue;
      const [a, b] = k.split('|').map(s => s.split(',').map(Number));
      const mx = (a[0] + b[0]) / 2 + 0.5, my = (a[1] + b[1]) / 2 + 0.5;   // the edge's midpoint, in line coordinates
      if(mx >= x0 && mx <= x1 && my >= y0 && my <= y1) edges[k] = 'ford';
    }
  }
  const bridges = (spec.bridges || []).map((b, i) => {
    const [[ax, ay], [bx, by]] = b.squares;
    const key = edgeKey({ x: ax, y: ay }, { x: bx, y: by });
    edges[key] = 'bridge';
    return { id: i, a: { x: ax, y: ay }, b: { x: bx, y: by }, key, art: b.art || 'single-arch', hits: 0, broken: false };
  });
  return { spec, edges, bridges, version: 1 };
}

/* What lies between two orthogonally adjacent squares in this water: null,
   'river', 'ford' or 'bridge' (a broken bridge answers 'ford'). */
export function waterBetweenIn(w, a, b){
  if(!w) return null;
  const t = w.edges[edgeKey(a, b)];
  if(t !== 'bridge') return t || null;
  const br = w.bridges.find(x => x.key === edgeKey(a, b));
  return br && br.broken ? 'ford' : 'bridge';
}
/* A step between neighbours, diagonals included: null (dry), 'river' (cannot
   cross), 'ford' or 'bridge'. A diagonal never crosses water: dry if either
   way round the corner is dry, otherwise blocked. */
export function stepWaterIn(w, a, b){
  if(!w) return null;
  const dx = b.x - a.x, dy = b.y - a.y;
  if(Math.abs(dx) + Math.abs(dy) === 1) return waterBetweenIn(w, a, b);
  if(Math.abs(dx) !== 1 || Math.abs(dy) !== 1) return null;
  const c1 = { x: b.x, y: a.y }, c2 = { x: a.x, y: b.y };
  const dry1 = !waterBetweenIn(w, a, c1) && !waterBetweenIn(w, c1, b);
  const dry2 = !waterBetweenIn(w, a, c2) && !waterBetweenIn(w, c2, b);
  return dry1 || dry2 ? null : 'river';
}
