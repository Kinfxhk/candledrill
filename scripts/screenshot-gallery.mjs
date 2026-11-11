// SPDX-License-Identifier: AGPL-3.0-or-later
// Capture beginner-friendly README screenshots against a running server (synthetic only).
// Usage: CANDLEDRILL_DATA_DIR=... npm run serve
//   PW_CHROMIUM_PATH=/usr/bin/google-chrome node scripts/screenshot-gallery.mjs
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const base = process.argv[2] ?? 'http://127.0.0.1:4870';
// README screenshots use the light theme (THEME=dark to compare).
const THEME = process.env.THEME === 'dark' ? 'dark' : 'light';
/** Pin the app theme as well as the media query (a stored preference would win). */
async function pinTheme(target) {
  await target.addInitScript((t) => {
    const p = JSON.parse(localStorage.getItem('candledrill.prefs') ?? '{}');
    localStorage.setItem(
      'candledrill.prefs',
      JSON.stringify({ lang: 'en', blind: true, ...p, theme: t }),
    );
  }, THEME);
}
const executablePath = process.env.PW_CHROMIUM_PATH;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
mkdirSync('docs', { recursive: true });

/** Remove transient toasts so a screenshot shows the whole UI (runs in the page). */
const clearToasts = (page) =>
  page.evaluate(() => globalThis.document.querySelectorAll('.toast').forEach((t) => t.remove()));

async function freshPage() {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    colorScheme: THEME,
    locale: 'en-US',
  });
  await pinTheme(page);
  await page.goto(base, { waitUntil: 'networkidle' });
  return page;
}

async function startSession(page, { blind = false, name = 'Practice' } = {}) {
  // Prefer existing demo dataset if present; else generate.
  const demoBtn = page.locator('#btn-demo');
  if (await demoBtn.isVisible().catch(() => false)) {
    await demoBtn.click();
    await page.waitForTimeout(800);
  }
  const blindBox = page.getByTestId('ns-blind');
  if (await blindBox.count()) {
    await blindBox.setChecked(blind);
  }
  await page.locator('#new-session-form input[name=name]').fill(name);
  await page.locator('#new-session-form button[type=submit]').click();
  await page.getByTestId('charts').waitFor({ timeout: 15000 });
}

/** Open the floating Draw palette if it is collapsed (its state persists). */
async function openPalette(page) {
  const toggle = page.getByTestId('drawing-palette-toggle').first();
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}

async function step(page, n = 1) {
  for (let i = 0; i < n; i++) await page.getByTestId('btn-step10').click();
}

// 1) Hero: practice screen with split, R tool, open bracket, order ticket
{
  const page = await freshPage();
  await startSession(page, { blind: false, name: 'Morning practice' });
  await step(page, 1);
  await page.getByTestId('sl-ticks').fill('8');
  await page.getByTestId('tp-ticks').fill('12');
  await page.getByTestId('btn-buy').click();
  await step(page, 6);
  await page.getByTestId('sl-ticks').fill('8');
  await page.getByTestId('tp-ticks').fill('16');
  await page.getByTestId('btn-sell').click();
  await step(page, 4);
  await page.getByTestId('sl-ticks').fill('40');
  await page.getByTestId('tp-ticks').fill('80');
  await page.getByTestId('btn-buy').click();
  await page.getByTestId('btn-step').click();
  await page.getByTestId('btn-step').click();
  await page.getByTestId('btn-split').click();
  const body = await page.locator('.chart-body').first().boundingBox();
  await openPalette(page);
  await page.getByTestId('palette-long').first().click();
  await page.mouse.click(body.x + body.width * 0.72, body.y + body.height * 0.4);
  await page.waitForTimeout(4500);
  await page.mouse.move(body.x + body.width * 0.55, body.y + body.height * 0.5);
  await page.waitForTimeout(300);
  await clearToasts(page);
  await page.screenshot({ path: 'docs/screenshot.png' });
  await page.close();
  console.info('wrote docs/screenshot.png');
}

// 2) Blind practice badge + disguised chart
{
  const page = await freshPage();
  await startSession(page, { blind: true, name: 'Blind drill' });
  await step(page, 3);
  await page.getByTestId('blind-badge').waitFor({ timeout: 5000 });
  await page.waitForTimeout(500);
  await clearToasts(page);
  await page.screenshot({ path: 'docs/shot-blind.png' });
  await page.close();
  console.info('wrote docs/shot-blind.png');
}

