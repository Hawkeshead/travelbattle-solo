#!/usr/bin/env node
// Guards the invariant that makes ES modules work here.
//
// Under ES modules an imported binding is READ-ONLY in the importing module.
// `import { x } from './m.js'; x = 5;` throws TypeError, and so do `x++`,
// `x += 1`, `x ??= 1` and `({ x } = obj)`. None of it is a parse error — it
// fails at runtime, on whatever line happens to execute first, which in a game
// might be a code path nobody exercises for weeks.
//
// This codebase used to reassign eleven shared variables across file
// boundaries. Each is now written only by the file that owns it, through an
// exported accessor. This check keeps it that way.
//
// It resolves scopes properly rather than pattern-matching, because several
// files legitimately declare a local with the same name as an import — for
// example `const canvas = document.getElementById('rotationPreviewCanvas')`
// inside a function, which shadows the imported `canvas` and is perfectly
// fine. A checker that flagged those would be turned off within a week.
//
// Run:  node tools/check-module-boundaries.mjs

import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Defaults to js/. Takes a directory argument so the test suite can point it
// at fixtures and prove it still catches what it is supposed to catch.
const jsDir = process.argv[2] ? join(process.cwd(), process.argv[2]) : join(root, 'js');

/** Collect the identifier names bound by a binding pattern. */
function patternNames(node, out) {
  if (!node) return;
  switch (node.type) {
    case 'Identifier': out.push(node.name); break;
    case 'ObjectPattern':
      for (const p of node.properties) patternNames(p.type === 'RestElement' ? p.argument : p.value, out);
      break;
    case 'ArrayPattern':
      for (const el of node.elements) patternNames(el, out);
      break;
    case 'AssignmentPattern': patternNames(node.left, out); break;
    case 'RestElement': patternNames(node.argument, out); break;
    case 'Property': patternNames(node.value, out); break;
  }
}

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

/**
 * Walk a module, tracking a scope chain, and report every assignment whose
 * target resolves to an imported binding in module scope.
 */
