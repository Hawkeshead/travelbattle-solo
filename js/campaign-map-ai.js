/* =========================================================
   CAMPAIGN MAP: THE FRENCH STRATEGIC AI (pure)

   Replaces the Phase 1 placeholder (march at the nearest British army,
   always), which stays in campaign-map-core.js as aiStep: the control this
   AI is measured against (tools/sim/campaign-ai-check.mjs).

   Kept deliberately simple, at the level of the campaign itself: a handful
   of plain judgements a player can read off the map, scored per army and
   per destination (stay, or each road out of its town):
   - FIGHT ONLY WITH THE ODDS. March on a British army only with at least
     ATTACK_RATIO times its unit value; never into one it cannot beat.
   - DO NOT WALK INTO A BEATING. A town next to British armies stronger than
     this army (by DANGER_RATIO) is marked down, by how much stronger.
   - TAKE TOWNS. An undefended British town is worth its income.
   - GO TO WHERE IT MATTERS. A healthy army closes on the nearest British
     army it could take on; a weak one (below WEAK_VALUE) falls back on Lille
     to be topped up and to join another army.
   - KEEP LILLE. When a British army comes within reach of Lille, the army
     nearest it is pulled home.
   - JOIN UP. Two French armies in one town merge if they fit.
   Spending: top up brigades standing at Lille first, then raise a brigade,
   but never past the point where the treasury would start losing money each
   turn (the placeholder spent everything on turn 1 and went broke). A small
   new army marches to join a bigger one rather than wandering alone.
========================================================= */
import * as cm from './campaign-map-core.js';

export const AI_TUNING = {
  ATTACK_RATIO: 1.1,    // attack only with this much more unit value
  DANGER_RATIO: 1.3,    // a neighbouring British force this much stronger is a threat
  APPROACH: 4,          // pull per road toward a British army it could take on
  WEAK_VALUE: 30,       // below this the army goes home to rebuild
  LILLE_ALERT: 2,       // a British army this many roads from Lille brings a defender home
};

const dist = (map, a, b) => { const p = cm.shortestPath(map, a, b); return p ? p.length - 1 : 99; };
const strengthAt = (c, map, townId, side) => cm.armiesAt(c, townId, side).reduce((n, a) => n + cm.armyStrength(map, a), 0);

/* The British strength that could strike `townId` next turn: armies in it or
   one road away. */
function threatTo(c, map, townId, enemy){
  const t = cm.townById(map, townId);
  return [townId, ...t.links].reduce((n, id) => n + strengthAt(c, map, id, enemy), 0);
}

/* Which French army, if any, is detailed to hold Lille this turn. */
function lilleDefender(c, map, side){
  const depot = cm.homeDepot(map, side);
  if(!depot) return null;
  const enemy = cm.otherSideCM(side);
  const near = cm.armiesOf(c, enemy).some(e => dist(map, e.townId, depot.id) <= AI_TUNING.LILLE_ALERT);
  if(!near) return null;
  return cm.armiesOf(c, side).reduce((best, a) => (!best || dist(map, a.townId, depot.id) < dist(map, best.townId, depot.id) ? a : best), null);
}

/* Scores one destination for one army. Exported for the tests and the log. */
export function scoreDestination(c, map, army, dest, ctx){
  const side = army.side, enemy = cm.otherSideCM(side);
  const mine = cm.armyStrength(map, army);
  const depot = cm.homeDepot(map, side);
  const enemyHere = strengthAt(c, map, dest, enemy);
  const parts = {};
  if(enemyHere > 0){
    const ratio = mine / enemyHere;
    if(ratio < AI_TUNING.ATTACK_RATIO) return { score: -1000, parts: { refuse: ratio } };
    parts.attack = 60 + 10 * ratio;
  } else {
    const town = cm.townById(map, dest);
    if(c.towns[dest] && c.towns[dest].owner === enemy) parts.capture = (town.income || 0) * 8;
    // Threat from British armies adjacent to the destination (the ones that
    // could attack it next turn). An army it could itself beat is no threat.
    const threat = threatTo(c, map, dest, enemy);
    if(threat > mine * AI_TUNING.DANGER_RATIO) parts.danger = -15 * (threat / Math.max(1, mine));
    const weak = mine < AI_TUNING.WEAK_VALUE;
    if(ctx.defender === army.id && depot) parts.holdLille = -6 * dist(map, dest, depot.id);
    else if(weak && depot){
      // Rebuild: join the nearest French army with room for it, else go home.
      const friends = cm.armiesOf(c, side).filter(a => a.id !== army.id && a.brigades.length + army.brigades.length <= (c.maxBrigades || 3));
      const target = friends.length ? friends.reduce((x, y) => (dist(map, army.townId, y.townId) < dist(map, army.townId, x.townId) ? y : x)).townId : depot.id;
      parts.rebuild = -5 * dist(map, dest, target);
    }
    else {
      // Close on the nearest British army this one could take on.
      const targets = cm.armiesOf(c, enemy).filter(e => mine >= cm.armyStrength(map, e) * 0.8);
      if(targets.length) parts.approach = -AI_TUNING.APPROACH * Math.min(...targets.map(e => dist(map, dest, e.townId)));
    }
    const friend = cm.armiesAt(c, dest, side).find(a => a.id !== army.id && a.brigades.length + army.brigades.length <= (c.maxBrigades || 3));
    if(friend) parts.join = 8;
  }
  if(dest === army.townId) parts.stay = 0.5;   // ties go to standing still, not wandering
  return { score: Object.values(parts).reduce((a, b) => a + b, 0), parts };
}

