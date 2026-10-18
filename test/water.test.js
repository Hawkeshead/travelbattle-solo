// Rivers (js/water-core.js): a course along grid lines becomes river edges
// between squares; fords and bridges sit on those edges; diagonal steps never
// cross water; a broken bridge is crossed as a ford.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWater, stepWaterIn, waterBetweenIn } from '../js/water-core.js';

const spec = { course: [[-0.2, 5], [5, 5], [5, 4], [8, 4], [8, 5], [20.2, 5]],
  fords: [[5.2, 7.8, 3.6, 4.4]], bridges: [{ squares: [[10, 4], [10, 5]], art: 'single-arch' }] };
const w = buildWater(spec, 20, 10);

test('the course becomes river edges between squares, along each grid line it follows', () => {
  assert.equal(waterBetweenIn(w, { x: 0, y: 4 }, { x: 0, y: 5 }), 'river');   // under row 5, at the west edge
  assert.equal(waterBetweenIn(w, { x: 4, y: 4 }, { x: 5, y: 4 }), 'river');   // the jog north, along line x = 5
  assert.equal(waterBetweenIn(w, { x: 3, y: 2 }, { x: 3, y: 3 }), null);      // dry ground
  assert.equal(Object.keys(w.edges).length, 22);   // 5 + 1 + 3 + 1 + 12
});

test('fords and bridges sit on river edges; a diagonal step never crosses water', () => {
  assert.equal(waterBetweenIn(w, { x: 6, y: 3 }, { x: 6, y: 4 }), 'ford');
  assert.equal(waterBetweenIn(w, { x: 10, y: 4 }, { x: 10, y: 5 }), 'bridge');
  assert.equal(stepWaterIn(w, { x: 10, y: 4 }, { x: 11, y: 5 }), 'river');    // diagonally past the bridge: blocked
  assert.equal(stepWaterIn(w, { x: 2, y: 2 }, { x: 3, y: 3 }), null);
});

test('a broken bridge is crossed as a ford', () => {
  const w2 = buildWater(spec, 20, 10);
  w2.bridges[0].broken = true;
  assert.equal(waterBetweenIn(w2, { x: 10, y: 4 }, { x: 10, y: 5 }), 'ford');
});
