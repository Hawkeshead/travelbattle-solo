/* =========================================================
   CAMPAIGN BATTLES AS BATTLE CARDS (18 October 2026)

   Pure: turns one battle from data/story/<campaign>.json into the battle card
   the Operations engine plays (map, forces, objectives, turn limit), for the
   nation the player has chosen.

   Sides: France (and its allies) is the French side; every other nation on
   the field is the Coalition side. The Coalition's objective on the card is
   the PLAYER's nation's when the player is on that side; otherwise the
   objective of the Coalition nation with the most Brigades there. Brigades of
   a nation other than the player's are marked { ai: true }: an allied AI
   commander plays them (wired up with the allied-Brigade work).

   Campaign battles are judged independently: each side's objective is what it
   achieved historically, both can be met in one game, and the battle runs to
   its turn limit (engine-objectives.js).
========================================================= */
export const FRENCH_SIDE = new Set(['France']);

function cardBrigade(b, nation, ally){
  const units = b.units.map((t, i) => {
    const f = Array.isArray(b.formation) && b.formation[i] && b.formation[i] !== 'line' ? b.formation[i] : null;
    const n = Array.isArray(b.names) && b.names[i] ? b.names[i] : null;   // the unit's own name (the 92nd Highlanders)
    return f || n ? Object.assign({ type: t }, f ? { formation: f } : {}, n ? { name: n } : {}) : t;
  });
  const out = { name: b.name, nation, units, placement: b.placement || { type: 'edge' } };
  if(b.tag) out.tag = b.tag;
  if(b.commander) out.commander = b.commander;   // the Brigadier's name
  for(const k of ['arrives', 'arrivals', 'lockedUntil', 'pinCommanderUntil']) if(b[k] != null) out[k] = b[k];   // reinforcements and held-back Brigades
  if(ally) out.ai = true;
  return out;
}

/* CORRIDOR BATTLES (Matthew, 18 Oct 2026): designed as 20 wide by 10 deep
   with France at the left end and the Coalition at the right. The game plays
   them as a board 10 wide by 20 deep (France at the top, the Coalition at the
   bottom), so every rule that reads "forward" as up or down works unchanged,
   and shows it from the side (view edge W) so it looks as designed. Design
   square (col, row) becomes game square (9 - row, col); line coordinates
   (X, Y) become (10 - Y, X). */
export function corridorMap(m){
  const W = m.terrain[0].length, H = m.terrain.length;           // 20 x 10 as designed
  const grid = rows => Array.from({ length: W }, (_, gy) => Array.from({ length: H }, (_, gx) => rows[H - 1 - gx][gy]).join(''));
  const sq = ([x, y]) => [H - 1 - y, x];
  const line = ([x, y]) => [H - y, x];
  const out = Object.assign({}, m, { terrain: grid(m.terrain), roads: grid(m.roads) });
  if(m.river) out.river = Object.assign({}, m.river, {
    course: m.river.course.map(line),
    fords: (m.river.fords || []).map(([x0, x1, y0, y1]) => [H - y1, H - y0, x0, x1]),
    bridges: (m.river.bridges || []).map(b => Object.assign({}, b, { squares: b.squares.map(sq) })),
  });
  if(m.places) out.places = m.places.map(([n, x, y, k]) => [n, H - y, x, k]);
  if(m.areas) out.areas = Object.fromEntries(Object.entries(m.areas).map(([k, v]) => [k, v.map(sq)]));
  out.corridor = true;
  return out;
}
export function storyToCard(battle, playerNation, campaign = 'story'){
  const coalition = Object.keys(battle.sides).filter(n => !FRENCH_SIDE.has(n));
  const french = Object.keys(battle.sides).filter(n => FRENCH_SIDE.has(n));
  const playerCoalition = coalition.includes(playerNation);
  const lead = playerCoalition ? playerNation
    : coalition.slice().sort((a, b) => battle.sides[b].brigades.length - battle.sides[a].brigades.length)[0];
  /* A commander an enemy objective sets out to remove (COMMANDER_REMOVED) is a
     VIP: Brigadiers can never be attacked, only taken by a unit ending its
     move in his square, which only VIPs allow. */
  const hunted = new Set(Object.values(battle.sides).flatMap(s => (s.objective.conditions || []).filter(c => c.type === 'COMMANDER_REMOVED').map(c => c.tag)));
  const forcesFor = names => ({ brigades: names.flatMap(n => battle.sides[n].brigades.map(b => Object.assign(cardBrigade(b, n, n !== playerNation), b.tag && hunted.has(b.tag) ? { vip: true } : {}))) });
  const winFor = n => ({ text: battle.sides[n].objective.text, combinator: battle.sides[n].objective.combinator || 'any',
    conditions: battle.sides[n].objective.conditions || [] });
  const holds = n => (battle.sides[n].objective.conditions || []).some(c => /HOLD|CONTROL|COMMANDER$|UNBROKEN/.test(c.type));
  return {
    id: `${campaign}-${battle.id}-${playerNation.toLowerCase()}`,
    kind: 'operation', campaign, status: 'ready', judging: 'independent',
    name: battle.name, date: battle.date, archetype: null, intro: battle.history,
    sourceUrl: battle.sourceUrl || '', historicalResult: '',
    firstPlayer: battle.firstPlayer || 'french',   // who moves first (the Narrow Escape: the Allies)
    map: Object.assign({ type: 'authored' }, battle.layout === 'corridor' ? corridorMap(battle.map) : battle.map),
    turnLimit: battle.turnLimit,
    forces: { british: forcesFor(coalition), french: forcesFor(french) },
    win: { british: winFor(lead), french: winFor(french[0]) },
    /* ALLIED OBJECTIVES (23 Oct 2026, Papelotte): a nation on the field that
       is neither the player's nor the side's lead kept its objective only in
       the story file, so Zieten's Prussians never sought the Nassauers. Each
       is carried here: judged and reported, pursued by its own AI-led
       Brigades, but never what decides the battle or the campaign. */
    allies: { british: coalition.filter(n => n !== lead).map(n => Object.assign({ nation: n }, winFor(n))).filter(a => a.conditions.length),
      french: french.slice(1).map(n => Object.assign({ nation: n }, winFor(n))).filter(a => a.conditions.length) },
    specialRules: {},
    storyRules: { layout: battle.layout, needs: battle.needs || [], notes: battle.special || '', rules: battle.rules || {} },   // the campaign's own rules, applied as the engine gains them
    ifBothMet: null, ifTimeExpires: null,
    aiRoles: { british: battle.sides[lead].role || (holds(lead) ? 'hold' : 'attack'), french: battle.sides[french[0]].role || (holds(french[0]) ? 'hold' : 'attack') },   // the battle's own attacker and defender
    outcomes: { britishWin: '', frenchWin: '' },
    story: { battleId: battle.id, playerNation, lead, layout: battle.layout },
  };
}
