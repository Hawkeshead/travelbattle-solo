/* =========================================================
   BRIGADIER PROBE

   The stall probe says the Brigadiers hold while their own units sit on zero
   legal moves. The term breakdown says freeStrandedUnit reads an identical
   -1.80 on the square held and on every rival square, in three different
   Brigadiers at once, which would mean the term that is supposed to pull him
   toward a frozen unit has no gradient at all and cannot decide anything.

   The code says it should have a gradient: chebyshev(candidate, target) times a
   pull. So either the reading or the reading of the code is wrong, and guessing
   which has already cost two wrong answers.

   This settles it by walking every square the Brigadier could legally move to
   and printing, per square, the recovery target he would be chasing FROM that
   square and the term value that follows. The important subtlety it is built to
   expose: the scorer teleports the unit to the candidate before scoring, and
   whether a mate counts as stranded depends on where the Brigadier is, so the
   target itself can change from square to square.

   Usage:  node tools/sim/brigadier-probe.mjs [seed] [ms]
========================================================= */
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
rules.seedRng(Number(process.argv[2]||1));
menus.beginBoardSetup();
await new Promise(r=>realSetTimeout(r, Number(process.argv[3]||12000)));

const name = u => (u.historicalName||u.type).slice(0,22);
console.log(`\n=== turn ${state.turnNumber} ===`);

for(const brig of state.units.filter(u=>!u.removed && u.type==='BRIGADIER')){
  const mates = state.units.filter(o=>!o.removed && o.side===brig.side &&
    o.brigadeId===brig.brigadeId && o.id!==brig.id);
  const conn = er.movableUnitsForSide(brig.side);
  console.log(`\n${name(brig)} (${brig.side} b${brig.brigadeId}) @${brig.x},${brig.y}`);
  for(const m of mates){
    console.log(`   mate ${name(m).padEnd(24)} @${m.x},${m.y}  connected=${conn.has(m.id)}  ` +
                `legalMoves=${(er.legalMoves(m)||[]).length}  strandedSince=${m._strandedSince ?? '-'}`);
  }

  /* Walk the candidates the way the scorer does: move him there, ask the
     question, put him back. Anything read without the move is read at the
     wrong position, which is the whole point of the probe. */
  const cands = er.legalMoves(brig) || [];
  const ox = brig.x, oy = brig.y;
  const rows = [];
  for(const c of [{x:ox,y:oy,hold:true}, ...cands]){
    brig.x = c.x; brig.y = c.y;
    let tgt = null, freed = 0;
    try {
      tgt = ai.brigadierRecoveryTarget(brig);
      const nowConn = er.movableUnitsForSide(brig.side);
      freed = mates.filter(m => nowConn.has(m.id)).length;
    } catch(e){ tgt = 'throw:'+e.message.slice(0,30); }
    const d = (tgt && tgt.x!=null) ? Math.max(Math.abs(c.x-tgt.x), Math.abs(c.y-tgt.y)) : null;
    rows.push({ sq:`${c.x},${c.y}${c.hold?' (hold)':''}`,
                target: tgt && tgt.x!=null ? name(tgt) : String(tgt),
                dist: d, freed });
  }
  brig.x = ox; brig.y = oy;

  console.log(`   ${'square'.padEnd(14)} ${'recovery target'.padEnd(24)} dist  mates connected`);
  for(const r of rows){
    console.log(`   ${r.sq.padEnd(14)} ${String(r.target).padEnd(24)} ${String(r.dist ?? '-').padStart(4)}  ${r.freed}`);
  }
}
process.exit(0);
