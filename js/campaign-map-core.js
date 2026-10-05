/* =========================================================
   CAMPAIGN MAP, PHASE 1: THE RULES (pure)

   A strategic map between battles (in the spirit of Roma Invicta): armies
   march town to town along roads, and every clash is fought on the tactical
   board. This module is the whole of the map's rules and holds no browser
   state at all: the screen (campaign-map-ui.js) and the bridge to the
   tactical board (campaign-map-battle.js) call into it, and the unit tests
   call it directly.

   ONE OBJECT IS THE WHOLE CAMPAIGN. Everything that changes lives in the
   object createCampaign returns, which is plain JSON and carries a version
   number, so a save written now still loads when Phases 2 to 6 add money,
   bread, depots and seasons (they add fields; they do not rename these).
   Everything that does not change (towns, roads, dates, starting forces)
   lives in the map's data file (data/campaign-maps/<id>.json), so the
   Peninsular and Waterloo maps can be added as data.

   SIDES are 'british' and 'french' here, as in the scenario cards. The
   tactical board calls them red and blue; campaign-map-battle.js translates.

   Locked design, Phase 1 parts:
   - Up to 3 armies per side; an army holds 1 to 3 brigades.
   - Movement is one town per turn along a road. Moving into a town held by
     an enemy army is an attack and the battle is fought at once.
   - Units lost in a battle are gone for good. A brigade with no fighting
     units left is broken and removed; an army with no brigades is removed.
   - The loser retreats one town, to a neighbour the enemy does not hold. If
     there is none, the army is destroyed.
   - Victory: destroy every enemy army. If neither side manages it by the
     final turn, the side that destroyed more enemy unit value wins.
========================================================= */

export const CAMPAIGN_VERSION = 1;
export const SIDES_CM = ['british', 'french'];
export const otherSideCM = s => (s === 'british' ? 'french' : 'british');
const ARCHIVE_SIDE = { british: 'red', french: 'blue' };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/* ---------- reading the map data ---------- */
export const townById = (map, id) => map.towns.find(t => t.id === id) || null;
export const townName = (map, id) => (townById(map, id) || { name: id }).name;
export const linked = (map, a, b) => !!(townById(map, a) && townById(map, a).links.includes(b));

/* What each unit type is worth when destroyed: the map's own table, which
   for Flanders is the Real-Time clock-victory points (Guard, cavalry and guns
   worth more than line infantry). The fallback is the same table. */
const RTS_POINT_VALUE = { INFANTRY: 4, GUARD: 5, LIGHT_CAV: 5, HEAVY_CAV: 5, ARTILLERY: 6, BRIGADIER: 0 };
export function unitValues(map){
  const v = map && map.unitValues;
  return (v && v.table) || RTS_POINT_VALUE;
}
export const valueOf = (map, unit) => unitValues(map)[unit.type] || 0;

/* The date of a turn: fortnightly from the map's start date. */
export function dateForTurn(map, turn){
  const [y, m, d] = map.startDate.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + (turn - 1) * (map.daysPerTurn || 14)));
  return `${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]} ${t.getUTCFullYear()}`;
}

/* ---------- creating a campaign ---------- */
/* Ids are prefixed so they can never be mistaken for the battle board's own
   unit ids ('u' + n): cu = campaign unit, cb = brigade, ca = army. */
const PREFIX = { unit: 'cu', brigade: 'cb', army: 'ca', battle: 'battle' };
function nextId(c, kind){ c.nextIds[kind] = (c.nextIds[kind] || 0) + 1; return PREFIX[kind] + c.nextIds[kind]; }

/* A regiment's name, from the same archive the battle board uses, in order,
   wrapping when a side runs out (as newUnit does). */
function nameFor(c, archive, side, type){
  const k = ARCHIVE_SIDE[side];
  c.nameCounters[k] = c.nameCounters[k] || {};
  const i = c.nameCounters[k][type] || 0;
  c.nameCounters[k][type] = i + 1;
  const list = (archive && archive[k] && archive[k][type]) || [];
  return list.length ? list[i % list.length].name : `${type} ${i + 1}`;
}
function makeUnit(c, archive, side, type){
  return { id: nextId(c, 'unit'), name: nameFor(c, archive, side, type), type, xp: 0, status: 'active' };
}
const ORDINAL = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th'];

