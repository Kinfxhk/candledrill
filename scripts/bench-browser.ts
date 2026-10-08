// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Browser side of the long-data benchmark: imports a large synthetic dataset into a RUNNING
// CandleDrill (use an empty CANDLEDRILL_DATA_DIR), opens a session at 80% of it in headless
// Chromium and times the first render and single-bar steps (one chart and split view).
// Usage: CANDLEDRILL_DATA_DIR=$(mktemp -d) CANDLEDRILL_PORT=4915 npm start   (other terminal)
//        PW_CHROMIUM_PATH=/usr/bin/google-chrome node --import tsx scripts/bench-browser.ts \
//          http://127.0.0.1:4915 500000
import { chromium } from '@playwright/test';
import { generateSyntheticBars } from '@candledrill/core';

const base = process.argv[2] ?? 'http://127.0.0.1:4870';
const target = Number(process.argv[3] ?? 500_000);
const token = ((await (await fetch(`${base}/api/token`)).json()) as { token: string }).token;
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-candledrill-token': token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
  return r.json() as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
};

const days = Math.ceil((target / 510) * 1.4) + 7;
const bars = generateSyntheticBars({
  seed: 42,
  startDate: '2020-01-06',
  days,
  tickSize: 0.25,
}).bars.slice(0, target);
const csv = [
  'time,open,high,low,close,volume',
  ...bars.map((b) => `${b.time},${b.open},${b.high},${b.low},${b.close},${b.volume}`),
].join('\n');
const ds = (
  await api('POST', '/api/datasets/import', {
    name: 'bench',
    symbol: 'BENCH',
    tickSize: 0.25,
    csv,
    options: {
      mapping: { time: 0, open: 1, high: 2, low: 3, close: 4, volume: 5 },
      hasHeader: true,
      timeFormat: 'unix-s',
    },
  })
).dataset;
const settings = {
  tickSize: 0.25,
  pointValue: 50,
  commissionPerContract: 2,
  slippageTicks: 1,
  startingBalance: 50000,
  dailyLossLimit: null,
  trailingDrawdown: null,
  profitTarget: null,
  utcOffsetMinutes: 0,
  dayStartMinutes: 0,
};
const id = (
  await api('POST', '/api/sessions', {
    datasetId: ds.id,
    name: 'bench',
    startTime: bars[Math.floor(bars.length * 0.8)]!.time,
    settings,
  })
).session.id;

const executablePath = process.env.PW_CHROMIUM_PATH;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript((sid) => localStorage.setItem('candledrill.lastSession', String(sid)), id);
const t0 = performance.now();
await page.goto(base);
await page.getByTestId('clock').waitFor({ state: 'visible', timeout: 60_000 });
await page.locator('.chart-body canvas').first().waitFor({ state: 'visible' });
const firstRender = performance.now() - t0;

async function stepTimes(n: number): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const before = await page.getByTestId('clock').textContent();
    const t = performance.now();
    await page.getByTestId('btn-step').click();
    await page.waitForFunction(
      (b) => document.querySelector('[data-testid=clock]')?.textContent !== b,
      before,
    );
    out.push(performance.now() - t);
  }
  return out;
}
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return `median ${s[Math.floor(s.length / 2)]!.toFixed(0)} ms, p95 ${s[Math.floor(s.length * 0.95)]!.toFixed(0)} ms`;
};
const single = await stepTimes(60);
await page.getByTestId('btn-split').click();
await page.waitForTimeout(500);
const split = await stepTimes(60);
const heap = await page.evaluate(
  () =>
    (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0,
);
await browser.close();
console.info(
  `| first render of a session at bar ${Math.floor(bars.length * 0.8).toLocaleString('en')} (50,000 bars sent) | ${firstRender.toFixed(0)} ms |`,
);
console.info(`| step 1 bar, one chart (60 clicks, round trip + redraw) | ${stats(single)} |`);
console.info(`| step 1 bar, split view (60 clicks) | ${stats(split)} |`);
console.info(`| page JS heap after the run | ${(heap / 1024 / 1024).toFixed(0)} MiB |`);
