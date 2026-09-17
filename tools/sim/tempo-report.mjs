/* =========================================================
   TEMPO REPORT — did the army arrive together?

   The win rate cannot answer that. A spectated match gives BOTH armies the same
   AI, so a change that makes an army attack as one makes both armies attack as
   one and the advantage cancels: the result reads as noise whether the system
   works perfectly or not at all.

   These are the measures that do answer it, taken per side and averaged:

   BRIGADE CONTACT SPREAD is the headline. The turn each Brigade first came into
   contact, largest minus smallest. Under 3 means the army arrived together; 6 or
   more means it is still turning up in ones and twos. Measured from ADJACENCY
   rather than from fight events, so a Brigade that closes and is then beaten to
   the punch still counts as having arrived.

   FIGHTS BEFORE AND AFTER COMMIT, over the five turns each side of it. If COMMIT
   means anything, the five turns after it hold more fighting than the five
   before.

   SOLO LOSSES counts units that fought once and lost, which is the shape of
   arriving alone: five in the match that prompted this work.

   Usage:  node tools/sim/tempo-report.mjs [matches] [variant]
========================================================= */
import { loadGame, collapseTimers } from './headless-env.mjs';
import { resolveVariant } from './variants.mjs';

const realSetInterval = globalThis.setInterval;
const N = Number(process.argv[2] || 6);
const VARIANT = process.argv[3] || 'control';

const spreads = [], commitTurns = [], holdOverruns = [], noCommit = [];
const fightsBefore = [], fightsAfter = [];
let soloLosses = 0, matches = 0, totalFights = 0, stalled = 0;

const g = await loadGame();
const render = await import('../../js/render-board.js');
const menus  = await import('../../js/ui-menus.js');
collapseTimers();
const { data, dice, rules } = g; const { state, SIDES } = data;
const cheb = (a,b) => Math.max(Math.abs(a.x-b.x), Math.abs(a.y-b.y));

const CHILD = process.argv.includes('--child');
const SEEDS = CHILD ? [Number(process.argv[process.argv.indexOf('--child') + 1])]
                    : Array.from({ length: N }, (_, i) => i + 1);
for (const seed of (CHILD ? SEEDS : [])) {
  dice.setFastDiceMode(true); render.setFastAnimationMode(true);
  state.scenario = null; state.campaign = null; state.mode = 'ai';
  state.spectate = true; state.aiDifficulty = 'hard';
  state.aiSide = SIDES.RED; state.gameOver = false; state.winner = null; state.turnNumber = 1;
  state.aiConfig = { red: resolveVariant(VARIANT), blue: resolveVariant(VARIANT) };
  rules.seedRng(seed);

  const firstContact = {};   // `${side}:${brigadeId}` -> turn
  menus.beginBoardSetup();
  await new Promise(resolve => {
    const poll = realSetInterval(() => {
      for (const u of state.units) {
        if (u.removed) continue;
        const k = `${u.side}:${u.brigadeId}`;
        if (firstContact[k] !== undefined) continue;
        const touching = state.units.some(o => !o.removed && o.side !== u.side && cheb(o, u) <= 1);
        if (touching) firstContact[k] = state.turnNumber;
      }
      if (state.gameOver || state.turnNumber > 400) { clearInterval(poll); resolve(); }
    }, 4);
  });
  matches++;
  if (state.turnNumber > 400) stalled++;

  for (const side of ['red', 'blue']) {
    const turns = Object.entries(firstContact).filter(([k]) => k.startsWith(side + ':')).map(([, v]) => v);
    if (turns.length >= 2) spreads.push(Math.max(...turns) - Math.min(...turns));

    const t = state._tempo && state._tempo[side];
    const commits = (state.matchLog || []).filter(e => e.type === 'tempo' && e.side === side && e.to === 'COMMIT');
    if (!commits.length) noCommit.push(side); else commitTurns.push(commits[0].turn);
    for (const c of commits) {
      const f = w => (state.matchLog || []).filter(e => e.type === 'fight' &&
        e.turn >= c.turn + w[0] && e.turn <= c.turn + w[1]).length;
      fightsBefore.push(f([-5, -1])); fightsAfter.push(f([1, 5]));
    }
    const holds = (state.matchLog || []).filter(e => e.type === 'tempo' && e.side === side && e.from === 'HOLD');
    for (const h of holds) if (t && h.turn - (t.since || 0) > 6) holdOverruns.push(h.turn);
  }
  /* A unit that fought once and lost: the signature of arriving alone. */
  const fights = (state.matchLog || []).filter(e => e.type === 'fight');
  totalFights += fights.length;
  const tally = {};
  for (const f of fights) {
    for (const id of [f.attackerId, f.defenderId]) (tally[id] = tally[id] || []).push(f);
  }
  for (const id of Object.keys(tally)) {
    if (tally[id].length !== 1) continue;
    const u = state.units.find(x => x.id === id);
    if (u && u.removed) soloLosses++;
  }
  process.stderr.write(`  seed ${seed} done (turn ${state.turnNumber})\n`);
}

