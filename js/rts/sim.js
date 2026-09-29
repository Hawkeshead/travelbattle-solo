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
import { ARTILLERY_RELOAD_TICKS, BLOCKED_WAIT_TICKS, COOLDOWN_TICKS, FORM_TICKS, GROUP_SPREAD, LIMBER_TICKS, MATCH_CLOCK_TICKS,
         MELEE_ROUND_TICKS, MID_FORMATION_PENALTY, ORDER_REGEN_TICKS, PUSHBACK_TRAVEL_FACTOR, RALLY_ON, ROAD_TRAVEL_FACTOR,
         POINT_VALUE, ROUT_TO_RALLY_TICKS, TRAVEL_TICKS, TURNED_AROUND_TICKS, WOODS_OCCUPANCY_TICKS } from './constants.js';
import { nextRandom } from './rng.js';

export const BATTLE_VERSION = 5;

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
      arrivedTick: -1,     // when it last finished a square (decides who attacked)
      turnedUntil: 0,      // turned around until this tick: attackers +1, no orders
      routing: false,      // running for its own edge after a rallied rout
      rallyUntil: 0,       // rallying at the edge until this tick: no orders
      formation: 'line',   // 'line' or 'square'
      forming: null,       // { to, until } while changing formation (or laying an ambush)
      hidden: false,       // a laid ambush: unseen, and springs when an enemy steps beside it
      lock: null,          // artillery: the unit it keeps firing at
      nextShot: 0,
      limberUntil: 0,      // artillery: limbering up before it moves
      enteredTick: 0,      // when it arrived on its current square (woods defence)
      lastDir: null, straightRun: 0,   // squares crossed in one straight line without stopping (the charge)
      column: null,        // { partner, lead } once two stacked foot units have formed Column
      stackInto: null,     // the friendly unit it is marching to stack with
    })),
    pools: {},
    leadershipUsed: {},    // brigade key: its Brigadier's one save has been spent
    fights: {},            // pair key: { a, d, next, rounds }
    homeRow: { red: terrain.length - 1, blue: 0 },
    events: [],            // recent dice results and what they did, for pop-ups and records
    eventCount: 0,
    stats: { rounds: 0, fights: 0, destroyed: { red: 0, blue: 0 }, lostValue: { red: 0, blue: 0 } },
    over: false,
    winner: null,
    result: null,          // 'break', or 'clock' (points) when the match clock runs out
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
const isFoot = u => u.type === 'INFANTRY' || u.type === 'GUARD';

/* COLUMNS. Two foot units stack in one square first (the second marches onto
   the first, where the turn-based rules allow doubling), then Form Column:
   from then on they move as one massed unit, the lead unit carrying the
   orders and its partner keeping step. Each still fights its own fights; a
   formed Column gets the turn-based Attack Column bonus and wins ties when it
   attacks. Only the unit that loses a fight falls back, which breaks the
   Column; a roundshot strikes both halves (and any stacked pair). */
export function stackPartner(b, u){
  return b.units.find(o => !o.removed && o.id !== u.id && o.side === u.side && o.x === u.x && o.y === u.y && !o.step && isFoot(o)) || null;
}
export function columnLead(b, u){
  if(!u || !u.column) return u;
  return u.column.lead ? u : unitById(b, u.column.partner) || u;
}
function breakColumn(b, u){
  if(!u || !u.column) return;
  const p = unitById(b, u.column.partner);
  u.column = null;
  if(p){ p.column = null; p.forming = null; }
}
const cheb = (a, c) => Math.max(Math.abs(a.x - c.x), Math.abs(a.y - c.y));

