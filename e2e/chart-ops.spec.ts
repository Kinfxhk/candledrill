// SPDX-License-Identifier: AGPL-3.0-or-later
// Playback chip, one-bar step back, replay-from, and dragging a protective stop.
import { expect, type Page, test } from '@playwright/test';
import { generateDemo, sessionState, stepUntil } from './helpers.js';

/** Next bar ignores a click while the previous candle is still painting. */
async function nextPracticeBar(page: Page): Promise<number> {
  const before = (await sessionState(page)).state.cursor as number;
  await expect
    .poll(async () => {
      const now = (await sessionState(page)).state.cursor as number;
      if (now > before) return now;
      await page.getByTestId('btn-step').click();
      return (await sessionState(page)).state.cursor as number;
    })
    .toBeGreaterThan(before);
  return (await sessionState(page)).state.cursor as number;
}

function localInput(time: number, utcOffsetMinutes: number): string {
  return new Date((time + utcOffsetMinutes * 60) * 1000).toISOString().slice(0, 16);
}

test('playback, replay from a bar, and stop drag', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await generateDemo(page);
  await page.locator('#new-session-form button[type=submit]').click();
  await expect(page.locator('#practice-root')).toBeVisible();

  const state = page.getByTestId('replay-state');
  await expect(state).toHaveAttribute('data-state', 'paused');
  await expect(state).toHaveText('Paused');

  await page.getByTestId('speed').selectOption('2');
  await page.getByTestId('btn-play').click();
  await expect(state).toHaveAttribute('data-state', 'playing');
  await expect(state).toHaveText('Playing · 2×');
  await page.getByTestId('btn-play').click();
  await expect(state).toHaveAttribute('data-state', 'paused');
  await expect(state).toHaveText('Paused');

  const opened = await sessionState(page);
  await nextPracticeBar(page);
  expect((await sessionState(page)).state.cursor).toBeGreaterThan(opened.state.cursor);
  const mid = await sessionState(page);
  await nextPracticeBar(page);
  expect((await sessionState(page)).state.cursor).toBeGreaterThan(mid.state.cursor);

  await expect(page.getByTestId('btn-bar-back')).toBeEnabled();
  await expect
    .poll(async () => {
      const now = (await sessionState(page)).state.cursor as number;
      if (now === mid.state.cursor) return now;
      await page.getByTestId('btn-bar-back').click();
      return (await sessionState(page)).state.cursor as number;
    })
    .toBe(mid.state.cursor);
  const stepped = await sessionState(page);
  expect(stepped.bars.at(-1).time).toBe(stepped.cursorTime);
  expect(stepped.bars.length - 1).toBe(stepped.state.cursor);

  await expect
    .poll(async () => {
      const now = (await sessionState(page)).state.cursor as number;
      if (now > mid.state.cursor) return now;
      await page.keyboard.press('ArrowRight');
      return (await sessionState(page)).state.cursor as number;
    })
    .toBeGreaterThan(mid.state.cursor);
  const forwardTime = (await sessionState(page)).cursorTime as number;
  await expect
    .poll(async () => {
      const now = (await sessionState(page)).cursorTime as number;
      if (now !== forwardTime) return now;
      await page.keyboard.press('ArrowDown');
      return (await sessionState(page)).cursorTime as number;
    })
    .toBe(mid.cursorTime);

  await nextPracticeBar(page);
  await nextPracticeBar(page);
  const later = (await sessionState(page)).state.cursor;
  expect(later).toBeGreaterThan(mid.state.cursor);
  const jump = page.getByTestId('jump-input');
  const jumpValue = localInput(mid.cursorTime, mid.session.settings.utcOffsetMinutes);
  await expect
    .poll(async () => {
      const now = (await sessionState(page)).cursorTime as number;
      if (now === mid.cursorTime) return now;
      await jump.click();
      await jump.fill(jumpValue);
      await page.getByTestId('btn-jump').click();
      return (await sessionState(page)).cursorTime as number;
    })
    .toBe(mid.cursorTime);
  const replayed = await sessionState(page);
  expect(replayed.state.cursor).toBeLessThan(later);
  expect(replayed.bars.at(-1).time).toBe(replayed.cursorTime);
  expect(replayed.bars.length - 1).toBe(replayed.state.cursor);

  const chart = page.locator('.chart-body').first();
  const box = (await chart.boundingBox())!;
  const beforeMenu = (await sessionState(page)).state.cursor;
  await chart.click({
    button: 'right',
    position: { x: Math.max(24, box.width - 100), y: box.height * 0.45 },
  });
  await expect(page.getByTestId('bar-menu')).toBeVisible();
  await expect(page.getByTestId('replay-from-here')).toHaveText('Replay from this bar');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('bar-menu')).toHaveCount(0);

  await chart.click({
    button: 'right',
    position: { x: Math.max(24, box.width - 100), y: box.height * 0.45 },
  });
  await page.getByTestId('replay-from-here').click();
  await expect(page.getByTestId('bar-menu')).toHaveCount(0);
  await expect
    .poll(async () => {
      const cursor = (await sessionState(page)).state.cursor;
      const toast = await page.locator('.toast').count();
      return cursor < beforeMenu || toast > 0;
    })
    .toBe(true);
  const afterMenu = await sessionState(page);
  if (afterMenu.state.cursor < beforeMenu) {
    expect(afterMenu.bars.at(-1).time).toBe(afterMenu.cursorTime);
  }

  await page.getByTestId('sl-ticks').fill('20');
  await page.getByTestId('tp-ticks').fill('40');
  await page.getByTestId('btn-buy').click();
  await stepUntil(page, async () =>
    /Long/.test((await page.getByTestId('position').textContent()) ?? ''),
  );
  const marker = page.getByTestId('bracket-stop');
  await expect(marker).toBeVisible();
  await expect(marker).toContainText(/SL/);
  await expect(page.getByTestId('bracket-target')).toContainText(/TP/);
  const stopPrice = async () => {
    const view = await sessionState(page);
    const order = view.state.trading.orders.find(
      (o: { role: string; status: string; price: number | null }) =>
        o.role === 'stop-loss' && o.status === 'working',
    );
    return order?.price as number;
  };
  const before = await stopPrice();
  expect(before).toBeGreaterThan(0);
  const hit = (await marker.boundingBox())!;
  await page.mouse.move(hit.x + hit.width / 2, hit.y + hit.height / 2);
  await page.mouse.down();
  await page.mouse.move(hit.x + hit.width / 2, hit.y + hit.height / 2 + 80, { steps: 10 });
  await page.mouse.up();
  await expect.poll(stopPrice).toBeLessThan(before);

  expect(errors, errors.join('\n')).toEqual([]);
});
