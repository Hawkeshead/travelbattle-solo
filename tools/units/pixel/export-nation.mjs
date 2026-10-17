// Exports every pixel unit sheet for one or more nations (17 Oct 2026, for
// Prussia), in the format README.md describes:
// assets/units-pixel/{nation}/{TYPE}/{anim}_{facing}_v{n}.png, one horizontal
// strip of equal frames per file, plus each type's sidecar {TYPE}.json (copied
// from the British one: the frames, anims and anchors are the same for every
// nation). Convert the pngs to lossless webp afterwards (cwebp -lossless).
//
// Run:  node tools/units/pixel/export-nation.mjs prussian
//       node tools/units/pixel/export-nation.mjs british --verify
// --verify writes nothing: it draws the sheets and compares them, pixel for
// pixel, with the ones already in assets/ (served from http://127.0.0.1:4173,
// so start `npx http-server . -p 4173` first). Used to prove the exporter
// reproduces the shipped British and French art before trusting it with a
// new nation.
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
const ROOT = new URL('../../../', import.meta.url).pathname;
const nations = process.argv.slice(2).filter(a => !a.startsWith('--'));
const verify = process.argv.includes('--verify');
const src = f => fs.readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
const exe = fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined;

/* Every sheet: type, the figure kind it is drawn from, and how a frame of an
   anim maps to a pose (and, for the colour bearer, the flag's wave phase). */
const TYPES = {
  INFANTRY:      { lib: 'GROG', kind: 'line',   facings: ['toward', 'away', 'left', 'right'], anims: ['idle', 'march', 'fire', 'melee', 'fall', 'flee'] },
  GUARD:         { lib: 'GROG', kind: 'guard',  facings: ['toward', 'away', 'left', 'right'], anims: ['idle', 'march', 'fire', 'melee', 'fall', 'flee'] },
  GUARD_BEARER:  { lib: 'GROG', kind: 'bearer', facings: ['toward', 'away'], anims: ['idle', 'march', 'fall', 'flee'] },
  ARTILLERY:     { lib: 'GROG', kind: 'gunner', facings: ['toward', 'away'], anims: ['idle', 'march', 'serve', 'fall', 'flee'] },
  ARTILLERY_GUN: { lib: 'ART',  facings: ['toward', 'away'], anims: ['idle', 'fire', 'wreck'], variants: 1 },
  HEAVY_CAV:     { lib: 'CAV',  kind: 'heavy',   facings: ['toward', 'away'], anims: ['idle', 'march', 'charge', 'melee', 'fall', 'flee'] },
  LIGHT_CAV:     { lib: 'CAV',  kind: 'light',   facings: ['toward', 'away'], anims: ['idle', 'march', 'charge', 'melee', 'fall', 'flee'] },
  BRIGADIER:     { lib: 'CAV',  kind: 'general', facings: ['toward', 'away'], anims: ['idle', 'march', 'charge', 'melee', 'fall', 'flee'] },
};

const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage();
await page.goto(verify ? 'http://127.0.0.1:4173/favicon.png' : 'about:blank');
await page.addScriptTag({ content: src('infantry.js') + '\n' + src('cavalry.js') + '\n' + src('artillery.js') + '\nwindow.GROG = GROG; window.CAV = CAV; window.ART = ART;' });
let written = 0, checked = 0, differ = [];
for (const nation of nations) for (const [type, T] of Object.entries(TYPES)) {
  const meta = JSON.parse(fs.readFileSync(path.join(ROOT, `assets/units-pixel/british/${type}/${type}.json`), 'utf8'));
  const sheets = await page.evaluate(async ({ nation, type, T, meta, verify }) => {
    const L = window[T.lib], out = {};
    // --verify: compare with the shipped sheet here in the page, pixel for pixel.
    const compare = async (c, file) => {
      const img = new Image(); img.src = `/assets/units-pixel/${nation}/${type}/${file}.webp`;
      try { await img.decode(); } catch { return 'missing'; }
      if (img.width !== c.width || img.height !== c.height) return `size ${img.width}x${img.height}, drawn ${c.width}x${c.height}`;
      const o = document.createElement('canvas'); o.width = img.width; o.height = img.height;
      const og = o.getContext('2d'); og.drawImage(img, 0, 0);
      const d = og.getImageData(0, 0, o.width, o.height).data, e = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let bad = 0; for (let k = 0; k < d.length; k++) if (Math.abs(d[k] - e[k]) > 2) bad++;
      return bad ? `${bad} channels differ` : true;
    };
    for (const anim of T.anims) for (const f of T.facings) for (let v = 0; v < (T.variants || 5); v++) {
      const n = meta.anims[anim].frameCount, c = document.createElement('canvas');
      c.width = meta.frameWidth * n; c.height = meta.frameHeight;
      const g = c.getContext('2d'); g.imageSmoothingEnabled = false;
      for (let i = 0; i < n; i++) {
        let img;
        if (T.lib === 'ART') img = L.get(nation, f, L.ANIMS[anim].frames[i]);
        else if (T.lib === 'CAV') {
          const a = L.ANIMS[anim];
          // Troopers flee on the run poses (two frames each); the Brigadier,
          // exported later, on the gallop turned the other way.
          if (anim === 'flee' && T.kind !== 'general') img = L.get(nation, f, ['run1', 'run1', 'run2', 'run2'][i], v, T.kind);
          else img = L.get(nation, a.turn ? (f === 'toward' ? 'away' : 'toward') : f, a.frames[i], v, T.kind);
        } else if (T.kind === 'bearer') {
          // The flag waves through its six phases at a steady seven a second
          // while the man idles or marches (whatever the sheet's own fps), and
          // one phase a frame while he runs.
          const fr = L.ANIMS[anim].frames, fps = meta.anims[anim].fps;
          img = L.get(nation, f, fr[i % fr.length], v, 'bearer', anim === 'flee' ? i % 6 : Math.round(i / fps * 7) % 6);
        } else img = L.get(nation, f, L.ANIMS[anim].frames[i], v, T.kind);
        // A smaller canvas (the bearer's fall, drawn at the plain 48 x 56) sits
        // bottom centre in the frame, where his feet are.
        g.drawImage(img, i * meta.frameWidth + (meta.frameWidth - img.width) / 2, meta.frameHeight - img.height);
      }
      out[`${anim}_${f}_v${v}`] = verify ? await compare(c, `${anim}_${f}_v${v}`) : c.toDataURL('image/png');
    }
    return out;
  }, { nation, type, T, meta, verify });
  if (verify) {
    for (const [file, same] of Object.entries(sheets)) { checked++; if (same !== true) differ.push(`${nation}/${type}/${file}: ${same}`); }
    continue;
  }
  const dir = path.join(ROOT, `assets/units-pixel/${nation}/${type}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, url] of Object.entries(sheets)) { fs.writeFileSync(path.join(dir, `${file}.png`), Buffer.from(url.split(',')[1], 'base64')); written++; }
  fs.writeFileSync(path.join(dir, `${type}.json`), fs.readFileSync(path.join(ROOT, `assets/units-pixel/british/${type}/${type}.json`)));
}
await browser.close();
if (verify) {
  console.log(`checked ${checked} sheets, ${differ.length} differ`);
  for (const d of differ) console.log('  ' + d);
} else console.log(`wrote ${written} strips (png; convert to lossless webp next)`);
