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

/* 1: Phase 1. 2: Phase 2 (withdrawal and pursuit): armies gain restTurn,
   a pending battle gains a stage. 3: gold (the economy). restoreCampaign
   upgrades older saves. */
export const CAMPAIGN_VERSION = 3;
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

/* PHASE 2 SETTINGS, from the map's "withdrawal" block (config values):
   aiWithdrawRatio  the French withdraw (and pursue on foot) when the other
                    side's unit value is more than this many times theirs
   pursuitInfantryDicePenalty  dice a pursuit without cavalry attacks short
   rearguardTurns   rounds a rearguard must survive */
export function withdrawalRules(map){
  const w = (map && map.withdrawal) || {};
  return {
    aiWithdrawRatio: w.aiWithdrawRatio ?? 1.5,
    pursuitInfantryDicePenalty: w.pursuitInfantryDicePenalty ?? 1,
    rearguardTurns: w.rearguardTurns ?? 8,
  };
}

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
  const army = { id: nextId(c, 'army'), side, name: spec.name, townId: spec.townId, brigades: [], hasMoved: false, restTurn: null };
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
    gold: Object.assign({ british: 0, french: 0 }, economyRules(map).startGold),
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
export const armyStrength = (map, a) => a.brigades.reduce((n, b) => n + brigadeValue(map, b), 0);
export const brigadeValue = (map, b) => b.units.reduce((m, u) => m + valueOf(map, u), 0);
const CAVALRY = new Set(['LIGHT_CAV', 'HEAVY_CAV']);
export const hasCavalry = b => b.units.some(u => CAVALRY.has(u.type));
/* An army resting after a withdrawal cannot move this turn (Phase 2's
   placeholder cost; bread and money replace it in Phases 3 and 4). */
export const isResting = (c, a) => a.restTurn != null && a.restTurn === c.turn && c.phase === a.side;
/* The "cannot move" marker shows while restTurn is set: from the withdrawal
   until the end of the phase it stood still in (cleared by endRests). */
export const restPending = a => a.restTurn != null;
function endRests(c, side){ for(const a of armiesOf(c, side)) if(a.restTurn != null && a.restTurn <= c.turn) a.restTurn = null; }

/* ---------- the log ---------- */
export function logEntry(c, map, side, kind, text, data){
  c.log.push(Object.assign({ turn: c.turn, date: dateForTurn(map, c.turn), side, kind, text }, data ? { data } : {}));
}

/* ---------- moving ---------- */
export function validMoves(c, map, army){
  if(!army || c.phase !== army.side || army.hasMoved || c.pendingBattle || c.result) return [];
  if(isResting(c, army)) return [];
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
    updateOwnership(c, map);
    return { kind: 'moved' };
  }
  c.pendingBattle = makeBattle(c, map, army, from, enemies);
  const b = c.pendingBattle;
  logEntry(c, map, army.side, 'attack', `${army.name} marches from ${townName(map, from)} on ${townName(map, townId)}, held by ${enemies.map(e => e.name).join(' and ')}.` +
    (b.cornered ? ` ${enemies.map(e => e.name).join(' and ')} ${enemies.length === 1 ? 'is' : 'are'} cornered, with no line of retreat: battle.` : ' The defence may fight or withdraw.'),
    { armyId, from, to: townId, defenders: enemies.map(e => e.id), cornered: b.cornered });
  return { kind: 'battle', battle: b };
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
  const b = {
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
    /* PHASE 2. 'decide': the defence chooses to fight or withdraw. 'battle':
       it fights (or is cornered). 'pursuit': it withdrew and the attacker
       chooses whether to chase. 'rearguard': a pursuit is on. */
    kind: 'battle',
    stage: 'decide',
    cornered: false,
  };
  const options = withdrawOptions(c, map, b, otherSideCM(attacker.side));
  if(!options.length){ b.stage = 'battle'; b.cornered = true; }
  return b;
}

/* The brigades (with their units) each side fields, in order. */
export function battleBrigades(c, battle, side){
  return battle.participants[side].map(p => {
    const army = armyById(c, p.armyId);
    const brigade = army && army.brigades.find(b => b.id === p.brigadeId);
    return brigade ? { army, brigade } : null;
  }).filter(Boolean);
}

