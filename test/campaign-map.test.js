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
