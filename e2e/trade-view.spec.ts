// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
import { generateDemo } from './helpers.js';

async function setup(page: Page, name: string, blind = false) {
  await page.goto('/');
  await generateDemo(page);
  const form = page.locator('#new-session-form');
  if (blind) {
    await form.getByTestId('ns-blind').check();
    await expect(form.locator('input[name=name]')).toHaveValue(/^Blind /);
  }
  await form.locator('input[name=name]').fill(name);
  await form.locator('button[type=submit]').click();
  await expect(page.locator('.toolbar strong')).toHaveText(name);
  const list = await (await page.request.get('/api/sessions')).json();
  const id = list.sessions.find((s: { name: string }) => s.name === name).id;
  const read = async () => (await page.request.get(`/api/sessions/${id}`)).json();
  await page.getByTestId('btn-buy').click();
  await expect(page.getByTestId('orders')).toContainText('MKT');
  await page.getByTestId('btn-step').click();
  await expect.poll(async () => (await read()).state.trading.fills.length).toBeGreaterThan(0);
  if ((await read()).state.trading.trades.length === 0) {
    await page.getByTestId('btn-flatten').click();
    await expect(page.getByTestId('orders')).toContainText('MKT');
    await page.getByTestId('btn-step').click();
  }
  await expect(page.getByTestId('trades-view-1')).toBeVisible();
  return read;
}

test('trade and journal navigation preserves session state across pane/timeframe changes', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const read = await setup(page, 'Trade navigation');
  const cursor = (await read()).state.cursor;
  await page.getByTestId('btn-step10').click();
  await expect.poll(async () => (await read()).state.cursor).toBe(cursor + 10);
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
  await page.click('#lang-toggle');
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
  const before = await read();
  await expect(page.getByTestId('trades-view-1')).toBeDisabled();
  await expect(page.getByTestId('trades-view-1')).toHaveAttribute('title', /Reveal/);
  await page.getByTestId('tab-journal').click();
  await expect(page.getByTestId('journal-view-1')).toBeDisabled();
  await expect(page.getByTestId('btn-return-live')).toBeHidden();
  expect(await read()).toEqual(before);
});