/* ---------- PHASE 2: WITHDRAWAL AND PURSUIT ----------

   An attacked army may refuse battle. The sequence, all held on
   c.pendingBattle so a save mid-way resumes at the same choice:
     decide     the defence fights (-> 'battle') or withdraws, if any
                neighbouring town is free of enemy armies. With none it is
                cornered and goes straight to battle.
     pursuit    it withdrew. The attacker chases with ONE brigade or lets it
                go. Cavalry brigades must be chosen if there are any; with
                none, a foot brigade may chase at a dice penalty.
     rearguard  the withdrawing army's weakest brigade turns to cover the
                retreat on a 10 x 10 board: it wins by lasting the set number
                of rounds, the pursuer by breaking it.
   A withdrawn army cannot move on its next turn (the placeholder cost until
   bread and money arrive in Phases 3 and 4). The attacker holds the town. */

/* Towns the defence could fall back to: road neighbours free of enemy armies. */
export function withdrawOptions(c, map, battle, defenderSide){
  return townById(map, battle.townId).links.filter(t => armiesAt(c, t, otherSideCM(defenderSide)).length === 0);
}
export const defenderSideOf = battle => otherSideCM(battle.attackerSide);
const defendingArmies = (c, battle) => battle.defenderArmyIds.map(id => armyById(c, id)).filter(Boolean);
export const totalValue = (map, armies) => armies.reduce((n, a) => n + armyStrength(map, a), 0);

export function chooseFight(c, map){
  const b = c.pendingBattle;
  if(!b || b.stage !== 'decide') throw new Error('no fight-or-withdraw choice pending');
  b.stage = 'battle';
  logEntry(c, map, defenderSideOf(b), 'stand', `${defendingArmies(c, b).map(a => a.name).join(' and ')} stand${b.defenderArmyIds.length === 1 ? 's' : ''} and fight at ${townName(map, b.townId)}.`);
}

/* The rearguard: the withdrawing armies' weakest brigade, by total unit
   value, the one with fewer units on a tie. */
export function weakestBrigade(map, armies){
  let best = null;
  for(const a of armies) for(const br of a.brigades){
    const v = brigadeValue(map, br), n = br.units.length;
    if(!best || v < best.v || (v === best.v && n < best.n)) best = { army: a, brigade: br, v, n };
  }
  return best;
}

/* The defence withdraws to `toTownId`. Every defending army in the town goes,
   and each rests on its next turn. */
export function chooseWithdraw(c, map, toTownId){
  const b = c.pendingBattle;
  if(!b || b.stage !== 'decide') throw new Error('no fight-or-withdraw choice pending');
  const side = defenderSideOf(b);
  if(!withdrawOptions(c, map, b, side).includes(toTownId)) throw new Error('cannot withdraw to ' + toTownId);
  const armies = defendingArmies(c, b);
  // Its next own phase: later this turn if it moves second, otherwise next turn.
  const restTurn = side === c.playerSide ? c.turn + 1 : c.turn;
  for(const a of armies){ a.townId = toTownId; a.restTurn = restTurn; }
  updateOwnership(c, map);
  const rg = weakestBrigade(map, armies);
  b.stage = 'pursuit';
  b.withdrawal = { side, to: toTownId, armyIds: armies.map(a => a.id), rearguard: rg ? { armyId: rg.army.id, brigadeId: rg.brigade.id } : null, restTurn };
  logEntry(c, map, side, 'withdraw', `${armies.map(a => a.name).join(' and ')} refuse${armies.length === 1 ? 's' : ''} battle and withdraw${armies.length === 1 ? 's' : ''} from ${townName(map, b.townId)} to ${townName(map, toTownId)}; ${armies.length === 1 ? 'it' : 'they'} cannot march on turn ${restTurn}. ${armyById(c, b.attackerArmyId).name} holds ${townName(map, b.townId)}.` +
    (rg ? ` If pursued, ${rg.brigade.name} of ${rg.army.name} forms the rearguard.` : ''), { to: toTownId, armies: armies.map(a => a.id) });
  return b.withdrawal;
}

/* Which brigades may pursue: the cavalry brigades if there are any (one of
   them must go), otherwise any brigade, on foot, at the dice penalty. */
