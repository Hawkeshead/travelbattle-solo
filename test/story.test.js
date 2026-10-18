// The Waterloo campaign's battles (data/story/waterloo.json): every map is a
// whole board, every river joins up and every bridge sits on open road, every
// place name is on the board, and every side has Brigades and an objective.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildWater } from '../js/water-core.js';

const story = JSON.parse(readFileSync(new URL('../data/story/waterloo.json', import.meta.url)));

test('Waterloo: fourteen battles, each a complete board with forces and objectives', () => {
  assert.equal(story.battles.length, 14);
  for(const b of story.battles){
    const { terrain, roads, river, places } = b.map;
    const W = terrain[0].length;
    assert.ok(W === 10 || W === 20, `${b.id}: board ${W} wide`);
    assert.equal(terrain.length, 10, `${b.id}: 10 rows`);
    for(const row of [...terrain, ...roads]) assert.equal(row.length, W, `${b.id}: a row is ${row.length} wide`);
    if(river){
      const w = buildWater(river, W, 10);
      assert.ok(Object.keys(w.edges).length > 0, `${b.id}: river has no edges`);
      for(const br of river.bridges){
        for(const [x, y] of br.squares){
          assert.ok('.:'.includes(terrain[y][x]) && roads[y][x] === '=', `${b.id}: bridge square ${x},${y} is not open road`);
        }
      }
    }
    for(const [name, x, y] of places) assert.ok(x >= 0 && x <= W && y >= 0 && y <= 10, `${b.id}: ${name} is off the board`);
    for(const [side, s] of Object.entries(b.sides)){
      assert.ok(s.brigades.length > 0 && s.brigades.every(g => g.units.length >= 2), `${b.id}: ${side} has an empty Brigade`);
      assert.ok(s.objective.text.length > 10, `${b.id}: ${side} has no objective`);
    }
    assert.ok(b.turnLimit > 0 && ['standard', 'corridor', 'single'].includes(b.layout), `${b.id}: layout or turn limit`);
  }
});
