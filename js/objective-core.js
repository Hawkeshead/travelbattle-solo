/* =========================================================
   OPERATIONS: OBJECTIVE CONDITIONS, PURE (Operations and Campaigns brief, 2.4)

   The condition table and its helpers, reading a "world" rather than the game
   state, so the unit tests can check them on hand-made positions without a
   browser. engine-objectives.js points the world at the live game (useWorld)
   before every check.

   world: { units, card, streaks }  (streaks: the forRounds counters, kept on
   state by the game so undo carries them).
========================================================= */
let W = { units: [], card: null, streaks: {} };
export function useWorld(w){ W = w; }
const SIDE_KEY = { red: 'british', blue: 'french' };
const otherSide = side => (side === 'red' ? 'blue' : 'red');
export const CONDITION_TABLE = () => CONDITIONS;
export const INSTANT = new Set(['DESTROY', 'MARCH_OFF', 'COMMANDER_REMOVED', 'BREAK_BRIGADES', 'ENTERED']);
const areaSquares = name => ((W.card && W.card.map && W.card.map.areas && W.card.map.areas[name]) || []);
const inArea = (u, name) => areaSquares(name).some(([x, y]) => u.x === x && u.y === y);
const onBoard = u => !u.removed;
const fighters = side => W.units.filter(u => u.side === side && u.type !== 'BRIGADIER');

/* Who holds an area right now: { british: n, french: n } non-Brigadier units, and any unit at all. */
export function areaHolders(name){
  const live = W.units.filter(u => onBoard(u) && inArea(u, name));
  return {
    british: live.filter(u => u.side === 'red' && u.type !== 'BRIGADIER').length,
    french: live.filter(u => u.side === 'blue' && u.type !== 'BRIGADIER').length,
    anyBritish: live.some(u => u.side === 'red'), anyFrench: live.some(u => u.side === 'blue'),
    squaresBritish: new Set(live.filter(u => u.side === 'red' && u.type !== 'BRIGADIER').map(u => u.x + ',' + u.y)).size,
    squaresFrench: new Set(live.filter(u => u.side === 'blue' && u.type !== 'BRIGADIER').map(u => u.x + ',' + u.y)).size,
  };
}
/* Enemy units destroyed (never Brigadiers, never units that marched off). */
export function destroyedCount(bySide, types){
  return W.units.filter(u => u.side === otherSide(bySide) && u.removed && !u.escaped && u.type !== 'BRIGADIER' &&
    (!types || !types.length || types.includes(u.type))).length;
}
export function marchedOff(side){ return W.units.filter(u => u.side === side && u.escaped); }
export function startingFighters(side){
  return (W.card && W.card._startFighters && W.card._startFighters[SIDE_KEY[side]]) || fighters(side).length;
}

