#!/usr/bin/env node
/* Real-Time tuning sweep: runs rts-run.mjs once per setting, each in its own
   process with globalThis.__RTS_TUNE set, and prints one summary line each.
   Values are in seconds.
   Run: node tools/sim/rts-sweep.mjs '{"MELEE_ROUND":[12,20,30],"ARTILLERY_RELOAD":[15,30]}' [matches=24] */
import { spawnSync } from 'node:child_process';
const grid = JSON.parse(process.argv[2] || '{}'), N = process.argv[3] || '24';
const keys = Object.keys(grid);
const combos = keys.reduce((acc, k) => acc.flatMap(c => grid[k].map(v => ({ ...c, [k]: v }))), [{}]);
for(const c of combos){
  const r = spawnSync(process.execPath, ['--import', 'data:text/javascript,globalThis.__RTS_TUNE=' + encodeURIComponent(JSON.stringify(c)),
    new URL('./rts-run.mjs', import.meta.url).pathname, N, '1'], { encoding: 'utf8' });
  const lines = (r.stdout || '').split('\n');
  const i = lines.indexOf('SUMMARY');
  console.log(JSON.stringify(c).padEnd(48), lines.slice(i + 1, i + 4).map(l => l.trim()).join(' | '));
}
