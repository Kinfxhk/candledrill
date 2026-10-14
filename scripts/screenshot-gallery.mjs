// SPDX-License-Identifier: AGPL-3.0-or-later
// Capture beginner-friendly README screenshots against a running server (synthetic only).
// Usage: CANDLEDRILL_DATA_DIR=... npm run serve
//   PW_CHROMIUM_PATH=/usr/bin/google-chrome node scripts/screenshot-gallery.mjs
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const base = process.argv[2] ?? 'http://127.0.0.1:4870';
const executablePath = process.env.PW_CHROMIUM_PATH;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
mkdirSync('docs', { recursive: true });

async function freshPage() {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
    locale: 'en-US',
  });
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
  await page.getByTestId('drawing-palette-toggle').first().click();
  await page.getByTestId('palette-long').first().click();
  await page.mouse.click(body.x + body.width * 0.72, body.y + body.height * 0.4);
  await page.waitForTimeout(4500);
  await page.mouse.move(body.x + body.width * 0.55, body.y + body.height * 0.5);
  await page.waitForTimeout(300);
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
  await page.screenshot({ path: 'docs/shot-blind.png' });
  await page.close();
  console.info('wrote docs/shot-blind.png');
}

// 3) Drawing palette open (tools visible)
{
  const page = await freshPage();
  await startSession(page, { blind: false, name: 'Draw tools' });
  await step(page, 2);
  await page.getByTestId('drawing-palette-toggle').first().click();
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
    await page.getByTestId('drawing-palette-toggle').first().click();
    await hline.waitFor({ state: 'visible' });
  }
  await page.waitForTimeout(300);
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
  await page.screenshot({ path: 'docs/shot-multitf.png' });
  await page.close();
  console.info('wrote docs/shot-multitf.png');
}

// 5) Indicators: enable SMA overlays + RSI pane, then screenshot with panel open
{
  const page = await freshPage();
  await startSession(page, { blind: false, name: 'Indicators' });
  await step(page, 8); // enough bars for SMA/RSI
  // Open Indicators button (first chart head)
  await page.locator('button.small.ghost', { hasText: 'Indicators' }).first().click();
  await page.locator('.indicator-panel').waitFor({ state: 'visible' });
  // Enable first three SMA checkboxes and RSI
  const rows = page.locator('.indicator-panel .indicator-row');
  const n = await rows.count();
  for (let i = 0; i < n; i++) {
    const text = await rows.nth(i).innerText();
    if (/SMA 9|SMA 20|SMA 50|RSI/i.test(text)) {
      const box = rows.nth(i).locator('input[type=checkbox]');
      if (!(await box.isChecked())) await box.check();
    }
  }
  await page.waitForTimeout(800);
  // Keep panel open for the screenshot
  await page.screenshot({ path: 'docs/shot-indicators.png' });
  await page.close();
  console.info('wrote docs/shot-indicators.png');
}

// 6) Semi-auto wizard: step 3 ready line, then step 4 result card (繁體中文 labels).
{
  const page = await freshPage();
  await page.locator('#lang-picker').selectOption('zh-Hant');
  await startSession(page, { blind: false, name: 'Semi-auto' });
  await step(page, 2);
  await page
    .locator('.toast')
    .waitFor({ state: 'hidden', timeout: 6000 })
    .catch(() => undefined);
  await page.getByTestId('macro-open').first().click();
  await page.getByTestId('macro-goto-run').click();
  await page
    .locator('.toolbar')
    .getByText(/SYNTH-/)
    .waitFor({ timeout: 5000 });
  const ready = page.locator('[data-testid=macro-ready].ok');
  await ready.waitFor({ timeout: 8000 });
  await page.getByTestId('macro-from-start').waitFor({ state: 'visible' });
  await page.getByTestId('macro-from-cursor').waitFor({ state: 'visible' });
  await page.getByTestId('macro-run').waitFor({ state: 'visible' });
  await page.getByTestId('macro-arm').waitFor({ state: 'visible' });
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'docs/shot-semi-run.png' });
  console.info('wrote docs/shot-semi-run.png');
  await page.getByTestId('macro-run').click();
  await page.getByTestId('macro-result').waitFor({ timeout: 30000 });
  await page
    .locator('.toast')
    .waitFor({ state: 'hidden', timeout: 6000 })
    .catch(() => undefined);
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'docs/shot-semi-result.png' });
  await page.close();
  console.info('wrote docs/shot-semi-result.png');
}

await browser.close();
console.info('gallery done');
