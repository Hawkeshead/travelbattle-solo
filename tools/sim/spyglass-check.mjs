/* =========================================================
   SPYGLASS CHECK: the decision trace changes nothing

   The Spyglass overlay (js/spyglass.js) reads a decision trace the AI writes
   as it decides (js/ai-trace.js). The trace must be read-only: switching it
   on may not change one move, one roll or one choice.

   This plays ONE match with a fixed seed twice, each in its own process,
   once with the trace off and once with it on (both sides traced), and
   compares every move, shot, fight, formation and ambush of the two. Same
   list means the trace is inert. It also reports how many decisions the
   traced run captured, so a trace that silently recorded nothing cannot
   pass for an inert one.

   Usage:  node tools/sim/spyglass-check.mjs [seed]     (default 7)
========================================================= */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadGame, collapseTimers } from './headless-env.mjs';

const KINDS = new Set(['move', 'fire', 'fight', 'formation', 'ambush', 'status', 'rally', 'leadership', 'turnStart']);
const TURN_CAP = 400, TIMEOUT_MS = 60_000;

async function child(seed, traceOn, outFile){
  const realSetInterval = globalThis.setInterval;
  const g = await loadGame();
  const render = await import('../../js/render-board.js');
  const menus = await import('../../js/ui-menus.js');
  const trace = await import('../../js/ai-trace.js');
  collapseTimers();
  const { state, SIDES } = g.data;
  g.dice.setFastDiceMode(true);
  render.setFastAnimationMode(true);
  state.scenario = null; state.campaign = null;
  state.mode = 'ai'; state.spectate = true; state.aiDifficulty = 'hard';
  state.aiSide = SIDES.RED; state.gameOver = false; state.winner = null; state.turnNumber = 1;
  state.aiConfig = { red: {}, blue: {} };
  g.rules.seedRng(seed);
  trace.setTraceCapture(traceOn);
  menus.beginBoardSetup();
  const t0 = Date.now();
  await new Promise(resolve => {
    const t = realSetInterval(() => {
      if(state.gameOver || state.turnNumber > TURN_CAP || Date.now() - t0 > TIMEOUT_MS){ clearInterval(t); resolve(); }
    }, 4);
  });
  // The match itself, without the bookkeeping that differs run to run.
  const events = (state.matchLog || []).filter(e => KINDS.has(e.type)).map(e => {
    const rest = { ...e }; delete rest.at; return JSON.stringify(rest);
  });
  const t = trace.traceStats();
  /* The whole game state at the end, AI memory included (its plans, caches
     and move history), so a trace that disturbed anything the AI keeps, not
     only what it did, would show here too. Event timestamps are left out. */
  /* Left out: clock times, and the purely cosmetic art choices the game makes
     with Math.random on purpose (grass and building tile variants; see the
     simulator README), which differ between any two runs of anything. */
  const CLOCK_OR_COSMETIC = new Set(['at', '_matchStartStamp', 'startedAt', 'wallMs', '_dispatchUntil', 'grassStyles', 'buildingStyles']);
  const snap = JSON.stringify(state, (k, v) => {
    if(typeof v === 'function') return undefined;
    if(v instanceof Set) return [...v];
    if(v instanceof Map) return [...v.entries()];
    if(CLOCK_OR_COSMETIC.has(k)) return undefined;
    return v;
  });
  const { createHash } = await import('node:crypto');
  const stateHash = createHash('sha256').update(snap).digest('hex').slice(0, 16);
  if(process.env.SPYGLASS_DUMP) fs.writeFileSync(process.env.SPYGLASS_DUMP + (traceOn ? '-on' : '-off') + '.json', snap);
  // Through a file: a whole match is too long for one write before exit.
  fs.writeFileSync(outFile, JSON.stringify({ events, winner: state.winner || null, turns: state.turnNumber, trace: t, stateHash, stateBytes: snap.length }));
  process.exit(0);
}

function run(seed, traceOn){
  const outFile = path.join(os.tmpdir(), `spyglass-check-${process.pid}-${traceOn ? 'on' : 'off'}.json`);
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [process.argv[1], '--child', String(seed), traceOn ? '1' : '0', outFile], { stdio: ['ignore', 'ignore', 'ignore'] });
    p.on('close', () => {
      try { resolve(JSON.parse(fs.readFileSync(outFile, 'utf8'))); fs.unlinkSync(outFile); }
      catch(e){ reject(new Error('no result from child: ' + e.message)); }
    });
  });
}

const args = process.argv.slice(2);
if(args[0] === '--child'){
  await child(Number(args[1]), args[2] === '1', args[3]);
} else {
  const seed = Number(args[0] || 7);
  const off = await run(seed, false);
  const on = await run(seed, true);
  let firstDiff = -1;
  const n = Math.max(off.events.length, on.events.length);
  for(let i = 0; i < n; i++) if(off.events[i] !== on.events[i]){ firstDiff = i; break; }
  console.log(`seed ${seed}: trace off ${off.events.length} events (${off.turns} turns, winner ${off.winner}); ` +
              `trace on ${on.events.length} events (${on.turns} turns, winner ${on.winner})`);
  console.log(`trace on captured: ${on.trace.turns} turns, ${on.trace.brigades} Brigade orders, ${on.trace.decisions} unit decisions, ${on.trace.candidates} candidate squares`);
  console.log(`final game state: off ${off.stateHash} (${off.stateBytes} bytes), on ${on.stateHash} (${on.stateBytes} bytes)`);
  if(firstDiff === -1 && off.stateHash === on.stateHash){ console.log('IDENTICAL: every move, shot, fight and roll, and the whole final game state, are the same with the trace on and off.'); process.exit(0); }
  if(firstDiff === -1){ console.log('MOVES IDENTICAL, but the final game state differs.'); process.exit(1); }
  console.log(`DIFFERENT at event ${firstDiff}:\n  off: ${off.events[firstDiff]}\n  on:  ${on.events[firstDiff]}`);
  process.exit(1);
}
