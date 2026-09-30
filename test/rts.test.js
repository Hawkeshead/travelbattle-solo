// Real-Time variant: the simulation core (js/rts/sim.js), which is pure and
// runs without a browser. Timing is in ticks, never the wall clock. The
// turn-based rules it borrows (range and chain) are stubbed here with simple
// stand-ins; in the game they come from the turn-based engine itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brokenBrigades, createBattle, issueGroupOrder, issueOrder, loadBattle, poolOf, saveBattle, step, visualPosition } from '../js/rts/sim.js';
import { ARTILLERY_RELOAD_TICKS, COOLDOWN_TICKS, FORM_TICKS, LIMBER_TICKS, MATCH_CLOCK_TICKS, MELEE_ROUND_TICKS, ORDER_REGEN_TICKS, ROAD_TRAVEL_FACTOR, TRAVEL_TICKS } from '../js/rts/constants.js';
import { nextRandom } from '../js/rts/rng.js';

const COLS = 20, ROWS = 10;
const terrain = Array.from({ length: ROWS }, () => Array(COLS).fill('OPEN'));
const noRoad = Array.from({ length: ROWS }, () => Array(COLS).fill(false));
const RANGE = { INFANTRY: 3, LIGHT_CAV: 4, BRIGADIER: 4 };      // generous stand-ins, so paths have room
const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
// Stand-in rules: range by type, chain = within 2 squares of the Brigadier of its brigade.
const rules = {
  inChain(b, u){
    if(u.type === 'BRIGADIER') return true;
    const brig = b.units.find(o => !o.removed && o.type === 'BRIGADIER' && o.side === u.side && o.brigadeId === u.brigadeId);
    return !brig || cheb(brig, u) <= 2;
  },
  reachable(b, u){
    const r = RANGE[u.type] || 1, out = [];
    for(let y = 0; y < ROWS; y++) for(let x = 0; x < COLS; x++) if(cheb(u, { x, y }) <= r && cheb(u, { x, y }) > 0) out.push({ x, y, steps: cheb(u, { x, y }) });
    return out;
  },
  canAttack: (b, a, d) => d.type !== 'BRIGADIER',
  canFireAt: (b, g, t) => cheb(g, t) <= 6 && t.type !== 'BRIGADIER' && !t.hidden,
  inCover: () => false,
  fightDice: () => ({ aDice: 1, dDice: 1, aBonus: 0, dBonus: 0, aReroll: false, dReroll: false, defenderHigher: false }),
};
const withDice = over => ({ ...rules, fightDice: () => ({ aDice: 1, dDice: 1, aBonus: 0, dBonus: 0, aReroll: false, dReroll: false, defenderHigher: false, ...over }) });
const units = [
  { id: 'g', side: 'red', type: 'BRIGADIER', brigadeId: 0, x: 3, y: 9 },
  { id: 'a', side: 'red', type: 'INFANTRY', brigadeId: 0, x: 2, y: 8 },
  { id: 'b', side: 'red', type: 'LIGHT_CAV', brigadeId: 0, x: 3, y: 8 },
  { id: 'far', side: 'red', type: 'INFANTRY', brigadeId: 0, x: 12, y: 8 },
  { id: 'c', side: 'blue', type: 'INFANTRY', brigadeId: 0, x: 10, y: 1 },
];
const fresh = (road = noRoad) => createBattle({ seed: 42, terrain, road, units, playerSide: 'red' });
const run = (b, n, r = rules) => { for (let i = 0; i < n; i++) step(b, r); };
const U = (b, id) => b.units.find(u => u.id === id);
const move = (b, id, x, y) => issueOrder(b, { unitId: id, type: 'move', target: { x, y } }, rules);

test('a move takes the travel time per square, counted in ticks', () => {
  const b = fresh();
  assert.equal(move(b, 'a', 2, 6).ok, true);
  run(b, TRAVEL_TICKS.INFANTRY * 2);
  assert.deepEqual([U(b, 'a').x, U(b, 'a').y], [2, 7]);
  run(b, 2);
  assert.deepEqual([U(b, 'a').x, U(b, 'a').y], [2, 6]);
});

test('roads are about a third faster', () => {
  const road = noRoad.map(r => r.slice()); road[8][2] = road[7][2] = true;
  const b = fresh(road);
  move(b, 'a', 2, 7);
  run(b, 1 + Math.round(TRAVEL_TICKS.INFANTRY * ROAD_TRAVEL_FACTOR));
  assert.deepEqual([U(b, 'a').x, U(b, 'a').y], [2, 7]);
});

