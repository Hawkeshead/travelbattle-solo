/* =========================================================
   THE SIMULATOR

   Plays full matches with the same AI on both sides, headless, and aggregates
   the results.

   HOW BOTH SIDES ARE DRIVEN. It does not drive them. Spectate mode already does,
   in js/, and this runs that: state.spectate points state.aiSide at whichever
   side is acting, so the same scoring, the same weights and the same doctrine
   play both. The runner sets the flag, starts the match and reads the result.

   THAT IS THE WHOLE DESIGN CHANGE FROM THE PREVIOUS VERSION. The old runner
   carried its own turn driver and two kicks (re-arm the deploy chain, press
   Start Battle) because there was no in-game path for an unattended match.
   Spectate is that path, so all of it is gone. What runs here is what runs on
   the phone, which is the only way a batch result says anything about the game
   that is actually played.

   Usage:  node tools/sim/run.mjs [matches] [--seed N] [--json out.json]
========================================================= */
import { loadGame, collapseTimers } from './headless-env.mjs';
import fs from 'fs';
import { resolveVariant } from './variants.mjs';

/* Captured BEFORE collapseTimers replaces the global. The runner still needs a
   real clock to poll and to time out with; only the game's own pacing goes. */
const realSetInterval = globalThis.setInterval;
const POLL_MS = 4;

/* A STALLED MATCH IS CAPPED ON TURNS, NOT ON THE CLOCK.

   A wall-clock timeout was costing sixty seconds per stall, which at a 15% rate
   was most of the running time of every batch: forty matches took fifteen
   minutes, of which nine were spent watching armies not move.

   400 side activations is 200 full rounds. The longest match that has ever
   DECIDED is 252 activations, so the cap cannot cut a real game short, and a
   stall reaches it in about two seconds instead of sixty. Same information,
   twenty times faster, and it is deterministic rather than dependent on how busy
   the machine was.

   The wall-clock limit stays as a backstop for a match that hangs rather than
   stalls (a frozen callback chain stops advancing turnNumber at all, so the turn
   cap would never fire). It should never be the thing that trips. */
const MATCH_TURN_CAP = 400;
const MATCH_TIMEOUT_MS = 45_000;

export async function runOneMatch({ seed, variant = 'control', variantSide = null }, g) {
  const { data, dice, rules, render, menus } = g;
  const { state, SIDES } = data;

  dice.setFastDiceMode(true);
  render.setFastAnimationMode(true);

  /* Exactly what the Spectate button sets, and nothing else. If this list ever
     drifts from ui-menus, the runner stops testing the shipped mode. */
  state.scenario = null;
  state.campaign = null;
  state.mode = 'ai';
  state.spectate = true;
  state.aiDifficulty = 'hard';
  state.aiSide = SIDES.RED;
  state.gameOver = false;
  state.winner = null;
  state.turnNumber = 1;

  /* Deterministic per match so any single result can be reproduced. NOTE: board
     assignment and rotation in beginBoardSetup use Math.random directly rather
     than the seeded generator, so THE SEED FIXES THE DICE, NOT THE MAP. The
     board drawn is recorded per match below so a result stays identifiable. */
  rules.seedRng(seed);

  /* THE VARIANT IS AN OVERRIDE TABLE ON ONE SIDE, NOT A SECOND AI.

     ai-strategy reads every wired weight through tune(side, ...), which falls
     back to the module constant when a side has no entry. So the control side
     literally runs the shipped code path with no overrides, rather than a copy
     of it that could drift. Both armies share the same scoring, the same
     doctrine and the same everything else, which is the only way the win rate
     isolates the change. */
  state.aiConfig = { red: {}, blue: {} };
  if (variantSide) state.aiConfig[variantSide] = resolveVariant(variant);

  const t0 = Date.now();
  menus.beginBoardSetup();

  const finished = await waitForEnd(state, MATCH_TIMEOUT_MS);
  const living = side => state.units.filter(u => !u.removed && u.side === side).length;

  const variantWon = variantSide && state.winner
    ? (state.winner === variantSide ? 'variant' : 'control') : null;

  return {
    seed,
    variant, variantSide, variantWon,
    finished,                       // 'win' | 'stalled' | 'hung'
    winner: state.winner || null,
    turns: state.turnNumber,
    wallMs: Date.now() - t0,
    board: JSON.stringify(state.boardAssignment) + ' rot ' + JSON.stringify(state.boardRotation),
    survivors: { red: living(SIDES.RED), blue: living(SIDES.BLUE) },
    brokenBrigades: countBrokenBrigades(state, SIDES),
    stall: finished === 'win' ? null : snapshotStall(state, SIDES),
  };
}

