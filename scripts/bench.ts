// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Long-data benchmark: builds a synthetic 1-minute dataset (default 500,000 bars), imports
// it through the real HTTP API as CSV into a temporary database, then times the main
// operations. Nothing is written outside a temporary folder.
// Usage: node --import tsx scripts/bench.ts [bars=500000]
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir, cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { generateSyntheticBars } from '@candledrill/core';
import { buildApp } from '../packages/server/src/app.js';
import { openDatabase } from '../packages/server/src/db.js';

const target = Number(process.argv[2] ?? 500_000);
const TOKEN = 'bench-token-0123456789abcdef';
const rows: [string, string][] = [];
const ms = (t: number) => `${(performance.now() - t).toFixed(0)} ms`;
const time = async <T>(label: string, f: () => Promise<T> | T): Promise<T> => {
  const t = performance.now();
  const r = await f();
  rows.push([label, ms(t)]);
  return r;
};

const days = Math.ceil((target / 510) * 1.4) + 7;
const bars = (
  await time('generate bars (core)', () =>
    generateSyntheticBars({ seed: 42, startDate: '2020-01-06', days, tickSize: 0.25 }),
  )
).bars.slice(0, target);
const csv = await time('build CSV text', () =>
  [
    'time,open,high,low,close,volume',
    ...bars.map((b) => `${b.time},${b.open},${b.high},${b.low},${b.close},${b.volume}`),
  ].join('\n'),
);
rows.push(['CSV size', `${(csv.length / 1024 / 1024).toFixed(1)} MiB`]);

const dir = mkdtempSync(join(tmpdir(), 'cd-bench-'));
const dbPath = join(dir, 'candledrill.db');
const db = openDatabase(dbPath);
const app = buildApp({ db, apiToken: TOKEN, databasePath: dbPath });
const call = async (method: string, url: string, payload?: unknown) => {
  const r = await app.inject({
    method: method as 'GET',
    url,
    payload: payload as string,
    headers: { 'x-candledrill-token': TOKEN },
  });
  if (r.statusCode >= 400)
    throw new Error(`${method} ${url}: ${r.statusCode} ${r.body.slice(0, 300)}`);
  return r;
};

const ds = (
  await time(`import ${bars.length.toLocaleString('en')} bars (HTTP, CSV)`, () =>
    call('POST', '/api/datasets/import', {
      name: 'bench',
      symbol: 'BENCH',
      tickSize: 0.25,
      csv,
      options: {
        mapping: { time: 0, open: 1, high: 2, low: 3, close: 4, volume: 5 },
        hasHeader: true,
        timeFormat: 'unix-s',
      },
    }),
  )
).json().dataset;
rows.push([
  'database size after import',
  `${(statSync(dbPath).size / 1024 / 1024).toFixed(1)} MiB`,
]);

const SET = {
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
const startTime = bars[Math.floor(bars.length * 0.8)]!.time;
const created = await time('create session at 80% (first load of the bars)', () =>
  call('POST', '/api/sessions', { datasetId: ds.id, name: 'bench', startTime, settings: SET }),
);
const id = created.json().session.id;
const view = await time('open session (sends last 50,000 bars)', () =>
  call('GET', `/api/sessions/${id}`),
);
rows.push(['session response size', `${(view.body.length / 1024 / 1024).toFixed(1)} MiB`]);
await call('POST', `/api/sessions/${id}/orders`, { side: 'buy', type: 'market', qty: 1 });
const steps = 200;
const t0 = performance.now();
for (let i = 0; i < steps; i++) {
  await call('POST', `/api/sessions/${id}/step`, { count: 1 });
  if (i % 20 === 10) await call('POST', `/api/sessions/${id}/flatten`).catch(() => undefined);
  if (i % 20 === 0)
    await call('POST', `/api/sessions/${id}/orders`, {
      side: i % 40 ? 'sell' : 'buy',
      type: 'market',
      qty: 1,
    }).catch(() => undefined);
}
rows.push([
  `step 1 bar (mean of ${steps}, with orders)`,
  `${((performance.now() - t0) / steps).toFixed(1)} ms`,
]);
await time('step 5,000 bars in one action (API maximum)', () =>
  call('POST', `/api/sessions/${id}/step`, { count: 5_000 }),
);
await time('journal (MAE/MFE + hour/weekday stats)', () =>
  call('GET', `/api/sessions/${id}/journal`),
);
const backup = await time('full backup download', () => call('GET', '/api/backup'));
rows.push(['backup file size', `${(backup.rawPayload.length / 1024 / 1024).toFixed(1)} MiB`]);
await time('restore that backup', () =>
  app.inject({
    method: 'POST',
    url: '/api/restore',
    payload: backup.rawPayload,
    headers: { 'x-candledrill-token': TOKEN, 'content-type': 'application/vnd.sqlite3' },
  }),
);
await app.close();
db.close();
rmSync(dir, { recursive: true, force: true });

rows.push(['peak RSS', `${(process.resourceUsage().maxRSS / 1024).toFixed(0)} MiB`]);
console.info(
  `CandleDrill benchmark — node ${process.version}, ${cpus()[0]?.model ?? 'cpu'} ×${cpus().length}, ${(totalmem() / 2 ** 30).toFixed(0)} GiB RAM, ${process.platform}`,
);
console.info('| operation | result |\n|---|---|');
for (const [k, v] of rows) console.info(`| ${k} | ${v} |`);