/* A square is taken if a unit stands on it or is crossing into it. */
function takenSquares(b, exceptIds){
  const skip = new Set(exceptIds instanceof Set ? exceptIds : (exceptIds ? [exceptIds] : []));
  for(const id of [...skip]){ const u = unitById(b, id); if(u && u.column) skip.add(u.column.partner); }   // a Column moves as one
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
    if(e.removed || e.side === side || e.hidden) continue;   // a hidden ambush is not seen, so not avoided
    for(const [dx, dy] of DIRS) near.add((e.x + dx) + ',' + (e.y + dy));
  }
  return near;
}
export function enemyBeside(b, u){
  return b.units.some(e => !e.removed && !e.hidden && e.side !== u.side && cheb(e, u) === 1);
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
  if(b.over) return 'The battle is over';
  if(u.routing) return 'Routing';
  if(b.tick < u.rallyUntil) return 'Rallying';
  if(b.tick < u.turnedUntil) return 'Turned around';
  if(u.forming) return 'Changing formation';
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
  if(u.type === 'ARTILLERY'){ u.lock = null; u.limberUntil = b.tick + LIMBER_TICKS; }
  u.straightRun = 0; u.lastDir = null;
  u.goal = { x: target.x, y: target.y };
  u.path = path;
  u.blocked = 0;
  u.cooldownFrom = b.tick;
  u.cooldownUntil = b.tick + (COOLDOWN_TICKS[u.type] || COOLDOWN_TICKS.INFANTRY);
  poolOf(b, u).pool.orders -= orderCost(u);
  b.orderLog.push({ type: order.type, group: !!order.group, side: order.side || u.side, unitId: u.id, target: { x: target.x, y: target.y }, tick: b.tick });
}

function spendOrder(b, u, order, extra){
  u.cooldownFrom = b.tick;
  u.cooldownUntil = b.tick + (COOLDOWN_TICKS[u.type] || COOLDOWN_TICKS.INFANTRY);
  poolOf(b, u).pool.orders -= orderCost(u);
  b.orderLog.push({ type: order.type, side: order.side || u.side, unitId: u.id, tick: b.tick, ...extra });
}

/* ARTILLERY: one order locks a gun onto a target; it fires at once and then
   every ARTILLERY_RELOAD_TICKS until the target is gone, leaves range or line
   of sight, or the gun is given a new order. */
function fireOrder(b, u, order, rules){
  if(u.type !== 'ARTILLERY') return { ok: false, reason: 'Only guns fire' };
  const t = unitById(b, order.targetId);
  if(!t || t.removed || t.side === u.side) return { ok: false, reason: 'No target' };
  if(enemyBeside(b, u)) return { ok: false, reason: 'Gun is in a fight' };
  if(poolOf(b, u).pool.orders < orderCost(u)) return { ok: false, reason: 'No orders left' };
  if(!rules.canFireAt(b, u, t)) return { ok: false, reason: 'No line of fire' };
  u.lock = t.id;
  u.nextShot = b.tick + 1;
  spendOrder(b, u, order, { targetId: t.id });
  return { ok: true };
}

/* FORMATIONS: Square (infantry and Guard; cannot move, and does not start
   fights), Line (back out of Square), and Lay Ambush (infantry and Guard in
   woods, with no enemy beside it). Each costs an order and takes time; a unit
   caught mid-change fights at a penalty. */
