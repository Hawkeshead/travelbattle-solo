/* =========================================================
   MIXED BRIGADES (17 Oct 2026, the Confederation of the Rhine)

   A combined army of several states (data/unit-states.json; today only the
   Confederation) may not field a Brigade made up entirely of one state's
   troops, its Brigadier aside. Pure: the callers pass the state map, so the
   tests read the same file the game does.

   Where it is enforced: an army layout that would give such a Brigade is
   refused in the army picker (player) and never chosen by the AI; a Brigade
   placed by hand is refused when it is confirmed. With today's rosters and
   layouts it cannot actually happen (no state has more than two units, the
   six infantry regiments are six different states, and the smallest Brigade
   in any layout is two infantry), so this guards the rule for future rosters
   and layouts rather than changing any match now.
========================================================= */

/* The one state a Brigade's units (names, Brigadier excluded) all come from,
   or null if they are mixed, or if any unit has no state on record. */
export function singleStateOf(names, states){
  if(!states || !names.length) return null;
  const st = names.map(n => states[n]);
  if(st.some(s => !s)) return null;
  return st.every(s => s === st[0]) ? st[0] : null;
}

/* Why this Brigade is refused (a short message for the player), or null. */
export function brigadeRefusal(adjective, names, states){
  const s = singleStateOf(names, states);
  return s ? `A ${adjective} Brigade must mix troops from more than one state: this one would be all from ${s}.` : null;
}

/* The names an army layout's units would take, Brigade by Brigade, in the
   order they are placed (each Brigade's Brigadier first, then its units in
   the layout's order; names go out per type in list order, wrapping round):
   [[names of Brigade 1, Brigadier excluded], ...]. */
export function layoutNames(composition, archive){
  const counters = {};
  const take = type => { const list = archive[type] || []; const i = counters[type] || 0; counters[type] = i + 1; return list.length ? list[i % list.length].name : null; };
  return composition.brigades.map(b => { take('BRIGADIER'); return b.units.filter(e => e.type !== 'BRIGADIER').map(e => take(e.type)); });
}

/* Why an army layout is refused for this nation, or null. */
export function layoutRefusal(adjective, composition, archive, states){
  if(!states) return null;
  for(const names of layoutNames(composition, archive)){
    const why = brigadeRefusal(adjective, names, states);
    if(why) return why;
  }
  return null;
}
