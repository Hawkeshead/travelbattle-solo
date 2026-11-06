/* =========================================================
   COMMAND CHECK (6 Nov 2026)

   Every campaign battle should start with every unit in command: linked to
   its Brigadier through touching units of its own Brigade, so it can move on
   the first turn the chain counts. For each campaign card (each battle, from
   each nation's side), sets the battle up as the game does (setupOperation),
   then asks the engine which units may move with the chain in force (round 2,
   after any first-turn waiver) and lists those that may not.

   Usage:  node tools/sim/command-check.mjs        (exit 1 if any unit is cut off)
========================================================= */
import { loadGame, collapseTimers } from './headless-env.mjs';

const g = await loadGame();
const ops = await import('../../js/operations.js');
const cards = await import('../../js/scenario-cards.js');
collapseTimers();
const { state } = g.data;
let bad = 0, n = 0;
const seen = new Set();
for (const c of cards.allCards().filter(c => c.kind === 'operation' && c.status === 'ready' && /^(peninsula|waterloo)-/.test(c.id))) {
  if (seen.has(c.id)) continue; seen.add(c.id);
  g.rules.seedRng(1);
  ops.setupOperation(c.id, null);
  state.turnNumber = 3; state.phase = 'move';
  const out = [], meant = [];
  for (const side of ['red', 'blue']) {
    const movable = g.rules.movableUnitsForSide(side);
    const brigades = c.forces[side === 'red' ? 'british' : 'french'].brigades;
    for (const u of state.units) {
      if (u.removed || u.side !== side || u.x < 0 || movable.has(u.id)) continue;
      const line = `${side} ${u.historicalName || u.type} (${u.x},${u.y}) Bde ${u.brigadeId}`;
      // A Brigade placed square by square (placement.split) is left where the
      // battle puts it on purpose (operations.js regroupBrigades): listed, not failed.
      const p = (brigades[u.brigadeId] || {}).placement || {};
      (p.split ? meant : out).push(line);
    }
  }
  n++;
  if (out.length) { bad++; console.log(`${c.id}: ${out.length} cut off\n  ` + out.join('\n  ')); }
  if (meant.length) console.log(`${c.id}: ${meant.length} placed apart on purpose (split placement)\n  ` + meant.join('\n  '));
}
console.log(`${n} cards checked, ${bad} with units cut off at the start`);
process.exit(bad ? 1 : 0);