function formOrder(b, u, order, rules){
  const to = order.formation;
  const foot = u.type === 'INFANTRY' || u.type === 'GUARD';
  const partner = stackPartner(b, u);
  if(to === 'square'){
    if(!foot) return { ok: false, reason: 'Only infantry form Square' };
    if(u.formation === 'square') return { ok: false, reason: 'Already in Square' };
    if(partner || u.column) return { ok: false, reason: 'Needs the square to itself' };
  } else if(to === 'column'){
    if(!foot) return { ok: false, reason: 'Only infantry form Column' };
    if(u.column) return { ok: false, reason: 'Already in Column' };
    if(!partner) return { ok: false, reason: 'Stack two infantry first' };
    if(partner.formation === 'square' || partner.hidden || partner.column) return { ok: false, reason: 'Partner cannot join' };
    const pr = readiness(b, partner, rules);
    if(pr) return { ok: false, reason: 'Partner: ' + pr };
  } else if(to === 'line'){
    if(u.formation !== 'square' && !u.column) return { ok: false, reason: 'Already in Line' };
  } else if(to === 'ambush'){
    if(partner) return { ok: false, reason: 'Needs the square to itself' };
    if(!foot) return { ok: false, reason: 'Only infantry lay ambushes' };
    if(b.terrain[u.y][u.x] !== 'WOODS') return { ok: false, reason: 'Ambush needs woods' };
    if(u.hidden) return { ok: false, reason: 'Already in ambush' };
    if(enemyBeside(b, u)) return { ok: false, reason: 'Enemy too close' };
  } else return { ok: false, reason: 'Unknown formation' };
  if(poolOf(b, u).pool.orders < orderCost(u)) return { ok: false, reason: 'No orders left' };
  const ticks = to === 'square' ? FORM_TICKS.SQUARE : to === 'ambush' ? FORM_TICKS.AMBUSH : to === 'column' ? FORM_TICKS.COLUMN : FORM_TICKS.LINE;
  u.forming = { to, until: b.tick + ticks, lead: true };
  const mate = to === 'column' ? partner : (u.column ? unitById(b, u.column.partner) : null);
  if(mate){ mate.forming = { to, until: u.forming.until, lead: false }; mate.cooldownFrom = b.tick; mate.cooldownUntil = b.tick + (COOLDOWN_TICKS[mate.type] || COOLDOWN_TICKS.INFANTRY); }
  if(to === 'column') u.forming.partner = partner.id;
  spendOrder(b, u, order, { formation: to });
  note(b, 'form', u, to === 'square' ? 'Forming Square' : to === 'ambush' ? 'Laying ambush' : to === 'column' ? 'Forming Column' : 'Forming Line');
  return { ok: true };
}

