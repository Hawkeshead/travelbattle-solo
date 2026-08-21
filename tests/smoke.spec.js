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

test('a match starts and reaches deployment', async ({ page }) => {
  const errors = watchForErrors(page);

  await page.goto('/');

  // Hotseat is temporarily removed from the home menu (still fully working
  // underneath, see beginBoardSetup() — just not offered here for now), so
  // this exercises the same "does board setup reach deployment" path via the
  // vs-AI entry point instead.
  await page.getByRole('button', { name: 'vs AI Opponent' }).click();
  await page.getByRole('button', { name: 'Play Britain' }).click();
  await page.getByRole('button', { name: 'Easy' }).click();

  await clearBoardSetup(page);
  const roster = page.locator('#rosterList');

  // Deployment is live: the roster is showing placeable units.
  await expect(roster.locator('.roster-chip').first()).toBeVisible({ timeout: 10_000 });

  // The engine agrees we are in the deploy phase. Asserted through the UI
  // rather than by reading game state: since the ES module conversion, `state`
  // is module-scoped and deliberately not reachable from the page context.
  // Testing what the player can see is the better contract anyway.
  await expect(page.locator('#turnBadge')).toHaveText(/^Deploying:/);

  expect(errors, `errors during match start:\n${errors.join('\n')}`).toEqual([]);
});

/**
 * Click a board cell by its internal coordinates.
 *
 * The click handler divides the canvas rect by COLS/ROWS, then maps screen row
 * to board row through sy(). sy() only flips when the human is playing France,
 * and these tests always pick Britain, so screen row == board row here.
 */
async function clickCell(page, bx, by, { cols = 20, rows = 10 } = {}) {
  const rect = await page.locator('#board').boundingBox();
  await page.mouse.click(
    rect.x + ((bx + 0.5) * rect.width) / cols,
    rect.y + ((by + 0.5) * rect.height) / rows
  );
}

/**
 * Clear the board-setup sequence until the roster appears.
 *
 * Board setup is now a chain of dice rolls (a roll for orientation order, then
 * a roll for each side's right to rotate — each several seconds of flicker-
 * then-fade before the result is even known) rather than the one-or-two quick
 * rotation prompts this used to be, so this needs real patience, not a couple
 * of quick polls. It also has to handle the Army Picker screen, which can
 * appear the moment it becomes a human side's turn to deploy — "Deploy
 * Manually Instead" keeps this test exercising the original manual roster
 * flow rather than needing to know about Army compositions at all.
 */
async function clearBoardSetup(page) {
  const confirmOrientation = page.getByRole('button', { name: 'Confirm This Orientation' });
  const deployManually = page.getByRole('button', { name: 'Deploy Manually Instead' });
  const firstChip = page.locator('#rosterList .roster-chip').first();
  for (let i = 0; i < 40; i++) {
    // isVisible(), not count() — renderRoster() populates the roster chips
    // before the Army Picker overlay ever gets a chance to show on top of
    // them, so the chips already exist (just hidden) the whole time the
    // Picker is up. count() alone would report "deployment has started" the
    // instant those hidden chips exist, well before the Picker is actually
    // dismissed.
    if (await firstChip.isVisible().catch(() => false)) return;
    if (await confirmOrientation.isVisible().catch(() => false)) {
      await confirmOrientation.click();
      continue;
    }
    if (await deployManually.isVisible().catch(() => false)) {
      await deployManually.click();
      continue;
    }
    await page.waitForTimeout(400);
  }
}