/* A broken brigade is the win condition, so it is the one tally worth taking
   from every match rather than reconstructing it later from the log. */
function countBrokenBrigades(state, SIDES) {
  const out = { red: 0, blue: 0 };
  for (const side of [SIDES.RED, SIDES.BLUE]) {
    const key = side === SIDES.RED ? 'red' : 'blue';
    /* brigadeId, NOT brigade. The first version of this read u.brigade, which
       does not exist on a unit, so every unit grouped under one undefined key
       and the tally was silently meaningless rather than wrong-looking. */
    const brigades = new Set(state.units.filter(u => u.side === side).map(u => u.brigadeId));
    for (const b of brigades) {
      const alive = state.units.filter(u => u.side === side && u.brigadeId === b &&
                                            !u.removed && u.type !== 'BRIGADIER').length;
      if (alive === 0) out[key]++;
    }
  }
  return out;
}


function readLogTail(n) {
  try {
    const el = document.getElementById('log');
    if (!el) return [];
    return [...el.children].slice(-n).map(d => d.textContent);
  } catch { return []; }
}

/* WHAT A STALLED MATCH LOOKED LIKE AT THE MOMENT IT WAS ABANDONED.

   A match that will not end is the most valuable thing a long run finds and the
   hardest to get back, because the seed does not fix the map (see above), so
   re-running the same seed plays a different battle. Confirmed the hard way:
   seed 5 timed out at turn 2380 in one batch and finished at turn 82 on the next
   run. The snapshot therefore has to be taken while it is happening. */
function snapshotStall(state, SIDES) {
  const live = side => state.units.filter(u => !u.removed && u.side === side);
  const r = live(SIDES.RED), b = live(SIDES.BLUE);
  let minGap = 99, contacts = 0;
  for (const a of r) for (const c of b) {
    const d = Math.max(Math.abs(a.x - c.x), Math.abs(a.y - c.y));
    if (d < minGap) minGap = d;
    if (d <= 1) contacts++;
  }
  const place = us => us.map(u => `${u.type}@${u.x},${u.y}${u.formation === 'line' ? '' : '/' + u.formation}`);
  return {
    minGap, contacts,
    red: place(r), blue: place(b),
    /* log() writes straight into the #log element rather than onto state, so
       the tail is read back out of the DOM. Headless that DOM is jsdom's, which
       is why this works at all. */
    tail: readLogTail(25),
    events: (state.matchLog || []).slice(-15),
  };
}

/* Resolves when the match reports itself over, or when the wall clock runs out.
   A TIMEOUT IS A RESULT, NOT AN ERROR. A match that will not end is exactly the
   thing a long run exists to find, so it is recorded against its seed rather
   than crashing the batch. */
function waitForEnd(state, timeoutMs) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const poll = realSetInterval(() => {
      if (state.gameOver) { clearInterval(poll); resolve('win'); return; }
      /* 'stalled' and 'hung' are different results and are reported separately.
         A stall is two armies that will not commit and is a finding about the
         AI; a hang is the game not advancing at all and is a bug. Collapsing
         them into one 'timeout' hid that distinction for three batches. */
      if (state.turnNumber > MATCH_TURN_CAP) { clearInterval(poll); resolve('stalled'); return; }
      if (Date.now() - t0 > timeoutMs) { clearInterval(poll); resolve('hung'); return; }
    }, POLL_MS);
  });
}

/* ---------------------------------------------------------
   AGGREGATION
--------------------------------------------------------- */
/* THE VARIANT VERDICT.

   UNDECIDED MATCHES ARE EXCLUDED, not scored as draws. A stall is a failure of
   both AIs to commit and says nothing about which weights are better; folding it
   in as half a win would let a change that made matches MORE likely to stall
   look neutral. The count is reported on its own line instead, where a variant
   that raises the stall rate is visible as the regression it is. That has
   already happened twice.

   The 60/55 thresholds are the brief's and they are not arbitrary: on ~170
   decided matches the standard error on a win rate is about 4 points, so 55% is
   inside noise and 60% is not. */
