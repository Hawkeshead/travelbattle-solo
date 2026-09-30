/* The nation-coloured dice art (assets/dice/): British dice are red with
   silver pips, French dice blue with gold pips. 360 x 360 transparent webp,
   the die centred (a face fills about 71% of the canvas; tumble frames, being
   turned, fill more). Pure: no DOM, so check-assets.mjs can read the list. */
export const DICE_NATION = { red: 'british', blue: 'french' };
export const DICE_FACES = 6;
export const DICE_TUMBLE_FRAMES = 8;
export const diceFacePath = (nation, value) => `assets/dice/${nation}_face_${value}.webp`;
export const diceTumblePath = (nation, i) => `assets/dice/${nation}_tumble_${i}.webp`;
export function diceArtPaths(){
  const out = [];
  for(const nation of Object.values(DICE_NATION)){
    for(let v = 1; v <= DICE_FACES; v++) out.push(diceFacePath(nation, v));
    for(let i = 1; i <= DICE_TUMBLE_FRAMES; i++) out.push(diceTumblePath(nation, i));
  }
  return out;
}
