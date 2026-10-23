// SPDX-License-Identifier: AGPL-3.0-or-later
// v1.0: rewind and save points, rule profiles, phone trade bar, disclosure placement.
import { expect, test, type Page } from '@playwright/test';
import { generateDemo, stepUntil } from './helpers.js';

async function sessionState(page: Page) {
  const list = await (await page.request.get('/api/sessions')).json();
  const id = list.sessions[0].id as number;
  return (await page.request.get(`/api/sessions/${id}`)).json();
}

async function newSession(page: Page, name: string) {
  await generateDemo(page);
  const form = page.locator('#new-session-form');
  await form.locator('input[name=name]').fill(name);
  await form.locator('button[type=submit]').click();
  await expect(page.locator('#practice-root')).toBeVisible();
}

test('rewind undoes an order and its fills; a save point restores the exact state', async ({
  page,
}) => {
  await page.goto('/');
  await newSession(page, 'E2E rewind');
  for (let i = 0; i < 3; i++) await page.getByTestId('btn-step10').click();
  const start = await sessionState(page);
  await page.getByTestId('btn-checkpoint').click();
  await expect(page.getByTestId('checkpoints').locator('li')).toHaveCount(1);
  await page.getByTestId('btn-buy').click();
  await stepUntil(page, async () => (await sessionState(page)).state.trading.fills.length > 0);
  for (let i = 0; i < 3; i++) await page.getByTestId('btn-step10').click();
  const later = await sessionState(page);
  expect(later.state.trading.fills.length).toBeGreaterThan(0);

  // Back: one action at a time, never ahead of the current bar.
  await page.getByTestId('btn-back').click();
  await expect
    .poll(async () => (await sessionState(page)).state.cursor)
    .toBeLessThan(later.state.cursor);

  // Save point: back to the exact state before the order.
  await page.getByTestId('cp-go-1').click();
  await expect.poll(async () => (await sessionState(page)).state.cursor).toBe(start.state.cursor);
  const restored = await sessionState(page);
  expect(restored.state.trading.fills).toEqual(start.state.trading.fills);
  // Bars sent to the browser never pass the restored cursor.
  expect(restored.bars.at(-1).time).toBe(restored.cursorTime);
});

test('rule profile: create, use on a session, live rule check', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('profile-new').click();
  const dialog = page.getByTestId('profile-dialog');
  await dialog.locator('input[name=name]').fill('E2E 50K rules');
  await dialog.locator('input[name=accountSize]').fill('50000');
  await dialog.locator('input[name=profitTarget]').fill('3000');
  await dialog.locator('input[name=dailyLoss]').fill('1000');
  await dialog.locator('input[name=maxContracts]').fill('1');
  await dialog.getByTestId('profile-save').click();
  await expect(page.getByTestId('profile-list').locator('li')).toHaveCount(1);

  await generateDemo(page);
  const form = page.locator('#new-session-form');
  const id = await page.evaluate(
    () => JSON.parse(localStorage.getItem('candledrill.profiles.v1')!)[0].id as string,
  );
  await page.getByTestId('ns-profile').selectOption(id);
  // The engine fields are filled from the profile.
  await expect(form.locator('input[name=target]')).toHaveValue('3000');
  await expect(form.locator('input[name=dailyLoss]')).toHaveValue('1000');
  await form.locator('input[name=name]').fill('E2E profile');
  await form.locator('button[type=submit]').click();

  const check = page.getByTestId('rule-check');
  await expect(check).toContainText('E2E 50K rules');
  await expect(check.locator('[data-rule=maxContracts]')).toHaveAttribute('data-state', 'pass');
  // Break the contract cap: two contracts.
  await page.getByTestId('qty').fill('2');
  await page.getByTestId('btn-buy').click();
  await stepUntil(page, async () => (await sessionState(page)).state.trading.fills.length > 0);
  await expect(check.locator('[data-rule=maxContracts]')).toHaveAttribute('data-state', 'fail');
  await expect(page.getByTestId('rule-overall')).toHaveClass(/fail/);
  // The engine settings came from the profile.
  const view = await sessionState(page);
  expect(view.session.settings.profitTarget).toBe(3000);
  expect(view.session.settings.dailyLossLimit).toBe(1000);
});

test('phone: chart first, trade bar buys and flattens, drawer holds the rail', async ({
  browser,
}) => {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  await page.goto('/');
  await newSession(page, 'E2E phone');
  await expect(page.getByTestId('trade-bar')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const chart = await page.locator('.chart-body').first().boundingBox();
  expect(chart!.height).toBeGreaterThan(844 * 0.45);
  await page.getByTestId('tb-qty').fill('1');
  await page.getByTestId('tb-buy').click();
  for (let i = 0; i < 24 && !(await sessionState(page)).state.trading.position; i++)
    await page.getByTestId('tb-step').click();
  expect((await sessionState(page)).state.trading.position.qty).toBe(1);
  await page.getByTestId('tb-flatten').click();
  for (let i = 0; i < 24 && (await sessionState(page)).state.trading.position; i++)
    await page.getByTestId('tb-step').click();
  expect((await sessionState(page)).state.trading.position).toBeNull();
  // The rail is a drawer on phones.
  const side = page.getByTestId('side');
  expect((await side.boundingBox())!.x).toBeGreaterThanOrEqual(390);
  await page.getByTestId('btn-sheet').click();
  await expect.poll(async () => (await side.boundingBox())!.x).toBeLessThan(390);
  await ctx.close();
});

test('affiliate disclosure sits in About and the footer, never next to order entry', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('#about-open').click();
  const rec = page.getByTestId('recommendations');
  await expect(rec).toContainText(/commission/i);
  await expect(rec).toContainText(/not investment advice/i);
  const link = page.getByTestId('referral-link');
  await expect(link).toHaveAttribute('href', 'https://linktr.ee/kinfx');
  await expect(link).toHaveAttribute('rel', /sponsored/);
  await expect(page.getByTestId('disclosure')).not.toHaveAttribute('open', '');
  await page.keyboard.press('Escape');
  await newSession(page, 'E2E disclosure');
  await expect(page.locator('[data-testid=side] a[href*="linktr.ee"]')).toHaveCount(0);
  await expect(page.locator('[data-testid=trade-bar] a[href*="linktr.ee"]')).toHaveCount(0);
});