export function pursuitChoices(c, map){
  const b = c.pendingBattle;
  const army = b && armyById(c, b.attackerArmyId);
  if(!army) return { brigades: [], onFoot: false };
  const cav = army.brigades.filter(hasCavalry);
  return cav.length ? { brigades: cav, onFoot: false } : { brigades: army.brigades.slice(), onFoot: true };
}

export function choosePursue(c, map, brigadeId){
  const b = c.pendingBattle;
  if(!b || b.stage !== 'pursuit') throw new Error('no pursuit choice pending');
  const choice = pursuitChoices(c, map);
  const br = choice.brigades.find(x => x.id === brigadeId);
  if(!br) throw new Error('that brigade may not pursue: ' + brigadeId);
  if(!b.withdrawal.rearguard){ chooseLetGo(c, map); return null; }
  const rules = withdrawalRules(map);
  b.stage = 'rearguard';
  b.kind = 'rearguard';
  b.boardMode = 'single';
  b.pursuit = { side: b.attackerSide, armyId: b.attackerArmyId, brigadeId, onFoot: choice.onFoot, dicePenalty: choice.onFoot ? rules.pursuitInfantryDicePenalty : 0 };
  b.rearguardTurns = rules.rearguardTurns;
  b.participants = { [b.attackerSide]: [{ armyId: b.attackerArmyId, brigadeId }], [b.withdrawal.side]: [{ armyId: b.withdrawal.rearguard.armyId, brigadeId: b.withdrawal.rearguard.brigadeId }] };
  const rgArmy = armyById(c, b.withdrawal.rearguard.armyId);
  const rgBrig = rgArmy.brigades.find(x => x.id === b.withdrawal.rearguard.brigadeId);
  logEntry(c, map, b.attackerSide, 'pursue', `${br.name} of ${armyById(c, b.attackerArmyId).name} pursues${choice.onFoot ? ' on foot (no cavalry: attacking at ' + b.pursuit.dicePenalty + ' die fewer)' : ''}. ${rgBrig.name} of ${rgArmy.name} turns to cover the retreat to ${townName(map, b.withdrawal.to)}: it must hold for ${rules.rearguardTurns} rounds.`);
  return b.pursuit;
}

export function chooseLetGo(c, map){
  const b = c.pendingBattle;
  if(!b || b.stage !== 'pursuit') throw new Error('no pursuit choice pending');
  logEntry(c, map, b.attackerSide, 'noPursuit', `${armyById(c, b.attackerArmyId).name} lets the ${cap(b.withdrawal.side)} go.`);
  c.pendingBattle = null;
}

/* THE FRENCH AI'S CHOICES (Phase 2). Ratios use the same unit values as the
   campaign's scoring (the Real-Time clock-victory points).
   - Defending: withdraw when the attacker's value exceeds theirs by the
     configured ratio and a road is open; retreat to the free neighbour
     furthest from every other British army.
   - Attacking a withdrawn army: always pursue with cavalry if a brigade has
     any (the strongest such brigade); with none, pursue on foot only when
     its army's value exceeds the withdrawing armies' by the same ratio. */
export function aiShouldWithdraw(c, map, b){
  const side = defenderSideOf(b);
  if(!withdrawOptions(c, map, b, side).length) return false;
  const att = armyStrength(map, armyById(c, b.attackerArmyId));
  const def = totalValue(map, defendingArmies(c, b));
  return att > def * withdrawalRules(map).aiWithdrawRatio;
}
export function aiRetreatTown(c, map, b){
  const side = defenderSideOf(b);
  const enemies = armiesOf(c, otherSideCM(side));
  const score = t => {
    const ds = enemies.filter(e => e.id !== b.attackerArmyId).map(e => (shortestPath(map, t, e.townId) || []).length - 1).filter(d => d >= 0);
    return ds.length ? Math.min(...ds) : 99;
  };
  const opts = withdrawOptions(c, map, b, side);
  return opts.reduce((best, t) => (score(t) > score(best) ? t : best), opts[0]);
}
export function aiPursuit(c, map){
  const b = c.pendingBattle;
  const choice = pursuitChoices(c, map);
  if(!choice.brigades.length || !b.withdrawal.rearguard) return null;
  const strongest = choice.brigades.reduce((x, y) => (brigadeValue(map, y) > brigadeValue(map, x) ? y : x));
  if(!choice.onFoot) return strongest.id;
  const att = armyStrength(map, armyById(c, b.attackerArmyId));
  const def = totalValue(map, b.withdrawal.armyIds.map(id => armyById(c, id)).filter(Boolean));
  return att > def * withdrawalRules(map).aiWithdrawRatio ? strongest.id : null;
}
/* Makes whatever choices are the AI's to make, until one is the player's or
   there is nothing left to choose. Returns the pending engagement or null. */
