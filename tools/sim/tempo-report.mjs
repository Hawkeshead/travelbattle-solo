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
let soloLosses = 0, matches = 0, totalFights = 0;

const g = await loadGame();
const render = await import('../../js/render-board.js');
const menus  = await import('../../js/ui-menus.js');
collapseTimers();
const { data, dice, rules } = g; const { state, SIDES } = data;
const cheb = (a,b) => Math.max(Math.abs(a.x-b.x), Math.abs(a.y-b.y));

for (let seed = 1; seed <= N; seed++) {
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
process.exit(0);
