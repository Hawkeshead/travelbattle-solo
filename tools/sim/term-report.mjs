/* =========================================================
   TERM REPORT — which terms are actually deciding moves

   The simulator reports outcomes. This reports MECHANISM: for every move the AI
   makes, which scoring term separated the square it chose from the ones it did
   not, and how often each term wins that comparison across a run.

   WIDEST SPREAD, NOT LARGEST VALUE, which is the whole point and is easy to get
   wrong. A term worth a constant -3.00 on every candidate square decides
   nothing: it cancels out. A term worth +0.40 on one square and -0.10 on the
   rest decides that move. So each term is scored by (max - min) across the
   candidates considered, and the widest spread is credited with the decision.

   SECOND CAVEAT, and the larger one, found while recording the Cerberus
   baseline. The poll samples _aiDebugLog on a 4ms REAL-time interval while the
   game's own timers are collapsed, so turns can be overwritten before they are
   ever seen. A match that ran 401 turns contributed 349 sampled moves; one that
   ran 47 turns contributed 21, which is far short of its real move count. Long
   matches are therefore over-represented twice over: they last longer AND they
   sample more densely. Since long matches are usually STALLED matches, the
   totals lean toward the terms that dominate a stall (brigadierTrail,
   freeStrandedUnit) and understate the terms that decide a fighting match.
   Reading a rank table across mixed matches is safe; reading it as "this is how
   the AI decides a battle" is not. Fixing this properly means sampling on the
   activation itself rather than polling.

   CAVEAT, stated because it changes how the numbers should be read: the AI's
   debug record keeps the chosen square plus its best three alternatives, not
   every candidate. Spread is therefore measured across four squares rather than
   twenty-odd, which understates terms that only separate a poor option from a
   good one and is fair to every term equally. Good for ranking, not for exact
   counts.

   Also tallies artillery shots by range, since "are the guns close enough" is
   read off the same run.

   Usage:  node tools/sim/term-report.mjs [matches] [variant]
                                          [--from N] [--json out.json]
========================================================= */
import { loadGame, collapseTimers } from './headless-env.mjs';
import { resolveVariant } from './variants.mjs';

const realSetInterval = globalThis.setInterval;
const args = process.argv.slice(2);
const N = Number(args.find(a => /^\d+$/.test(a)) || 6);
const VARIANT = args.find(a => !/^[-\d]/.test(a)) || 'control';

/* --from lets a long baseline be built across several runs and merged, which
   matters because a single match can run to the 400-turn cap and a batch of
   four will outlast most timeouts. --json writes the raw tallies so separate
   runs can be summed rather than eyeballed. */
const fromAt = args.indexOf('--from');
const FROM = fromAt > -1 ? Number(args[fromAt + 1]) : 1;
const jsonAt = args.indexOf('--json');
const JSON_OUT = jsonAt > -1 ? args[jsonAt + 1] : null;

const decides = new Map();      // term -> moves it decided
const appears = new Map();      // term -> moves it was present on
const fireRange = new Map();    // chebyshev range -> shots
let moves = 0, matches = 0;

const bump = (m, k, n = 1) => m.set(k, (m.get(k) || 0) + n);

function tallyMove(entry) {
  const dec = entry.decision;
  if (!dec || !dec.chosen || !dec.chosen.parts) return;
  const rows = [dec.chosen.parts, ...(dec.alternatives || []).map(a => a.parts).filter(Boolean)];
  if (rows.length < 2) return;            // nothing to compare against
  moves++;
  const keys = new Set(rows.flatMap(r => Object.keys(r)));
  let best = null, bestSpread = 0;
  for (const k of keys) {
    if (k === 'jitter') continue;         // a tiebreak, not a reason
    const vals = rows.map(r => r[k] || 0);
    const spread = Math.max(...vals) - Math.min(...vals);
    bump(appears, k, 0); appears.set(k, (appears.get(k) || 0) + 1);
    if (spread > bestSpread) { bestSpread = spread; best = k; }
  }
  if (best && bestSpread > 0.0001) bump(decides, best);
}