// 3) Drawing palette open (tools visible)
{
  const page = await freshPage();
  await startSession(page, { blind: false, name: 'Draw tools' });
  await step(page, 2);
  await openPalette(page);
  await page.getByTestId('palette-hline').first().waitFor({ state: 'visible' });
  // Place a trendline so chart looks alive
  const body = await page.locator('.chart-body').first().boundingBox();
  await page.getByTestId('palette-tline').first().click();
  await page.mouse.click(body.x + body.width * 0.25, body.y + body.height * 0.65);
  await page.mouse.click(body.x + body.width * 0.7, body.y + body.height * 0.3);
  await page.waitForTimeout(400);
  // Re-open palette if it collapsed after tool use — keep tools visible for shot
  const hline = page.getByTestId('palette-hline').first();
  if (!(await hline.isVisible().catch(() => false))) {
    await openPalette(page);
    await hline.waitFor({ state: 'visible' });
  }
  await page.waitForTimeout(300);
  await clearToasts(page);
  await page.screenshot({ path: 'docs/shot-drawings.png' });
  await page.close();
  console.info('wrote docs/shot-drawings.png');
}

// 4) Multi-timeframe split + linked crosshair
{
  const page = await freshPage();
  await startSession(page, { blind: false, name: 'Multi-TF' });
  await step(page, 5);
  await page.getByTestId('btn-split').click();
  await page.waitForTimeout(400);
  // Change second pane TF if select exists
  const tf1 = page.getByTestId('tf-1');
  if (await tf1.count()) {
    await tf1.selectOption({ label: /15|1h|5/i }).catch(async () => {
      const opts = await tf1.locator('option').allTextContents();
      if (opts.length > 1) await tf1.selectOption({ index: Math.min(2, opts.length - 1) });
    });
  }
  const body = await page.locator('.chart-body').first().boundingBox();
  await page.mouse.move(body.x + body.width * 0.6, body.y + body.height * 0.45);
  await page.waitForTimeout(400);
  await clearToasts(page);
  await page.screenshot({ path: 'docs/shot-multitf.png' });
  await page.close();
  console.info('wrote docs/shot-multitf.png');
}

/** Add one catalog indicator and wait until it appears in the active list. */
async function addIndicator(page, query, kind) {
  const search = page.getByTestId('indicator-search');
  await search.fill(query);
  const add = page.getByTestId(`indicator-add-${kind}`);
  await add.waitFor({ state: 'visible', timeout: 5000 });
  await add.click();
  await page
    .locator('.indicator-panel .indicator-row', { hasText: new RegExp(query, 'i') })
    .first()
    .waitFor({ state: 'visible' });
  await search.fill('');
}

// 5) Indicators: SuperTrend + Keltner from the expanded catalog. Panel stays open.
{
  const page = await freshPage();
  await startSession(page, { blind: false, name: 'Indicators' });
  await step(page, 8);
  await page.waitForTimeout(1200);
  await page.locator('button.small.ghost', { hasText: 'Indicators' }).first().click();
  await page.getByTestId('indicator-panel').waitFor({ state: 'visible' });
  await addIndicator(page, 'SuperTrend', 'supertrend');
  await addIndicator(page, 'Keltner', 'keltner');
  await page.locator('.indicator-panel').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await page
    .locator('.indicator-panel .indicator-row', { hasText: /SuperTrend/i })
    .first()
    .waitFor({ state: 'visible' });
  await page.waitForTimeout(600);
  await clearToasts(page);
  await page.screenshot({ path: 'docs/shot-indicators.png' });
  await page.close();
  console.info('wrote docs/shot-indicators.png');
}

