// SPDX-License-Identifier: AGPL-3.0-or-later
// Core flow: demo data -> new session -> replay -> bracket order -> trade recorded.
import { expect, test, type Page } from '@playwright/test';

async function sessionState(page: Page) {
  const list = await (await page.request.get('/api/sessions')).json();
  const id = list.sessions[0].id as number;
  return (await page.request.get(`/api/sessions/${id}`)).json();
}

test('replay and bracket order flow', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/');

  // Required third-party attribution is visible with a link to tradingview.com.
  const attribution = page.locator('#chart-attribution');
  await expect(attribution).toContainText('TradingView Lightweight Charts');
  await expect(attribution.locator('a[href="https://www.tradingview.com/"]')).toBeVisible();

  // Synthetic demo data (never real market data) and a new session.
  await page.click('#btn-demo');
  const form = page.locator('#new-session-form');
  await expect(form).toBeVisible();
  await form.locator('input[name=name]').fill('E2E smoke');
  await form.locator('button[type=submit]').click();
  await expect(page.locator('#practice-root')).toBeVisible();

  // Replay: stepping moves the clock forward and never reveals future bars.
  const clock = page.getByTestId('clock');
  const before = await clock.textContent();
  await page.getByTestId('btn-step').click();
  await expect(clock).not.toHaveText(before ?? '');
  const view = await sessionState(page);
  const lastBar = view.bars.at(-1);
  expect(lastBar.time).toBe(view.cursorTime);

  // Market buy with a stop-loss and take-profit bracket.
  await page.getByTestId('sl-ticks').fill('16');
  await page.getByTestId('tp-ticks').fill('16');
  await page.getByTestId('btn-buy').click();
  // The order fills on the NEXT bar (never on the bar it was placed on).
  await expect(page.getByTestId('orders')).toContainText(/buy/i);
  await page.getByTestId('btn-step').click();
  const rows = page.getByTestId('trades-table').locator('tr:has(td)');
  await expect
    .poll(async () => {
      const pos = (await page.getByTestId('position').textContent()) ?? '';
      return /Long/.test(pos) || (await rows.count()) > 0;
    })
    .toBe(true);

  // Step until the bracket resolves into a closed trade.
  for (let i = 0; i < 30 && (await rows.count()) === 0; i++) {
    await page.getByTestId('btn-step10').click();
    await page.waitForTimeout(100);
  }
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(/Stop-loss|Take-profit/);

  // Stats tab renders and the language toggle switches to Traditional Chinese.
  await page.getByTestId('tab-stats').click();
  await expect(page.getByTestId('stats')).toBeVisible();
  await page.click('#lang-toggle');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hant');

  expect(errors).toEqual([]);
});
