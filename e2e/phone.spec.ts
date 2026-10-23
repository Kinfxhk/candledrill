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

const PRACTICE_WIDTHS: [number, number][] = [
  [375, 812],
  [390, 844],
  [768, 1024],
];

for (const [width, height] of PRACTICE_WIDTHS) {
  test(`playback speed is on the first screen at ${width}×${height}`, async ({ browser }) => {
    const ctx = await browser.newContext({
      viewport: { width, height },
      hasTouch: true,
      isMobile: width < 768,
    });
    const page = await ctx.newPage();
    await page.goto('/');
    await generateDemo(page);
    await page.locator('#new-session-form button[type=submit]').click();
    await expect(page.locator('#practice-root')).toBeVisible();

    const speed = page.getByTestId('tb-speed');
    const play = page.getByTestId('tb-play');
    await expect(page.locator('.toolbar .replay')).toBeHidden();
    await expect(speed).toBeVisible();
    await expect(speed).toHaveValue('1');
    const speedBox = (await speed.boundingBox())!;
    const playBox = (await play.boundingBox())!;
    expect(Math.abs(speedBox.y - playBox.y), 'speed sits on the play row').toBeLessThan(4);
    expect(speedBox.x).toBeGreaterThanOrEqual(-0.5);
    expect(speedBox.x + speedBox.width).toBeLessThanOrEqual(width + 0.5);
    expect(speedBox.y + speedBox.height).toBeLessThanOrEqual(height + 0.5);
    expect(speedBox.height).toBeGreaterThanOrEqual(44);
    expect(speedBox.width).toBeGreaterThanOrEqual(88);

    for (const id of [
      'tb-buy',
      'tb-sell',
      'tb-flatten',
      'tb-play',
      'tb-step',
      'tb-back',
    ] as const) {
      const box = (await page.getByTestId(id).boundingBox())!;
      expect(box.width, id).toBeGreaterThanOrEqual(44);
      expect(box.height, id).toBeGreaterThanOrEqual(44);
      expect(box.y + box.height, id).toBeLessThanOrEqual(height + 0.5);
    }
    const buyBox = (await page.getByTestId('tb-buy').boundingBox())!;
    const flatBox = (await page.getByTestId('tb-flatten').boundingBox())!;
    expect(
      flatBox.x - (buyBox.x + buyBox.width),
      'space between Buy and Flatten',
    ).toBeGreaterThanOrEqual(16);
    const tabCount = await page.locator('.bottom .tabbar button').count();
    for (let i = 0; i < tabCount; i++) {
      const tab = page.locator('.bottom .tabbar button').nth(i);
      if (!(await tab.isVisible())) continue;
      const box = (await tab.boundingBox())!;
      expect(box.height, 'tab hit height').toBeGreaterThanOrEqual(44);
      expect(box.width, 'tab hit width').toBeGreaterThanOrEqual(44);
      expect(box.x, 'tab on screen').toBeGreaterThanOrEqual(-0.5);
      expect(box.x + box.width, 'tab not clipped').toBeLessThanOrEqual(width + 0.5);
    }

    await speed.selectOption('2');
    await expect(speed).toHaveValue('2');
    await expect(page.getByTestId('speed')).toHaveValue('2');
    const scrollX = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(scrollX, 'no sideways scroll').toBeLessThanOrEqual(0);
    await ctx.close();
  });
}

