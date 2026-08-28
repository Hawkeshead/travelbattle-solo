/* =========================================================
   DATA LOADER
   Game content (unit archive, narration text, campaigns, scenarios,
   terrain layouts, unit stats) lives in /data/*.json rather than inline
   in this file, so edits to content don't require touching this HTML.
   Loaded synchronously (deliberately, via XHR rather than fetch) so
   every line below this block can keep reading TB_DATA-derived consts
   immediately, exactly as it read inline literals before this change,
   with no restructuring of the game code itself.
========================================================= */
export const TB_DATA = (function(){
  function loadJSON(path){
    const xhr = new XMLHttpRequest();
    xhr.open('GET', path, false);
    xhr.send(null);
    if (xhr.status !== 200 && xhr.status !== 0) {
      throw new Error('Failed to load ' + path + ' (HTTP ' + xhr.status + ')');
    }
    return JSON.parse(xhr.responseText);
  }
  try {
    return {
      unitArchive: loadJSON('data/unit-archive.json'),
      narration: loadJSON('data/narration.json'),
      campaigns: loadJSON('data/campaigns.json'),
      scenarios: loadJSON('data/scenarios.json'),
      terrainLayouts: loadJSON('data/terrain-layouts.json'),
      unitTypes: loadJSON('data/unit-types.json'),
      armyCompositions: loadJSON('data/army-compositions.json'),
    };
  } catch (err) {
    document.body.innerHTML = '<div style="color:#eee;background:#2a1414;padding:40px;font-family:sans-serif;max-width:600px;margin:60px auto;border:1px solid #a33;border-radius:8px;">'
      + '<h2 style="margin-top:0;color:#e88;">Field Command failed to load</h2>'
      + '<p>One of the game data files couldn\'t be loaded. If you\'re running this locally, the /data/ files need to be served over HTTP (not opened as a local file), and on GitHub Pages this usually means a file is missing or the page hasn\'t finished deploying yet.</p>'
      + '<p style="font-family:monospace;font-size:13px;color:#caa;">' + (err && err.message ? err.message : err) + '</p>'
      + '</div>';
    throw err;
  }
})();

/* =========================================================
   CONFIG & CONSTANTS
========================================================= */
/* =========================================================
   BOARD: TWO PHYSICAL BOARDS, PLACED SIDE BY SIDE
   TravelBattle is played on two boards pushed together. They join
   along a vertical seam; both players deploy along their own top/
   bottom edge across the FULL combined width. Each half below
   represents one physical board, full depth, half width.

   BOARD_A_TERRAIN / BOARD_B_TERRAIN are traced from Matthew's actual
   board photos (Aug 2026) — best-effort read of road/woods/building/
   field placement, confirmed against his description. The light grey
   blotches visible in the photos are decorative (rocks / cliff faces
   on hill inclines) with no gameplay effect on their own.

   Each game start: one board is randomly assigned to each side, then
   each side rolls a d6 for that board's table orientation (1-3 =
   forced rotation of that many 90° clockwise turns; 4-6 = that side's
   player chooses the rotation) — see beginBoardSetup().
========================================================= */
export const HALF_COLS = 10, COLS = HALF_COLS*2; // each physical board is 10x10; combined map is always 20 wide
export let ROWS = 10; // 10 deep for a standard 2-board match; setBoardMode('grand') sets this to 20 for a 2x2, 4-board match
export let CELL = 68; // recomputed responsively at runtime, see computeCellSize()

// Switches board depth between a standard 2-board match (ROWS=10) and a 2x2
// four-board Grand Strategy match (ROWS=20, COLS stays 20 either way). Must
// be called before buildTerrainMap()/buildExcludedRoadEdgeSet() and before
// any deployment-zone or edge-retreat logic runs for the new match, since
// those all read ROWS live rather than caching it.
export function setBoardMode(mode){
  state.boardMode = mode;
  ROWS = (mode === 'grand') ? HALF_COLS*2 : HALF_COLS;
}

// Board A — exact terrain from Matthew's annotated spreadsheet (Aug 2026).
// Roads are stored as a full ROAD square for gameplay (any unit in the square
// gets the bonus) but rendered as a thin line through the cell centre — see
// the road-drawing pass in draw() — so the visual doesn't fill the whole tile.
export const BOARD_A_TERRAIN = TB_DATA.terrainLayouts.boardATerrain;