/* Moves the next French army (strongest first) and returns what happened,
   like core aiStep: { kind: 'moved' | 'battle' | 'held' | 'done', army }. */
export function strategicAiStep(c, map){
  if(c.phase !== c.aiSide || c.pendingBattle || c.result) return { kind: 'done' };
  const side = c.aiSide;
  mergeWherePossible(c, map, side);
  const army = cm.armiesOf(c, side).filter(a => !a.hasMoved).sort((a, b) => cm.armyStrength(map, b) - cm.armyStrength(map, a))[0];
  if(!army) return { kind: 'done' };
  if(cm.isResting(c, army)){
    army.hasMoved = true;
    cm.logEntry(c, map, side, 'rest', `${army.name} rests at ${cm.townName(map, army.townId)} after its withdrawal and cannot march.`, { armyId: army.id });
    return { kind: 'held', army };
  }
  const ctx = { defender: (lilleDefender(c, map, side) || {}).id };
  const options = [army.townId, ...cm.validMoves(c, map, army)];
  let best = null;
  for(const dest of options){
    const s = scoreDestination(c, map, army, dest, ctx);
    if(!best || s.score > best.score) best = Object.assign({ dest }, s);
  }
  if(!best || best.dest === army.townId){
    army.hasMoved = true;
    cm.logEntry(c, map, side, 'hold', `${army.name} holds at ${cm.townName(map, army.townId)}.`, { armyId: army.id, parts: best && best.parts });
    return { kind: 'held', army };
  }
  const r = cm.moveArmy(c, map, army.id, best.dest);
  if(r.kind === 'moved') mergeWherePossible(c, map, side);
  return Object.assign(r, { army });
}

/* Two French armies in one town become one, if the brigades fit. The merged
   army has moved if either had (core mergeArmies). AI side only: the
   player merges by hand. */
function mergeWherePossible(c, map, side){
  for(const a of cm.armiesOf(c, side)){
    const other = cm.armiesAt(c, a.townId, side).find(b => b.id !== a.id && cm.canMerge(c, a, b));
    if(other){
      const [into, from] = c.armies.indexOf(a) < c.armies.indexOf(other) ? [a, other] : [other, a];
      cm.mergeArmies(c, map, into.id, from.id);
      return mergeWherePossible(c, map, side);
    }
  }
}

/* Spending at Lille: top up depleted brigades there first (a gun or horse
   now and then, otherwise infantry), then raise a brigade, never letting the
   turn's income fall below zero. */
export function strategicAiRecruit(c, map, archive){
  const side = c.aiSide, rules = cm.economyRules(map), depot = cm.homeDepot(map, side);
  if(!depot || !cm.canRecruitAt(c, map, side, depot.id)) return;
  const affordable = (cost, addedUnits) => c.gold[side] >= cost && cm.incomeOf(c, map, side).net - addedUnits * rules.upkeepPerUnit >= 0;
  for(let guard = 0; guard < 12; guard++){
    const slot = cm.armiesAt(c, depot.id, side).flatMap(a => a.brigades.map(br => ({ a, br })))
      .filter(x => cm.fightingUnits(x.br).length < rules.maxFightingUnitsPerBrigade)
      .sort((x, y) => cm.fightingUnits(x.br).length - cm.fightingUnits(y.br).length)[0];
    if(slot){
      const has = t => slot.br.units.some(u => u.type === t);
      const type = !has('ARTILLERY') ? 'ARTILLERY' : !has('LIGHT_CAV') && !has('HEAVY_CAV') ? 'LIGHT_CAV' : 'INFANTRY';
      const pick = affordable(rules.unitCost[type], 1) ? type : affordable(rules.unitCost.INFANTRY, 1) ? 'INFANTRY' : null;
      if(!pick) return;
      cm.recruitUnit(c, map, archive, slot.a.id, slot.br.id, pick);
      continue;
    }
    if(!affordable(rules.newBrigadeCost, 2)) return;
    // Into an army at Lille with room, else as a new army there; a weak new
    // army then marches to join another (the "rebuild" judgement above).
    try { cm.raiseBrigade(c, map, archive, side); } catch { return; }
  }
}
