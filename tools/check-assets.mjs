#!/usr/bin/env node
// Verifies that every repo-relative asset path referenced from index.html or
// js/*.js actually exists on disk.
//
// A mistyped portrait or audio path is the most likely way to break the live
// game, and it fails silently in the browser. This catches it in under a
// second, with no dependencies.

import { readFile, readdir, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Matches quoted repo-relative paths into the asset directories.
const PATH_RE = /['"`](?:\.\/)?((?:assets|audio|data|js)\/[A-Za-z0-9._/-]+\.[a-z0-9]{2,5})['"`]/g;

const jsFiles = (await readdir(join(root, 'js'), { recursive: true }))
  .filter((f) => f.endsWith('.js'))
  .map((f) => `js/${f}`);

const sources = ['index.html', ...jsFiles];

const missing = [];
const seen = new Set();

for (const src of sources) {
  let text;
  try {
    text = await readFile(join(root, src), 'utf8');
  } catch {
    console.error(`Could not read source file: ${src}`);
    process.exitCode = 1;
    continue;
  }

  const CSS_URL_RE = /url\(\s*(?:\.\/)?((?:assets|audio)\/[A-Za-z0-9._/-]+\.[a-z0-9]{2,5})\s*\)/g;
  for (const [, path] of [...text.matchAll(PATH_RE), ...text.matchAll(CSS_URL_RE)]) {
    const key = `${src}::${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      await access(join(root, path));
    } catch {
      missing.push({ src, path });
    }
  }
}

/* The v2 terrain art is loaded by pattern (grass_1..6 and so on) rather than
   by literal path, so the pattern above cannot see it. Every file the v2 board
   will ask for is listed here from the same counts the game uses. */
{
  const v2 = await import(new URL('../js/terrain-v2.js', import.meta.url));
  const want = [];
  for (let i = 1; i <= v2.GRASS_PLAIN_COUNT; i++) want.push(`assets/terrain/v2/grass/grass_${i}.webp`);
  for (const f of v2.GRASS_DETAIL_FILES) want.push(`assets/terrain/v2/grass/detail/${f}.webp`);
  for (let i = 1; i <= v2.HILL_COUNT; i++) want.push(`assets/terrain/v2/hill/hill_${i}.webp`);
  for (let i = 1; i <= v2.FARM_COUNT; i++) want.push(`assets/terrain/v2/farm/farm_${i}.webp`);
  for (let i = 1; i <= v2.WOODS_COUNT; i++) want.push(`assets/terrain/v2/woods/woods_${i}.webp`);
  for (let i = 1; i <= 6; i++) want.push(`assets/terrain/v2/building/building_${i}.webp`);
  want.push('assets/terrain/v2/effects/crater.webp');
  want.push('assets/terrain/v2/effects/death_skull.webp');
  for (const path of want) {
    seen.add(`terrain-v2::${path}`);
    try { await access(join(root, path)); } catch { missing.push({ src: 'js/terrain-v2.js (v2 terrain set)', path }); }
  }
}

/* Painted bird sheets (js/ambient-layer.js BIRD_SHEETS): a webp and its json each. */
for (const name of ['partridge', 'goose', 'buzzard']) {
  for (const ext of ['webp', 'json']) {
    const path = `assets/ambient/birds/${name}.${ext}`;
    seen.add(`birds::${path}`);
    try { await access(join(root, path)); } catch { missing.push({ src: 'js/ambient-layer.js (painted birds)', path }); }
  }
}

/* Unit figure sheets (js/render-figures.js) are named by pattern from each
   unit type's sidecar JSON: every anim x facing it lists must exist, for both
   nations. */
{
  const { readFile: rf } = await import('node:fs/promises');
  const types = ['INFANTRY', 'GUARD', 'LIGHT_CAV', 'HEAVY_CAV', 'ARTILLERY', 'ARTILLERY_GUN'];
  for (const nation of ['british', 'french']) for (const t of types) {
    const metaPath = `assets/units/${nation}/${t}/${t}.json`;
    let meta = null;
    try { meta = JSON.parse(await rf(join(root, metaPath), 'utf8')); } catch { missing.push({ src: 'js/render-figures.js (unit sidecar)', path: metaPath }); continue; }
    seen.add(`figures::${metaPath}`);
    for (const anim of Object.keys(meta.anims || {})) for (const facing of (meta.facings || [])) {
      const path = `assets/units/${nation}/${t}/${anim}_${facing}.webp`;
      seen.add(`figures::${path}`);
      try { await access(join(root, path)); } catch { missing.push({ src: 'js/render-figures.js (unit figures)', path }); }
    }
  }
}

/* Pixel unit sheets (js/render-figures.js, the Animated unit models): named
   {anim}_{facing}_v{variant}.webp, every anim x facing x variant the sidecar
   lists, for every nation in js/nations.js (its 'art' folder). */
{
  const { readFile: rf } = await import('node:fs/promises');
  const { NATIONS } = await import(new URL('../js/nations.js', import.meta.url));
  const types = ['INFANTRY', 'GUARD', 'GUARD_BEARER', 'ARTILLERY', 'ARTILLERY_GUN', 'LIGHT_CAV', 'HEAVY_CAV', 'BRIGADIER'];
  for (const nation of new Set(Object.values(NATIONS).map(n => n.art).filter(Boolean))) for (const t of types) {
    const metaPath = `assets/units-pixel/${nation}/${t}/${t}.json`;
    let meta = null;
    try { meta = JSON.parse(await rf(join(root, metaPath), 'utf8')); } catch { missing.push({ src: 'js/render-figures.js (pixel sidecar)', path: metaPath }); continue; }
    seen.add(`pixel::${metaPath}`);
    for (const anim of Object.keys(meta.anims || {})) for (const facing of (meta.facings || [])) for (let v = 0; v < (meta.variants || 1); v++) {
      const path = `assets/units-pixel/${nation}/${t}/${anim}_${facing}_v${v}.webp`;
      seen.add(`pixel::${path}`);
      try { await access(join(root, path)); } catch { missing.push({ src: 'js/render-figures.js (pixel units)', path }); }
    }
  }
}

/* The gunfire and smoke frames are named by pattern too (js/render-gunfire.js
   builds the list; it imports nothing that needs a browser at load time). */
{
  const smoke = await import(new URL('../js/render-gunfire.js', import.meta.url)).catch(() => null);
  const list = smoke ? smoke.smokeFileList() : [];
  if(!smoke) missing.push({ src: 'js/render-gunfire.js', path: '(could not load the smoke file list)' });
  for (const path of list) {
    seen.add(`smoke::${path}`);
    try { await access(join(root, path)); } catch { missing.push({ src: 'js/render-gunfire.js (smoke art)', path }); }
  }
}

/* The dice art is also loaded by pattern (js/dice-art.js). */
{
  const dice = await import(new URL('../js/dice-art.js', import.meta.url));
  for (const path of dice.diceArtPaths()) {
    seen.add(`dice-art::${path}`);
    try { await access(join(root, path)); } catch { missing.push({ src: 'js/dice-art.js (dice art)', path }); }
  }
}

if (missing.length) {
  console.error('\nMissing asset files referenced in source:\n');
  for (const { src, path } of missing) {
    console.error(`  ${path}`);
    console.error(`      referenced by ${src}`);
  }
  console.error(`\n${missing.length} missing file(s).\n`);
  process.exit(1);
}

/* =========================================================
   THE ASSET MANIFEST (assets-manifest.json), written from what is checked
   above, never kept by hand. Every file under assets/ and audio/ with its size
   and a tier, plus the app shell (the page, the code and the data) that the
   service worker (sw.js) keeps for offline play:
     1  needed by any battle: preloaded and decoded during the title screen;
        a battle waits for these (js/asset-loader.js)
     2  soon: preloaded after tier 1, never waited for
     3  rare or legacy: never preloaded, still fetched on demand
   A file the code refers to that no tier rule covers fails this check, so a
   new kind of asset has to be placed deliberately. Run on every deploy (CI)
   so the manifest always matches the build.
========================================================= */
const TIER_RULES = [
  // 3: rare or legacy
  ['assets/terrain/v1/', 3], ['assets/units/', 3], ['audio/music/', 3],
  // 1: any battle
  ['assets/terrain/v2/', 1], ['assets/terrain/', 3], ['assets/tutorial/', 3], ['assets/units-pixel/', 1], ['assets/dice/', 1], ['assets/ui/menu/', 2], ['assets/ui/', 1],
  ['assets/brigadiers/', 1], ['assets/icons/status/', 1], ['audio/effects/', 1], ['audio/ui/', 1],
  // 2: soon
  ['assets/portraits/', 2], ['assets/icons/', 2], ['assets/ambient/', 2], ['audio/ambience/', 2],
];
export const tierOf = path => { for (const [pre, t] of TIER_RULES) if (path.startsWith(pre)) return t; return null; };
{
  const { readdir: rd, stat, writeFile } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const referenced = new Set([...seen].map(k => k.split('::').pop()).filter(p => /^(assets|audio)\//.test(p)));
  const untiered = [...referenced].filter(p => tierOf(p) == null);
  if (untiered.length) {
    console.error('\nReferenced asset files with no tier (add a rule to TIER_RULES in tools/check-assets.mjs):\n');
    for (const p of untiered.sort()) console.error('  ' + p);
    process.exit(1);
  }
  const walk = async dir => (await rd(join(root, dir), { recursive: true, withFileTypes: true }))
    .filter(d => d.isFile()).map(d => join(d.parentPath || d.path, d.name).slice(root.length + 1).split('\\').join('/'));
  const SKIP = /(\.md|\.txt|\.py|\.DS_Store)$/i;
  const files = [];
  for (const top of ['assets', 'audio']) for (const p of (await walk(top)).sort()) {
    if (SKIP.test(p)) continue;
    // Not referenced anywhere: legacy, kept loadable but never preloaded.
    const t = referenced.has(p) ? tierOf(p) : 3;
    // h: a short fingerprint of the contents, so the service worker can keep
    // a file that has not changed across builds instead of fetching it again.
    const h = createHash('sha1').update(await readFile(join(root, p))).digest('hex').slice(0, 10);
    files.push({ path: p, bytes: (await stat(join(root, p))).size, tier: t, h });
  }
  // The app shell: network-first in the service worker, kept for offline play.
  const shell = ['index.html', 'favicon.png',
    ...(await walk('js')).filter(p => p.endsWith('.js')).sort(),
    ...(await walk('data')).filter(p => p.endsWith('.json') && !p.startsWith('data/matches/')).sort()];
  const total = t => files.filter(f => f.tier === t).reduce((n, f) => n + f.bytes, 0);
  const manifest = { generated: 'tools/check-assets.mjs', tiers: { 1: total(1), 2: total(2), 3: total(3) }, shell, files };
  await writeFile(join(root, 'assets-manifest.json'), JSON.stringify(manifest, null, 0).replace(/\},\{/g, '},\n{') + '\n');
  const mb = b => (b / 1048576).toFixed(1) + ' MB';
  console.log(`Asset manifest written: tier 1 ${mb(total(1))}, tier 2 ${mb(total(2))}, tier 3 ${mb(total(3))} (${files.length} files, ${shell.length} shell)`);
}

console.log(`Asset check passed — ${seen.size} references checked, all present.`);
