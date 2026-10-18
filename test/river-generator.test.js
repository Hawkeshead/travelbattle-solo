// Random-map rivers (js/river-generator.js): over many seeds, every river
// enters and leaves at the centre gap of a board edge, every road it crosses
// is bridged (never beside a village), and it always has two crossings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateBoard } from '../js/map-generator.js';
import { generateRiver } from '../js/river-generator.js';
import { buildWater, waterBetweenIn } from '../js/water-core.js';

test('random rivers join at the centre gaps, bridge every road and have two crossings', () => {
  let made = 0;
  for(let s = 1; s <= 60; s++){
    const L = generateBoard(s * 7919), R = generateBoard(s * 104729);
    const terrain = L.terrain.map((row, y) => [...row, ...R.terrain[y]]);
    const road = L.road.map((row, y) => [...row, ...R.road[y]]);
    const spec = generateRiver(terrain, road, s, 1);
    if(!spec) continue;
    made++;
    const ends = [spec.course[0], spec.course[spec.course.length - 1]].map(p => p.map(Math.round).join(','));
    for(const e of ends) assert.ok(['0,5', '10,5', '20,5', '5,0', '5,10', '15,0', '15,10'].includes(e), `seed ${s}: river ends at ${e}`);
    const w = buildWater(spec, 20, 10);
    const isRoad = (x, y) => road[y][x] || terrain[y][x] === 'BUILDING';
    for(const k of Object.keys(w.edges)){
      const [a, b] = k.split('|').map(t => t.split(',').map(Number));
      if(isRoad(a[0], a[1]) && isRoad(b[0], b[1])){
        assert.equal(waterBetweenIn(w, { x: a[0], y: a[1] }, { x: b[0], y: b[1] }), 'bridge', `seed ${s}: road crossing at ${k} is not bridged`);
        assert.ok(terrain[a[1]][a[0]] !== 'BUILDING' && terrain[b[1]][b[0]] !== 'BUILDING', `seed ${s}: bridge beside a village`);
      }
    }
    const crossings = Object.values(w.edges).filter(t => t !== 'river').length;
    assert.ok(crossings >= 2, `seed ${s}: only ${crossings} crossings`);
  }
  assert.ok(made >= 40, `only ${made} of 60 seeds made a river`);
});
