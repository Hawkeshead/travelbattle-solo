/* =========================================================
   SPRITE TOOL: 3D FIGURES TO SPRITE SHEETS (7 Nov 2026)

   Renders the figures in figures.js with three.js r128 in headless Chromium
   (Playwright), eight facings and a few frames per animation, one sheet per
   unit type per nation, into lab/sprites3d/<nation>/<TYPE>.webp with a
   sidecar <TYPE>.json the Iso Lab reads (lab/iso-figures.js, style B).

   Offline only: nothing in the game reads these. three.js comes from the
   devDependency (node_modules/three); the live lab page uses cdnjs.

   Usage: node tools/sprites/render-sheets.mjs [nation ...] [--preview]
          nations default to british french prussian spanish portuguese
          --preview also writes lab/sprites3d/preview-<nation>.png to look at
========================================================= */
import { chromium } from 'playwright';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const preview = args.includes('--preview');
const nations = args.filter(a => !a.startsWith('--'));
if(!nations.length) nations.push('british', 'french', 'prussian', 'spanish', 'portuguese');

const exe = existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {};
const browser = await chromium.launch(exe);
const page = await browser.newPage();
page.on('pageerror', e => { console.error('page error:', e.message); });
await page.setContent('<!DOCTYPE html><html><body></body></html>');
await page.addScriptTag({ path: join(root, 'node_modules/three/build/three.min.js') });
await page.addScriptTag({ path: join(root, 'tools/sprites/figures.js') });
const types = await page.evaluate(() => window.FIGURES.TYPES);

let total = 0;
for(const nation of nations){
  const dir = join(root, 'lab/sprites3d', nation);
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  let bytes = 0;
  for(const type of types){
    const { dataUrl, meta } = await page.evaluate(([t, n]) => window.FIGURES.renderSheet(t, n, 0), [type, nation]);
    const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
    writeFileSync(join(dir, type + '.webp'), buf);
    writeFileSync(join(dir, type + '.json'), JSON.stringify(meta, null, 1) + '\n');
    bytes += buf.length;
  }
  total += bytes;
  console.log(`${nation}: ${types.length} sheets, ${(bytes / 1024).toFixed(0)} KB, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if(preview){
    // a contact sheet: the first facing of every animation's first frame, each type in a row
    const png = await page.evaluate(async n => {
      const c = document.createElement('canvas'); c.width = 1200; c.height = 640; const g = c.getContext('2d');
      g.fillStyle = '#4a5f36'; g.fillRect(0, 0, c.width, c.height);
      let y = 8;
      for(const t of window.FIGURES.TYPES){
        const { dataUrl, meta } = window.FIGURES.renderSheet(t, n, 0);
        const im = new Image(); im.src = dataUrl; await new Promise(r => { im.onload = r; });
        let x = 8;
        const animNames = Object.keys(meta.anims);
        for(let a = 0; a < animNames.length; a++){
          for(let d = 0; d < 8; d += 2){
            const row = a * meta.dirs + d;
            g.drawImage(im, 0, row * meta.frameH, meta.frameW, meta.frameH, x, y, meta.frameW, meta.frameH);
            x += meta.frameW + 2;
          }
          x += 10;
        }
        y += 76;
      }
      return c.toDataURL('image/png');
    }, nation);
    writeFileSync(join(root, 'lab/sprites3d', `preview-${nation}.png`), Buffer.from(png.split(',')[1], 'base64'));
  }
}
await browser.close();
console.log(`total ${(total / 1024).toFixed(0)} KB in lab/sprites3d`);
