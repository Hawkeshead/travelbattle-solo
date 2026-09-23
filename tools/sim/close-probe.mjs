/* =========================================================
   CLOSE PROBE

   Why does a unit ordered to attack not close? For every unit that could have
   moved nearer its nearest enemy and did not, compare the square it chose with
   the BEST square that would have closed, and credit each term by how much it
   favoured staying. */
import { loadGame, collapseTimers } from '/home/claude/fc/tools/sim/headless-env.mjs';
const realSetInterval = globalThis.setInterval;
const g = await loadGame();
const render = await import('/home/claude/fc/js/render-board.js');
const menus  = await import('/home/claude/fc/js/ui-menus.js');
collapseTimers();
const { data, dice, rules } = g; const { state, SIDES } = data;
dice.setFastDiceMode(true); render.setFastAnimationMode(true);
state.scenario=null; state.campaign=null; state.mode='ai'; state.spectate=true;
state.aiDifficulty='hard'; state.aiSide=SIDES.RED; state.gameOver=false; state.winner=null;
const L=Number(process.argv[3]||1); const BP=Number(process.argv[4]||0); state.aiConfig={ red:{BRIGADIER_LEAD:L,BRIGADE_PLAN:BP}, blue:{BRIGADIER_LEAD:L,BRIGADE_PLAN:BP} };
rules.seedRng(Number(process.argv[2]||4));
const cheb=(a,b)=>Math.max(Math.abs(a.x-b.x),Math.abs(a.y-b.y));
const by={}, gap=[]; let held=0, closed=0, noOption=0;
globalThis.__fcScoreProbe = (u, scored) => {
  if(!scored.length || u.type==='BRIGADIER') return;
  const foes = state.units.filter(o=>!o.removed && o.side!==u.side && o.type!=='BRIGADIER');
  if(!foes.length) return;
  const d0 = Math.min(...foes.map(f=>cheb(u,f)));
  if(d0 <= 1 || d0 > 8) return;                       // already in contact, or far from the fighting
  const chosen = scored[0];
  const dOf = c => Math.min(...foes.map(f=>cheb(c,f)));
  const closer = scored.filter(c => dOf(c) < d0);
  if(!closer.length){ noOption++; return; }
  if(dOf(chosen) < d0){ closed++; return; }
  held++;
  const best = closer[0];                              // best-scoring closing square
  gap.push(chosen.total - best.total);
  for(const k of new Set([...Object.keys(chosen.parts), ...Object.keys(best.parts)])){
    const diff = (chosen.parts[k]||0) - (best.parts[k]||0);
    if(diff > 0) by[k] = (by[k]||0) + diff;
  }
};
menus.beginBoardSetup();
await new Promise(r=>{ const p=realSetInterval(()=>{ if(state.gameOver||state.turnNumber>200){clearInterval(p);r();} },20); });
console.log(`seed ${process.argv[2]} turn ${state.turnNumber} | closed ${closed}, held ${held}, no closing square ${noOption}`);
if(held){
  gap.sort((a,b)=>a-b);
  console.log(`  staying beat closing by: median ${gap[gap.length>>1].toFixed(2)}, worst ${gap[gap.length-1].toFixed(2)}`);
  console.log('  terms favouring the square it stayed on, mean per case:');
  for(const [k,v] of Object.entries(by).sort((a,b)=>b[1]-a[1]).slice(0,10))
    console.log(`    ${k.padEnd(22)} ${(v/held).toFixed(2)}`);
}
process.exit(0);
