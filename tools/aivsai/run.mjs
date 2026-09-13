/* =========================================================
   AI-VS-AI RUNNER

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

   Usage:  node tools/aivsai/run.mjs [matches] [--seed N] [--json out.json]
========================================================= */
import { loadGame, collapseTimers } from './headless-env.mjs';
import fs from 'fs';

/* Captured BEFORE collapseTimers replaces the global. The runner still needs a
   real clock to poll and to time out with; only the game's own pacing goes. */
const realSetInterval = globalThis.setInterval;
const POLL_MS = 4;
const MATCH_TIMEOUT_MS = 60_000;

export async function runOneMatch({ seed }, g) {
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

  const t0 = Date.now();
  menus.beginBoardSetup();

  const finished = await waitForEnd(state, MATCH_TIMEOUT_MS);
  const living = side => state.units.filter(u => !u.removed && u.side === side).length;

  return {
    seed,
    finished,                       // 'win' | 'timeout'
    winner: state.winner || null,
    turns: state.turnNumber,
    wallMs: Date.now() - t0,
    board: JSON.stringify(state.boardAssignment) + ' rot ' + JSON.stringify(state.boardRotation),
    survivors: { red: living(SIDES.RED), blue: living(SIDES.BLUE) },
    brokenBrigades: countBrokenBrigades(state, SIDES),
    stall: finished === 'timeout' ? snapshotStall(state, SIDES) : null,
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
      if (Date.now() - t0 > timeoutMs) { clearInterval(poll); resolve('timeout'); return; }
    }, POLL_MS);
  });
}

/* ---------------------------------------------------------
   AGGREGATION
--------------------------------------------------------- */
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
  lines.push(`timed out          ${results.filter(r => r.finished === 'timeout').length}`);
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
    lines.push('SEEDS THAT DID NOT FINISH CLEANLY (reproduce with: node tools/aivsai/run.mjs 1 --seed N)');
    for (const r of stuck) {
      lines.push(`  seed ${r.seed} ${r.finished} at turn ${r.turns}` +
                 (r.stall ? `  survivors ${r.survivors.red}v${r.survivors.blue}` +
                            `  closest units ${r.stall.minGap} apart, ${r.stall.contacts} in contact` : ''));
    }
    lines.push('  (the seed does not fix the map, so these do not replay — use --json for the board snapshot)');
  }
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
async function runChild(seed) {
  const g = await loadGame();
  g.render = await import('../../js/render-board.js');
  g.menus  = await import('../../js/ui-menus.js');
  collapseTimers();
  const r = await runOneMatch({ seed }, g);
  process.stdout.write('\u0001RESULT' + JSON.stringify(r) + '\n');
  process.exit(0);
}

export async function main() {
  const args = process.argv.slice(2);
  const childAt = args.indexOf('--child');
  if (childAt > -1) return runChild(Number(args[childAt + 1]));

  const { spawn } = await import('node:child_process');
  const n = Number(args.find(a => /^\d+$/.test(a)) || 5);
  const jsonAt = args.indexOf('--json');
  const seedAt = args.indexOf('--seed');
  const firstSeed = seedAt > -1 ? Number(args[seedAt + 1]) : 1;

  const results = [];
  for (let i = 0; i < n; i++) {
    const seed = firstSeed + i;
    const r = await new Promise(resolve => {
      let out = '';
      const child = spawn(process.execPath, [process.argv[1], '--child', String(seed)],
                          { cwd: process.cwd() });
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', () => {});   // game logging, not wanted in a batch
      child.on('close', code => {
        const line = out.split('\n').find(l => l.startsWith('\u0001RESULT'));
        if (line) { resolve(JSON.parse(line.slice(7))); return; }
        /* A CRASH IS A RESULT TOO, and the most interesting kind: it names a
           seed that breaks the game rather than merely stalling it. */
        resolve({ seed, finished: 'crashed', winner: null, turns: 0, wallMs: 0,
                  exitCode: code, survivors: { red: 0, blue: 0 } });
      });
    });
    results.push(r);
    console.log(`  seed ${r.seed}  ${r.finished.padEnd(7)} winner=${String(r.winner).padEnd(5)}` +
                ` turns=${String(r.turns).padStart(3)}  survivors ${r.survivors.red}v${r.survivors.blue}` +
                `  ${(r.wallMs / 1000).toFixed(1)}s`);
  }
  console.log('\n' + summarise(results));
  if (jsonAt > -1) {
    fs.writeFileSync(args[jsonAt + 1], JSON.stringify(results, null, 2));
    console.log(`\nwritten to ${args[jsonAt + 1]}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
