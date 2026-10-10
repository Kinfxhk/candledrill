// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { openDatabase, type Db } from '../src/db.js';
import { SETTINGS, TEST_TOKEN, withToken } from './helpers.js';

let app: FastifyInstance | undefined;
let db: Db | undefined;

async function setup(): Promise<{
  a: FastifyInstance;
  ds: { id: number; firstTime: number; lastTime: number };
}> {
  db = openDatabase(':memory:');
  app = withToken(
    buildApp({ db, apiToken: TEST_TOKEN, now: () => new Date('2026-10-07T12:00:00Z') }),
  );
  const res = await app.inject({
    method: 'POST',
    url: '/api/datasets/synthetic',
    payload: { seed: 3, startDate: '2026-10-05', days: 2 },
  });
  return { a: app, ds: res.json().dataset };
}

afterEach(async () => {
  await app?.close();
  db?.close();
});

describe('session API', () => {
  it('enforces optional daily cycle discipline after queued fills and preserves it across reopen/import/restore', async () => {
    const { a, ds } = await setup();
    const created = await a.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        datasetId: ds.id,
        name: 'Discipline',
        startTime: ds.firstTime + 3600,
        settings: { ...SETTINGS, maxDailyTradeCycles: 1, maxConsecutiveLosses: null },
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().session.id;
    const buy = () =>
      a.inject({
        method: 'POST',
        url: `/api/sessions/${id}/orders`,
        payload: { side: 'buy', type: 'market', qty: 1 },
      });
    expect((await buy()).statusCode).toBe(200);
    expect((await buy()).statusCode).toBe(200);
    const stepped = await a.inject({
      method: 'POST',
      url: `/api/sessions/${id}/step`,
      payload: { count: 1 },
    });
    expect(stepped.json().state.trading.fills).toHaveLength(1);
    expect(stepped.json().state.trading.orders[1].status).toBe('cancelled');
    expect((await buy()).statusCode).toBe(400);
    expect(
      (await a.inject({ method: 'GET', url: `/api/sessions/${id}` })).json().session.settings
        .maxDailyTradeCycles,
    ).toBe(1);
    const exported = (
      await a.inject({ method: 'GET', url: `/api/sessions/${id}/export/session.json` })
    ).body;
    const imported = await a.inject({
      method: 'POST',
      url: '/api/sessions/import',
      payload: { file: exported },
    });
    expect(imported.statusCode).toBe(201);
    expect(
      (
        await a.inject({
          method: 'POST',
          url: `/api/sessions/${imported.json().session.id}/orders`,
          payload: { side: 'buy', type: 'market', qty: 1 },
        })
      ).statusCode,
    ).toBe(400);
    const backup = (await a.inject({ method: 'GET', url: '/api/backup' })).rawPayload;
    expect(
      (
        await a.inject({
          method: 'POST',
          url: '/api/restore',
          payload: backup,
          headers: { 'content-type': 'application/vnd.sqlite3' },
        })
      ).statusCode,
    ).toBe(200);
    expect((await buy()).statusCode).toBe(400);
    expect(
      (await a.inject({ method: 'POST', url: `/api/sessions/${id}/flatten` })).statusCode,
    ).toBe(200);
    const flat = await a.inject({
      method: 'POST',
      url: `/api/sessions/${id}/step`,
      payload: { count: 1 },
    });
    expect(flat.json().state.trading.position).toBeNull();
  });

  it('enforces a closed-loss pause through the API and resumes new exposure on the next trading day', async () => {
    const { a, ds } = await setup();
    const created = await a.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        datasetId: ds.id,
        name: 'Loss discipline',
        startTime: ds.firstTime + 3600,
        settings: {
          ...SETTINGS,
          pointValue: 1,
          commissionPerContract: 1000,
          maxConsecutiveLosses: 1,
        },
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().session.id;
    const buy = () =>
      a.inject({
        method: 'POST',
        url: `/api/sessions/${id}/orders`,
        payload: { side: 'buy', type: 'market', qty: 1 },
      });
    expect((await buy()).statusCode).toBe(200);
    await a.inject({ method: 'POST', url: `/api/sessions/${id}/step`, payload: { count: 1 } });
    await a.inject({ method: 'POST', url: `/api/sessions/${id}/flatten` });
    const closed = await a.inject({
      method: 'POST',
      url: `/api/sessions/${id}/step`,
      payload: { count: 1 },
    });
    expect(closed.json().state.trading.trades[0].netPnl).toBeLessThan(0);
    const blocked = await buy();
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().error).toContain('consecutive-loss limit');
    const resumed = await a.inject({
      method: 'POST',
      url: `/api/sessions/${id}/jump`,
      payload: { time: created.json().cursorTime + 86400 },
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().state.status).toBe('active');
    expect((await buy()).statusCode).toBe(200);
  });

  it('rejects fractional/zero optional discipline settings and ignores no unknown settings', async () => {
    const { a, ds } = await setup();
    for (const extra of [
      { maxDailyTradeCycles: 0 },
      { maxConsecutiveLosses: 1.5 },
      { unexpectedDiscipline: 1 },
    ]) {
      const response = await a.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: {
          datasetId: ds.id,
          name: 'Bad',
          startTime: ds.firstTime + 3600,
          settings: { ...SETTINGS, ...extra },
        },
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it('creates, steps, jumps and never sends bars past the cursor', async () => {
    const { a, ds } = await setup();
    const start = ds.firstTime + 60 * 60;
    const created = await a.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { datasetId: ds.id, name: 'Drill 1', startTime: start, settings: SETTINGS },
    });
    expect(created.statusCode).toBe(201);
    const view = created.json();
    expect(view.cursorTime).toBe(start - 60);
    expect(view.session.settings.symbol).toBe('SYNTH-DEMO');
    const id = view.session.id;

    const opened = (await a.inject({ method: 'GET', url: `/api/sessions/${id}` })).json();
    expect(opened.bars).toHaveLength(60);
    expect(opened.bars.every((b: { time: number }) => b.time <= opened.cursorTime)).toBe(true);

    const stepped = (
      await a.inject({ method: 'POST', url: `/api/sessions/${id}/step`, payload: { count: 5 } })
    ).json();
    expect(stepped.revealed).toHaveLength(5);
    expect(stepped.cursorTime).toBe(start + 4 * 60);
    expect(stepped.revealed.at(-1).time).toBe(stepped.cursorTime);

    const jumped = (
      await a.inject({
        method: 'POST',
        url: `/api/sessions/${id}/jump`,
        payload: { time: start + 3600 },
      })
    ).json();
    expect(jumped.cursorTime).toBe(start + 3600);

    // State is persisted: reopening resumes at the same cursor.
    const again = (await a.inject({ method: 'GET', url: `/api/sessions/${id}?history=10` })).json();
    expect(again.cursorTime).toBe(start + 3600);
    expect(again.bars).toHaveLength(10);
    expect(again.bars.at(-1).time).toBe(start + 3600);

    const list = (await a.inject({ method: 'GET', url: '/api/sessions' })).json();
    expect(list.sessions).toMatchObject([{ id, name: 'Drill 1', status: 'active' }]);
  });

  it('validates input and cascades dataset deletion', async () => {
    const { a, ds } = await setup();
    const bad = await a.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        datasetId: ds.id,
        name: 'x',
        startTime: 0,
        settings: { ...SETTINGS, tickSize: 0 },
      },
    });
    expect(bad.statusCode).toBe(400);
    const missing = await a.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { datasetId: 999, name: 'x', startTime: 0, settings: SETTINGS },
    });
    expect(missing.statusCode).toBe(404);
    const ok = await a.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { datasetId: ds.id, name: 'x', startTime: 0, settings: SETTINGS },
    });
    const id = ok.json().session.id;
    expect(
      (
        await a.inject({
          method: 'POST',
          url: `/api/sessions/${id}/step`,
          payload: { count: 9999 },
        })
      ).statusCode,
    ).toBe(400);
    await a.inject({ method: 'DELETE', url: `/api/datasets/${ds.id}` });
    expect((await a.inject({ method: 'GET', url: `/api/sessions/${id}` })).statusCode).toBe(404);
  });
});

