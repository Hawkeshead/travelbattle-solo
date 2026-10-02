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

// ---------------------------------------------------------------------------
// Step 2: placement and the objective engine, on the pure modules the game
// uses (js/operation-placement.js, js/objective-core.js).
import { planOperationPlacement } from '../js/operation-placement.js';
import { listMet, resolveEndOfRound, useWorld } from '../js/objective-core.js';

const OPEN = Array.from({ length: 10 }, () => Array(20).fill('OPEN'));
const opCards = cards.filter((c) => c.status === 'ready' && c.kind === 'operation');

test('every ready Operation deploys both sides: every unit placed, one per square, in its area or on its own rows', () => {
  for (const card of opCards) {
    const plan = planOperationPlacement(card, OPEN);
    const want = ['british', 'french'].reduce((n, k) => n + card.forces[k].brigades.reduce((m, b) => m + b.units.length, 0), 0);
    assert.equal(plan.length, want, card.id + ': units placed');
    assert.equal(new Set(plan.map((p) => p.x + ',' + p.y)).size, plan.length, card.id + ': two units on one square');
    for (const k of ['british', 'french']) {
      const side = k === 'british' ? 'red' : 'blue';
      const b = card.forces[k].brigades[0];
      const mine = plan.filter((p) => p.side === side);
      if (b.placement.type === 'area') {
        const areaNames = b.placement.split ? b.placement.split.map((g) => g.area) : [b.placement.area];
        const sq = new Set(areaNames.flatMap((a) => card.map.areas[a].map(([x, y]) => x + ',' + y)));
        assert.ok(mine.every((p) => sq.has(p.x + ',' + p.y)), `${card.id}: ${k} outside its area`);
      } else {
        const rows = side === 'red' ? [8, 9] : [0, 1];
        assert.ok(mine.every((p) => rows.includes(p.y)), `${card.id}: ${k} off its own rows`);
      }
    }
  }
});

// A small world: Lincelles's village, a few units.
const lincelles = byId.get('op-lincelles');
const U = (id, side, type, x, y, extra = {}) => Object.assign({ id, side, type, x, y, removed: false }, extra);
const card = (overrides) => Object.assign(JSON.parse(JSON.stringify(lincelles)), overrides);

test('HOLD_AREA forRounds advances once per round, however many units fall in it', () => {
  const c = card({});
  c.win.french = { combinator: 'any', conditions: [{ type: 'HOLD_AREA', area: 'village', forRounds: 2 }] };
  const streaks = {};
  const units = [U('f1', 'blue', 'INFANTRY', 8, 2), U('f2', 'blue', 'INFANTRY', 7, 3)];
  useWorld({ units, card: c, streaks });
  // Units die mid-round: instant checks must not move the counter.
  units[1].removed = true;
  assert.equal(listMet('blue', { endOfRound: false, round: 1 }), false);
  assert.equal(listMet('blue', { endOfRound: false, round: 1 }), false);
  assert.equal(listMet('blue', { endOfRound: true, round: 1, countRound: true }), false, 'one round held');
  assert.equal(listMet('blue', { endOfRound: true, round: 2, countRound: true }), true, 'two rounds held');
});

test('DESTROY ignores Brigadiers and units that marched off', () => {
  const c = card({});
  c.win.british = { combinator: 'any', conditions: [{ type: 'DESTROY', count: 2 }] };
  const units = [U('b', 'blue', 'BRIGADIER', 0, 0, { removed: true }), U('e', 'blue', 'INFANTRY', 0, 1, { removed: true, escaped: true }),
    U('k', 'blue', 'INFANTRY', 0, 2, { removed: true })];
  useWorld({ units, card: c, streaks: {} });
  assert.equal(listMet('red', { endOfRound: false, round: 3 }), false, 'only one real kill');
  units.push(U('k2', 'blue', 'ARTILLERY', 0, 3, { removed: true }));
  assert.equal(listMet('red', { endOfRound: false, round: 3 }), true);
});

test('MARCH_OFF counts the fraction (rounded up) and every type it must include', () => {
  const c = card({ _startFighters: { british: 4, french: 3 } });
  c.win.british = { combinator: 'all', conditions: [{ type: 'MARCH_OFF', fraction: 0.5, mustInclude: ['BRIGADIER'], byRound: 8 }] };
  const units = [U('a', 'red', 'INFANTRY', 0, 9, { removed: true, escaped: true })];
  useWorld({ units, card: c, streaks: {} });
  assert.equal(listMet('red', { endOfRound: false, round: 2 }), false, '1 of 2, no Brigadier');
  units.push(U('b', 'red', 'INFANTRY', 1, 9, { removed: true, escaped: true }));
  assert.equal(listMet('red', { endOfRound: false, round: 2 }), false, '2 of 2 but the Brigadier is still on the field');
  units.push(U('g', 'red', 'BRIGADIER', 2, 9, { removed: true, escaped: true }));
  assert.equal(listMet('red', { endOfRound: false, round: 2 }), true);
  assert.equal(listMet('red', { endOfRound: false, round: 9 }), false, 'too late: byRound 8');
});

test('ifBothMet and ifTimeExpires resolve; otherwise play goes on', () => {
  const c = card({});   // Lincelles: ifBothMet french, ifTimeExpires french, 8 rounds
  assert.deepEqual(resolveEndOfRound(c, ['red'], 3, null), { winner: 'red', how: null });
  assert.deepEqual(resolveEndOfRound(c, ['red', 'blue'], 3, null), { winner: 'blue', how: 'both' });
  assert.deepEqual(resolveEndOfRound(c, [], 8, null), { winner: 'blue', how: 'time' });
  assert.equal(resolveEndOfRound(c, [], 7, null), null);
  assert.deepEqual(resolveEndOfRound(c, [], 4, 'red'), { winner: 'red', how: 'wiped' });
});
