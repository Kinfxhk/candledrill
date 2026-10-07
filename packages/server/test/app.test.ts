// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { openDatabase, type Db } from '../src/db.js';
import { LOOPBACK_HOST } from '../src/config.js';

let app: FastifyInstance | undefined;
let db: Db | undefined;

function setup(): FastifyInstance {
  db = openDatabase(':memory:');
  app = buildApp({ db, now: () => new Date('2026-10-07T12:00:00Z') });
  return app;
}

afterEach(async () => {
  await app?.close();
  db?.close();
  app = undefined;
  db = undefined;
});

describe('HTTP API', () => {
  it('GET /api/health reports no telemetry and the risk notice', async () => {
    const res = await setup().inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ status: 'ok', name: 'CandleDrill', telemetry: false });
    expect(body.notice).toMatch(/not investment advice/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('rejects requests addressed to a non-loopback Host (DNS rebinding guard)', async () => {
    const a = setup();
    const bad = await a.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: 'evil.example:4870' },
    });
    expect(bad.statusCode).toBe(421);
    const ok = await a.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: '127.0.0.1:4870' },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('creates a synthetic dataset and serves its bars', async () => {
    const a = setup();
    const created = await a.inject({
      method: 'POST',
      url: '/api/datasets/synthetic',
      payload: { seed: 99, startDate: '2026-10-05', days: 1, name: 'DEMO' },
    });
    expect(created.statusCode).toBe(201);
    const ds = created.json().dataset;
    expect(ds).toMatchObject({ symbol: 'SYNTH-DEMO', synthetic: true, barCount: 510 });
    expect(ds.createdAt).toBe('2026-10-07T12:00:00.000Z');

    const list = await a.inject({ method: 'GET', url: '/api/datasets' });
    expect(list.json().datasets).toHaveLength(1);

    const to = ds.firstTime + 9 * 60;
    const bars = await a.inject({ method: 'GET', url: `/api/datasets/${ds.id}/bars?to=${to}` });
    expect(bars.statusCode).toBe(200);
    expect(bars.json().bars).toHaveLength(10);
    expect(bars.json().synthetic).toBe(true);
  });

  it('validates input', async () => {
    const a = setup();
    const r1 = await a.inject({
      method: 'POST',
      url: '/api/datasets/synthetic',
      payload: { seed: 1, startDate: '2026-10-05', days: 10_000 },
    });
    expect(r1.statusCode).toBe(400);
    const r2 = await a.inject({
      method: 'POST',
      url: '/api/datasets/synthetic',
      payload: { seed: 1, startDate: '2026-02-30', days: 1 },
    });
    expect(r2.statusCode).toBe(400);
    const r3 = await a.inject({ method: 'GET', url: '/api/datasets/999/bars' });
    expect(r3.statusCode).toBe(404);
    const r4 = await a.inject({ method: 'GET', url: '/api/datasets/1/bars?limit=999999' });
    expect(r4.statusCode).toBe(400);
  });

  it('listens on 127.0.0.1 only', async () => {
    const a = setup();
    await a.listen({ host: LOOPBACK_HOST, port: 0 });
    const addrs = a.addresses();
    expect(addrs.length).toBeGreaterThan(0);
    expect(addrs.every((x) => x.address === LOOPBACK_HOST)).toBe(true);
  });
});

describe('CSV import API', () => {
  const csv = [
    'Date,Time,Open,High,Low,Close,Volume',
    '2026-01-05,09:30,100,101,99.5,100.5,10',
    '2026-01-05,09:31,100.5,102,100,101.75,12',
    '2026-01-05,09:32,101.75,102.25,101,101.25,8',
  ].join('\n');
  const options = {
    mapping: { time: 0, timeOfDay: 1, open: 2, high: 3, low: 4, close: 5, volume: 6 },
  };

  it('imports a valid file and serves it', async () => {
    const a = setup();
    const res = await a.inject({
      method: 'POST',
      url: '/api/datasets/import',
      payload: {
        name: 'My data',
        symbol: 'TEST',
        tickSize: 0.25,
        csv,
        options: { ...options, utcOffsetMinutes: -300 },
      },
    });
    expect(res.statusCode).toBe(201);
    const { dataset, report } = res.json();
    expect(dataset).toMatchObject({
      symbol: 'TEST',
      synthetic: false,
      source: 'user-import',
      barCount: 3,
      utcOffsetMinutes: -300,
    });
    expect(report.timeframeSeconds).toBe(60);
    expect(dataset.firstTime).toBe(Date.UTC(2026, 0, 5, 14, 30) / 1000);
    const bars = await a.inject({
      method: 'GET',
      url: `/api/datasets/${dataset.id}/bars?limit=2&last=true`,
    });
    expect(bars.json().bars.map((b: { close: number }) => b.close)).toEqual([101.75, 101.25]);
    const del = await a.inject({ method: 'DELETE', url: `/api/datasets/${dataset.id}` });
    expect(del.statusCode).toBe(204);
    expect((await a.inject({ method: 'GET', url: '/api/datasets' })).json().datasets).toHaveLength(
      0,
    );
  });

  it('returns a report for invalid data and rejects reserved symbols', async () => {
    const a = setup();
    const bad = await a.inject({
      method: 'POST',
      url: '/api/datasets/import',
      payload: { name: 'x', symbol: 'TEST', tickSize: 1, csv, options },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().report.barIssues[0].code).toBe('off-tick-grid');
    const reserved = await a.inject({
      method: 'POST',
      url: '/api/datasets/import',
      payload: { name: 'x', symbol: 'synth-x', tickSize: 0.25, csv, options },
    });
    expect(reserved.statusCode).toBe(400);
  });

  it('sends a strict Content-Security-Policy', async () => {
    const res = await setup().inject({ method: 'GET', url: '/api/health' });
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['content-security-policy']).toContain("connect-src 'self'");
  });
});
