// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';

// A tiny, deterministic dummy dataset on the local in-memory test server.
async function setup(page: Page, name: string, rule: 'passed' | 'breached' | 'finished') {
  const { token, header } = await (await page.request.get('/api/token')).json();
  const post = async (url: string, data: unknown) => {
    const response = await page.request.post(url, { data, headers: { [header]: token } });
    expect(response.ok()).toBe(true);
    return response.json();
  };
  const adverse = rule === 'breached';
  const csv = [
    'Date,Time,Open,High,Low,Close,Volume',
    '2026-01-05,09:30,100,101,99,100,10',
    '2026-01-05,09:31,100,101,99,100,10',
    adverse ? '2026-01-05,09:32,100,101,97,98,10' : '2026-01-05,09:32,100,103,99,102,10',
    adverse ? '2026-01-05,09:33,98,99,97,98,10' : '2026-01-05,09:33,102,104,101,103,10',
  ].join('\n');
  const { dataset } = await post('/api/datasets/import', {
    name,
    symbol: 'DUMMY',
    tickSize: 0.25,
    csv,
    options: { mapping: { time: 0, timeOfDay: 1, open: 2, high: 3, low: 4, close: 5, volume: 6 } },
  });
  const created = await post('/api/sessions', {
    datasetId: dataset.id,
    name,
    startTime: dataset.firstTime + 60,
    settings: {
      tickSize: 0.25,
      pointValue: 1,
      commissionPerContract: 0,
      slippageTicks: 0,
      startingBalance: 50000,
      dailyLossLimit: adverse ? 1 : null,
      trailingDrawdown: null,
      profitTarget: rule === 'passed' ? 1 : null,
      utcOffsetMinutes: 0,
      dayStartMinutes: 0,
    },
  });
  await page.goto('/');
  await page.getByTestId(`open-session-${created.session.id}`).click();
  await expect(page.locator('.toolbar strong')).toHaveText(name);
  const read = async () => (await page.request.get(`/api/sessions/${created.session.id}`)).json();
  return read;
}

for (const status of ['passed', 'breached'] as const) {
  test(`${status} presents a dismissible read-only completion summary`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const read = await setup(page, `Summary ${status}`, status);
    await expect(page.getByTestId('completion-summary')).toBeHidden();
    await page.getByTestId('sl-ticks').fill('40');
    await page.getByTestId('tp-ticks').fill('');
    await page.getByTestId('btn-buy').click();
    await expect(page.getByTestId('orders')).toContainText('MKT');
    await page.getByTestId('btn-step').click();
    await expect.poll(async () => (await read()).state.trading.position !== null).toBe(true);
    await page.getByTestId('btn-step').click();
    await expect.poll(async () => (await read()).state.status).toBe(status);
    await expect(page.getByTestId('completion-details')).toBeVisible();
    await expect(page.getByTestId('summary-trade-1')).toContainText('Lowest net P&L');
    await expect(page.getByTestId('summary-trade-1')).toContainText('Largest MAE');
    const before = await read();
    const writes: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/sessions') && r.method() !== 'GET') writes.push(r.url());
    });
    await page.getByTestId('btn-summary').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('completion-details')).toHaveCount(0);
    await page.click('#lang-toggle');
    await expect(page.getByTestId('completion-details')).toHaveCount(0);
    await page.getByTestId('btn-summary').click();
    await expect(page.getByTestId('completion-details')).toContainText('已平倉淨盈虧');
    await page.getByTestId('summary-journal').click();
    await expect(page.getByTestId('tab-journal')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('journal-table')).toBeVisible();
    expect(await read()).toEqual(before);
    expect(writes).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test('end-of-data summary separates an open position from closed-trade results', async ({
  page,
}) => {
  const read = await setup(page, 'Summary open', 'finished');
  await page.getByTestId('sl-ticks').fill('40');
  await page.getByTestId('tp-ticks').fill('');
  await page.getByTestId('btn-buy').click();
  await expect(page.getByTestId('orders')).toContainText('MKT');
  await page.getByTestId('btn-step10').click();
  await expect.poll(async () => (await read()).state.status).toBe('finished');
  await expect(page.getByTestId('summary-open')).toContainText('unrealized P&L 3.00');
  await expect(page.getByTestId('completion-details')).toContainText('No closed trades');
  await expect(page.getByTestId('summary-highlights')).toHaveCount(0);
  expect((await read()).state.trading.position.qty).toBe(1);
});

test('a completed no-trade session can show and hide its summary', async ({ page }) => {
  await setup(page, 'Summary empty', 'finished');
  await page.getByTestId('btn-step10').click();
  await expect(page.getByTestId('completion-details')).toContainText('No closed trades');
  await expect(page.getByTestId('summary-open')).toHaveCount(0);
  await page.getByTestId('btn-summary').click();
  await expect(page.getByTestId('completion-details')).toHaveCount(0);
  await page.getByTestId('btn-summary').click();
  await expect(page.getByTestId('completion-details')).toBeVisible();
});
