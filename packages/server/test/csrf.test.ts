// SPDX-License-Identifier: AGPL-3.0-or-later
// Cross-origin (CSRF-style) protection of the local API: state-changing requests need the
// per-launch token and, when the browser states an origin, it must be the server's own.
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { openDatabase, type Db } from '../src/db.js';
import { SETTINGS, TEST_TOKEN } from './helpers.js';

let app: FastifyInstance | undefined;
let db: Db | undefined;
const HOST = '127.0.0.1:4870';
const SELF = `http://${HOST}`;

afterEach(async () => {
  await app?.close();
  db?.close();
});

type Inject = (o: InjectOptions) => Promise<LightMyRequestResponse>;

async function setup(): Promise<{ inject: Inject; sid: number; orderId: number }> {
  db = openDatabase(':memory:');
  app = buildApp({ db, apiToken: TEST_TOKEN });
  const inject: Inject = (o) =>
    app!.inject({
      ...o,
      headers: { host: HOST, ...(o.headers ?? {}) },
    }) as Promise<LightMyRequestResponse>;
  const auth = { 'x-candledrill-token': TEST_TOKEN };
  const ds = await inject({
    method: 'POST',
    url: '/api/datasets/synthetic',
    headers: auth,
    payload: { seed: 1, startDate: '2026-01-05', days: 2 },
  });
  const dsId = ds.json().dataset.id;
  const first = ds.json().dataset.firstTime as number;
  const s = await inject({
    method: 'POST',
    url: '/api/sessions',
    headers: auth,
    payload: { datasetId: dsId, name: 'csrf', startTime: first + 3600, settings: SETTINGS },
  });
  const sid = s.json().session.id;
  const last = s.json().state.trading.lastClose as number;
  const o = await inject({
    method: 'POST',
    url: `/api/sessions/${sid}/orders`,
    headers: auth,
    payload: { side: 'buy', type: 'limit', qty: 1, price: last - 25 },
  });
  return { inject, sid, orderId: o.json().state.trading.orders[0].id };
}

const working = async (inject: Inject, sid: number) =>
  (await inject({ method: 'GET', url: `/api/sessions/${sid}` }))
    .json()
    .state.trading.orders.filter((o: { status: string }) => o.status === 'working').length;

describe('cross-origin protection', () => {
  it.each([
    ['a foreign origin', { origin: 'https://cross-origin.example' }],
    ['the null origin', { origin: 'null' }],
    ['another port on loopback', { origin: 'http://127.0.0.1:9999' }],
    ['a different loopback name', { origin: 'http://localhost:4870' }],
    ['https on the same host', { origin: 'https://127.0.0.1:4870' }],
    ['Sec-Fetch-Site: cross-site', { 'sec-fetch-site': 'cross-site' }],
    ['Sec-Fetch-Site: same-site', { 'sec-fetch-site': 'same-site' }],
  ])('refuses writes from %s even with a valid token', async (_label, extra) => {
    const { inject, sid } = await setup();
    const res = await inject({
      method: 'POST',
      url: `/api/sessions/${sid}/flatten`,
      headers: { 'x-candledrill-token': TEST_TOKEN, 'content-type': 'text/plain', ...extra },
      payload: 'probe',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('bad-origin');
    expect(await working(inject, sid)).toBe(1);
  });

  it('review case: cross-origin DELETE no longer deletes the session', async () => {
    const { inject, sid } = await setup();
    const del = await inject({
      method: 'DELETE',
      url: `/api/sessions/${sid}`,
      headers: { origin: 'https://cross-origin.example' },
    });
    expect(del.statusCode).toBe(403);
    expect((await inject({ method: 'GET', url: `/api/sessions/${sid}` })).statusCode).toBe(200);
  });

  it.each([
    ['no token', {}],
    ['a wrong token', { 'x-candledrill-token': 'nope' }],
    [
      'a token of the right length but wrong value',
      { 'x-candledrill-token': 'x'.repeat(TEST_TOKEN.length) },
    ],
  ])('refuses writes with %s (non-browser clients included)', async (_label, headers) => {
    const { inject, sid, orderId } = await setup();
    for (const req of [
      { method: 'POST' as const, url: `/api/sessions/${sid}/flatten` },
      { method: 'POST' as const, url: `/api/sessions/${sid}/step`, payload: { count: 1 } },
      { method: 'DELETE' as const, url: `/api/sessions/${sid}/orders/${orderId}` },
      {
        method: 'PATCH' as const,
        url: `/api/sessions/${sid}/orders/${orderId}`,
        payload: { price: 1 },
      },
      { method: 'DELETE' as const, url: `/api/sessions/${sid}` },
    ]) {
      const res = await inject({ ...req, headers });
      expect(res.statusCode, `${req.method} ${req.url}`).toBe(403);
      expect(res.json().code).toBe('bad-token');
    }
    expect(await working(inject, sid)).toBe(1);
  });

  it('accepts same-origin writes with the token (what the bundled UI sends)', async () => {
    const { inject, sid } = await setup();
    const res = await inject({
      method: 'POST',
      url: `/api/sessions/${sid}/flatten`,
      headers: {
        origin: SELF,
        'sec-fetch-site': 'same-origin',
        'x-candledrill-token': TEST_TOKEN,
        'content-type': 'application/json',
      },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(await working(inject, sid)).toBe(0);
  });

  it('reads stay open to same-origin pages and tools; no CORS headers are sent', async () => {
    const { inject } = await setup();
    const list = await inject({ method: 'GET', url: '/api/sessions' });
    expect(list.statusCode).toBe(200);
    expect(list.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('serves the token only to its own origin', async () => {
    const { inject } = await setup();
    const ok = await inject({ method: 'GET', url: '/api/token', headers: { origin: SELF } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ token: TEST_TOKEN, header: 'x-candledrill-token' });
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.headers['access-control-allow-origin']).toBeUndefined();
    const evil = await inject({
      method: 'GET',
      url: '/api/token',
      headers: { origin: 'https://cross-origin.example' },
    });
    expect(evil.statusCode).toBe(403);
    const site = await inject({
      method: 'GET',
      url: '/api/token',
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(site.statusCode).toBe(403);
  });

  it('generates a different random token for every launch by default', async () => {
    const tokens: string[] = [];
    for (let i = 0; i < 2; i++) {
      const d = openDatabase(':memory:');
      const a = buildApp({ db: d });
      const res = await a.inject({ method: 'GET', url: '/api/token', headers: { host: HOST } });
      tokens.push(res.json().token);
      await a.close();
      d.close();
    }
    expect(tokens[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokens[0]).not.toBe(tokens[1]);
  });
});
