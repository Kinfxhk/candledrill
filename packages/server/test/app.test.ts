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