test('the pool starts full at one order per unit, spends one per order, and regenerates up to the cap', () => {
  const b = fresh();
  const { pool, cap } = poolOf(b, U(b, 'a'));
  assert.equal(cap, 3);                        // a, b and far; the Brigadier is not counted
  assert.equal(pool.orders, 3);
  move(b, 'a', 2, 6);
  assert.equal(poolOf(b, U(b, 'a')).pool.orders, 2);
  run(b, ORDER_REGEN_TICKS);
  assert.equal(poolOf(b, U(b, 'a')).pool.orders, 3);
  run(b, ORDER_REGEN_TICKS * 3);
  assert.equal(poolOf(b, U(b, 'a')).pool.orders, 3);   // capped
});

test('moving the Brigadier costs no order', () => {
  const b = fresh();
  assert.equal(move(b, 'g', 5, 9).ok, true);
  assert.equal(poolOf(b, U(b, 'a')).pool.orders, 3);
});

test('an empty pool refuses, and the refusal changes nothing', () => {
  const b = fresh();
  poolOf(b, U(b, 'a')).pool.orders = 0;
  const before = saveBattle(b);
  assert.deepEqual(move(b, 'a', 2, 6), { ok: false, reason: 'No orders left' });
  assert.equal(saveBattle(b), before);
});

test('cooldown: no new order while moving or until the cooldown has run', () => {
  const b = fresh();
  move(b, 'b', 3, 7);
  assert.equal(move(b, 'b', 3, 6).reason, 'Still moving');
  run(b, TRAVEL_TICKS.LIGHT_CAV + 2);                  // arrived, cooldown still running
  assert.equal(move(b, 'b', 3, 6).reason, 'Not ready yet');
  run(b, COOLDOWN_TICKS.LIGHT_CAV);
  assert.equal(move(b, 'b', 3, 6).ok, true);
});

test('range cap: beyond the allowance is refused', () => {
  const b = fresh();
  assert.equal(move(b, 'a', 2, 2).reason, 'Out of range');
});

test('a unit off the chain can be given nothing new', () => {
  const b = fresh();
  assert.equal(move(b, 'far', 12, 7).reason, 'Out of the chain');
});

test('group orders: all go, each to its own square, one order each', () => {
  const b = fresh();
  const res = issueGroupOrder(b, { unitIds: ['a', 'b'], type: 'move', target: { x: 3, y: 6 } }, rules);
  assert.equal(res.ok, true);
  assert.equal(poolOf(b, U(b, 'a')).pool.orders, 1);
  run(b, 200);
  const spots = ['a', 'b'].map(id => U(b, id).x + ',' + U(b, id).y);
  assert.equal(new Set(spots).size, 2);
  assert.ok(spots.includes('3,6'));
});

test('group orders: a short pool refuses the whole group', () => {
  const b = fresh();
  poolOf(b, U(b, 'a')).pool.orders = 1;
  const before = saveBattle(b);
  assert.equal(issueGroupOrder(b, { unitIds: ['a', 'b'], type: 'move', target: { x: 3, y: 6 } }, rules).reason, 'No orders left');
  assert.equal(saveBattle(b), before);
});

test('two units never share a square', () => {
  const b = fresh();
  move(b, 'a', 4, 7);
  move(b, 'b', 4, 7);                                  // refused or rerouted; either way no sharing
  for (let t = 0; t < 400; t++) {
    step(b);
    const occ = b.units.filter(u => !u.removed).map(u => u.x + ',' + u.y);
    assert.equal(new Set(occ).size, occ.length);
  }
});

test('a blocked unit waits, then finds another way', () => {
  const b = createBattle({ seed: 1, terrain, road: noRoad, playerSide: 'red', units: [
    { id: 'g', side: 'red', type: 'BRIGADIER', brigadeId: 0, x: 5, y: 9 },
    { id: 'a', side: 'red', type: 'INFANTRY', brigadeId: 0, x: 5, y: 8 },
    { id: 'z', side: 'red', type: 'INFANTRY', brigadeId: 1, x: 5, y: 7 },
  ]});
  // a is told to go straight through the square z stands on; it must route round
  U(b, 'a').path = [{ x: 5, y: 7 }, { x: 5, y: 6 }]; U(b, 'a').goal = { x: 5, y: 6 };
  run(b, 400);
  assert.deepEqual([U(b, 'a').x, U(b, 'a').y], [5, 6]);
});

