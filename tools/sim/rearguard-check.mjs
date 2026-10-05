/* =========================================================
   REARGUARD CHECK (campaign map, Phase 2)

   An automated check, not a playtest: it sets up campaign map rearguard
   actions exactly as the map does (campaign-map-core + campaign-map-battle),
   lets the battle AI play both sides headless to the end, and writes the
   result back into the campaign. It confirms that
   - the on-the-spot Operation card resolves: the rearguard wins when the
     rounds run out, the pursuit wins by breaking the rearguard brigade;
   - each side starts on the edge it should (the rearguard toward its retreat
     town, which can put Britain at the top);
   - a pursuit on foot really attacks at one die fewer;
   - the result is written back permanently.

   One match per process, as run.mjs does (the game state is a singleton).
   Usage:  node tools/sim/rearguard-check.mjs            (runs every case)
           node tools/sim/rearguard-check.mjs <case> <seed>
========================================================= */
import { loadGame, collapseTimers } from './headless-env.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CASES = {
  /* France withdraws from Menin toward Lincelles (south of Menin on the map,
     so the French rearguard stands at the bottom and Britain at the top) and
     British cavalry pursues. */
  'british-cavalry-pursuit': { attacker: 'british', from: 'ypres', at: 'menin', to: 'lincelles', foot: false },
  /* Britain withdraws from Menin to Ypres (north of Menin) and France pursues
     on foot: the British rearguard at the TOP, France at the bottom. */
  'french-foot-pursuit': { attacker: 'french', from: 'lincelles', at: 'menin', to: 'ypres', foot: true },
  /* The pursuit's win path, forced: once the battle is under way every
     fighting unit of the rearguard is removed, and the objective engine must
     give the pursuer the win and the campaign must lose the whole brigade. */
  'forced-break': { attacker: 'british', from: 'ypres', at: 'menin', to: 'lincelles', foot: false, forceBreak: true },
};

async function runCase(name, seed){
  const spec = CASES[name];
  const g = await loadGame();
  const render = await import('../../js/render-board.js');
  const cm = await import('../../js/campaign-map-core.js');
  const cmb = await import('../../js/campaign-map-battle.js');
  collapseTimers();
  const { data, dice, rules, ui } = g;
  const { state, TB_DATA } = data;
  dice.setFastDiceMode(true);
  render.setFastAnimationMode(true);
  rules.seedRng(seed);
  const map = TB_DATA.campaignMaps.flanders;
  const c = cm.createCampaign(map, TB_DATA.armyCompositions, TB_DATA.unitArchive, { id: 'check-' + name });
  const att = cm.armiesOf(c, spec.attacker)[0], def = cm.armiesOf(c, cm.otherSideCM(spec.attacker))[0];
  att.townId = spec.from; def.townId = spec.at;
  if(spec.foot) for(const b of att.brigades) b.units = b.units.filter(u => u.type !== 'LIGHT_CAV' && u.type !== 'HEAVY_CAV');
  c.phase = spec.attacker;
  cm.moveArmy(c, map, att.id, spec.at);
  cm.chooseWithdraw(c, map, spec.to);
  const choice = cm.pursuitChoices(c, map);
  cm.choosePursue(c, map, choice.brigades[0].id);
  const b = c.pendingBattle;

  cmb.setupMapBattle(c, map);
  const rows = side => [...new Set(state.units.filter(u => u.side === side).map(u => u.y))].sort();
  const startRows = { red: rows('red'), blue: rows('blue') };
  // Pursuit on foot: an attack that would roll two dice rolls one.
  let footCheck = null;
  if(spec.foot){
    const pu = state.units.find(u => u.side === state.mapBattle.pursuit.side && (u.type === 'INFANTRY' || u.type === 'GUARD'));
    const gun = { id: 'probe', side: pu.side === 'red' ? 'blue' : 'red', type: 'ARTILLERY', x: 5, y: 5, formation: 'line', removed: false };
    const withPenalty = rules.combatBonuses(pu, gun, false).dice;
    const saved = state.mapBattle.pursuit.dicePenalty; state.mapBattle.pursuit.dicePenalty = 0;
    const without = rules.combatBonuses(pu, gun, false).dice;
    state.mapBattle.pursuit.dicePenalty = saved;
    const defendingDice = rules.combatBonuses(pu, gun, true).dice;
    footCheck = { attackingGunDiceWithout: without, attackingGunDiceWith: withPenalty, defendingUnaffected: defendingDice };
  }
  state.spectate = true;
  ui.startBattle();
  if(spec.forceBreak){
    const rg = state.units.filter(u => u.side !== state.mapBattle.pursuit.side && u.type !== 'BRIGADIER');
    for(const u of rg) u.removed = true;
    rules.checkWinCondition();
  }
  const t0 = Date.now();
  await new Promise(res => { const p = setInterval(() => { if(state.gameOver || state.turnNumber > 60 || Date.now() - t0 > 60000){ clearInterval(p); res(); } }, 5); });
  const outcome = cmb.readBattleOutcome(state.winner);
  const summary = state.gameOver ? cm.applyRearguardResult(c, map, outcome) : null;
  return {
    case: name, seed, finished: state.gameOver, winner: outcome.winner, reason: state.scenarioResult && state.scenarioResult.reason,
    rounds: Math.ceil(state.turnNumber / 2), rearguardSide: b.withdrawal.side, homeRow: state.mapBattle.homeRow, startRows,
    pursuit: b.pursuit, footCheck,
    lost: summary && { british: summary.lostUnits.british.length, french: summary.lostUnits.french.length, broken: summary.brokenBrigades },
    pendingAfter: c.pendingBattle, log: c.log[c.log.length - 1].text,
  };
}

if(process.argv[2] && CASES[process.argv[2]]){
  const r = await runCase(process.argv[2], Number(process.argv[3] || 1));
  console.log('\u0001RESULT' + JSON.stringify(r));
  process.exit(0);
} else {
  const self = fileURLToPath(import.meta.url);
  for(const name of Object.keys(CASES)) for(const seed of (CASES[name].forceBreak ? [1] : [1, 2])){
    const out = spawnSync(process.execPath, [self, name, String(seed)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const line = (out.stdout || '').split('\n').find(l => l.startsWith('\u0001RESULT'));
    console.log(line ? JSON.stringify(JSON.parse(line.slice(7)), null, 1) : `${name} ${seed}: crashed\n${(out.stderr || '').slice(-2000)}`);
  }
}
