// The hand-drawn Flanders maps carry roads to the same rules as a generated
// board (js/map-generator.js): checked board by board (a 20 x 10 Battle is
// two boards), buildings counting as road.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateBoard } from '../js/map-generator.js';
const G = { '.': 'OPEN', ':': 'PLOUGHED_FIELD', '*': 'WOODS', '^': 'HILL', '#': 'BUILDING', '=': 'ROAD' };
const cards = JSON.parse(fs.readFileSync(new URL('../data/scenario-cards.json', import.meta.url), 'utf8')).cards;

test('every Flanders map has roads, and each of its boards obeys the road rules', () => {
  const flanders = cards.filter(c => c.status === 'ready' && c.map && c.map.type === 'authored');
  assert.ok(flanders.length >= 7);
  for (const c of flanders) {
    assert.ok(Array.isArray(c.map.roads), `${c.id}: no roads`);
    const W = c.map.terrain[0].length;
    for (let half = 0; half < W / 10; half++) {
      const terrain = c.map.terrain.map(r => [...r.slice(half * 10, half * 10 + 10)].map(ch => G[ch]));
      const road = c.map.roads.map((r, y) => [...r.slice(half * 10, half * 10 + 10)].map((ch, x) => ch === '=' || terrain[y][x] === 'BUILDING'));
      const errs = validateBoard({ terrain, road }).filter(e => e !== 'no village');
      assert.deepEqual(errs, [], `${c.id} board ${half + 1}`);
    }
  }
});

test('no village sits in either army\u2019s deployment rows on a Flanders map (unless it is an objective area a side starts in)', () => {
  for (const c of cards.filter(c => c.status === 'ready' && c.map && c.map.type === 'authored')) {
    const rows = c.map.terrain;
    const inArea = (x, y) => Object.values(c.map.areas || {}).some(a => a.some(([ax, ay]) => ax === x && ay === y));
    for (const y of [0, 1, rows.length - 2, rows.length - 1])
      [...rows[y]].forEach((ch, x) => { if (ch === '#') assert.ok(inArea(x, y), `${c.id} (${x},${y})`); });
  }
});
