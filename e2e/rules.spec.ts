// SPDX-License-Identifier: AGPL-3.0-or-later
import { test, expect } from '@playwright/test';
import { generateDemo } from './helpers.js';

test.describe('practice rules form (V1 trailing modes)', () => {
  test('new session form exposes trailing mode and anchor fields', async ({ page }) => {
    await page.goto('/');
    await generateDemo(page);
    await expect(page.getByTestId('ns-trailing-mode')).toBeVisible();
    await expect(page.getByTestId('ns-anchor')).toBeVisible();
    await page.getByTestId('ns-trailing-mode').selectOption('eod');
    await expect(page.getByTestId('ns-trailing-mode')).toHaveValue('eod');
    await page.getByTestId('ns-trailing-mode').selectOption('close');
    // Anchor should be prefilled from first bar (demo data starts mid-morning, not 00:00).
    const anchor = page.getByTestId('ns-anchor');
    const v = await anchor.inputValue();
    expect(v).not.toBe('00:00');
  });
});
