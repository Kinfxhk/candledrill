// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared e2e helpers. Specs share one in-memory server (workers: 1).
import { expect, type Page } from '@playwright/test';

/**
 * Click "Generate demo data" and wait until createDemo's async reload + prefill
 * have finished. Waiting only for the form to be visible is not enough on a slow
 * Windows runner: prefill can still overwrite the name after the test filled it.
 */
export async function generateDemo(page: Page): Promise<void> {
  const list = async () =>
    (await (await page.request.get('/api/datasets')).json()).datasets as { id: number }[];
  const before = (await list()).length;
  await page.click('#btn-demo');
  let now = await list();
  for (let i = 0; i < 50 && now.length === before; i++) {
    await page.waitForTimeout(100);
    now = await list();
  }
  expect(now.length).toBeGreaterThan(before);
  const id = now.at(-1)!.id;
  await expect(page.locator(`#dataset-list li[data-id="${id}"]`)).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('#new-session-form')).toBeVisible();
  await expect(page.locator('#new-session-form input[name=name]')).toHaveValue(/^SYNTH-/);
}
