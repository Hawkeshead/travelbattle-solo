// Campaign battles deploy every Brigade in one piece (js/operation-placement.js):
// a unit not linked to its Brigadier through touching units is cut off and can
// never move. Only a card's deliberate placement.split may start one apart.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { storyToCard } from '../js/story.js';
import { planOperationPlacement } from '../js/operation-placement.js';

const glyph = { '.': 'OPEN', '^': 'HILL', '*': 'WOODS', '#': 'BUILDING', ':': 'PLOUGHED_FIELD', '=': 'ROAD' };
for(const f of ['waterloo', 'peninsula']){
  const d = JSON.parse(fs.readFileSync(new URL(`../data/story/${f}.json`, import.meta.url)));
  test(`${f}: every Brigade starts in one piece, unless its card splits it`, () => {
    for(const b of d.battles) for(const nation of Object.keys(b.sides)){
      const card = storyToCard(b, nation, f);
      const terrain = card.map.terrain.map(r => [...r].map(ch => glyph[ch] || 'OPEN'));
      const plan = planOperationPlacement(card, terrain).filter(p => !p.reserve);
      for(const key of ['british', 'french']) card.forces[key].brigades.forEach((br, i) => {
        if(br.placement && br.placement.split) return;
        const side = key === 'british' ? 'red' : 'blue';
        const g = plan.filter(p => p.side === side && p.brigadeId === i);
        const brig = g.find(p => p.type === 'BRIGADIER');
        if(!brig) return;
        const seen = new Set([brig]), q = [brig];
        while(q.length){ const c = q.shift(); for(const o of g) if(!seen.has(o) && Math.max(Math.abs(o.x - c.x), Math.abs(o.y - c.y)) === 1){ seen.add(o); q.push(o); } }
        assert.equal(seen.size, g.length, `${b.id} (${nation}) ${side} Brigade ${i} (${br.name}) starts in pieces`);
      });
    }
  });
}
