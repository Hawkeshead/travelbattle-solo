/* =========================================================
   BRIGADE PERKS, PURE (23 Oct 2026, Matthew)

   A Brigade earns a perk by a feat of the whole Brigade during a battle
   ("beats off two cavalry attacks"). Its Brigadier holds it, and it works only
   for the Brigade's units in command: linked to the Brigadier through a chain
   of touching units, the same chain Brigadier cohesion uses. If the Brigadier
   falls, the perk goes with him. Perks last for the one battle.

   One perk per Brigade (two in battles of 12 rounds or more), so a lucky
   early fight cannot snowball into an unstoppable Brigade. Every reward is a
   flat +1 (never a second die) or a one-step easier roll.

   Pure: reads only what it is given. perks.js points it at the live game.

   ps (the perk state, kept on state.perkState so undo and saves carry it):
     { perks: { 'red:0': ['STEADY'] }, feats: { 'red:0': { cavRepelled: 1 } } }
========================================================= */
export const PERKS = {
  STEADY:       { name: 'Steady Lads',        feat: 'cavRepelled',  need: 2, text: 'its infantry get +1 defending against cavalry',
                  how: 'beaten off two cavalry attacks' },
  BLOODTHIRSTY: { name: 'Bloodthirsty',       feat: 'destroyed',    need: 3, text: 'its cavalry get +1 in every fight',
                  how: 'destroyed three enemy units' },
  MARKSMEN:     { name: 'Marksmen',           feat: 'knockbacks',   need: 2, text: 'its volleys get +1',
                  how: 'knocked back two enemy units with volleys' },
  STREET:       { name: 'Street Fighters',    feat: 'villageHolds', need: 2, text: 'its units get +1 defending a village or building',
                  how: 'won two fights defending a village or building' },
  INSPIRING:    { name: 'Inspiring Presence', feat: 'wins',         need: 5, text: 'its units rally one better (guns excepted)',
                  how: 'won five fights' },
  STUBBORN:     { name: 'Stubborn',           feat: 'heldGround',   need: 4, text: 'once a turn, one of its units stands its ground instead of being pushed back',
                  how: 'held its ground in four fights' },
  GUERRILLAS:   { name: 'Guerrillas',         feat: 'ambushWins',   need: 2, text: 'its infantry move through woods as if on road',
                  how: 'won two fights from ambush' },
  MOUSTACHES:   { name: 'Old Moustaches',     feat: 'winsAfterLoss', need: 3, text: 'its units get +1 in their next fight after a friend falls',
                  how: 'won three fights after losing a unit' },
  PURSUERS:     { name: 'Pursuers',           feat: 'cavalryRouts', need: 2, text: 'its cavalry ride into the ground a routed enemy leaves',
                  how: 'routed two enemy units with its cavalry' },
  CHARMED:      { name: 'Charmed Life',       feat: 'winsAfterLeadership', need: 2, text: 'its Brigadier gets his Leadership Roll back',
                  how: 'won two fights after its Leadership Roll was spent' },
};
export const PERK_ORDER = Object.keys(PERKS);

export const newPerkState = () => ({ perks: {}, feats: {}, avenge: {}, stoodTurn: {} });
export const brigKey = (side, brigadeId) => side + ':' + brigadeId;
export const perksOf = (ps, key) => (ps && ps.perks[key]) || [];

/* Count one feat for a Brigade. Returns the perk earned by it, or null: the
   first perk whose feat reaches its number, while the Brigade is under its cap
   and does not hold that perk already. */
export function addFeat(ps, key, feat, cap){
  if(!ps) return null;
  const f = ps.feats[key] = ps.feats[key] || {};
  f[feat] = (f[feat] || 0) + 1;
  const held = perksOf(ps, key);
  if(held.length >= cap) return null;
  for(const id of PERK_ORDER){
    const p = PERKS[id];
    if(p.feat !== feat || held.includes(id) || f[feat] < p.need) continue;
    (ps.perks[key] = held).push(id);
    return id;
  }
  return null;
}

/* The unit's Brigadier, if the unit is in command: the Brigadier alive and on
   the board, and the unit linked to him through touching units of its own
   Brigade. adj(a, b) is the game's adjacency (it knows about rivers). */
export function commandingBrigadier(units, unit, adj){
  const group = units.filter(o => !o.removed && o.side === unit.side && o.brigadeId === unit.brigadeId && o.x >= 0);
  const brig = group.find(o => o.type === 'BRIGADIER');
  if(!brig || unit.removed) return null;
  if(unit === brig || unit.id === brig.id) return brig;
  const reached = new Set([brig.id]), queue = [brig];
  while(queue.length){
    const cur = queue.shift();
    for(const o of group){
      if(reached.has(o.id) || !adj(cur, o)) continue;
      if(o.id === unit.id) return brig;
      reached.add(o.id); queue.push(o);
    }
  }
  return null;
}

/* Does this perk work for this unit right now? */
export function perkWorks(ps, units, unit, id, adj){
  if(!ps || !unit || !perksOf(ps, brigKey(unit.side, unit.brigadeId)).includes(id)) return false;
  return !!commandingBrigadier(units, unit, adj);
}
