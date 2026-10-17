/* The nation-coloured dice art (assets/dice/): British dice are red with
   silver pips, French dice blue with gold pips, Prussian dice black with
   white-silver pips; and since all nations (17 Oct 2026) every other nation's
   set, the British or French dice repainted in its colours (Russia green with
   silver pips, Austria ivory with gold, Spain red with gold, Portugal blue
   with red, Poland white with crimson, the Confederation black with gold,
   Italy & Naples green with gold). Named by each nation's 'dice' in
   js/nations.js. 360 x 360 transparent webp,
   the die centred (a face fills about 71% of the canvas; tumble frames, being
   turned, fill more). Pure: no DOM, so check-assets.mjs can read the list. */
export const DICE_ARTS = ['british', 'french', 'prussian', 'russian', 'austrian', 'spanish', 'portuguese', 'polish', 'confederation', 'italian'];
export const DICE_FACES = 6;
export const DICE_TUMBLE_FRAMES = 8;
export const diceFacePath = (nation, value) => `assets/dice/${nation}_face_${value}.webp`;
export const diceTumblePath = (nation, i) => `assets/dice/${nation}_tumble_${i}.webp`;
export function diceArtPaths(){
  const out = [];
  for(const nation of DICE_ARTS){
    for(let v = 1; v <= DICE_FACES; v++) out.push(diceFacePath(nation, v));
    for(let i = 1; i <= DICE_TUMBLE_FRAMES; i++) out.push(diceTumblePath(nation, i));
  }
  return out;
}
