// End-to-end smoke tests.
//
// These exist to make the ES module conversion provable rather than hopeful.
// They drive the real game in a real browser and assert that it boots, that the
// script load order resolved, and that a match can actually be started and
// played into the deployment phase.
//
// Run with:  npx playwright test

import { test, expect } from '@playwright/test';

/** Collect console errors and uncaught exceptions for the life of a page. */
function watchForErrors(page) {
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`uncaught: ${e.message}`));
  return errors;
}

test('the game boots cleanly and reaches the title screen', async ({ page }) => {
  const errors = watchForErrors(page);

  await page.goto('/');

  // The title splash rendered, which means all six data/*.json files loaded and
  // every script evaluated in a workable order.
  await expect(page.locator('#overlayTitle')).toHaveText('TravelBattle');
  await expect(page.locator('#overlaySubtitle')).toBeVisible();

  // The data-loading failure page did NOT replace the document.
  await expect(page.getByText('Field Command failed to load')).toHaveCount(0);

  // The mode buttons were built by showModeSelect(), so boot.js ran to completion.
  await expect(page.locator('#modeChoices button').first()).toBeVisible();

  // The board canvas exists and sizeCanvas() gave it real dimensions.
  const box = await page.locator('#board').boundingBox();
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);

  expect(errors, `errors during boot:\n${errors.join('\n')}`).toEqual([]);
});

test('every game global the inline handlers depend on is reachable', async ({ page }) => {
  await page.goto('/');

  // ui-battle.js injects onclick="toggleUnitBio()" via innerHTML. Inline
  // handlers resolve against the global scope, so this function MUST stay on
  // window even after modularization or unit histories silently stop opening.
  const reachable = await page.evaluate(() => typeof window.toggleUnitBio === 'function');
  expect(reachable, 'window.toggleUnitBio must remain globally reachable').toBe(true);
});

test('a hotseat match starts and reaches deployment', async ({ page }) => {
  const errors = watchForErrors(page);

  await page.goto('/');

  // Start a hotseat game.
  await page.getByRole('button', { name: 'Hotseat (2 players)' }).click();

  // Board setup rolls a d6 per side for table orientation. On a 4-6 the player
  // is asked to choose, so between zero and two rotation prompts appear. Accept
  // whatever orientation is offered until deployment opens.
  const roster = page.locator('#rosterList');
  const confirmOrientation = page.getByRole('button', { name: 'Confirm This Orientation' });

  for (let i = 0; i < 4; i++) {
    if ((await roster.locator('.roster-chip').count()) > 0) break;
    if (await confirmOrientation.isVisible().catch(() => false)) {
      await confirmOrientation.click();
      continue;
    }
    await page.waitForTimeout(300);
  }

  // Deployment is live: the roster is showing placeable units.
  await expect(roster.locator('.roster-chip').first()).toBeVisible({ timeout: 10_000 });

  // The engine agrees we are in the deploy phase. `state` is read as a bare
  // identifier rather than via `window`: today it is a top-level `let`, which
  // lives in the global lexical scope and is NOT a property of window.
  const phase = await page.evaluate(() => (typeof state !== 'undefined' ? state.phase : null));
  expect(phase).toBe('deploy');

  expect(errors, `errors during match start:\n${errors.join('\n')}`).toEqual([]);
});

test('the board is usable on a phone-sized viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  await expect(page.locator('#overlayTitle')).toBeVisible();

  // Nothing may overflow horizontally — the page must never scroll sideways.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow, 'page scrolls horizontally on a 390px viewport').toBeLessThanOrEqual(0);
});
