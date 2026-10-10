// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';

async function freshSession(page: Page, name: string) {
  await page.goto('/');
  await page.click('#btn-demo');
  const form = page.locator('#new-session-form');
  await expect(form).toBeVisible();
  await expect(form.locator('input[name=name]')).not.toHaveValue('');
  await form.locator('input[name=name]').fill(name);
  await form.locator('input[name=pointValue]').fill('50');
  await form.locator('button[type=submit]').click();
  await expect(page.locator('#practice-root')).toBeVisible();
  const list = (await (await page.request.get('/api/sessions')).json()).sessions;
  const id = list.find((s: { name: string }) => s.name === name).id;
  return await (await page.request.get(`/api/sessions/${id}`)).json();
}
const money = (v: number) =>
  v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

test('risk ticket updates live, respects each side and never submits while editing', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const view = await freshSession(page, 'Risk preview');
  let writes = 0;
  page.on('request', (req) => {
    if (req.method() !== 'GET' && req.url().includes('/api/sessions')) writes++;
  });
  await expect(page.getByTestId('risk-buy')).toContainText('Set a stop distance');
  await page.getByTestId('qty').fill('2');
  await page.getByTestId('sl-ticks').fill('8');
  await page.getByTestId('tp-ticks').fill('16');
  const s = view.session.settings;
  const gross = 8 * s.tickSize * s.pointValue * 2;
  const commission = s.commissionPerContract * 4;
  const marketSlip = s.slippageTicks * s.tickSize * s.pointValue * 4;
  const loss = gross + commission + marketSlip;
  for (const side of ['buy', 'sell']) {
    await expect(page.getByTestId(`risk-${side}-price`)).toHaveText(money(gross));
    await expect(page.getByTestId(`risk-${side}-loss`)).toHaveText(money(loss));
    await expect(page.getByTestId(`risk-${side}-equity`)).toHaveText(
      `${((100 * loss) / s.startingBalance).toFixed(2)}%`,
    );
  }
  await page.getByTestId('qty').fill('3');
  await expect(page.getByTestId('risk-buy-loss')).toHaveText(money(loss * 1.5));
  await page.getByTestId('type-limit').click();
  await expect(page.getByTestId('risk-buy')).toContainText('Unavailable');
  await page.getByTestId('price').fill(String(view.state.trading.lastClose - 4 * s.tickSize));
  await expect(page.getByTestId('risk-buy-loss')).toHaveText(
    money((gross + commission + marketSlip / 2) * 1.5),
  );
  await expect(page.getByTestId('risk-sell')).toContainText('Unavailable');
  await page.getByTestId('tp-ticks').fill('');
  await expect(page.getByTestId('risk-buy-ratio')).toHaveText('–');
  await page.getByTestId('qty').fill('0');
  await expect(page.getByTestId('risk-buy')).toContainText('Unavailable');
  await page.getByTestId('qty').fill('2');
  await page.click('#lang-toggle');
  await expect(page.getByTestId('risk-preview')).toContainText('風險預覽');
  await expect(page.getByTestId('risk-preview')).toContainText('估算不保證損失上限');
  await expect(page.getByTestId('risk-buy-loss')).toHaveText(
    money(gross + commission + marketSlip / 2),
  );
  expect(writes).toBe(0);
  const after = await (await page.request.get(`/api/sessions/${view.session.id}`)).json();
  expect(after.state).toEqual(view.state);
  expect(errors).toEqual([]);
  await page.screenshot({ path: '/tmp/candledrill-risk-preview.png', fullPage: true });
});

test('working entries and open positions have explanatory unsupported previews', async ({
  page,
}) => {
  await freshSession(page, 'Risk position');
  await page.getByTestId('sl-ticks').fill('400');
  await page.getByTestId('btn-buy').click();
  await expect(page.getByTestId('orders')).toContainText('MKT');
  await expect(page.getByTestId('risk-buy')).toContainText('entry order is already working');
  await page.getByTestId('btn-step').click();
  await expect(page.getByTestId('position')).toContainText('Long');
  await expect(page.getByTestId('risk-buy')).toContainText('fresh entries from flat only');
  await expect(page.getByTestId('risk-buy-loss')).toHaveCount(0);
});