// Board B — exact terrain from Matthew's annotated spreadsheet (Aug 2026).
export const BOARD_B_TERRAIN = TB_DATA.terrainLayouts.boardBTerrain;

// Rotate a square (N x N) grid 90° clockwise, `times` times.
export function rotateGrid90CW(grid){
  const n = grid.length;
  const out = [];
  for(let y=0;y<n;y++){ const row=[]; for(let x=0;x<n;x++) row.push(null); out.push(row); }
  for(let y=0;y<n;y++) for(let x=0;x<n;x++) out[x][n-1-y] = grid[y][x];
  return out;
}
export function rotateGridTimes(grid, times){
  let g = grid;
  const n = ((times%4)+4)%4;
  for(let i=0;i<n;i++) g = rotateGrid90CW(g);
  return g;
}

export function boardTerrainFor(key, rotation){
  const base = key==='A' ? BOARD_A_TERRAIN : BOARD_B_TERRAIN;
  return rotateGridTimes(base, rotation||0);
}

// Specific road-to-road connections to NOT draw, even though the cells are
// adjacent ROAD squares — a visually redundant loop where the road already
// connects one square earlier (Matthew's note, Aug 2026). Coordinates are
// LOCAL to that physical board (0..HALF_COLS-1), before rotation/placement.
export const BOARD_EXCLUDED_ROAD_EDGES = TB_DATA.terrainLayouts.boardExcludedRoadEdges;

export function rotatePointCW(x, y, n, times){
  let px=x, py=y;
  const t = ((times%4)+4)%4;
  for(let i=0;i<t;i++){ const nx = n-1-py, ny = px; px=nx; py=ny; }
  return [px, py];
}

// Excluded edges for one physical board, transformed by its rotation and
// shifted by colOffset (0 if it landed on the left half, HALF_COLS if right)
// and rowOffset (0 if top row of boards, HALF_COLS if bottom — only non-zero
// in a 2x2 Grand Strategy layout; standard 2-board matches never pass it).
export function excludedEdgesForBoard(boardKey, rotation, colOffset, rowOffset){
  rowOffset = rowOffset || 0;
  return (BOARD_EXCLUDED_ROAD_EDGES[boardKey]||[]).map(e=>{
    const [rx1,ry1] = rotatePointCW(e.x1,e.y1,HALF_COLS,rotation);
    const [rx2,ry2] = rotatePointCW(e.x2,e.y2,HALF_COLS,rotation);
    return { x1:rx1+colOffset, y1:ry1+rowOffset, x2:rx2+colOffset, y2:ry2+rowOffset };
  });
}
export function edgeKey(x1,y1,x2,y2){
  // undirected — normalize so (a,b) and (b,a) produce the same key
  return (x1<x2 || (x1===x2 && y1<y2)) ? `${x1},${y1}-${x2},${y2}` : `${x2},${y2}-${x1},${y1}`;
}

