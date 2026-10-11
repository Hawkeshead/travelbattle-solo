/* =========================================================
   ONE IMAGE PER FILE

   Every part of the game that wants an image file asks here, so a file is
   requested once and decoded once, whoever asks first: the board's tiles
   (render-units), the hi-res tile copies (render-board), the dice, the unit
   sheets (render-figures), the gun smoke and the title-screen loader
   (asset-loader). On a slow line two separate Image objects for the same
   file were two downloads (seen on Fast 3G: the 19 MB of tiles came down
   twice). No imports, so it loads anywhere, including under Node.
========================================================= */
const IMAGES = new Map();
export function sharedImage(url){
  let img = IMAGES.get(url);
  if(!img){
    img = new Image();
    img.src = url;
    IMAGES.set(url, img);
  }
  return img;
}
