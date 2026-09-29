/* =========================================================
   REAL-TIME FIELD COMMAND: the simulation.

   Pure: no DOM, no wall clock, no imports from the turn-based engine. The
   whole battle is one plain object (createBattle) that saves to JSON and
   loads back (saveBattle / loadBattle); the dice live inside it (rng.js).
   step() advances it by exactly one tick, so the browser, the simulator and
   a future online host can all drive the same battle at their own speed.

   Every player or AI action is an ORDER OBJECT passed through issueOrder()
   (one unit) or issueGroupOrder() (several at once): the only places orders
   are checked. A refused order changes nothing and says why.

   The rules the turn-based game already owns (how far a unit may move from
   where it stands, through which terrain, and whether it is on its
   Brigadier's chain) are not copied here. They come in through a RULES
   adapter, { inChain(b, u), reachable(b, u) }, which the browser builds on
   the turn-based engine itself (rules-adapter.js) and the tests stub. So a
   ruling can never drift between the two games.

   Phase 2, the command system:
   - ORDER POOL. Each Brigadier's pool gains one order every ORDER_REGEN_TICKS,
     banked up to one per living unit under his command, and starts full.
     Every order costs one, except moving the Brigadier himself.
   - COOLDOWN. An order starts the unit's cooldown; it can be ordered again
     only once it has stopped AND the cooldown has run out.
   - RANGE. One order moves a unit no further than its turn-based allowance.
   - CHAIN. Checked at the moment of every order: a unit off its Brigadier's
     chain finishes what it is doing but can be given nothing new.
   - GROUP. Several units at once, each finding its own square and its own
     path; if the pool is short, or any one of them cannot go, none go.
   - ON THE WAY. Paths keep off squares next to an enemy unless the
     destination is next to one; a unit that finds an enemy beside it mid-route
     stops there (contact is commitment); a unit whose next square is taken
     waits briefly, then finds another way, or stops if there is none.
========================================================= */
import { BLOCKED_WAIT_TICKS, COOLDOWN_TICKS, GROUP_SPREAD, ORDER_REGEN_TICKS, ROAD_TRAVEL_FACTOR, TRAVEL_TICKS } from './constants.js';

export const BATTLE_VERSION = 2;

/* terrain: rows of terrain keys; road: rows of booleans (road-like squares);
   units: [{ id, side, type, brigadeId, x, y }] as deployed. */
export function createBattle({ seed, terrain, road, units, playerSide }){
  const b = {
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
      goal: null,          // where the current order is taking it
      path: [],            // squares still to enter, in order
      step: null,          // { fromX, fromY, toX, toY, elapsed, total } while crossing a square
      blocked: 0,          // ticks spent waiting for the next square
      cooldownUntil: 0,    // tick from which it can take a new order (once stopped)
      cooldownFrom: 0,
    })),
    pools: {},
    orderLog: [],
  };
  for(const key of brigadeKeys(b)) b.pools[key] = { orders: poolCap(b, key), sinceRegen: 0 };
  return b;
}

export const saveBattle = b => JSON.stringify(b);
export function loadBattle(json){
  const b = JSON.parse(json);
  if(b.version !== BATTLE_VERSION) throw new Error(`battle version ${b.version}, expected ${BATTLE_VERSION}`);
  return b;
}

/* ---------------------------------------------------------
   Brigades and their order pools
--------------------------------------------------------- */
export const brigadeKey = u => u.side + ':' + u.brigadeId;
function brigadeKeys(b){ return [...new Set(b.units.map(brigadeKey))]; }
export function poolCap(b, key){
  return b.units.filter(u => !u.removed && u.type !== 'BRIGADIER' && brigadeKey(u) === key).length;
}
export function poolOf(b, u){
  const key = brigadeKey(u);
  const p = b.pools[key] || (b.pools[key] = { orders: 0, sinceRegen: 0 });
  return { key, pool: p, cap: poolCap(b, key) };
}
const orderCost = u => u.type === 'BRIGADIER' ? 0 : 1;

/* ---------------------------------------------------------
   Squares and paths
--------------------------------------------------------- */
const unitById = (b, id) => b.units.find(u => u.id === id);
const inBounds = (b, x, y) => x >= 0 && y >= 0 && x < b.cols && y < b.rows;
const DIRS = [[0,-1],[1,0],[0,1],[-1,0],[1,-1],[1,1],[-1,1],[-1,-1]];
export const isBusy = u => !!(u.step || u.path.length);
const cheb = (a, c) => Math.max(Math.abs(a.x - c.x), Math.abs(a.y - c.y));

/* A square is taken if a unit stands on it or is crossing into it. */
function takenSquares(b, exceptIds){
  const skip = exceptIds instanceof Set ? exceptIds : new Set(exceptIds ? [exceptIds] : []);
  const taken = new Set();
  for(const u of b.units){
    if(u.removed || skip.has(u.id)) continue;
    taken.add(u.x + ',' + u.y);
    if(u.step) taken.add(u.step.toX + ',' + u.step.toY);
  }
  return taken;
}
function enemyAdjacentSquares(b, side){
  const near = new Set();
  for(const e of b.units){
    if(e.removed || e.side === side) continue;
    for(const [dx, dy] of DIRS) near.add((e.x + dx) + ',' + (e.y + dy));
  }
  return near;
}
export function enemyBeside(b, u){
  return b.units.some(e => !e.removed && e.side !== u.side && cheb(e, u) === 1);
}