/* The condition table. Each returns true when met. ctx: { endOfRound, round }. */
const CONDITIONS = {
  HOLD_AREA(side, c, ctx){
    if(!ctx.endOfRound) return false;
    const sq = areaSquares(c.area);
    const mine = W.units.filter(u => onBoard(u) && u.side === side && u.type !== 'BRIGADIER' && inArea(u, c.area));
    const here = c.mode === 'all' ? sq.every(([x, y]) => mine.some(u => u.x === x && u.y === y)) : mine.length > 0;
    return roundGate(side, c, ctx, here);
  },
  CLEAR_AREA(side, c, ctx){
    if(!ctx.endOfRound) return false;
    return roundGate(side, c, ctx, !W.units.some(u => onBoard(u) && u.side === otherSide(side) && inArea(u, c.area)));
  },
  // At least `count` of several areas each held (a fighting unit of this side in it, none of the enemy's).
  HOLD_AREAS(side, c, ctx){
    if(!ctx.endOfRound) return false;
    const held = (c.areas || []).filter(a => W.units.some(u => onBoard(u) && u.side === side && u.type !== 'BRIGADIER' && inArea(u, a)) &&
      !W.units.some(u => onBoard(u) && u.side === otherSide(side) && inArea(u, a))).length;
    return roundGate(side, c, ctx, held >= (c.count || 1));
  },
  CONTROL_AREA(side, c, ctx){
    if(!ctx.endOfRound) return false;
    const h = areaHolders(c.area);
    const mineN = side === 'red' ? h.british : h.french;
    const theirsAny = side === 'red' ? h.anyFrench : h.anyBritish;
    return roundGate(side, c, ctx, mineN > 0 && !theirsAny);
  },
  DESTROY(side, c, ctx){
    if(c.byRound && ctx.round > c.byRound) return false;
    return destroyedCount(side, c.unitTypes) >= c.count;
  },
  MARCH_OFF(side, c, ctx){
    if(c.byRound && ctx.round > c.byRound) return false;
    const gone = marchedOff(side);
    const goneFighters = gone.filter(u => u.type !== 'BRIGADIER').length;
    const need = c.count != null ? c.count : Math.ceil((c.fraction || 0) * startingFighters(side));
    const types = c.mustInclude || [];
    const tags = c.mustIncludeTag ? [c.mustIncludeTag] : [];
    return goneFighters >= need && types.every(t => gone.some(u => u.type === t)) && tags.every(t => gone.some(u => u.storyTag === t));
  },
  /* CAMPAIGN CONDITIONS (18 Oct 2026, the Waterloo battles). */
  // At least `count` squares of an area held by this side's fighting units.
  HOLD_COUNT(side, c, ctx){
    if(!ctx.endOfRound) return false;
    const held = new Set(W.units.filter(u => onBoard(u) && u.side === side && u.type !== 'BRIGADIER' && inArea(u, c.area)).map(u => u.x + ',' + u.y));
    return roundGate(side, c, ctx, held.size >= c.count);
  },
  // At least `count` of this side's units (Brigadiers too if c.anyUnit) in an area.
  IN_AREA(side, c, ctx){
    if(!ctx.endOfRound) return false;
    const n = W.units.filter(u => onBoard(u) && u.side === side && (c.anyUnit || u.type !== 'BRIGADIER') && inArea(u, c.area) && (!c.tag || u.storyTag === c.tag)).length;
    return roundGate(side, c, ctx, n >= (c.count || 1));
  },
  // At least `count` units tagged `tag` next to a unit tagged `nextTo` (two allied Brigades joining up).
  NEXT_TO(side, c, ctx){
    if(!ctx.endOfRound) return false;
    const mine = W.units.filter(u => onBoard(u) && u.side === side && u.storyTag === c.tag && u.type !== 'BRIGADIER');
    const them = W.units.filter(u => onBoard(u) && u.side === side && u.storyTag === c.nextTo);
    const n = mine.filter(u => them.some(o => Math.max(Math.abs(o.x - u.x), Math.abs(o.y - u.y)) === 1)).length;
    return roundGate(side, c, ctx, n >= (c.count || 1));
  },
  // A named commander (tagged unit) still in play, optionally inside an area.
  COMMANDER(side, c, ctx){
    if(!ctx.endOfRound) return false;
    const u = W.units.find(o => o.storyTag === c.tag && o.type === 'BRIGADIER');
    return roundGate(side, c, ctx, !!u && onBoard(u) && (!c.area || inArea(u, c.area)));
  },
  // The enemy's named commander removed (killed or captured, not marched off).
  COMMANDER_REMOVED(side, c, ctx){
    if(c.byRound && ctx.round > c.byRound) return false;
    const u = W.units.find(o => o.storyTag === c.tag && o.type === 'BRIGADIER');
    return !!u && u.removed && !u.escaped;
  },
  // At least `count` of this side's Brigades with a fighting unit left.
  BRIGADES_UNBROKEN(side, c, ctx){
    if(!ctx.endOfRound) return false;
    return roundGate(side, c, ctx, brigadeStates(side).filter(b => b.alive).length >= c.count);
  },
  // At least `count` enemy Brigades broken (every fighting unit gone).
  BREAK_BRIGADES(side, c, ctx){
    if(c.byRound && ctx.round > c.byRound) return false;
    return brigadeStates(otherSide(side)).filter(b => !b.alive).length >= c.count;
  },
  // This side has had a fighting unit in the area at least once (latched).
  ENTERED(side, c, ctx){
    if(c.byRound && ctx.round > c.byRound) return false;
    const key = SIDE_KEY[side] + ':ENTERED:' + c.area;
    if(W.units.some(u => onBoard(u) && u.side === side && u.type !== 'BRIGADIER' && inArea(u, c.area))) W.streaks[key] = 1;
    return !!W.streaks[key];
  },
};
/* HOW FAR ALONG A COUNTING CONDITION IS, right now (23 Oct 2026: Papelotte's
   "hold three squares of the hamlets" showed no count at all, and the battle
   was missed by one square). { have, need } for the objective panel, or null
   for a condition that is not a count. The same tests as the table above,
   without the round gate. */
