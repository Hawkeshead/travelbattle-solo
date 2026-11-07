/* =========================================================
   ISO LAB CHECK (7 Nov 2026)

   Opens lab/iso.html in headless Chromium (WebGL through SwiftShader), fails
   on any console error, reads the page's own readout (fps, draw calls,
   triangles, figures, download) and takes screenshots of the battle at three
   camera angles in both figure styles, at a phone's landscape size.

   three.js comes from cdnjs on the live page; here the request is answered
   from node_modules/three (a devDependency), so the check runs offline.

   Usage: node tools/lab/iso-check.mjs [battle card id] [--shots]
========================================================= */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const battle = args.find(a => !a.startsWith('--')) || 'waterloo-waterloo-britain';
const shots = args.includes('--shots');
const PORT = 4177;
const srv = spawn('npx', ['--yes', 'http-server', '.', '-p', String(PORT), '--silent', '-c-1'], { cwd: root, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 2500));
const three = readFileSync(join(root, 'node_modules/three/build/three.min.js'));
/* The repo pins its own Playwright; the browser preinstalled on the session's
   machine (when there is one) is used so no download is needed. */
const exe = existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {};
const browser = await chromium.launch(exe);
let failed = false;
try {
  const ctx = await browser.newContext({ viewport: { width: 852, height: 393 }, deviceScaleFactor: shots ? 2 : 1, isMobile: true, hasTouch: true });
  await ctx.route(/cdnjs\.cloudflare\.com\/ajax\/libs\/three\.js\/r128\/three\.min\.js/, r => r.fulfill({ body: three, contentType: 'application/javascript' }));
  await ctx.route(/fonts\.googleapis\.com|fonts\.gstatic\.com/, r => r.fulfill({ body: '', contentType: 'text/css' }));
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if(m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('uncaught: ' + e.message));
  for(const style of ['A', 'B']){
    for(const quality of ['low', 'high']){
      await page.goto(`http://127.0.0.1:${PORT}/lab/iso.html?battle=${battle}&style=${style}&quality=${quality}`);
      await page.waitForFunction(() => window.__iso && window.__iso.stats && window.__iso.stats.figures > 0, null, { timeout: 90000 }).catch(() => {});
      await page.waitForTimeout(1500);
      const stats = await page.evaluate(() => window.__iso && window.__iso.stats);
      const note = await page.evaluate(() => document.getElementById('note').textContent);
      console.log(`${battle} style ${style} ${quality}: ${stats ? JSON.stringify(stats) : 'no stats'}${note ? '  note: ' + note : ''}`);
      if(!stats || !stats.figures){ failed = true; }
      if(shots && quality === 'low'){
        mkdirSync(join(root, 'lab/screenshots'), { recursive: true });
        const views = [['high', 76, 0], ['mid', 52, 0.35], ['low', 30, -0.6]];
        for(const [name, pitch, yaw] of views){
          await page.evaluate(([p, y]) => { const r = window.__iso.rig; r.reset(); r.tiltTo(p); r.yaw += y; r.dist *= p > 70 ? 0.95 : p > 40 ? 0.7 : 0.45; if(p < 40){ r.target.z += 3; } }, [pitch, yaw]);
          await page.evaluate(() => { document.getElementById('allvolley').click(); });
          await page.waitForTimeout(700);
          await page.screenshot({ path: join(root, `lab/screenshots/${battle}-${style}-${name}.jpg`), type: 'jpeg', quality: 80 });
        }
      }
    }
  }
  if(errors.length){ failed = true; console.log('CONSOLE ERRORS:\n' + [...new Set(errors)].slice(0, 20).join('\n')); }
} finally {
  await browser.close(); srv.kill();
}
console.log(failed ? 'FAIL' : 'OK');
process.exit(failed ? 1 : 0);