export function resolveAiChoices(c, map){
  for(let guard = 0; guard < 4; guard++){
    const b = c.pendingBattle;
    if(!b) return null;
    if(b.stage === 'decide' && defenderSideOf(b) === c.aiSide){
      if(aiShouldWithdraw(c, map, b)) chooseWithdraw(c, map, aiRetreatTown(c, map, b)); else chooseFight(c, map);
      continue;
    }
    if(b.stage === 'pursuit' && b.attackerSide === c.aiSide){
      const pick = aiPursuit(c, map);
      if(pick) choosePursue(c, map, pick); else chooseLetGo(c, map);
      continue;
    }
    return b;
  }
  return c.pendingBattle;
}

/* After the rearguard action. result: { winner, lost, matchUid? }. The dead
   go for good; the rearguard's survivors are already with their army in the
   retreat town, the pursuers with theirs in the town they took. Nobody
   retreats further: the withdrawal has already happened. */
export function applyRearguardResult(c, map, result){
  const b = c.pendingBattle;
  if(!b || b.stage !== 'rearguard') throw new Error('no rearguard action pending');
  const lost = new Set(result.lost || []);
  const summary = { battleId: b.id, townId: b.townId, winner: result.winner, rearguard: true, lostUnits: { british: [], french: [] }, brokenBrigades: { british: [], french: [] }, removedArmies: [], retreat: null, destroyedArmies: [] };
  removeLosses(c, map, lost, summary);
  updateOwnership(c, map);
  const record = Object.assign({}, b, { winner: result.winner, matchUid: result.matchUid || null, summary, foughtAt: new Date().toISOString() });
  c.battles.push(record);
  c.pendingBattle = null;
  const rgSide = b.withdrawal.side;
  const lostText = k => summary.lostUnits[k].length ? summary.lostUnits[k].map(u => `${u.name} (${u.type}, ${u.brigade} of ${u.army})`).join('; ') : 'none';
  logEntry(c, map, result.winner, 'rearguard',
    `Rearguard action at ${townName(map, b.townId)} (10 x 10 board): ${result.winner === rgSide ? `the ${cap(rgSide)} rearguard held and covered the retreat to ${townName(map, b.withdrawal.to)}` : `the ${cap(b.attackerSide)} pursuit broke the rearguard`}. ` +
    `British lost: ${lostText('british')}. French lost: ${lostText('french')}.` +
    (summary.removedArmies.length ? ` Destroyed: ${summary.removedArmies.map(a => a.name).join(', ')}.` : ''), { battle: record });
  checkVictory(c, map);
  return summary;
}

/* ---------- THE ECONOMY (kept deliberately light) ----------

   Gold is the only resource. No bread, depots to stock, attrition, foraging
   or hostility: a war of manoeuvre with one purse.
   - INCOME: every town a side holds pays its "income" each turn, and Britain
     also draws a fixed subsidy. Marching into a town nobody is defending
     takes it, so income follows the map.
   - UPKEEP: every fighting unit costs a little each turn (Brigadiers are
     free). A big army drains the purse, which is what slows recruiting as
     money runs low; there is no hard cut-off, and gold never goes below 0
     (an army is never disbanded for want of pay).
   - RECRUITING happens only at a side's home depot (Ostend, Lille), during
     its own phase, and the units join at once: top up a brigade that has
     lost units, or raise a new brigade (a Brigadier and two infantry).
   Paid at the start of each side's own phase. All the numbers are in the
   map file's "economy" block. */