test('a full vs-AI deployment completes for both sides', async ({ page }) => {
  // A full 3-Brigade deployment with the AI alternating turns was already a
  // longer-running test before this; the board-setup dice-roll sequence now
  // adds several more real seconds before deployment even starts, so the
  // default 30s test timeout no longer leaves enough room for the deployment
  // loop itself.
  test.setTimeout(60_000);
  const errors = watchForErrors(page);

  await page.goto('/');

  // vs AI -> Play Britain -> Easy. This is the path that pulls in
  // ai-deployment.js and ai-strategy.js, the most interconnected files in the
  // codebase and the ones the other tests never touch.
  await page.getByRole('button', { name: 'vs AI Opponent' }).click();
  await page.getByRole('button', { name: 'Play Britain' }).click();
  await page.getByRole('button', { name: 'Easy' }).click();

  await clearBoardSetup(page);
  await expect(page.locator('#rosterList .roster-chip').first()).toBeVisible({ timeout: 10_000 });

  const confirmBrigade = page.locator('#confirmBrigadeBtn');
  const endDeploy = page.locator('#endDeployBtn');

  // Britain deploys along rows 8-9. Place units left to right, skipping any
  // square the rules reject (terrain restrictions, occupancy), confirming each
  // Brigade and letting the AI take its alternating turns in between.
  const candidates = [];
  for (const by of [9, 8]) for (let bx = 2; bx < 18; bx++) candidates.push([bx, by]);

  let next = 0;
  for (let step = 0; step < 90; step++) {
    if (await endDeploy.isEnabled().catch(() => false)) break;

    // Wait out the AI's turn.
    const title = (await page.locator('#rosterTitle').textContent()) ?? '';
    if (!title.startsWith('Britain')) {
      await page.waitForTimeout(300);
      continue;
    }

    if (await confirmBrigade.isEnabled().catch(() => false)) {
      await confirmBrigade.click();
      continue;
    }

    const chip = page.locator('#rosterList .roster-chip').first();
    if (!(await chip.isVisible().catch(() => false))) {
      await page.waitForTimeout(200);
      continue;
    }
    await chip.click();

    if (next >= candidates.length) break;
    const [bx, by] = candidates[next++];
    await clickCell(page, bx, by);
  }

  // Both armies are on the board and the battle can begin.
  await expect(endDeploy).toBeEnabled({ timeout: 20_000 });

  // The AI actually placed units rather than stalling silently mid-deployment,
  // which is the failure mode that makes the Operations unplayable.
  const aiConfirms = await page
    .locator('#log .entry')
    .filter({ hasText: /France's Brigade \d is fully deployed/ })
    .count();
  expect(aiConfirms, 'the AI never finished a Brigade').toBe(3);

  expect(errors, `errors during AI deployment:\n${errors.join('\n')}`).toEqual([]);
});

test('resuming a saved campaign into a branch choice does not crash', async ({ page }) => {
  const errors = watchForErrors(page);

  // Seed a saved campaign sitting on flow step 1 of Flanders, which is a
  // branch — the player is about to choose their next Operation.
  await page.addInitScript(() => {
    localStorage.setItem(
      'tbCampaignProgress',
      JSON.stringify({
        campaignId: 'flanders',
        flowIndex: 1,
        lastWinner: 'red',
        record: ['red'],
        mode: 'hotseat',
        aiSide: null,
        aiDifficulty: 'medium',
      })
    );
  });

  await page.goto('/');

  // This boot path goes straight from boot.js into the campaign screens and
  // never passes through showModeSelect, which is the only other thing that
  // builds #modeChoices. Before ensureModeChoices() existed, the branch screen
  // threw "Cannot set properties of null" here and the game died on load.
  await expect(page.locator('#modeChoices button').first()).toBeVisible({ timeout: 10_000 });

  // Both branch options are offered, the locked one included.
  const labels = await page.locator('#modeChoices button').allTextContents();
  expect(labels.length).toBeGreaterThanOrEqual(2);

  expect(errors, `errors resuming a campaign:\n${errors.join('\n')}`).toEqual([]);
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

test('the Army Picker deploys the chosen Army correctly', async ({ page }) => {
  test.setTimeout(90_000); // board-orientation dice sequence plus polling for the Picker can genuinely take a while, more so on a loaded CI runner than locally
  const errors = watchForErrors(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'vs AI Opponent' }).click();
  await page.getByRole('button', { name: 'Play Britain' }).click();
  await page.getByRole('button', { name: 'Hard' }).click();

  // Waits out the board-orientation dice sequence (which can take a real
  // while) specifically for the Army Picker to appear — it only shows the
  // very first time it becomes Britain's turn to deploy, which depending on
  // who's rolled first for orientation and who deploys first could be
  // immediately or only after the AI finishes its own Brigades.
  const confirmOrientation = page.getByRole('button', { name: 'Confirm This Orientation' });
  const armyPicker = page.locator('#armyPickerPanel');
  let pickerShown = false;
  for (let i = 0; i < 90; i++) {
    if (await confirmOrientation.isVisible().catch(() => false)) {
      await confirmOrientation.click();
    }
    const cls = await armyPicker.getAttribute('class');
    if (cls !== null && !cls.includes('hidden')) { pickerShown = true; break; }
    await page.waitForTimeout(500);
  }
  expect(pickerShown, 'Army Picker never appeared for a fresh standard match').toBe(true);

  const armyName = await page.locator('#armyPickerName').textContent();
  await page.locator('#armyPickerDeployBtn').click();

  // Deployment completed in one shot — the roster panel should now be back
  // to normal deployment state (Britain's Brigade 1 area, or already handed
  // off to France if Britain went first and finished instantly).
  await expect(page.locator('#turnBadge')).toHaveText(/^Deploying:/, { timeout: 10_000 });

  // At least Britain's own units are actually on the board, not just the
  // Picker's own preview state — the auto-deploy genuinely placed them.
  const britishUnitsLogged = await page
    .locator('#log .entry')
    .filter({ hasText: /Britain deploys/ })
    .count();
  expect(britishUnitsLogged, `Army Picker (${armyName}) did not actually deploy any units`).toBeGreaterThan(0);

  expect(errors, `errors deploying via Army Picker:\n${errors.join('\n')}`).toEqual([]);
});

test('the Army Picker View Map toggle works without breaking the flow', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = watchForErrors(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'vs AI Opponent' }).click();
  await page.getByRole('button', { name: 'Play Britain' }).click();
  await page.getByRole('button', { name: 'Hard' }).click();

  const confirmOrientation = page.getByRole('button', { name: 'Confirm This Orientation' });
  const armyPicker = page.locator('#armyPickerPanel');
  let pickerShown = false;
  for (let i = 0; i < 90; i++) {
    if (await confirmOrientation.isVisible().catch(() => false)) {
      await confirmOrientation.click();
    }
    const cls = await armyPicker.getAttribute('class');
    if (cls !== null && !cls.includes('hidden')) { pickerShown = true; break; }
    await page.waitForTimeout(500);
  }
  expect(pickerShown, 'Army Picker never appeared').toBe(true);

  await page.locator('#armyPickerViewMapBtn').click();
  await expect(armyPicker).toHaveClass(/viewingMap/);
  await expect(page.locator('#armyPickerCards')).toBeHidden();

  // The board itself is genuinely visible underneath, not just the toggle
  // having flipped a class with nothing to actually show.
  await expect(page.locator('#board')).toBeVisible();

  await page.locator('#armyPickerViewMapBtn').click();
  await expect(armyPicker).not.toHaveClass(/viewingMap/);
  await expect(page.locator('#armyPickerCards')).toBeVisible();

  expect(errors, `errors toggling View Map:\n${errors.join('\n')}`).toEqual([]);
});