/* One unit. order = { unitId, type: 'move', target: { x, y }, side? } */
export function issueOrder(b, order, rules){
  let u = unitById(b, order.unitId);
  if(order.side && u && u.side !== order.side) return { ok: false, reason: 'Not your unit' };
  if(u && u.column && order.type !== 'form') u = columnLead(b, u);      // a Column takes its orders through its lead unit
  const notReady = readiness(b, u, rules) || (u && u.column ? readiness(b, unitById(b, u.column.partner), rules) : null);
  if(notReady) return { ok: false, reason: notReady };
  if(order.type === 'fire') return fireOrder(b, u, order, rules);
  if(order.type === 'form') return formOrder(b, u, order, rules);
  if(order.type !== 'move') return { ok: false, reason: 'Unknown order' };
  if(u.formation === 'square') return { ok: false, reason: 'In Square: form Line first' };
  const { x, y } = order.target || {};
  if(u.x === x && u.y === y) return { ok: false, reason: 'Already there' };
  if(poolOf(b, u).pool.orders < orderCost(u)) return { ok: false, reason: 'No orders left' };
  if(!reachableSet(b, u, rules).has(x + ',' + y)) return { ok: false, reason: 'Out of range' };
  // Stacking: marching onto a lone friendly foot unit that is standing still.
  const there = b.units.filter(o => !o.removed && o.id !== u.id && (o.x === x && o.y === y || (o.step && o.step.toX === x && o.step.toY === y)));
  let stackInto = null;
  if(there.length){
    const f = there[0];
    const canStack = there.length === 1 && f.side === u.side && isFoot(u) && isFoot(f) && !u.column && !f.column &&
      f.formation !== 'square' && !f.hidden && !f.forming && !isBusy(f);
    if(!canStack) return { ok: false, reason: 'Square is taken' };
    stackInto = f.id;
  }
  const taken = takenSquares(b, stackInto ? new Set([u.id, stackInto]) : u.id);
  const path = findPath(b, u, x, y, taken);
  if(!path) return { ok: false, reason: 'No way through' };
  commitMove(b, u, { x, y }, path, order);
  u.stackInto = stackInto;
  if(u.column){ const p = unitById(b, u.column.partner); p.cooldownFrom = u.cooldownFrom; p.cooldownUntil = u.cooldownUntil; }
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
    if(u.formation === 'square') return { ok: false, reason: 'In Square: form Line first' };
    if(u.column) return { ok: false, reason: 'Columns move on their own' };
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

export function step(b, rules){
  if(b.over) return;
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
    if(u.column && !u.column.lead) continue;            // keeps step with its lead (below)
    if(u.step){
      u.step.elapsed += 1;
      if(u.step.elapsed >= u.step.total){
        const dir = (u.step.toX - u.step.fromX) + ',' + (u.step.toY - u.step.fromY);
        u.straightRun = (u.lastDir === dir) ? u.straightRun + 1 : 1;
        u.lastDir = dir;
        u.x = u.step.toX; u.y = u.step.toY; u.step = null;
        u.arrivedTick = b.tick;
        u.enteredTick = b.tick;
        if(u.hidden && b.terrain[u.y][u.x] !== 'WOODS') u.hidden = false;   // an ambush cannot leave the trees
        // Contact is commitment: with an enemy beside it now, it goes no further.
        // (A routing unit is running, not advancing, and keeps going.)
        if(u.path.length && !u.routing && enemyBeside(b, u)) u.path = [];
        if(!u.path.length){
          u.goal = null; u.stackInto = null;
          if(u.routing){ u.routing = false; u.rallyUntil = b.tick + ROUT_TO_RALLY_TICKS; u.turnedUntil = Math.max(u.turnedUntil, u.rallyUntil); }
        }
      }
      continue;
    }
    if(u.forming && b.tick >= u.forming.until){
      const f = u.forming;
      u.forming = null;
      if(f.to === 'ambush'){ u.hidden = true; note(b, 'form', u, 'Hidden'); }
      else if(f.to === 'column'){
        const p = unitById(b, f.partner);
        if(f.lead && p && !p.removed && p.x === u.x && p.y === u.y){
          u.column = { partner: p.id, lead: true }; p.column = { partner: u.id, lead: false }; p.forming = null;
          note(b, 'form', u, 'In Column');
        }
      } else if(f.to === 'line'){
        if(u.column){ if(f.lead) note(b, 'form', u, 'Column split'); breakColumn(b, u); }
        else { u.formation = 'line'; note(b, 'form', u, 'In Line'); }
      } else { u.formation = f.to; note(b, 'form', u, 'In Square'); }
    }
    if(!u.path.length){ if(b.tick - u.arrivedTick > 1){ u.straightRun = 0; u.lastDir = null; } continue; }
    if(b.tick < u.limberUntil) continue;                // limbering up
    const next = u.path[0];
    const stacking = u.stackInto && u.path.length === 1 && (() => {
      const f = unitById(b, u.stackInto);
      const there = b.units.filter(o => !o.removed && o.id !== u.id && (o.x === next.x && o.y === next.y || (o.step && o.step.toX === next.x && o.step.toY === next.y)));
      return f && there.length === 1 && there[0] === f && !isBusy(f);
    })();
    if(!stacking && takenSquares(b, u.id).has(next.x + ',' + next.y)){
      // Someone is in the way: wait a moment, then find another way round.
      if(++u.blocked < BLOCKED_WAIT_TICKS) continue;
      u.blocked = 0;
      const again = u.goal ? findPath(b, u, u.goal.x, u.goal.y) : null;
      if(again && again.length) u.path = again;
      else {
        u.path = []; u.goal = null;
        if(u.routing){ u.routing = false; u.rallyUntil = b.tick + ROUT_TO_RALLY_TICKS; u.turnedUntil = Math.max(u.turnedUntil, u.rallyUntil); }
      }
      continue;
    }
    u.blocked = 0;
    u.path.shift();
    const total = u.pushed ? Math.max(1, Math.round(travelTicks(b, u, next.x, next.y) * PUSHBACK_TRAVEL_FACTOR)) : travelTicks(b, u, next.x, next.y);
    u.pushed = false;
    u.step = { fromX: u.x, fromY: u.y, toX: next.x, toY: next.y, elapsed: 0, total };
  }
  // Column partners keep step with their lead unit.
  for(const f of b.units){
    if(f.removed || !f.column || f.column.lead) continue;
    const L = unitById(b, f.column.partner);
    if(!L || L.removed){ breakColumn(b, f); continue; }
    f.x = L.x; f.y = L.y; f.step = L.step ? { ...L.step } : null; f.path = [];
    f.arrivedTick = L.arrivedTick; f.enteredTick = L.enteredTick; f.straightRun = L.straightRun; f.lastDir = L.lastDir;
  }
  if(rules && rules.fightDice) melee(b, rules);
  if(rules && rules.canFireAt) artillery(b, rules);
  if(!b.over && b.tick >= MATCH_CLOCK_TICKS) clockOut(b);
}