export function economyRules(map){
  const e = (map && map.economy) || {};
  return {
    startGold: e.startGold || { british: 20, french: 20 },
    subsidy: e.subsidy || { british: 4, french: 0 },
    upkeepPerUnit: e.upkeepPerUnit ?? 1,
    unitCost: e.unitCost || { INFANTRY: 8, GUARD: 12, LIGHT_CAV: 10, HEAVY_CAV: 12, ARTILLERY: 12 },
    newBrigadeCost: e.newBrigadeCost ?? 20,
    maxFightingUnitsPerBrigade: e.maxFightingUnitsPerBrigade ?? 5,
  };
}
export const townsHeldBy = (c, side) => Object.keys(c.towns).filter(id => c.towns[id].owner === side);
export function incomeOf(c, map, side){
  const towns = townsHeldBy(c, side).reduce((n, id) => n + ((townById(map, id) || {}).income || 0), 0);
  const subsidy = economyRules(map).subsidy[side] || 0;
  const upkeep = armiesOf(c, side).reduce((n, a) => n + a.brigades.reduce((m, b) => m + fightingUnits(b).length, 0), 0) * economyRules(map).upkeepPerUnit;
  return { towns, subsidy, upkeep, net: towns + subsidy - upkeep };
}
/* Pays a side its income and takes its upkeep, at the start of its phase. */
export function collectIncome(c, map, side){
  const inc = incomeOf(c, map, side);
  const before = c.gold[side];
  c.gold[side] = Math.max(0, before + inc.net);
  logEntry(c, map, side, 'income', `${cap(side)} treasury: ${townsHeldBy(c, side).length} towns pay ${inc.towns}${inc.subsidy ? ` and the subsidy ${inc.subsidy}` : ''}, upkeep ${inc.upkeep}; gold ${before} to ${c.gold[side]}.`, inc);
  return inc;
}

/* A town changes hands when one side's armies stand in it and the other's
   do not. Called after every move, withdrawal and battle. */
export function updateOwnership(c, map){
  for(const t of map.towns){
    const here = new Set(armiesAt(c, t.id).map(a => a.side));
    if(here.size !== 1) continue;
    const side = [...here][0];
    if(c.towns[t.id] && c.towns[t.id].owner !== side){
      const was = c.towns[t.id].owner;
      c.towns[t.id].owner = side;
      logEntry(c, map, side, 'capture', `${cap(side)} take${was ? ` ${t.name} from the ${cap(was)}` : ` ${t.name}`} (it paid ${t.income || 0} a turn).`, { townId: t.id, from: was });
    }
  }
}

/* Recruiting: only at the side's own home depot, in its own phase. */
export const homeDepot = (map, side) => map.towns.find(t => t.isDepot && t.depotSide === side) || null;
export function canRecruitAt(c, map, side, townId){
  const d = homeDepot(map, side);
  // Only while the side still holds its depot: an occupied depot recruits nobody.
  return !!d && d.id === townId && c.towns[d.id] && c.towns[d.id].owner === side && c.phase === side && !c.pendingBattle && !c.result;
}
/* Adds one unit to a brigade of an army standing at its depot. */
export function recruitUnit(c, map, archive, armyId, brigadeId, type){
  const army = armyById(c, armyId);
  if(!army || !canRecruitAt(c, map, army.side, army.townId)) throw new Error('recruiting only at your home depot, in your own phase');
  const rules = economyRules(map);
  const cost = rules.unitCost[type];
  if(!cost) throw new Error('cannot recruit ' + type);
  const b = army.brigades.find(x => x.id === brigadeId);
  if(!b) throw new Error('no such brigade');
  if(fightingUnits(b).length >= rules.maxFightingUnitsPerBrigade) throw new Error(`${b.name} is at full strength`);
  if(c.gold[army.side] < cost) throw new Error(`not enough gold (${cost} needed)`);
  c.gold[army.side] -= cost;
  const u = makeUnit(c, archive, army.side, type);
  b.units.push(u);
  logEntry(c, map, army.side, 'recruit', `${u.name} (${type}) joins ${b.name} of ${army.name} at ${townName(map, army.townId)} for ${cost} gold; ${c.gold[army.side]} left.`, { armyId, brigadeId, unitId: u.id, cost });
  return u;
}
/* Raises a new brigade (a Brigadier and two infantry) at the depot: into an
   army there with room for it, else as a new army if the side has fewer
   than three. */