// Patchwork grass style assignment — each Open cell independently gets one
// of 6 grass tile styles, but not uniformly at random: cells prefer to
// continue an already-started neighbouring patch, subject to two hard caps
// checked before every assignment — no cell ends up adjacent (8-direction)
// to more than 2 cells of its own style, and no cell's border shows more
// than 4 distinct styles among its neighbours. Computed once per terrain
// generation (not per-cell-per-render) since later cells' choices depend on
// earlier ones — order matters, so this isn't a pure function of (x,y) the
// way woodsStyleIndex is.
export function assignGrassStyles(terrain){
  const h = terrain.length, w = terrain[0].length;
  const NUM_STYLES = 6, MAX_SAME = 2, MAX_VARIETY = 4;
  const styles = Array.from({length:h}, ()=>new Array(w).fill(null));

  function neighborsOf(x,y){
    const list = [];
    for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++){
      if(dx===0 && dy===0) continue;
      const nx=x+dx, ny=y+dy;
      if(nx>=0 && nx<w && ny>=0 && ny<h) list.push([nx,ny]);
    }
    return list;
  }
  function sameStyleCount(x,y,style){
    let c = 0;
    for(const [nx,ny] of neighborsOf(x,y)) if(styles[ny][nx]===style) c++;
    return c;
  }
  function varietyIfNeighborBecomes(nx,ny,style){
    const set = new Set();
    for(const [ax,ay] of neighborsOf(nx,ny)) if(styles[ay][ax]) set.add(styles[ay][ax]);
    set.add(style);
    return set.size;
  }

  const cells = [];
  // BUILDING cells get a grass style as well as OPEN ones. The hamlet tiles are
  // a rounded plaque floating inside their frame — the artwork never exceeds 89%
  // of its own width and stops short of the bottom edge entirely — so there is a
  // permanent transparent margin around every one, at any scale. Without real
  // grass beneath, that margin shows the flat terrainColor fill as a grey square
  // around each village. Scaling the tile up cannot close it: bottom-anchoring
  // means a larger tile samples a narrower strip of the frame, so coverage
  // actually falls away above 1.3x rather than improving.
  const GRASS_UNDER = new Set(['OPEN','BUILDING']);
  for(let y=0;y<h;y++) for(let x=0;x<w;x++) if(GRASS_UNDER.has(terrain[y][x])) cells.push([x,y]);
  for(let i=cells.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [cells[i],cells[j]] = [cells[j],cells[i]];
  }

  for(const [x,y] of cells){
    const neighbors = neighborsOf(x,y);
    const candidates = [];
    for(let s=1;s<=NUM_STYLES;s++){
      if(sameStyleCount(x,y,s) > MAX_SAME) continue;
      let ok = true;
      for(const [nx,ny] of neighbors){
        if(styles[ny][nx]===s && sameStyleCount(nx,ny,s)+1 > MAX_SAME){ ok = false; break; }
        if(varietyIfNeighborBecomes(nx,ny,s) > MAX_VARIETY){ ok = false; break; }
      }
      if(ok) candidates.push(s);
    }
    if(candidates.length===0){
      // No fully-compliant option (rare, tight corners) — score every style
      // by how much it would overshoot each constraint and take the least
      // bad overall, rather than only optimizing the same-style cap.
      let best = 1, bestScore = Infinity;
      for(let s=1;s<=NUM_STYLES;s++){
        const sameOver = Math.max(0, sameStyleCount(x,y,s) - MAX_SAME);
        let varietyOver = 0;
        for(const [nx,ny] of neighbors){
          varietyOver += Math.max(0, varietyIfNeighborBecomes(nx,ny,s) - MAX_VARIETY);
        }
        const score = sameOver*10 + varietyOver; // same-style shape is the primary constraint
        if(score<bestScore){ bestScore=score; best=s; }
      }
      styles[y][x] = best;
      continue;
    }
    const continuing = candidates.filter(s => neighbors.some(([nx,ny])=>styles[ny][nx]===s));
    const pool = (continuing.length>0 && Math.random()<0.75) ? continuing : candidates;
    styles[y][x] = pool[Math.floor(Math.random()*pool.length)];
  }
  return styles;
}

// Building style assignment — much simpler than Grass's patchwork: no
// clumping wanted here, just avoidance. Each Building cell independently
// rolls one of 6 housing-cluster styles, excluding whatever styles its
// already-assigned neighbours (8-direction) are using, so no two adjacent
// Building squares ever show the same visual. With 6 styles and Buildings
// typically sparse/scattered on real boards, this is essentially always
// satisfiable; the random fallback only matters in the deliberately
// pathological case of one cell fully boxed in by all 6 styles at once.
export function assignBuildingStyles(terrain){
  const h = terrain.length, w = terrain[0].length;
  const NUM_STYLES = 6;
  const styles = Array.from({length:h}, ()=>new Array(w).fill(null));

  function neighborsOf(x,y){
    const list = [];
    for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++){
      if(dx===0 && dy===0) continue;
      const nx=x+dx, ny=y+dy;
      if(nx>=0 && nx<w && ny>=0 && ny<h) list.push([nx,ny]);
    }
    return list;
  }

  const cells = [];
  for(let y=0;y<h;y++) for(let x=0;x<w;x++) if(terrain[y][x]==='BUILDING') cells.push([x,y]);
  for(let i=cells.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [cells[i],cells[j]] = [cells[j],cells[i]];
  }

  for(const [x,y] of cells){
    const used = new Set();
    for(const [nx,ny] of neighborsOf(x,y)) if(styles[ny][nx]) used.add(styles[ny][nx]);
    const candidates = [];
    for(let s=1;s<=NUM_STYLES;s++) if(!used.has(s)) candidates.push(s);
    styles[y][x] = candidates.length>0
      ? candidates[Math.floor(Math.random()*candidates.length)]
      : 1 + Math.floor(Math.random()*NUM_STYLES); // boxed in by all 6 — vanishingly rare
  }
  return styles;
}

