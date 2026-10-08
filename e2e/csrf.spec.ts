// SPDX-License-Identifier: AGPL-3.0-or-later
// Browser-level check of the cross-origin protection: a page served from another origin
// (here another port on 127.0.0.1) cannot change local data with a form post, and
// same-origin scripts without the per-launch token are refused, while the UI keeps working.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Page } from '@playwright/test';

async function startPractice(page: Page, name: string) {
  await page.goto('/');
  await page.click('#btn-demo');
  const form = page.locator('#new-session-form');
  await expect(form).toBeVisible();
  await form.locator('input[name=name]').fill(name);
  await form.locator('button[type=submit]').click();
  await expect(page.locator('#practice-root')).toBeVisible();
  // A limit order far below the market stays working: the UI could still write.
  await page.getByTestId('type-limit').click();
  const last = await page.getByTestId('price').inputValue();
  await page.getByTestId('price').fill(String(Number(last) - 5));
  await page.getByTestId('btn-buy').click();
  await expect(page.getByTestId('orders')).toContainText(/limit/i);
  const list = await (await page.request.get('/api/sessions')).json();
  const s = list.sessions.find((x: { name: string }) => x.name === name);
  return s.id as number;
}

async function workingCount(page: Page, id: number): Promise<number> {
  const view = await (await page.request.get(`/api/sessions/${id}`)).json();
  return view.state.trading.orders.filter((o: { status: string }) => o.status === 'working').length;
}

test('a page on another origin cannot flatten or delete via form posts', async ({
  page,
  baseURL,
}) => {
  const id = await startPractice(page, 'CSRF form');
  expect(await workingCount(page, id)).toBe(1);

  const target = `${baseURL}/api/sessions/${id}`;
  const evil: Server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><body>
      <form id="f" method="POST" action="${target}/flatten" enctype="text/plain">
        <input name="x" value="1"></form>
      <script>document.getElementById('f').submit();</script></body>`);
  });
  await new Promise<void>((r) => evil.listen(0, '127.0.0.1', () => r()));
  try {
    const port = (evil.address() as AddressInfo).port;
    const response = page.waitForResponse((r) => r.url() === `${target}/flatten`);
    await page.goto(`http://127.0.0.1:${port}/`);
    const res = await response;
    expect(res.status()).toBe(403);
  } finally {
    evil.close();
  }
  expect(await workingCount(page, id)).toBe(1);
});

test('same-origin scripts need the per-launch token; the UI still writes', async ({ page }) => {
  const id = await startPractice(page, 'CSRF token');
  const result = await page.evaluate(async (sid) => {
    const bare = await fetch(`/api/sessions/${sid}/flatten`, { method: 'POST' });
    const { token, header } = await (await fetch('/api/token')).json();
    const withToken = await fetch(`/api/sessions/${sid}/flatten`, {
      method: 'POST',
      headers: { [header]: token },
    });
    return { bare: bare.status, withToken: withToken.status };
  }, id);
  expect(result).toEqual({ bare: 403, withToken: 200 });
  expect(await workingCount(page, id)).toBe(0);
});
