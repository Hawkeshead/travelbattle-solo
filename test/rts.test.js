// Real-Time variant: the simulation core (js/rts/sim.js), which is pure and
// runs without a browser. Timing is in ticks, never the wall clock. The
// turn-based rules it borrows (range and chain) are stubbed here with simple
// stand-ins; in the game they come from the turn-based engine itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBattle, issueGroupOrder, issueOrder, loadBattle, poolOf, saveBattle, step, visualPosition } from '../js/rts/sim.js';
import { COOLDOWN_TICKS, ORDER_REGEN_TICKS, ROAD_TRAVEL_FACTOR, TRAVEL_TICKS } from '../js/rts/constants.js';
import { nextRandom } from '../js/rts/rng.js';

const COLS = 20, ROWS = 10;
const terrain = Array.from({ length: ROWS }, () => Array(COLS).fill('OPEN'));
const noRoad = Array.from({ length: ROWS }, () => Array(COLS).fill(false));
const RANGE = { INFANTRY: 3, LIGHT_CAV: 4, BRIGADIER: 4 };      // generous stand-ins, so paths have room
const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
// Stand-in rules: range by type, chain = within 2 squares of the Brigadier of its brigade.
const rules = {
  inChain(b, u){
    if(u.type === 'BRIGADIER') return true;
    const brig = b.units.find(o => !o.removed && o.type === 'BRIGADIER' && o.side === u.side && o.brigadeId === u.brigadeId);
    return !brig || cheb(brig, u) <= 2;
  },
  reachable(b, u){
    const r = RANGE[u.type] || 1, out = [];
    for(let y = 0; y < ROWS; y++) for(let x = 0; x < COLS; x++) if(cheb(u, { x, y }) <= r && cheb(u, { x, y }) > 0) out.push({ x, y, steps: cheb(u, { x, y }) });
    return out;
  },
};
const units = [
  { id: 'g', side: 'red', type: 'BRIGADIER', brigadeId: 0, x: 3, y: 9 },
  { id: 'a', side: 'red', type: 'INFANTRY', brigadeId: 0, x: 2, y: 8 },
  { id: 'b', side: 'red', type: 'LIGHT_CAV', brigadeId: 0, x: 3, y: 8 },
  { id: 'far', side: 'red', type: 'INFANTRY', brigadeId: 0, x: 12, y: 8 },
  { id: 'c', side: 'blue', type: 'INFANTRY', brigadeId: 0, x: 10, y: 1 },
];
const fresh = (road = noRoad) => createBattle({ seed: 42, terrain, road, units, playerSide: 'red' });
const run = (b, n) => { for (let i = 0; i < n; i++) step(b); };
const U = (b, id) => b.units.find(u => u.id === id);
const move = (b, id, x, y) => issueOrder(b, { unitId: id, type: 'move', target: { x, y } }, rules);

test('a move takes the travel time per square, counted in ticks', () => {
  const b = fresh();
  assert.equal(move(b, 'a', 2, 6).ok, true);
  run(b, TRAVEL_TICKS.INFANTRY * 2);
  assert.deepEqual([U(b, 'a').x, U(b, 'a').y], [2, 7]);
  run(b, 2);
  assert.deepEqual([U(b, 'a').x, U(b, 'a').y], [2, 6]);
});

test('roads are about a third faster', () => {
  const road = noRoad.map(r => r.slice()); road[8][2] = road[7][2] = true;
  const b = fresh(road);
  move(b, 'a', 2, 7);
  run(b, 1 + Math.round(TRAVEL_TICKS.INFANTRY * ROAD_TRAVEL_FACTOR));
  assert.deepEqual([U(b, 'a').x, U(b, 'a').y], [2, 7]);
});

test('the pool starts full at one order per unit, spends one per order, and regenerates up to the cap', () => {
  const b = fresh();
  const { pool, cap } = poolOf(b, U(b, 'a'));
  assert.equal(cap, 3);                        // a, b and far; the Brigadier is not counted
  assert.equal(pool.orders, 3);
  move(b, 'a', 2, 6);
  assert.equal(poolOf(b, U(b, 'a')).pool.orders, 2);
  run(b, ORDER_REGEN_TICKS);
  assert.equal(poolOf(b, U(b, 'a')).pool.orders, 3);
  run(b, ORDER_REGEN_TICKS * 3);
  assert.equal(poolOf(b, U(b, 'a')).pool.orders, 3);   // capped
});

test('moving the Brigadier costs no order', () => {
  const b = fresh();
  assert.equal(move(b, 'g', 5, 9).ok, true);
  assert.equal(poolOf(b, U(b, 'a')).pool.orders, 3);
});

test('an empty pool refuses, and the refusal changes nothing', () => {
  const b = fresh();
  poolOf(b, U(b, 'a')).pool.orders = 0;
  const before = saveBattle(b);
  assert.deepEqual(move(b, 'a', 2, 6), { ok: false, reason: 'No orders left' });
  assert.equal(saveBattle(b), before);
});

test('cooldown: no new order while moving or until the cooldown has run', () => {
  const b = fresh();
  move(b, 'b', 3, 7);
  assert.equal(move(b, 'b', 3, 6).reason, 'Still moving');
  run(b, TRAVEL_TICKS.LIGHT_CAV + 2);                  // arrived, cooldown still running
  assert.equal(move(b, 'b', 3, 6).reason, 'Not ready yet');
  run(b, COOLDOWN_TICKS.LIGHT_CAV);
  assert.equal(move(b, 'b', 3, 6).ok, true);
});

