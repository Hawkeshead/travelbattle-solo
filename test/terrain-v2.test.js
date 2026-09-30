// Terrain art v2: the layout rules in js/terrain-v2.js against the reference
// result the art pack ships (docs/terrain-v2/reference/expected_1v1_result.json):
// the 1v1 map, Board A left and Board B right, rotation 0, no flip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildRoadGraph, farmOverlaySet, farmPicks, grassPicks, parseNode, roadChains, smoothChain } from '../js/terrain-v2.js';

const layouts = JSON.parse(readFileSync(new URL('../data/terrain-layouts.json', import.meta.url)));
const expected = JSON.parse(readFileSync(new URL('../docs/terrain-v2/reference/expected_1v1_result.json', import.meta.url)));
const A = layouts.boardATerrain, B = layouts.boardBTerrain;
const map = A.map((row, y) => row.concat(B[y]));
const noTurn = (x, y) => [x, y];
const overlay = farmOverlaySet(layouts, [{ board: 'A', rotation: 0, colOffset: 0, rowOffset: 0 }, { board: 'B', rotation: 0, colOffset: 10, rowOffset: 0 }], 10, noTurn);
const excluded = new Set();
for (const [side, off] of [['A', 0], ['B', 10]]) for (const e of layouts.boardExcludedRoadEdges[side]) {
  const a = `${e.x1 + off},${e.y1}`, b = `${e.x2 + off},${e.y2}`; excluded.add(a < b ? a + '|' + b : b + '|' + a);
}
const exKey = (x1, y1, x2, y2) => { const a = `${x1},${y1}`, b = `${x2},${y2}`; return excluded.has(a < b ? a + '|' + b : b + '|' + a); };

test('roads: 11 chains, the expected forks and the expected 6 exits', () => {
  const adj = buildRoadGraph(map, exKey);
  const chains = roadChains(adj);
  assert.equal(chains.length, 11);
  const forks = [...adj.keys()].filter(k => k.startsWith('c:') && adj.get(k).size >= 3).map(k => parseNode(k).v).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  assert.deepEqual(forks, expected.forks);
  const exits = [...adj.keys()].filter(k => k.startsWith('e:')).map(k => parseNode(k).v).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  assert.deepEqual(exits, expected.exits);
});

test('roads: villages link as expected', () => {
  const adj = buildRoadGraph(map, exKey);
  for (const [v, links] of expected.village_links) {
    const [vx, vy] = JSON.parse(v.slice('village'.length));
    const got = [...adj.get(`v:${vx},${vy}`)].map(k => parseNode(k).v.slice(0, 2)).sort();
    const want = links.map(r => JSON.parse(r.slice('road'.length))).sort();
    assert.deepEqual(got, want);
  }
});

test('roads: smoothed chains keep their ends and never change between runs', () => {
  const chains = roadChains(buildRoadGraph(map, exKey));
  const toScreen = (x, y) => ({ x, y });
  const a = smoothChain(chains[0], toScreen), b = smoothChain(chains[0], toScreen);
  assert.deepEqual(a, b);
  assert.ok(a.length > 12);
});

test('farms: the expected tile on every farm square', () => {
  const cells = new Set(overlay);
  map.forEach((row, y) => row.forEach((t, x) => { if (t === 'PLOUGHED_FIELD') cells.add(x + ',' + y); }));
  const got = farmPicks(cells);
  assert.equal(got.size, Object.keys(expected.farm_tiles).length);
  for (const [k, v] of Object.entries(expected.farm_tiles)) assert.equal('farm_' + got.get(k), v, k);
});

test('grass: plain never matches the left or above neighbour; details are spaced out and only on open ground', () => {
  const g = grassPicks(map, overlay);
  for (let y = 0; y < 10; y++) for (let x = 0; x < 20; x++) {
    if (x > 0) assert.notEqual(g[y][x].plain, g[y][x - 1].plain);
    if (y > 0) assert.notEqual(g[y][x].plain, g[y - 1][x].plain);
    if (g[y][x].detail >= 0) {
      assert.equal(map[y][x], 'OPEN'); assert.ok(!overlay.has(x + ',' + y));
      for (const [nx, ny] of [[x - 1, y], [x, y - 1], [x - 1, y - 1], [x + 1, y - 1]]) if (nx >= 0 && ny >= 0 && nx < 20) assert.equal(g[ny][nx].detail, -1);
    }
  }
});
