// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '@playwright/test';

test('retired campaign URLs leave normal practice available without an exam entry', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/?exam=1&daily=2026-11-05');
  await expect(page.locator('#view-library')).toBeVisible();
  await expect(page.locator('[data-testid="daily-card"]')).toHaveCount(0);
  await expect(page.locator('[class*="exam-"]')).toHaveCount(0);
  await expect(page.locator('a[href*="docs.google.com/forms"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});
