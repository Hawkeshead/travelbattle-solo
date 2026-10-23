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

import { storyToCard } from '../js/story.js';
import { validateCard } from '../js/scenario-validate.js';

test('every Waterloo battle makes a valid battle card for every nation that fought in it', () => {
  for(const b of story.battles){
    for(const nation of Object.keys(b.sides)){
      const card = storyToCard(b, nation, 'waterloo');
      const errs = validateCard(card);
      assert.deepEqual(errs, [], `${b.id} as ${nation}: ${errs.join('; ')}`);
      assert.equal(card.judging, 'independent');
      for(const side of ['british', 'french']) assert.ok(card.win[side].conditions.length > 0, `${b.id}: ${side} has no conditions`);
    }
  }
});

import { corridorMap } from '../js/story.js';
test('a corridor map turns into a 10 by 20 board with France at the top', () => {
  const qb = story.battles.find(b => b.id === 'quatre-bras');
  const m = corridorMap(qb.map);
  assert.equal(m.terrain.length, 20); assert.equal(m.terrain[0].length, 10);
  // design square (col 9, row 5) is Gemioncourt; in the game it is (9 - 5, 9) = (4, 9)
  assert.equal(qb.map.terrain[5][9], '#'); assert.equal(m.terrain[9][4], '#');
  assert.deepEqual(m.areas.crossroads, [[5, 15]]);   // design (15, 4)
});

test('every campaign file: valid cards, names that fit, and routes through battles each nation fought', () => {
  for(const id of ['waterloo', 'peninsula']){
    const file = JSON.parse(readFileSync(new URL(`../data/story/${id}.json`, import.meta.url)));
    for(const b of file.battles){
      for(const [n, s] of Object.entries(b.sides)) for(const br of s.brigades)
        if(br.names) assert.equal(br.names.length, br.units.length, `${id}/${b.id} ${n} ${br.name}: names do not match units`);
      for(const nation of Object.keys(b.sides)){
        const errs = validateCard(storyToCard(b, nation, id));
        assert.deepEqual(errs, [], `${id}/${b.id} as ${nation}: ${errs.join('; ')}`);
      }
    }
    for(const [nation, route] of Object.entries(file.routes)) for(const step of route) for(const bid of [].concat(step)){
      const b = file.battles.find(x => x.id === bid);
      assert.ok(b, `${id}: route ${nation} names a missing battle ${bid}`);
      assert.ok(b.sides[nation], `${id}: ${nation}'s route includes ${bid}, where ${nation} did not fight`);
    }
  }
});
