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
