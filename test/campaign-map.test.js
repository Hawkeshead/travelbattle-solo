/* THE CAMPAIGN MAP'S RULES (js/campaign-map-core.js), Phase 1.

   The core is pure, so these run without a browser: the Flanders map data,
   the default army, movement, split and merge, the placeholder French AI,
   battle results written back (losses, broken brigades, retreat, cornered
   armies), both victory conditions and the save round trip. */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import * as cm from '../js/campaign-map-core.js';
import { POINT_VALUE } from '../js/rts/constants.js';

const json = p => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), 'utf8'));
const MAP = json('../data/campaign-maps/flanders.json');
const COMPS = json('../data/army-compositions.json');
const ARCHIVE = json('../data/unit-archive.json');
const CARDS = json('../data/scenario-cards.json');
const fresh = () => cm.createCampaign(MAP, COMPS, ARCHIVE, { id: 'test', now: '2026-10-05T00:00:00Z' });

test('the Flanders map is well formed', () => {
  assert.strictEqual(MAP.towns.length, 21);
  const ids = new Set(MAP.towns.map(t => t.id));
  for(const t of MAP.towns){
    assert.ok(t.links.length >= 2 && t.links.length <= 4, `${t.name} has ${t.links.length} roads`);
    for(const l of t.links){
      assert.ok(ids.has(l), `${t.name} links to unknown ${l}`);
      assert.ok(cm.townById(MAP, l).links.includes(t.id), `road ${t.id}-${l} is one way`);
    }
    for(const k of ['supplyValue', 'income', 'isDepot', 'hostility', 'terrainProfile', 'owner']) assert.ok(k in t, `${t.name} lacks ${k}`);
    if(t.historicalSiteId) assert.ok((CARDS.cards || CARDS).some(c => c.id === t.historicalSiteId), `${t.name}: no card ${t.historicalSiteId}`);
  }
  // Every town reachable from Ostend.
  for(const t of MAP.towns) assert.ok(cm.shortestPath(MAP, 'ostend', t.id), `${t.name} unreachable`);
  assert.ok(cm.townById(MAP, 'ostend').isDepot && cm.townById(MAP, 'lille').isDepot);
  const sites = MAP.towns.filter(t => t.historicalSiteId).map(t => t.name).sort();
  assert.deepStrictEqual(sites, ["Beaumont", "Caesar's Camp", 'Famars', 'Hondschoote', 'Lincelles', 'Tourcoing', 'Willems']);
});

test('unit values are the Real-Time clock-victory points', () => {
  assert.deepStrictEqual(cm.unitValues(MAP), POINT_VALUE);
});

test('each side starts with the default three-brigade army at its depot', () => {
  const c = fresh();
  assert.strictEqual(c.version, cm.CAMPAIGN_VERSION);
  const [b] = cm.armiesOf(c, 'british'), [f] = cm.armiesOf(c, 'french');
  assert.strictEqual(b.townId, 'ostend');
  assert.strictEqual(f.townId, 'lille');
  const balanced = COMPS.find(a => a.id === 'balanced');
  for(const a of [b, f]){
    assert.strictEqual(a.brigades.length, 3);
    a.brigades.forEach((br, i) => {
      assert.strictEqual(br.units[0].type, 'BRIGADIER');
      assert.deepStrictEqual(cm.fightingUnits(br).map(u => u.type), balanced.brigades[i].units.map(u => u.type));
      for(const u of br.units){ assert.ok(u.id && u.name && u.status === 'active' && u.xp === 0); }
    });
  }
  assert.strictEqual(cm.dateForTurn(MAP, 1), '23 May 1793');
  assert.strictEqual(cm.dateForTurn(MAP, 2), '6 June 1793');
  assert.strictEqual(c.totalTurns, 48);
});

