/* =========================================================
   MATCH TELEMETRY: MISSED-OPPORTUNITY FLAGS (build spec 2.4)

   Records, not judgements: nothing here is ever shown to the player. Each check
   runs for a HUMAN side only, at the end of that side's own phase (not from the
   turn snapshot, which is taken after the enemy has also moved and would put
   the blame in the wrong place).

   Every check asks the game's own rules, passed in as `rules`, in a dry run:
   no dice, nothing changed. Passing them in (rather than importing
   engine-rules) is what lets test/telemetry-missed.test.js check each code on a
   hand-built position without a browser.

   rules: { legalMoves(u), computeChargeDestinations(u), hasLOS(gun, target),
            chebyshev(a, b), stackPartner(u), terrainAt(x, y) -> terrain key
            ('OPEN', 'WOODS', 'BUILDING', ...), isAdjacent(a, b) }

   COLUMN_IN_GUN_RANGE  a friendly Attack Column (two foot on one square)
     within 4 of an enemy battery that can see it. The game's artillery rule is
     what makes this costly: a column whose unit is destroyed by a gun loses its
     partner with it ("Column broken alongside its partner"), so one shot can
     cost two units.
   LINE_VS_HEAVY_CAV  friendly infantry in line (not square) next to a square
     an enemy Heavy Cavalry unit could charge to next turn (the game's own
     charge destinations).
   CAV_ALONE  a cavalry attack this phase on a defender no other friendly unit
     attacked, while another friendly unit that did not fight could have
     reached a square next to that defender (reach taken at turn start).
   EXPOSED_NO_COVER  a unit ending its move in the open, in sight of and within
     6 of an enemy battery, when a free wood or village square was within its
     reach at turn start.
========================================================= */
export const COVER_TERRAIN = new Set(['WOODS', 'BUILDING']);
const FOOT = new Set(['INFANTRY', 'GUARD']);
const CAV = new Set(['LIGHT_CAV', 'HEAVY_CAV']);
const key = (x, y) => x + ',' + y;

/* Reach sets at the start of a side's move: unit id -> Set of "x,y". */
export function reachAtTurnStart(units, side, rules){
  const out = new Map();
  for(const u of units){
    if(u.removed || u.side !== side) continue;
    const set = new Set([key(u.x, u.y)]);
    for(const m of (rules.legalMoves(u) || [])) set.add(key(m.x, m.y));
    out.set(u.id, set);
  }
  return out;
}

/* After the side's move phase: COLUMN_IN_GUN_RANGE, LINE_VS_HEAVY_CAV, EXPOSED_NO_COVER. */
export function checksAfterMove(units, side, reach, rules){
  const flags = [];
  const live = units.filter(u => !u.removed);
  const mine = live.filter(u => u.side === side);
  const guns = live.filter(u => u.side !== side && u.type === 'ARTILLERY');
  const occupied = new Set(live.map(u => key(u.x, u.y)));

  const seen = new Set();
  for(const u of mine){
    if(!FOOT.has(u.type)) continue;
    const p = rules.stackPartner(u);
    if(!p) continue;
    const sq = key(u.x, u.y);
    if(seen.has(sq)) continue;
    const gun = guns.find(g => rules.chebyshev(g, u) <= 4 && rules.hasLOS(g, u));
    if(gun){ seen.add(sq); flags.push({ code: 'COLUMN_IN_GUN_RANGE', unit: u.id, detail: { partner: p.id, gun: gun.id, range: rules.chebyshev(gun, u) } }); }
  }

  const heavy = live.filter(u => u.side !== side && u.type === 'HEAVY_CAV');
  if(heavy.length){
    const reachable = [];
    for(const c of heavy) for(const d of (rules.computeChargeDestinations(c) || [])) reachable.push({ x: d.x, y: d.y, cav: c.id });
    for(const u of mine){
      if(!FOOT.has(u.type) || u.formation === 'square') continue;
      const hit = reachable.find(d => rules.isAdjacent(d, u));
      if(hit) flags.push({ code: 'LINE_VS_HEAVY_CAV', unit: u.id, detail: { cavalry: hit.cav, from: { x: hit.x, y: hit.y } } });
    }
  }

  for(const u of mine){
    if(u.type === 'BRIGADIER' || COVER_TERRAIN.has(rules.terrainAt(u.x, u.y))) continue;
    const gun = guns.find(g => rules.chebyshev(g, u) <= 6 && rules.hasLOS(g, u));
    if(!gun) continue;
    const r = reach && reach.get(u.id);
    if(!r) continue;
    let cover = null;
    for(const k of r){
      const [x, y] = k.split(',').map(Number);
      if(COVER_TERRAIN.has(rules.terrainAt(x, y)) && !occupied.has(k)){ cover = { x, y }; break; }
    }
    if(cover) flags.push({ code: 'EXPOSED_NO_COVER', unit: u.id, detail: { gun: gun.id, cover } });
  }
  return flags;
}

/* After the side's fight phase: CAV_ALONE. fights: this phase's fights by this
   side, each { attackerId, defenderId }. */
export function checksAfterFight(units, side, fights, reach, rules){
  const flags = [];
  const byId = new Map(units.map(u => [u.id, u]));
  const fought = new Set(fights.map(f => f.attackerId));
  const attackersOn = new Map();
  for(const f of fights) attackersOn.set(f.defenderId, (attackersOn.get(f.defenderId) || 0) + 1);
  for(const f of fights){
    const a = byId.get(f.attackerId), d = byId.get(f.defenderId);
    if(!a || !d || !CAV.has(a.type) || attackersOn.get(f.defenderId) > 1) continue;
    const helper = units.find(o => o.side === side && !o.removed && o.id !== a.id && o.type !== 'BRIGADIER' && o.type !== 'ARTILLERY' &&
      !fought.has(o.id) && reach && reach.get(o.id) && [...reach.get(o.id)].some(k => {
        const [x, y] = k.split(',').map(Number);
        return rules.isAdjacent({ x, y }, d) && !(x === d.x && y === d.y);
      }));
    if(helper) flags.push({ code: 'CAV_ALONE', unit: a.id, detail: { defender: d.id, couldHaveHelped: helper.id } });
  }
  return flags;
}
