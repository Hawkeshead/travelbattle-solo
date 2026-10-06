// The random board generator (js/map-generator.js): every board obeys Matthew's
// road rules, and the same seed always gives the same board.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EXITS, generateBoard, roadNetworks, validateBoard, villagesOf, boardToText } from '../js/map-generator.js';

test('300 boards in a row: every one passes every rule', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const b = generateBoard(seed);
    assert.deepEqual(validateBoard(b), [], `seed ${seed}`);
    const n = roadNetworks(b.road).length;
    assert.ok(n === 1 || n === 2, `seed ${seed}: ${n} networks`);
    for (const e of Object.values(EXITS)) assert.ok(b.road[e.y][e.x], `seed ${seed}: exit (${e.x},${e.y})`);
    assert.ok(villagesOf(b.terrain).length >= 1, `seed ${seed}: no village`);
  }
});

test('the same seed always gives the same board', () => {
  for (const seed of [7, 99, 123456789]) assert.equal(boardToText(generateBoard(seed)), boardToText(generateBoard(seed)));
});

test('any two boards join on any side: every edge has its road at square 7', () => {
  const a = generateBoard(11), b = generateBoard(12);
  assert.ok(a.road[7][9] && b.road[7][0], 'side by side: row 7');
  assert.ok(a.road[9][7] && b.road[0][7], 'one above the other: column 7');
});