test('armies move one town along a road, once a turn', () => {
  const c = fresh();
  const [b] = cm.armiesOf(c, 'british');
  assert.deepStrictEqual(cm.validMoves(c, MAP, b).sort(), ['bruges', 'nieuport']);
  assert.throws(() => cm.moveArmy(c, MAP, b.id, 'ypres'));
  assert.strictEqual(cm.moveArmy(c, MAP, b.id, 'nieuport').kind, 'moved');
  assert.deepStrictEqual(cm.validMoves(c, MAP, b), []);
});

test('split detaches 1 or 2 brigades; merge recombines up to 3', () => {
  const c = fresh();
  const [b] = cm.armiesOf(c, 'british');
  assert.throws(() => cm.splitArmy(c, MAP, b.id, b.brigades.map(x => x.id)));   // cannot take all three
  const s1 = cm.splitArmy(c, MAP, b.id, [b.brigades[2].id]);
  assert.strictEqual(s1.townId, 'ostend');
  assert.strictEqual(b.brigades.length, 2);
  const s2 = cm.splitArmy(c, MAP, b.id, [b.brigades[1].id]);
  assert.strictEqual(cm.armiesOf(c, 'british').length, 3);
  assert.ok(!cm.canSplit(c, s2));   // one brigade, and three armies already
  cm.mergeArmies(c, MAP, b.id, s1.id);
  cm.mergeArmies(c, MAP, b.id, s2.id);
  assert.strictEqual(b.brigades.length, 3);
  assert.strictEqual(cm.armiesOf(c, 'british').length, 1);
  // A split army inherits "moved", so splitting never buys a second march.
  cm.moveArmy(c, MAP, b.id, 'bruges');
  const s3 = cm.splitArmy(c, MAP, b.id, [b.brigades[0].id]);
  assert.strictEqual(s3.hasMoved, true);
});

test('the placeholder AI marches on the nearest British army and attacks', () => {
  const c = fresh();
  cm.endPlayerPhase(c, MAP);
  const r = cm.aiStep(c, MAP);
  assert.strictEqual(r.kind, 'moved');
  const [f] = cm.armiesOf(c, 'french');
  // Lille to Ostend: Lille, Lincelles, Menin, Ypres, Nieuport, Ostend.
  assert.strictEqual(f.townId, 'lincelles');
  assert.strictEqual(cm.aiStep(c, MAP).kind, 'done');
  cm.endAiPhase(c, MAP);
  assert.strictEqual(c.turn, 2);
  assert.strictEqual(c.phase, 'british');
  // Put the armies next to each other: the next French move is an attack.
  const [b] = cm.armiesOf(c, 'british');
  b.townId = 'menin';
  cm.endPlayerPhase(c, MAP);
  const a = cm.aiStep(c, MAP);
  assert.strictEqual(a.kind, 'battle');
  assert.strictEqual(c.pendingBattle.townId, 'menin');
  assert.strictEqual(c.pendingBattle.attackerSide, 'french');
  assert.strictEqual(c.pendingBattle.boardMode, 'standard');
});

test('a battle result is written back and the loser retreats', () => {
  const c = fresh();
  const [b] = cm.armiesOf(c, 'british'), [f] = cm.armiesOf(c, 'french');
  b.townId = 'ypres'; f.townId = 'menin';
  cm.moveArmy(c, MAP, b.id, 'menin');
  const battle = c.pendingBattle;
  assert.strictEqual(battle.participants.british.length, 3);
  // France loses one whole brigade and one gun from another.
  const lost = [...f.brigades[0].units.filter(u => u.type !== 'BRIGADIER').map(u => u.id),
                f.brigades[1].units.find(u => u.type === 'ARTILLERY').id,
                b.brigades[0].units.find(u => u.type === 'INFANTRY').id];
  const summary = cm.applyBattleResult(c, MAP, { winner: 'british', lost });
  assert.strictEqual(c.pendingBattle, null);
  assert.strictEqual(f.brigades.length, 2, 'broken brigade removed');
  assert.ok(!f.brigades.some(br => br.units.some(u => lost.includes(u.id))));
  assert.strictEqual(summary.retreat.side, 'french');
  assert.notStrictEqual(f.townId, 'menin');
  assert.ok(cm.armiesAt(c, f.townId, 'british').length === 0, 'retreated into an enemy-free town');
  assert.strictEqual(b.townId, 'menin', 'the winning attacker holds the town');
  const v = cm.unitValues(MAP);
  const expected = lost.slice(0, -1).reduce((n, id) => n + v[(summary.lostUnits.french.find(u => u.id === id) || {}).type], 0);
  assert.strictEqual(c.destroyedValue.british, expected);
  assert.strictEqual(c.destroyedValue.french, v.INFANTRY);
  assert.ok(c.log.some(e => e.kind === 'battle'));
});