const g = await loadGame();
const render = await import('../../js/render-board.js');
const menus  = await import('../../js/ui-menus.js');
collapseTimers();
const { data, dice, rules } = g; const { state, SIDES } = data;

for (let seed = FROM; seed < FROM + N; seed++) {
  dice.setFastDiceMode(true); render.setFastAnimationMode(true);
  state.scenario = null; state.campaign = null; state.mode = 'ai';
  state.spectate = true; state.aiDifficulty = 'hard';
  state.aiSide = SIDES.RED; state.gameOver = false; state.winner = null; state.turnNumber = 1;
  state.aiConfig = { red: resolveVariant(VARIANT), blue: resolveVariant(VARIANT) };
  rules.seedRng(seed);

  const seen = new Set();
  menus.beginBoardSetup();
  await new Promise(resolve => {
    const poll = realSetInterval(() => {
      /* Sampled as the match runs, because _aiDebugLog holds only the CURRENT
         turn for each side and is overwritten every activation. A key of side
         plus turn keeps the same activation from being counted twice while the
         poll spins. */
      for (const side of ['red', 'blue']) {
        const d = state._aiDebugLog && state._aiDebugLog[side];
        if (!d || !d.moveLog) continue;
        const key = `${side}:${d.turn}`;
        if (seen.has(key)) continue;
        seen.add(key);
        for (const m of d.moveLog) tallyMove(m);
      }
      for (const e of (state.matchLog || [])) {
        if (e.type !== 'fire' || e._counted) continue;
        e._counted = true;
        const gun = state.units.find(u => u.id === e.gunId);
        if (gun) bump(fireRange, Math.max(Math.abs(gun.x - e.x), Math.abs(gun.y - e.y)));
      }
      if (state.gameOver || state.turnNumber > 400) { clearInterval(poll); resolve(); }
    }, 4);
  });
  matches++;
  process.stderr.write(`  seed ${seed} done (turn ${state.turnNumber})\n`);
}

console.log(`\n=== TERM REPORT — variant '${VARIANT}', ${matches} matches, ${moves} moves ===\n`);
const ranked = [...decides.entries()].sort((a, b) => b[1] - a[1]);
console.log('rank  term                        decided    % of moves');
ranked.slice(0, 15).forEach(([k, v], i) => {
  console.log(`${String(i + 1).padStart(4)}  ${k.padEnd(26)} ${String(v).padStart(7)}    ${(v / moves * 100).toFixed(1)}%`);
});
const engageRank = ranked.findIndex(([k]) => k === 'engage');
console.log(`\nengage: ${engageRank === -1 ? 'never decided a move' : `rank ${engageRank + 1}, ${ranked[engageRank][1]} moves`}`);

console.log('\n=== ARTILLERY SHOTS BY RANGE ===');
const ranges = [...fireRange.entries()].sort((a, b) => a[0] - b[0]);
const shots = ranges.reduce((t, [, v]) => t + v, 0);
for (const [r, v] of ranges) console.log(`  range ${r}  ${String(v).padStart(4)}  ${(v / shots * 100).toFixed(1)}%`);
const far = ranges.filter(([r]) => r >= 5).reduce((t, [, v]) => t + v, 0);
console.log(`\n  at range 5-6: ${far} of ${shots}  (${shots ? (far / shots * 100).toFixed(1) : 0}%)`);
if (JSON_OUT) {
  const obj = {
    variant: VARIANT, from: FROM, matches, moves,
    decides: Object.fromEntries(decides), appears: Object.fromEntries(appears),
    fireRange: Object.fromEntries(fireRange)
  };
  (await import('node:fs')).writeFileSync(JSON_OUT, JSON.stringify(obj, null, 2));
  process.stderr.write(`  wrote ${JSON_OUT}\n`);
}

/* The JSON write MUST come before this. It was once appended after it and so
   never ran, silently, for a whole baseline recording. */
process.exit(0);