/* THE MATCH CLOCK. If no army has broken when it runs out, the battle goes on
   points: the value of every enemy unit destroyed (POINT_VALUE: Guard,
   cavalry and guns worth more than line infantry). Level is a draw. */
export function points(b, side){ return b.stats.lostValue[side === 'red' ? 'blue' : 'red'] || 0; }
function clockOut(b){
  b.over = true; b.result = 'clock';
  const r = points(b, 'red'), bl = points(b, 'blue');
  b.winner = r > bl ? 'red' : bl > r ? 'blue' : null;
  note(b, 'break', null, b.winner ? `Time: ${b.winner} ahead on points` : 'Time: drawn');
}

/* =========================================================
   ARTILLERY (Phase 4), as fireArtillery in turn-based: range N needs N+ to
   hit; at 2 squares or less canister rolls two dice for both the hit and the
   effect; a kept 6 to hit adds +1 to the effect (Crack Shot); effect +1
   against a Square or a unit already turned around, -1 in woods or a
   building; 4 turns it around, 5 routs it, 6 destroys it. Line of sight and
   targeting rules come from the turn-based engine and are checked before
   every shot. A gun with an enemy beside it holds fire (it is fighting).
========================================================= */
function artillery(b, rules){
  for(const g of b.units){
    if(g.removed || g.type !== 'ARTILLERY' || !g.lock) continue;
    const t = unitById(b, g.lock);
    if(!t || t.removed){ g.lock = null; note(b, 'lock', g, 'Target gone'); continue; }
    if(isBusy(g) || enemyBeside(b, g) || b.tick < g.nextShot) continue;
    if(!rules.canFireAt(b, g, t)){ g.lock = null; note(b, 'lock', g, 'Lost the line of fire'); continue; }
    g.nextShot = b.tick + ARTILLERY_RELOAD_TICKS;
    shoot(b, rules, g, t);
  }
}
function shoot(b, rules, g, t){
  b.stats.shots = (b.stats.shots || 0) + 1;
  const dist = cheb(g, t);
  const canister = dist <= 2;
  const hit = rollBest(b, canister ? 2 : 1).best;
  if(hit < dist){ note(b, 'shot', t, `Miss (${hit})`); return; }
  const crack = hit === 6 ? 1 : 0;
  const eff = rollBest(b, canister ? 2 : 1).best;
  // A roundshot goes through a doubled stand: both halves share the effect,
  // at +1 (and the turned-around +1 only if both already are).
  const mate = stackPartner(b, t);
  const stack = mate && !t.step ? [t, mate] : [t];
  const shaken = stack.every(u => b.tick < u.turnedUntil);
  const bonus = ((t.formation === 'square' || stack.length > 1) ? 1 : 0) + (shaken ? 1 : 0) + crack - (rules.inCover(b, t) ? 1 : 0);
  const e = Math.max(1, Math.min(6, eff + bonus));
  if(e <= 3){ note(b, 'shot', t, `Hit, no effect (${e})`); return; }
  b.stats.artilleryKills = b.stats.artilleryKills || 0;
  for(const u of stack){
    if(u.removed) continue;
    if(e === 4){ u.turnedUntil = Math.max(u.turnedUntil, b.tick + TURNED_AROUND_TICKS); u.path = []; u.goal = null; note(b, 'shot', u, 'Shaken: turned around'); }
    else if(e === 5){ note(b, 'shot', u, 'Roundshot: routed'); rout(b, u); }
    else { note(b, 'shot', u, 'Roundshot: destroyed'); b.stats.artilleryKills += 1; destroy(b, u); }
  }
}

