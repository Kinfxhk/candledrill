// SPDX-License-Identifier: AGPL-3.0-or-later
// The browser backend (GitHub Pages build) must give the same results as the local server for
// the same calls: same fills, same trades, same rule outcome. This replays one scripted practice
// session against both and compares the engine state after every call.
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../server/src/app.js';
import { openDatabase, type Db } from '../../server/src/db.js';
import { LocalBackend } from '../src/local-backend.js';

const TOKEN = 'parity-token-0123456789abcdef';
const NOW = () => new Date('2026-10-23T04:00:00Z');
const SETTINGS = {
  tickSize: 0.25,
  pointValue: 50,
  commissionPerContract: 2,
  slippageTicks: 1,
  startingBalance: 50_000,
  dailyLossLimit: 1_000,
  trailingDrawdown: 2_000,
  trailingDrawdownMode: 'eod' as const,
  profitTarget: 3_000,
  utcOffsetMinutes: 0,
  dayStartMinutes: 0,
  anchorMinutes: 480,
};

let app: FastifyInstance | undefined;
let db: Db | undefined;
const backends: LocalBackend[] = [];
afterEach(async () => {
  await app?.close();
  db?.close();
  app = undefined;
  db = undefined;
  for (const lb of backends.splice(0)) await lb.close();
  // Fresh IndexedDB per test.
  await new Promise<void>((resolve) => {
    const r = indexedDB.deleteDatabase('candledrill');
    r.onsuccess = r.onerror = r.onblocked = () => resolve();
  });
});

type Call = [method: string, url: string, body?: unknown];