function verdict(results) {
  const played = results.filter(r => r.variantSide);
  if (!played.length) return null;
  const decided = played.filter(r => r.finished === 'win' && r.variantWon);
  const lines = ['', '=== VARIANT vs CONTROL ==='];
  const tally = set => {
    const w = set.filter(r => r.variantWon === 'variant').length;
    return { w, n: set.length, pct: set.length ? Math.floor((w / set.length) * 1000) / 10 : 0 };
  };
  const all = tally(decided);
  const asRed  = tally(decided.filter(r => r.variantSide === 'red'));
  const asBlue = tally(decided.filter(r => r.variantSide === 'blue'));
  lines.push(`variant '${played[0].variant}'`);
  lines.push(`decided            ${decided.length} of ${played.length}` +
             `   (${played.length - decided.length} excluded: stalled, hung or crashed)`);
  lines.push(`variant win rate   ${all.w}/${all.n}  ${all.pct}%`);
  lines.push(`  as Britain       ${asRed.w}/${asRed.n}  ${asRed.pct}%`);
  lines.push(`  as France        ${asBlue.w}/${asBlue.n}  ${asBlue.pct}%`);
  const bothSides = asRed.pct > 50 && asBlue.pct > 50;
  lines.push('');
  lines.push(all.pct >= 60 && bothSides ? 'IMPROVEMENT: above 60% and present on both sides of the swap.'
    : all.pct >= 60 ? 'INCONCLUSIVE: above 60% overall but NOT on both sides. That is a side effect, not a change effect.'
    : all.pct > 55 ? 'WORTH A SECOND RUN: between 55% and 60%.'
    : all.pct < 45 ? 'REGRESSION: the control is winning.'
    : 'NOISE: within 55%, no effect detected.');
  return lines.join('\n');
}

export function summarise(results) {
  const done = results.filter(r => r.finished === 'win');
  const wins = { red: 0, blue: 0, none: 0 };
  for (const r of done) {
    if (r.winner === 'red') wins.red++;
    else if (r.winner === 'blue') wins.blue++;
    else wins.none++;
  }
  const turns = done.map(r => r.turns).sort((a, b) => a - b);
  const pct = n => (results.length ? Math.floor((n / results.length) * 1000) / 10 : 0);
  const median = turns.length ? turns[Math.floor(turns.length / 2)] : null;

  const lines = [];
  lines.push(`matches            ${results.length}`);
  lines.push(`completed          ${done.length} (${pct(done.length)}%)`);
  lines.push(`stalled            ${results.filter(r => r.finished === 'stalled').length} (${pct(results.filter(r => r.finished === 'stalled').length)}%)`);
  lines.push(`hung               ${results.filter(r => r.finished === 'hung').length}`);
  lines.push(`crashed            ${results.filter(r => r.finished === 'crashed').length}`);
  lines.push('');
  lines.push(`Britain (red) wins ${wins.red} (${pct(wins.red)}%)`);
  lines.push(`France (blue) wins ${wins.blue} (${pct(wins.blue)}%)`);
  if (wins.none) lines.push(`no winner recorded ${wins.none}`);
  if (turns.length) {
    lines.push('');
    lines.push(`turns   shortest ${turns[0]}  median ${median}  longest ${turns[turns.length - 1]}`);
    const surv = done.reduce((a, r) => ({ red: a.red + r.survivors.red, blue: a.blue + r.survivors.blue }),
                             { red: 0, blue: 0 });
    lines.push(`mean survivors   Britain ${Math.floor(surv.red / done.length * 10) / 10}` +
               `  France ${Math.floor(surv.blue / done.length * 10) / 10}`);
  }
  const stuck = results.filter(r => r.finished !== 'win');
  if (stuck.length) {
    lines.push('');
    lines.push('SEEDS THAT DID NOT FINISH CLEANLY (reproduce with: node tools/sim/run.mjs 1 --seed N)');
    for (const r of stuck) {
      lines.push(`  seed ${r.seed} ${r.finished} at turn ${r.turns}` +
                 (r.stall ? `  survivors ${r.survivors.red}v${r.survivors.blue}` +
                            `  closest units ${r.stall.minGap} apart, ${r.stall.contacts} in contact` : ''));
    }
    lines.push('  (seeds reproduce exactly — stall-probe.mjs takes the same seed)');
  }
  const v = verdict(results);
  if (v) lines.push(v);
  return lines.join('\n');
}

/* ---------------------------------------------------------
   ONE MATCH PER PROCESS

   The game keeps its state in a module singleton, and a finished match leaves
   things behind: a deferred endGame timer waiting out the brigade-break
   dispatch, the previous roster, the undo stack. Running a second match in the
   same process produced instant turn-1 "wins" from that residue, which is a
   harness artefact and would have quietly poisoned a hundred-match tally.

   Rather than hunt every field that needs clearing (and re-hunt it whenever a
   new one is added), each match gets a clean process. It costs about a second
   of module loading per match and buys total isolation, plus a crashed match
   now loses one result instead of the batch.
--------------------------------------------------------- */
async function runChild(seed, variant, variantSide) {
  const g = await loadGame();
  g.render = await import('../../js/render-board.js');
  g.menus  = await import('../../js/ui-menus.js');
  collapseTimers();
  const r = await runOneMatch({ seed, variant, variantSide }, g);
  process.stdout.write('\u0001RESULT' + JSON.stringify(r) + '\n');
  process.exit(0);
}