test('contact is commitment: an enemy beside it mid-route and it stops', () => {
  const b = createBattle({ seed: 1, terrain, road: noRoad, playerSide: 'red', units: [
    { id: 'g', side: 'red', type: 'BRIGADIER', brigadeId: 0, x: 0, y: 9 },
    { id: 'a', side: 'red', type: 'INFANTRY', brigadeId: 0, x: 5, y: 8 },
    { id: 'e', side: 'blue', type: 'INFANTRY', brigadeId: 0, x: 7, y: 7 },
  ]});
  U(b, 'a').path = [{ x: 6, y: 8 }, { x: 7, y: 8 }, { x: 8, y: 8 }]; U(b, 'a').goal = { x: 8, y: 8 };
  run(b, 300);
  assert.deepEqual([U(b, 'a').x, U(b, 'a').y], [6, 8]);
});

test('paths keep away from the enemy when they can', () => {
  const b = createBattle({ seed: 1, terrain, road: noRoad, playerSide: 'red', units: [
    { id: 'g', side: 'red', type: 'BRIGADIER', brigadeId: 0, x: 0, y: 9 },
    { id: 'a', side: 'red', type: 'LIGHT_CAV', brigadeId: 0, x: 4, y: 5 },
    { id: 'e', side: 'blue', type: 'INFANTRY', brigadeId: 0, x: 6, y: 4 },
  ]});
  assert.equal(issueOrder(b, { unitId: 'a', type: 'move', target: { x: 8, y: 5 } }, { ...rules, inChain: () => true }).ok, true);
  const near = U(b, 'a').path.slice(0, -1).some(s => cheb(s, { x: 6, y: 4 }) === 1);
  assert.equal(near, false);
});

test('save and load: a battle resumes exactly where it was', () => {
  const b = fresh();
  move(b, 'b', 5, 6);
  run(b, 37);
  const copy = loadBattle(saveBattle(b));
  run(b, 200); run(copy, 200);
  assert.equal(saveBattle(copy), saveBattle(b));
});

test('seeded replay: same seed and orders give the same battle, dice included', () => {
  const play = () => {
    const b = fresh();
    move(b, 'a', 2, 6);
    run(b, 50);
    move(b, 'g', 4, 7);
    run(b, 150);
    const rolls = [nextRandom(b), nextRandom(b), nextRandom(b)];
    return saveBattle(b) + JSON.stringify(rolls);
  };
  assert.equal(play(), play());
});

test('drawn position moves smoothly between squares', () => {
  const b = fresh();
  move(b, 'a', 2, 7);
  run(b, 1 + Math.floor(TRAVEL_TICKS.INFANTRY / 2));
  const p = visualPosition(U(b, 'a'), 0);
  assert.ok(p.y < 8 && p.y > 7, `mid-square y, got ${p.y}`);
});

/* ---------------- Phase 3: melee ---------------- */
const duel = () => createBattle({ seed: 7, terrain, road: noRoad, playerSide: 'red', units: [
  { id: 'rg', side: 'red', type: 'BRIGADIER', brigadeId: 0, x: 0, y: 9 },
  { id: 'r', side: 'red', type: 'INFANTRY', brigadeId: 0, x: 5, y: 7 },
  { id: 'r2', side: 'red', type: 'INFANTRY', brigadeId: 0, x: 1, y: 9 },
  { id: 'bg', side: 'blue', type: 'BRIGADIER', brigadeId: 0, x: 19, y: 0 },
  { id: 'e', side: 'blue', type: 'INFANTRY', brigadeId: 0, x: 5, y: 4 },
  { id: 'e2', side: 'blue', type: 'INFANTRY', brigadeId: 0, x: 18, y: 0 },
]});

test('contact starts a fight; the unit that arrived is the attacker; the first round comes after the round time', () => {
  const b = duel();
  U(b, 'r').path = [{ x: 5, y: 6 }, { x: 5, y: 5 }];
  run(b, TRAVEL_TICKS.INFANTRY * 2 + 3);
  const f = Object.values(b.fights)[0];
  assert.ok(f, 'a fight exists');
  assert.equal(f.a, 'r'); assert.equal(f.d, 'e');
  assert.equal(f.rounds, 0);
  run(b, MELEE_ROUND_TICKS);
  assert.ok(b.stats.rounds >= 1 || !b.fights[Object.keys(b.fights)[0]]);
});

