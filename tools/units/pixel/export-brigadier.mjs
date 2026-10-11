// Exports the Brigadier sprite sheets (10 Oct 2026) from cavalry.js's general
// officer, in the same format as every other pixel unit (README.md):
// assets/units-pixel/{british,french}/BRIGADIER/{anim}_{facing}_v{n}.webp, one
// horizontal strip of 64 x 64 frames each, plus BRIGADIER.json.
// Run: node tools/units/pixel/export-brigadier.mjs   (needs Playwright's Chromium)
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
const ROOT = new URL('../../../', import.meta.url).pathname;
const SRC = fs.readFileSync(new URL('./cavalry.js', import.meta.url), 'utf8');
const exe = fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined;
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage();
await page.setContent('<html><body></body></html>');
await page.addScriptTag({ content: SRC + '\nwindow.CAV = CAV;' });
/* global CAV */
const sheets = await page.evaluate(() => {
  const out = {};
  const FACINGS = ['toward', 'away'];
  for (const nation of ['british', 'french']) for (const [anim, a] of Object.entries(CAV.ANIMS)) for (const f of FACINGS) for (let v = 0; v < 5; v++) {
    const c = document.createElement('canvas'); c.width = CAV.W * a.frames.length; c.height = CAV.H;
    const g = c.getContext('2d'); g.imageSmoothingEnabled = false;
    a.frames.forEach((pose, i) => {
      // Fleeing: the same gallop, heading the other way (as the cavalry sheets).
      const view = a.turn ? (f === 'toward' ? 'away' : 'toward') : f;
      g.drawImage(CAV.get(nation, view, pose, v, 'general'), i * CAV.W, 0);
    });
    out[`${nation}/${anim}_${f}_v${v}`] = c.toDataURL('image/png');
  }
  return out;
});
await browser.close();
const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/units-pixel/british/HEAVY_CAV/HEAVY_CAV.json'), 'utf8'));
for (const nation of ['british', 'french']) fs.mkdirSync(path.join(ROOT, `assets/units-pixel/${nation}/BRIGADIER`), { recursive: true });
let n = 0;
for (const [key, url] of Object.entries(sheets)) {
  const [nation, file] = key.split('/');
  fs.writeFileSync(path.join(ROOT, `assets/units-pixel/${nation}/BRIGADIER/${file}.png`), Buffer.from(url.split(',')[1], 'base64'));
  n++;
}
for (const nation of ['british', 'french']) fs.writeFileSync(path.join(ROOT, `assets/units-pixel/${nation}/BRIGADIER/BRIGADIER.json`), JSON.stringify(meta, null, 1));
console.log(`wrote ${n} strips (png; convert to lossless webp next)`);