function findImportWrites(ast) {
  const violations = [];
  const imported = new Set();

  // Module-scope declarations. Imports go in first; anything else declared at
  // module scope with the same name would be a duplicate-binding SyntaxError,
  // so there is no ambiguity here.
  for (const node of ast.body) {
    if (node.type === 'ImportDeclaration') {
      for (const s of node.specifiers) imported.add(s.local.name);
    }
  }
  if (!imported.size) return violations;

  /** A scope is a Set of names it declares. */
  const scopes = [new Set(imported)];
  const declaredLocally = (name) => scopes.slice(1).some((s) => s.has(name));
  const resolvesToImport = (name) => imported.has(name) && !declaredLocally(name);

  // Hoist declarations into a scope before walking its body, so a `const`
  // declared later in a block still shadows for the whole block.
  function hoist(body, scope, { varsToo }) {
    const visitStatement = (node) => {
      if (!node || typeof node.type !== 'string') return;
      if (node.type === 'VariableDeclaration') {
        if (node.kind === 'var' && !varsToo) return;
        for (const d of node.declarations) {
          const names = [];
          patternNames(d.id, names);
          for (const n of names) scope.add(n);
        }
        return;
      }
      if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') {
        if (node.id) scope.add(node.id.name);
        return;
      }
      // `var` hoists through blocks and loops to the nearest function scope.
      if (varsToo) {
        for (const key of Object.keys(node)) {
          if (key === 'type' || key === 'start' || key === 'end') continue;
          const child = node[key];
          if (Array.isArray(child)) child.forEach(visitStatement);
          else if (child && typeof child.type === 'string' && !FUNCTION_TYPES.has(child.type)) {
            visitStatement(child);
          }
        }
      }
    };
    body.forEach(visitStatement);
  }

  function reportTarget(node) {
    if (!node) return;
    if (node.type === 'Identifier') {
      if (resolvesToImport(node.name)) violations.push({ name: node.name, start: node.start });
      return;
    }
    // Destructuring assignment target: ({ x } = o) / [x] = a
    const names = [];
    patternNames(node, names);
    for (const n of names) if (resolvesToImport(n)) violations.push({ name: n, start: node.start });
  }

  function walk(node) {
    if (!node || typeof node.type !== 'string') return;

    if (node.type === 'AssignmentExpression') {
      reportTarget(node.left);
      walk(node.right);
      // Still walk a destructuring left side for computed keys / defaults.
      if (node.left.type !== 'Identifier') walk(node.left);
      return;
    }

    if (node.type === 'UpdateExpression') {
      reportTarget(node.argument);
      return;
    }

    if (FUNCTION_TYPES.has(node.type)) {
      const scope = new Set();
      for (const p of node.params) {
        const names = [];
        patternNames(p, names);
        names.forEach((n) => scope.add(n));
      }
      if (node.id && node.type !== 'FunctionDeclaration') scope.add(node.id.name);
      if (node.body.type === 'BlockStatement') {
        hoist(node.body.body, scope, { varsToo: true });
      }
      scopes.push(scope);
      walk(node.body);
      scopes.pop();
      return;
    }

    if (node.type === 'BlockStatement') {
      const scope = new Set();
      hoist(node.body, scope, { varsToo: false });
      scopes.push(scope);
      node.body.forEach(walk);
      scopes.pop();
      return;
    }

    if (node.type === 'CatchClause') {
      const scope = new Set();
      if (node.param) {
        const names = [];
        patternNames(node.param, names);
        names.forEach((n) => scope.add(n));
      }
      scopes.push(scope);
      walk(node.body);
      scopes.pop();
      return;
    }

    if (node.type === 'ForStatement' || node.type === 'ForInStatement' || node.type === 'ForOfStatement') {
      const scope = new Set();
      const decl = node.init && node.init.type === 'VariableDeclaration' ? node.init : node.left;
      if (decl && decl.type === 'VariableDeclaration') {
        for (const d of decl.declarations) {
          const names = [];
          patternNames(d.id, names);
          names.forEach((n) => scope.add(n));
        }
      }
      scopes.push(scope);
      for (const key of ['init', 'test', 'update', 'left', 'right', 'body']) {
        if (node[key]) walk(node[key]);
      }
      scopes.pop();
      return;
    }

    // Don't descend into non-computed member properties or object keys —
    // `obj.state` and `{ state: 1 }` are not references to the binding.
    if (node.type === 'MemberExpression') {
      walk(node.object);
      if (node.computed) walk(node.property);
      return;
    }
    if (node.type === 'Property') {
      if (node.computed) walk(node.key);
      walk(node.value);
      return;
    }
    if (node.type === 'ImportDeclaration') return;

    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end') continue;
      const child = node[key];
      if (Array.isArray(child)) child.forEach(walk);
      else if (child && typeof child.type === 'string') walk(child);
    }
  }

  const moduleScope = new Set();
  hoist(ast.body, moduleScope, { varsToo: true });
  // Module-scope declarations do NOT shadow imports (that would be a duplicate
  // binding), so keep the module scope out of the shadow chain.
  ast.body.forEach(walk);

  return violations;
}

const files = (await readdir(jsDir)).filter((f) => f.endsWith('.js')).sort();
const all = [];
let importCount = 0;

for (const file of files) {
  const src = await readFile(join(jsDir, file), 'utf8');
  let ast;
  try {
    ast = acorn.parse(src, { ecmaVersion: 2023, sourceType: 'module' });
  } catch (err) {
    console.error(`js/${file}: parse error — ${err.message}`);
    process.exit(1);
  }
  importCount += ast.body.filter((n) => n.type === 'ImportDeclaration').reduce((a, n) => a + n.specifiers.length, 0);

  for (const v of findImportWrites(ast)) {
    const line = src.slice(0, v.start).split('\n').length;
    all.push({ file, line, name: v.name, text: src.split('\n')[line - 1].trim().slice(0, 90) });
  }
}

if (all.length) {
  console.error('\nAssignments to imported bindings:\n');
  for (const v of all) {
    console.error(`  js/${v.file}:${v.line}  writes to "${v.name}", which it imports`);
    console.error(`      ${v.text}`);
  }
  console.error(
    `\n${all.length} violation(s). An imported binding is read-only under ES modules,\n` +
      `so each of these throws a TypeError at runtime. Export an accessor from the\n` +
      `file that owns the value and call that instead — see setCell() in\n` +
      `js/data-core.js for the pattern.\n`
  );
  process.exit(1);
}

console.log(
  `Module boundary check passed — ${files.length} files, ${importCount} imported bindings, none written to.`
);
