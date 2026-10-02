// Content tests for the Scenario Cards (data/scenario-cards.json) and the
// campaign flows (data/campaigns.json): Operations and Campaigns brief, step 1.
//
// They read the JSON directly and use the card validator the game itself runs
// (js/scenario-validate.js, which needs no browser), so they run anywhere in
// well under a second. Deployment and the objective engine are tested in
// step 2.
//
// Run with:  node --test test/

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateCard } from '../js/scenario-validate.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => JSON.parse(readFileSync(join(root, 'data', f), 'utf8'));
const { cards } = read('scenario-cards.json');
const flows = read('campaigns.json');
const byId = new Map(cards.map((c) => [c.id, c]));

test('25 cards: 11 Battles and 14 Operations, each id once', () => {
  assert.equal(cards.length, 25);
  assert.equal(cards.filter((c) => c.kind === 'battle').length, 11);
  assert.equal(cards.filter((c) => c.kind === 'operation').length, 14);
  assert.equal(byId.size, cards.length, 'duplicate card ids');
});

test('every card validates (ready cards in full, draft cards for their forces)', () => {
  const faults = cards.flatMap(validateCard);
  assert.deepEqual(faults, []);
});

test('Flanders is ready (3 Battles, 4 Operations); Peninsular and Waterloo are drafts with no win conditions', () => {
  const flanders = cards.filter((c) => c.campaign === 'flanders');
  assert.equal(flanders.length, 7);
  assert.ok(flanders.every((c) => c.status === 'ready'));
  const others = cards.filter((c) => c.campaign !== 'flanders');
  assert.ok(others.every((c) => c.status === 'draft'));
  assert.ok(others.filter((c) => c.kind === 'operation').every((c) => c.win === null));
});

test('every area a condition or placement names is on its map, with a square for every unit placed', () => {
  // validateCard checks this; asserted here per card so a failure names it.
  for (const c of cards.filter((x) => x.status === 'ready' && x.kind === 'operation')) {
    const areaFaults = validateCard(c).filter((m) => /area/.test(m));
    assert.deepEqual(areaFaults, [], c.id);
  }
});

test('every campaign step and branch option points at an existing card', () => {
  const missing = [];
  for (const f of flows) for (const s of f.steps) {
    for (const id of (s.type === 'branch' ? s.options : [s.card])) if (!byId.has(id)) missing.push(`${f.id}/${s.id}: ${id}`);
  }
  assert.deepEqual(missing, []);
});

test('no em dashes in any carried-over text (house style)', () => {
  const text = readFileSync(join(root, 'data', 'scenario-cards.json'), 'utf8') + readFileSync(join(root, 'data', 'campaigns.json'), 'utf8');
  assert.equal((text.match(/\u2014/g) || []).length, 0);
});

test('a card with a fault is reported, not passed', () => {
  const bad = JSON.parse(JSON.stringify(byId.get('op-lincelles')));
  bad.win.british.conditions[0].area = 'nowhere';
  bad.forces.french.brigades[0].units = ['INFANTRY', 'INFANTRY'];
  bad.specialRules = { madeUpRule: true };
  const faults = validateCard(bad);
  assert.ok(faults.some((m) => /area "nowhere"/.test(m)));
  assert.ok(faults.some((m) => /Brigadiers/.test(m)));
  assert.ok(faults.some((m) => /madeUpRule/.test(m)));
});
