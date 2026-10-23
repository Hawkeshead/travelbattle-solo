// Brigade perks (js/perks-core.js): feats earn a perk once, the cap holds, and
// a perk works only for units linked to a living Brigadier.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addFeat, commandingBrigadier, newPerkState, perkWorks } from '../js/perks-core.js';

const u = (id, x, y, extra = {}) => Object.assign({ id, side: 'red', brigadeId: 0, type: 'INFANTRY', x, y, removed: false }, extra);
const adj = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) === 1;

test('a feat earns its perk when it reaches its number, once', () => {
  const ps = newPerkState();
  assert.equal(addFeat(ps, 'red:0', 'cavRepelled', 1), null);
  assert.equal(addFeat(ps, 'red:0', 'cavRepelled', 1), 'STEADY');
  assert.equal(addFeat(ps, 'red:0', 'cavRepelled', 1), null);          // already held
  assert.deepEqual(ps.perks['red:0'], ['STEADY']);
});

test('the cap stops a second perk; a longer battle allows two', () => {
  const short = newPerkState(), long = newPerkState();
  for(let i = 0; i < 2; i++){ addFeat(short, 'red:0', 'cavRepelled', 1); addFeat(long, 'red:0', 'cavRepelled', 2); }
  for(let i = 0; i < 5; i++){ addFeat(short, 'red:0', 'wins', 1); addFeat(long, 'red:0', 'wins', 2); }
  assert.deepEqual(short.perks['red:0'], ['STEADY']);
  assert.deepEqual(long.perks['red:0'], ['STEADY', 'INSPIRING']);
});

test('in command: linked to the Brigadier through touching units of its own Brigade', () => {
  const brig = u('b', 0, 0, { type: 'BRIGADIER' }), a = u('a', 1, 0), c = u('c', 2, 1), far = u('f', 6, 6);
  const other = u('o', 3, 1, { brigadeId: 1 }), d = u('d', 4, 1);   // d touches only another Brigade's unit
  const units = [brig, a, c, far, other, d];
  assert.equal(commandingBrigadier(units, c, adj), brig);
  assert.equal(commandingBrigadier(units, far, adj), null);
  assert.equal(commandingBrigadier(units, d, adj), null);
  const ps = newPerkState(); ps.perks['red:0'] = ['STEADY'];
  assert.equal(perkWorks(ps, units, c, 'STEADY', adj), true);
  assert.equal(perkWorks(ps, units, far, 'STEADY', adj), false);
  brig.removed = true;                                                    // he falls: the perk goes with him
  assert.equal(perkWorks(ps, units, a, 'STEADY', adj), false);
});

test('every perk has its own feat and a number to reach', async () => {
  const { PERKS } = await import('../js/perks-core.js');
  const feats = Object.values(PERKS).map(p => p.feat);
  assert.equal(new Set(feats).size, feats.length);
  assert.equal(Object.keys(PERKS).length, 10);
  for(const p of Object.values(PERKS)) assert.ok(p.need > 0 && p.name && p.text && p.how);
});
