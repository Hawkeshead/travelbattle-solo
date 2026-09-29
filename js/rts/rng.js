/* A seeded random generator whose whole state is one number kept IN the game
   state, so a saved battle carries its dice with it and any match replays
   exactly from its seed and order log. (mulberry32) */
export function nextRandom(rts){
  let a = (rts.rng = (rts.rng + 0x6D2B79F5) | 0);
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
