/* =========================================================
   REAL-TIME FIELD COMMAND: the simulation.

   Pure: no DOM, no wall clock, no imports from the turn-based engine. The
   whole battle is one plain object (createBattle) that saves to JSON and
   loads back (saveBattle / loadBattle); the dice live inside it (rng.js).
   step() advances it by exactly one tick, so the browser, the simulator and
   a future online host can all drive the same battle at their own speed.

   Every player or AI action is an ORDER OBJECT ({ unitId, type, target,
   tick }) passed through issueOrder(), the one place orders are checked.

   Phase 1 (this scaffold): units stand on the board and can be sent to a
   square. They travel square by square in real time along a grid path and
   never share a square. No order pool, cooldowns, range cap or combat yet.
========================================================= */
import { TRAVEL_TICKS, ROAD_TRAVEL_FACTOR } from './constants.js';

export const BATTLE_VERSION = 1;

/* terrain: rows of terrain keys; road: rows of booleans (road-like squares);
   units: [{ id, side, type, brigadeId, x, y }] as deployed. */
export function createBattle({ seed, terrain, road, units, playerSide }){
  return {
    version: BATTLE_VERSION,
    seed: seed >>> 0,
    rng: seed >>> 0,
    tick: 0,
    playerSide,
    cols: terrain[0].length,
    rows: terrain.length,
    terrain: terrain.map(r => r.slice()),
    road: road.map(r => r.slice()),
    units: units.map(u => ({
      id: u.id, side: u.side, type: u.type, brigadeId: u.brigadeId,
      x: u.x, y: u.y,
      removed: false,
      path: [],          // squares still to enter, in order
      step: null,        // { fromX, fromY, toX, toY, elapsed, total } while crossing a square
    })),
    orderLog: [],
  };
}

export const saveBattle = b => JSON.stringify(b);
export function loadBattle(json){
  const b = JSON.parse(json);
  if(b.version !== BATTLE_VERSION) throw new Error(`battle version ${b.version}, expected ${BATTLE_VERSION}`);
  return b;
}

const unitById = (b, id) => b.units.find(u => u.id === id);
const inBounds = (b, x, y) => x >= 0 && y >= 0 && x < b.cols && y < b.rows;

/* A square is taken if a unit stands on it or is crossing into it. */
function takenSquares(b, exceptId){
  const taken = new Set();
  for(const u of b.units){
    if(u.removed || u.id === exceptId) continue;
    taken.add(u.x + ',' + u.y);
    if(u.step) taken.add(u.step.toX + ',' + u.step.toY);
  }
  return taken;
}

/* Shortest grid path (eight directions) from a unit to a square, around
   squares already taken. Returns the squares to enter, or null. */
export function findPath(b, u, tx, ty){
  if(!inBounds(b, tx, ty)) return null;
  const taken = takenSquares(b, u.id);
  if(taken.has(tx + ',' + ty)) return null;
  const start = u.x + ',' + u.y, goal = tx + ',' + ty;
  if(start === goal) return [];
  const prev = new Map([[start, null]]);
  const queue = [[u.x, u.y]];
  for(let qi = 0; qi < queue.length; qi++){
    const [x, y] = queue[qi];
    for(const [dx, dy] of [[0,-1],[1,0],[0,1],[-1,0],[1,-1],[1,1],[-1,1],[-1,-1]]){
      const nx = x + dx, ny = y + dy, k = nx + ',' + ny;
      if(!inBounds(b, nx, ny) || prev.has(k) || taken.has(k)) continue;
      prev.set(k, x + ',' + y);
      if(k === goal){
        const out = [];
        for(let c = goal; c !== start; c = prev.get(c)){ const [px, py] = c.split(',').map(Number); out.unshift({ x: px, y: py }); }
        return out;
      }
      queue.push([nx, ny]);
    }
  }
  return null;
}

/* The one gate every order passes through. Returns { ok, reason }. Refused
   orders change nothing. */
export function issueOrder(b, order){
  const u = unitById(b, order.unitId);
  if(!u || u.removed) return { ok: false, reason: 'No such unit' };
  if(order.type === 'move'){
    const { x, y } = order.target || {};
    const path = findPath(b, u, x, y);
    if(!path) return { ok: false, reason: 'No way through' };
    if(!path.length) return { ok: false, reason: 'Already there' };
    u.path = path;
    b.orderLog.push({ ...order, tick: b.tick });
    return { ok: true };
  }
  return { ok: false, reason: 'Unknown order' };
}

function travelTicks(b, u, toX, toY){
  const base = TRAVEL_TICKS[u.type] || TRAVEL_TICKS.INFANTRY;
  const onRoad = b.road[u.y][u.x] && b.road[toY][toX];
  return Math.max(1, Math.round(onRoad ? base * ROAD_TRAVEL_FACTOR : base));
}

/* Advance the battle by one tick. */
export function step(b){
  b.tick += 1;
  for(const u of b.units){
    if(u.removed) continue;
    if(u.step){
      u.step.elapsed += 1;
      if(u.step.elapsed >= u.step.total){ u.x = u.step.toX; u.y = u.step.toY; u.step = null; }
      continue;
    }
    if(!u.path.length) continue;
    const next = u.path[0];
    // Reserve the next square before entering it; if someone got there first,
    // wait (Phase 2 adds the brief wait-then-repath rule).
    if(takenSquares(b, u.id).has(next.x + ',' + next.y)) continue;
    u.path.shift();
    u.step = { fromX: u.x, fromY: u.y, toX: next.x, toY: next.y, elapsed: 0, total: travelTicks(b, u, next.x, next.y) };
  }
}

/* Where a unit is drawn, as a fraction of the way through its current square.
   alpha (0 to 1) is how far the clock is past the last tick, so movement is
   smooth between ticks at any frame rate. */
export function visualPosition(u, alpha){
  if(!u.step) return { x: u.x, y: u.y };
  const t = Math.min(1, (u.step.elapsed + alpha) / u.step.total);
  return { x: u.step.fromX + (u.step.toX - u.step.fromX) * t, y: u.step.fromY + (u.step.toY - u.step.fromY) * t };
}