export function raiseBrigade(c, map, archive, side){
  const d = homeDepot(map, side);
  if(!d || !canRecruitAt(c, map, side, d.id)) throw new Error('recruiting only at your home depot, in your own phase');
  const rules = economyRules(map);
  if(c.gold[side] < rules.newBrigadeCost) throw new Error(`not enough gold (${rules.newBrigadeCost} needed)`);
  let army = armiesAt(c, d.id, side).find(a => a.brigades.length < (c.maxBrigades || 3));
  if(!army && armiesOf(c, side).length >= (c.maxArmies || 3)) throw new Error('no army at the depot with room, and three armies already in the field');
  if(!army){
    army = { id: nextId(c, 'army'), side, name: nextArmyName(c, side), townId: d.id, brigades: [], hasMoved: false, restTurn: null };
    c.armies.push(army);
  }
  c.gold[side] -= rules.newBrigadeCost;
  const used = new Set(c.armies.filter(a => a.side === side).flatMap(a => a.brigades.map(b => b.name)));
  const name = ORDINAL.map(o => `${o} Brigade`).find(n => !used.has(n)) || `Brigade ${c.nextIds.brigade + 1}`;
  const brigade = { id: nextId(c, 'brigade'), name, units: ['BRIGADIER', 'INFANTRY', 'INFANTRY'].map(t => makeUnit(c, archive, side, t)) };
  army.brigades.push(brigade);
  logEntry(c, map, side, 'recruit', `${brigade.name} raised at ${d.name} for ${rules.newBrigadeCost} gold and joins ${army.name}: ${brigade.units.map(u => `${u.name} (${u.type})`).join(', ')}; ${c.gold[side]} left.`, { armyId: army.id, brigadeId: brigade.id, cost: rules.newBrigadeCost });
  return { army, brigade };
}
/* The placeholder's spending (the control; the game uses strategicAiRecruit
   in campaign-map-ai.js): raise
   a brigade at Lille whenever it can afford one, then top up brigades of any
   army standing there with infantry, keeping nothing back. */
export function aiRecruit(c, map, archive){
  const side = c.aiSide, rules = economyRules(map), d = homeDepot(map, side);
  if(!d) return;
  for(let guard = 0; guard < 10; guard++){
    try { if(c.gold[side] >= rules.newBrigadeCost){ raiseBrigade(c, map, archive, side); continue; } } catch { /* no room: fall through to topping up */ }
    const b = armiesAt(c, d.id, side).flatMap(a => a.brigades.map(br => ({ a, br }))).find(x => fightingUnits(x.br).length < rules.maxFightingUnitsPerBrigade);
    if(!b || c.gold[side] < rules.unitCost.INFANTRY) return;
    recruitUnit(c, map, archive, b.a.id, b.br.id, 'INFANTRY');
  }
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
  const fresh = { id: nextId(c, 'army'), side: army.side, name: name || nextArmyName(c, army.side), townId: army.townId, brigades: moving, hasMoved: army.hasMoved, restTurn: army.restTurn ?? null };
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
  if(from.restTurn != null) into.restTurn = Math.max(into.restTurn ?? -1, from.restTurn);
  c.armies = c.armies.filter(a => a.id !== fromId);
  logEntry(c, map, into.side, 'merge', `${from.name} joins ${into.name} at ${townName(map, into.townId)}: now ${describeArmy(into)}.`, { into: intoId, from: fromId });
  return into;
}

