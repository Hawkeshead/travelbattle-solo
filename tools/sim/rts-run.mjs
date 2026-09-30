#!/usr/bin/env node
/* =========================================================
   REAL-TIME SIMULATOR: AI against AI, tick by tick, as fast as the CPU
   allows (never in real time), with the real turn-based rules through the
   same adapter the browser uses.

   Run:  node tools/sim/rts-run.mjs [matches=6] [firstSeed=1]

   Per match: length, how it ended (break or clock), orders spent and how many
   were banked on average, unit idle time, artillery's share of kills, melee
   rounds per fight, and whether it stalled. Sides are swapped every match;
   because the board favours the northern deployer (about 61/39 in turn-based),
   only overall figures count, never the per-side split.
========================================================= */
import { loadGame } from './headless-env.mjs';

const N = Number(process.argv[2] || 6), SEED0 = Number(process.argv[3] || 1);
const g = await loadGame();
const { state, SIDES } = g.data;
g.dice.setFastDiceMode(true);
const { setupBattle } = await import('../../js/rts/setup.js');
const { step, isBusy } = await import('../../js/rts/sim.js');
const { createAi, aiTick } = await import('../../js/rts/ai.js');
const { turnBasedRules: R } = await import('../../js/rts/rules-adapter.js');
const { TICKS_PER_SECOND, MATCH_CLOCK_TICKS } = await import('../../js/rts/constants.js');

const rows = [];
for(let i = 0; i < N; i++){
  const seed = SEED0 + i;
  g.rules.seedRng(seed);
  state.mode = 'ai'; state.aiSide = SIDES.BLUE;
  const b = setupBattle(i % 2 ? SIDES.BLUE : SIDES.RED);
  const ais = [createAi('red', { phase: 0 }), createAi('blue', { phase: 10 })];
  let idle = 0, samples = 0, bankSum = 0, bankN = 0;
  const t0 = Date.now();
  while(!b.over && b.tick < MATCH_CLOCK_TICKS + 1){
    step(b, R);
    for(const ai of ais) aiTick(ai, b, R);
    if(b.tick % 50 === 0){
      for(const u of b.units){ if(u.removed || u.type === 'BRIGADIER') continue; samples++; if(!isBusy(u) && !Object.values(b.fights).some(f => f.a === u.id || f.d === u.id)) idle++; }
      for(const k of Object.keys(b.pools)){ bankSum += b.pools[k].orders; bankN++; }
    }
  }
  const destroyed = (b.stats.destroyed.red || 0) + (b.stats.destroyed.blue || 0);
  const spent = ais.reduce((s, a) => s + a.stats.ordersIssued, 0);
  const row = {
    seed, minutes: +(b.tick / TICKS_PER_SECOND / 60).toFixed(1), result: b.result, winner: b.winner || 'draw',
    stalled: b.result === 'clock' && destroyed < 4,
    ordersSpent: spent, refused: ais.reduce((s, a) => s + a.stats.refused, 0),
    avgBanked: +(bankSum / Math.max(1, bankN)).toFixed(2),
    idlePct: Math.round(100 * idle / Math.max(1, samples)),
    destroyed, artilleryShare: destroyed ? Math.round(100 * (b.stats.artilleryKills || 0) / destroyed) : 0,
    roundsPerFight: +(b.stats.rounds / Math.max(1, b.stats.fights)).toFixed(2),
    wallSec: +((Date.now() - t0) / 1000).toFixed(1),
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}
const avg = k => +(rows.reduce((s, r) => s + r[k], 0) / rows.length).toFixed(2);
const decided = rows.filter(r => r.winner !== 'draw');
console.log('\nSUMMARY');
console.log(`matches ${rows.length}  decided ${decided.length}  by break ${rows.filter(r => r.result === 'break').length}  on the clock ${rows.filter(r => r.result === 'clock').length}  stalled ${rows.filter(r => r.stalled).length}`);
console.log(`minutes avg ${avg('minutes')}  orders spent avg ${avg('ordersSpent')}  refused avg ${avg('refused')}  banked avg ${avg('avgBanked')}  idle ${avg('idlePct')}%`);
console.log(`artillery share of kills ${avg('artilleryShare')}%  melee rounds per fight ${avg('roundsPerFight')}  wall ${avg('wallSec')}s per match`);
process.exit(0);