/* The army a side starts with: its composition from army-compositions.json,
   each brigade led by a Brigadier (as deployment places one first). */
function buildArmy(c, archive, side, spec, composition){
  const army = { id: nextId(c, 'army'), side, name: spec.name, townId: spec.townId, brigades: [], hasMoved: false };
  composition.brigades.forEach((b, i) => {
    const brigade = { id: nextId(c, 'brigade'), name: `${ORDINAL[i] || (i + 1) + 'th'} Brigade`, units: [] };
    brigade.units.push(makeUnit(c, archive, side, 'BRIGADIER'));
    for(const u of b.units) brigade.units.push(makeUnit(c, archive, side, typeof u === 'string' ? u : u.type));
    army.brigades.push(brigade);
  });
  return army;
}

/* compositions: the army-compositions.json list. archive: unit-archive.json. */
export function createCampaign(map, compositions, archive, opts = {}){
  const c = {
    version: CAMPAIGN_VERSION,
    kind: 'campaign-map',
    id: opts.id || ('cm-' + Date.now().toString(36)),
    mapId: map.id,
    createdAt: opts.now || new Date().toISOString(),
    playerSide: map.playerSide || 'british',
    aiSide: map.aiSide || 'french',
    totalTurns: map.totalTurns,
    maxArmies: map.maxArmiesPerSide || 3,
    maxBrigades: map.maxBrigadesPerArmy || 3,
    turn: 1,
    phase: 'british',             // 'british' | 'french' | 'over'
    towns: Object.fromEntries(map.towns.map(t => [t.id, { owner: t.owner || null }])),
    armies: [],
    nextIds: {},
    nameCounters: {},
    destroyedValue: { british: 0, french: 0 },   // enemy unit value each side has destroyed
    unitsLost: { british: 0, french: 0 },
    pendingBattle: null,
    battles: [],
    log: [],
    result: null,
  };
  for(const side of SIDES_CM){
    for(const spec of (map.startingForces[side] || [])){
      const comp = compositions.find(a => a.id === spec.composition);
      if(!comp) throw new Error(`campaign map: no army composition '${spec.composition}'`);
      c.armies.push(buildArmy(c, archive, side, spec, comp));
    }
  }
  logEntry(c, map, null, 'start', `Campaign begins: ${map.name}. ${c.armies.map(a => `${a.name} (${a.side}) at ${townName(map, a.townId)}, ${describeArmy(a)}`).join('; ')}.`);
  return c;
}

/* ---------- looking things up ---------- */
export const armyById = (c, id) => c.armies.find(a => a.id === id) || null;
export const armiesOf = (c, side) => c.armies.filter(a => a.side === side);
export const armiesAt = (c, townId, side) => c.armies.filter(a => a.townId === townId && (!side || a.side === side));
export const fightingUnits = b => b.units.filter(u => u.type !== 'BRIGADIER');
export function describeArmy(a){
  return a.brigades.map(b => `${b.name} [${b.units.map(u => `${u.name} (${u.type})`).join(', ')}]`).join('; ');
}
export const armyStrength = (map, a) => a.brigades.reduce((n, b) => n + b.units.reduce((m, u) => m + valueOf(map, u), 0), 0);

/* ---------- the log ---------- */
export function logEntry(c, map, side, kind, text, data){
  c.log.push(Object.assign({ turn: c.turn, date: dateForTurn(map, c.turn), side, kind, text }, data ? { data } : {}));
}

/* ---------- moving ---------- */
export function validMoves(c, map, army){
  if(!army || c.phase !== army.side || army.hasMoved || c.pendingBattle || c.result) return [];
  return townById(map, army.townId).links.slice();
}

/* Moves an army one town. Returns { kind:'moved' } or { kind:'battle',
   battle } when the town holds an enemy army (the battle is then pending
   until applyBattleResult). Throws on an illegal move. */
