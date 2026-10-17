/* =========================================================
   NATIONS (17 Oct 2026: the archive by nation, for Prussia)

   The two sides of a battle stay 'red' and 'blue' (the board, turn order and
   win checks are built on them), but which NATION fights on each is now part
   of the match. Red is always the Coalition and blue the Imperial side: a
   Coalition nation never faces another. Where nobody picks, it is Britain
   against France, exactly as before.

   Per nation: its key (also its key in data/unit-archive.json), the name
   shown to the player, the side it fights for, how many of its armies a
   match may field (null: no limit set yet, left open for a second French
   army), its UI colours, and the folder its art lives in.

   A leaf module (no imports), so the campaign map's pure core and the tests
   can read it as well as the game.
========================================================= */
export const NATIONS = {
  britain: { key: 'britain', name: 'Britain', adjective: 'British', team: 'coalition', side: 'red', maxArmies: 1,
             colours: { main: '#a3403a', dim: '#5c2825' }, art: 'british' },
  france:  { key: 'france', name: 'France', adjective: 'French', team: 'imperial', side: 'blue', maxArmies: null,
             colours: { main: '#2e4566', dim: '#1c2a3d' }, art: 'french' },
  prussia: { key: 'prussia', name: 'Prussia', adjective: 'Prussian', team: 'coalition', side: 'red', maxArmies: 1,
             colours: { main: '#1d1d1f', dim: '#0e0e0f', accent: '#f2f2ee' }, art: 'prussian' },
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
/* The nations that may fight on a side (Coalition nations for red). */
export const nationsForSide = side => Object.values(NATIONS).filter(n => n.team === TEAM_OF_SIDE[side]);