test('margin 3 or more destroys the loser; the winner holds', () => {
  const b = duel(), r = withDice({ aBonus: 10 });
  U(b, 'r').path = [{ x: 5, y: 6 }, { x: 5, y: 5 }];
  run(b, 200, r);
  assert.equal(U(b, 'e').removed, true);
  assert.deepEqual([U(b, 'r').x, U(b, 'r').y], [5, 5]);
});

test('the defender wins too: a strong defence destroys the attacker', () => {
  const b = duel(), r = withDice({ dBonus: 10 });
  U(b, 'r').path = [{ x: 5, y: 6 }, { x: 5, y: 5 }];
  run(b, 200, r);
  assert.equal(U(b, 'r').removed, true);
});

test('a tie against higher ground pushes the attacker back and turns it around (no orders meanwhile)', () => {
  const b = duel();
  const r = { ...withDice({ aDice: 1, dDice: 1 }), fightDice: () => ({ aDice: 1, dDice: 1, aBonus: 0, dBonus: 0, aReroll: false, dReroll: false, defenderHigher: true }) };
  U(b, 'r').path = [{ x: 5, y: 6 }, { x: 5, y: 5 }];
  let pushedAt = null;
  for(let t = 0; t < 2000 && pushedAt === null; t++){ step(b, r); if(U(b, 'r').turnedUntil > b.tick) pushedAt = b.tick; }
  assert.ok(pushedAt !== null, 'pushed back at some point');
  assert.equal(issueOrder(b, { unitId: 'r', type: 'move', target: { x: 5, y: 9 } }, rules).reason, 'Turned around');
});

test('Brigadiers never fight', () => {
  const b = createBattle({ seed: 3, terrain, road: noRoad, playerSide: 'red', units: [
    { id: 'rg', side: 'red', type: 'BRIGADIER', brigadeId: 0, x: 5, y: 5 },
    { id: 'bg', side: 'blue', type: 'BRIGADIER', brigadeId: 0, x: 5, y: 4 },
    { id: 'e', side: 'blue', type: 'INFANTRY', brigadeId: 0, x: 6, y: 4 },
  ]});
  run(b, 200);
  assert.equal(Object.keys(b.fights).length, 0);
});

test('two-brigade skirmish plays through to a break, with no stuck fights and never two in a square', () => {
  const mk = (side, bId, x0, y) => [
    { id: `${side}${bId}g`, side, type: 'BRIGADIER', brigadeId: bId, x: x0 + 2, y: side === 'red' ? 9 : 0 },
    ...[0, 1, 2, 3].map(i => ({ id: `${side}${bId}u${i}`, side, type: i === 3 ? 'LIGHT_CAV' : 'INFANTRY', brigadeId: bId, x: x0 + i, y })),
  ];
  const b = createBattle({ seed: 99, terrain, road: noRoad, playerSide: 'red', units: [
    ...mk('red', 0, 2, 8), ...mk('red', 1, 10, 8), ...mk('blue', 0, 2, 1), ...mk('blue', 1, 10, 1),
  ]});
  const loose = { ...rules, inChain: () => true };
  let t = 0;
  for(; t < 20000 && !b.over; t++){
    if(t % 5 === 0){
      for(const u of b.units){
        if(u.removed || u.type === 'BRIGADIER') continue;
        const foe = b.units.filter(o => !o.removed && o.side !== u.side && o.type !== 'BRIGADIER').sort((p, q) => cheb(u, p) - cheb(u, q))[0];
        if(!foe || cheb(u, foe) <= 1) continue;
        const cells = loose.reachable(b, u).sort((p, q) => cheb(p, foe) - cheb(q, foe));
        for(const c of cells.slice(0, 6)) if(issueOrder(b, { unitId: u.id, type: 'move', target: c }, loose).ok) break;
      }
    }
    step(b, loose);
    const occ = b.units.filter(u => !u.removed).map(u => u.x + ',' + u.y);
    assert.equal(new Set(occ).size, occ.length);
  }
  assert.equal(b.over, true, `ended within ${t} ticks`);
  const loser = b.winner === 'red' ? 'blue' : 'red';
  assert.ok(brokenBrigades(b, loser).broken >= 2);
  assert.ok(b.stats.rounds > 0);
  for(const f of Object.values(b.fights)) assert.ok(f.rounds < 200, 'no fight went on for ever');
});

