// SPDX-License-Identifier: AGPL-3.0-or-later
// Device fit and alignment: real 2026 phone viewports (portrait and landscape, browser bars
// subtracted). Nothing scrolls sideways, the trade controls and P&L stay on screen, controls
// in a row share one height, and content edges line up.
import { expect, test, type Page } from '@playwright/test';
import { generateDemo } from './helpers.js';

// [name, width, visible height]  (CSS px; Safari/Chrome bars subtracted on first load)
const DEVICES: [string, number, number][] = [
  ['iPhone 18 Pro portrait', 402, 718],
  ['iPhone 18 Pro landscape', 874, 352],
  ['iPhone 18 Pro Max portrait', 440, 800],
  ['iPhone 18 Pro Max landscape', 956, 390],
  ['Galaxy S26 Ultra portrait', 412, 811],
  ['Galaxy S26 Ultra landscape', 891, 356],
  ['Pixel 10 Pro landscape', 914, 354],
  ['Galaxy Z Fold8 open', 816, 536],
];

async function layout(page: Page) {
  return page.evaluate(() => {
    const shown = (e: Element) => {
      const r = e.getBoundingClientRect();
      const c = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && c.display !== 'none' && c.visibility !== 'hidden';
    };
    const inView = (sel: string) => {
      const e = document.querySelector(sel);
      if (!e || !shown(e)) return false;
      const r = e.getBoundingClientRect();
      return (
        r.left >= -0.5 &&
        r.right <= innerWidth + 0.5 &&
        r.top >= -0.5 &&
        r.bottom <= innerHeight + 0.5
      );
    };
    const heights = (sel: string) => [
      ...new Set(
        [...document.querySelectorAll(sel)]
          .filter(shown)
          .map((e) => Math.round(e.getBoundingClientRect().height)),
      ),
    ];
    const left = (sel: string) => {
      const els = [...document.querySelectorAll(sel)].filter(shown);
      return els.length
        ? Math.round(Math.min(...els.map((e) => e.getBoundingClientRect().left)))
        : null;
    };
    const bar = document.querySelector('[data-testid=trade-bar]');
    const usesBar = !!bar && shown(bar);
    return {
      scrollX: document.documentElement.scrollWidth - innerWidth,
      scrollY: document.documentElement.scrollHeight - innerHeight,
      usesBar,
      buy: inView(usesBar ? '[data-testid=tb-buy]' : '[data-testid=btn-buy]'),
      pnl: inView('[data-testid=pnl-chip]'),
      tabs: inView('.bottom .tabbar'),
      chartH: Math.round(document.querySelector('.chart-body')!.getBoundingClientRect().height),
      barRows: usesBar
        ? [heights('.tb-replay button'), heights('.tb-order button, .tb-order input')]
        : [],
      tabHeights: heights('.bottom .tabbar button'),
      lefts: [left('header.app > *'), left('.toolbar > *'), left('.chart-head > *')],
    };
  });
}

for (const [name, width, height] of DEVICES) {
  test(`fits and lines up: ${name} (${width}×${height})`, async ({ browser }) => {
    const ctx = await browser.newContext({
      viewport: { width, height },
      hasTouch: true,
      isMobile: true,
    });
    const page = await ctx.newPage();
    await page.goto('/');
    await generateDemo(page);
    await page.locator('#new-session-form button[type=submit]').click();
    await expect(page.locator('#practice-root')).toBeVisible();
    await page.waitForTimeout(300);
    const m = await layout(page);
    expect(m.scrollX, 'no sideways scroll').toBeLessThanOrEqual(0);
    expect(m.scrollY, 'practice screen fits the height').toBeLessThanOrEqual(0);
    expect(m.buy, 'Buy is on screen').toBe(true);
    expect(m.pnl, 'P&L chip is on screen').toBe(true);
    expect(m.tabs, 'tab strip is on screen').toBe(true);
    expect(m.chartH, 'chart keeps real height').toBeGreaterThanOrEqual(150);
    for (const row of m.barRows) expect(row, 'one height per trade-bar row').toHaveLength(1);
    expect(m.tabHeights, 'one tab height').toHaveLength(1);
    expect(new Set(m.lefts).size, `left edges line up ${m.lefts}`).toBe(1);
    await ctx.close();
  });
}