test('a cornered loser is destroyed, and destroying every enemy army wins', () => {
  const c = fresh();
  const [b] = cm.armiesOf(c, 'british'), [f] = cm.armiesOf(c, 'french');
  // Dunkirk's only roads lead to Nieuport and Hondschoote. One British army
  // holds each, and a third attacks from Nieuport, so Nieuport stays held.
  f.townId = 'dunkirk';
  b.townId = 'nieuport';
  const blocker = cm.splitArmy(c, MAP, b.id, [b.brigades[2].id]);
  blocker.townId = 'hondschoote';
  cm.splitArmy(c, MAP, b.id, [b.brigades[1].id]);   // stays at Nieuport
  cm.moveArmy(c, MAP, b.id, 'dunkirk');
  const summary = cm.applyBattleResult(c, MAP, { winner: 'british', lost: [] });
  assert.strictEqual(summary.destroyedArmies.length, 1);
  assert.strictEqual(cm.armiesOf(c, 'french').length, 0);
  assert.deepStrictEqual(c.result && c.result.winner, 'british');
  assert.strictEqual(c.phase, 'over');
});

test('at the final turn the side that destroyed more value wins', () => {
  const c = fresh();
  c.turn = c.totalTurns;
  c.destroyedValue = { british: 10, french: 14 };
  cm.endPlayerPhase(c, MAP);
  cm.aiStep(c, MAP);
  cm.endAiPhase(c, MAP);
  assert.strictEqual(c.result.winner, 'french');
  const d = fresh(); d.turn = d.totalTurns; d.destroyedValue = { british: 5, french: 5 };
  cm.endPlayerPhase(d, MAP); cm.aiStep(d, MAP); cm.endAiPhase(d, MAP);
  assert.strictEqual(d.result.winner, 'draw');
});

test('a single-brigade fight uses the 10 x 10 board', () => {
  const c = fresh();
  const [b] = cm.armiesOf(c, 'british'), [f] = cm.armiesOf(c, 'french');
  const lone = cm.splitArmy(c, MAP, b.id, [b.brigades[0].id]);
  f.townId = 'bruges';
  f.brigades.splice(1);   // the French army there is down to one brigade
  cm.moveArmy(c, MAP, lone.id, 'bruges');
  assert.strictEqual(c.pendingBattle.boardMode, 'single');
});

test('the save round-trips and the log export reads', () => {
  const c = fresh();
  const [b] = cm.armiesOf(c, 'british');
  cm.moveArmy(c, MAP, b.id, 'bruges');
  const back = cm.restoreCampaign(cm.serialiseCampaign(c));
  assert.deepStrictEqual(back, c);
  assert.strictEqual(cm.restoreCampaign('{"kind":"campaign-map","version":999}'), null);
  assert.strictEqual(cm.restoreCampaign('not json'), null);
  const text = cm.campaignLogText(c, MAP);
  assert.match(text, /Turn 1, 23 May 1793/);
  assert.match(text, /marches from Ostend to Bruges/);
});

/* ---------- PHASE 2: withdrawal and pursuit ---------- */
const unitsOf = (types) => types.map((type, i) => ({ id: 'x' + type + i + Math.random().toString(36).slice(2, 6), name: type, type, xp: 0, status: 'active' }));
const brigade = (id, types) => ({ id, name: id, units: unitsOf(['BRIGADIER', ...types]) });