test('battles with fights replay identically from the same seed and orders', () => {
  const play = () => {
    const b = duel();
    U(b, 'r').path = [{ x: 5, y: 6 }, { x: 5, y: 5 }];
    run(b, 1500);
    return saveBattle(b);
  };
  assert.equal(play(), play());
});

/* ---------------- Phase 4: artillery, formations, ambush, charge, clock ---------------- */
const field = (extra = [], terr = terrain) => createBattle({ seed: 11, terrain: terr, road: noRoad, playerSide: 'red', units: [
  { id: 'rg', side: 'red', type: 'BRIGADIER', brigadeId: 0, x: 0, y: 9 },
  { id: 'gun', side: 'red', type: 'ARTILLERY', brigadeId: 0, x: 5, y: 8 },
  { id: 'inf', side: 'red', type: 'INFANTRY', brigadeId: 0, x: 8, y: 8 },
  { id: 'bg', side: 'blue', type: 'BRIGADIER', brigadeId: 0, x: 19, y: 0 },
  { id: 't', side: 'blue', type: 'INFANTRY', brigadeId: 0, x: 5, y: 4 },
  ...extra,
]});
const loose = { ...rules, inChain: () => true };

test('artillery: one order locks on and it keeps firing on its reload', () => {
  const b = field();
  const before = poolOf(b, U(b, 'gun')).pool.orders;
  assert.equal(issueOrder(b, { unitId: 'gun', type: 'fire', targetId: 't' }, loose).ok, true);
  assert.equal(poolOf(b, U(b, 'gun')).pool.orders, before - 1);
  run(b, ARTILLERY_RELOAD_TICKS * 3 + 5, loose);
  assert.ok((b.stats.shots || 0) >= 3 || U(b, 't').removed, `shots ${b.stats.shots}`);
});

test('artillery: the lock breaks when the line of fire goes', () => {
  const b = field();
  issueOrder(b, { unitId: 'gun', type: 'fire', targetId: 't' }, loose);
  run(b, 2, loose);
  const blind = { ...loose, canFireAt: () => false };
  run(b, ARTILLERY_RELOAD_TICKS + 2, blind);
  assert.equal(U(b, 'gun').lock, null);
});

test('artillery: moving drops the lock and limbers up first', () => {
  const b = field();
  issueOrder(b, { unitId: 'gun', type: 'fire', targetId: 't' }, loose);
  run(b, COOLDOWN_TICKS.ARTILLERY + 2, loose);
  assert.equal(issueOrder(b, { unitId: 'gun', type: 'move', target: { x: 5, y: 7 } }, loose).ok, true);
  assert.equal(U(b, 'gun').lock, null);
  run(b, LIMBER_TICKS - 1, loose);
  assert.equal(U(b, 'gun').step, null, 'still limbering');
});

test('Square: takes time, cannot move, and does not start fights', () => {
  const b = field();
  assert.equal(issueOrder(b, { unitId: 'inf', type: 'form', formation: 'square' }, loose).ok, true);
  run(b, FORM_TICKS.SQUARE + 1, loose);
  assert.equal(U(b, 'inf').formation, 'square');
  run(b, COOLDOWN_TICKS.INFANTRY, loose);
  assert.equal(issueOrder(b, { unitId: 'inf', type: 'move', target: { x: 8, y: 7 } }, loose).reason, 'In Square: form Line first');
  // an enemy walks up beside it: the enemy is the attacker, whoever arrived
  U(b, 't').x = 8; U(b, 't').y = 6; U(b, 't').path = [{ x: 8, y: 7 }];
  run(b, TRAVEL_TICKS.INFANTRY + 3, loose);
  const f = Object.values(b.fights)[0];
  assert.ok(f); assert.equal(f.a, 't');
});

test('Ambush: laid in woods it hides, then springs on an enemy stepping beside it, striking first', () => {
  const woods = terrain.map(r => r.slice()); woods[8][8] = 'WOODS';
  const b = field([], woods);
  assert.equal(issueOrder(b, { unitId: 'inf', type: 'form', formation: 'ambush' }, loose).ok, true);
  run(b, FORM_TICKS.AMBUSH + 1, loose);
  assert.equal(U(b, 'inf').hidden, true);
  U(b, 't').x = 8; U(b, 't').y = 5; U(b, 't').path = [{ x: 8, y: 6 }, { x: 8, y: 7 }, { x: 8, y: 8 }];
  let sprung = null;
  for(let i = 0; i < 400 && !sprung; i++){ step(b, loose); sprung = b.events.find(e => e.text === 'Ambush!'); }
  assert.ok(sprung, 'ambush sprang');
  assert.equal(U(b, 'inf').hidden, false);
  assert.equal(b.stats.rounds, 1, 'the ambusher struck at once');
  assert.notDeepEqual([U(b, 't').x, U(b, 't').y], [8, 8]);
  assert.ok(!U(b, 't').path.some(p => p.x === 8 && p.y === 8), 'the enemy no longer marches on');
});