test('short landscape: the rules chip keeps the chart and leaves the head controls clear', async ({
  browser,
}) => {
  for (const [width, height] of [
    [874, 352],
    [816, 536],
  ] as const) {
    const ctx = await browser.newContext({
      viewport: { width, height },
      hasTouch: true,
      isMobile: true,
    });
    const page = await ctx.newPage();
    await page.goto('/');
    await generateDemo(page);
    const form = page.locator('#new-session-form');
    await form.locator('input[name=dailyLoss]').fill('1000');
    await form.locator('input[name=trailing]').fill('5000');
    await form.locator('input[name=target]').fill('3000');
    await form.locator('button[type=submit]').click();
    await expect(page.locator('#practice-root')).toBeVisible();
    const strip = page.getByTestId('rules-strip');
    await expect(strip).toHaveClass(/is-short-chip/);
    await expect(strip).toHaveClass(/docked/);
    await expect(page.getByTestId('rules')).toBeHidden();
    // Expanding would paint the metrics row over Semi-auto, Indicators, and OHLC.
    await page.getByTestId('rules-strip-toggle').click();
    await expect(page.getByTestId('rules')).toBeHidden();
    await expect(strip).toHaveClass(/is-short-chip/);
    await expect(page.getByTestId('rules-strip-drag')).toHaveCSS('touch-action', 'none');
    const legend = page.locator('[data-testid=ohlc-legend]').first();
    await expect(legend).not.toBeEmpty();
    const fit = await page.evaluate(() => {
      const box = (sel: string) => {
        const e = document.querySelector(sel);
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      };
      const hits = (
        a: { x: number; y: number; w: number; h: number } | null,
        b: { x: number; y: number; w: number; h: number } | null,
      ) =>
        !!a &&
        !!b &&
        a.w > 1 &&
        b.w > 1 &&
        a.h > 1 &&
        b.h > 1 &&
        a.x < b.x + b.w &&
        a.x + a.w > b.x &&
        a.y < b.y + b.h &&
        a.y + a.h > b.y;
      const centerHit = (sel: string) => {
        const e = document.querySelector(sel);
        if (!e) return false;
        const r = e.getBoundingClientRect();
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!at && (at === e || e.contains(at));
      };
      const stripBox = box('[data-testid=rules-strip]');
      const chart = box('.chart-body');
      return {
        chartH: chart?.h ?? 0,
        stripH: stripBox?.h ?? 0,
        aboveChart: !!stripBox && !!chart && stripBox.y + stripBox.h <= chart.y + 1,
        coverTf: hits(stripBox, box('[data-testid=tf-0]')),
        coverMacro: hits(stripBox, box('[data-testid=macro-open]')),
        coverInd: hits(stripBox, box('[data-testid=indicators-toggle]')),
        coverOhlc: hits(stripBox, box('[data-testid=ohlc-legend]')),
        hitTf: centerHit('[data-testid=tf-0]'),
        hitMacro: centerHit('[data-testid=macro-open]'),
        hitInd: centerHit('[data-testid=indicators-toggle]'),
      };
    });
    expect(fit.chartH, `${width}×${height} chart`).toBeGreaterThanOrEqual(150);
    expect(fit.stripH, `${width}×${height} chip is one line`).toBeLessThanOrEqual(32);
    expect(fit.aboveChart, `${width}×${height} chip stays above the candles`).toBe(true);
    expect(fit.coverTf, `${width}×${height} timeframe`).toBe(false);
    expect(fit.coverMacro, `${width}×${height} semi-auto`).toBe(false);
    expect(fit.coverInd, `${width}×${height} indicators`).toBe(false);
    expect(fit.coverOhlc, `${width}×${height} OHLC`).toBe(false);
    expect(fit.hitTf, `${width}×${height} timeframe clickable`).toBe(true);
    expect(fit.hitMacro, `${width}×${height} semi-auto clickable`).toBe(true);
    expect(fit.hitInd, `${width}×${height} indicators clickable`).toBe(true);
    // Dragging must not unfold the metrics row over the chart head.
    const grip = page.getByTestId('rules-strip-drag');
    const gripBox = (await grip.boundingBox())!;
    await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + 80, { steps: 6 });
    await page.mouse.up();
    await expect(strip).toHaveClass(/floating/);
    await expect(strip).not.toHaveClass(/is-short-chip/);
    await expect(page.getByTestId('rules')).toBeHidden();
    await expect(grip).toHaveCSS('touch-action', 'none');
    await ctx.close();
  }
});