export function moveArmy(c, map, armyId, townId){
  const army = armyById(c, armyId);
  if(!validMoves(c, map, army).includes(townId)) throw new Error(`illegal move: ${armyId} to ${townId}`);
  const from = army.townId;
  army.townId = townId;
  army.hasMoved = true;
  const enemies = armiesAt(c, townId, otherSideCM(army.side));
  if(!enemies.length){
    logEntry(c, map, army.side, 'move', `${army.name} marches from ${townName(map, from)} to ${townName(map, townId)}.`, { armyId, from, to: townId });
    return { kind: 'moved' };
  }
  logEntry(c, map, army.side, 'attack', `${army.name} marches from ${townName(map, from)} on ${townName(map, townId)}, held by ${enemies.map(e => e.name).join(' and ')}: battle.`, { armyId, from, to: townId, defenders: enemies.map(e => e.id) });
  c.pendingBattle = makeBattle(c, map, army, from, enemies);
  return { kind: 'battle', battle: c.pendingBattle };
}

/* MAX_BRIGADES_PER_BATTLE. The tactical board is built for up to three
   Brigades a side (deployment rows, the Brigade pips, the break rule). An
   attack is always one army, so at most three; a town can hold several
   defending armies, so the defence fields its first three brigades, army by
   army, and the rest stand by. They share the defenders' fate: if the
   defence loses, they retreat with it. */
export const MAX_BRIGADES_PER_BATTLE = 3;
function makeBattle(c, map, attacker, fromTownId, defenders){
  const pick = armies => {
    const out = [];
    for(const a of armies) for(const b of a.brigades) if(out.length < MAX_BRIGADES_PER_BATTLE) out.push({ armyId: a.id, brigadeId: b.id });
    return out;
  };
  const participants = { [attacker.side]: pick([attacker]), [otherSideCM(attacker.side)]: pick(defenders) };
  const largest = Math.max(participants.british.length, participants.french.length);
  return {
    id: nextId(c, 'battle'),
    turn: c.turn,
    date: dateForTurn(map, c.turn),
    townId: attacker.townId,
    attackerSide: attacker.side,
    attackerArmyId: attacker.id,
    fromTownId,
    defenderArmyIds: defenders.map(d => d.id),
    participants,
    // One brigade on the larger side: the 10 x 10 Operation board; two or three: the full board.
    boardMode: largest <= 1 ? 'single' : 'standard',
  };
}

/* The brigades (with their units) each side fields, in order. */
export function battleBrigades(c, battle, side){
  return battle.participants[side].map(p => {
    const army = armyById(c, p.armyId);
    const brigade = army && army.brigades.find(b => b.id === p.brigadeId);
    return brigade ? { army, brigade } : null;
  }).filter(Boolean);
}

/* ---------- splitting and merging ---------- */
export function canSplit(c, army){
  return !!army && c.phase === army.side && !c.pendingBattle && !c.result &&
    army.brigades.length >= 2 && armiesOf(c, army.side).length < (c.maxArmies || 3);
}
/* Detaches 1 or 2 brigades into a new army in the same town. The new army
   has moved if its parent had: splitting must not buy an extra march. */
export function splitArmy(c, map, armyId, brigadeIds, name){
  const army = armyById(c, armyId);
  if(!canSplit(c, army)) throw new Error('cannot split ' + armyId);
  const ids = [...new Set(brigadeIds)];
  if(ids.length < 1 || ids.length > 2 || ids.length >= army.brigades.length) throw new Error('split must detach 1 or 2 brigades and leave at least one');
  const moving = army.brigades.filter(b => ids.includes(b.id));
  if(moving.length !== ids.length) throw new Error('unknown brigade in split');
  army.brigades = army.brigades.filter(b => !ids.includes(b.id));
  const fresh = { id: nextId(c, 'army'), side: army.side, name: name || nextArmyName(c, army.side), townId: army.townId, brigades: moving, hasMoved: army.hasMoved };
  c.armies.push(fresh);
  logEntry(c, map, army.side, 'split', `${fresh.name} detached from ${army.name} at ${townName(map, army.townId)}: ${describeArmy(fresh)}.`, { from: army.id, to: fresh.id, brigades: ids });
  return fresh;
}
const ARMY_NAMES = { british: ['Army of Flanders', 'Second Column', 'Third Column', 'Fourth Column'], french: ['Armée du Nord', 'Second Division', 'Third Division', 'Fourth Division'] };
function nextArmyName(c, side){
  const used = new Set(armiesOf(c, side).map(a => a.name));
  return ARMY_NAMES[side].find(n => !used.has(n)) || `${side} army ${c.nextIds.army}`;
}
export function canMerge(c, a, b){
  return !!a && !!b && a.id !== b.id && a.side === b.side && a.townId === b.townId && c.phase === a.side &&
    !c.pendingBattle && !c.result && a.brigades.length + b.brigades.length <= (c.maxBrigades || 3);
}
/* Folds army `fromId` into `intoId`. Moved if either had moved. */
export function mergeArmies(c, map, intoId, fromId){
  const into = armyById(c, intoId), from = armyById(c, fromId);
  if(!canMerge(c, into, from)) throw new Error(`cannot merge ${fromId} into ${intoId}`);
  into.brigades.push(...from.brigades);
  into.hasMoved = into.hasMoved || from.hasMoved;
  c.armies = c.armies.filter(a => a.id !== fromId);
  logEntry(c, map, into.side, 'merge', `${from.name} joins ${into.name} at ${townName(map, into.townId)}: now ${describeArmy(into)}.`, { into: intoId, from: fromId });
  return into;
}