test('a cornered army cannot withdraw', () => {
  const c = fresh();
  const [b] = cm.armiesOf(c, 'british'), [f] = cm.armiesOf(c, 'french');
  f.townId = 'dunkirk'; b.townId = 'nieuport';
  const blocker = cm.splitArmy(c, MAP, b.id, [b.brigades[2].id]);
  blocker.townId = 'hondschoote';
  cm.splitArmy(c, MAP, b.id, [b.brigades[1].id]);
  cm.moveArmy(c, MAP, b.id, 'dunkirk');
  assert.strictEqual(c.pendingBattle.cornered, true);
  assert.strictEqual(c.pendingBattle.stage, 'battle');
  assert.throws(() => cm.chooseWithdraw(c, MAP, 'hondschoote'));
  // With a road open, the same army is offered the choice.
  const d = fresh();
  const [b2] = cm.armiesOf(d, 'british'), [f2] = cm.armiesOf(d, 'french');
  f2.townId = 'dunkirk'; b2.townId = 'nieuport';
  cm.moveArmy(d, MAP, b2.id, 'dunkirk');
  assert.strictEqual(d.pendingBattle.stage, 'decide');
  // The attacker came from Nieuport, so it is free too: both roads are open.
  assert.deepStrictEqual(cm.withdrawOptions(d, MAP, d.pendingBattle, 'french').sort(), ['hondschoote', 'nieuport']);
});

test('the French withdraw only beyond the configured value ratio', () => {
  const ratio = cm.withdrawalRules(MAP).aiWithdrawRatio;
  assert.strictEqual(ratio, 1.5);
  const setup = (frenchBrigades) => {
    const c = fresh();
    const [b] = cm.armiesOf(c, 'british'), [f] = cm.armiesOf(c, 'french');
    b.townId = 'ypres'; f.townId = 'menin';
    f.brigades.splice(frenchBrigades);
    cm.moveArmy(c, MAP, b.id, 'menin');
    return { c, b, f };
  };
  // Three brigades against three: about even, so France stands.
  const even = setup(3);
  assert.ok(!cm.aiShouldWithdraw(even.c, MAP, even.c.pendingBattle));
  cm.resolveAiChoices(even.c, MAP);
  assert.strictEqual(even.c.pendingBattle.stage, 'battle');
  // Three British brigades against one French: well past 1.5, France withdraws.
  const weak = setup(1);
  const att = cm.armyStrength(MAP, weak.b), def = cm.armyStrength(MAP, weak.f);
  assert.ok(att > def * ratio, `${att} vs ${def}`);
  cm.resolveAiChoices(weak.c, MAP);
  assert.strictEqual(weak.c.pendingBattle.stage, 'pursuit');
  assert.notStrictEqual(weak.f.townId, 'menin');
  assert.strictEqual(weak.b.townId, 'menin', 'the attacker holds the town');
  // Exactly at the ratio is not enough: "exceeds".
  const edge = setup(3);
  edge.f.brigades = [brigade('cbX', ['INFANTRY', 'INFANTRY'])];   // 8
  edge.b.brigades = [brigade('cbY', ['INFANTRY', 'INFANTRY', 'INFANTRY'])];   // 12 = 8 x 1.5
  assert.ok(!cm.aiShouldWithdraw(edge.c, MAP, edge.c.pendingBattle));
  edge.b.brigades[0].units.push(...unitsOf(['INFANTRY']));   // 16
  assert.ok(cm.aiShouldWithdraw(edge.c, MAP, edge.c.pendingBattle));
});

