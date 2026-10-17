/* =========================================================
   NATIONS (17 Oct 2026: the archive by nation, for Prussia)

   The two sides of a battle stay 'red' and 'blue' (the board, turn order and
   win checks are built on them), but which NATION fights on each is now part
   of the match. Red is always the Coalition and blue the Imperial side: a
   Coalition nation never faces another. Where nobody picks, it is Britain
   against France, exactly as before.

   Per nation: its key (also its key in data/unit-archive.json), the name
   shown to the player, the side it fights for, how many of its armies a
   match may field, its UI colours, the folder its pixel art lives in, whether it has
   classic icons (only Britain and France; the others draw as pixel figures
   under the Classic setting; a nation with no 'art' yet borrows its side's
   default figures), and its cockade (the selection marker: outer
   folds, middle ring, button).

   SECOND ARMIES (17 Oct 2026, all nations). Russia and France may field two
   armies in one match. The second has a roster of its own, under its own key
   ('russia_2', 'france_2', marked secondOf), so no name appears twice; it is
   never offered on its own, only taken by a nation's second army
   (armyKeysFor).

   A leaf module (no imports), so the campaign map's pure core and the tests
   can read it as well as the game.
========================================================= */
export const NATIONS = {
  britain: { key: 'britain', name: 'Britain', adjective: 'British', team: 'coalition', side: 'red', maxArmies: 1,
             colours: { main: '#a3403a', dim: '#5c2825' }, art: 'british', classic: true,
             cockade: ['#151515', '#2b2b2b', '#d9dee4'] },
  france:  { key: 'france', name: 'France', adjective: 'French', team: 'imperial', side: 'blue', maxArmies: 2,
             colours: { main: '#2e4566', dim: '#1c2a3d' }, art: 'french', classic: true,
             cockade: ['#c8191e', '#f6f3ea', '#1f3a8a'] },
  prussia: { key: 'prussia', name: 'Prussia', adjective: 'Prussian', team: 'coalition', side: 'red', maxArmies: 1,
             colours: { main: '#1d1d1f', dim: '#0e0e0f', accent: '#f2f2ee' }, art: 'prussian',
             cockade: ['#151515', '#f2f2ee', '#151515'] },
  russia:   { key: 'russia', name: 'Russia', adjective: 'Russian', team: 'coalition', side: 'red', maxArmies: 2,
             colours: { main: '#2f4a2e', dim: '#1c2e1b', accent: '#f2f2ee' }, art: null,
             cockade: ['#151515', '#e07a1a', '#151515'] },
  russia_2: { key: 'russia_2', name: 'Russia (2nd Army)', adjective: 'Russian', team: 'coalition', side: 'red', maxArmies: 1, secondOf: 'russia',
             colours: { main: '#2f4a2e', dim: '#1c2e1b', accent: '#f2f2ee' }, art: null,
             cockade: ['#151515', '#e07a1a', '#151515'] },
  austria:  { key: 'austria', name: 'Austria', adjective: 'Austrian', team: 'coalition', side: 'red', maxArmies: 1,
             colours: { main: '#a8841f', dim: '#5e4a12', accent: '#f4f1e8' }, art: null,
             cockade: ['#151515', '#e6b422', '#151515'] },
  spain:    { key: 'spain', name: 'Spain', adjective: 'Spanish', team: 'coalition', side: 'red', maxArmies: 1,
             colours: { main: '#b3261e', dim: '#6e1712', accent: '#e6b422' }, art: null,
             cockade: ['#c8191e', '#9a1216', '#c8191e'] },
  portugal: { key: 'portugal', name: 'Portugal', adjective: 'Portuguese', team: 'coalition', side: 'red', maxArmies: 1,
             colours: { main: '#1f4a8a', dim: '#132e57', accent: '#c8191e' }, art: null,
             cockade: ['#1f4a8a', '#c8191e', '#1f4a8a'] },
  poland:   { key: 'poland', name: 'Poland', adjective: 'Polish', team: 'imperial', side: 'blue', maxArmies: 1,
             colours: { main: '#a3203a', dim: '#5e1222', accent: '#f2f2ee' }, art: null,
             cockade: ['#f2f2ee', '#a3203a', '#f2f2ee'] },
};
/* Who fights where when nobody has chosen: today's game. */
export const DEFAULT_NATIONS = { red: 'britain', blue: 'france' };
export const TEAM_OF_SIDE = { red: 'coalition', blue: 'imperial' };

/* The nation fighting on a side in a match ({ red, blue }), falling back to
   the default for a match saved before nations existed. */
export function nationKeyFor(nations, side){
  const k = nations && nations[side];
  return NATIONS[k] ? k : DEFAULT_NATIONS[side];
}
export const nationFor = (nations, side) => NATIONS[nationKeyFor(nations, side)];
/* The nations a player may pick for a side (Coalition nations for red); a
   second army's own key is never offered. */
export const nationsForSide = side => Object.values(NATIONS).filter(n => n.team === TEAM_OF_SIDE[side] && !n.secondOf);
/* A nation's second-army key ('russia' -> 'russia_2'), or null. */
export const secondArmyKey = key => (Object.values(NATIONS).find(n => n.secondOf === key) || {}).key || null;
/* The base nation of any key ('france_2' -> 'france'). */
export const baseNation = key => (NATIONS[key] && NATIONS[key].secondOf) || key;
/* One side's armies, as picked (base nations, in army order), to the keys
   they fight under: a nation's second army takes its second-army key. */
export function armyKeysFor(picks){
  const seen = {};
  return picks.map(k => { const n = seen[k] = (seen[k] || 0) + 1; return n > 1 ? (secondArmyKey(k) || k) : k; });
}
/* Why a nation cannot take another army alongside those already picked for
   its side (a short reason for a greyed-out choice), or null if it can. */
export function cannotField(picks, key){
  const n = NATIONS[key]; if(!n) return 'Unknown nation';
  const have = picks.filter(k => k === key).length, max = n.maxArmies || 1;
  if(have < max) return null;
  return max === 1 ? `${n.name} fields one army` : `${n.name} fields at most ${max} armies`;
}
