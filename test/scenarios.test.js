// Content tests for data/scenarios.json and data/campaigns.json.
//
// These check the Operation data against the rules the deployment screen
// actually enforces. They need no browser and no game code — they read the
// JSON directly, so they run anywhere in well under a second.
//
// Run with:  node --test test/

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => JSON.parse(readFileSync(join(root, 'data', f), 'utf8'));

const scenarios = read('scenarios.json');
const campaigns = read('campaigns.json');
const unitTypes = read('unit-types.json');

const SIDES = ['red', 'blue'];

// The deployment screen requires every side to field exactly 3 Brigades, and
// refuses to confirm a Brigade with fewer than 2 non-Brigadier units:
//
//   js/ui-deployment.js:43   sideFullyDeployed  -> deployBrigadeIndex >= 3
//   js/ui-deployment.js:238  confirmCurrentBrigade -> currentBrigadeCount >= 2
//
// So a playable roster needs at least 3 BRIGADIER and at least 6 others.
// A roster below that cannot finish deployment: the Confirm button never
// enables and there is no error message. The match soft-locks.
const MIN_BRIGADIERS = 3;
const MIN_OTHERS = 6;

const rosterOf = (scenario, side) => {
  const units = scenario.sides[side].units;
  const brigadiers = units.filter((u) => u === 'BRIGADIER').length;
  return { units, brigadiers, others: units.length - brigadiers };
};

test('every scenario has both sides defined with a unit list', () => {
  for (const s of scenarios) {
    for (const side of SIDES) {
      assert.ok(s.sides?.[side]?.units, `${s.id}/${side} has no unit list`);
      assert.ok(Array.isArray(s.sides[side].units), `${s.id}/${side} units is not an array`);
      assert.ok(s.sides[side].units.length > 0, `${s.id}/${side} unit list is empty`);
    }
  }
});

test('every unit key in every roster exists in unit-types.json', () => {
  const known = new Set(Object.keys(unitTypes.unitTypes));
  for (const s of scenarios) {
    for (const side of SIDES) {
      for (const u of s.sides[side].units) {
        assert.ok(known.has(u), `${s.id}/${side} references unknown unit type "${u}"`);
      }
    }
  }
});

// KNOWN FAILING — this is a real, player-facing bug, not a flaky test.
//
// 12 of the 28 side-rosters cannot complete deployment, which makes 11 of the
// 14 Operations unplayable. Only op-caesars-camp, op-beaumont and op-sabugal
// are deployable on both sides today.
//
// The fix is a data change (top up the short rosters) or a code change (let a
// Brigade hold fewer than 2 units when the scenario roster is small). Once
// either lands, delete this skip and the test guards the invariant forever.
test('every scenario roster can actually be deployed', { skip: 'known bug — see TRIAGE.md' }, () => {
  const broken = [];
  for (const s of scenarios) {
    for (const side of SIDES) {
      const { brigadiers, others } = rosterOf(s, side);
      if (brigadiers < MIN_BRIGADIERS || others < MIN_OTHERS) {
        broken.push(`${s.id}/${side}: ${brigadiers} Brigadiers, ${others} others`);
      }
    }
  }
  assert.deepEqual(broken, [], `undeployable rosters:\n  ${broken.join('\n  ')}`);
});

// The inverse of the test above: it passes today and will start failing the
// moment someone "fixes" a roster by accident, or adds a new broken one. This
// keeps an honest, checked-in record of the damage until it is repaired.
test('the set of undeployable rosters has not grown', () => {
  const known = new Set([
    'op-lincelles/blue',
    'op-garcia-hernandez/red',
    'op-willems/blue',
    'op-coa/red',
    'op-barba-del-puerco/red',
    'op-barba-del-puerco/blue',
    'op-el-bodon/red',
    'op-arroyo-dos-molinos/blue',
    'op-hougoumont/red',
    'op-la-haye-sainte/red',
    'op-papelotte/red',
    'op-frischermont/red',
  ]);

  const found = new Set();
  for (const s of scenarios) {
    for (const side of SIDES) {
      const { brigadiers, others } = rosterOf(s, side);
      if (brigadiers < MIN_BRIGADIERS || others < MIN_OTHERS) found.add(`${s.id}/${side}`);
    }
  }

  const regressions = [...found].filter((k) => !known.has(k));
  assert.deepEqual(regressions, [], `NEW undeployable rosters introduced: ${regressions.join(', ')}`);

  const fixed = [...known].filter((k) => !found.has(k));
  if (fixed.length) {
    console.log(`  note: ${fixed.length} roster(s) repaired — remove from the known list: ${fixed.join(', ')}`);
  }
});

test('every campaign branch points at a scenario that exists', () => {
  const ids = new Set(scenarios.map((s) => s.id));
  const dangling = [];
  for (const c of campaigns) {
    for (const step of c.flow) {
      if (step.type !== 'branch') continue;
      for (const opt of step.options) {
        // Options flagged `locked` are deliberate "coming soon" placeholders
        // and are allowed to dangle until their mechanics are built.
        if (opt.locked) continue;
        if (!ids.has(opt.operationId)) dangling.push(`${c.id} -> ${opt.operationId}`);
      }
    }
  }
  assert.deepEqual(dangling, [], `campaign branches reference missing scenarios:\n  ${dangling.join('\n  ')}`);
});

test('locked campaign options are the only dangling references', () => {
  const ids = new Set(scenarios.map((s) => s.id));
  const lockedDangling = [];
  for (const c of campaigns) {
    for (const step of c.flow) {
      if (step.type !== 'branch') continue;
      for (const opt of step.options) {
        if (opt.locked && !ids.has(opt.operationId)) lockedDangling.push(opt.operationId);
      }
    }
  }
  // Documents the two Operations promised in the UI but not yet built.
  assert.deepEqual(
    lockedDangling.sort(),
    ['op-colbert', 'op-dukes-narrow-escape'],
    'the set of unbuilt "coming soon" Operations changed'
  );
});

test('scenarios with a CAPTURE_ZONE objective and no turn limit are recorded', () => {
  // Objectives are only evaluated when a unit is removed (checkWinCondition is
  // called from removeUnit, js/engine-rules.js:661) or when a turn limit is
  // reached. A CAPTURE_ZONE scenario with turnLimit null can therefore stall
  // forever if both sides stop taking casualties.
  const stallable = scenarios
    .filter((s) => s.turnLimit == null)
    .filter((s) => s.objective?.conditions?.some((c) => c.type === 'CAPTURE_ZONE'))
    .map((s) => s.id)
    .sort();

  assert.deepEqual(
    stallable,
    ['op-frischermont', 'op-lincelles', 'op-willems'],
    'the set of potentially unresolvable CAPTURE_ZONE scenarios changed'
  );
});