/* =========================================================
   MELEE (Phase 3)

   Any two enemy units side by side fight, with no order needed: one fight per
   pair, each on its own round timer, so a unit with two enemies beside it
   fights both. The first round comes MELEE_ROUND_TICKS after contact.

   The ATTACKER is the unit that arrived into contact (the later of the two to
   finish a square), fixed for as long as the pair stays in contact; exact
   ties are settled by the battle's dice. Dice and bonuses come from the
   turn-based engine's own combatBonuses through the rules adapter; the round
   itself follows resolveFight: best die of each side plus bonuses, +1 against
   a unit turned around, Guard and Heavy Cavalry re-roll when losing (taken
   automatically: the battle never stops to ask), a tie drawn unless the
   defender holds higher ground. Margin 1 pushes the loser back, 2 routs it,
   3 or more destroys it. The winner holds its ground.

   Brigadiers do not fight: the turn-based rules never let one be attacked,
   and a Brigadier escorts rather than engages.
========================================================= */
const pairKey = (p, q) => p.id < q.id ? p.id + '|' + q.id : q.id + '|' + p.id;
const d6 = b => 1 + Math.floor(nextRandom(b) * 6);
function rollBest(b, n){ let best = 0; const all = []; for(let i = 0; i < Math.max(1, n); i++){ const r = d6(b); all.push(r); if(r > best) best = r; } return { best, all }; }
function note(b, kind, u, text, extra){
  b.eventCount += 1;
  b.events.push({ n: b.eventCount, tick: b.tick, kind, unitId: u ? u.id : null, side: u ? u.side : null, x: u ? u.x : null, y: u ? u.y : null, text, ...(extra || {}) });
  if(b.events.length > 200) b.events.shift();
}
const fightsWith = u => u && !u.removed && !u.routing && u.type !== 'BRIGADIER';
const isCav = u => u.type === 'LIGHT_CAV' || u.type === 'HEAVY_CAV';

function melee(b, rules){
  // A laid ambush springs the moment an enemy steps beside it: the ambusher
  // strikes first, at once, with +1 on that round, and the enemy halts.
  for(const amb of b.units){
    if(!amb.hidden || !fightsWith(amb)) continue;
    const foe = b.units.find(e => fightsWith(e) && e.side !== amb.side && cheb(e, amb) === 1);
    if(!foe) continue;
    amb.hidden = false;
    foe.path = []; foe.goal = null;
    note(b, 'ambush', amb, 'Ambush!');
    if(!rules.canAttack(b, amb, foe)) continue;
    b.fights[pairKey(amb, foe)] = { a: amb.id, d: foe.id, next: b.tick, rounds: 0, ambush: true };
    b.stats.fights += 1;
  }
  const live = b.units.filter(u => fightsWith(u) && !u.hidden);
  // New contacts.
  for(let i = 0; i < live.length; i++) for(let j = i + 1; j < live.length; j++){
    const p = live[i], q = live[j];
    if(p.side === q.side || cheb(p, q) !== 1) continue;
    const key = pairKey(p, q);
    if(b.fights[key]) continue;
    let att = p.arrivedTick > q.arrivedTick ? p : q.arrivedTick > p.arrivedTick ? q : (nextRandom(b) < 0.5 ? p : q);
    let def = att === p ? q : p;
    // A Square does not start fights (turn-based house rule W4): the other side attacks it.
    const mayStart = (x, y) => x.formation !== 'square' && rules.canAttack(b, x, y);
    if(!mayStart(att, def)){
      if(!mayStart(def, att)) continue;                  // neither may attack the other (e.g. horse against a village, or two Squares)
      [att, def] = [def, att];
    }
    // A charge: cavalry that crossed two squares in one straight line and arrived into this contact.
    const charge = isCav(att) && att.arrivedTick === b.tick && att.straightRun >= 2;
    b.fights[key] = { a: att.id, d: def.id, next: b.tick + MELEE_ROUND_TICKS, rounds: 0, charge };
    b.stats.fights += 1;
    note(b, 'contact', def, 'Contact');
  }
  // Rounds due, and fights that have ended.
  for(const [key, f] of Object.entries(b.fights)){
    const A = unitById(b, f.a), D = unitById(b, f.d);
    if(!fightsWith(A) || !fightsWith(D) || cheb(A, D) !== 1){ delete b.fights[key]; continue; }
    if(b.tick < f.next) continue;
    f.next = b.tick + MELEE_ROUND_TICKS;
    f.rounds += 1;
    b.stats.rounds += 1;
    resolveRound(b, rules, A, D, key, f);
    f.ambush = false; f.charge = false;                  // first round only
  }
  checkBreak(b);
}

