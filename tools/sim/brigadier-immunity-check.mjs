/* BRIGADIERS CANNOT BE ATTACKED, AND ARE NEVER TURNED AROUND.

   Loads the real game headlessly (the simulator's jsdom shim) and sets up tiny
   hand-built boards, so each rule is asserted against the engine itself rather
   than a description of it:

   - the Charge highlight never offers an ordinary enemy Brigadier's square, nor
     a square whose only neighbour worth charging is a Brigadier;
   - the Move highlight still offers his square (displacement is unchanged);
   - no source of "turned around" can put the status on a Brigadier;
   - an Operation VIP (anything carrying a captureRule) IS a charge destination,
     and ending a move on him captures him instead of shoving him;
   - the AI's chain-severing count matches what the cohesion rule then does.

   A plain script rather than an npm test: it needs jsdom, which the test suite
   deliberately runs without. Usage (jsdom installed as for the simulator):

     node tools/sim/brigadier-immunity-check.mjs
*/
import assert from 'node:assert';
import { loadGame, collapseTimers } from './headless-env.mjs';

const g = await loadGame();
collapseTimers();
const data = g.data, rules = g.rules;
const render = await import('../../js/render-board.js');
const ai = await import('../../js/ai-strategy.js');
const es = await import('../../js/engine-state.js');
const units = await import('../../js/render-units.js');
render.setFastAnimationMode(true);

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// An all-open-ground board with only the given units on it.
function board(list){
  const { state, COLS, ROWS } = data;
  state.terrain = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => 'OPEN'));
  state.units = list;
  state.scenario = null; state.campaign = null;
  state.moved = new Set();
  return state;
}
const unit = (side, type, x, y, brigadeId = 'b1') => es.newUnit(side, type, x, y, brigadeId);
const has = (cells, x, y) => cells.some(c => c.x === x && c.y === y);

test('Charge never targets an ordinary Brigadier; Move still reaches his square', () => {
  const cav = unit('red', 'LIGHT_CAV', 5, 2, 'r1');
  const brig = unit('blue', 'BRIGADIER', 5, 5, 'b1');
  board([cav, brig]);
  const charges = rules.computeChargeDestinations(cav);
  assert.ok(!has(charges, 5, 4), 'a square beside only a Brigadier was offered as a charge');
  assert.ok(!charges.some(c => rules.isAdjacent(c, brig)), 'Charge aimed at a lone Brigadier');
  assert.ok(!rules.canAttackTarget(cav, brig), 'canAttackTarget allowed a Brigadier');

  // His square stays a movement destination (shove him clear, as before).
  const cav2 = unit('red', 'LIGHT_CAV', 5, 3, 'r1');
  board([cav2, brig]);
  assert.ok(has(rules.legalMoves(cav2), 5, 5), 'Move no longer reaches the Brigadier\'s square');
});

test('a clean run onto a Brigadier beside a real target is still not a charge', () => {
  const cav = unit('red', 'LIGHT_CAV', 5, 3, 'r1');
  const brig = unit('blue', 'BRIGADIER', 5, 5, 'b1');
  const inf = unit('blue', 'INFANTRY', 5, 6, 'b1');
  board([cav, brig, inf]);
  const charges = rules.computeChargeDestinations(cav);
  assert.ok(!has(charges, 5, 5), 'the Brigadier\'s own square highlighted as a charge');
});

test('a real target still makes a charge', () => {
  const cav = unit('red', 'LIGHT_CAV', 5, 2, 'r1');
  const inf = unit('blue', 'INFANTRY', 5, 5, 'b1');
  board([cav, inf]);
  assert.ok(has(rules.computeChargeDestinations(cav), 5, 4), 'ordinary charge lost');
});

test('nothing can turn a Brigadier around, and no badge or bonus can follow', () => {
  const brig = unit('blue', 'BRIGADIER', 5, 5, 'b1');
  const inf = unit('blue', 'INFANTRY', 5, 6, 'b1');
  const foe = unit('red', 'INFANTRY', 5, 4, 'r1');
  board([brig, inf, foe]);
  assert.strictEqual(rules.setTurnedAround(brig), false);
  assert.strictEqual(brig.turnOnly, false);
  assert.strictEqual(rules.setTurnedAround(inf), true);
  assert.strictEqual(inf.turnOnly, true);
  // A Brigadier standing where a pushed-back unit lands is shoved, not turned.
  inf.turnOnly = false;
  const loser = unit('blue', 'INFANTRY', 5, 4, 'b1');
  const winner = unit('red', 'INFANTRY', 5, 3, 'r1');
  board([loser, winner, brig]);
  brig.x = 5; brig.y = 5;
  rules.pushBack(loser, winner);
  assert.strictEqual(brig.turnOnly, false, 'pushback shove turned the Brigadier');
  // Even a stale flag (old save) draws no badge and grants no bonus.
  brig.turnOnly = true;
  assert.ok(!units.statusBadgesFor([brig]).includes('turned'));
  assert.strictEqual(rules.volleyModifiers(brig).turnedBonus, 0);
  assert.strictEqual(rules.isTurnedAround(brig), false);
});

test('an Operation VIP is a charge destination and is captured, not shoved', () => {
  const cav = unit('red', 'LIGHT_CAV', 5, 3, 'r1');
  const vip = unit('blue', 'BRIGADIER', 5, 5, 'b1');
  vip.captureRule = 'captured/eliminated if an enemy unit ends its move in its square';
  board([cav, vip]);
  assert.ok(has(rules.computeChargeDestinations(cav), 5, 5), 'VIP square not offered to Charge');
  assert.ok(!rules.canAttackTarget(cav, vip), 'a VIP is taken by moving onto him, not by melee');
  render.displaceBrigadierIfPresent(5, 5, 5, 3);
  assert.strictEqual(vip.removed, true, 'VIP was not captured');
});

test('the AI counts exactly the units a shove would cut off', () => {
  // Blue chain runs up and to the left: Brigadier (5,5), then (4,4), then
  // (3,3). Red steps down onto him from (5,4), so the engine shoves him two
  // squares straight on, to (5,7), out of touch with both of his units.
  const brig = unit('blue', 'BRIGADIER', 5, 5, 'b1');
  const a = unit('blue', 'INFANTRY', 4, 4, 'b1');
  const b = unit('blue', 'INFANTRY', 3, 3, 'b1');
  const mover = unit('red', 'INFANTRY', 5, 4, 'r1');
  const st = board([brig, a, b, mover]);
  st.aiConfig = { red: {}, blue: {} };
  const predicted = ai.unitsFrozenByDisplacing(brig, mover, 5, 4, { x: 5, y: 5 });
  const before = rules.movableUnitsForSide('blue');
  render.displaceBrigadierIfPresent(5, 5, 5, 4);
  const after = rules.movableUnitsForSide('blue');
  const actual = [a, b].filter(u => before.has(u.id) && !after.has(u.id)).length;
  assert.strictEqual(predicted, actual);
  assert.strictEqual(actual, 2, 'test board should cut off both units');
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`ok      ${name}`); }
  catch (e) { failed++; console.log(`FAILED  ${name}\n        ${e.message}`); }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
