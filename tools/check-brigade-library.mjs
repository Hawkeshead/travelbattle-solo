#!/usr/bin/env node
/* Does the brigade library actually produce a game?

   A template list can look generous and still collapse, because the binding
   constraint is not brigade SIZE, it is unit TYPE. The pool holds exactly two
   Guard, two Heavy, two Light and two Artillery, so the moment one card spends
   one of a scarce pair the other two must absorb the exact complement. Six Line
   is the only slack in the whole pool.

   The v1 library was designed against size and checked afterwards: 4 legal
   armies out of 2,300 and 15 of 25 cards unplaceable. This check exists so that
   cannot happen again quietly.

   COUNTS WITH REPLACEMENT, because a template may be fielded twice in one army.
   That is a locked decision and it is load-bearing: it adds eight armies, and
   two of the five 6/6/2 armies exist only because of it. Counting plain
   combinations under-reports by exactly those eight and then wrongly calls the
   cards involved dead.

     node tools/check-brigade-library.mjs [--armies]

   A DEAD CARD is worse than an unbalanced one: it renders in the picker, reads
   as available, and can never be chosen. Failure names them rather than
   counting them, so a future template edit says which card it killed. */
import { readFileSync } from 'node:fs';

const EXPECTED_ARMIES = 42;

const lib = JSON.parse(readFileSync(new URL('../data/brigade-library.json', import.meta.url)));
const { pool, brigadesPerSide, brigades } = lib;
const minBrigade = lib.brigadeSize.min;
const maxBrigade = lib.brigadeSize.max;
const poolTotal = Object.values(pool).reduce((a, b) => a + b, 0);

function legal(combo){
  const tot = {};
  let n = 0;
  for(const b of combo){
    if(b.size < minBrigade || b.size > maxBrigade) return false;
    for(const u of b.units){ tot[u] = (tot[u] || 0) + 1; n++; }
  }
  if(n !== poolTotal) return false;
  return Object.entries(tot).every(([k, v]) => v <= (pool[k] || 0));
}

const armies = [];
(function pick(start, acc){
  if(acc.length === brigadesPerSide){ if(legal(acc)) armies.push([...acc]); return; }
  for(let i = start; i < brigades.length; i++){
    acc.push(brigades[i]);
    pick(i, acc);            // i, not i + 1: a template may repeat
    acc.pop();
  }
})(0, []);

const alive = new Set(armies.flat().map(b => b.id));
const dead = brigades.filter(b => !alive.has(b.id));
const splits = {};
for(const a of armies){
  const k = a.map(b => b.size).sort((x, y) => y - x).join('/');
  splits[k] = (splits[k] || 0) + 1;
}
const repeats = armies.filter(a => new Set(a.map(b => b.id)).size < brigadesPerSide).length;

let combos = 1;  // multiset coefficient, matching the with-replacement search
for(let i = 0; i < brigadesPerSide; i++) combos = combos * (brigades.length + i) / (i + 1);

console.log(`brigade library: ${brigades.length} templates, pool ${poolTotal}`);
console.log(`combinations ${Math.round(combos)} -> legal armies ${armies.length} (${repeats} use a repeated template)`);
console.log(`reachable splits: ${Object.entries(splits).sort().map(([k, v]) => `${k} x${v}`).join(', ') || 'none'}`);
if(process.argv.includes('--armies')){
  for(const a of armies) console.log('  ' + a.map(b => `${b.name}(${b.size})`).join(' + '));
}

let ok = true;
if(dead.length){
  ok = false;
  console.log(`\nDEAD CARDS — in no legal army (${dead.length} of ${brigades.length}):`);
  for(const b of dead) console.log(`  ${b.id.padEnd(22)} ${b.size}  ${b.units.join(' ')}`);
}
if(armies.length !== EXPECTED_ARMIES){
  ok = false;
  console.log(`\nARMY COUNT CHANGED: ${armies.length}, expected ${EXPECTED_ARMIES}.`);
  console.log('If the library was edited on purpose, update EXPECTED_ARMIES in this file.');
}
console.log(ok ? '\nLibrary check passed.' : '\nLIBRARY CHECK FAILED.');
process.exit(ok ? 0 : 1);
