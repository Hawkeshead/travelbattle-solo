/* =========================================================
   THE RECORDER GATE (telemetry build spec, step 3)

   The same seed with the recorder on and off must give the same match and a
   byte-identical text export. This plays each seed twice, once each way, in
   fresh processes, and compares: the winner, the turn count, the survivors,
   the whole match export and the AI move logs. It also checks every record
   against tools/telemetry/record.schema.json and reports how many events a
   match produces.

   Math.random is seeded too, per match, because the board draw uses it
   rather than the game's own dice: without that the two runs of a seed would
   be on different maps and could never match.

   Usage: node tools/telemetry/recorder-check.mjs [matches] [--seed N] [--jobs J] [--report]
========================================================= */
import fs from 'node:fs';

const args = process.argv.slice(2);

if (args[0] === '--child') {
  const seed = Number(args[1]), on = args[2] === 'on';
  // Seeded Math.random BEFORE the game loads (mulberry32).
  let a = seed >>> 0;
  Math.random = () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const { loadGame, collapseTimers } = await import('../sim/headless-env.mjs');
  const { runOneMatch } = await import('../sim/run.mjs');
  const g = await loadGame();
  g.render = await import('../../js/render-board.js');
  g.menus = await import('../../js/ui-menus.js');
  g.router = await import('../../js/ai-router.js');
  const recorder = await import('../../js/telemetry/recorder.js');
  recorder.setRecorderEnabled(on);
  collapseTimers();
  const r = await runOneMatch({ seed }, g);
  const st = g.data.state;
  // Lines that state the wall-clock time are the only ones allowed to differ.
  const norm = t => String(t).split('\n').filter(l => !/^(Started|Ended)\s*:/.test(l)).map(l => l.replace(/\(about \d+ min ago\)/, '')).join('\n');
  const exportText = norm(g.replay.exportFullMatchLog());
  const moveLogs = ['red', 'blue'].map(side => { st.aiSide = side; try { return g.ai.exportAiMoveLog(); } catch (e) { return 'ERR ' + e.message; } }).join('\n=====\n');
  const rec = recorder.currentRecord();
  const out = {
    seed, on,
    outcome: { finished: r.finished, winner: r.winner, turns: r.turns, survivors: r.survivors },
    exportText, moveLogs,
    record: rec ? JSON.parse(JSON.stringify(rec)) : null,
  };
  fs.writeFileSync(`/tmp/fc-reccheck-${seed}-${on ? 'on' : 'off'}.json`, JSON.stringify(out));
  process.stdout.write('\u0001DONE\n');
  process.exit(0);
}

const n = Number(args.find(x => /^\d+$/.test(x)) || 50);
const seedAt = args.indexOf('--seed'), first = seedAt > -1 ? Number(args[seedAt + 1]) : 1;
const jobsAt = args.indexOf('--jobs');
const jobs = jobsAt > -1 ? Number(args[jobsAt + 1]) : Math.min(8, (await import('node:os')).cpus().length || 4);
const { spawn } = await import('node:child_process');
const Ajv = (await import('ajv')).default;
const validate = new Ajv({ allErrors: true }).compile(JSON.parse(fs.readFileSync(new URL('./record.schema.json', import.meta.url))));

const run = (seed, mode) => new Promise(res => {
  const c = spawn(process.execPath, [process.argv[1], '--child', String(seed), mode], { cwd: process.cwd() });
  let o = ''; c.stdout.on('data', d => o += d); c.stderr.on('data', () => {});
  c.on('close', () => res(o.includes('\u0001DONE')));
});
/* --report reads the results already written for these seeds instead of
   playing them again (a long batch can be played in parts, then reported once). */
const tasks = [];
if (!args.includes('--report')) for (let i = 0; i < n; i++) for (const m of ['off', 'on']) tasks.push([first + i, m]);
let next = 0;
await Promise.all(Array.from({ length: jobs }, async () => { while (next < tasks.length) { const [s, m] = tasks[next++]; await run(s, m); } }));

let same = 0, diff = 0, invalid = 0, missing = 0;
const counts = [], bytes = [], types = {}, faults = [];
for (let i = 0; i < n; i++) {
  const seed = first + i;
  const f = m => { try { return JSON.parse(fs.readFileSync(`/tmp/fc-reccheck-${seed}-${m}.json`, 'utf8')); } catch { return null; } };
  const off = f('off'), on = f('on');
  if (!off || !on) { missing++; console.log(`seed ${seed}: a run crashed`); continue; }
  const eq = JSON.stringify(off.outcome) === JSON.stringify(on.outcome) && off.exportText === on.exportText && off.moveLogs === on.moveLogs;
  if (eq) same++; else {
    diff++;
    const a = off.exportText.split('\n'), b = on.exportText.split('\n');
    const at = a.findIndex((l, k) => l !== b[k]);
    console.log(`seed ${seed}: DIFFERENT  outcome off ${JSON.stringify(off.outcome)} on ${JSON.stringify(on.outcome)}; first export difference at line ${at}: "${a[at]}" vs "${b[at]}"`);
  }
  if (off.record) { console.log(`seed ${seed}: the recorder was OFF but a record exists`); diff++; }
  if (!on.record) { console.log(`seed ${seed}: no record with the recorder on`); invalid++; continue; }
  if (!validate(on.record)) { invalid++; console.log(`seed ${seed}: record invalid: ${JSON.stringify(validate.errors.slice(0, 3))}`); }
  counts.push(on.record.events.length); bytes.push(JSON.stringify(on.record).length);
  for (const e of on.record.events) types[e.type] = (types[e.type] || 0) + 1;
  if (on.record.derived.recorder_faults) faults.push(`${seed}: ${on.record.derived.recorder_faults} (${(on.record.derived.fault_notes || []).slice(0, 2).join('; ')})`);
}
const stat = xs => { const s = [...xs].sort((p, q) => p - q); return s.length ? `min ${s[0]}, median ${s[Math.floor(s.length / 2)]}, max ${s[s.length - 1]}` : 'n/a'; };
console.log(`\n${n} seeds: ${same} identical with the recorder on and off, ${diff} different, ${missing} crashed, ${invalid} records invalid`);
console.log(`events per match: ${stat(counts)}`);
console.log(`record size (JSON bytes): ${stat(bytes)}`);
console.log(`events by type (all matches): ${Object.entries(types).sort((p, q) => q[1] - p[1]).map(([k, v]) => k + ' ' + v).join(', ')}`);
console.log(`recorder faults: ${faults.length ? faults.join(' | ') : 'none'}`);
process.exit(diff || missing || invalid ? 1 : 0);
