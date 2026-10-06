// Adds roads to the hand-drawn Flanders maps (data/scenario-cards.json), to
// the same rules as a generated board (js/map-generator.js roadsForTerrain):
// every 10 x 10 board gets exits at square 7 on all four edges, one or two
// networks, a road through every village, buildings as road, no dead ends,
// no long straights. A 20 x 10 Battle map is two boards side by side, each
// done on its own; their row-7 exits meet at the seam.
// Writes map.roads as rows of '=' (road) and '.' (none). Deterministic: the
// seed is fixed per card, so rerunning gives the same roads.
// Run: node tools/maps/add-roads.mjs [card ids...]
import fs from 'fs';
import { roadsForTerrain, validateBoard } from '../../js/map-generator.js';
const GLYPH = { '.': 'OPEN', ':': 'PLOUGHED_FIELD', '*': 'WOODS', '^': 'HILL', '#': 'BUILDING', '=': 'ROAD' };
const FILE = new URL('../../data/scenario-cards.json', import.meta.url);
const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const want = process.argv.slice(2);
const ids = want.length ? want : ['op-lincelles', 'op-caesars-camp', 'op-beaumont', 'op-willems', 'battle-famars', 'battle-hondschoote', 'battle-tourcoing'];
const seedOf = id => [...id].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);
for (const id of ids) {
  const card = data.cards.find(c => c.id === id);
  const rows = card.map.terrain;
  const W = rows[0].length;
  const out = rows.map(() => Array(W).fill('.'));
  for (let half = 0; half < W / 10; half++) {
    const terrain = rows.map(r => [...r.slice(half * 10, half * 10 + 10)].map(ch => GLYPH[ch]));
    let road = null, s = seedOf(id) + half * 1000;
    for (let k = 0; k < 20 && !road; k++) road = roadsForTerrain(terrain, s + k);
    if (!road) throw new Error(`${id}: no valid roads for board ${half + 1}`);
    const errs = validateBoard({ terrain, road }).filter(e => e !== 'no village');
    if (errs.length) throw new Error(`${id}: ${errs.join('; ')}`);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) if (road[y][x]) out[y][half * 10 + x] = '=';
  }
  card.map.roads = out.map(r => r.join(''));
  console.log(id); console.log(rows.map((r, y) => [...r].map((ch, x) => out[y][x] === '=' ? (ch === '.' ? '=' : ch === '#' ? '#' : ch === '^' ? 'H' : ch === '*' ? 'W' : 'F') : ch).join('')).join('\n'));
}
fs.writeFileSync(FILE, JSON.stringify(data, null, 1) + '\n');
