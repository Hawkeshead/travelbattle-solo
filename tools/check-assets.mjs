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
