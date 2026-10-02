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
export const INSTANT = new Set(['DESTROY', 'MARCH_OFF']);
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
    return !W.units.some(u => onBoard(u) && u.side === otherSide(side) && inArea(u, c.area));
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
    return goneFighters >= need && types.every(t => gone.some(u => u.type === t));
  },
};
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