/* ONE MATCH PER PROCESS, for the same reason run.mjs does it and which this file
   did NOT do until now: the game's state is a module singleton and a finished
   match leaves residue behind it, so a second match in the same process starts
   part-played. It was producing matches that "ended" at turn 1. Every number
   this tool reported before this change is therefore only trustworthy for the
   first match of each run, which is to say not trustworthy.

   The child prints its tallies as JSON and the parent sums them. */
if (CHILD) {
  process.stdout.write('\u0001TALLY' + JSON.stringify({
    spreads, commitTurns, noCommit: noCommit.length, fightsBefore, fightsAfter,
    soloLosses, totalFights, stalled, matches,
  }) + '\n');
  process.exit(0);
}

/* PARENT: spawn one child per match and sum their tallies. */
{
  const { spawn } = await import('node:child_process');
  const os = await import('node:os');
  const jobs = Math.max(1, Math.min(8, os.cpus().length || 4));
  const runOne = seed => new Promise(resolve => {
    let out = '';
    const c = spawn(process.execPath, [process.argv[1], '1', VARIANT, '--child', String(seed)],
                    { cwd: process.cwd() });
    c.stdout.on('data', d => { out += d; });
    c.stderr.on('data', () => {});
    c.on('close', () => {
      const line = out.split('\n').find(l => l.startsWith('\u0001TALLY'));
      resolve(line ? JSON.parse(line.slice(6)) : null);
    });
  });
  const seeds = Array.from({ length: N }, (_, i) => i + 1);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(jobs, N) }, async () => {
    while (next < seeds.length) {
      const seed = seeds[next++];
      const r = await runOne(seed);
      if (!r) { process.stderr.write(`  seed ${seed} CRASHED\n`); continue; }
      spreads.push(...r.spreads); commitTurns.push(...r.commitTurns);
      fightsBefore.push(...r.fightsBefore); fightsAfter.push(...r.fightsAfter);
      for (let i = 0; i < r.noCommit; i++) noCommit.push('x');
      soloLosses += r.soloLosses; totalFights += r.totalFights;
      stalled += r.stalled; matches += r.matches;
      process.stderr.write(`  seed ${seed} done\n`);
    }
  }));
}

const avg = a => a.length ? (a.reduce((t, v) => t + v, 0) / a.length) : null;
const fmt = v => v === null ? 'n/a' : v.toFixed(1);
console.log(`\n=== TEMPO REPORT — variant '${VARIANT}', ${matches} matches ===\n`);
console.log(`Brigade contact spread   ${fmt(avg(spreads))} turns   (target under 3)`);
console.log(`  worst seen             ${spreads.length ? Math.max(...spreads) : 'n/a'}`);
console.log(`First COMMIT turn        ${fmt(avg(commitTurns))}`);
console.log(`Sides with no COMMIT     ${noCommit.length}   (target 0)`);
console.log(`Fights 5 turns BEFORE    ${fmt(avg(fightsBefore))}`);
console.log(`Fights 5 turns AFTER     ${fmt(avg(fightsAfter))}   (target: higher than before)`);
console.log(`Units 0 from 1           ${(soloLosses / matches).toFixed(1)} per match   (target under 2)`);
console.log(`Fights per match         ${(totalFights / matches).toFixed(1)}`);
/* THE STALL RATE, MEASURED WITH THE CHANGE ON BOTH SIDES.

   run.mjs puts a variant on ONE side, which is right for a win rate and wrong
   for this: a stall needs BOTH armies to refuse to commit, so a one-sided test
   can only ever half-fix it and will understate any real effect. This report
   applies the variant to both, which is the only way to read a stall rate. */
console.log(`Matches that stalled     ${stalled} of ${matches}  (${(stalled/matches*100).toFixed(0)}%)`);
process.exit(0);