/* ---------- turn structure ---------- */
export function endPlayerPhase(c, map){
  if(c.phase !== c.playerSide || c.pendingBattle || c.result) throw new Error('not the player phase');
  logEntry(c, map, c.playerSide, 'endPhase', `${cap(c.playerSide)} phase ends.`);
  endRests(c, c.playerSide);
  c.phase = c.aiSide;
  for(const a of armiesOf(c, c.aiSide)) a.hasMoved = false;
  collectIncome(c, map, c.aiSide);
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

/* THE PLACEHOLDER FRENCH AI (Phase 1). The game now plays the strategic AI
   (campaign-map-ai.js); this stays as the control it is measured against
   (tools/sim/campaign-ai-check.mjs) and for the tests. Each French army
   advances one town along the shortest road toward the nearest British
   army, and that is all. Moves the next French army that has
   not moved; returns its outcome, or { kind:'done' } when all have moved. */
export function aiStep(c, map){
  if(c.phase !== c.aiSide || c.pendingBattle || c.result) return { kind: 'done' };
  const army = armiesOf(c, c.aiSide).find(a => !a.hasMoved);
  if(!army) return { kind: 'done' };
  if(isResting(c, army)){
    army.hasMoved = true;
    logEntry(c, map, army.side, 'rest', `${army.name} rests at ${townName(map, army.townId)} after its withdrawal and cannot march.`, { armyId: army.id });
    return { kind: 'held', army };
  }
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
  endRests(c, c.aiSide);
  if(c.turn >= c.totalTurns){ finalReckoning(c, map); return; }
  c.turn += 1;
  c.phase = c.playerSide;
  for(const a of armiesOf(c, c.playerSide)) a.hasMoved = false;
  logEntry(c, map, null, 'turn', `Turn ${c.turn} of ${c.totalTurns}: ${dateForTurn(map, c.turn)}.`);
  collectIncome(c, map, c.playerSide);
}

/* ---------- after a battle ---------- */
/* result: { winner: 'british'|'french', lost: [unit ids destroyed on the
   board], matchUid?, notes? }. Removes the dead for good, breaks brigades,
   drops empty armies, retreats the loser, tallies value and checks victory.
   Returns a summary for the screen. */
export function applyBattleResult(c, map, result){
  const battle = c.pendingBattle;
  if(!battle) throw new Error('no battle pending');
  if(battle.stage !== 'battle' && battle.stage !== 'decide') throw new Error('the pending engagement is not a battle (stage ' + battle.stage + ')');
  const winner = result.winner, loser = otherSideCM(winner);
  const lost = new Set(result.lost || []);
  const summary = { battleId: battle.id, townId: battle.townId, winner, lostUnits: { british: [], french: [] }, brokenBrigades: { british: [], french: [] }, removedArmies: [], retreat: null, destroyedArmies: [] };
  removeLosses(c, map, lost, summary);

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

  updateOwnership(c, map);
  const record = Object.assign({}, battle, { winner, matchUid: result.matchUid || null, summary, foughtAt: new Date().toISOString() });
  c.battles.push(record);
  c.pendingBattle = null;
  logEntry(c, map, winner, 'battle', battleText(map, record), { battle: record });
  checkVictory(c, map);
  return summary;
}

/* The dead go for good: each lost unit is removed (its value counted to the
   side that destroyed it), a brigade with no fighting units left is broken
   and removed, and an army with no brigades is removed. Shared by battles and
   rearguard actions. */
function removeLosses(c, map, lost, summary){
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
    return upgradeCampaign(c);
  } catch { return null; }
}

/* Brings an older save up to this version, filling new fields with their
   defaults. Version 1 (Phase 1) had no withdrawals: no army is resting, and a
   battle already pending was a straight fight (it was offered no choice), so
   it stays one. */
export function upgradeCampaign(c){
  if(c.version < 2){
    for(const a of c.armies) if(a.restTurn === undefined) a.restTurn = null;
    if(c.pendingBattle){
      c.pendingBattle.kind = c.pendingBattle.kind || 'battle';
      c.pendingBattle.stage = c.pendingBattle.stage || 'battle';
      c.pendingBattle.cornered = !!c.pendingBattle.cornered;
    }
    for(const b of c.battles) b.kind = b.kind || 'battle';
    c.version = 2;
  }
  if(c.version < 3){
    // Before the economy: each side starts with the map's opening purse.
    c.gold = c.gold || { british: 20, french: 20 };
    c.version = 3;
  }
  return c;
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
    if((e.kind === 'battle' || e.kind === 'rearguard') && e.data && e.data.battle){
      const b = e.data.battle;
      out.push(`      ${b.kind === 'rearguard' ? 'rearguard action' : 'battle'} id ${b.id}, match ${b.matchUid || '(no record)'}, board ${b.boardMode}, attacker ${b.attackerSide} from ${townName(map, b.fromTownId)}${b.pursuit ? `, pursuit ${b.pursuit.onFoot ? 'on foot (dice -' + b.pursuit.dicePenalty + ')' : 'with cavalry'}, rearguard to hold ${b.rearguardTurns} rounds` : ''}`);
      for(const s of SIDES_CM) out.push(`      ${s} fielded: ${b.participants[s].map(p => p.brigadeId + ' of ' + p.armyId).join(', ')}`);
    }
  }
  out.push('');
  out.push('== Armies now ==');
  for(const a of c.armies) out.push(`  ${a.side} ${a.name} (${a.id}) at ${townName(map, a.townId)}${a.hasMoved ? ', moved' : ''}: ${describeArmy(a)}`);
  return out.join('\n');
}