/* ---------- turn structure ---------- */
export function endPlayerPhase(c, map){
  if(c.phase !== c.playerSide || c.pendingBattle || c.result) throw new Error('not the player phase');
  logEntry(c, map, c.playerSide, 'endPhase', `${cap(c.playerSide)} phase ends.`);
  c.phase = c.aiSide;
  for(const a of armiesOf(c, c.aiSide)) a.hasMoved = false;
}
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

/* Shortest road path (town ids, start included), or null. */
export function shortestPath(map, from, to){
  const prev = new Map([[from, null]]);
  const queue = [from];
  while(queue.length){
    const t = queue.shift();
    if(t === to){
      const path = [];
      for(let x = to; x != null; x = prev.get(x)) path.unshift(x);
      return path;
    }
    for(const n of townById(map, t).links) if(!prev.has(n)){ prev.set(n, t); queue.push(n); }
  }
  return null;
}

/* THE PLACEHOLDER FRENCH AI (Phase 1 only; the strategic AI is Phase 5).
   Each French army advances one town along the shortest road toward the
   nearest British army, and that is all. Moves the next French army that has
   not moved; returns its outcome, or { kind:'done' } when all have moved. */
export function aiStep(c, map){
  if(c.phase !== c.aiSide || c.pendingBattle || c.result) return { kind: 'done' };
  const army = armiesOf(c, c.aiSide).find(a => !a.hasMoved);
  if(!army) return { kind: 'done' };
  let best = null;
  for(const target of armiesOf(c, c.playerSide)){
    const path = shortestPath(map, army.townId, target.townId);
    if(path && (!best || path.length < best.length)) best = path;
  }
  if(!best || best.length < 2){
    army.hasMoved = true;
    logEntry(c, map, army.side, 'hold', `${army.name} holds at ${townName(map, army.townId)}.`, { armyId: army.id });
    return { kind: 'held', army };
  }
  return Object.assign(moveArmy(c, map, army.id, best[1]), { army });
}

/* Ends the AI phase: either the next turn, or the end of the campaign. */
export function endAiPhase(c, map){
  if(c.phase !== c.aiSide || c.pendingBattle || c.result) throw new Error('not the AI phase');
  logEntry(c, map, c.aiSide, 'endPhase', `${cap(c.aiSide)} phase ends.`);
  if(c.turn >= c.totalTurns){ finalReckoning(c, map); return; }
  c.turn += 1;
  c.phase = c.playerSide;
  for(const a of armiesOf(c, c.playerSide)) a.hasMoved = false;
  logEntry(c, map, null, 'turn', `Turn ${c.turn} of ${c.totalTurns}: ${dateForTurn(map, c.turn)}.`);
}

/* ---------- after a battle ---------- */
/* result: { winner: 'british'|'french', lost: [unit ids destroyed on the
   board], matchUid?, notes? }. Removes the dead for good, breaks brigades,
   drops empty armies, retreats the loser, tallies value and checks victory.
   Returns a summary for the screen. */