test('the AI retreats to the free town furthest from other British armies', () => {
  const c = fresh();
  const [b] = cm.armiesOf(c, 'british'), [f] = cm.armiesOf(c, 'french');
  // Menin's roads: Ypres, Courtrai, Lincelles. Britain attacks from Ypres with
  // a second army standing at Tourcoing, next to Courtrai and Lincelles.
  b.townId = 'ypres'; f.townId = 'menin'; f.brigades.splice(1);
  const other = cm.splitArmy(c, MAP, b.id, [b.brigades[2].id]);
  other.townId = 'tourcoing';
  cm.moveArmy(c, MAP, b.id, 'menin');
  const opts = cm.withdrawOptions(c, MAP, c.pendingBattle, 'french').sort();
  assert.deepStrictEqual(opts, ['courtrai', 'lincelles', 'ypres']);
  assert.strictEqual(cm.aiRetreatTown(c, MAP, c.pendingBattle), 'ypres');
});

test('the rearguard is the weakest brigade, fewest units on a tie', () => {
  const army = { brigades: [brigade('a', ['GUARD', 'INFANTRY', 'LIGHT_CAV']), brigade('b', ['INFANTRY', 'INFANTRY']), brigade('c', ['ARTILLERY', 'ARTILLERY'])] };
  assert.strictEqual(cm.weakestBrigade(MAP, [army]).brigade.id, 'b');   // 8 against 14 and 12
  const tie = { brigades: [brigade('d', ['INFANTRY', 'INFANTRY', 'BRIGADIER'].slice(0, 2)), brigade('e', ['INFANTRY', 'INFANTRY'])] };
  tie.brigades[0].units.push({ id: 'extra', name: 'B', type: 'BRIGADIER', xp: 0, status: 'active' });   // same value (8), one more unit
  assert.strictEqual(cm.weakestBrigade(MAP, [tie]).brigade.id, 'e');
});

test('French pursuit: cavalry always, on foot only with the advantage', () => {
  const withdrawn = (britishTypes, frenchBrigades) => {
    const c = fresh();
    const [b] = cm.armiesOf(c, 'british'), [f] = cm.armiesOf(c, 'french');
    f.brigades = frenchBrigades;
    b.brigades = [brigade('cbB', britishTypes)];
    b.townId = 'menin'; f.townId = 'lincelles';
    cm.endPlayerPhase(c, MAP);
    cm.moveArmy(c, MAP, f.id, 'menin');
    cm.chooseWithdraw(c, MAP, 'ypres');   // the player's choice
    return c;
  };
  // Has a cavalry brigade: pursues with it, never on foot, whatever the odds.
  const cav = withdrawn(['GUARD', 'GUARD', 'INFANTRY'], [brigade('cbF1', ['INFANTRY', 'INFANTRY']), brigade('cbF2', ['LIGHT_CAV', 'INFANTRY'])]);
  cm.resolveAiChoices(cav, MAP);
  assert.strictEqual(cav.pendingBattle.stage, 'rearguard');
  assert.strictEqual(cav.pendingBattle.pursuit.brigadeId, 'cbF2');
  assert.strictEqual(cav.pendingBattle.pursuit.onFoot, false);
  // No cavalry and no 1.5 advantage: lets them go.
  const even = withdrawn(['INFANTRY', 'INFANTRY'], [brigade('cbF3', ['INFANTRY', 'INFANTRY'])]);
  cm.resolveAiChoices(even, MAP);
  assert.strictEqual(even.pendingBattle, null);
  // No cavalry but more than 1.5 times the value: pursues on foot, penalised.
  const strong = withdrawn(['INFANTRY'], [brigade('cbF4', ['INFANTRY', 'INFANTRY']), brigade('cbF5', ['GUARD', 'INFANTRY'])]);
  cm.resolveAiChoices(strong, MAP);
  assert.strictEqual(strong.pendingBattle.stage, 'rearguard');
  assert.strictEqual(strong.pendingBattle.pursuit.onFoot, true);
  assert.strictEqual(strong.pendingBattle.pursuit.dicePenalty, 1);
  assert.strictEqual(strong.pendingBattle.pursuit.brigadeId, 'cbF5', 'the strongest brigade goes');
});

