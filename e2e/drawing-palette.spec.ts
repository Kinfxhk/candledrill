// SPDX-License-Identifier: AGPL-3.0-or-later
// Option A: collapsible floating palette (no top-bar drawing tools).
import { expect, test, type Page } from '@playwright/test';
import { generateDemo } from './helpers.js';

async function openPractice(page: Page, name: string) {
  await page.goto('/');
  await generateDemo(page);
  const form = page.locator('#new-session-form');
  await form.locator('input[name=name]').fill(name);
  await form.locator('button[type=submit]').click();
  await expect(page.locator('#practice-root')).toBeVisible();
}

test('palette expands, draws, collapses; Clear is labeled and confirms', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await openPractice(page, 'Palette A');

  // Top toolbar must not duplicate drawing tools.
  await expect(page.getByTestId('btn-hline')).toHaveCount(0);
  await expect(page.getByTestId('btn-long')).toHaveCount(0);
  await expect(page.getByTestId('btn-clear-drawings')).toHaveCount(0);

  const toggle = page.getByTestId('drawing-palette-toggle').first();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('palette-hline').first()).toBeHidden();

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('palette-hline').first()).toBeVisible();

  const clear = page.getByTestId('drawing-palette-clear').first();
  await expect(clear).toBeVisible();
  await expect(clear).not.toHaveText('×');
  await expect(clear).toContainText(/Clear|清除|消去|지우기|画线|畫線|描画|그리기/i);

  const body = page.locator('.chart-body').first();
  const box = (await body.boundingBox())!;
  const cx = box.x + box.width * 0.6;
  const cy = box.y + box.height * 0.45;
  await page.getByTestId('palette-long').first().click();
  await page.mouse.click(cx, cy);
  await expect(page.locator('[data-kind=risk]')).toHaveCount(1);

  // Collapse via toggle; tools hide, drawing stays.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('palette-long').first()).toBeHidden();
  await expect(page.locator('[data-kind=risk]')).toHaveCount(1);

  // Expand again; Clear asks confirm and clears.
  await toggle.click();
  page.once('dialog', (d) => {
    expect(d.type()).toBe('confirm');
    void d.dismiss();
  });
  await clear.click();
  await expect(page.locator('[data-kind=risk]')).toHaveCount(1);

  page.once('dialog', (d) => void d.accept());
  await clear.click();
  await expect(page.locator('[data-kind=risk]')).toHaveCount(0);

  expect(errors).toEqual([]);
});

test('language switch updates floating palette strings', async ({ page }) => {
  await openPractice(page, 'Palette i18n');
  const toggle = page.getByTestId('drawing-palette-toggle').first();
  await toggle.click();
  await expect(toggle).toHaveText('Draw');
  await expect(page.getByTestId('palette-text').first()).toHaveText('Text');

  await page.locator('#lang-picker').selectOption('zh-Hant');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hant');
  await expect(toggle).toHaveText('畫圖');
  await expect(page.getByTestId('palette-text').first()).toHaveText('文字');
  await expect(page.getByTestId('drawing-palette-clear').first()).toContainText('清除');

  await page.locator('#lang-picker').selectOption('ja');
  await expect(toggle).toHaveText('描画');
  await expect(page.getByTestId('palette-text').first()).toHaveText('テキスト');
});

test('Esc cancels draw mode then collapses palette', async ({ page }) => {
  await openPractice(page, 'Palette Esc');
  const toggle = page.getByTestId('drawing-palette-toggle').first();
  await toggle.click();
  await page.getByTestId('palette-tline').first().click();
  await expect(page.getByTestId('palette-tline').first()).toHaveAttribute('aria-pressed', 'true');

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('palette-tline').first()).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');

  await page.keyboard.press('Escape');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
});
