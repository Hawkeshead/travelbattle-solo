/* =========================================================
   CAMPAIGN MAP, PHASE 1: THE DRAWING

   Turns the map data and the campaign state into one SVG string. Nothing
   here decides anything: it is handed what to show (the selected army, the
   towns it may march to) and draws it. Kept apart from the rules and the
   screen so the art can be replaced wholesale later (an engraved map, real
   town icons) without touching either: anything that returns the same SVG
   hooks (data-town, data-army) can stand in for renderMapSVG.

   A plain parchment map in the game's own palette and fonts: roads as
   inked lines, towns as seals in their owner's colour, armies as small
   flags beside their town showing how many brigades they hold.
========================================================= */
const INK = '#3b3020', INK_DIM = '#7a6b4d', BRASS = '#a8823f', BRASS_BRIGHT = '#d1a64e';
const SIDE_FILL = { british: '#8c2f2f', french: '#2c3e63' };
const OWNER_FILL = { british: '#c9a49a', french: '#a4adc4' };
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI'];
/* Where a town's name goes when below it would collide (the crowded country
   round Lille, and Antwerp at the map's edge). Art, not data: a new drawing
   of the map lays its labels out for itself. */
const LABEL_AT = { courtrai: 'right', lincelles: 'left', tourcoing: 'right', antwerp: 'left' };
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* Where each army's flag sits: in a row above its town. */
export function armySlots(c, map){
  const out = {};
  const byTown = {};
  for(const a of c.armies) (byTown[a.townId] = byTown[a.townId] || []).push(a);
  for(const [townId, list] of Object.entries(byTown)){
    const t = map.towns.find(x => x.id === townId);
    // Above the town, or to its left for a town at the top edge (Ostend,
    // Bruges, Antwerp), where above would be off the parchment.
    const nearTop = t.y - 40 < 30;
    list.forEach((a, i) => {
      out[a.id] = nearTop ? { x: t.x - 46 - i * 40, y: t.y + 4 } : { x: t.x - (list.length - 1) * 19 + i * 38, y: t.y - 40 };
    });
  }
  return out;
}

