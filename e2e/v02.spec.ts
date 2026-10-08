// SPDX-License-Identifier: AGPL-3.0-or-later
// v0.2: blind practice, drawing tools, session file import, backup and restore, reminder.
import { copyFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/423|Locked/.test(m.text())) errors.push(m.text());
  });
  return errors;
}

/** Generate demo data and wait until the new dataset is selected (the form is prefilled). */
async function demo(page: Page) {
  const list = async () =>
    (await (await page.request.get('/api/datasets')).json()).datasets as { id: number }[];
  const before = (await list()).length;
  await page.click('#btn-demo');
  let now = await list();
  for (let i = 0; i < 50 && now.length === before; i++) {
    await page.waitForTimeout(100);
    now = await list();
  }
  const id = now.at(-1)!.id;
  await expect(page.locator(`#dataset-list li[data-id="${id}"]`)).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('#new-session-form input[name=name]')).not.toHaveValue('');
}

async function newSession(page: Page, name: string, blind = false) {
  const form = page.locator('#new-session-form');
  await expect(form).toBeVisible();
  await expect(form.locator('input[name=name]')).not.toHaveValue('');
  if (blind) {
    await form.getByTestId('ns-blind').check();
    await expect(form.locator('input[name=name]')).toHaveValue(/^Blind /);
  }
  await form.locator('input[name=name]').fill(name);
  await form.locator('button[type=submit]').click();
  await expect(page.locator('#practice-root')).toBeVisible();
}

async function sessionByName(page: Page, name: string) {
  const list = await (await page.request.get('/api/sessions')).json();
  const s = list.sessions.find((x: { name: string }) => x.name === name);
  return (await page.request.get(`/api/sessions/${s.id}`)).json();
}

test('a delayed step from the previous session cannot change the newly opened session', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.goto('/');
  await demo(page);
  await newSession(page, 'Race A');
  const a = await sessionByName(page, 'Race A');
  await page.getByTestId('btn-buy').click();
  await expect(page.getByTestId('orders')).toContainText('MKT');

  let release!: () => void;
  let arrived!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const ready = new Promise<void>((r) => (arrived = r));
  await page.route(`**/api/sessions/${a.session.id}/step`, async (route) => {
    const response = await route.fetch();
    arrived();
    await gate;
    await route.fulfill({ response });
  });
  try {
    await page.getByTestId('btn-step').click();
    await ready;
    await page.click('nav.tabs button[data-view=library]');
    await newSession(page, 'Race B');
    await expect(page.locator('.toolbar strong')).toHaveText('Race B');
    const b = await sessionByName(page, 'Race B');
    const clock = await page.getByTestId('clock').textContent();
    const response = page.waitForResponse((r) =>
      r.url().endsWith(`/sessions/${a.session.id}/step`),
    );
    release();
    await response;
    // The next live step must use B's state, and only advance B once.
    await page.getByTestId('btn-step').click();
    await expect
      .poll(async () => (await sessionByName(page, 'Race B')).state.cursor)
      .toBe(b.state.cursor + 1);
    await expect(page.getByTestId('position')).toContainText('Flat');
    await expect(page.getByTestId('clock')).not.toHaveText(clock!);
    expect(errors).toEqual([]);
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('blind practice hides the period, symbol and preview until revealed', async ({ page }) => {
  const errors = watchErrors(page);
  const bodies: string[] = [];
  page.on('response', async (r) => {
    if (r.url().includes('/api/sessions')) bodies.push(await r.text().catch(() => ''));
  });
  await page.goto('/');
  await demo(page);
  const symbol = (await (await page.request.get('/api/datasets')).json()).datasets.at(-1)
    .symbol as string;
  await newSession(page, 'Blind e2e', true);
  await expect(page.getByTestId('blind-badge')).toBeVisible();
  await expect(page.getByTestId('clock')).toHaveText(/^Day \d+ · \w{3} \d\d:\d\d$/);
  await expect(page.getByTestId('btn-jump')).toBeHidden();
  await page.getByTestId('btn-step10').click();
  await page.getByTestId('btn-buy').click();
  await page.getByTestId('btn-step10').click();
  await expect(page.locator('#practice-root')).not.toContainText(symbol);
  await expect(page.locator('.charts')).not.toContainText(/20\d\d-\d\d-\d\d/);

  // Library: the dataset preview is locked while the blind session runs.
  await page.click('nav.tabs button[data-view=library]');
  await page.locator('#dataset-list li').last().click();
  await expect(page.locator('#preview-locked')).toBeVisible();
  await expect(page.locator('#session-table')).toContainText('blind');
  for (const b of bodies) expect(b).not.toContain(symbol);

  // Reveal.
  await page.click('nav.tabs button[data-view=practice]');
  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('btn-reveal').click();
  await expect(page.getByTestId('reveal-banner')).toContainText(symbol);
  await expect(page.getByTestId('reveal-banner')).toContainText(/20\d\d-\d\d-\d\d/);
  await page.click('nav.tabs button[data-view=library]');
  await page.locator('#dataset-list li').last().click();
  await expect(page.locator('#preview-locked')).toBeHidden();
  expect(errors).toEqual([]);
});

test('rectangle and long R tool: draw, drag the stop, delete', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/');
  await demo(page);
  await newSession(page, 'Draw e2e');
  const body = page.locator('.chart-body').first();
  const box = (await body.boundingBox())!;
  const cx = box.x + box.width * 0.6;
  const cy = box.y + box.height * 0.45;

  await page.getByTestId('btn-long').click();
  await page.mouse.click(cx, cy);
  await expect(page.locator('[data-kind=risk]')).toHaveCount(1);
  await expect(page.locator('[data-testid^=rlabel-]')).toContainText(
    /Long · risk 20 ticks .* reward 40 ticks · 2\.00R/,
  );

  let v = await sessionByName(page, 'Draw e2e');
  const pos = v.session.drawings[0];
  expect(pos).toMatchObject({ kind: 'position', side: 'long' });
  expect(pos.entry - pos.stop).toBeCloseTo(20 * v.session.settings.tickSize, 9);

  // Drag the stop handle further down: risk grows, R falls.
  const stop = page.locator(`[data-drawing="${pos.id}"][data-part=stop]`);
  const sb = (await stop.boundingBox())!;
  await page.mouse.move(sb.x + 5, sb.y + 5);
  await page.mouse.down();
  await page.mouse.move(sb.x + 5, sb.y + 45, { steps: 5 });
  await page.mouse.up();
  await expect
    .poll(async () => (await sessionByName(page, 'Draw e2e')).session.drawings[0].stop)
    .toBeLessThan(pos.stop);

  await page.getByTestId('btn-rect').click();
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.waitForTimeout(600);
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.5);
  await expect(page.locator('[data-kind=rect]')).toHaveCount(1);
  v = await sessionByName(page, 'Draw e2e');
  expect(v.session.drawings.map((d: { kind: string }) => d.kind)).toEqual(['position', 'rect']);

  // Select the R tool (press its entry handle) and delete it with the × button.
  const entry = page.locator(`[data-drawing="${pos.id}"][data-part=entry]`);
  const eb = (await entry.boundingBox())!;
  await page.mouse.move(eb.x + 5, eb.y + 5);
  await page.mouse.down();
  await page.mouse.up();
  await page.getByTestId('delete-drawing').dispatchEvent('pointerdown');
  await expect
    .poll(async () => (await sessionByName(page, 'Draw e2e')).session.drawings.length)
    .toBe(1);

  // Two linked charts keep working with drawings and the crosshair.
  await page.getByTestId('btn-split').click();
  await expect(page.locator('.chart-body')).toHaveCount(2);
  await expect(page.getByTestId('link-charts')).toBeVisible();
  await page.mouse.move(cx, cy);
  await page.mouse.move(cx - 40, cy);
  await expect(page.locator('[data-kind=rect]')).toHaveCount(2);
  expect(errors).toEqual([]);
});

