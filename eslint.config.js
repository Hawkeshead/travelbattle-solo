// Deliberately minimal.
//
// This config is not here to enforce a style. It is here to catch the one class
// of bug that the move from global scripts to ES modules makes easy to write
// and hard to notice: a reference to a name that doesn't exist in scope.
//
// Under the old global-script setup, every function could see every other
// file's variables, so a typo or a deleted declaration usually still resolved
// to *something*. Under modules it throws ReferenceError — at runtime, on
// whatever line happens to execute first. `node --check` doesn't catch it,
// because it's valid syntax.
//
// Rules that are only about taste are left off on purpose. Adding them would
// mean a wall of warnings on working code, and a check people learn to ignore
// is worse than no check at all.

import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      'test-results/**',
      'playwright-report/**',
      // Throwaway probes, never committed — see .gitignore.
      'tests/probe-*.spec.js',
    ],
  },

  // The game itself: ES modules running in a browser.
  {
    files: ['js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        // Attached deliberately in js/ui-battle.js and js/dice.js — see the
        // comments there for why they have to be reachable from global scope.
        toggleUnitBio: 'writable',
        __tbTest: 'writable',
      },
    },
    rules: {
      ...js.configs.recommended.rules,

      // The rule this config exists for.
      'no-undef': 'error',

      // The other genuine-bug rules from `recommended` are kept. These few are
      // relaxed because they fire on deliberate, working patterns in this
      // codebase rather than on mistakes.
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // The remaining two audio files are still classic scripts — unplugged from
  // the game and not converted to modules (audio-manager.js has been, see the
  // general js/**/*.js rule above). Lint these as scripts so `no-undef`
  // doesn't flag the cross-file references that are valid in that world.
  {
    files: ['js/audio-catalog.js', 'js/audio-hooks.js'],
    languageOptions: { sourceType: 'script' },
    rules: { 'no-undef': 'off' },
  },

  // Repo tooling and tests run in Node.
  //
  // The browser globals are included for the test files on purpose: the bodies
  // of page.evaluate() and addInitScript() callbacks are serialised and run
  // inside the browser, so `document` and `localStorage` are genuinely in scope
  // there even though the surrounding file is Node.
  {
    files: ['tools/**/*.mjs', 'test/**/*.js', 'tests/**/*.js', '*.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['warn', { args: 'none' }],
    },
  },
];