test('range cap: beyond the allowance is refused', () => {
  const b = fresh();
  assert.equal(move(b, 'a', 2, 2).reason, 'Out of range');
});

test('a unit off the chain can be given nothing new', () => {
  const b = fresh();
  assert.equal(move(b, 'far', 12, 7).reason, 'Out of the chain');
});

test('group orders: all go, each to its own square, one order each', () => {
  const b = fresh();
  const res = issueGroupOrder(b, { unitIds: ['a', 'b'], type: 'move', target: { x: 3, y: 6 } }, rules);
  assert.equal(res.ok, true);
  assert.equal(poolOf(b, U(b, 'a')).pool.orders, 1);
  run(b, 200);
  const spots = ['a', 'b'].map(id => U(b, id).x + ',' + U(b, id).y);
  assert.equal(new Set(spots).size, 2);
  assert.ok(spots.includes('3,6'));
});

test('group orders: a short pool refuses the whole group', () => {
  const b = fresh();
  poolOf(b, U(b, 'a')).pool.orders = 1;
  const before = saveBattle(b);
  assert.equal(issueGroupOrder(b, { unitIds: ['a', 'b'], type: 'move', target: { x: 3, y: 6 } }, rules).reason, 'No orders left');
  assert.equal(saveBattle(b), before);
});

test('two units never share a square', () => {
  const b = fresh();
  move(b, 'a', 4, 7);
  move(b, 'b', 4, 7);                                  // refused or rerouted; either way no sharing
  for (let t = 0; t < 400; t++) {
    step(b);
    const occ = b.units.filter(u => !u.removed).map(u => u.x + ',' + u.y);
    assert.equal(new Set(occ).size, occ.length);
  }
});

test('a blocked unit waits, then finds another way', () => {
  const b = createBattle({ seed: 1, terrain, road: noRoad, playerSide: 'red', units: [
    { id: 'g', side: 'red', type: 'BRIGADIER', brigadeId: 0, x: 5, y: 9 },
    { id: 'a', side: 'red', type: 'INFANTRY', brigadeId: 0, x: 5, y: 8 },
    { id: 'z', side: 'red', type: 'INFANTRY', brigadeId: 1, x: 5, y: 7 },
  ]});
  // a is told to go straight through the square z stands on; it must route round
  U(b, 'a').path = [{ x: 5, y: 7 }, { x: 5, y: 6 }]; U(b, 'a').goal = { x: 5, y: 6 };
  run(b, 400);
  assert.deepEqual([U(b, 'a').x, U(b, 'a').y], [5, 6]);
});

test('contact is commitment: an enemy beside it mid-route and it stops', () => {
  const b = createBattle({ seed: 1, terrain, road: noRoad, playerSide: 'red', units: [
    { id: 'g', side: 'red', type: 'BRIGADIER', brigadeId: 0, x: 0, y: 9 },
    { id: 'a', side: 'red', type: 'INFANTRY', brigadeId: 0, x: 5, y: 8 },
    { id: 'e', side: 'blue', type: 'INFANTRY', brigadeId: 0, x: 7, y: 7 },
  ]});
  U(b, 'a').path = [{ x: 6, y: 8 }, { x: 7, y: 8 }, { x: 8, y: 8 }]; U(b, 'a').goal = { x: 8, y: 8 };
  run(b, 300);
  assert.deepEqual([U(b, 'a').x, U(b, 'a').y], [6, 8]);
});

test('paths keep away from the enemy when they can', () => {
  const b = createBattle({ seed: 1, terrain, road: noRoad, playerSide: 'red', units: [
    { id: 'g', side: 'red', type: 'BRIGADIER', brigadeId: 0, x: 0, y: 9 },
    { id: 'a', side: 'red', type: 'LIGHT_CAV', brigadeId: 0, x: 4, y: 5 },
    { id: 'e', side: 'blue', type: 'INFANTRY', brigadeId: 0, x: 6, y: 4 },
  ]});
  assert.equal(issueOrder(b, { unitId: 'a', type: 'move', target: { x: 8, y: 5 } }, { ...rules, inChain: () => true }).ok, true);
  const near = U(b, 'a').path.slice(0, -1).some(s => cheb(s, { x: 6, y: 4 }) === 1);
  assert.equal(near, false);
});

test('save and load: a battle resumes exactly where it was', () => {
  const b = fresh();
  move(b, 'b', 5, 6);
  run(b, 37);
  const copy = loadBattle(saveBattle(b));
  run(b, 200); run(copy, 200);
  assert.equal(saveBattle(copy), saveBattle(b));
});

test('seeded replay: same seed and orders give the same battle, dice included', () => {
  const play = () => {
    const b = fresh();
    move(b, 'a', 2, 6);
    run(b, 50);
    move(b, 'g', 4, 7);
    run(b, 150);
    const rolls = [nextRandom(b), nextRandom(b), nextRandom(b)];
    return saveBattle(b) + JSON.stringify(rolls);
  };
  assert.equal(play(), play());
});

test('drawn position moves smoothly between squares', () => {
  const b = fresh();
  move(b, 'a', 2, 7);
  run(b, 1 + Math.floor(TRAVEL_TICKS.INFANTRY / 2));
  const p = visualPosition(U(b, 'a'), 0);
  assert.ok(p.y < 8 && p.y > 7, `mid-square y, got ${p.y}`);
});