test('session file import, full backup and restore, reminder', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/');
  await page.evaluate(() => localStorage.removeItem('candledrill.backup'));
  await demo(page);
  await newSession(page, 'Keep me');
  await page.getByTestId('btn-buy').click();
  await page.getByTestId('btn-step10').click();
  const orig = await sessionByName(page, 'Keep me');
  const file = test.info().outputPath('session.json');
  const exp = await page.request.get(`/api/sessions/${orig.session.id}/export/session.json`);
  (await import('node:fs')).writeFileSync(file, await exp.body());

  // Import it as a new session.
  await page.click('nav.tabs button[data-view=library]');
  await page.locator('#session-file').setInputFiles(file);
  await expect(page.locator('#practice-root')).toBeVisible();
  const list = (await (await page.request.get('/api/sessions')).json()).sessions;
  expect(list.filter((s: { name: string }) => s.name === 'Keep me')).toHaveLength(2);
  const copy = (
    await page.request.get(`/api/sessions/${Math.max(...list.map((s: { id: number }) => s.id))}`)
  ).json();
  expect((await copy).state).toEqual(orig.state);

  // Reminder after a few changes (two new sessions + one import so far => add one more).
  await page.click('nav.tabs button[data-view=library]');
  await newSession(page, 'Third');
  await page.click('nav.tabs button[data-view=library]');
  await expect(page.locator('#backup-reminder')).toBeVisible();

  // Back up (download), then change things, then restore.
  const atBackup = (await (await page.request.get('/api/sessions')).json()).sessions
    .length as number;
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#remind-backup').click(),
  ]);
  const backup = test.info().outputPath(dl.suggestedFilename());
  copyFileSync((await dl.path())!, backup);
  expect(dl.suggestedFilename()).toMatch(/^candledrill-backup-\d{8}-\d{6}\.db$/);
  await expect(page.locator('#backup-reminder')).toBeHidden();
  await page.request.delete(`/api/sessions/${orig.session.id}`, {
    headers: { 'x-candledrill-token': (await (await page.request.get('/api/token')).json()).token },
  });
  page.once('dialog', (d) => void d.accept());
  await page.locator('#restore-file').setInputFiles(backup);
  await expect(page.locator('.toast')).toContainText(
    new RegExp(`Restored \\d+ datasets and ${atBackup} sessions`),
  );
  await expect(page.locator('#session-table tbody tr')).toHaveCount(atBackup);
  const back = await sessionByName(page, 'Keep me');
  expect(back.state).toEqual(orig.state);
  expect(errors).toEqual([]);
});