export function buildTerrainMap(assignment, rotation){
  assignment = assignment || { red:'A', blue:'B' };
  rotation = rotation || { red:0, blue:0 };
  const leftGrid = boardTerrainFor(assignment.red, rotation.red);
  const rightGrid = boardTerrainFor(assignment.blue, rotation.blue);
  const map = [];
  for(let y=0;y<ROWS;y++) map.push(leftGrid[y].concat(rightGrid[y]));
  return map;
}

export function buildExcludedRoadEdgeSet(assignment, rotation){
  assignment = assignment || { red:'A', blue:'B' };
  rotation = rotation || { red:0, blue:0 };
  const edges = [
    ...excludedEdgesForBoard(assignment.red, rotation.red, 0),
    ...excludedEdgesForBoard(assignment.blue, rotation.blue, HALF_COLS)
  ];
  const set = new Set();
  edges.forEach(e=> set.add(edgeKey(e.x1,e.y1,e.x2,e.y2)));
  return set;
}

/* =========================================================
   GRAND STRATEGY: 2x2 four-board composition (20x20 combined).
   Reuses the same two physical boards (A and B), each appearing twice,
   randomly shuffled across the four quadrant positions with an
   independent rotation roll per quadrant — see generateGrandQuadrants().
   quadrants shape: { topLeft, topRight, bottomLeft, bottomRight },
   each { board:'A'|'B', rotation:0-3 }.
========================================================= */
export function generateGrandQuadrants(rollFn){
  rollFn = rollFn || (() => Math.floor(Math.random()*4)); // 0-3, overridable for deterministic tests
  const boards = ['A','A','B','B'];
  // Fisher-Yates shuffle
  for(let i=boards.length-1; i>0; i--){
    const j = Math.floor(Math.random()*(i+1));
    [boards[i], boards[j]] = [boards[j], boards[i]];
  }
  const positions = ['topLeft','topRight','bottomLeft','bottomRight'];
  const quadrants = {};
  positions.forEach((pos, i) => {
    quadrants[pos] = { board: boards[i], rotation: rollFn() };
  });
  return quadrants;
}

export function buildTerrainMapGrand(quadrants){
  const tl = boardTerrainFor(quadrants.topLeft.board, quadrants.topLeft.rotation);
  const tr = boardTerrainFor(quadrants.topRight.board, quadrants.topRight.rotation);
  const bl = boardTerrainFor(quadrants.bottomLeft.board, quadrants.bottomLeft.rotation);
  const br = boardTerrainFor(quadrants.bottomRight.board, quadrants.bottomRight.rotation);
  const map = [];
  for(let y=0;y<HALF_COLS;y++) map.push(tl[y].concat(tr[y]));       // top board-row
  for(let y=0;y<HALF_COLS;y++) map.push(bl[y].concat(br[y]));       // bottom board-row
  return map;
}

export function buildExcludedRoadEdgeSetGrand(quadrants){
  const edges = [
    ...excludedEdgesForBoard(quadrants.topLeft.board, quadrants.topLeft.rotation, 0, 0),
    ...excludedEdgesForBoard(quadrants.topRight.board, quadrants.topRight.rotation, HALF_COLS, 0),
    ...excludedEdgesForBoard(quadrants.bottomLeft.board, quadrants.bottomLeft.rotation, 0, HALF_COLS),
    ...excludedEdgesForBoard(quadrants.bottomRight.board, quadrants.bottomRight.rotation, HALF_COLS, HALF_COLS),
  ];
  const set = new Set();
  edges.forEach(e=> set.add(edgeKey(e.x1,e.y1,e.x2,e.y2)));
  return set;
}
export const SIDES = { RED: 'red', BLUE: 'blue' };
export const SIDE_LABEL = { red: 'Britain', blue: 'France' };
export const SIDE_COLOR = { red: '#a3403a', blue: '#2e4566' };
export const SIDE_COLOR_DIM = { red: '#5c2825', blue: '#1c2a3d' };

export const UNIT_TYPES = TB_DATA.unitTypes.unitTypes;

// Full army per side, split into 3 Brigades — matches the physical box contents
// (3 Brigadiers, 2 Guard Infantry, 6 Infantry, 2 Heavy Cavalry, 2 Light Cavalry, 2 Artillery)
export const UNIT_ARCHIVE = TB_DATA.unitArchive;

