// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { openDatabase, type Db } from '../src/db.js';

let app: FastifyInstance | undefined;
let db: Db | undefined;

export const SETTINGS = {
  tickSize: 0.25,
  pointValue: 50,
  commissionPerContract: 2,
  slippageTicks: 1,
  startingBalance: 50_000,
  dailyLossLimit: null,
  trailingDrawdown: null,
  profitTarget: null,
  utcOffsetMinutes: 0,
  dayStartMinutes: 0,
};

async function setup(): Promise<{
  a: FastifyInstance;
  ds: { id: number; firstTime: number; lastTime: number };
}> {
  db = openDatabase(':memory:');
  app = buildApp({ db, now: () => new Date('2026-10-07T12:00:00Z') });
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