test('the player must pursue with cavalry if any brigade has it', () => {
  const c = fresh();
  const [b] = cm.armiesOf(c, 'british'), [f] = cm.armiesOf(c, 'french');
  b.townId = 'ypres'; f.townId = 'menin'; f.brigades.splice(1);
  cm.moveArmy(c, MAP, b.id, 'menin');
  cm.chooseWithdraw(c, MAP, cm.aiRetreatTown(c, MAP, c.pendingBattle));
  const choice = cm.pursuitChoices(c, MAP);
  assert.strictEqual(choice.onFoot, false);
  assert.ok(choice.brigades.every(cm.hasCavalry));
  const footOnly = b.brigades.find(x => !cm.hasCavalry(x));
  if(footOnly) assert.throws(() => cm.choosePursue(c, MAP, footOnly.id));
  cm.choosePursue(c, MAP, choice.brigades[0].id);
  assert.strictEqual(c.pendingBattle.boardMode, 'single');
  assert.strictEqual(c.pendingBattle.rearguardTurns, 8);
});

test('a rearguard result is permanent, and a withdrawn army rests a turn', () => {
  const c = fresh();
  const [b] = cm.armiesOf(c, 'british'), [f] = cm.armiesOf(c, 'french');
  b.townId = 'ypres'; f.townId = 'menin';
  f.brigades.splice(2);
  cm.moveArmy(c, MAP, b.id, 'menin');
  cm.chooseWithdraw(c, MAP, 'lincelles');
  const rg = c.pendingBattle.withdrawal.rearguard;
  cm.choosePursue(c, MAP, cm.pursuitChoices(c, MAP).brigades[0].id);
  const rgBrig = f.brigades.find(x => x.id === rg.brigadeId);
  const lost = cm.fightingUnits(rgBrig).map(u => u.id);   // the rearguard is broken
  const s = cm.applyRearguardResult(c, MAP, { winner: 'british', lost });
  assert.strictEqual(c.pendingBattle, null);
  assert.strictEqual(f.brigades.length, 1);
  assert.strictEqual(f.townId, 'lincelles');
  assert.strictEqual(b.townId, 'menin');
  assert.strictEqual(s.brokenBrigades.french.length, 1);
  assert.ok(c.log.some(e => e.kind === 'rearguard'));
  // France withdrew in the British phase, so it rests in this turn's French phase.
  assert.strictEqual(f.restTurn, c.turn);
  assert.ok(cm.restPending(f));
  cm.endPlayerPhase(c, MAP);
  assert.deepStrictEqual(cm.validMoves(c, MAP, f), []);
  assert.strictEqual(cm.aiStep(c, MAP).kind, 'held');
  cm.endAiPhase(c, MAP);
  assert.ok(!cm.restPending(f), 'free again next turn');
});

test('a Phase 1 (version 1) save loads and plays on', () => {
  const c = fresh();
  const [b] = cm.armiesOf(c, 'british');
  // What a Phase 1 save looked like: version 1, no restTurn, a pending battle with no stage.
  const v1 = JSON.parse(cm.serialiseCampaign(c));
  v1.version = 1;
  for(const a of v1.armies) delete a.restTurn;
  const back = cm.restoreCampaign(JSON.stringify(v1));
  assert.strictEqual(back.version, cm.CAMPAIGN_VERSION);
  assert.ok(back.armies.every(a => a.restTurn === null));
  cm.moveArmy(back, MAP, b.id, 'bruges');
  cm.endPlayerPhase(back, MAP);
  while(cm.aiStep(back, MAP).kind !== 'done'){ /* French march */ }
  cm.endAiPhase(back, MAP);
  assert.strictEqual(back.turn, 2);
  // A battle pending in a version 1 save stays a straight fight.
  const p1 = JSON.parse(cm.serialiseCampaign(fresh()));
  p1.version = 1;
  p1.pendingBattle = { id: 'battle1', townId: 'menin', attackerSide: 'british', participants: { british: [], french: [] } };
  assert.strictEqual(cm.restoreCampaign(JSON.stringify(p1)).pendingBattle.stage, 'battle');
});