test('drawing tools: fib and measure, object list hides and locks', async ({ page }) => {
  await page.goto('/');
  await newSession(page, 'E2E tools');
  for (let i = 0; i < 6; i++) await page.getByTestId('btn-step10').click();
  const body = (await page.locator('.chart-body').first().boundingBox())!;
  const tool = async (name: string) => {
    const toggle = page.getByTestId('drawing-palette-toggle').first();
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    await page.getByTestId(`palette-${name}`).first().click();
  };
  await tool('fib');
  await page.mouse.click(body.x + body.width * 0.3, body.y + body.height * 0.3);
  await page.mouse.click(body.x + body.width * 0.6, body.y + body.height * 0.6);
  await expect(page.locator('[data-kind=fib-level]')).toHaveCount(7);
  await tool('measure');
  await page.mouse.click(body.x + body.width * 0.4, body.y + body.height * 0.5);
  await page.mouse.click(body.x + body.width * 0.55, body.y + body.height * 0.35);
  await expect(page.locator('[data-testid^=measure-]')).toHaveText(/\dt.*bars/);
  const objects = page.getByTestId('objects').locator('li[data-object]');
  await expect(objects).toHaveCount(2);
  // Hide the fib: its levels go away, the drawing stays saved.
  await objects.first().locator('button').first().click();
  await expect(page.locator('[data-kind=fib-level]')).toHaveCount(0);
  const saved = (await sessionState(page)).session.drawings as { kind: string }[];
  expect(saved.map((d) => d.kind).sort()).toEqual(['fib', 'measure']);
});

test('review tab, custom hotkey and trailing stop', async ({ page }) => {
  await page.goto('/');
  // Settings: trail 4 ticks, rebind Buy to "k".
  await page.getByTestId('settings-open').click();
  const dlg = page.getByTestId('settings-dialog');
  await dlg.locator('input[name=trailTicks]').fill('4');
  await dlg.locator('[data-key-action=buy]').click();
  await page.keyboard.press('k');
  await expect(dlg.locator('[data-key-action=buy]')).toHaveText('K');
  await dlg.getByTestId('settings-save').click();

  await newSession(page, 'E2E trail');
  for (let i = 0; i < 3; i++) await page.getByTestId('btn-step10').click();
  await page.getByTestId('sl-ticks').fill('40');
  await page.getByTestId('tp-ticks').fill('');
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('k');
  await stepUntil(page, async () => (await sessionState(page)).state.trading.position !== null);
  const stopPrice = async () =>
    (
      (await sessionState(page)).state.trading.orders as {
        role: string;
        status: string;
        price: number;
      }[]
    ).find((o) => o.role === 'stop-loss' && o.status === 'working')?.price;
  const first = await stopPrice();
  expect(first).toBeDefined();
  // Step until the trailing rule tightens the stop. A tightened stop is logged as a user
  // modification of the stop-loss order (same path as dragging it).
  let moved = false;
  for (let i = 0; i < 120 && !moved; i++) {
    await page.getByTestId('btn-step').click();
    const now = await stopPrice();
    if (now === undefined) break; // stopped out before price ran far enough
    moved = now > first!;
  }
  const mods = ((await sessionState(page)).state.trading.modifications ?? []) as unknown[];
  if (moved) expect(mods.length).toBeGreaterThan(0);
  else expect((await sessionState(page)).state.trading.position).toBeNull();
  // Close and look at the review tab.
  if ((await sessionState(page)).state.trading.position) {
    await page.getByTestId('btn-flatten').click();
    await stepUntil(page, async () => (await sessionState(page)).state.trading.position === null);
  }
  await page.getByTestId('tab-review').click();
  await expect(page.getByTestId('equity-svg')).toBeVisible();
  await page.getByTestId('mc-run').click();
  await expect(page.getByTestId('mc-result')).not.toBeEmpty();
});

test('Back after Play rewinds the whole run, even with a trailing stop moving', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByTestId('settings-open').click();
  const dlg = page.getByTestId('settings-dialog');
  await dlg.locator('input[name=trailTicks]').fill('2');
  await dlg.getByTestId('settings-save').click();
  await newSession(page, 'E2E play undo');
  for (let i = 0; i < 3; i++) await page.getByTestId('btn-step10').click();
  await page.getByTestId('sl-ticks').fill('60');
  await page.getByTestId('btn-buy').click();
  await stepUntil(page, async () => (await sessionState(page)).state.trading.position !== null);
  const before = (await sessionState(page)).state.cursor as number;
  await page.getByTestId('btn-play').click();
  await expect
    .poll(async () => (await sessionState(page)).state.cursor, { timeout: 15000 })
    .toBeGreaterThan(before + 40);
  await page.getByTestId('btn-play').click(); // pause
  await page.waitForTimeout(300);
  await page.getByTestId('btn-back').click();
  await expect.poll(async () => (await sessionState(page)).state.cursor).toBe(before);
});
