// SPDX-License-Identifier: AGPL-3.0-or-later
// Language switch must not leave mount-once copy, an open Settings dialog, or the
// OHLC legend in the previous language. The browser-build notice is covered in
// packages/web/test/locale-chrome.test.ts (this server build does not show it).
import { expect, test } from '@playwright/test';
import { generateDemo } from './helpers.js';

test('locale switch refreshes chrome, open settings, and the OHLC legend', async ({ page }) => {
  await page.goto('/');
  await page.locator('#lang-picker').selectOption('zh-Hant');
  await expect(page.getByTestId('profile-new')).toHaveText('新增規則檔');
  await expect(page.getByTestId('profile-import')).toHaveText('匯入');
  await expect(page.getByTestId('ns-profile').locator('option').first()).toHaveText('不使用規則檔');
  await expect(page.getByTestId('footer-recommend')).toHaveText('推薦連結（含聯盟佣金）');

  await page.locator('#about-open').click();
  const about = page.locator('#about-dialog');
  await expect(about.locator('h3').first()).toHaveText('第三方聲明');
  await expect(page.getByTestId('referral-link')).toHaveText('開啟 KINFX 連結頁');
  await expect(page.getByTestId('disclosure')).toContainText('完整披露');
  await about.locator('button.primary').click();

  await page.getByTestId('settings-open').click();
  const settings = page.getByTestId('settings-dialog');
  await expect(settings.locator('#settings-title')).toHaveText('設定');
  const qty = settings.locator('input[name="qtyPresets"]');
  await qty.fill('9, 9');
  await page.locator('#lang-picker').selectOption('zh-Hans');
  await expect(settings.locator('#settings-title')).toHaveText('设置');
  await expect(settings.getByText('涨', { exact: true })).toBeVisible();
  await expect(qty).toHaveValue('9, 9');
  await settings.locator('button.primary').click();

  await expect(page.getByTestId('profile-new')).toHaveText('新建规则档');
  await expect(page.getByTestId('ns-profile').locator('option').first()).toHaveText('不使用规则档');
  await expect(page.getByTestId('footer-recommend')).toHaveText('推荐链接（含联盟佣金）');

  await generateDemo(page);
  await page.locator('#new-session-form button[type=submit]').click();
  await expect(page.locator('#practice-root')).toBeVisible();
  const legend = page.getByTestId('ohlc-legend').first();
  await expect.poll(async () => legend.textContent()).toMatch(/^开 /);
  await expect(page.getByTestId('checkpoints')).toContainText('暂无存档点');

  await page.locator('#lang-picker').selectOption('en');
  await expect.poll(async () => legend.textContent()).toMatch(/^O /);
  await expect(page.getByTestId('checkpoints')).toContainText('No save points yet');
  await page.locator('#lang-picker').selectOption('zh-Hant');
  await expect.poll(async () => legend.textContent()).toMatch(/^開 /);
  await expect(page.getByTestId('checkpoints')).toContainText('暫未有存檔點');
});