/* view: { selectedArmyId, moves: [townId], lastBattleTownId } */
export function renderMapSVG(map, c, view = {}){
  const W = map.width, H = map.height;
  const moves = new Set(view.moves || []);
  const sel = view.selectedArmyId ? c.armies.find(a => a.id === view.selectedArmyId) : null;
  const town = id => map.towns.find(t => t.id === id);
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" class="cmap-svg" role="img" aria-label="${esc(map.name)} campaign map">`);
  parts.push(`<defs>
    <radialGradient id="cmPaper" cx="50%" cy="45%" r="75%"><stop offset="0" stop-color="#f0e5c7"/><stop offset="0.7" stop-color="#e2d2aa"/><stop offset="1" stop-color="#c9b385"/></radialGradient>
    <linearGradient id="cmSea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8fa3a0"/><stop offset="1" stop-color="#b9c2b0"/></linearGradient>
  </defs>`);
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="url(#cmPaper)"/>`);
  // The North Sea along the top left: the coast runs from Dunkirk past Ostend toward the Scheldt.
  parts.push(`<path d="M0,0 L700,0 C640,10 600,8 560,16 C470,30 380,8 300,18 C250,26 230,60 190,92 C140,128 80,130 0,128 Z" fill="url(#cmSea)" opacity="0.75"/>`);
  parts.push(`<text x="70" y="50" font-family="IM Fell English, Cormorant Garamond, serif" font-style="italic" font-size="26" fill="#4d5c58" opacity="0.8">North Sea</text>`);
  parts.push(`<rect x="8" y="8" width="${W - 16}" height="${H - 16}" fill="none" stroke="${BRASS}" stroke-width="3" opacity="0.6"/>`);

  // Roads: inked, a selected army's legal marches picked out in brass.
  for(const [a, b] of map.roads){
    const p = town(a), q = town(b);
    const live = sel && ((sel.townId === a && moves.has(b)) || (sel.townId === b && moves.has(a)));
    parts.push(`<line x1="${p.x}" y1="${p.y}" x2="${q.x}" y2="${q.y}" stroke="${live ? BRASS_BRIGHT : INK_DIM}" stroke-width="${live ? 7 : 3.5}" stroke-dasharray="${live ? '' : '10 7'}" stroke-linecap="round" opacity="${live ? 1 : 0.75}"/>`);
  }

  // Towns.
  for(const t of map.towns){
    const owner = (c.towns[t.id] && c.towns[t.id].owner) || t.owner;
    const isMove = moves.has(t.id);
    const enemyHere = sel && isMove && c.armies.some(a => a.townId === t.id && a.side !== sel.side);
    if(isMove) parts.push(`<circle cx="${t.x}" cy="${t.y}" r="27" fill="${enemyHere ? '#b5453f' : BRASS_BRIGHT}" opacity="0.45"/>`);
    if(view.lastBattleTownId === t.id) parts.push(`<circle cx="${t.x}" cy="${t.y}" r="24" fill="none" stroke="#8c2f2f" stroke-width="3" stroke-dasharray="4 4"/>`);
    if(t.isDepot) parts.push(`<rect x="${t.x - 17}" y="${t.y - 17}" width="34" height="34" transform="rotate(45 ${t.x} ${t.y})" fill="none" stroke="${INK}" stroke-width="2.5"/>`);
    parts.push(`<circle cx="${t.x}" cy="${t.y}" r="13" fill="${OWNER_FILL[owner] || '#d8c99e'}" stroke="${INK}" stroke-width="3"/>`);
    if(t.historicalSiteId){
      // Crossed sabres: a battle was fought here in 1793-94.
      parts.push(`<g stroke="${INK}" stroke-width="2.4" stroke-linecap="round"><line x1="${t.x - 6}" y1="${t.y - 6}" x2="${t.x + 6}" y2="${t.y + 6}"/><line x1="${t.x + 6}" y1="${t.y - 6}" x2="${t.x - 6}" y2="${t.y + 6}"/></g>`);
    }
    const lp = LABEL_AT[t.id] || 'below';
    const lx = lp === 'left' ? t.x - 20 : lp === 'right' ? t.x + 20 : t.x;
    const ly = lp === 'below' ? t.y + 34 : t.y + 6;
    const anchor = lp === 'left' ? 'end' : lp === 'right' ? 'start' : 'middle';
    parts.push(`<text x="${lx}" y="${ly}" text-anchor="${anchor}" font-family="Cinzel, serif" font-weight="700" font-size="19" fill="${INK}" stroke="#efe3c2" stroke-width="5" paint-order="stroke">${esc(t.name)}</text>`);
    // Generous invisible hit area so a fingertip finds the town.
    parts.push(`<circle cx="${t.x}" cy="${t.y}" r="30" fill="transparent" data-town="${t.id}" class="cmap-hit${isMove ? ' cmap-move' : ''}"/>`);
  }

  // Armies: a flag per army above its town.
  const slots = armySlots(c, map);
  for(const a of c.armies){
    const s = slots[a.id];
    const t = town(a.townId);
    const selected = sel && sel.id === a.id;
    parts.push(`<g data-army="${a.id}" class="cmap-army${a.hasMoved ? ' moved' : ''}">`);
    parts.push(`<line x1="${s.x - 15}" y1="${s.y - 15}" x2="${t.x}" y2="${t.y - 12}" stroke="${INK}" stroke-width="1.5" opacity="0.5"/>`);
    parts.push(`<rect x="${s.x - 18}" y="${s.y - 15}" width="36" height="28" rx="3" fill="${SIDE_FILL[a.side]}" stroke="${selected ? BRASS_BRIGHT : INK}" stroke-width="${selected ? 5 : 2}" opacity="${a.hasMoved && c.phase === a.side ? 0.6 : 1}"/>`);
    parts.push(`<text x="${s.x}" y="${s.y + 6}" text-anchor="middle" font-family="Cinzel, serif" font-weight="800" font-size="17" fill="#f3e7c6">${ROMAN[a.brigades.length] || a.brigades.length}</text>`);
    // Withdrew from a fight: cannot march on its next turn.
    if(a.restTurn != null){
      parts.push(`<g class="cmap-rest"><rect x="${s.x - 30}" y="${s.y + 15}" width="60" height="18" rx="3" fill="#efe3c2" stroke="#8c2f2f" stroke-width="2"/>` +
        `<text x="${s.x}" y="${s.y + 28.5}" text-anchor="middle" font-family="Cinzel, serif" font-weight="800" font-size="12" fill="#8c2f2f">RESTING</text></g>`);
    }
    parts.push(`<rect x="${s.x - 24}" y="${s.y - 21}" width="48" height="40" fill="transparent"/>`);
    parts.push(`</g>`);
  }
  parts.push('</svg>');
  return parts.join('');
}
