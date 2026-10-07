// SPDX-License-Identifier: AGPL-3.0-or-later
// Regenerate docs/screenshot.png against a running server (synthetic data only).
// Usage: npm start (in another terminal), then
//   PW_CHROMIUM_PATH=/usr/bin/google-chrome node scripts/screenshot.mjs [http://127.0.0.1:4870]
import { chromium } from '@playwright/test';

const base = process.argv[2] ?? 'http://127.0.0.1:4870';
const executablePath = process.env.PW_CHROMIUM_PATH;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  colorScheme: 'dark',
  locale: 'en-US',
});
await page.goto(base);
await page.click('#btn-demo');
await page.locator('#new-session-form input[name=name]').fill('Morning practice');
await page.locator('#new-session-form button[type=submit]').click();
await page.getByTestId('btn-step10').click();
await page.getByTestId('sl-ticks').fill('8');
await page.getByTestId('tp-ticks').fill('12');
await page.getByTestId('btn-buy').click();
for (let i = 0; i < 6; i++) await page.getByTestId('btn-step10').click();
await page.getByTestId('sl-ticks').fill('8');
await page.getByTestId('tp-ticks').fill('16');
await page.getByTestId('btn-sell').click();
for (let i = 0; i < 4; i++) await page.getByTestId('btn-step10').click();
// Leave an open bracket position on screen so the ticket, P&L and order lines are visible.
await page.getByTestId('sl-ticks').fill('40');
await page.getByTestId('tp-ticks').fill('80');
await page.getByTestId('btn-buy').click();
await page.getByTestId('btn-step').click();
await page.getByTestId('btn-step').click();
await page.getByTestId('btn-split').click();
await page.waitForTimeout(4500); // let toasts fade
await page.screenshot({ path: 'docs/screenshot.png' });
await browser.close();
console.info('wrote docs/screenshot.png');
