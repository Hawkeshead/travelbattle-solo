/* =========================================================
   THE SPARRING BOT (19 Oct 2026)

   A second AI to test ours against, that thinks differently from it. It is a
   copy of js/ai-strategy.js (so it moves, fires and fights through exactly the
   same machinery, as the Alexander snapshot does) with its MOVEMENT brain
   replaced: instead of the AI's dozens of weighted terms, every candidate
   square is scored by a short rulebook of plain good play, learned from a
   sparring game Claude played against the AI:

     1. Keep the line together: no unit more than one row ahead of the army's
        front; the army advances as a block. Lone units are punished.
     2. Never leave infantry next to enemy cavalry in the open.
     3. Guns on hills or flanks, in range, with a clear lane; never stand in a
        friendly gun's lane.
     4. Cavalry stay in command (near their Brigadier) and behind the infantry,
        and strike only a turned, isolated or broken enemy.
     5. Infantry seek woods, villages and hills; they close on the enemy only
        to gang up (two on one) or to finish a turned unit.
     Firing, fighting and Form Square are left as the AI does them.

   node tools/spar/make-bot.mjs   writes js/ai-strategy.bot.js (not committed)
   The simulator uses it with: node tools/sim/run.mjs N --vs bot
========================================================= */
import { readFileSync, writeFileSync } from 'node:fs';
const here = new URL('../../js/', import.meta.url);
let s = readFileSync(new URL('ai-strategy.js', here), 'utf8');

const anchor = `  for(const c of candidates){
    const ox=u.x, oy=u.y;
    u.x=c.x; u.y=c.y;
    const parts = {};`;
if(!s.includes(anchor)) throw new Error('make-bot: the candidate loop has moved; update the anchor');
s = s.replace(anchor, anchor + `
    { // SPARRING BOT: the rulebook decides the square (tools/spar/make-bot.mjs)
      const bs = botDoctrineScore(u, c, side, parts, ox, oy) + seededRandom() * 0.03;
      u.x = ox; u.y = oy;
      scored.push({ x:c.x, y:c.y, stay:!!c.stay, total:bs, parts });
      if(bs > bestScore){ bestScore = bs; best = c; }
      continue;
    }`);

s += `

/* ===== SPARRING BOT RULEBOOK (generated into ai-strategy.bot.js only) ===== */
function botDoctrineScore(u, c, side, parts, ox, oy){
  const t = UNIT_TYPES[u.type], rows = state.terrain.length, cols = state.terrain[0].length;
  const fwd = y => side === 'blue' ? y : rows - 1 - y;          // how far forward a row is for this side
  const mine = state.units.filter(o => !o.removed && o.side === side && o.id !== u.id && o.type !== 'BRIGADIER');
  const foes = state.units.filter(o => !o.removed && o.side !== side && !isConcealedFromEnemy(o));
  const fighters = foes.filter(o => o.type !== 'BRIGADIER');
  const dist = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  const terr = terrainAt(c.x, c.y).key;
  let s = 0;
  const add = (k, v) => { parts[k] = (parts[k] || 0) + v; s += v; };
  // the army's front: the average of its three most forward units (before this move)
  const fronts = mine.map(o => fwd(o.y)).sort((a, b) => b - a);
  const front = fronts.length ? fronts.slice(0, 3).reduce((n, v) => n + v, 0) / Math.min(3, fronts.length) : fwd(oy);
  const nearFoe = fighters.length ? Math.min(...fighters.map(o => dist(c, o))) : 99;
  const adjFriends = mine.filter(o => dist(c, o) === 1).length;
  if(t.key === 'BRIGADIER'){
    const own = mine.filter(o => o.brigadeId === u.brigadeId);
    if(own.length){ const cx = own.reduce((n, o) => n + o.x, 0) / own.length, cy = own.reduce((n, o) => n + o.y, 0) / own.length;
      add('withBrigade', -0.8 * Math.hypot(c.x - cx, c.y - cy)); }
    if(fwd(c.y) > front - 1) add('stayBehind', -2);
    if(nearFoe <= 1) add('danger', -6);
    return s;
  }
  // 1. the line: advance as a block, never more than a row ahead of the front
  add('advance', 1.2 * fwd(c.y));   // 0.6 held 96% of the time and stalled 9 of 20
  if(fwd(c.y) > front + 1) add('aheadOfLine', -3 * (fwd(c.y) - front - 1));
  add('cohesion', Math.min(adjFriends, 3) * 0.8);
  if(adjFriends === 0) add('alone', -3);
  // 2. infantry and enemy cavalry
  const enemyCavNear = fighters.filter(o => UNIT_TYPES[o.type].isCavalry && dist(c, o) <= 1);
  if((t.key === 'INFANTRY' || t.key === 'GUARD') && enemyCavNear.length && u.formation !== 'square' && terr !== 'WOODS' && terr !== 'BUILDING') add('cavalryNear', -4);
  if(fighters.filter(o => dist(c, o) === 1).length >= 3) add('outnumbered', -2 * (fighters.filter(o => dist(c, o) === 1).length - 2));   // two adjacent is ordinary line contact
  // 3. guns
  if(t.isArtillery){
    if(terr === 'HILL') add('gunHill', 3);
    if(c.x <= 3 || c.x >= cols - 4) add('gunFlank', 1);
    if(nearFoe <= 1) add('gunExposed', -6);
    else if(nearFoe <= 5) add('gunInRange', 2);
    return s;
  }
  for(const g of state.units.filter(o => !o.removed && o.side === side && UNIT_TYPES[o.type].isArtillery)){
    const tgt = fighters.slice().sort((a, b) => dist(g, a) - dist(g, b))[0];
    if(!tgt || dist(g, tgt) > 6) continue;
    const between = dist(g, c) + dist(c, tgt) <= dist(g, tgt) + 0 && dist(g, c) > 0 && dist(c, tgt) > 0;
    if(between) add('inGunLane', -2);
  }
  // 4. cavalry
  if(t.isCavalry){
    const brig = state.units.find(o => !o.removed && o.side === side && o.type === 'BRIGADIER' && o.brigadeId === u.brigadeId);
    if(brig && dist(c, brig) > 2) add('outOfCommand', -3);
    const prey = fighters.filter(o => dist(c, o) === 1 && (o.turnOnly || !fighters.some(f => f.id !== o.id && dist(f, o) === 1)));
    if(prey.length) add('strike', 5);
    else if(fwd(c.y) > front) add('cavalryAhead', -2);
    return s;
  }
  // 5. infantry: good ground, and contact only on good terms
  if(terr === 'WOODS' || terr === 'BUILDING') add('cover', 1.5);
  else if(terr === 'HILL') add('hill', 1);
  // contact as a line: with a friend beside it, meeting the enemy is welcome;
  // and once the battle drags on (round 15+) the whole line presses
  if(fighters.some(o => dist(c, o) === 1) && adjFriends >= 1) add('lineContact', 1.5);
  if((state.turnNumber || 1) > 30) add('press', 0.8 * fwd(c.y));
  for(const e of fighters.filter(o => dist(c, o) === 1)){
    const ganging = mine.filter(o => dist(o, e) === 1).length >= 1;
    if(e.turnOnly) add('finishTurned', 3);
    else if(ganging) add('twoOnOne', 2);
    else add('loneAttack', 0);
  }
  return s;
}
`;
writeFileSync(new URL('ai-strategy.bot.js', here), s);
console.log('wrote js/ai-strategy.bot.js');
