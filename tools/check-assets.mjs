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

const jsFiles = (await readdir(join(root, 'js')))
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

  for (const [, path] of text.matchAll(PATH_RE)) {
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

console.log(`Asset check passed — ${seen.size} references checked, all present.`);