// v1.0 shots: rule check + review (desktop), phone and tablet layouts.
const PROFILE = {
  format: 'candledrill-rule-profile',
  version: 1,
  id: 'readme50k',
  name: 'My 50K rules',
  accountSize: 50000,
  profitTarget: 3000,
  dailyLoss: 1000,
  maxLoss: 2000,
  maxLossMode: 'eod',
  consistencyPct: 50,
  minTradingDays: 3,
  maxTradingDays: null,
  minProfitDays: null,
  minProfitDayAmount: null,
  maxContracts: 5,
  flatBy: '16:00',
  noOvernight: true,
  maxTradesPerDay: null,
  maxConsecutiveLosses: 4,
};
async function v1Page(viewport, mobile) {
  const ctx = await browser.newContext({
    viewport,
    deviceScaleFactor: mobile ? 2 : 1,
    isMobile: mobile,
    hasTouch: mobile,
    colorScheme: THEME,
    locale: 'en-US',
  });
  await ctx.addInitScript((p) => {
    localStorage.setItem('candledrill.profiles.v1', JSON.stringify([p]));
  }, PROFILE);
  await pinTheme(ctx);
  const page = await ctx.newPage();
  await page.goto(base, { waitUntil: 'networkidle' });
  const demoBtn = page.locator('#btn-demo');
  await demoBtn.click();
  await page.waitForTimeout(800);
  await page.getByTestId('ns-blind').setChecked(false);
  await page.getByTestId('ns-profile').selectOption('readme50k');
  await page.locator('#new-session-form input[name=name]').fill('Morning practice');
  await page.locator('#new-session-form button[type=submit]').click();
  await page.getByTestId('charts').waitFor({ timeout: 15000 });
  return { ctx, page };
}
{
  const { ctx, page } = await v1Page({ width: 1440, height: 900 }, false);
  await step(page, 2);
  await page.getByTestId('sl-ticks').fill('12');
  await page.getByTestId('tp-ticks').fill('24');
  await page.getByTestId('btn-buy').click();
  await step(page, 4);
  await page.getByTestId('btn-sell').click();
  await step(page, 4);
  await page.getByTestId('btn-buy').click();
  await step(page, 6);
  await page.waitForTimeout(4500);
  // Rule check moved off the side card into a bottom tab.
  await page.getByTestId('tab-rulecheck').click();
  await page.getByTestId('rule-check').waitFor({ state: 'visible', timeout: 8000 });
  await clearToasts(page);
  await page.screenshot({ path: 'docs/shot-rules.png' });
  console.info('wrote docs/shot-rules.png');
  // Closed round-trips so the journal has trades, stats and a daily P&L cell.
  for (let i = 0; i < 3; i++) {
    await page.getByTestId('btn-buy').click();
    await page.getByTestId('btn-step').click();
    await page.waitForTimeout(700);
    await page.getByTestId('btn-flatten').click();
    await page.getByTestId('btn-step').click();
    await page.waitForTimeout(700);
  }
  await page.getByTestId('tab-journal').click();
  await page.getByTestId('journal-table').waitFor({ timeout: 15000 });
  const saveField = async (prefix, value, select = false) => {
    const input = page.locator(`[data-testid^="${prefix}-"]`).first();
    await input.waitFor({ state: 'visible' });
    if (select) await input.selectOption(value);
    else {
      await input.fill(value);
      await input.blur().catch(() => {});
      await input.dispatchEvent('change').catch(() => {});
    }
    await page.getByText('Journal saved.').waitFor({ timeout: 8000 });
    await clearToasts(page);
  };
  await saveField('setup', 'ORB breakout');
  await saveField('market', 'Trend');
  await saveField('emotion', 'Calm');
  await saveField('plan-note', 'Waited for the open');
  await saveField('plan', 'yes', true);
  // The tab strip is short; open it tall enough that the new columns are readable.
  await page.evaluate(() => {
    const bottom = globalThis.document.querySelector('.bottom');
    if (bottom) bottom.style.height = '460px';
  });
  await page
    .locator('[data-testid^="setup-"]')
    .first()
    .evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' }));
  await page.waitForTimeout(300);
  await clearToasts(page);
  await page.screenshot({ path: 'docs/shot-review.png' });
  console.info('wrote docs/shot-review.png');
  await ctx.close();
}
{
  const { ctx, page } = await v1Page({ width: 390, height: 844 }, true);
  for (let i = 0; i < 3; i++) await page.getByTestId('tb-step10').click();
  await page.getByTestId('tb-buy').click();
  for (let i = 0; i < 2; i++) await page.getByTestId('tb-step10').click();
  await page.waitForTimeout(4500);
  await clearToasts(page);
  await page.screenshot({ path: 'docs/shot-phone.png' });
  console.info('wrote docs/shot-phone.png');
  await ctx.close();
}
{
  const { ctx, page } = await v1Page({ width: 1024, height: 768 }, true);
  await step(page, 3);
  await page.getByTestId('btn-buy').click();
  await step(page, 2);
  await page.waitForTimeout(4500);
  await clearToasts(page);
  await page.screenshot({ path: 'docs/shot-tablet.png' });
  console.info('wrote docs/shot-tablet.png');
  await ctx.close();
}

// Live sim: toolbar toggle, playing ticks, an open position, SYNTHETIC badge, rules strip.
{
  const { ctx, page } = await v1Page({ width: 1440, height: 900 }, false);
  await step(page, 2);
  await page.getByTestId('sim-toggle').click();
  await page.getByTestId('sim-badge').waitFor({ state: 'visible', timeout: 8000 });
  await page.getByTestId('rules-strip').waitFor({ state: 'visible' });
  await page.getByTestId('btn-play').click();
  await page.getByTestId('sl-ticks').fill('40');
  await page.getByTestId('tp-ticks').fill('80');
  await page.getByTestId('btn-buy').click();
  await page.getByTestId('position').getByText('Long').waitFor({ timeout: 15000 });
  await page.waitForTimeout(1200);
  await clearToasts(page);
  await page.screenshot({ path: 'docs/shot-live-sim.png' });
  console.info('wrote docs/shot-live-sim.png');
  await ctx.close();
}

await browser.close();
console.info('gallery done');