async function server(): Promise<(c: Call) => Promise<{ status: number; body: unknown }>> {
  db = openDatabase(':memory:');
  app = buildApp({ db, apiToken: TOKEN, now: NOW, databasePath: ':memory:' });
  return async ([method, url, body]) => {
    const res = await app!.inject({
      method: method as 'GET',
      url,
      headers: { 'x-candledrill-token': TOKEN },
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    return { status: res.statusCode, body: res.body ? res.json() : undefined };
  };
}
function newBackend(): LocalBackend {
  const lb = new LocalBackend('test', NOW);
  backends.push(lb);
  return lb;
}
function browser(): (c: Call) => Promise<{ status: number; body: unknown }> {
  const lb = newBackend();
  return async ([method, url, body]) => {
    const r = await lb.handle(method, url, body);
    return {
      status: r.status,
      body: r.body === undefined ? undefined : JSON.parse(JSON.stringify(r.body)),
    };
  };
}

/** Fields that legitimately differ between the two stores. */
function comparable(body: unknown): unknown {
  return JSON.parse(
    JSON.stringify(body, (k, v) =>
      k === 'createdAt' || k === 'updatedAt' || k === 'generator' ? undefined : v,
    ),
  );
}

describe('browser backend parity with the local server', () => {
  it('replays the same practice session to the same state', async () => {
    const s = await server();
    const b = browser();
    const both = async (c: Call) => {
      const [x, y] = await Promise.all([s(c), b(c)]);
      expect(y.status, `${c[0]} ${c[1]}`).toBe(x.status);
      // Error wording differs (Fastify schema messages); status codes must still match.
      if (x.status < 400) expect(comparable(y.body), `${c[0]} ${c[1]}`).toEqual(comparable(x.body));
      return x.body as Record<string, unknown>;
    };

    const ds = (
      await both(['POST', '/api/datasets/synthetic', { seed: 7, startDate: '2026-01-05', days: 3 }])
    ).dataset as { id: number; firstTime: number };
    await both(['GET', '/api/datasets']);
    const view = await both([
      'POST',
      '/api/sessions',
      { datasetId: ds.id, name: 'parity', startTime: ds.firstTime + 3600, settings: SETTINGS },
    ]);
    const id = (view.session as { id: number }).id;
    await both(['POST', `/api/sessions/${id}/step`, { count: 20 }]);
    await both([
      'POST',
      `/api/sessions/${id}/orders`,
      { side: 'buy', type: 'market', qty: 2, stopLoss: null, takeProfit: null },
    ]);
    await both(['POST', `/api/sessions/${id}/step`, { count: 15 }]);
    const v = await both(['GET', `/api/sessions/${id}`]);
    const close = (v.state as { trading: { lastClose: number } }).trading.lastClose;
    await both([
      'POST',
      `/api/sessions/${id}/orders`,
      { side: 'sell', type: 'limit', qty: 1, price: close + 2 },
    ]);
    await both([
      'POST',
      `/api/sessions/${id}/orders`,
      { side: 'sell', type: 'stop', qty: 1, price: close - 3 },
    ]);
    await both(['POST', `/api/sessions/${id}/step`, { count: 120 }]);
    await both([
      'POST',
      `/api/sessions/${id}/orders`,
      { side: 'sell', type: 'market', qty: 1, stopLoss: close + 8, takeProfit: close - 8 },
    ]);
    await both(['POST', `/api/sessions/${id}/step`, { count: 400 }]);
    await both(['POST', `/api/sessions/${id}/flatten`, {}]);
    await both(['POST', `/api/sessions/${id}/jump`, { time: ds.firstTime + 86_400 * 2 }]);
    await both(['GET', `/api/sessions/${id}/journal`]);
    await both([
      'PUT',
      `/api/sessions/${id}/drawings`,
      { drawings: [{ kind: 'hline', id: 'h1', price: close }] },
    ]);
    await both([
      'PUT',
      `/api/sessions/${id}/drawings`,
      {
        drawings: [
          {
            kind: 'fib',
            id: 'f1',
            t1: ds.firstTime,
            p1: close + 5,
            t2: ds.firstTime + 600,
            p2: close - 5,
          },
          {
            kind: 'channel',
            id: 'c1',
            t1: ds.firstTime,
            p1: close,
            t2: ds.firstTime + 600,
            p2: close + 2,
            w: 3,
          },
        ],
      },
    ]);
    // A channel without its width is rejected by both.
    await both([
      'PUT',
      `/api/sessions/${id}/drawings`,
      {
        drawings: [
          {
            kind: 'channel',
            id: 'c2',
            t1: ds.firstTime,
            p1: close,
            t2: ds.firstTime + 600,
            p2: close,
          },
        ],
      },
    ]);
    await both(['GET', '/api/sessions']);
    // Errors match too.
    await both([
      'POST',
      `/api/sessions/${id}/orders`,
      { side: 'buy', type: 'limit', qty: 1, price: 0.0001 },
    ]);
    await both(['GET', '/api/sessions/999']);
  });

  it('rewinds to an earlier state and re-steps to the same result', async () => {
    const b = browser();
    const ds = (
      (await b(['POST', '/api/datasets/synthetic', { seed: 3, startDate: '2026-01-05', days: 2 }]))
        .body as {
        dataset: { id: number; firstTime: number };
      }
    ).dataset;
    const v = (
      await b([
        'POST',
        '/api/sessions',
        { datasetId: ds.id, name: 'r', startTime: ds.firstTime + 600, settings: SETTINGS },
      ])
    ).body as {
      session: { id: number };
    };
    const id = v.session.id;
    await b(['POST', `/api/sessions/${id}/orders`, { side: 'buy', type: 'market', qty: 1 }]);
    const snap = (
      (await b(['POST', `/api/sessions/${id}/step`, { count: 5 }])).body as { state: unknown }
    ).state;
    const after = (
      (await b(['POST', `/api/sessions/${id}/step`, { count: 50 }])).body as { state: unknown }
    ).state;
    const back = await b(['PUT', `/api/sessions/${id}/state`, { state: snap }]);
    expect(back.status).toBe(200);
    expect((back.body as { state: unknown }).state).toEqual(snap);
    const again = (
      (await b(['POST', `/api/sessions/${id}/step`, { count: 50 }])).body as { state: unknown }
    ).state;
    expect(again).toEqual(after);
    // A forged state with an invented fill is refused.
    const forged = JSON.parse(JSON.stringify(snap));
    forged.trading.realizedPnl += 1_000_000;
    forged.trading.fills.push({ ...forged.trading.fills[0], id: 999, price: 1 });
    expect((await b(['PUT', `/api/sessions/${id}/state`, { state: forged }])).status).toBe(400);
  });

  it('backs up and restores everything as one JSON file', async () => {
    const b = browser();
    const lb = newBackend();
    const ds = (
      (
        await lb.handle('POST', '/api/datasets/synthetic', {
          seed: 5,
          startDate: '2026-01-05',
          days: 1,
        })
      ).body as {
        dataset: { id: number; firstTime: number };
      }
    ).dataset;
    await lb.handle('POST', '/api/sessions', {
      datasetId: ds.id,
      name: 'keep',
      startTime: ds.firstTime + 600,
      settings: SETTINGS,
    });
    const backup = await lb.handle('GET', '/api/backup', undefined);
    expect(backup.download?.filename).toMatch(/^candledrill-backup-.*\.json$/);
    await lb.handle('DELETE', `/api/datasets/${ds.id}`, undefined);
    expect(
      ((await b(['GET', '/api/sessions'])).body as { sessions: unknown[] }).sessions,
    ).toHaveLength(0);
    const r = await lb.handle(
      'POST',
      '/api/restore',
      new TextEncoder().encode(backup.download!.text).buffer,
    );
    expect(r.body).toEqual({ datasets: 1, sessions: 1, previousCopy: null });
    const list = (await b(['GET', '/api/sessions'])).body as { sessions: { name: string }[] };
    expect(list.sessions.map((x) => x.name)).toEqual(['keep']);
  });

  it('keeps blind sessions hidden: no dataset bars, no rewind, no session file', async () => {
    const b = browser();
    const ds = (
      (await b(['POST', '/api/datasets/synthetic', { seed: 9, startDate: '2026-01-05', days: 5 }]))
        .body as {
        dataset: { id: number };
      }
    ).dataset;
    const v = (
      await b([
        'POST',
        '/api/sessions',
        { datasetId: ds.id, name: 'blind', blind: true, settings: SETTINGS },
      ])
    ).body as {
      session: { id: number; settings: { symbol: string; blind: unknown } };
      state: unknown;
    };
    expect(v.session.settings.symbol).toBe('BLIND');
    expect(v.session.settings.blind).toEqual({ revealed: false });
    expect((await b(['GET', `/api/datasets/${ds.id}/bars?limit=10`])).status).toBe(423);
    expect(
      (await b(['PUT', `/api/sessions/${v.session.id}/state`, { state: v.state }])).status,
    ).toBe(423);
    expect((await b(['GET', `/api/sessions/${v.session.id}/export/session.json`])).status).toBe(
      423,
    );
    await b(['POST', `/api/sessions/${v.session.id}/reveal`, {}]);
    expect((await b(['GET', `/api/datasets/${ds.id}/bars?limit=10`])).status).toBe(200);
  });
});
