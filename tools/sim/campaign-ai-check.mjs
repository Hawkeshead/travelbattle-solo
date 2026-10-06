/* =========================================================
   CAMPAIGN AI CHECK (campaign map, strategic AI)

   An automated comparison, not a playtest, and NOT how the game resolves
   anything: in the game every fight is played on the tactical board. Here
   battles are settled by a quick strength-weighted roll so whole 48-turn
   campaigns can be run in a moment, to compare the French strategic AI
   (campaign-map-ai.js) with the Phase 1 placeholder it replaces (core
   aiStep and aiRecruit, the control), against the same scripted British
   opponent on the same seeds.

   Two British scripts, because one AI can look good against a fool:
   - charger: every army marches on the nearest French army and always fights
     (the placeholder's own habits);
   - careful: attacks only with at least 1.2 times the value, otherwise goes
     for undefended French towns, and a battered army (below 30) goes home to
     Ostend to rebuild. Closer to how a person plays.
   Both top up at Ostend when standing there, stand and fight when attacked,
   and pursue with cavalry when they can.

   Reported per arm: campaigns won by France, enemy value destroyed by each
   side, French towns at the end, French gold at the end, and how many French
   attacks were made at bad odds (below 1:1).

   Usage: node tools/sim/campaign-ai-check.mjs [campaigns per arm, default 10]
========================================================= */
import fs from 'node:fs';
import * as cm from '../../js/campaign-map-core.js';
import * as ai from '../../js/campaign-map-ai.js';

const json = p => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), 'utf8'));
const MAP = json('../../data/campaign-maps/flanders.json');
const COMPS = json('../../data/army-compositions.json');
const ARCHIVE = json('../../data/unit-archive.json');

function rng(seed){ let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 1e9) / 1e9; }; }

/* The stand-in for a battle: the stronger side usually wins; the loser loses
   about 40% of its fighting units, the winner about 15%, weakest first. */
function autoBattle(c, rand, sides){
  const b = c.pendingBattle;
  const val = s => cm.battleBrigades(c, b, s).reduce((n, x) => n + cm.brigadeValue(MAP, x.brigade), 0);
  const a = val(b.attackerSide), d = val(cm.otherSideCM(b.attackerSide));
  const pa = (a * a) / (a * a + d * d);
  const winner = rand() < pa ? b.attackerSide : cm.otherSideCM(b.attackerSide);
  const lose = (s, frac) => {
    const units = cm.battleBrigades(c, b, s).flatMap(x => cm.fightingUnits(x.brigade));
    const n = Math.round(units.length * frac * (0.7 + rand() * 0.6));
    return units.sort((p, q) => cm.valueOf(MAP, p) - cm.valueOf(MAP, q)).slice(0, n).map(u => u.id);
  };
  const lost = [...lose(winner, 0.15), ...lose(cm.otherSideCM(winner), 0.4)];
  sides.badAttacks += (b.attackerSide === 'french' && a < d) ? 1 : 0;
  return { winner, lost };
}
function autoRearguard(c, rand){
  const b = c.pendingBattle;
  const rg = cm.battleBrigades(c, b, b.withdrawal.side)[0];
  const holds = rand() < (b.pursuit.onFoot ? 0.85 : 0.65);
  const units = rg ? cm.fightingUnits(rg.brigade) : [];
  const lost = holds ? units.slice(0, Math.min(1, units.length)).map(u => u.id) : units.map(u => u.id);
  return { winner: holds ? b.withdrawal.side : b.attackerSide, lost };
}
/* Settles whatever engagement is pending, the British script deciding its own choices. */
function settle(c, rand, stats){
  for(let g = 0; g < 6 && c.pendingBattle; g++){
    cm.resolveAiChoices(c, MAP);
    const b = c.pendingBattle;
    if(!b) return;
    if(b.stage === 'decide'){ cm.chooseFight(c, MAP); continue; }   // the script always stands
    if(b.stage === 'pursuit'){
      const ch = cm.pursuitChoices(c, MAP);
      if(!ch.onFoot && ch.brigades.length) cm.choosePursue(c, MAP, ch.brigades[0].id); else cm.chooseLetGo(c, MAP);
      continue;
    }
    if(b.stage === 'battle') cm.applyBattleResult(c, MAP, autoBattle(c, rand, stats));
    else if(b.stage === 'rearguard') cm.applyRearguardResult(c, MAP, autoRearguard(c, rand));
  }
}