export function applyBattleResult(c, map, result){
  const battle = c.pendingBattle;
  if(!battle) throw new Error('no battle pending');
  const winner = result.winner, loser = otherSideCM(winner);
  const lost = new Set(result.lost || []);
  const summary = { battleId: battle.id, townId: battle.townId, winner, lostUnits: { british: [], french: [] }, brokenBrigades: { british: [], french: [] }, removedArmies: [], retreat: null, destroyedArmies: [] };

  for(const army of c.armies){
    for(const b of army.brigades){
      const dead = b.units.filter(u => lost.has(u.id));
      for(const u of dead){
        u.status = 'destroyed';
        summary.lostUnits[army.side].push({ id: u.id, name: u.name, type: u.type, brigade: b.name, army: army.name });
        c.destroyedValue[otherSideCM(army.side)] += valueOf(map, u);
        c.unitsLost[army.side] += 1;
      }
      b.units = b.units.filter(u => !lost.has(u.id));
      if(fightingUnits(b).length === 0) summary.brokenBrigades[army.side].push({ id: b.id, name: b.name, army: army.name });
    }
    army.brigades = army.brigades.filter(b => fightingUnits(b).length > 0);
  }
  for(const a of c.armies.filter(x => x.brigades.length === 0)) summary.removedArmies.push({ id: a.id, name: a.name, side: a.side });
  c.armies = c.armies.filter(a => a.brigades.length > 0);

  // The loser's armies in the town (fielded or standing by) fall back together.
  const losers = armiesAt(c, battle.townId, loser);
  if(losers.length){
    const to = retreatTown(c, map, battle, loser);
    if(to){
      for(const a of losers){ a.townId = to; a.hasMoved = true; }
      summary.retreat = { side: loser, to, armies: losers.map(a => a.name) };
    } else {
      for(const a of losers){
        for(const b of a.brigades) for(const u of b.units){ u.status = 'destroyed'; c.destroyedValue[winner] += valueOf(map, u); c.unitsLost[loser] += 1; summary.lostUnits[loser].push({ id: u.id, name: u.name, type: u.type, brigade: b.name, army: a.name, cornered: true }); }
        summary.destroyedArmies.push({ id: a.id, name: a.name, side: loser });
      }
      c.armies = c.armies.filter(a => !losers.includes(a));
    }
  }

  const record = Object.assign({}, battle, { winner, matchUid: result.matchUid || null, summary, foughtAt: new Date().toISOString() });
  c.battles.push(record);
  c.pendingBattle = null;
  logEntry(c, map, winner, 'battle', battleText(map, record), { battle: record });
  checkVictory(c, map);
  return summary;
}

/* Where a beaten army goes: a neighbouring town with no enemy army in it.
   A beaten attacker goes back the way it came if it can; otherwise the
   loser's own towns first, then any other free neighbour. Null if there is
   nowhere to go. */
export function retreatTown(c, map, battle, side){
  const free = townById(map, battle.townId).links.filter(t => armiesAt(c, t, otherSideCM(side)).length === 0);
  if(!free.length) return null;
  if(battle.attackerSide === side && free.includes(battle.fromTownId)) return battle.fromTownId;
  const own = free.filter(t => c.towns[t] && c.towns[t].owner === side);
  return (own[0] || free[0]);
}

function battleText(map, b){
  const s = b.summary;
  const side = k => {
    const lostList = s.lostUnits[k];
    return `${cap(k)} lost ${lostList.length} unit${lostList.length === 1 ? '' : 's'}` +
      (lostList.length ? ` (${lostList.map(u => `${u.name}, ${u.type}, ${u.brigade} of ${u.army}${u.cornered ? ', cornered' : ''}`).join('; ')})` : '') +
      (s.brokenBrigades[k].length ? `; brigades broken: ${s.brokenBrigades[k].map(x => `${x.name} of ${x.army}`).join(', ')}` : '');
  };
  return `Battle of ${townName(map, b.townId)} (${b.boardMode === 'single' ? '10 x 10 board' : 'full board'}): ${cap(b.attackerSide)} attacked, ${cap(b.winner)} won. ` +
    `${side('british')}. ${side('french')}.` +
    (s.removedArmies.length ? ` Armies destroyed in the fight: ${s.removedArmies.map(a => a.name).join(', ')}.` : '') +
    (s.retreat ? ` ${s.retreat.armies.join(' and ')} retreat${s.retreat.armies.length === 1 ? 's' : ''} to ${townName(map, s.retreat.to)}.` : '') +
    (s.destroyedArmies.length ? ` ${s.destroyedArmies.map(a => a.name).join(' and ')}, cornered with nowhere to retreat, ${s.destroyedArmies.length === 1 ? 'is' : 'are'} destroyed.` : '');
}