describe('order API', () => {
  it('places, modifies, cancels, fills and flattens', async () => {
    const { a, ds } = await setup();
    const created = (
      await a.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: {
          datasetId: ds.id,
          name: 'o',
          startTime: ds.firstTime + 3600,
          settings: SETTINGS,
        },
      })
    ).json();
    const id = created.session.id;
    const last = created.state.trading.lastClose as number;
    const lim = await a.inject({
      method: 'POST',
      url: `/api/sessions/${id}/orders`,
      payload: { side: 'buy', type: 'limit', qty: 1, price: last - 50 },
    });
    expect(lim.statusCode).toBe(200);
    const orderId = lim.json().state.trading.orders[0].id;
    const mod = await a.inject({
      method: 'PATCH',
      url: `/api/sessions/${id}/orders/${orderId}`,
      payload: { price: last - 40 },
    });
    expect(mod.json().state.trading.orders[0].price).toBe(last - 40);
    const del = await a.inject({ method: 'DELETE', url: `/api/sessions/${id}/orders/${orderId}` });
    expect(del.json().state.trading.orders[0].status).toBe('cancelled');

    const badSl = await a.inject({
      method: 'POST',
      url: `/api/sessions/${id}/orders`,
      payload: { side: 'buy', type: 'market', qty: 1, stopLoss: last + 10 },
    });
    expect(badSl.statusCode).toBe(400);
    expect(badSl.json().error).toMatch(/below/);

    await a.inject({
      method: 'POST',
      url: `/api/sessions/${id}/orders`,
      payload: { side: 'buy', type: 'market', qty: 2, stopLoss: last - 20, takeProfit: last + 20 },
    });
    const stepped = (
      await a.inject({ method: 'POST', url: `/api/sessions/${id}/step`, payload: {} })
    ).json();
    expect(stepped.state.trading.position.qty).toBe(2);
    const flat = (await a.inject({ method: 'POST', url: `/api/sessions/${id}/flatten` })).json();
    expect(
      flat.state.trading.orders.filter((o: { status: string }) => o.status === 'working'),
    ).toHaveLength(1);
    const after = (
      await a.inject({ method: 'POST', url: `/api/sessions/${id}/step`, payload: {} })
    ).json();
    expect(after.state.trading.position).toBeNull();
    expect(after.state.trading.trades).toHaveLength(1);
  });

  it('rejects unknown order fields such as stoploss instead of stripping them', async () => {
    const { a, ds } = await setup();
    const created = (
      await a.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: {
          datasetId: ds.id,
          name: 'typo',
          startTime: ds.firstTime + 3600,
          settings: SETTINGS,
        },
      })
    ).json();
    const id = created.session.id;
    const last = created.state.trading.lastClose as number;
    const typo = await a.inject({
      method: 'POST',
      url: `/api/sessions/${id}/orders`,
      payload: { side: 'buy', type: 'market', qty: 1, stoploss: last - 20 },
    });
    expect(typo.statusCode).toBe(400);
    expect(typo.json()).toMatchObject({ statusCode: 400 });
    const open = (await a.inject({ method: 'GET', url: `/api/sessions/${id}` })).json();
    expect(open.state.trading.position).toBeNull();
    expect(open.state.trading.orders).toEqual([]);
  });

  it('modifies a bracket atomically and logs before/after', async () => {
    const { a, ds } = await setup();
    const created = (
      await a.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: {
          datasetId: ds.id,
          name: 'm',
          startTime: ds.firstTime + 3600,
          settings: SETTINGS,
        },
      })
    ).json();
    const id = created.session.id;
    const last = created.state.trading.lastClose as number;
    const placed = await a.inject({
      method: 'POST',
      url: `/api/sessions/${id}/orders`,
      payload: {
        side: 'buy',
        type: 'limit',
        qty: 1,
        price: last - 50,
        stopLoss: last - 60,
        takeProfit: last - 30,
      },
    });
    const orderId = placed.json().state.trading.orders[0].id;
    const url = `/api/sessions/${id}/orders/${orderId}`;
    const bad = await a.inject({ method: 'PATCH', url, payload: { price: last - 70 } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/stop-loss must be below/);
    const empty = await a.inject({ method: 'PATCH', url, payload: {} });
    expect(empty.statusCode).toBe(400);
    const good = await a.inject({
      method: 'PATCH',
      url,
      payload: { price: last - 70, shiftBracket: true },
    });
    expect(good.statusCode).toBe(200);
    const st = good.json().state;
    expect(st.trading.orders[0]).toMatchObject({
      price: last - 70,
      stopLoss: last - 80,
      takeProfit: last - 50,
    });
    expect(st.trading.modifications).toEqual([
      {
        seq: 1,
        time: good.json().cursorTime,
        orderId,
        role: 'entry',
        before: { price: last - 50, stopLoss: last - 60, takeProfit: last - 30 },
        after: { price: last - 70, stopLoss: last - 80, takeProfit: last - 50 },
      },
    ]);
  });
});