function resolveRound(b, rules, A, D, key, f = {}){
  const freshInWoods = b.terrain[D.y][D.x] === 'WOODS' && (b.tick - D.enteredTick) < WOODS_OCCUPANCY_TICKS;
  const dice = rules.fightDice(b, A, D, { charge: !!f.charge, ambush: !!f.ambush, defenderFreshInWoods: freshInWoods });
  const aBonus = dice.aBonus + (b.tick < D.turnedUntil ? 1 : 0) + (f.ambush ? 1 : 0) - (A.forming ? MID_FORMATION_PENALTY : 0);
  const dBonus = dice.dBonus - (D.forming ? MID_FORMATION_PENALTY : 0);
  let a = rollBest(b, dice.aDice), d = rollBest(b, dice.dDice);
  let aVal = a.best + aBonus, dVal = d.best + dBonus;
  // Guard and Heavy Cavalry re-roll once when losing, if the die could improve.
  if(aVal < dVal && dice.aReroll && a.best < 6){ a = rollBest(b, dice.aDice); aVal = a.best + aBonus; }
  else if(dVal < aVal && dice.dReroll && d.best < 6){ d = rollBest(b, dice.dDice); dVal = d.best + dBonus; }
  const score = `${aVal} v ${dVal}`;
  if(aVal === dVal){
    if(dice.defenderHigher){ note(b, 'melee', A, `${score}: high ground holds`); return pushBackUnit(b, A, D, key); }
    if(f.charge && D.formation !== 'square'){ note(b, 'melee', D, `${score}: the charge carries it`); return pushBackUnit(b, D, A, key); }
    if(A.column && isFoot(A)){ note(b, 'melee', D, `${score}: the Column carries it`); return pushBackUnit(b, D, A, key); }
    note(b, 'melee', D, `${score}: drawn`);
    return;
  }
  const winner = aVal > dVal ? A : D, loser = aVal > dVal ? D : A;
  const margin = Math.abs(aVal - dVal);
  if(loser.formation === 'square'){ loser.formation = 'line'; note(b, 'form', loser, 'Square broken'); }
  if(loser.forming) loser.forming = null;
  if(margin === 1){ note(b, 'melee', loser, `${score}: pushed back`); return pushBackUnit(b, loser, winner, key); }
  delete b.fights[key];
  if(margin === 2){ note(b, 'melee', loser, `${score}: routed`); return rout(b, loser); }
  note(b, 'melee', loser, `${score}: destroyed`);
  destroy(b, loser);
}

/* One square straight away from the winner, quickly, and turned around for
   TURNED_AROUND_TICKS (attackers +1, no orders). Blocked or at the board edge,
   it holds its square, turned around all the same. */
function pushBackUnit(b, loser, winner, key){
  delete b.fights[key];
  breakColumn(b, loser);                                  // only the loser falls back
  loser.turnedUntil = b.tick + TURNED_AROUND_TICKS;
  loser.path = []; loser.goal = null;
  if(loser.step) return;
  const tx = loser.x + Math.sign(loser.x - winner.x), ty = loser.y + Math.sign(loser.y - winner.y);
  if(!inBounds(b, tx, ty) || takenSquares(b, loser.id).has(tx + ',' + ty)) return;
  loser.path = [{ x: tx, y: ty }];
  loser.pushed = true;
}