test('Charge: cavalry that crossed two squares in a straight line into contact charges', () => {
  const b = field([{ id: 'cav', side: 'red', type: 'LIGHT_CAV', brigadeId: 0, x: 12, y: 8 }]);
  U(b, 'cav').path = [{ x: 12, y: 7 }, { x: 12, y: 6 }, { x: 12, y: 5 }];
  U(b, 't').x = 12; U(b, 't').y = 4;
  let f = null;
  for(let i = 0; i < 200 && !f; i++){ step(b, loose); f = Object.values(b.fights).find(x => x.a === 'cav'); }
  assert.ok(f); assert.equal(f.charge, true);
});

test('the match clock: at time, the side ahead on points wins', () => {
  const b = field();
  b.stats.lostValue.blue = 12; b.stats.lostValue.red = 6;
  b.tick = MATCH_CLOCK_TICKS - 1;
  step(b, loose);
  assert.equal(b.over, true); assert.equal(b.result, 'clock'); assert.equal(b.winner, 'red');
});

/* ---------------- Columns ---------------- */
const pair = () => createBattle({ seed: 5, terrain, road: noRoad, playerSide: 'red', units: [
  { id: 'rg', side: 'red', type: 'BRIGADIER', brigadeId: 0, x: 0, y: 9 },
  { id: 'p', side: 'red', type: 'INFANTRY', brigadeId: 0, x: 6, y: 8 },
  { id: 'q', side: 'red', type: 'INFANTRY', brigadeId: 0, x: 7, y: 8 },
  { id: 'bg', side: 'blue', type: 'BRIGADIER', brigadeId: 0, x: 19, y: 0 },
  { id: 'e', side: 'blue', type: 'INFANTRY', brigadeId: 0, x: 18, y: 1 },
]});
const stackUp = b => {
  assert.equal(issueOrder(b, { unitId: 'q', type: 'move', target: { x: 6, y: 8 } }, loose).ok, true);
  run(b, TRAVEL_TICKS.INFANTRY + 3, loose);
  assert.deepEqual([U(b, 'q').x, U(b, 'q').y], [6, 8], 'stacked');
  run(b, COOLDOWN_TICKS.INFANTRY, loose);
};

test('Columns: stack two infantry, form Column, and they move as one for one order', () => {
  const b = pair();
  stackUp(b);
  assert.equal(issueOrder(b, { unitId: 'p', type: 'form', formation: 'column' }, loose).ok, true);
  run(b, FORM_TICKS.COLUMN + 1, loose);
  assert.ok(U(b, 'p').column && U(b, 'q').column, 'in Column');
  run(b, COOLDOWN_TICKS.INFANTRY, loose);
  poolOf(b, U(b, 'p')).pool.orders = 2;            // whatever the regeneration rate, the pool can pay
  const before = poolOf(b, U(b, 'p')).pool.orders;
  assert.equal(issueOrder(b, { unitId: 'q', type: 'move', target: { x: 6, y: 6 } }, loose).ok, true, 'either unit takes the order');
  assert.equal(poolOf(b, U(b, 'p')).pool.orders, before - 1, 'one order for the Column');
  for(let t = 0; t < TRAVEL_TICKS.INFANTRY * 3; t++){
    step(b, loose);
    assert.deepEqual([U(b, 'q').x, U(b, 'q').y], [U(b, 'p').x, U(b, 'p').y], 'in step');
  }
  assert.deepEqual([U(b, 'p').x, U(b, 'p').y], [6, 6]);
});

