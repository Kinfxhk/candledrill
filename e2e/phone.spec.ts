// SPDX-License-Identifier: AGPL-3.0-or-later
// Phone behaviour (user reports): panels close on an outside tap and the tap does nothing
// else; play shows pause while playing; blind hides semi-auto; one "Next bar" reaches the
// next 1m close so a manual order fills; no sideways scrolling; the new-session form lines up.
import { expect, test, type Browser, type Page } from '@playwright/test';
import { generateDemo, sessionState } from './helpers.js';

const PHONE = { width: 402, height: 718 };

async function phone(browser: Browser, blind = false) {
  const ctx = await browser.newContext({ viewport: PHONE, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await page.goto('/');
  await generateDemo(page);
  await page.getByTestId('ns-blind').setChecked(blind);
  await page.locator('#new-session-form button[type=submit]').click();
  await expect(page.locator('#practice-root')).toBeVisible();
  return { ctx, page };
}

/** Tap an empty spot near the top of the chart (bottom sheets cover the lower part). */
async function tapChart(page: Page) {
  const b = (await page.locator('.chart-body').first().boundingBox())!;
  await page.mouse.click(b.x + b.width * 0.3, b.y + Math.min(60, b.height * 0.2));
}

test('panels close on a tap outside and the tap does nothing else', async ({ browser }) => {
  const { ctx, page } = await phone(browser);
  const drawings = async () => ((await sessionState(page)).session.drawings as unknown[]).length;

  // Drawer.
  await page.getByTestId('btn-sheet').click();
  await expect(page.locator('body')).toHaveClass(/sheet-open/);
  await tapChart(page);
  await expect(page.locator('body')).not.toHaveClass(/sheet-open/);
  // Drawer ✕.
  await page.getByTestId('btn-sheet').click();
  await page.getByTestId('sheet-close').click();
  await expect(page.locator('body')).not.toHaveClass(/sheet-open/);

  // Bottom panel opened from a tab: the chart keeps real room, then gets it all back.
  const chartH = async () => (await page.locator('.chart-body').first().boundingBox())!.height;
  const full = await chartH();
  await page.getByTestId('tab-trades').click();
  await expect(page.getByTestId('bottom')).toHaveClass(/expanded/);
  expect(await chartH(), 'chart while a panel is open').toBeGreaterThanOrEqual(240);
  await tapChart(page);
  await expect(page.getByTestId('bottom')).not.toHaveClass(/expanded/);
  await expect(page.getByTestId('trade-bar')).toBeVisible();
  await expect.poll(chartH).toBeGreaterThanOrEqual(full - 1);

  // Indicators.
  await page.getByTestId('indicators-toggle').first().click();
  await expect(page.getByTestId('indicator-panel')).toBeVisible();
  await tapChart(page);
  await expect(page.getByTestId('indicator-panel')).toHaveCount(0);

  // Draw palette: picking a tool folds it; an outside tap on an open palette folds it and
  // does not place a point.
  const toggle = page.getByTestId('drawing-palette-toggle').first();
  // Nothing so far may have drawn: the taps above only closed panels.
  expect(await drawings(), 'closing taps drew nothing').toBe(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const before = await drawings();
  await tapChart(page);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(await drawings()).toBe(before);
  await toggle.click();
  await page.getByTestId('palette-hline').first().click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toContainText(/·/); // names the active tool
  await tapChart(page);
  await expect
    .poll(async () => JSON.stringify((await sessionState(page)).session.drawings))
    .toMatch(/^\[\{"kind":"hline"[^\]]*\}\]$/);
  expect(await drawings()).toBe(before + 1);

  // Opening one panel closes another.
  await page.getByTestId('btn-sheet').click();
  await page.getByTestId('tab-orders').click({ force: true });
  await expect(page.locator('body')).not.toHaveClass(/sheet-open/);
  await ctx.close();
});

test('play turns into pause while playing', async ({ browser }) => {
  const { ctx, page } = await phone(browser);
  const play = page.getByTestId('tb-play');
  await expect(play).toHaveAttribute('aria-pressed', 'false');
  await expect(play).toHaveText('▶');
  await play.click();
  await expect(play).toHaveAttribute('aria-pressed', 'true');
  await expect(play).toHaveText('❚❚');
  await expect(play).toHaveAttribute('aria-label', /Pause/);
  await play.click();
  await expect(play).toHaveAttribute('aria-pressed', 'false');
  await expect(play).toHaveText('▶');
  await ctx.close();
});

test('blind: no semi-auto button or tab; a manual Buy fills on the next bar', async ({
  browser,
}) => {
  const { ctx, page } = await phone(browser, true);
  await expect(page.getByTestId('macro-open')).toBeHidden();
  await expect(page.getByTestId('tab-macro')).toBeHidden();
  await page.getByTestId('tb-buy').click();
  await expect.poll(async () => (await sessionState(page)).state.trading.orders.length).toBe(1);
  // One "Next bar" press reaches the 1m close: the market order fills there.
  await page.getByTestId('tb-step').click();
  await expect.poll(async () => (await sessionState(page)).state.trading.fills.length).toBe(1);
  await expect(page.getByTestId('pnl-chip')).toContainText('+1');
  await ctx.close();
});

test('nothing scrolls sideways; header and form line up', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: PHONE, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await page.goto('/');
  await generateDemo(page);
  const lib = await page.evaluate(() => {
    const vw = innerWidth;
    const over = [...document.querySelectorAll('header.app *, #view-library *')]
      .filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && (r.right > vw + 0.5 || r.left < -0.5);
      })
      .map(
        (e) =>
          `${e.tagName.toLowerCase()}#${e.id}.${e.className} r=${Math.round(e.getBoundingClientRect().right)}`,
      );
    const form = document.getElementById('new-session-form')!;
    const inputs = [...form.querySelectorAll('label.field > input, label.field > select')].filter(
      (e) => e.getBoundingClientRect().width > 0,
    );
    // Inputs whose cells share a row must share one bottom edge and one height.
    const rows = new Map<number, { bottom: number; h: number }[]>();
    for (const e of inputs) {
      const cell = e.closest('label')!.getBoundingClientRect();
      const r = e.getBoundingClientRect();
      const k = Math.round(cell.top);
      rows.set(k, [
        ...(rows.get(k) ?? []),
        { bottom: Math.round(r.bottom), h: Math.round(r.height) },
      ]);
    }
    const misaligned = [...rows.values()].filter(
      (r) =>
        r.length > 1 &&
        (new Set(r.map((x) => x.bottom)).size > 1 || new Set(r.map((x) => x.h)).size > 1),
    ).length;
    const fonts = new Set(inputs.map((e) => getComputedStyle(e).fontSize));
    return { docW: document.documentElement.scrollWidth, vw, over, misaligned, fonts: [...fonts] };
  });
  expect(lib.docW, 'page width').toBeLessThanOrEqual(lib.vw);
  expect(lib.over, 'elements past the screen edge').toEqual([]);
  expect(lib.misaligned, 'form rows with uneven inputs').toBe(0);
  expect(lib.fonts, 'touch inputs at 16px (no iOS zoom)').toEqual(['16px']);

  await page.locator('#new-session-form button[type=submit]').click();
  await expect(page.locator('#practice-root')).toBeVisible();
  const prac = await page.evaluate(() => {
    const scrollers = [...document.querySelectorAll('#practice-root *')]
      .filter((e) => {
        const c = getComputedStyle(e);
        return (
          (c.overflowX === 'auto' || c.overflowX === 'scroll') && e.scrollWidth > e.clientWidth + 1
        );
      })
      .map((e) => e.className);
    return { docW: document.documentElement.scrollWidth, vw: innerWidth, scrollers };
  });
  expect(prac.docW).toBeLessThanOrEqual(prac.vw);
  expect(prac.scrollers, 'no sideways scroll strips').toEqual([]);
  await ctx.close();
});

