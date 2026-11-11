// SPDX-License-Identifier: AGPL-3.0-or-later
// Core flow: demo data -> new session -> replay -> bracket order -> trade recorded.
import { expect, test, type Page } from '@playwright/test';
import { generateDemo, showWorkingOrders, stepUntil } from './helpers.js';

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
  await generateDemo(page);
  const form = page.locator('#new-session-form');
  await form.locator('input[name=name]').fill('E2E smoke');
  await expect(form.locator('input[name=name]')).toHaveValue('E2E smoke');
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
  // Fills on the next *practice* bar close (1m), not the next 20s source bar.
  await showWorkingOrders(page);
  await expect(page.getByTestId('orders')).toContainText(/buy/i);
  await page.getByTestId('tab-trades').click();
  const rows = page.getByTestId('trades-table').locator('tr:has(td)');
  await stepUntil(page, async () => {
    const pos = (await page.getByTestId('position').textContent()) ?? '';
    return /Long/.test(pos) || (await rows.count()) > 0;
  });

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
  await page.locator('#lang-picker').selectOption('zh-Hant');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hant');

  // Rail keeps the ticket, position, save points and drawings. Practice rules are the
  // strip above the chart; the full rule check is a bottom tab, not a side card.
  await expect(page.getByTestId('side').locator('h3')).toHaveText([
    '落單',
    '持倉',
    '存檔點',
    '繪圖物件',
  ]);
  await expect(page.getByTestId('tab-rulecheck')).toHaveText('規則檢查');
  const strip = page.getByTestId('rules-strip');
  await expect(strip).toBeVisible();
  await expect(strip).toHaveAttribute('aria-label', '練習規則');
  await expect(strip).toHaveClass(/docked/);
  await expect(page.getByTestId('rules')).toContainText('這個練習沒有設定規則');
  const beforeBox = (await strip.boundingBox())!;
  const grip = page.getByTestId('rules-strip-drag');
  const gripBox = (await grip.boundingBox())!;
  const chart = (await page.locator('.chart-body').first().boundingBox())!;
  await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(chart.x + chart.width * 0.72, chart.y + chart.height * 0.35, {
    steps: 8,
  });
  await page.mouse.up();
  await expect(strip).toHaveClass(/floating/);
  const floated = (await strip.boundingBox())!;
  expect(floated.x, 'drag moves the strip').toBeGreaterThan(beforeBox.x + 40);
  expect(floated.y, 'drag moves the strip down').toBeGreaterThan(beforeBox.y + 40);
  await grip.dblclick();
  await expect(strip).toHaveClass(/docked/);
  await expect(strip).not.toHaveClass(/floating/);

  expect(errors).toEqual([]);
});
