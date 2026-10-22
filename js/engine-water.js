/* =========================================================
   RIVERS, BRIDGES AND FORDS (Matthew, 18 October 2026)

   One kind of water, the river. It runs BETWEEN squares, along the grid
   lines, so a unit is always on one bank or the other and never in the water.
   It is crossed only at a bridge or a ford.

   A map carries its river as `river`:
     course:  the line of the river in grid-line coordinates. Line x sits
              between columns x-1 and x; line y between rows y-1 and y. The
              course runs along grid lines from vertex to vertex (ends may
              overshoot the board slightly so it is drawn off the edge).
     fords:   boxes [x0, x1, y0, y1] in the same coordinates; every river edge
              whose midpoint falls inside a box is a ford.
     bridges: { squares: [[x,y],[x,y]], art } the two squares, one on each
              bank, a bridge joins. `art` names Matthew's bridge picture.

   The rules (see the design doc, "River rules"):
     - Crossing: bridges for everyone; fords for infantry, Guard, cavalry and
       Brigadiers, never guns. Never diagonally.
     - A ford: infantry that crossed cannot fire or form square that turn;
       cavalry and Brigadiers move only one square when they cross, and cannot
       charge across. Infantry and cavalry attacking across a ford get -1.
     - A bridge square holds one unit (no columns, no square); its defender
       gets +1.
     - No hand-to-hand across open water. Volleys and guns fire across it.
     - Backs to the water: infantry and Guard with the river directly behind
       them win ties, and drown if beaten and pushed back. Cavalry and guns
       pushed back against the river simply stay put, turned around.
     - Five artillery hits on a bridge's squares break it; a broken bridge
       is crossed as a ford from then on. No repairs.

   This module only answers questions about the water and keeps the bridge
   damage; the rules above are applied where movement, fights, volleys and
   gunnery already live (engine-rules.js, ui-battle.js, ai-strategy.js).
========================================================= */
import { COLS, ROWS, UNIT_TYPES, state } from './data-core.js';
import { buildWater as coreBuild, stepWaterIn, waterBetweenIn } from './water-core.js';

export const BRIDGE_HITS_TO_BREAK = 5;

export { edgeKey } from './water-core.js';
export const buildWater = spec => coreBuild(spec, COLS, ROWS);

const W = () => state.water;

export const waterBetween = (a, b) => waterBetweenIn(W(), a, b);
export const stepWater = (a, b) => stepWaterIn(W(), a, b);

/* Can this unit make this step? Fords are closed to guns. */
export function canCross(u, a, b){
  const t = stepWater(a, b);
  if(!t) return true;
  if(t === 'river') return false;
  if(t === 'ford') return !UNIT_TYPES[u.type].isArtillery;
  return true;   // an intact bridge
}

/* Two units in reach of each other for hand-to-hand: not across open water. */
export function meleeBlocked(a, b){ return stepWater(a, b) === 'river'; }

export function bridgeAtSquare(x, y){
  const w = W(); if(!w) return null;
  return w.bridges.find(br => !br.broken && ((br.a.x === x && br.a.y === y) || (br.b.x === x && br.b.y === y))) || null;
}
export function isBridgeSquare(x, y){ return !!bridgeAtSquare(x, y); }

/* Every bridge, intact or broken, that a square belongs to (for gunnery). */
function anyBridgeAt(x, y){
  const w = W(); if(!w) return null;
  return w.bridges.find(br => (br.a.x === x && br.a.y === y) || (br.b.x === x && br.b.y === y)) || null;
}

/* Infantry and Guard with the river directly behind them, on the side away
   from the attacker: the square they would be pushed back to is across open
   water (or there is open water between them and it). */
export function backsToWater(defender, attacker){
  const k = UNIT_TYPES[defender.type].key;
  if(k !== 'INFANTRY' && k !== 'GUARD') return false;
  return retreatIntoRiver(defender, attacker);
}
/* Whether a push-back from `winner` would take `loser` across open water. */
export function retreatIntoRiver(loser, winner){
  if(!W()) return false;
  const dx = Math.sign(loser.x - winner.x) || 0, dy = Math.sign(loser.y - winner.y) || 0;
  if(!dx && !dy) return false;
  return stepWater(loser, { x: loser.x + dx, y: loser.y + dy }) === 'river';
}

/* The path a move took crossed a ford (or a broken bridge). */
export function pathCrossesFord(path){
  if(!W() || !path || path.length < 2) return false;
  for(let i = 0; i < path.length - 1; i++) if(stepWater(path[i], path[i + 1]) === 'ford') return true;
  return false;
}
export function crossedFordThisTurn(u){ return u._fordTurn != null && u._fordTurn === state.turnNumber; }

/* Square formation: not on a bridge square, and not straight after wading a ford. */
export function squareBlockedByWater(u){ return isBridgeSquare(u.x, u.y) || crossedFordThisTurn(u); }

/* An artillery hit landing on a square: if it is a bridge square, the bridge
   takes the damage, whatever happened to any unit standing there. Returns the
   bridge if this hit broke it. */
export function recordBridgeHit(x, y){
  const br = anyBridgeAt(x, y);
  if(!br || br.broken) return null;
  br.hits += 1;
  state.water.version += 1;
  if(br.hits >= BRIDGE_HITS_TO_BREAK){ br.broken = true; return br; }
  return null;
}

/* DISTANCE AROUND THE WATER, for the AI. Squares apart counting only steps a
   unit can take across the ground (fords and bridges, not open river); with no
   river it is the plain square distance. One distance field per target square,
   cached until the water changes. A target the river cuts off entirely (it
   cannot happen on a generated map, which always has crossings) reads 99. */
const fields = new Map();
let fieldsFor = null;
export function waterDistance(a, b){
  const w = W();
  if(!w) return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  /* A target or origin off the board (a removed unit, a reserve waiting at
     -1,-1, a missing square): no field can be built from it. Without this
     guard the search below looped forever on NaN squares until memory ran
     out (found 21 Oct 2026 when the AI's kill pull began measuring round the
     river). Fall back to the straight-line distance, or 99 if there is none. */
  const onBoard = p => p && Number.isInteger(p.x) && Number.isInteger(p.y) && p.x >= 0 && p.y >= 0 && p.x < COLS && p.y < ROWS;
  if(!onBoard(a) || !onBoard(b)){
    const d = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    return Number.isFinite(d) ? d : 99;
  }
  const stamp = w.version + ':' + COLS + 'x' + ROWS;
  if(fieldsFor !== w || fields.stamp !== stamp){ fields.clear(); fieldsFor = w; fields.stamp = stamp; }
  const key = b.x + ',' + b.y;
  let f = fields.get(key);
  if(!f){
    f = new Int16Array(COLS * ROWS).fill(99);
    const q = [[b.x, b.y]]; f[b.y * COLS + b.x] = 0;
    for(let i = 0; i < q.length; i++){
      const [x, y] = q[i], d = f[y * COLS + x];
      for(let dy = -1; dy <= 1; dy++) for(let dx = -1; dx <= 1; dx++){
        if(!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if(nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS || f[ny * COLS + nx] <= d + 1) continue;
        if(stepWaterIn(w, { x, y }, { x: nx, y: ny }) === 'river') continue;
        f[ny * COLS + nx] = d + 1; q.push([nx, ny]);
      }
    }
    fields.set(key, f);
  }
  return f[a.y * COLS + a.x];
}
