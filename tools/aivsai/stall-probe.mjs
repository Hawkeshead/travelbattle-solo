/* =========================================================
   STALL PROBE

   Runs one seed, samples the board four times as it plays, and then dumps the
   AI's own decision record for both sides: plan, missions, and for every unit
   the action chosen, how many options it considered and the best few
   alternatives with their scores.

   Built for the matches that never end. The aggregate runner says a match
   stalled; this says what the units were choosing while it did, and in
   particular tells apart a unit that CHOSE to hold from one that had no option
   but to hold. That distinction is the whole diagnosis: the first is a weighting
   problem, the second is not.

   Usage:  node tools/aivsai/stall-probe.mjs <seed>

   Seeds reproduce exactly, so a seed the runner reports as a timeout can be
   handed straight to this.
========================================================= */
/* Runs one seed and dumps the AI's own decision record once the match is clearly
   going nowhere. Diagnostic only. */
import { loadGame, collapseTimers } from './headless-env.mjs';
const realSetTimeout = globalThis.setTimeout;
const g = await loadGame();
const render = await import('../../js/render-board.js');
const menus  = await import('../../js/ui-menus.js');
const ai     = await import('../../js/ai-strategy.js');
const er     = await import('../../js/engine-rules.js');
collapseTimers();
const { data, dice, rules } = g; const { state, SIDES } = data;
dice.setFastDiceMode(true); render.setFastAnimationMode(true);
state.scenario=null; state.campaign=null; state.mode='ai'; state.spectate=true;
state.aiDifficulty='hard'; state.aiSide=SIDES.RED; state.gameOver=false; state.winner=null;
rules.seedRng(Number(process.argv[2]||6));
menus.beginBoardSetup();
for(let k=0;k<4;k++){
  await new Promise(r=>realSetTimeout(r, 4000));
  const f = state.units.filter(u=>!u.removed).map(u=>`${(u.historicalName||u.type).slice(0,14)}@${u.x},${u.y}${u.formation==='line'?'':'/'+u.formation}${u.rallying?'/RALLY':''}${u.turnOnly?'/TURN':''}`);
  console.log(`t=${state.turnNumber} ` + f.join(' '));
  if(k===3){
    for(const u of state.units.filter(x=>!x.removed)){
      let lm='err';
      try { lm = (er.legalMoves(u)||[]).length; } catch(e){ lm='throw:'+e.message.slice(0,40); }
      console.log(`   ${(u.historicalName||u.type).padEnd(30)} ${u.side} @${u.x},${u.y} ${u.formation} rally=${!!u.rallying} turnOnly=${!!u.turnOnly} legalMoves=${lm}`);
    }
  }
}
console.log('turn', state.turnNumber, 'phase', state.phase, 'gameOver', state.gameOver);
console.log('TEMPO_COMMIT_TURN', ai.TEMPO_COMMIT_TURN, 'TEMPO_PULL', JSON.stringify(ai.TEMPO_PULL));
const live = s2 => state.units.filter(u=>!u.removed && u.side===s2);
for(const s2 of ['red','blue']){
  console.log(s2.toUpperCase(), live(s2).map(u=>`${u.historicalName||u.type}@${u.x},${u.y} ${u.formation}${u.turnOnly?' TURNONLY':''}${u.pushed?' PUSHED':''}${u.noActionThisTurn?' NOACTION':''}${u.rallying?' RALLYING':''}`).join(' | '));
}
for(const side of ['red','blue']){
  const d = state._aiDebugLog && state._aiDebugLog[side];
  console.log(`\n===== ${side} (recorded turn ${d && d.turn}) =====`);
  if(!d){ console.log('  no debug record'); continue; }
  console.log('  plan     :', JSON.stringify(d.plan));
  console.log('  missions :', JSON.stringify(d.missions));
  console.log('  moveLog  :', (d.moveLog||[]).length, 'entries');
  for(const m of (d.moveLog||[])){
    const dec = m.decision||{};
    const alts = dec.alternatives||[];
    console.log(`    ${String(m.unit).padEnd(32)} ${String(m.mission).padEnd(12)} ${String(m.action).padEnd(8)} score ${m.score}  alts=${alts.length} considered=${dec.considered===undefined?'-':dec.considered}`);
    for(const a of alts.slice(0,3)) console.log(`        alt (${a.x},${a.y}) total ${Number(a.total).toFixed(2)}`);
  }
}
process.exit(0);