function britishTurn(c, rand, stats, careful){
  for(const a of cm.armiesOf(c, 'british')){
    if(c.result) return;
    const d = cm.homeDepot(MAP, 'british');
    if(a.townId === d.id){
      for(const br of a.brigades){
        while(cm.fightingUnits(br).length < 5 && c.gold.british >= 8){ try { cm.recruitUnit(c, MAP, ARCHIVE, a.id, br.id, 'INFANTRY'); } catch { break; } }
      }
    }
    if(!cm.armiesOf(c, 'british').includes(a) || cm.validMoves(c, MAP, a).length === 0) continue;
    let step = null;
    if(!careful){
      let best = null;
      for(const t of cm.armiesOf(c, 'french')){ const p = cm.shortestPath(MAP, a.townId, t.townId); if(p && (!best || p.length < best.length)) best = p; }
      step = best && best.length > 1 ? best[1] : null;
    } else {
      const mine = cm.armyStrength(MAP, a);
      const fr = id => cm.armiesAt(c, id, 'french').reduce((n, x) => n + cm.armyStrength(MAP, x), 0);
      const moves = cm.validMoves(c, MAP, a);
      const goodFight = moves.find(id => fr(id) > 0 && mine >= fr(id) * 1.2);
      if(goodFight) step = goodFight;
      else if(mine < 30){ const p = cm.shortestPath(MAP, a.townId, 'ostend'); step = p && p.length > 1 ? p[1] : null; }
      else {
        const safe = moves.filter(id => fr(id) === 0);
        const grab = safe.find(id => c.towns[id].owner === 'french');
        if(grab) step = grab;
        else {
          // Head for the nearest French-held town, by roads not through a French army.
          let best = null;
          for(const t of MAP.towns.filter(t => c.towns[t.id].owner === 'french' && fr(t.id) === 0)){ const p = cm.shortestPath(MAP, a.townId, t.id); if(p && (!best || p.length < best.length)) best = p; }
          step = best && best.length > 1 && fr(best[1]) === 0 ? best[1] : null;
        }
      }
    }
    if(step){ cm.moveArmy(c, MAP, a.id, step); settle(c, rand, stats); }
  }
}

function frenchTurn(c, rand, stats, strategic){
  if(strategic) ai.strategicAiRecruit(c, MAP, ARCHIVE); else cm.aiRecruit(c, MAP, ARCHIVE);
  for(let g = 0; g < 10 && !c.result && c.phase === 'french'; g++){
    const r = strategic ? ai.strategicAiStep(c, MAP) : cm.aiStep(c, MAP);
    if(r.kind === 'battle') settle(c, rand, stats);
    if(r.kind === 'done') break;
  }
}

function runCampaign(seed, strategic, careful){
  const rand = rng(seed * 7919 + 1);
  const c = cm.createCampaign(MAP, COMPS, ARCHIVE, { id: 'sim-' + seed, now: 'sim' });
  const stats = { badAttacks: 0 };
  while(!c.result){
    britishTurn(c, rand, stats, careful);
    if(c.result) break;
    cm.endPlayerPhase(c, MAP);
    frenchTurn(c, rand, stats, strategic);
    if(c.result) break;
    cm.endAiPhase(c, MAP);
  }
  return { seed, winner: c.result.winner, turn: c.result.turn, valueByFrance: c.destroyedValue.french, valueByBritain: c.destroyedValue.british,
    frenchTowns: cm.townsHeldBy(c, 'french').length, frenchGold: c.gold.french, frenchArmies: cm.armiesOf(c, 'french').length, badAttacks: stats.badAttacks, frenchLost: c.unitsLost.french, britishLost: c.unitsLost.british };
}

const n = Number(process.argv[2] || 10);
for(const [label, strategic, careful] of [['placeholder (control) vs charger', false, false], ['strategic AI vs charger', true, false], ['placeholder (control) vs careful', false, true], ['strategic AI vs careful', true, true]]){
  const rs = Array.from({ length: n }, (_, i) => runCampaign(i + 1, strategic, careful));
  const sum = k => rs.reduce((a, r) => a + r[k], 0);
  const wins = s => rs.filter(r => r.winner === s).length;
  console.log(`\n${label}: ${n} campaigns`);
  console.log(`  France won ${wins('french')}, Britain won ${wins('british')}, drawn ${wins('draw')}; mean end turn ${(sum('turn') / n).toFixed(1)}`);
  console.log(`  enemy value destroyed, mean: by France ${(sum('valueByFrance') / n).toFixed(1)}, by Britain ${(sum('valueByBritain') / n).toFixed(1)}`);
  console.log(`  at the end, mean: French towns ${(sum('frenchTowns') / n).toFixed(1)}, French gold ${(sum('frenchGold') / n).toFixed(1)}, French armies ${(sum('frenchArmies') / n).toFixed(1)}`);
  console.log(`  French attacks at worse than even odds: ${sum('badAttacks')}; French units lost, mean ${(sum('frenchLost') / n).toFixed(1)}; British units lost, mean ${(sum('britishLost') / n).toFixed(1)}`);
  console.log('  per seed: ' + rs.map(r => `${r.seed}:${r.winner[0]}${r.turn}`).join(' '));
}