describe('export API', () => {
  it('exports trades CSV, an HTML report and session JSON without price bars', async () => {
    const { a, ds } = await setup();
    const s = (
      await a.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: {
          datasetId: ds.id,
          name: 'Export me',
          startTime: ds.firstTime + 3600,
          settings: SETTINGS,
        },
      })
    ).json();
    const id = s.session.id;
    await a.inject({
      method: 'POST',
      url: `/api/sessions/${id}/orders`,
      payload: { side: 'sell', type: 'market', qty: 1 },
    });
    await a.inject({ method: 'POST', url: `/api/sessions/${id}/step`, payload: { count: 3 } });
    await a.inject({ method: 'POST', url: `/api/sessions/${id}/flatten` });
    await a.inject({ method: 'POST', url: `/api/sessions/${id}/step`, payload: {} });

    const csv = await a.inject({ method: 'GET', url: `/api/sessions/${id}/export/trades.csv` });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toContain(
      'attachment; filename="candledrill-1-trades.csv"',
    );
    expect(csv.body.trim().split('\n')).toHaveLength(2);
    expect(csv.body).toContain(',SYNTH-DEMO,short,1,');

    const html = await a.inject({ method: 'GET', url: `/api/sessions/${id}/export/report.html` });
    expect(html.body).toContain('Export me');
    expect(html.body).toContain('not investment advice');
    expect(html.body).toContain('(synthetic data)');
    expect(html.body).toContain('fill model v3');
    expect(html.body).toContain('net-after-exit-costs');
    expect(html.body).toContain('Check your data licence before sharing');

    const json = (
      await a.inject({ method: 'GET', url: `/api/sessions/${id}/export/session.json` })
    ).json();
    expect(json).toMatchObject({
      format: 'candledrill-session',
      formatVersion: 1,
      name: 'Export me',
      simulationPolicy: {
        fillModelVersion: '3',
        gapPolicy: 'fill-at-open',
        endOfDataPolicy: 'keep-open',
        profitTargetBasis: 'net-after-exit-costs',
      },
    });
    expect(json.simulationPolicy.engineVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(json.stats.trades).toBe(1);
    expect(JSON.stringify(json)).not.toContain('"open":');
  });
});

describe('drawings API', () => {
  it('stores validated drawings with the session', async () => {
    const { a, ds } = await setup();
    const id = (
      await a.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { datasetId: ds.id, name: 'd', startTime: ds.firstTime + 600, settings: SETTINGS },
      })
    ).json().session.id;
    const drawings = [
      { kind: 'hline', id: 'a1', price: 4000.25 },
      { kind: 'tline', id: 'b2', t1: ds.firstTime, p1: 4000, t2: ds.firstTime + 300, p2: 4010 },
    ];
    const put = await a.inject({
      method: 'PUT',
      url: `/api/sessions/${id}/drawings`,
      payload: { drawings },
    });
    expect(put.statusCode).toBe(200);
    expect(
      (await a.inject({ method: 'GET', url: `/api/sessions/${id}` })).json().session.drawings,
    ).toEqual(drawings);
    const bad = await a.inject({
      method: 'PUT',
      url: `/api/sessions/${id}/drawings`,
      payload: { drawings: [{ kind: 'circle', id: 'x', price: 1 }] },
    });
    expect(bad.statusCode).toBe(400);
  });
});