/* Shortest grid path (eight directions) to a square, around taken squares.
   Keeps off squares next to an enemy where it can, unless the destination is
   itself next to one; falls back to the plain shortest path if that is the
   only way. Returns the squares to enter, or null. */
export function findPath(b, u, tx, ty, taken = takenSquares(b, u.id)){
  if(!inBounds(b, tx, ty) || taken.has(tx + ',' + ty)) return null;
  if(u.x === tx && u.y === ty) return [];
  const avoid = enemyAdjacentSquares(b, u.side);
  const destNearEnemy = avoid.has(tx + ',' + ty);
  const bfs = blocked => {
    const start = u.x + ',' + u.y, goal = tx + ',' + ty;
    const prev = new Map([[start, null]]);
    const queue = [[u.x, u.y]];
    for(let qi = 0; qi < queue.length; qi++){
      const [x, y] = queue[qi];
      for(const [dx, dy] of DIRS){
        const nx = x + dx, ny = y + dy, k = nx + ',' + ny;
        if(!inBounds(b, nx, ny) || prev.has(k) || taken.has(k)) continue;
        if(k !== goal && blocked.has(k)) continue;
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
  };
  return (destNearEnemy ? null : bfs(avoid)) || bfs(new Set());
}

/* ---------------------------------------------------------
   Orders
--------------------------------------------------------- */
/* Can this unit take an order at all right now? A refusal reason, or null. */
function readiness(b, u, rules){
  if(!u || u.removed) return 'No such unit';
  if(isBusy(u)) return 'Still moving';
  if(b.tick < u.cooldownUntil) return 'Not ready yet';
  if(!rules.inChain(b, u)) return 'Out of the chain';
  return null;
}
function reachableSet(b, u, rules){
  const m = new Map();
  for(const c of rules.reachable(b, u)) m.set(c.x + ',' + c.y, c);
  return m;
}
function commitMove(b, u, target, path, order){
  u.goal = { x: target.x, y: target.y };
  u.path = path;
  u.blocked = 0;
  u.cooldownFrom = b.tick;
  u.cooldownUntil = b.tick + (COOLDOWN_TICKS[u.type] || COOLDOWN_TICKS.INFANTRY);
  poolOf(b, u).pool.orders -= orderCost(u);
  b.orderLog.push({ type: order.type, group: !!order.group, side: order.side || u.side, unitId: u.id, target: { x: target.x, y: target.y }, tick: b.tick });
}

/* One unit. order = { unitId, type: 'move', target: { x, y }, side? } */
export function issueOrder(b, order, rules){
  const u = unitById(b, order.unitId);
  if(order.side && u && u.side !== order.side) return { ok: false, reason: 'Not your unit' };
  const notReady = readiness(b, u, rules);
  if(notReady) return { ok: false, reason: notReady };
  if(order.type !== 'move') return { ok: false, reason: 'Unknown order' };
  const { x, y } = order.target || {};
  if(u.x === x && u.y === y) return { ok: false, reason: 'Already there' };
  if(poolOf(b, u).pool.orders < orderCost(u)) return { ok: false, reason: 'No orders left' };
  if(!reachableSet(b, u, rules).has(x + ',' + y)) return { ok: false, reason: 'Out of range' };
  const path = findPath(b, u, x, y);
  if(!path) return { ok: false, reason: 'No way through' };
  commitMove(b, u, { x, y }, path, order);
  return { ok: true };
}

/* Several units to one place: the unit nearest the tapped square takes it,
   the rest the nearest free squares around it (within GROUP_SPREAD) that each
   can reach, each by its own path. All or nothing.
   order = { unitIds, type: 'move', target: { x, y }, side? } */
export function issueGroupOrder(b, order, rules){
  const units = [...new Set(order.unitIds)].map(id => unitById(b, id));
  if(!units.length) return { ok: false, reason: 'Nothing selected' };
  for(const u of units){
    if(order.side && u && u.side !== order.side) return { ok: false, reason: 'Not your unit' };
    const notReady = readiness(b, u, rules);
    if(notReady) return { ok: false, reason: notReady };
  }
  // The pool must cover every unit asked to move, brigade by brigade.
  const need = {};
  for(const u of units){ const k = brigadeKey(u); need[k] = (need[k] || 0) + orderCost(u); }
  for(const [k, n] of Object.entries(need)){
    if((b.pools[k] ? b.pools[k].orders : 0) < n) return { ok: false, reason: 'No orders left' };
  }
  const target = order.target || {};
  const movers = new Set(units.map(u => u.id));
  const taken = takenSquares(b, movers);                 // the group's own squares are free for it to use
  const candidates = [];
  for(let dy = -GROUP_SPREAD; dy <= GROUP_SPREAD; dy++) for(let dx = -GROUP_SPREAD; dx <= GROUP_SPREAD; dx++){
    const c = { x: target.x + dx, y: target.y + dy };
    if(inBounds(b, c.x, c.y)) candidates.push(c);
  }
  candidates.sort((a, c) => cheb(a, target) - cheb(c, target) ||
    (Math.abs(a.x - target.x) + Math.abs(a.y - target.y)) - (Math.abs(c.x - target.x) + Math.abs(c.y - target.y)));
  const sorted = units.slice().sort((a, c) => cheb(a, target) - cheb(c, target));
  const plan = [];
  const claimed = new Set();
  for(const u of sorted){
    const reach = reachableSet(b, u, rules);
    const chosen = candidates.find(c => {
      const k = c.x + ',' + c.y;
      return !claimed.has(k) && !taken.has(k) && ((u.x === c.x && u.y === c.y) || reach.has(k));
    });
    if(!chosen) return { ok: false, reason: 'Out of range' };
    claimed.add(chosen.x + ',' + chosen.y);
    plan.push({ u, target: chosen });
  }
  // Each path treats the rest of the group's destinations as taken, so no two
  // plan to end on one square.
  const committed = [];
  for(const { u, target: t } of plan){
    if(u.x === t.x && u.y === t.y){ committed.push({ u, target: t, path: [] }); continue; }
    const blocked = new Set(taken);
    for(const o of plan) if(o.u !== u) blocked.add(o.target.x + ',' + o.target.y);
    const path = findPath(b, u, t.x, t.y, blocked);
    if(!path) return { ok: false, reason: 'No way through' };
    committed.push({ u, target: t, path });
  }
  let moved = 0;
  for(const { u, target: t, path } of committed){
    if(!path.length) continue;                          // already on its square: nothing spent
    commitMove(b, u, t, path, { type: 'move', group: true, side: order.side });
    moved++;
  }
  return { ok: true, moved };
}

/* ---------------------------------------------------------
   The tick
--------------------------------------------------------- */
function travelTicks(b, u, toX, toY){
  const base = TRAVEL_TICKS[u.type] || TRAVEL_TICKS.INFANTRY;
  const onRoad = b.road[u.y][u.x] && b.road[toY][toX];
  return Math.max(1, Math.round(onRoad ? base * ROAD_TRAVEL_FACTOR : base));
}

export function step(b){
  b.tick += 1;
  // Couriers: every Brigadier's pool gains one order every ORDER_REGEN_TICKS, up to its cap.
  for(const [key, p] of Object.entries(b.pools)){
    const cap = poolCap(b, key);
    if(p.orders > cap) p.orders = cap;               // units lost: the cap, and anything above it, shrinks
    if(p.orders >= cap){ p.sinceRegen = 0; continue; }
    if(++p.sinceRegen >= ORDER_REGEN_TICKS){ p.sinceRegen = 0; p.orders += 1; }
  }
  for(const u of b.units){
    if(u.removed) continue;
    if(u.step){
      u.step.elapsed += 1;
      if(u.step.elapsed >= u.step.total){
        u.x = u.step.toX; u.y = u.step.toY; u.step = null;
        // Contact is commitment: with an enemy beside it now, it goes no further.
        if(u.path.length && enemyBeside(b, u)) u.path = [];
        if(!u.path.length) u.goal = null;
      }
      continue;
    }
    if(!u.path.length) continue;
    const next = u.path[0];
    if(takenSquares(b, u.id).has(next.x + ',' + next.y)){
      // Someone is in the way: wait a moment, then find another way round.
      if(++u.blocked < BLOCKED_WAIT_TICKS) continue;
      u.blocked = 0;
      const again = u.goal ? findPath(b, u, u.goal.x, u.goal.y) : null;
      if(again && again.length) u.path = again; else { u.path = []; u.goal = null; }
      continue;
    }
    u.blocked = 0;
    u.path.shift();
    u.step = { fromX: u.x, fromY: u.y, toX: next.x, toY: next.y, elapsed: 0, total: travelTicks(b, u, next.x, next.y) };
  }
}

/* How far through its cooldown a unit is, 0 (just ordered) to 1 (ready).
   Still moving counts as not quite ready, whatever the timer says. */
export function readiness01(b, u){
  const r = u.cooldownUntil <= u.cooldownFrom ? 1
    : Math.min(1, Math.max(0, (b.tick - u.cooldownFrom) / (u.cooldownUntil - u.cooldownFrom)));
  return isBusy(u) ? Math.min(r, 0.999) : r;
}

/* Where a unit is drawn, as a fraction of the way through its current square.
   alpha (0 to 1) is how far the clock is past the last tick, so movement is
   smooth between ticks at any frame rate. */
export function visualPosition(u, alpha){
  if(!u.step) return { x: u.x, y: u.y };
  const t = Math.min(1, (u.step.elapsed + alpha) / u.step.total);
  return { x: u.step.fromX + (u.step.toX - u.step.fromX) * t, y: u.step.fromY + (u.step.toY - u.step.fromY) * t };
}