/* ---------- victory ---------- */
export function checkVictory(c, map){
  if(c.result) return c.result;
  const left = s => armiesOf(c, s).length;
  if(left('french') === 0 && left('british') === 0) c.result = { winner: 'draw', reason: 'Both armies destroyed', turn: c.turn };
  else if(left('french') === 0) c.result = { winner: 'british', reason: 'Every French field army destroyed', turn: c.turn };
  else if(left('british') === 0) c.result = { winner: 'french', reason: 'Every British field army destroyed', turn: c.turn };
  if(c.result){
    c.phase = 'over';
    logEntry(c, map, null, 'end', `Campaign over: ${c.result.winner === 'draw' ? 'a draw' : cap(c.result.winner) + ' victory'} (${c.result.reason}).`);
  }
  return c.result;
}
/* The final turn has been played: whoever destroyed more enemy unit value wins. */
export function finalReckoning(c, map){
  const b = c.destroyedValue.british, f = c.destroyedValue.french;
  const winner = b > f ? 'british' : f > b ? 'french' : 'draw';
  c.result = { winner, reason: `Final turn reached. Enemy value destroyed: British ${b}, French ${f}`, turn: c.turn };
  c.phase = 'over';
  logEntry(c, map, null, 'end', `Campaign over at the final turn: ${winner === 'draw' ? 'a draw' : cap(winner) + ' victory'}. ${c.result.reason}.`);
  return c.result;
}

/* ---------- saving ---------- */
export const serialiseCampaign = c => JSON.stringify(c);
/* A save from this version or an older one that later code knows how to
   upgrade; null for anything unreadable or from the future. */
export function restoreCampaign(text){
  try {
    const c = JSON.parse(text);
    if(!c || c.kind !== 'campaign-map' || typeof c.version !== 'number' || c.version > CAMPAIGN_VERSION) return null;
    return c;
  } catch { return null; }
}

/* ---------- the campaign log export ---------- */
export function campaignLogText(c, map){
  const out = [];
  out.push(`GROGNARDS CAMPAIGN MAP LOG`);
  out.push(`Campaign ${c.id} on ${map.name} (map ${c.mapId}), save version ${c.version}`);
  out.push(`Started ${c.createdAt}. Player ${c.playerSide}, AI ${c.aiSide}. Turn ${c.turn} of ${c.totalTurns} (${dateForTurn(map, c.turn)}), phase ${c.phase}.`);
  out.push(`Enemy value destroyed: British ${c.destroyedValue.british}, French ${c.destroyedValue.french}. Units lost: British ${c.unitsLost.british}, French ${c.unitsLost.french}.`);
  if(c.result) out.push(`RESULT: ${c.result.winner === 'draw' ? 'Draw' : cap(c.result.winner) + ' victory'}, ${c.result.reason} (turn ${c.result.turn}).`);
  out.push('');
  let turn = null;
  for(const e of c.log){
    if(e.turn !== turn){ turn = e.turn; out.push(`== Turn ${e.turn}, ${e.date} ==`); }
    out.push(`  [${e.kind}${e.side ? ' ' + e.side : ''}] ${e.text}`);
    if(e.kind === 'battle' && e.data && e.data.battle){
      const b = e.data.battle;
      out.push(`      battle id ${b.id}, match ${b.matchUid || '(no record)'}, board ${b.boardMode}, attacker ${b.attackerSide} from ${townName(map, b.fromTownId)}`);
      for(const s of SIDES_CM) out.push(`      ${s} fielded: ${b.participants[s].map(p => p.brigadeId + ' of ' + p.armyId).join(', ')}`);
    }
  }
  out.push('');
  out.push('== Armies now ==');
  for(const a of c.armies) out.push(`  ${a.side} ${a.name} (${a.id}) at ${townName(map, a.townId)}${a.hasMoved ? ', moved' : ''}: ${describeArmy(a)}`);
  return out.join('\n');
}
