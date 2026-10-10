// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { generateDemo } from './helpers.js';

test('optional discipline shows a bilingual pause while flatten and replay remain available', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto('/');
  await generateDemo(page);
  const form = page.locator('#new-session-form');
  await expect(form.locator('[name=maxDailyTradeCycles]')).toHaveValue('');
  await expect(form.locator('[name=maxConsecutiveLosses]')).toHaveValue('');
  await form.locator('[name=name]').fill('Discipline E2E');
  await form.locator('[name=maxDailyTradeCycles]').fill('1');
  await form.locator('[name=trailing]').fill('10000');
  await form.locator('button[type=submit]').click();
  await expect(page.locator('#practice-root')).toBeVisible();
  await expect(page.getByTestId('discipline-counts')).toContainText('0 trade cycles');
  await expect(page.getByText('Peak equity', { exact: true })).toBeVisible();
  await expect(page.getByText('Trailing floor', { exact: true })).toBeVisible();
  await page.getByTestId('sl-ticks').fill('200');
  await page.getByTestId('btn-buy').click();
  await expect(page.getByTestId('orders')).toContainText('MKT');
  await page.getByTestId('btn-step').click();
  await expect(page.getByTestId('discipline-paused')).toContainText('next trading day');
  await expect(page.getByTestId('position')).toContainText('Long');
  const sessions = (await (await page.request.get('/api/sessions')).json()).sessions;
  const id = sessions.find((session: { name: string }) => session.name === 'Discipline E2E').id;
  const opened = (await (await page.request.get(`/api/sessions/${id}`)).json()).state.trading;
  const protection = opened.orders.find(
    (order: { status: string; role: string }) =>
      order.status === 'working' && order.role === 'stop-loss',
  );
  expect(protection).toBeDefined();
  // The upstream editor remains usable for protection while discipline pauses new exposure.
  await page.getByTestId(`modify-${protection.id}`).click();
  await expect(page.getByTestId('modify-dialog')).toBeVisible();
  await page.getByTestId('modify-price').fill(String(protection.price - 0.25));
  const edited = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/sessions/${id}/orders/${protection.id}`) &&
      response.request().method() === 'PATCH',
  );
  await page.getByTestId('modify-submit').click();
  expect((await edited).status()).toBe(200);
  await expect(page.getByTestId('modify-dialog')).not.toBeVisible();
  await expect(page.getByTestId('discipline-paused')).toBeVisible();
  await expect(page.getByText('Trailing floor', { exact: true })).toBeVisible();
  const before = (await (await page.request.get(`/api/sessions/${id}`)).json()).state.trading;
  expect(before.orders.find((order: { id: number }) => order.id === protection.id).price).toBe(
    protection.price - 0.25,
  );
  const rejection = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/sessions/${id}/orders`) && response.request().method() === 'POST',
  );
  await page.getByTestId('btn-buy').click();
  expect((await rejection).status()).toBe(400);
  const after = (await (await page.request.get(`/api/sessions/${id}`)).json()).state.trading;
  expect(after).toEqual(before);
  expect(
    after.orders.filter(
      (order: { status: string; role: string }) =>
        order.status === 'working' && order.role === 'entry',
    ),
  ).toHaveLength(0);
  await page.getByTestId('btn-flatten').click();
  await page.getByTestId('btn-step').click();
  await expect(page.getByTestId('position')).toContainText('Flat');
  const clock = await page.getByTestId('clock').textContent();
  await page.getByTestId('btn-step').click();
  await expect(page.getByTestId('clock')).not.toHaveText(clock!);
  await page.click('#lang-toggle');
  await expect(page.getByTestId('discipline-paused')).toContainText('下一交易日');
  await expect(page.getByText('追蹤下限', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
