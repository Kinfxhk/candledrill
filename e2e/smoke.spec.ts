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

  // v1: ticket and position first so trading never needs a scroll; rule check, practice
  // rules, save points and drawings follow.
  await expect(page.getByTestId('side').locator('h3')).toHaveText([
    '落單',
    '持倉',
    '規則檢查',
    '練習規則',
    '存檔點',
    '繪圖物件',
  ]);
  await expect(page.getByTestId('macro-open')).toHaveText('半自動');
  await page.getByTestId('macro-open').click();
  await expect(page.getByTestId('tab-macro')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('tab-macro')).toHaveText('半自動交易');
  await expect(page.getByTestId('macro-step-rules')).toBeVisible();
  await expect(page.getByTestId('macro-goto-rules')).toHaveText('1 條件');
  await expect(page.getByTestId('macro-goto-run')).toHaveText('3 跑一轉');
  await expect(page.getByTestId('macro-indicator')).toBeVisible();
  await expect(page.getByTestId('macro-reaction')).toBeVisible();
  await expect(page.getByTestId('macro-add')).toHaveText('新增');
  await expect(page.getByTestId('macro-quick')).toContainText('快速套用');
  await expect(page.getByTestId('macro-next')).toBeVisible();
  await page.getByTestId('macro-next').click();
  await expect(page.getByTestId('macro-step-trade')).toBeVisible();
  await expect(page.getByTestId('macro-back')).toBeVisible();
  await page.getByTestId('macro-next').click();
  await expect(page.getByTestId('macro-step-run')).toBeVisible();
  await expect(page.getByTestId('macro-ready')).toContainText('就緒 — 可以回測或邊播邊跟');
  await expect(page.getByTestId('macro-from-start')).toHaveText('由頭');
  await expect(page.getByTestId('macro-from-cursor')).toHaveText('由而家');
  await expect(page.getByTestId('macro-run')).toHaveText('回測');
  await expect(page.getByTestId('macro-arm')).toHaveText('邊播邊跟');
  await page.getByTestId('macro-next').click();
  await expect(page.getByTestId('macro-step-result')).toBeVisible();
  await expect(page.getByTestId('macro-result')).toContainText('尚未回測');
  await expect(page.getByTestId('macro-go-run')).toHaveText('去跑一轉');

  expect(errors).toEqual([]);
});
