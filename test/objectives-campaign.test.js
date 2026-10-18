// The campaign's objective conditions (js/objective-core.js), on hand-made
// positions: hold N squares, units in an area, joining up, commanders,
// Brigades unbroken and broken, and entering an area once (latched).
import test from 'node:test';
import assert from 'node:assert/strict';
import { CONDITION_TABLE, useWorld } from '../js/objective-core.js';

const C = CONDITION_TABLE();
const card = { map: { areas: { farm: [[5, 4], [5, 5]], rear: [[0, 8], [1, 8], [0, 9], [1, 9]] } } };
const u = (id, side, type, x, y, extra = {}) => Object.assign({ id, side, type, x, y, brigadeId: 0, removed: false }, extra);
const end = { endOfRound: true, round: 8 };

test('HOLD_COUNT and IN_AREA count squares and units', () => {
  useWorld({ card, streaks: {}, units: [u('a', 'red', 'INFANTRY', 5, 4), u('b', 'red', 'INFANTRY', 5, 4), u('c', 'blue', 'INFANTRY', 5, 5)] });
  assert.equal(C.HOLD_COUNT('red', { area: 'farm', count: 1 }, end), true);
  assert.equal(C.HOLD_COUNT('red', { area: 'farm', count: 2 }, end), false);      // two units, but on one square
  assert.equal(C.IN_AREA('red', { area: 'farm', count: 2 }, end), true);
  assert.equal(C.HOLD_COUNT('red', { area: 'farm', count: 1, atRound: 9 }, end), false);
});

test('NEXT_TO, COMMANDER and COMMANDER_REMOVED read Brigade tags', () => {
  useWorld({ card, streaks: {}, units: [
    u('p1', 'red', 'INFANTRY', 3, 3, { storyTag: 'zieten' }), u('n1', 'red', 'INFANTRY', 4, 4, { storyTag: 'nassau' }),
    u('bl', 'red', 'BRIGADIER', 0, 8, { storyTag: 'blucher' }), u('na', 'blue', 'BRIGADIER', 9, 0, { storyTag: 'napoleon', removed: true }) ] });
  assert.equal(C.NEXT_TO('red', { tag: 'zieten', nextTo: 'nassau', count: 1 }, end), true);
  assert.equal(C.COMMANDER('red', { tag: 'blucher', area: 'rear' }, end), true);
  assert.equal(C.COMMANDER_REMOVED('red', { tag: 'napoleon' }, { round: 3 }), true);
});

test('BRIGADES_UNBROKEN, BREAK_BRIGADES and ENTERED', () => {
  const streaks = {};
  useWorld({ card, streaks, units: [
    u('a', 'red', 'INFANTRY', 1, 1, { brigadeId: 0 }), u('b', 'red', 'INFANTRY', 1, 2, { brigadeId: 1, removed: true }),
    u('c', 'blue', 'INFANTRY', 5, 4, { brigadeId: 0 }) ] });
  assert.equal(C.BRIGADES_UNBROKEN('red', { count: 1 }, end), true);
  assert.equal(C.BRIGADES_UNBROKEN('red', { count: 2 }, end), false);
  assert.equal(C.BREAK_BRIGADES('blue', { count: 1 }, { round: 4 }), true);
  assert.equal(C.ENTERED('blue', { area: 'farm' }, { round: 4 }), true);
  useWorld({ card, streaks, units: [u('c', 'blue', 'INFANTRY', 1, 1)] });         // left the farm: still counts
  assert.equal(C.ENTERED('blue', { area: 'farm' }, { round: 5 }), true);
});
