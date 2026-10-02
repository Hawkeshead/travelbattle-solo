/* MISSED-OPPORTUNITY FLAGS ON HAND-BUILT POSITIONS (telemetry spec 2.4, step 4).

   Each check in js/telemetry/missed.js takes the game's rules as a parameter,
   so here they are small stand-ins with the same meaning on an open 10 x 10
   board: line of sight everywhere, moves of up to two squares, a Heavy
   Cavalry charge that can land on any square within two. One position per
   code that should flag, and one beside it that should not. */
import { test } from 'node:test';
import assert from 'node:assert';
import { checksAfterFight, checksAfterMove, reachAtTurnStart } from '../js/telemetry/missed.js';

const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
function rulesFor(units, terrain = {}){
  const within = (u, r) => { const out = []; for(let x = 0; x < 10; x++) for(let y = 0; y < 10; y++) if(cheb(u, { x, y }) <= r && !(x === u.x && y === u.y)) out.push({ x, y }); return out; };
  return {
    legalMoves: u => within(u, 2),
    computeChargeDestinations: u => (u.type === 'HEAVY_CAV' ? within(u, 2) : []),
    hasLOS: () => true,
    chebyshev: cheb,
    isAdjacent: (a, b) => cheb(a, b) === 1,
    stackPartner: u => units.find(o => o !== u && !o.removed && o.side === u.side && o.x === u.x && o.y === u.y && ['INFANTRY', 'GUARD'].includes(o.type)) || null,
    terrainAt: (x, y) => terrain[x + ',' + y] || 'OPEN',
  };
}
const U = (id, side, type, x, y, extra = {}) => Object.assign({ id, side, type, x, y, formation: 'line' }, extra);
const codes = flags => flags.map(f => f.code + ':' + f.unit).sort();

test('COLUMN_IN_GUN_RANGE: a column within 4 of an enemy gun flags; at 5 it does not', () => {
  const near = [U('a', 'red', 'INFANTRY', 5, 5), U('b', 'red', 'INFANTRY', 5, 5), U('g', 'blue', 'ARTILLERY', 5, 1)];
  assert.deepEqual(codes(checksAfterMove(near, 'red', null, rulesFor(near))).filter(c => c.startsWith('COLUMN')), ['COLUMN_IN_GUN_RANGE:a']);
  const far = [U('a', 'red', 'INFANTRY', 5, 6), U('b', 'red', 'INFANTRY', 5, 6), U('g', 'blue', 'ARTILLERY', 5, 1)];
  assert.deepEqual(codes(checksAfterMove(far, 'red', null, rulesFor(far))).filter(c => c.startsWith('COLUMN')), []);
});

test('LINE_VS_HEAVY_CAV: infantry in line next to a charge destination flags; in square it does not', () => {
  const line = [U('i', 'red', 'INFANTRY', 5, 5), U('c', 'blue', 'HEAVY_CAV', 5, 2)];
  assert.deepEqual(codes(checksAfterMove(line, 'red', null, rulesFor(line))), ['LINE_VS_HEAVY_CAV:i']);
  const square = [U('i', 'red', 'INFANTRY', 5, 5, { formation: 'square' }), U('c', 'blue', 'HEAVY_CAV', 5, 2)];
  assert.deepEqual(codes(checksAfterMove(square, 'red', null, rulesFor(square))), []);
});

test('EXPOSED_NO_COVER: in the open in range of a gun with a free wood in reach flags; with the wood occupied it does not', () => {
  const terrain = { '6,8': 'WOODS' };
  const units = [U('i', 'red', 'INFANTRY', 5, 8), U('g', 'blue', 'ARTILLERY', 5, 3)];
  const rules = rulesFor(units, terrain);
  const reach = reachAtTurnStart(units, 'red', rules);
  assert.deepEqual(codes(checksAfterMove(units, 'red', reach, rules)), ['EXPOSED_NO_COVER:i']);
  const taken = [...units, U('x', 'red', 'CAVALRY', 6, 8)];
  assert.deepEqual(codes(checksAfterMove(taken, 'red', reachAtTurnStart(taken, 'red', rulesFor(taken, terrain)), rulesFor(taken, terrain))).filter(c => c.startsWith('EXPOSED_NO_COVER:i')), []);
});

test('CAV_ALONE: a lone cavalry attack with an unused friend in reach flags; with a second attacker it does not', () => {
  const units = [U('h', 'red', 'LIGHT_CAV', 5, 5), U('i', 'red', 'INFANTRY', 2, 6), U('d', 'blue', 'INFANTRY', 5, 4)];
  const rules = rulesFor(units);
  const reach = reachAtTurnStart(units, 'red', rules);
  assert.deepEqual(codes(checksAfterFight(units, 'red', [{ attackerId: 'h', defenderId: 'd' }], reach, rules)), ['CAV_ALONE:h']);
  assert.deepEqual(codes(checksAfterFight(units, 'red', [{ attackerId: 'h', defenderId: 'd' }, { attackerId: 'i', defenderId: 'd' }], reach, rules)), []);
});
