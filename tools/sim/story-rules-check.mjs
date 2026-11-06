/* =========================================================
   STORY RULES CHECK (6 Nov 2026)

   The Peninsula special rules that can be checked on a staged position,
   checked headless on the real game modules: each case sets a battle up as
   the game does (setupOperation), puts units where the rule matters, and
   asserts what the rule says. The dice-driven rules (dieHard, deadHorse,
   marksman, followUp) are checked by playing the battles in the simulator
   and counting the RULE lines in their exports (see the commit message).

   One battle per process, as run.mjs does (the game state is a singleton).
   Usage:  node tools/sim/story-rules-check.mjs          (runs every case)
           node tools/sim/story-rules-check.mjs <case>
========================================================= */
import { loadGame, collapseTimers } from './headless-env.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CASES = {
  rain: 'peninsula-sabugal-britain',
  rainEarly: 'peninsula-arroyo-britain',
  noEntry: 'peninsula-arroyo-britain',
  roadOnly: 'peninsula-somosierra-spain',
  squareMarch: 'peninsula-elbodon-britain',
  baggage: 'peninsula-vitoria-britain',
  embark: 'peninsula-corunna-britain',
  battery: 'peninsula-corunna-britain',
};

async function runCase(name){
  const g = await loadGame();
  const render = await import('../../js/render-board.js');
  const ops = await import('../../js/operations.js');
  collapseTimers();
  const { data, rules } = g;
  const { state } = data;
  render.setFastAnimationMode(true);
  rules.seedRng(1);
  ops.setupOperation(CASES[name], null);
  state.phase = 'move'; state.moved = new Set();
  const at = round => { state.turnNumber = round * 2 - 1; };
  const sideUnits = (side, type) => state.units.filter(u => !u.removed && u.side === side && u.x >= 0 && (!type || u.type === type));
  const free = (x, y) => !state.units.some(o => !o.removed && o.x === x && o.y === y);
  const check = (ok, what) => { if(!ok) throw new Error(what); };

  if(name === 'rain'){
    at(5); check(!rules.rainNow(), 'Sabugal: no rain in round 5');
    at(6); check(rules.rainNow(), 'Sabugal: rain from round 6');
    at(8); check(rules.rainNow(), 'Sabugal: still raining in round 8');
  } else if(name === 'rainEarly'){
    at(3); check(rules.rainNow(), 'Arroyo: rain in round 3');
    at(4); check(!rules.rainNow(), 'Arroyo: dry from round 4');
  } else if(name === 'noEntry'){
    // a French hussar and a French infantry unit on row 2, the Sierra (rows 0 and 1) above them
    at(2); state.turn = 'blue';
    const cav = sideUnits('blue', 'LIGHT_CAV')[0], inf = sideUnits('blue', 'INFANTRY')[0];
    for(const u of state.units) if(!u.removed && u !== cav && u !== inf && u.y <= 3) u.x = -1;   // clear the way
    cav.x = 3; cav.y = 2; inf.x = 15; inf.y = 2;
    state.units.forEach(u => { if(u.side === 'blue' && u.type === 'BRIGADIER' && u.brigadeId === cav.brigadeId){ u.x = 4; u.y = 3; } if(u.side === 'blue' && u.type === 'BRIGADIER' && u.brigadeId === inf.brigadeId){ u.x = 16; u.y = 3; } });
    const cm = rules.legalMoves(cav), im = rules.legalMoves(inf);
    check(cm.length > 0, 'Arroyo: the hussars can still move');
    check(!cm.some(c => c.y <= 1), 'Arroyo: cavalry may not enter the Sierra');
    check(im.some(c => c.y <= 1), 'Arroyo: infantry may climb the Sierra');
  } else if(name === 'roadOnly'){
    at(2); state.turn = 'red';
    for(const cav of sideUnits('red').filter(u => u.type === 'LIGHT_CAV')){
      const moves = rules.legalMoves(cav);
      check(moves.every(c => rules.isRoadLike(rules.terrainAt(c.x, c.y))), `Somosierra: ${cav.historicalName} moves off the road`);
    }
    const inf = state.units.find(u => !u.removed && u.side === 'blue' && u.type === 'INFANTRY');
    check(inf, 'Somosierra: a Spanish infantry unit to compare');
  } else if(name === 'squareMarch'){
    at(2); state.turn = 'red';
    const inf = sideUnits('red', 'INFANTRY')[0];
    inf.formation = 'square';
    const moves = rules.legalMoves(inf);
    check(moves.length > 0, 'El Bodon: a square may move');
    check(moves.every(c => Math.max(Math.abs(c.x - inf.x), Math.abs(c.y - inf.y)) === 1), 'El Bodon: a square moves one square only');
    check(inf.formation === 'square', 'El Bodon: it stays in square');
  } else if(name === 'baggage'){
    const bag = state.scenario.map.areas.baggage;
    check(bag && bag.length, 'Vitoria: the baggage area exists');
    const inBag = (x, y) => bag.some(([ax, ay]) => ax === x && ay === y);
    // a free baggage square with a non-baggage square just below it (the French
    // line stands there at the start: move whoever is on it off the board)
    const [bx, by] = bag.find(([x, y]) => free(x, y) && !inBag(x, y + 1));
    for(const o of state.units) if(!o.removed && o.x === bx && o.y === by + 1) o.x = -1;
    // a French unit next to the baggage may not stop on it
    at(2); state.turn = 'blue';
    const fr = sideUnits('blue', 'INFANTRY')[0];
    fr.x = bx; fr.y = by + 1;
    state.units.forEach(u => { if(u.side === 'blue' && u.type === 'BRIGADIER' && u.brigadeId === fr.brigadeId){ u.x = fr.x + (fr.x < 19 ? 1 : -1); u.y = fr.y; } });
    check(!rules.legalMoves(fr).some(c => bag.some(([x, y]) => x === c.x && y === c.y)), 'Vitoria: a French unit stops on the baggage');
    // an Allied unit that marches onto it loses its next turn
    state.turn = 'red'; state.turnNumber = 4;
    const al = sideUnits('red', 'INFANTRY')[0];
    al.x = bx; al.y = by + 1;
    render.animateUnitTo(al, bx, by, 'march');
    check(al._baggageTurn === 4, 'Vitoria: the Allied unit is marked as stopped');
    state.turnNumber = 6; state.moved = new Set();
    check(rules.legalMoves(al).length === 0, 'Vitoria: it cannot move on its next turn');
    state.turnNumber = 8; state.moved = new Set();
    const brig = state.units.find(u => u.side === 'red' && u.type === 'BRIGADIER' && u.brigadeId === al.brigadeId);
    brig.x = bx + (bx < 19 ? 1 : -1); brig.y = by;
    check(rules.legalMoves(al).length > 0, 'Vitoria: it may move again the turn after');
  } else if(name === 'embark'){
    state.turn = 'red';
    const u = sideUnits('red', 'INFANTRY')[0];
    u.y = state.terrain.length - 1;
    state.units.forEach(o => { if(o.side === 'red' && o.type === 'BRIGADIER' && o.brigadeId === u.brigadeId){ o.x = u.x + (u.x < 19 ? 1 : -1); o.y = u.y; } });
    at(6); state.turn = 'red';
    check(!ops.canMarchOff(u), 'Corunna: no embarking before round 7');
    at(7); state.turnNumber = 14; state.turn = 'red';
    check(ops.canMarchOff(u), 'Corunna: embarking from round 7');
  } else if(name === 'battery'){
    const guns = state.units.filter(u => u.side === 'blue' && u.type === 'ARTILLERY' && u.brigadeId === 3);
    check(guns.length === 2 && guns.every(gn => rules.terrainAt(gn.x, gn.y).key === 'HILL'), 'Corunna: the great battery stands on the ridge');
  }
  return 'ok';
}

if (process.argv[2]) {
  try { console.log(await runCase(process.argv[2])); process.exit(0); }
  catch(e){ console.log('FAIL: ' + e.message); process.exit(1); }
} else {
  let bad = 0;
  for (const name of Object.keys(CASES)) {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), name], { encoding: 'utf8' });
    const out = (r.stdout || '').trim().split('\n').pop();
    console.log(`${name.padEnd(12)} ${out}`);
    if (r.status !== 0) bad++;
  }
  process.exit(bad ? 1 : 0);
}
