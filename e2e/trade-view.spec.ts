// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test, type Page, type Request } from '@playwright/test';
import { generateDemo, showWorkingOrders, stepUntil } from './helpers.js';

async function setup(page: Page, name: string, blind = false) {
  await page.goto('/');
  await generateDemo(page);
  const form = page.locator('#new-session-form');
  if (blind) {
    await form.getByTestId('ns-blind').check();
    await expect(form.locator('input[name=name]')).toHaveValue(/^Blind /);
    await expect(page.getByTestId('macro-blind-warn')).toBeVisible();
  }
  await form.locator('input[name=name]').fill(name);
  await form.locator('button[type=submit]').click();
  await expect(page.locator('.toolbar strong')).toHaveText(name);
  const list = await (await page.request.get('/api/sessions')).json();
  const id = list.sessions.find((s: { name: string }) => s.name === name).id;
  const read = async () => (await page.request.get(`/api/sessions/${id}`)).json();
  await page.getByTestId('btn-buy').click();
  await showWorkingOrders(page);
  await expect(page.getByTestId('orders')).toContainText('MKT');
  await stepUntil(page, async () => (await read()).state.trading.fills.length > 0);
  if ((await read()).state.trading.trades.length === 0) {
    await page.getByTestId('btn-flatten').click();
    await showWorkingOrders(page);
    await expect(page.getByTestId('orders')).toContainText('MKT');
    await stepUntil(page, async () => (await read()).state.trading.trades.length > 0);
  }
  await page.getByTestId('tab-trades').click();
  await expect(page.getByTestId('trades-view-1')).toBeVisible();
  return read;
}

test('trade and journal navigation preserves session state across pane/timeframe changes', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const read = await setup(page, 'Trade navigation');
  const start = await read();
  const cursor = start.state.cursor as number;
  const cursorTime = start.cursorTime as number;
  // +10 is ten 1m practice bars. On 20s data the cursor index moves 3 source bars
  // per bar (30) and the clock moves 60s per bar (600s), not one 20s print.
  // The fill's forming paint ignores a click until that candle finishes.
  const landed = async () => (await read()).state.cursor >= cursor + 30;
  let stepPosts = 0;
  const onStep = (r: Request) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/step')) stepPosts += 1;
  };
  page.on('request', onStep);
  const pressStep10 = async () => {
    const posts = stepPosts;
    await page.getByTestId('btn-step10').click();
    const deadline = Date.now() + 2000;
    while (stepPosts === posts && Date.now() < deadline) await page.waitForTimeout(50);
    return stepPosts > posts;
  };
  if (!(await pressStep10())) await pressStep10();
  page.off('request', onStep);
  await expect.poll(landed).toBe(true);
  expect((await read()).cursorTime).toBeGreaterThanOrEqual(cursorTime + 10 * 60);
  const before = await read();
  const chart = page.locator('.chart-body').first();
  const liveImage = await chart.screenshot();
  const writes: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/sessions') && r.method() !== 'GET') writes.push(r.url());
  });
  await page.getByTestId('trades-view-1').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('review-status')).toContainText('#1');
  await expect.poll(async () => (await chart.screenshot()).equals(liveImage)).toBe(false);
  await expect(page.getByTestId('btn-return-live')).toBeVisible();
  await page.getByTestId('tf-0').selectOption('300');
  await page.getByTestId('btn-split').click();
  await expect(page.getByTestId('tf-1')).toBeVisible();
  await page.getByTestId('tf-1').selectOption('60');
  await page.getByTestId('tab-journal').click();
  await page.getByTestId('journal-view-1').click();
  await expect(page.getByTestId('review-status')).toContainText('#1');
  await page.locator('#lang-picker').selectOption('zh-Hant');
  await expect(page.getByTestId('btn-return-live')).toContainText('返回');
  await page.getByTestId('btn-return-live').click();
  await expect(page.getByTestId('btn-return-live')).toBeHidden();
  await expect(page.getByTestId('review-status')).toHaveText('');
  expect(await read()).toEqual(before);
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
});

test('unrevealed blind sessions disable trade and journal navigation', async ({ page }) => {
  const read = await setup(page, 'Blind trade navigation', true);
  await expect(page.getByTestId('macro-blind-notice')).toBeVisible();
  const before = await read();
  await expect(page.getByTestId('trades-view-1')).toBeDisabled();
  await expect(page.getByTestId('trades-view-1')).toHaveAttribute('title', /Reveal/);
  await page.getByTestId('tab-journal').click();
  await expect(page.getByTestId('journal-view-1')).toBeDisabled();
  await expect(page.getByTestId('btn-return-live')).toBeHidden();
  expect(await read()).toEqual(before);
});