test('play steps whole practice bars; folding semi-auto brings the trade bar back', async ({
  browser,
}) => {
  const { ctx, page } = await phone(browser);
  // Every step request made by play covers at least one whole 1m bar of 10s data (6 bars).
  const counts: number[] = [];
  page.on('request', (r) => {
    if (r.url().endsWith('/step') && r.method() === 'POST')
      counts.push(JSON.parse(r.postData() ?? '{}').count as number);
  });
  await page.getByTestId('tb-play').click();
  await expect.poll(() => counts.length).toBeGreaterThanOrEqual(2);
  await page.getByTestId('tb-play').click();
  expect(Math.min(...counts), `play step counts ${counts}`).toBeGreaterThanOrEqual(6);

  // Semi-auto opens tall; folding it (outside tap) restores the trade bar and the strip.
  await page.getByTestId('macro-open').click();
  await expect(page.getByTestId('bottom')).toHaveClass(/macro-open/);
  await tapChart(page);
  await expect(page.getByTestId('bottom')).not.toHaveClass(/macro-open|expanded/);
  await expect(page.getByTestId('trade-bar')).toBeVisible();
  await ctx.close();
});

test('the tap that closes the draw sheet does not start a freehand stroke', async ({ browser }) => {
  const { ctx, page } = await phone(browser);
  const toggle = page.getByTestId('drawing-palette-toggle').first();
  await toggle.click();
  await page.getByTestId('palette-freehand').first().click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  // Re-open the sheet with freehand still active, then dismiss it with a drag on the chart.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const b = (await page.locator('.chart-body').first().boundingBox())!;
  await page.mouse.move(b.x + 40, b.y + 40);
  await page.mouse.down();
  await page.mouse.move(b.x + 120, b.y + 80, { steps: 6 });
  await page.mouse.up();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.waitForTimeout(300);
  expect(((await sessionState(page)).session.drawings as unknown[]).length).toBe(0);
  await ctx.close();
});
