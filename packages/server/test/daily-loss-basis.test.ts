// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { openDatabase, type Db } from '../src/db.js';
import { SETTINGS, TEST_TOKEN, withToken } from './helpers.js';

let app: FastifyInstance | undefined;
let db: Db | undefined;

async function setup() {
  db = openDatabase(':memory:');
  app = withToken(
    buildApp({ db, apiToken: TEST_TOKEN, now: () => new Date('2026-10-07T12:00:00Z') }),
  );
  const res = await app.inject({
    method: 'POST',
    url: '/api/datasets/synthetic',
    payload: { seed: 3, startDate: '2026-10-05', days: 2 },
  });
  return {
    a: app,
    ds: res.json().dataset as { id: number; firstTime: number; symbol: string },
  };
}

afterEach(async () => {
  await app?.close();
  db?.close();
  app = undefined;
  db = undefined;
});

describe('dailyLossBasis HTTP settings', () => {
  it('omits the field on old payloads and round-trips intraday through export and import', async () => {
    const { a, ds } = await setup();
    const omitted = await a.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        datasetId: ds.id,
        name: 'Legacy',
        startTime: ds.firstTime + 3600,
        settings: SETTINGS,
      },
    });
    expect(omitted.statusCode).toBe(201);
    expect(omitted.json().session.settings.dailyLossBasis).toBeUndefined();

    const created = await a.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        datasetId: ds.id,
        name: 'Intraday daily',
        startTime: ds.firstTime + 3600,
        settings: { ...SETTINGS, dailyLossBasis: 'intraday' },
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().session.id as number;
    expect(created.json().session.settings.dailyLossBasis).toBe('intraday');
    const loaded = await a.inject({ method: 'GET', url: `/api/sessions/${id}` });
    expect(loaded.json().session.settings.dailyLossBasis).toBe('intraday');

    const file = (await a.inject({ method: 'GET', url: `/api/sessions/${id}/export/session.json` }))
      .body;
    expect(JSON.parse(file).settings.dailyLossBasis).toBe('intraday');

    const imp = await a.inject({
      method: 'POST',
      url: '/api/sessions/import',
      payload: { file },
    });
    expect(imp.statusCode).toBe(201);
    expect(imp.json().session.settings.dailyLossBasis).toBe('intraday');

    const legacy = JSON.parse(file) as { settings: Record<string, unknown> };
    delete legacy.settings.dailyLossBasis;
    const old = await a.inject({
      method: 'POST',
      url: '/api/sessions/import',
      payload: { file: JSON.stringify(legacy) },
    });
    expect(old.statusCode).toBe(201);
    expect(old.json().session.settings.dailyLossBasis).toBeUndefined();
  });

  it('rejects a dailyLossBasis outside close | intraday', async () => {
    const { a, ds } = await setup();
    const bad = await a.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        datasetId: ds.id,
        name: 'Bad basis',
        startTime: ds.firstTime + 3600,
        settings: { ...SETTINGS, dailyLossBasis: 'wick' },
      },
    });
    expect(bad.statusCode).toBe(400);
    const list = await a.inject({ method: 'GET', url: '/api/sessions' });
    expect(list.json().sessions).toEqual([]);
  });
});
