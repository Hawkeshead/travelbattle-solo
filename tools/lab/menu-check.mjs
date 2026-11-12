/* =========================================================
   IN-MATCH MENU CHECK (12 Nov 2026, Matthew: the volume sliders did nothing)

   Opens the real game in headless Chromium, starts a Quick Battle, opens the
   battle Menu, and works every control in it as a player would: the four
   volume sliders and Mute (reading the level each sound is really playing
   at, through AudioManager.debugLevels, not just the saved setting), Ambient
   Motion, Floating battle text, Battle Camera, Board, Graphics, Figures,
   Unit models, How to Play and Back to Main Menu (Cancel). Fails on any
   control that does not take effect or on any console error.

   Usage: node tools/lab/menu-check.mjs
========================================================= */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 4185;
const srv = spawn('npx', ['--yes', 'http-server', '.', '-p', String(PORT), '--silent', '-c-1'], { cwd: root, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 2500));
const exe = existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {};
const browser = await chromium.launch({ ...exe, args: ['--autoplay-policy=no-user-gesture-required'] });
const results = [];
const ok = (name, pass, detail = '') => { results.push({ name, pass }); console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); };
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 852, height: 393 }, isMobile: true, hasTouch: true });
  await ctx.route(/fonts\.googleapis\.com|fonts\.gstatic\.com/, r => r.fulfill({ body: '', contentType: 'text/css' }));
  const page = await ctx.newPage();
  page.on('console', m => { if(m.type() === 'error' && !/Failed to load resource.*(fonts|telemetry)|decode audio/i.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', e => errors.push('uncaught: ' + e.message));
  await page.goto(`http://127.0.0.1:${PORT}/?board=3d`);
  await page.locator('#titleMenu button').first().waitFor({ timeout: 60000 });
  await page.getByRole('button', { name: 'Quick Battle' }).click();   // a real tap: unlocks the audio
  await page.locator('#modeChoices .side-flag[aria-label="Coalition"]').click();
  await page.locator('#modeChoices .brig-go').click();
  // deploy the army the picker offers, so nothing covers the menu
  await page.locator('#armyPickerDeployBtn').waitFor({ state: 'visible', timeout: 120000 });
  await page.locator('#armyPickerDeployBtn').click();
  await page.waitForTimeout(1500);
  await page.evaluate(async () => { window.__am = (await import('/js/audio-manager.js')).AudioManager; });
  // make sure there is music and ambience playing to measure
  await page.evaluate(() => { const a = window.__am; if(!a.debugMusicElement()) a.playMusic('audio/music/field-of-austerlitz.mp3'); if(!a.debugAmbienceElement()) a.playAmbience('audio/ambience/countryside.mp3'); });
  const levels = () => page.evaluate(() => window.__am.debugLevels());
  console.log('playing:', JSON.stringify(await levels()));
  // open the battle Menu
  await page.locator('#logIconBtn').click();
  await page.locator('#logTabMenu').click();
  await page.waitForTimeout(400);
  const setSlider = async (id, v) => { await page.locator('#' + id).scrollIntoViewIfNeeded(); await page.locator('#' + id).fill(String(v)); await page.waitForTimeout(150); };
  // the four sliders: each must move the sound it names
  const L0 = await levels();
  ok('music and ambience go through Web Audio gains', L0.musicRouted && L0.ambienceRouted, JSON.stringify(L0));
  await setSlider('musicVolumeSlider', 20);
  const L1 = await levels();
  ok('Music slider lowers the music', L1.music < L0.music - 0.05, `${L0.music.toFixed(3)} -> ${L1.music.toFixed(3)}`);
  ok('Music slider leaves the ambience', Math.abs(L1.ambience - L0.ambience) < 1e-3);
  await setSlider('ambienceVolumeSlider', 10);
  const L2 = await levels();
  ok('Ambience slider lowers the ambience', L2.ambience < L1.ambience - 0.05, `${L1.ambience.toFixed(3)} -> ${L2.ambience.toFixed(3)}`);
  await setSlider('masterVolumeSlider', 50);
  const L3 = await levels();
  ok('Master slider lowers both', L3.music < L2.music && L3.ambience < L2.ambience, JSON.stringify(L3));
  await setSlider('effectsVolumeSlider', 30);
  const fx = await page.evaluate(() => window.__am.getPrefs().volumes.effects);
  ok('Effects slider sets the effects level', Math.abs(fx - 0.3) < 1e-6, String(fx));
  await page.locator('#muteToggle').check();
  await page.waitForTimeout(150);
  const L4 = await levels();
  ok('Mute silences music and ambience', L4.music === 0 && L4.ambience === 0, JSON.stringify(L4));
  await page.locator('#muteToggle').uncheck();
  await page.waitForTimeout(150);
  const L5 = await levels();
  ok('Unmute brings them back', L5.music > 0 && L5.ambience > 0, JSON.stringify(L5));
  // the menu shows the saved levels when reopened
  await page.locator('#logTabReport').click(); await page.locator('#logTabMenu').click(); await page.waitForTimeout(200);
  const shown = await page.evaluate(() => ['masterVolumeSlider', 'musicVolumeSlider', 'effectsVolumeSlider', 'ambienceVolumeSlider'].map(id => document.getElementById(id).value).join(','));
  ok('reopened menu shows the levels set', shown === '50,20,30,10', shown);
  // the display toggles
  const flip = async (id, read) => { const before = await page.evaluate(read); await page.locator('#' + id).scrollIntoViewIfNeeded(); await page.locator('#' + id).click(); await page.waitForTimeout(150); const after = await page.evaluate(read); await page.locator('#' + id).click(); await page.waitForTimeout(150); const back = await page.evaluate(read); return [before, after, back]; };
  let r = await flip('ambientToggle', () => localStorage.getItem('fc:ambientMotion') || localStorage.getItem('fc_ambient') || [...Object.keys(localStorage)].filter(k => /ambient/i.test(k)).map(k => localStorage.getItem(k)).join());
  ok('Ambient Motion toggles', r[0] !== r[1] && r[0] === r[2] || r[1] !== r[2], JSON.stringify(r));
  r = await flip('fctToggle', () => [...Object.keys(localStorage)].filter(k => /fct|floating/i.test(k)).map(k => localStorage.getItem(k)).join());
  ok('Floating battle text toggles', r[1] !== r[2], JSON.stringify(r));
  r = await flip('cameraToggle', async () => (await import('/js/render-board.js')).CameraPref.enabled);
  ok('Battle Camera toggles', r[0] !== r[1] && r[0] === r[2], JSON.stringify(r));
  // board settings
  await page.locator('#figuresSelect').selectOption('large'); await page.waitForTimeout(200);
  ok('Figures: Large', await page.evaluate(async () => (await import('/js/board3d.js')).figuresPref() === 'large'));
  await page.locator('#figuresSelect').selectOption('small');
  await page.locator('#graphicsSelect').selectOption('high'); await page.waitForTimeout(2500);
  const hi = await page.evaluate(() => ({ q: window.__board3d.quality, sprites: window.__board3d.stats.sprites, aa: window.__board3d.renderer.getContext().getContextAttributes().antialias, canvases: document.querySelectorAll('#board3d').length }));
  ok('Graphics: High rebuilds the board, smoothed edges', hi.q === 'high' && hi.sprites > 0 && hi.aa === true && hi.canvases === 1, JSON.stringify(hi));
  await page.locator('#graphicsSelect').selectOption('low'); await page.waitForTimeout(2500);
  const lo = await page.evaluate(() => ({ q: window.__board3d.quality, sprites: window.__board3d.stats.sprites, aa: window.__board3d.renderer.getContext().getContextAttributes().antialias }));
  ok('Graphics: Low', lo.q === 'low' && lo.sprites > 0 && lo.aa === false, JSON.stringify(lo));
  await page.locator('#boardSelect').selectOption('classic'); await page.waitForTimeout(1000);
  const cl = await page.evaluate(() => ({ active: window.__board3d.active, rows: [...document.querySelectorAll('[data-board3d-only]')].map(r => r.style.display).join() }));
  ok('Board: Classic turns 3D off and hides its rows', !cl.active && cl.rows === 'none,none', JSON.stringify(cl));
  await page.locator('#boardSelect').selectOption('3d'); await page.waitForTimeout(2500);
  ok('Board: 3D turns it back on', await page.evaluate(() => window.__board3d.active));
  await page.locator('#unitModelsSelect').selectOption('classic'); await page.waitForTimeout(300);
  ok('Unit models: Classic', await page.evaluate(async () => (await import('/js/render-figures.js')).unitModels() === 'classic'));
  await page.locator('#unitModelsSelect').selectOption('animated');
  // the buttons
  await page.locator('#backToMenuBtn').scrollIntoViewIfNeeded(); await page.locator('#backToMenuBtn').click(); await page.waitForTimeout(200);
  ok('Back to Main Menu asks first', await page.locator('#backToMenuConfirm').isVisible());
  await page.locator('#backToMenuConfirmNo').click(); await page.waitForTimeout(200);
  ok('Cancel keeps the battle', !(await page.locator('#backToMenuConfirm').isVisible()));
  await page.locator('#howToPlayBtn').scrollIntoViewIfNeeded(); await page.locator('#howToPlayBtn').click(); await page.waitForTimeout(800);
  ok('How to Play opens', await page.evaluate(() => !!document.querySelector('.htp-overlay, #howToPlay, [class*="htp"]:not(.htp-open)')));
  if(errors.length) ok('no console errors', false, [...new Set(errors)].slice(0, 6).join(' | '));
} finally {
  await browser.close(); srv.kill();
}
const bad = results.filter(r => !r.pass).length;
console.log(bad ? `FAIL (${bad})` : 'OK');
process.exit(bad ? 1 : 0);
