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
  await form.locator('button[type=submit]').click();
  await expect(page.locator('#practice-root')).toBeVisible();
  await expect(page.getByTestId('discipline-counts')).toContainText('0 trade cycles');
  await page.getByTestId('btn-buy').click();
  await expect(page.getByTestId('orders')).toContainText('MKT');
  await page.getByTestId('btn-step').click();
  await expect(page.getByTestId('discipline-paused')).toContainText('next trading day');
  await expect(page.getByTestId('position')).toContainText('Long');
  const sessions = (await (await page.request.get('/api/sessions')).json()).sessions;
  const id = sessions.find((session: { name: string }) => session.name === 'Discipline E2E').id;
  const before = (await (await page.request.get(`/api/sessions/${id}`)).json()).state.trading;
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
  expect(errors).toEqual([]);
});