/* =========================================================
   OPERATIONS — asymmetrical scenario battles, distinct from a standard
   full-army fight. Each `sides.X.units` array is deployed as 3 nominal
   Brigades (matching the deployment UI's fixed assumption) even when
   very small or uneven, since that keeps this addition contained to
   data + the objective system rather than generalizing brigade count
   throughout the UI. Forces, objectives and turn limits are drawn from
   the project's Battles & Operations document.
   4 of the eventual 14 are authored here as a proven template — one
   per objective type, spanning all three campaigns.
========================================================= */
export const NARRATION = TB_DATA.narration;

export const CAMPAIGNS = TB_DATA.campaigns;

export const SCENARIOS = TB_DATA.scenarios;
export const BRIGADE_COMPOSITIONS = TB_DATA.unitTypes.brigadeCompositions;

export const TERRAIN = TB_DATA.unitTypes.terrainTypes;

/* =========================================================
   STATE
========================================================= */
export let state = {
  gameOver: false,
  mode: 'hotseat',  // 'hotseat' | 'ai'
  aiSide: null,     // side controlled by the AI, when mode==='ai'
  aiDifficulty: 'medium', // 'easy' | 'medium' | 'hard'
  scenario: null,   // active Operation, or null for a standard full-army battle
  campaign: null,   // active Campaign, or null when not playing one
  campaignFlowIndex: 0,
  campaignLastWinner: null,
  campaignRecord: [],
  turnNumber: 1,    // increments every side-turn (2 per round)
  captureHoldCounter: { red:0, blue:0 }, // consecutive turns each side has held a CAPTURE_ZONE objective
  terrain: buildTerrainMap(),
  excludedRoadEdges: buildExcludedRoadEdgeSet(),
  craters: [], // {x,y} — every square an Artillery shot has hit, persists for the whole match
  units: [],       // {id, side, type, x, y, hp:'active', formation:'line'|'square', pushed:false, mustTurnOnly:false, facing}
  turn: null,      // 'red' | 'blue'
  phase: 'deploy',
  deployQueue: [],
  deployTurn: null,
  selectedUnitId: null,
  moved: new Set(), // unit ids that have moved/declined this turn
  fired: new Set(),
  fought: new Set(),
  pendingTurnarounds: [], // units that must spend next phase turning around only
  log: [],
  matchLog: [],           // battle replay event stream — see logReplay()
  replayStartUnits: null, // deep snapshot of state.units the moment deployment ends
  replaying: false,       // true while the replay player is stepping through matchLog
  _aiPlan: { red:null, blue:null },     // OperationalPlan per side, Hard difficulty only — persists across AI turns
  _aiMissions: { red:null, blue:null }, // BrigadeMission[] per side, recomputed each AI turn from the current plan
  _aiDebugLog: { red:null, blue:null }, // last turn's assessment/plan/missions/reasoning, for the AI Debug panel
  _aiFocusTargetId: null,               // enemy the AI is concentrating this fight phase on; see aiDoFightPhase
  _matchMeta: null,                     // seed, start time, difficulty, deployment snapshot; see exportMatchReport
  _aiCavTargetCache: null,              // per (side, turn) cavalry aiming point; see cavalrySchwerpunkt
  _aiKillCache: null,                   // per (side, turn) nearly-broken enemy Brigade; see killTarget
  _aiContactCache: null,                // per (side, turn) centre of the fighting; see contactPoint
  _aiTempoCache: null,                  // per (side, turn) build/hold/commit phase; see tempoPhase
  _aiMoveHistory: { red:[], blue:[] }, // every AI move for the whole match, any difficulty — see exportAiMoveLog()
  _aiVulnCache: null, // per-(side,turn) cache of findVulnerableEnemyUnits — see getVulnerableEnemyUnits()
  _aiRallyCache: null, // per-(side,turn) cache of findDefensiveRallyPoint — see getDefensiveRallyPoint()
  _aiCompositionChoice: { red:null, blue:null } // 'standard' or 'cavalryFocused', decided once per match per side — see aiDeployStepHard()
};
export let uidCounter = 1;

// Unit ids are handed out through this function rather than by incrementing
// uidCounter from another file. Under ES modules an imported binding is
// read-only, so `uidCounter++` across a file boundary throws — this keeps the
// only write in the file that owns the variable.
export function nextUid(){
  return uidCounter++;
}

// Same reasoning for CELL, which sizeCanvas() in render-board.js recomputes
// on every resize.
export function setCell(px){
  CELL = px;
}