test('Columns: nothing else can stack on a pair, and a third unit is refused', () => {
  const b = createBattle({ seed: 5, terrain, road: noRoad, playerSide: 'red', units: [
    { id: 'rg', side: 'red', type: 'BRIGADIER', brigadeId: 0, x: 0, y: 9 },
    { id: 'p', side: 'red', type: 'INFANTRY', brigadeId: 0, x: 6, y: 8 },
    { id: 'q', side: 'red', type: 'INFANTRY', brigadeId: 0, x: 7, y: 8 },
    { id: 'r3', side: 'red', type: 'INFANTRY', brigadeId: 0, x: 5, y: 8 },
  ]});
  stackUp(b);
  assert.equal(issueOrder(b, { unitId: 'r3', type: 'move', target: { x: 6, y: 8 } }, loose).reason, 'Square is taken');
});

test('Columns: losing a fight breaks the Column and only the loser falls back', () => {
  let seen = 0;
  for(let seed = 1; seed <= 60 && seen < 3; seed++){
    const b = pair(); b.rng = seed;
    stackUp(b);
    issueOrder(b, { unitId: 'p', type: 'form', formation: 'column' }, loose);
    run(b, FORM_TICKS.COLUMN + 1, loose);
    U(b, 'e').x = 6; U(b, 'e').y = 7;
    for(let t = 0; t < 400; t++){
      step(b, loose);
      const pushed = ['p', 'q'].map(id => U(b, id)).find(u => !u.removed && u.turnedUntil > b.tick);
      if(!pushed) continue;
      const other = U(b, pushed.id === 'p' ? 'q' : 'p');
      assert.equal(U(b, 'p').column, null); assert.equal(U(b, 'q').column, null);
      if(!other.removed && other.turnedUntil <= b.tick) assert.deepEqual([other.x, other.y], [6, 8], 'the partner held');
      seen++; break;
    }
  }
  assert.ok(seen >= 1, 'saw a Column lose a fight');
});

test('Columns: a roundshot strikes both halves of a stack', () => {
  let seen = 0;
  for(let seed = 1; seed <= 80 && seen < 3; seed++){
    const b = createBattle({ seed, terrain, road: noRoad, playerSide: 'blue', units: [
      { id: 'rg', side: 'red', type: 'BRIGADIER', brigadeId: 0, x: 0, y: 9 },
      { id: 'p', side: 'red', type: 'INFANTRY', brigadeId: 0, x: 6, y: 8 },
      { id: 'q', side: 'red', type: 'INFANTRY', brigadeId: 0, x: 7, y: 8 },
      { id: 'bg', side: 'blue', type: 'BRIGADIER', brigadeId: 0, x: 19, y: 0 },
      { id: 'gun', side: 'blue', type: 'ARTILLERY', brigadeId: 0, x: 6, y: 6 },
    ]});
    stackUp(b);
    issueOrder(b, { unitId: 'gun', type: 'fire', targetId: 'p' }, loose);
    run(b, 3, loose);
    const hits = b.events.filter(e => e.kind === 'shot' && /Shaken|routed|destroyed/.test(e.text));
    if(!hits.length) continue;
    const who = new Set(hits.map(e => e.unitId));
    assert.ok(who.has('p') && who.has('q'), 'both halves took it');
    seen++;
  }
  assert.ok(seen >= 1, 'saw a telling shot');
});

/* ---------------- Phase 5: the AI ---------------- */
import { aiTick, createAi } from '../js/rts/ai.js';
import { AI_EVAL_TICKS, AI_REACTION_TICKS } from '../js/rts/constants.js';
const armies = () => createBattle({ seed: 21, terrain, road: noRoad, playerSide: 'red', units: [
  { id: 'rg', side: 'red', type: 'BRIGADIER', brigadeId: 0, x: 5, y: 9 },
  { id: 'r1', side: 'red', type: 'INFANTRY', brigadeId: 0, x: 4, y: 8 },
  { id: 'r2', side: 'red', type: 'INFANTRY', brigadeId: 0, x: 5, y: 8 },
  { id: 'r3', side: 'red', type: 'LIGHT_CAV', brigadeId: 0, x: 6, y: 8 },
  { id: 'bg', side: 'blue', type: 'BRIGADIER', brigadeId: 0, x: 5, y: 0 },
  { id: 'b1', side: 'blue', type: 'INFANTRY', brigadeId: 0, x: 4, y: 1 },
  { id: 'b2', side: 'blue', type: 'INFANTRY', brigadeId: 0, x: 5, y: 1 },
  { id: 'b3', side: 'blue', type: 'LIGHT_CAV', brigadeId: 0, x: 6, y: 1 },
]});