/* Margin 2. The rally is rolled where the unit stands (as in turn-based):
   rallied, it runs for its own edge, then rallies there for ROUT_TO_RALLY_TICKS
   before it can be ordered; failed, its Brigadier's once-a-battle Leadership
   Roll saves it where it stands if he judges it worth it; otherwise it is lost. */
function rout(b, u){
  breakColumn(b, u);
  const r = d6(b);
  const need = RALLY_ON[u.type] || RALLY_ON.INFANTRY;
  u.turnedUntil = Math.max(u.turnedUntil, b.tick + TURNED_AROUND_TICKS);
  u.path = []; u.goal = null;
  if(r >= need){
    note(b, 'rally', u, `Rallies (${r})`);
    const edge = homeEdgeSquare(b, u);
    const path = edge ? findPath(b, u, edge.x, edge.y) : null;
    if(path && path.length){ u.routing = true; u.path = path; u.goal = edge; }
    else u.rallyUntil = b.tick + ROUT_TO_RALLY_TICKS;
    return;
  }
  const key = brigadeKey(u);
  const brig = b.units.find(o => !o.removed && o.type === 'BRIGADIER' && brigadeKey(o) === key);
  const left = b.units.filter(o => !o.removed && o.type !== 'BRIGADIER' && brigadeKey(o) === key).length;
  const worthIt = left <= 2 || u.type === 'GUARD' || u.type === 'HEAVY_CAV' || u.type === 'ARTILLERY';
  if(brig && !b.leadershipUsed[key] && worthIt){
    b.leadershipUsed[key] = true;
    u.rallyUntil = b.tick + ROUT_TO_RALLY_TICKS;
    note(b, 'rally', u, `Fails (${r}): Leadership saves it`);
    return;
  }
  note(b, 'rally', u, `Fails to rally (${r})`);
  destroy(b, u);
}
function homeEdgeSquare(b, u){
  const row = b.homeRow[u.side];
  const brig = b.units.find(o => !o.removed && o.type === 'BRIGADIER' && brigadeKey(o) === brigadeKey(u));
  const ref = brig || u;
  const taken = takenSquares(b, u.id);
  let best = null;
  for(let x = 0; x < b.cols; x++){
    if(taken.has(x + ',' + row)) continue;
    if(!best || Math.abs(x - ref.x) < Math.abs(best.x - ref.x)) best = { x, y: row };
  }
  return best;
}
function destroy(b, u){
  u.removed = true; u.path = []; u.goal = null; u.step = null; u.routing = false; u.lock = null; u.hidden = false; u.forming = null;
  b.stats.destroyed[u.side] = (b.stats.destroyed[u.side] || 0) + 1;
  b.stats.lostValue[u.side] = (b.stats.lostValue[u.side] || 0) + (POINT_VALUE[u.type] || 0);
  breakColumn(b, u);
  note(b, 'destroyed', u, 'Destroyed');
}

/* A Brigade is broken when every unit under its Brigadier is gone; an army
   is beaten when two of its Brigades are broken (or all, if it has fewer). */
export function brokenBrigades(b, side){
  const ids = [...new Set(b.units.filter(u => u.side === side).map(u => u.brigadeId))];
  const broken = ids.filter(id => !b.units.some(u => u.side === side && u.brigadeId === id && !u.removed && u.type !== 'BRIGADIER'));
  return { broken: broken.length, total: ids.length };
}
function checkBreak(b){
  for(const side of ['red', 'blue']){
    const { broken, total } = brokenBrigades(b, side);
    if(total && broken >= Math.min(2, total)){
      b.over = true; b.result = 'break';
      b.winner = side === 'red' ? 'blue' : 'red';
      note(b, 'break', null, `${side} army breaks`);
      return;
    }
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
