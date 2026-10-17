/* NATIONS (js/nations.js) AND THE UNIT ARCHIVE BY NATION.

   The archive is keyed by nation since 17 Oct 2026 (Britain, France, and
   Prussia as a second Coalition nation). Unit names are handed out per
   nation in list order and wrap when a list runs out, and a name is also the
   key a portrait is found by, so every list must hold exactly the standard
   number and every name must be unique across all nations. */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { DEFAULT_NATIONS, NATIONS, TEAM_OF_SIDE, nationFor, nationKeyFor, nationsForSide } from '../js/nations.js';

const ARCHIVE = JSON.parse(fs.readFileSync(new URL('../data/unit-archive.json', import.meta.url), 'utf8'));
const STANDARD = { BRIGADIER: 3, GUARD: 2, INFANTRY: 6, HEAVY_CAV: 2, LIGHT_CAV: 2, ARTILLERY: 2 };

test('every registered nation has a full roster, and every roster a nation', () => {
  assert.deepStrictEqual(Object.keys(ARCHIVE).sort(), Object.keys(NATIONS).sort());
  for(const [key, roster] of Object.entries(ARCHIVE)){
    for(const [type, n] of Object.entries(STANDARD)){
      assert.strictEqual((roster[type] || []).length, n, `${key} ${type}: ${(roster[type] || []).length}, want ${n}`);
      for(const e of roster[type]){ assert.ok(e.name && e.bio, `${key} ${type}: an entry without a name or bio`); }
    }
  }
});

test('every unit name is unique across all nations (names are the portrait key)', () => {
  const names = Object.values(ARCHIVE).flatMap(r => Object.values(r).flat().map(e => e.name));
  const seen = new Set();
  for(const n of names){ assert.ok(!seen.has(n), `"${n}" appears twice`); seen.add(n); }
});

test('the Prussian names keep their umlauts', () => {
  const names = Object.values(ARCHIVE.prussia).flat().map(e => e.name);
  for(const n of ['Blücher', 'Bülow', 'Lützow', 'Lützow Free Corps Infantry', 'Lützow Free Corps Uhlans', 'Lützow Free Corps Battery']) assert.ok(names.includes(n), n);
});

test('the registry: teams, limits, and Britain against France by default', () => {
  assert.deepStrictEqual(DEFAULT_NATIONS, { red: 'britain', blue: 'france' });
  assert.strictEqual(NATIONS.britain.team, 'coalition');
  assert.strictEqual(NATIONS.prussia.team, 'coalition');
  assert.strictEqual(NATIONS.france.team, 'imperial');
  assert.strictEqual(NATIONS.britain.maxArmies, 1);
  assert.strictEqual(NATIONS.prussia.maxArmies, 1);
  assert.strictEqual(NATIONS.france.maxArmies, null);
  for(const n of Object.values(NATIONS)) assert.strictEqual(TEAM_OF_SIDE[n.side], n.team, `${n.key} fights on the wrong side`);
  // A Coalition nation never faces another: only Coalition nations can take red.
  assert.deepStrictEqual(nationsForSide('red').map(n => n.key).sort(), ['britain', 'prussia']);
  assert.deepStrictEqual(nationsForSide('blue').map(n => n.key), ['france']);
});

test('a match saved before nations existed reads as Britain against France', () => {
  assert.strictEqual(nationKeyFor(undefined, 'red'), 'britain');
  assert.strictEqual(nationKeyFor({}, 'blue'), 'france');
  assert.strictEqual(nationKeyFor({ red: 'nowhere' }, 'red'), 'britain');
  assert.strictEqual(nationFor({ red: 'prussia', blue: 'france' }, 'red').name, 'Prussia');
});
