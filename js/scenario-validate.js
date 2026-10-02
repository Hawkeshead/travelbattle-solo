/* =========================================================
   SCENARIO CARD VALIDATION (Operations and Campaigns brief, step 1)

   Pure: no game state, no DOM, so the unit tests import it directly. See
   js/scenario-cards.js for what a card is.
========================================================= */
export const CARD_SIDES = ['british', 'french'];
export const UNIT_TYPES_ALLOWED = new Set(['BRIGADIER', 'GUARD', 'INFANTRY', 'HEAVY_CAV', 'LIGHT_CAV', 'ARTILLERY']);
/* The step 2 objective types. Step 8 adds LINK_UP, BREAK_SQUARES and VIP_SAFE
   here, and the engine's type table; nothing else should need to change. */
export const CONDITION_TYPES = new Set(['HOLD_AREA', 'CLEAR_AREA', 'CONTROL_AREA', 'DESTROY', 'MARCH_OFF']);
export const SPECIAL_RULES_ALLOWED = new Set(['chainWaivedTurn1']);
const COLS = 20, ROWS = 10;

const unitType = u => (typeof u === 'string' ? u : u && u.type);

/* Every fault on one card, as plain sentences. Draft cards are checked only
   for what they carry (forces); ready cards for everything the engine needs. */
export function validateCard(card){
  const errs = [];
  const where = m => errs.push(`${card && card.id || '(no id)'}: ${m}`);
  if(!card || !card.id) { where('card has no id'); return errs; }
  if(!['battle', 'operation'].includes(card.kind)) where(`kind "${card.kind}" is not battle or operation`);
  if(!['ready', 'draft'].includes(card.status)) where(`status "${card.status}" is not ready or draft`);
  if(!['british', 'french', 'diceOff'].includes(card.firstPlayer)) where(`firstPlayer "${card.firstPlayer}" is not british, french or diceOff`);

  const forces = card.forces;
  if(card.kind === 'operation'){
    for(const side of CARD_SIDES){
      const f = forces && forces[side];
      if(!f || !Array.isArray(f.brigades) || !f.brigades.length || f.brigades.length > 3){ where(`${side} needs 1 to 3 Brigades`); continue; }
      f.brigades.forEach((b, i) => {
        const units = b.units || [];
        for(const u of units) if(!UNIT_TYPES_ALLOWED.has(unitType(u))) where(`${side} Brigade ${i + 1}: unknown unit type "${unitType(u)}"`);
        const brigs = units.filter(u => unitType(u) === 'BRIGADIER').length;
        if(brigs !== 1) where(`${side} Brigade ${i + 1}: has ${brigs} Brigadiers, needs exactly 1`);
        if(units.filter(u => unitType(u) !== 'BRIGADIER').length < 2) where(`${side} Brigade ${i + 1}: needs at least 2 units besides its Brigadier`);
      });
    }
  }
  if(card.status !== 'ready') return errs;

  // Ready cards: everything the engine reads.
  const map = card.map;
  if(!map || map.type !== 'standard') where(`map type "${map && map.type}" is not supported yet (step 2 has "standard"; "authored" arrives in step 3)`);
  else {
    for(const k of ['red', 'blue']) {
      if(!['A', 'B'].includes(map.boards && map.boards[k])) where(`map.boards.${k} must be A or B`);
      if(![0, 1, 2, 3].includes(map.rotation && map.rotation[k])) where(`map.rotation.${k} must be 0 to 3`);
    }
    for(const o of (map.overrides || [])) if(!inBounds(o.x, o.y)) where(`override at (${o.x},${o.y}) is off the board`);
  }
  const areas = (map && map.areas) || {};
  for(const [name, sq] of Object.entries(areas)){
    if(!Array.isArray(sq) || !sq.length) where(`area "${name}" has no squares`);
    for(const s of (sq || [])) if(!Array.isArray(s) || !inBounds(s[0], s[1])) where(`area "${name}" has a square off the board: ${JSON.stringify(s)}`);
  }
  if(map && map.exits) for(const [side, edge] of Object.entries(map.exits)){
    if(!CARD_SIDES.includes(side)) where(`exit for unknown side "${side}"`);
    if(!['britishEdge', 'frenchEdge'].includes(edge)) where(`exit edge "${edge}" is not britishEdge or frenchEdge`);
  }
  for(const k of Object.keys(card.specialRules || {})) if(!SPECIAL_RULES_ALLOWED.has(k)) where(`special rule "${k}" is not supported (step 2 has: ${[...SPECIAL_RULES_ALLOWED].join(', ')})`);

  if(card.kind === 'operation'){
    if(!(card.turnLimit > 0)) where('an Operation needs a turnLimit (full rounds)');
    for(const side of CARD_SIDES){
      for(const [i, b] of ((forces && forces[side] && forces[side].brigades) || []).entries()){
        const p = b.placement;
        if(!p || !['edge', 'area'].includes(p.type)) { where(`${side} Brigade ${i + 1}: placement must be edge or area`); continue; }
        if(p.type === 'area'){
          const groups = p.split || [{ area: p.area, count: (b.units || []).length }];
          let total = 0;
          for(const g of groups){
            if(!areas[g.area]) { where(`${side} Brigade ${i + 1}: placement area "${g.area}" is not on the map`); continue; }
            total += g.count;
            /* One unit per square (a Column can share, but placement does not
               plan Columns), so an area needs a square for every unit placed. */
            if(areas[g.area].length < g.count) where(`${side} Brigade ${i + 1}: area "${g.area}" has ${areas[g.area].length} squares for ${g.count} units`);
          }
          if(p.split && total !== (b.units || []).length) where(`${side} Brigade ${i + 1}: split places ${total} of ${(b.units || []).length} units`);
        }
      }
    }
    const win = card.win;
    if(!win || typeof win !== 'object') where('an Operation needs structured win conditions');
    else for(const side of CARD_SIDES){
      const w = win[side];
      if(!w || !Array.isArray(w.conditions) || !w.conditions.length) { where(`${side} has no win conditions`); continue; }
      if(!['any', 'all'].includes(w.combinator)) where(`${side} combinator "${w.combinator}" is not any or all`);
      for(const c of w.conditions){
        if(!CONDITION_TYPES.has(c.type)) where(`${side} condition type "${c.type}" is unknown`);
        if(/AREA$/.test(c.type) && !areas[c.area]) where(`${side} condition ${c.type} names area "${c.area}", which is not on the map`);
        if(c.type === 'MARCH_OFF' && !(map && map.exits && map.exits[side])) where(`${side} MARCH_OFF needs an exit edge for ${side} on the map`);
        if(c.type === 'DESTROY' && !(c.count > 0)) where(`${side} DESTROY needs a count`);
        for(const t of (c.unitTypes || []).concat(c.mustInclude || [])) if(!UNIT_TYPES_ALLOWED.has(t)) where(`${side} condition names unknown unit type "${t}"`);
      }
    }
    for(const k of ['ifTimeExpires', 'ifBothMet']) if(card[k] != null && !CARD_SIDES.includes(card[k])) where(`${k} must be british, french or null`);
  } else if(card.forces !== 'standard' || card.win !== 'standard') where('a Battle uses forces "standard" and win "standard"');
  return errs;
}
const inBounds = (x, y) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x < COLS && y >= 0 && y < ROWS;