export function conditionProgress(side, c){
  const mine = u => onBoard(u) && u.side === side && u.type !== 'BRIGADIER';
  switch(c.type){
    case 'HOLD_COUNT':
      return { have: new Set(W.units.filter(u => mine(u) && inArea(u, c.area)).map(u => u.x + ',' + u.y)).size, need: c.count };
    case 'IN_AREA':
      return { have: W.units.filter(u => onBoard(u) && u.side === side && (c.anyUnit || u.type !== 'BRIGADIER') && inArea(u, c.area) && (!c.tag || u.storyTag === c.tag)).length, need: c.count || 1 };
    case 'NEXT_TO': {
      const them = W.units.filter(u => onBoard(u) && u.side === side && u.storyTag === c.nextTo);
      return { have: W.units.filter(u => mine(u) && u.storyTag === c.tag && them.some(o => Math.max(Math.abs(o.x - u.x), Math.abs(o.y - u.y)) === 1)).length, need: c.count || 1 };
    }
    case 'HOLD_AREAS':
      return { have: (c.areas || []).filter(a => W.units.some(u => mine(u) && inArea(u, a)) && !W.units.some(u => onBoard(u) && u.side === otherSide(side) && inArea(u, a))).length, need: c.count || 1 };
    case 'BRIGADES_UNBROKEN':
      return { have: brigadeStates(side).filter(b => b.alive).length, need: c.count };
    case 'BREAK_BRIGADES':
      return { have: brigadeStates(otherSide(side)).filter(b => !b.alive).length, need: c.count };
    default: return null;
  }
}
/* A side's Brigades: alive while any fighting unit of it is still on the field. */
function brigadeStates(side){
  const by = new Map();
  for(const u of W.units.filter(o => o.side === side && o.type !== 'BRIGADIER' && !o.escaped)){
    const b = by.get(u.brigadeId) || { id: u.brigadeId, alive: false };
    if(onBoard(u)) b.alive = true;
    by.set(u.brigadeId, b);
  }
  return [...by.values()];
}
/* atRound: only at the end of that round. forRounds: consecutive end-of-round
   checks, counted once per round (however many units fell that round). */
function roundGate(side, c, ctx, here){
  if(c.atRound != null) return ctx.round === c.atRound && here;
  if(c.forRounds != null){
    const key = SIDE_KEY[side] + ':' + c.type + ':' + c.area;
    const streaks = W.streaks;
    if(ctx.countRound) streaks[key] = here ? (streaks[key] || 0) + 1 : 0;
    return (streaks[key] || 0) >= c.forRounds;
  }
  return here;
}
/* Per-condition latching, for independently judged campaign battles: each
   condition counts once it has been true at any check, so an objective can be
   "hold the farm at round 8 AND have Baring in play at round 12". */
export function listLatched(side, ctx){
  const w = W.card.win && W.card.win[SIDE_KEY[side]];
  if(!w) return false;
  return latchList(side, w, SIDE_KEY[side] + ':L:', ctx);
}
/* The same for any objective list, its latches kept under `prefix` (an
   allied nation's: 'british:A:Prussia:'). */
export function latchList(side, w, prefix, ctx){
  const conds = w.conditions || [];
  const done = conds.map((c, i) => {
    const key = prefix + i;
    if(!W.streaks[key] && (ctx.endOfRound || INSTANT.has(c.type)) && CONDITIONS[c.type](side, c, ctx)) W.streaks[key] = ctx.round || 1;
    return !!W.streaks[key];
  });
  return w.combinator === 'all' ? done.every(Boolean) && done.length > 0 : done.some(Boolean);
}
export function listMet(side, ctx){
  const w = W.card.win && W.card.win[SIDE_KEY[side]];
  if(!w) return false;
  const conds = w.conditions || [];
  const usable = ctx.endOfRound ? conds : conds.filter(c => INSTANT.has(c.type));
  if(w.combinator === 'all'){
    if(!ctx.endOfRound && usable.length !== conds.length) return false;
    return conds.every(c => CONDITIONS[c.type](side, c, ctx));
  }
  return usable.some(c => CONDITIONS[c.type](side, c, ctx));
}

/* The end-of-round decision (2.4), pure: met is the sides whose lists are
   complete, wipedLoser the winner when one side has no units left (or null).
   Returns { winner, how } or null for "play on". how: null (objective),
   'both', 'wiped', 'time'. */
export function resolveEndOfRound(card, met, round, wipedWinner){
  const KEY = { british: 'red', french: 'blue' };
  if(met.length === 1) return { winner: met[0], how: null };
  if(met.length === 2 && card.ifBothMet) return { winner: KEY[card.ifBothMet], how: 'both' };
  if(wipedWinner) return { winner: wipedWinner, how: 'wiped' };
  if(card.turnLimit && round >= card.turnLimit && card.ifTimeExpires) return { winner: KEY[card.ifTimeExpires], how: 'time' };
  return null;
}
