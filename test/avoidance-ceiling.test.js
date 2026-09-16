/* THE AVOIDANCE INVARIANT, ASSERTED SO IT CANNOT DRIFT SILENTLY AGAIN.

   Two terms grew past engage's reach without anyone noticing: brigadierTrail hit
   -6.30 and freeStrandedUnit -7.20 against an engage that reached +3.00, so a
   Brigadier faced -13.50 for doing anything other than reconnecting and would
   turn down a winning fight to go and tidy up. Neither weight had changed. Both
   are weight x distance, and a weight that is fine at one square is not fine at
   eight, and nothing checked the product.

   READ FROM THE SOURCE TEXT rather than imported. Importing ai-strategy pulls in
   the whole DOM chain, and the test suite deliberately runs without a browser
   shim. Parsing the declarations keeps this dependency-free, and what it guards
   is exactly a declaration being edited.

   Asserted against the CONFIGURED ceiling, not against whatever a term happened
   to reach in a match. Three separate briefs have now asked for a fix to a term
   that was inside its bounds all along, because the export shows observed values
   and the two get confused.
*/
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../js/ai-strategy.js', import.meta.url), 'utf8');
const num = name => {
  const m = src.match(new RegExp(`export const ${name}\\s*=\\s*([0-9.]+)`));
  assert.ok(m, `${name} not found in ai-strategy.js`);
  return Number(m[1]);
};

test('no avoidance ceiling may outweigh the best possible fight', () => {
  const engageMax = num('ENGAGE_CLAMP') * num('ENGAGE_WEIGHT');
  for (const name of ['AVOIDANCE_CEILING', 'THREAT_SCORE_MAX']) {
    assert.ok(num(name) < engageMax,
      `${name} is ${num(name)}, which is not below engage's ${engageMax}`);
  }
});

test('the distance-scaled avoidance terms still have a gradient', () => {
  /* The weights are deliberately large: they are what gives a Brigadier a slope
     to walk down. The cap is what stops the product running away. Both must
     hold, so this checks the weights are non-zero as well as the cap. */
  assert.ok(num('BRIGADIER_TRAIL_WEIGHT') > 0);
  assert.ok(num('STRANDED_RECOVERY_PULL') > 0);
  assert.ok(num('AVOIDANCE_CEILING') < num('ENGAGE_CLAMP') * num('ENGAGE_WEIGHT'));
});
