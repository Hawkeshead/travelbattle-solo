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
import { loadGame, collapseTimers } from './headless-env.mjs';

const KINDS = new Set(['move', 'fire', 'fight', 'formation', 'ambush', 'status', 'rally', 'leadership', 'turnStart']);
const TURN_CAP = 400, TIMEOUT_MS = 60_000;

async function child(seed, traceOn){
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
  process.stdout.write('\u0001RESULT' + JSON.stringify({ events, winner: state.winner || null, turns: state.turnNumber, trace: t }) + '\n');
  process.exit(0);
}

function run(seed, traceOn){
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [process.argv[1], '--child', String(seed), traceOn ? '1' : '0'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.on('close', () => {
      const line = out.split('\n').find(l => l.startsWith('\u0001RESULT'));
      if(!line) return reject(new Error('no result from child'));
      resolve(JSON.parse(line.slice(7)));
    });
  });
}

const args = process.argv.slice(2);
if(args[0] === '--child'){
  await child(Number(args[1]), args[2] === '1');
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
  if(firstDiff === -1){ console.log('IDENTICAL: every move, shot, fight and roll is the same with the trace on and off.'); process.exit(0); }
  console.log(`DIFFERENT at event ${firstDiff}:\n  off: ${off.events[firstDiff]}\n  on:  ${on.events[firstDiff]}`);
  process.exit(1);
}