export async function main() {
  const args = process.argv.slice(2);
  const childAt = args.indexOf('--child');
  if (childAt > -1) return runChild(Number(args[childAt + 1]), args[childAt + 2], args[childAt + 3] || null);

  const { spawn } = await import('node:child_process');
  const n = Number(args.find(a => /^\d+$/.test(a)) || 5);
  const jsonAt = args.indexOf('--json');
  const seedAt = args.indexOf('--seed');
  const firstSeed = seedAt > -1 ? Number(args[seedAt + 1]) : 1;

  /* RUN THEM IN PARALLEL. Each match is already its own process for isolation,
     so concurrency is free: they share nothing. Sequentially a forty-match batch
     was most of ten minutes, which is long enough that it stops being something
     you run after a change and starts being something you put off.

     Defaults to the machine's core count capped at 8. Results are collected by
     seed and sorted afterwards, so the printed order is stable and a batch is
     reproducible however the scheduler interleaves it. */
  const jobsAt = args.indexOf('--jobs');
  const jobs = Math.max(1, jobsAt > -1 ? Number(args[jobsAt + 1])
                                       : Math.min(8, (await import('node:os')).cpus().length || 4));

  const runOne = ({ seed, variant, variantSide }) => new Promise(resolve => {
    let out = '';
    const child = spawn(process.execPath,
      [process.argv[1], '--child', String(seed), variant, variantSide || ''],
      { cwd: process.cwd() });
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', () => {});   // game logging, not wanted in a batch
    child.on('close', code => {
      const line = out.split('\n').find(l => l.startsWith('\u0001RESULT'));
      if (line) { resolve(JSON.parse(line.slice(7))); return; }
      /* A CRASH IS A RESULT TOO, and the most interesting kind: it names a seed
         that breaks the game rather than merely stalling it. */
      resolve({ seed, variant, variantSide, variantWon: null, finished: 'crashed',
                winner: null, turns: 0, wallMs: 0, exitCode: code,
                survivors: { red: 0, blue: 0 } });
    });
  });

  const variant = args.includes('--variant') ? args[args.indexOf('--variant') + 1] : null;
  /* SWAP THE SIDES, ALWAYS, when running a variant. Every seed is played twice,
     once with the variant on Britain and once on France. Anything that makes a
     side more willing to close advantages whoever is not first into contact, so
     a one-sided run measures the side as much as the change. Reported split by
     side as well as pooled, so a result that only appears on one side is visible
     as the artefact it is rather than averaged into a verdict. */
  const seeds = [];
  for (let i = 0; i < n; i++) {
    const seed = firstSeed + i;
    if (!variant) { seeds.push({ seed, variant: 'control', variantSide: null }); continue; }
    seeds.push({ seed, variant, variantSide: 'red' });
    seeds.push({ seed, variant, variantSide: 'blue' });
  }
  const results = [];
  let next = 0, done = 0;
  console.log(`${seeds.length} matches, ${jobs} at a time` +
              (variant ? `  |  variant '${variant}' vs control, sides swapped` : '') + '\n');
  await Promise.all(Array.from({ length: Math.min(jobs, n) }, async () => {
    while (next < seeds.length) {
      const r = await runOne(seeds[next++]);
      results.push(r);
      done++;
      console.log(`  [${String(done).padStart(3)}/${seeds.length}] seed ${r.seed}  ${r.finished.padEnd(7)}` +
                  ` ${r.variantSide ? ('v=' + r.variantSide + ' ') : ''}winner=${String(r.winner).padEnd(5)} turns=${String(r.turns).padStart(3)}` +
                  `  survivors ${r.survivors.red}v${r.survivors.blue}  ${(r.wallMs / 1000).toFixed(1)}s`);
    }
  }));
  results.sort((a, b) => a.seed - b.seed || String(a.variantSide).localeCompare(String(b.variantSide)));
  console.log('\n' + summarise(results));
  if (jsonAt > -1) {
    fs.writeFileSync(args[jsonAt + 1], JSON.stringify(results, null, 2));
    console.log(`\nwritten to ${args[jsonAt + 1]}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
