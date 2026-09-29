// Real-Time variant: the simulation core (js/rts/sim.js), which is pure and
// runs without a browser. Timing is in ticks, never the wall clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBattle, issueOrder, loadBattle, saveBattle, step, visualPosition } from '../js/rts/sim.js';
import { TRAVEL_TICKS, ROAD_TRAVEL_FACTOR } from '../js/rts/constants.js';
import { nextRandom } from '../js/rts/rng.js';

const COLS = 20, ROWS = 10;
const terrain = Array.from({ length: ROWS }, () => Array(COLS).fill('OPEN'));
const noRoad = Array.from({ length: ROWS }, () => Array(COLS).fill(false));
const units = [
  { id: 'a', side: 'red', type: 'INFANTRY', brigadeId: 0, x: 2, y: 8 },
  { id: 'b', side: 'red', type: 'LIGHT_CAV', brigadeId: 0, x: 3, y: 8 },
  { id: 'c', side: 'blue', type: 'INFANTRY', brigadeId: 0, x: 10, y: 1 },
];
const fresh = (road = noRoad) => createBattle({ seed: 42, terrain, road, units, playerSide: 'red' });
const run = (b, n) => { for (let i = 0; i < n; i++) step(b); };

test('a move takes the travel time per square, counted in ticks', () => {
  const b = fresh();
  assert.equal(issueOrder(b, { unitId: 'a', type: 'move', target: { x: 2, y: 6 } }).ok, true);
  run(b, TRAVEL_TICKS.INFANTRY * 2);       // one tick to start each square, then its travel time
  assert.deepEqual([b.units[0].x, b.units[0].y], [2, 7]);
  run(b, 2);
  assert.deepEqual([b.units[0].x, b.units[0].y], [2, 6]);
});

test('roads are about a third faster', () => {
  const road = noRoad.map(r => r.slice()); road[8][2] = road[7][2] = true;
  const b = fresh(road);
  issueOrder(b, { unitId: 'a', type: 'move', target: { x: 2, y: 7 } });
  run(b, 1 + Math.round(TRAVEL_TICKS.INFANTRY * ROAD_TRAVEL_FACTOR));
  assert.deepEqual([b.units[0].x, b.units[0].y], [2, 7]);
});

test('two units never share a square', () => {
  const b = fresh();
  issueOrder(b, { unitId: 'a', type: 'move', target: { x: 5, y: 8 } });
  // b's destination is where a is heading; its order is refused while a holds or crosses it
  run(b, 300);
  assert.equal(issueOrder(b, { unitId: 'b', type: 'move', target: { x: 5, y: 8 } }).ok, false);
  for (let t = 0; t < 400; t++) {
    step(b);
    const occ = b.units.filter(u => !u.removed).map(u => u.x + ',' + u.y);
    assert.equal(new Set(occ).size, occ.length);
  }
});

test('a refused order changes nothing', () => {
  const b = fresh();
  const before = saveBattle(b);
  assert.equal(issueOrder(b, { unitId: 'a', type: 'move', target: { x: 99, y: 99 } }).ok, false);
  assert.equal(saveBattle(b), before);
});

test('save and load: a battle resumes exactly where it was', () => {
  const b = fresh();
  issueOrder(b, { unitId: 'b', type: 'move', target: { x: 12, y: 3 } });
  run(b, 37);
  const copy = loadBattle(saveBattle(b));
  run(b, 200); run(copy, 200);
  assert.equal(saveBattle(copy), saveBattle(b));
});

test('seeded replay: same seed and orders give the same battle, dice included', () => {
  const play = () => {
    const b = fresh();
    issueOrder(b, { unitId: 'a', type: 'move', target: { x: 8, y: 4 } });
    run(b, 50);
    issueOrder(b, { unitId: 'b', type: 'move', target: { x: 1, y: 2 } });
    run(b, 150);
    const rolls = [nextRandom(b), nextRandom(b), nextRandom(b)];
    return saveBattle(b) + JSON.stringify(rolls);
  };
  assert.equal(play(), play());
});

test('drawn position moves smoothly between squares', () => {
  const b = fresh();
  issueOrder(b, { unitId: 'a', type: 'move', target: { x: 2, y: 7 } });
  run(b, 1 + Math.floor(TRAVEL_TICKS.INFANTRY / 2));
  const p = visualPosition(b.units[0], 0);
  assert.ok(p.y < 8 && p.y > 7, `mid-square y, got ${p.y}`);
});