test('AI: decides on its evaluation beat and acts after a reaction delay, only through the order gate', () => {
  const b = armies(), ai = createAi('blue');
  for (let t = 0; t < AI_REACTION_TICKS[0]; t++) { step(b, loose); aiTick(ai, b, loose); }
  assert.equal(b.orderLog.length, 0, 'nothing before the reaction delay');
  for (let t = 0; t < AI_REACTION_TICKS[1] + 2; t++) { step(b, loose); aiTick(ai, b, loose); }
  assert.ok(b.orderLog.length > 0, 'orders issued');
  assert.ok(b.orderLog.every(o => o.side === 'blue'), 'only its own side');
});

test('AI: banks when its pool cannot cover a wave', () => {
  const b = armies(), ai = createAi('blue');
  poolOf(b, U(b, 'b1')).pool.orders = 0;
  for (let t = 0; t < AI_EVAL_TICKS * 2; t++) { step(b, loose); aiTick(ai, b, loose); }
  assert.equal(b.orderLog.filter(o => o.unitId !== 'bg').length, 0, 'no troop orders until the pool refills');
});

test('AI against AI plays to a result, and the same seed gives the same battle', () => {
  const play = () => {
    const b = armies(), ais = [createAi('red'), createAi('blue', { phase: 10 })];
    for (let t = 0; t < 20000 && !b.over; t++) { step(b, loose); for (const a of ais) aiTick(a, b, loose); }
    return b;
  };
  const a = play(), c = play();
  assert.equal(a.over, true);
  assert.equal(saveBattle(a), saveBattle(c));
});

/* ---------------- Pushback in full ---------------- */
import { MELEE_ROUND_TICKS as MR } from '../js/rts/constants.js';
const pushSeen = (build, check) => {
  let seen = 0;
  for (let seed = 1; seed <= 80 && seen < 2; seed++) {
    const b = build(); b.rng = seed;
    for (let t = 0; t < MR * 3 + 200; t++) {
      step(b, loose);
      const r = check(b);
      if (r === true) { seen++; break; }
      if (r === false) break;
    }
  }
  return seen;
};
test('pushback: a friendly unit behind the loser is shoved back and turned around', () => {
  const build = () => createBattle({ seed: 3, terrain, road: noRoad, playerSide: 'red', units: [
    { id: 'rg', side: 'red', type: 'BRIGADIER', brigadeId: 0, x: 0, y: 9 },
    { id: 'L', side: 'red', type: 'INFANTRY', brigadeId: 0, x: 6, y: 6 },
    { id: 'F', side: 'red', type: 'INFANTRY', brigadeId: 0, x: 6, y: 7 },
    { id: 'bg', side: 'blue', type: 'BRIGADIER', brigadeId: 0, x: 19, y: 0 },
    { id: 'W', side: 'blue', type: 'INFANTRY', brigadeId: 0, x: 6, y: 5 },
  ]});
  const seen = pushSeen(build, b => {
    const L = U(b, 'L'), F = U(b, 'F');
    if (L.removed || F.removed || U(b, 'W').removed) return false;
    if (b.events.some(e => e.text === 'Shoved back by the retreat')) {
      for (let t = 0; t < 120; t++) step(b, loose);
      assert.deepEqual([F.x, F.y], [6, 8], 'friend shoved back');
      assert.deepEqual([L.x, L.y], [6, 7], 'loser in its place');
      return true;
    }
    return undefined;
  });
  assert.ok(seen >= 1);
});
test('pushback: at the board edge the loser slides along it', () => {
  const build = () => createBattle({ seed: 3, terrain, road: noRoad, playerSide: 'red', units: [
    { id: 'rg', side: 'red', type: 'BRIGADIER', brigadeId: 0, x: 0, y: 9 },
    { id: 'L', side: 'red', type: 'INFANTRY', brigadeId: 0, x: 6, y: 9 },
    { id: 'bg', side: 'blue', type: 'BRIGADIER', brigadeId: 0, x: 19, y: 0 },
    { id: 'W', side: 'blue', type: 'INFANTRY', brigadeId: 0, x: 6, y: 8 },
  ]});
  const seen = pushSeen(build, b => {
    if (U(b, 'L').removed || U(b, 'W').removed) return false;
    if (b.events.some(e => e.text === 'Driven along the edge')) {
      for (let t = 0; t < 60; t++) step(b, loose);
      assert.equal(U(b, 'L').y, 9); assert.notEqual(U(b, 'L').x, 6);
      return true;
    }
    return undefined;
  });
  assert.ok(seen >= 1);
});
