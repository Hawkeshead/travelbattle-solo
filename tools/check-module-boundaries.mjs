#!/usr/bin/env node
// Guards the invariant that makes ES modules possible here.
//
// Under ES modules an imported binding is READ-ONLY in the importing module.
// `import { x } from './m.js'; x = 5;` is a TypeError, and so is `x++`.
//
// This codebase used to reassign eleven shared variables across file
// boundaries. Each one was replaced with an accessor exported by the file that
// owns the variable. This check makes sure none of them creep back, and that
// new ones don't appear.
//
// Run:  node tools/check-module-boundaries.mjs

import { readFile, readdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const jsDir = join(root, 'js');

// Shared bindings and the single file allowed to write each one.
const OWNER = {
  state: 'data-core.js',
  ROWS: 'data-core.js',
  CELL: 'data-core.js',
  uidCounter: 'data-core.js',
  unitAnimations: 'render-board.js',
  activeActionLine: 'render-board.js',
  deathEffects: 'render-board.js',
  mapGestureMoved: 'render-board.js',
  highlightCells: 'render-units.js',
  selectedDeployType: 'ui-deployment.js',
  dragState: 'ui-deployment.js',
  undoStack: 'engine-state.js',
  historicalSlotCounters: 'engine-state.js',
  FAST_DICE_MODE: 'dice.js',
};

/** Strip comments and string literals so we only match real code. */
function stripNonCode(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

const files = (await readdir(jsDir)).filter((f) => f.endsWith('.js')).sort();
const violations = [];

for (const file of files) {
  const raw = await readFile(join(jsDir, file), 'utf8');
  const lines = stripNonCode(raw).split('\n');

  for (const [symbol, owner] of Object.entries(OWNER)) {
    if (basename(file) === owner) continue;

    // Assignment (`x =` but not `==`, `===`, `<=`, `!=`, `>=`) or an
    // increment/decrement, where x is not preceded by a dot or an identifier
    // character (so `obj.state = 1` and `myState = 1` don't match).
    const assign = new RegExp(`(?<![.\\w$])${symbol}\\s*(?:=(?!=)|\\+\\+|--|[+\\-*/]=)`);
    // Declarations are fine — a local of the same name shadows harmlessly.
    const declare = new RegExp(`\\b(?:let|const|var|function)\\s+${symbol}\\b`);

    lines.forEach((line, i) => {
      if (declare.test(line)) return;
      if (!assign.test(line)) return;
      violations.push({ file, line: i + 1, symbol, owner, text: line.trim().slice(0, 90) });
    });
  }
}

if (violations.length) {
  console.error('\nCross-file writes to shared bindings:\n');
  for (const v of violations) {
    console.error(`  js/${v.file}:${v.line}  writes "${v.symbol}", owned by js/${v.owner}`);
    console.error(`      ${v.text}`);
  }
  console.error(
    `\n${violations.length} violation(s). Under ES modules an imported binding is read-only,\n` +
      `so each of these throws a TypeError at runtime. Add an accessor function to the\n` +
      `owning file and call that instead.\n`
  );
  process.exit(1);
}

console.log(
  `Module boundary check passed — ${Object.keys(OWNER).length} shared bindings, ` +
    `each written only by its owning file.`
);