test('desktop speed dropdown still defaults to 1×/s', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await generateDemo(page);
  await page.locator('#new-session-form button[type=submit]').click();
  await expect(page.locator('#practice-root')).toBeVisible();
  await expect(page.locator('.toolbar .replay')).toBeVisible();
  const speed = page.getByTestId('speed');
  await expect(speed).toBeVisible();
  await expect(speed).toHaveValue('1');
  await expect(page.getByTestId('trade-bar')).toBeHidden();
  await speed.selectOption('0.5');
  await expect(speed).toHaveValue('0.5');
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

test('short landscape keeps 44px trade controls and a usable chart', async ({ browser }) => {
  const ctx = await browser.newContext({
    viewport: { width: 844, height: 390 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await ctx.newPage();
  await page.goto('/');
  await generateDemo(page);
  await page.locator('#new-session-form button[type=submit]').click();
  await expect(page.locator('#practice-root')).toBeVisible();
  for (const id of ['tb-buy', 'tb-sell', 'tb-flatten', 'tb-speed', 'tb-play'] as const) {
    const box = (await page.getByTestId(id).boundingBox())!;
    expect(box.width, id).toBeGreaterThanOrEqual(44);
    expect(box.height, id).toBeGreaterThanOrEqual(44);
  }
  const chart = (await page.locator('.chart-body').first().boundingBox())!;
  expect(chart.height, 'chart keeps 150px').toBeGreaterThanOrEqual(150);
  const scrollX = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(scrollX).toBeLessThanOrEqual(0);
  await ctx.close();
});

test('pressed trade buttons, flatten arm, and a closing tap does not order', async ({
  browser,
}) => {
  const { ctx, page } = await phone(browser);
  const buy = page.getByTestId('tb-buy');
  const box = (await buy.boundingBox())!;
  const orders = async () => (await sessionState(page)).state.trading.orders.length;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  const filter = await buy.evaluate((el) => getComputedStyle(el).filter);
  await page.mouse.up();
  expect(filter, 'pressed state').not.toBe('none');
  // Releasing the press is a real click, so one order is already working.
  // Wait until that response is finished; a click during it is correctly ignored.
  await expect.poll(orders).toBe(1);
  await page.waitForLoadState('networkidle');

  await page.evaluate(() => {
    const b = document.querySelector('[data-testid=tb-buy]') as HTMLButtonElement;
    b.click();
    b.click();
  });
  await expect.poll(orders).toBe(2);
  await page.waitForTimeout(250);
  expect(await orders()).toBe(2);
  await expect(page.locator('.toast')).toContainText(/still running/i);

  const flat = page.getByTestId('tb-flatten');
  await flat.click();
  await expect(flat).toHaveClass(/armed/);
  await expect(flat).toHaveText('Sure?');
  await expect(page.locator('.toast')).toContainText(/Tap again/);
  expect(await orders()).toBe(2);
  await tapChart(page);
  await expect(flat).not.toHaveClass(/armed/);
  await expect(flat).toHaveText('Close');

  await page.getByTestId('btn-sheet').click();
  await expect(page.locator('body')).toHaveClass(/sheet-open/);
  const close = (await page.getByTestId('sheet-close').boundingBox())!;
  expect(close.width).toBeGreaterThanOrEqual(44);
  expect(close.height).toBeGreaterThanOrEqual(44);
  // The event target is Sell itself (not the dimmer). Closing must swallow it.
  await page.evaluate(() => {
    const b = document.querySelector('[data-testid=tb-sell]') as HTMLButtonElement;
    const opts = { bubbles: true, cancelable: true, composed: true, pointerId: 1 };
    b.dispatchEvent(new PointerEvent('pointerdown', opts));
    b.dispatchEvent(new PointerEvent('pointerup', opts));
    b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await expect(page.locator('body')).not.toHaveClass(/sheet-open/);
  expect(await orders()).toBe(2);

  await page.getByTestId('indicators-toggle').first().click();
  await expect(page.getByTestId('indicator-panel')).toBeVisible();
  const indClose = (await page.getByTestId('indicator-close').boundingBox())!;
  expect(indClose.width).toBeGreaterThanOrEqual(44);
  expect(indClose.height).toBeGreaterThanOrEqual(44);
  await page.getByTestId('indicator-close').click();
  await expect(page.getByTestId('indicator-panel')).toHaveCount(0);
  await ctx.close();
});

test('blind checkbox hit area is at least 44px and demo generation ignores a double tap', async ({
  browser,
}) => {
  const ctx = await browser.newContext({
    viewport: { width: 375, height: 812 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await ctx.newPage();
  await page.goto('/');
  const label = (await page.locator('label.blind-toggle').boundingBox())!;
  expect(label.height).toBeGreaterThanOrEqual(44);
  const check = (await page.getByTestId('ns-blind').boundingBox())!;
  expect(check.width).toBeGreaterThanOrEqual(20);
  expect(check.height).toBeGreaterThanOrEqual(20);

  const count = async () =>
    ((await (await page.request.get('/api/datasets')).json()) as { datasets: unknown[] }).datasets
      .length;
  const before = await count();
  await page.evaluate(() => {
    const b = document.querySelector('#btn-demo') as HTMLButtonElement;
    b.click();
    b.click();
  });
  await expect.poll(count, { timeout: 20_000 }).toBe(before + 1);
  await page.waitForTimeout(400);
  expect(await count()).toBe(before + 1);
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
