/* THE SPYGLASS'S FACTOR STRIP NAMES EVERY AI TERM IN PLAIN WORDS.

   Every term ai-strategy adds into a square's score must have a label and an
   icon in js/spyglass-terms.js, so no code name ever reaches the screen. A new
   term added to the AI without a label fails here rather than showing as
   "Other". Read from the source text, like the other AI tests, so the suite
   still runs without a browser. */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { ICON_NAMES, TERM_KEYS, iconSvg, termOf } from '../js/spyglass-terms.js';

const aiSrc = fs.readFileSync(new URL('../js/ai-strategy.js', import.meta.url), 'utf8');
const used = new Set([...aiSrc.matchAll(/(?:addScore|subScore)\(parts,\s*'([A-Za-z]+)'/g)].map(m => m[1]));
// The one term key built at run time: a kill credit is 'finishing' or 'brigadeKillValue'.
used.add('brigadeKillValue'); used.add('finishing');

test('every score term the AI uses has a plain label', () => {
  assert.ok(used.size > 40, `found ${used.size} terms`);
  for(const k of used) assert.ok(TERM_KEYS.includes(k), `no label for the AI term "${k}"`);
});

test('labels are plain words: no code names, no dashes, and the tie-breaker is hidden', () => {
  assert.strictEqual(termOf('jitter'), null);
  for(const k of TERM_KEYS){
    const t = termOf(k);
    if(!t) continue;
    assert.ok(!/[A-Z][a-z]+[A-Z]/.test(t.label) && !/_/.test(t.label), `"${t.label}" looks like a code name`);
    assert.ok(!/[–—]/.test(t.label), `"${t.label}" has a dash`);
    assert.ok(ICON_NAMES.includes(t.icon), `no icon "${t.icon}" for ${k}`);
    assert.ok(iconSvg(t.icon).startsWith('<svg'), 'icons are inline SVG');
  }
});
