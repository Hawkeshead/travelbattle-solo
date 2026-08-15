// Tests for the repository checks themselves.
//
// A guard nobody has tested is worse than no guard: it reports success and
// everyone believes it. The module-boundary check in particular is the only
// thing standing between this codebase and a whole class of runtime
// TypeErrors, so it needs to be held to the same standard as the game code.
//
// Run with:  node --test "test/*.test.js"

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECKER = join(root, 'tools', 'check-module-boundaries.mjs');

/** Run the checker against a directory of fixture files. */
function runChecker(files) {
  const dir = mkdtempSync(join(tmpdir(), 'tb-boundaries-'));
  try {
    writeFileSync(join(dir, 'owner.js'), 'export let value = 1;\nexport const CONST = 2;\n');
    for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, name), source);
    try {
      const stdout = execFileSync('node', [CHECKER, dir], { cwd: '/', encoding: 'utf8' });
      return { code: 0, output: stdout };
    } catch (err) {
      return { code: err.status, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const IMPORT = "import { value, CONST } from './owner.js';\n";

test('accepts a file that only reads its imports', () => {
  const r = runChecker({ 'clean.js': `${IMPORT}export function f(){ return value + CONST; }\n` });
  assert.equal(r.code, 0, r.output);
});

test('catches a plain assignment to an import', () => {
  const r = runChecker({ 'bad.js': `${IMPORT}export function f(){ value = 5; }\n` });
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /writes to "value"/);
});

test('catches an assignment split across lines', () => {
  const r = runChecker({ 'bad.js': `${IMPORT}export function f(){ value\n  = 5; }\n` });
  assert.equal(r.code, 1, r.output);
});

test('catches destructuring assignment to an import', () => {
  const r = runChecker({ 'bad.js': `${IMPORT}export function f(){ ({ value } = { value: 1 }); }\n` });
  assert.equal(r.code, 1, r.output);
});

test('catches logical and compound assignment', () => {
  for (const op of ['??=', '||=', '&&=', '+=', '-=']) {
    const r = runChecker({ 'bad.js': `${IMPORT}export function f(){ value ${op} 1; }\n` });
    assert.equal(r.code, 1, `${op} was not caught:\n${r.output}`);
  }
});

test('catches increment and decrement', () => {
  for (const src of ['value++', 'value--', '++value', '--value']) {
    const r = runChecker({ 'bad.js': `${IMPORT}export function f(){ ${src}; }\n` });
    assert.equal(r.code, 1, `${src} was not caught:\n${r.output}`);
  }
});

test('catches an array-destructuring assignment', () => {
  const r = runChecker({ 'bad.js': `${IMPORT}export function f(){ [value] = [1]; }\n` });
  assert.equal(r.code, 1, r.output);
});

// The other half of the job. Several files in this codebase legitimately
// declare a local with the same name as something they import — for example
// `const canvas = document.getElementById(...)` inside a function. A checker
// that flagged those would be switched off within a week.
test('allows a local declaration that shadows an import', () => {
  const cases = {
    'const in a function': `${IMPORT}export function f(){ const value = 1; return value; }\n`,
    'let reassigned locally': `${IMPORT}export function f(){ let value = 1; value = 2; return value; }\n`,
    'function parameter': `${IMPORT}export function f(value){ value = 2; return value; }\n`,
    'destructured parameter': `${IMPORT}export function f({ value }){ value = 2; return value; }\n`,
    'catch binding': `${IMPORT}export function f(){ try { g(); } catch(value){ value = 1; } }\n`,
    'for-of binding': `${IMPORT}export function f(){ for(const value of [1]){ } }\n`,
    'block-scoped const': `${IMPORT}export function f(){ { const value = 1; return value; } }\n`,
    'array destructuring declaration': `${IMPORT}export function f(){ const [value] = [1]; return value; }\n`,
  };
  for (const [label, source] of Object.entries(cases)) {
    const r = runChecker({ 'shadow.js': source });
    assert.equal(r.code, 0, `false positive on ${label}:\n${r.output}`);
  }
});

test('property access is not a write to the binding', () => {
  const r = runChecker({
    'props.js': `${IMPORT}export function f(){ value.x = 1; const o = { value: 2 }; o.value = 3; return o; }\n`,
  });
  assert.equal(r.code, 0, r.output);
});
