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
  // 10s demo can insert ~60k bars; allow up to ~15s on slow Windows runners.
  for (let i = 0; i < 150 && now.length === before; i++) {
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
  // The blind checkbox defaults to on; most helpers expect a normal session.
  await page.getByTestId('ns-blind').uncheck();
  await expect(page.getByTestId('macro-blind-warn')).toBeHidden();
  await expect(page.locator('#new-session-form input[name=name]')).toHaveValue(/^SYNTH-/);
}

/** Working orders live on the bottom Orders tab, not the right rail. */
export async function showWorkingOrders(page: Page): Promise<void> {
  await page.getByTestId('tab-orders').click();
  await expect(page.getByTestId('orders')).toBeVisible();
}

/**
 * Click "Next bar" until `check` is true. Demo data is 10s with fills on 1m
 * practice closes, so a market order needs several source steps (up to ~12).
 */
export async function stepUntil(
  page: Page,
  check: () => Promise<boolean>,
  maxSteps = 24,
): Promise<void> {
  for (let i = 0; i < maxSteps; i++) {
    if (await check()) return;
    await page.getByTestId('btn-step').click();
  }
  // One Next paints the forming source bars before the practice-bar fill hits the DOM.
  await expect.poll(check, { timeout: 3000 }).toBe(true);
}

/**
 * The session open in this page (the app records it), falling back to the most recently
 * updated one. The e2e server is shared, so "newest" alone can pick another test's session.
 */
export async function sessionState(page: Page) {
  const open = await page.evaluate(
    () => document.getElementById('practice-root')?.getAttribute('data-session-id') ?? null,
  );
  let id = open ? Number(open) : NaN;
  if (!Number.isInteger(id)) {
    const list = await (await page.request.get('/api/sessions')).json();
    id = list.sessions[0].id as number;
  }
  return (await page.request.get(`/api/sessions/${id}`)).json();
}
