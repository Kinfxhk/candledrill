// SPDX-License-Identifier: AGPL-3.0-or-later
// First open of a new session: 3-2-1, Skip, then Play. The same session does not count down again.
import { expect, test, type Page } from '@playwright/test';
import { generateDemo } from './helpers.js';

async function startSession(page: Page, name: string): Promise<string> {
  await page.locator('nav.tabs button[data-view=library]').click();
  const form = page.locator('#new-session-form');
  await form.locator('input[name=name]').fill(name);
  await form.locator('button[type=submit]').click();
  const root = page.locator('#practice-root');
  await expect(root).toBeVisible();
  await expect(page.getByTestId('countdown')).toBeVisible({ timeout: 15_000 });
  const id = await root.getAttribute('data-session-id');
  expect(id).toBeTruthy();
  return id!;
}

test('new session counts down into play, skip starts now, reopen stays stopped', async ({
  page,
}) => {
  await page.goto('/');
  await generateDemo(page);

  const first = await startSession(page, 'Countdown skip');
  const num = page.getByTestId('countdown-num');
  await expect(num).toHaveText(/^[123]$/);
  await expect(page.getByTestId('countdown-skip')).toHaveText('Skip');
  const animation = await num.evaluate((el) => getComputedStyle(el).animationName);
  expect(animation).toContain('countdown-pop');
  const box = await num.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(Math.abs(box!.x + box!.width / 2 - viewport!.width / 2)).toBeLessThan(160);
  expect(Math.abs(box!.y + box!.height / 2 - viewport!.height / 2)).toBeLessThan(220);

  await page.getByTestId('countdown-skip').click();
  const play = page.getByTestId('btn-play');
  await expect(play).toHaveAttribute('aria-pressed', 'true', { timeout: 1_000 });
  await expect(page.getByTestId('countdown')).toBeHidden();

  await play.click();
  await expect(play).toHaveAttribute('aria-pressed', 'false');
  await page.locator('nav.tabs button[data-view=library]').click();
  await page.getByTestId(`open-session-${first}`).click();
  await expect(page.locator('#practice-root')).toHaveAttribute('data-session-id', first);
  await expect(page.getByTestId('countdown')).toHaveCount(0);
  await expect(play).toHaveText('Play');
  await page.waitForTimeout(800);
  await expect(page.getByTestId('countdown')).toHaveCount(0);
  await expect(play).toHaveText('Play');

  await startSession(page, 'Countdown auto');
  const seen = new Set<string>();
  await expect
    .poll(
      async () => {
        const overlay = page.getByTestId('countdown');
        if (await overlay.count()) {
          const text = await page.getByTestId('countdown-num').textContent();
          if (text) seen.add(text);
          return 'counting';
        }
        return (await play.getAttribute('aria-pressed')) === 'true' ? 'playing' : 'stopped';
      },
      { timeout: 5_000 },
    )
    .toBe('playing');
  expect(seen.size).toBeGreaterThan(0);
  for (const n of seen) expect(n).toMatch(/^[123]$/);
  await expect(page.getByTestId('countdown')).toBeHidden();
});