test('leaving a short window reclamps an expanded strip off the OHLC legend', async ({
  browser,
}) => {
  const ctx = await browser.newContext({
    viewport: { width: 420, height: 352 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await ctx.newPage();
  await page.goto('/');
  await generateDemo(page);
  const form = page.locator('#new-session-form');
  await form.locator('input[name=dailyLoss]').fill('1000');
  await form.locator('input[name=trailing]').fill('5000');
  await form.locator('input[name=target]').fill('3000');
  await form.locator('button[type=submit]').click();
  await expect(page.locator('#practice-root')).toBeVisible();
  const strip = page.locator('.chart-col [data-testid=rules-strip]');
  const legend = page.locator('.chart-body [data-testid=ohlc-legend]');
  await expect(strip).toHaveClass(/is-short-chip/);
  await expect(legend).not.toBeEmpty();
  const before = await page.evaluate(() => {
    const stripEl = document.querySelector('.chart-col [data-testid=rules-strip]')!;
    const legendEl = document.querySelector('.chart-body [data-testid=ohlc-legend]')!;
    const sr = stripEl.getBoundingClientRect();
    const lr = legendEl.getBoundingClientRect();
    return { sx: sr.x, sy: sr.y, sh: sr.height, lx: lr.x, ly: lr.y, lw: lr.width };
  });
  expect(before.lw).toBeGreaterThan(8);
  // Just above the legend, sharing its x. A wrapped metrics row grows down onto it.
  const grip = (await page.getByTestId('rules-strip-drag').boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    grip.x + grip.width / 2 + (before.lx - before.sx),
    grip.y + grip.height / 2 + (before.ly - before.sh - 8 - before.sy),
    { steps: 8 },
  );
  await page.mouse.up();
  await expect(strip).toHaveClass(/floating/);
  await expect(page.getByTestId('rules')).toBeHidden();
  await page.setViewportSize({ width: 420, height: 720 });
  await expect(page.getByTestId('rules')).toBeVisible();
  const covered = await page.evaluate(() => {
    const stripEl = document.querySelector('.chart-col [data-testid=rules-strip]');
    const legendEl = document.querySelector('.chart-body [data-testid=ohlc-legend]');
    if (!stripEl || !legendEl) return true;
    const a = stripEl.getBoundingClientRect();
    const b = legendEl.getBoundingClientRect();
    const hits =
      a.width > 1 &&
      b.width > 1 &&
      a.height > 1 &&
      b.height > 1 &&
      a.x < b.x + b.width &&
      a.x + a.width > b.x &&
      a.y < b.y + b.height &&
      a.y + a.height > b.y;
    const at = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return hits || (!!at && (at === stripEl || stripEl.contains(at)));
  });
  expect(covered, 'expanded strip stays off the OHLC legend').toBe(false);
  await ctx.close();
});

test('phone landscape: a status banner and a toast never push or cover the trade bar', async ({
  browser,
}) => {
  const ctx = await browser.newContext({
    viewport: { width: 874, height: 352 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await ctx.newPage();
  await page.goto('/');
  await generateDemo(page);
  await page.locator('#new-session-form button[type=submit]').click();
  await expect(page.locator('#practice-root')).toBeVisible();
  // Force the end-of-data banner and a toast, then measure.
  await page.evaluate(() => {
    const b = document.querySelector('[data-testid=status-banner]') as HTMLElement;
    b.textContent = 'Session finished: end of data reached. Review your trades below.';
    b.className = 'status-banner show finished';
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = 'SYNTH-DEMO: 15300 bars';
    document.body.append(t);
  });
  const m = await page.evaluate(() => {
    const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
    const bar = r('[data-testid=trade-bar]');
    const toast = r('.toast');
    return {
      scrollY: document.documentElement.scrollHeight - innerHeight,
      bannerShown: r('[data-testid=status-banner]').height > 0,
      barBottom: Math.round(bar.bottom),
      vh: innerHeight,
      toastAboveBar: toast.bottom <= bar.top + 0.5,
      toastClearOfChart: toast.top >= r('.chart-body').top + r('.chart-body').height * 0.5,
    };
  });
  expect(m.bannerShown, 'status stays visible').toBe(true);
  expect(m.scrollY, 'banner does not push the page').toBeLessThanOrEqual(0);
  expect(m.barBottom, 'trade bar stays on screen').toBeLessThanOrEqual(m.vh);
  expect(m.toastAboveBar, 'toast sits above the trade bar').toBe(true);
  expect(m.toastClearOfChart, 'toast stays in the lower half, not over the chart').toBe(true);
  await ctx.close();
});
