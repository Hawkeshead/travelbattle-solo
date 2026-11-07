/* =========================================================
   3D BOARD CHECK (7 Nov 2026)

   Plays the real game in headless Chromium (WebGL through SwiftShader) with
   the 3D board on: the title screen, a Quick Battle through deployment into
   the first turns, a tap on a unit, the camera framing a shot. Fails on any
   console error or uncaught exception; prints the 3D board's readout; with
   --shots saves screenshots to docs/visual-record/3d/.

   Usage: node tools/lab/board3d-check.mjs [--shots] [--classic]
========================================================= */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const shots = process.argv.includes('--shots');
const classic = process.argv.includes('--classic');
const OUT = join(root, 'docs/visual-record/3d');
const PORT = 4181;
const srv = spawn('npx', ['--yes', 'http-server', '.', '-p', String(PORT), '--silent', '-c-1'], { cwd: root, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 2500));
const exe = existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {};
const browser = await chromium.launch(exe);
let failed = false;
const errors = [];
const shot = async (page, name) => { if(!shots) return; mkdirSync(OUT, { recursive: true }); await page.screenshot({ path: join(OUT, name + '.jpg'), type: 'jpeg', quality: 82 }); };
try {
  const ctx = await browser.newContext({ viewport: { width: 852, height: 393 }, deviceScaleFactor: shots ? 2 : 1, isMobile: true, hasTouch: true });
  await ctx.route(/fonts\.googleapis\.com|fonts\.gstatic\.com/, r => r.fulfill({ body: '', contentType: 'text/css' }));
  const page = await ctx.newPage();
  page.on('console', m => { if(m.type() === 'error' && !/Failed to load resource.*(fonts|telemetry)/i.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', e => errors.push('uncaught: ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 4).join('\n')));
  await page.goto(`http://127.0.0.1:${PORT}/${classic ? '?board=classic' : '?board=3d'}`);
  await page.locator('#titleMenu button').first().waitFor({ timeout: 60000 });
  await page.waitForTimeout(3000);
  const active = await page.evaluate(() => !!(window.__board3d && window.__board3d.active));
  console.log('3D board active:', active);
  if(!classic && !active) failed = true;
  await shot(page, '01-title');
  await page.getByRole('button', { name: 'Quick Battle' }).click();
  await page.locator('#modeChoices .side-flag[aria-label="Coalition"]').click();
  await page.locator('#modeChoices .brig-go').click();
  let deployedShot = false;
  const t0 = Date.now();
  for(let i = 0; Date.now() - t0 < 90000; i++){
    const badge = (await page.locator('#turnBadge').textContent().catch(() => '')) || '';
    if(/Turn|Move|Fire|Fight|Round|Your|AI/i.test(badge) && !/Deploy/i.test(badge)) break;
    const conf = page.locator('#endMoveBtn', { hasText: /^\s*Confirm/ });
    if(await conf.isVisible().catch(() => false)){ await conf.click(); continue; }
    const dep = page.locator('#armyPickerDeployBtn');
    if(await dep.isVisible().catch(() => false)){ await dep.click(); continue; }
    const end = page.locator('#endDeployBtn');
    if(await end.isVisible().catch(() => false) && await end.isEnabled().catch(() => false)){
      if(!deployedShot){ await page.waitForTimeout(800); await shot(page, '02-deployment'); deployedShot = true; }
      await end.click(); continue;
    }
    // Begin Battle on the phase seal, once both armies are down (pressed directly: the seal can sit under the dials)
    if(await page.evaluate(async () => { const st = (await import('/js/data-core.js')).state; const b = document.getElementById('beginBattleBtn'); if(st.phase === 'deploy' && st.deployPool && !st.deployPool.red.length && !st.deployPool.blue.length && b && b.style.display !== 'none' && document.getElementById('phaseDock').style.display === 'flex'){ b.click(); return true; } return false; })) continue;
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(2500);
  console.log('deploy state:', JSON.stringify(await page.evaluate(async () => { const st = (await import('/js/data-core.js')).state; const b = document.getElementById('beginBattleBtn'); return { phase: st.phase, deployTurn: st.deployTurn, pool: st.deployPool && { red: st.deployPool.red.length, blue: st.deployPool.blue.length }, begin: b && b.style.display, dock: document.getElementById('phaseDock').style.display, end: document.getElementById('endDeployBtn') && document.getElementById('endDeployBtn').style.display }; })));
  console.log('turn badge:', await page.locator('#turnBadge').textContent().catch(() => '?'));
  await shot(page, '03-battle');
  // tap one of our own units: it should be selected (the game's own tap handling, through the 3D camera)
  const picked = await page.evaluate(async () => {
    const b = window.__board3d; if(!b || !b.active) return 'classic';
    const mod = await import('/js/data-core.js');
    const st = mod.state;
    const mine = st.units.find(u => !u.removed && u.x >= 0 && u.side === (st.aiSide === 'red' ? 'blue' : 'red') && u.type !== 'BRIGADIER');
    if(!mine) return 'no unit';
    const p = b.project(mine.x, mine.y);
    return { id: mine.id, name: mine.historicalName || mine.type, x: p.x, y: p.y };
  });
  if(picked && picked.id){
    await page.mouse.click(picked.x, picked.y);
    await page.waitForTimeout(600);
    const sel = await page.evaluate(async () => (await import('/js/data-core.js')).state.selectedUnitId);
    console.log(`tapped ${picked.name}: selected ${sel === picked.id ? 'yes' : 'no (' + sel + ')'}`);
    if(sel !== picked.id) failed = true;
    await shot(page, '04-selected');
  } else console.log('tap check skipped:', picked);
  // a volley: the camera frames it, smoke goes up
  const framed = await page.evaluate(async () => {
    const b = window.__board3d; if(!b || !b.active) return null;
    const g = await import('/js/render-gunfire.js');
    const st = (await import('/js/data-core.js')).state;
    const a = st.units.find(u => !u.removed && u.x >= 0 && u.side === 'red' && u.type !== 'BRIGADIER');
    const t = st.units.filter(u => !u.removed && u.x >= 0 && u.side === 'blue').sort((p, q) => Math.hypot(p.x - a.x, p.y - a.y) - Math.hypot(q.x - a.x, q.y - a.y))[0];
    const d0 = b.rig.dist;
    g.spawnGunfire('musket', { x: a.x, y: a.y }, { x: t.x, y: t.y });
    await new Promise(r => setTimeout(r, 600));
    return { before: +d0.toFixed(1), after: +b.rig.dist.toFixed(1), smoke: b.smoke.count };
  });
  if(framed){ console.log('volley: camera distance', framed.before, '->', framed.after, ', smoke sprites', framed.smoke); if(!(framed.after < framed.before) || !framed.smoke) failed = true; await shot(page, '05-volley'); }
  await page.waitForTimeout(4500);
  const stats = await page.evaluate(() => window.__board3d && window.__board3d.stats);
  console.log('readout:', JSON.stringify(stats));
  if(!classic && (!stats || !stats.sprites)) failed = true;
  // the settings: switch to Classic and back
  if(!classic){
    await page.evaluate(() => window.__board3d.setBoard('classic'));
    await page.waitForTimeout(800);
    await shot(page, '06-classic-switch');
    await page.evaluate(() => window.__board3d.setBoard('3d'));
    await page.waitForTimeout(2500);
    const back = await page.evaluate(() => window.__board3d.active && window.__board3d.stats.sprites);
    console.log('back to 3D, figures drawn:', back);
  }
  if(errors.length){ failed = true; console.log('CONSOLE ERRORS:\n' + [...new Set(errors)].slice(0, 15).join('\n')); }
} finally {
  await browser.close(); srv.kill();
}
console.log(failed ? 'FAIL' : 'OK');
process.exit(failed ? 1 : 0);
