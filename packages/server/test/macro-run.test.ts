// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { exampleOrbSmaMacro } from '@candledrill/core';
import { buildApp } from '../src/app.js';
import { openDatabase, type Db } from '../src/db.js';
import { SETTINGS, TEST_TOKEN, withToken } from './helpers.js';

let app: FastifyInstance | undefined;
let db: Db | undefined;

async function setup(days = 2): Promise<{
  a: FastifyInstance;
  ds: { id: number; firstTime: number };
}> {
  db = openDatabase(':memory:');
  app = withToken(
    buildApp({ db, apiToken: TEST_TOKEN, now: () => new Date('2026-10-14T00:00:00Z') }),
  );
  const res = await app.inject({
    method: 'POST',
    url: '/api/datasets/synthetic',
    payload: { seed: 7, startDate: '2026-10-05', days },
  });
  return { a: app, ds: res.json().dataset };
}

afterEach(async () => {
  await app?.close();
  db?.close();
});

describe('macro-run', () => {
  it('returns stats without moving the practice cursor or sending bars', async () => {
    const { a, ds } = await setup();
    const created = await a.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        datasetId: ds.id,
        name: 'Macro',
        startTime: ds.firstTime + 3600,
        settings: SETTINGS,
      },
    });
    const id = created.json().session.id as number;
    const before = created.json().cursorTime as number;
    const run = await a.inject({
      method: 'POST',
      url: `/api/sessions/${id}/macro-run`,
      payload: { macro: exampleOrbSmaMacro(), mode: 'n_bars', count: 80, from: 'start' },
    });
    expect(run.statusCode).toBe(200);
    const body = run.json();
    expect(body.simulated).toBe(true);
    expect(body.researchCopy).toBe(true);
    expect(body.notice).toMatch(/not investment advice/i);
    expect(body.stats.trades).toEqual(expect.any(Number));
    expect(body.stats.winRate === null || typeof body.stats.winRate === 'number').toBe(true);
    expect(body.stats.maxDrawdown).toEqual(expect.any(Number));
    expect(body.bars).toBeUndefined();
    expect(body.trades).toBeUndefined();
    const again = await a.inject({ method: 'GET', url: `/api/sessions/${id}` });
    expect(again.json().cursorTime).toBe(before);
  });

  it('rejects an invalid macro and a hidden blind session', async () => {
    const { a, ds } = await setup(3);
    const bad = await a.inject({
      method: 'POST',
      url: '/api/sessions/1/macro-run',
      payload: { macro: { schemaVersion: 1, name: 'x', qty: 1, rules: [] } },
    });
    expect(bad.statusCode).toBe(404);
    const created = await a.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { datasetId: ds.id, name: 'Open', startTime: ds.firstTime, settings: SETTINGS },
    });
    const id = created.json().session.id as number;
    const invalid = await a.inject({
      method: 'POST',
      url: `/api/sessions/${id}/macro-run`,
      payload: { macro: { schemaVersion: 1, name: 'x', qty: 1, rules: [] } },
    });
    expect(invalid.statusCode).toBe(400);

    const blind = await a.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { datasetId: ds.id, name: 'Blind', blind: true, settings: SETTINGS },
    });
    const blindId = blind.json().session.id as number;
    const hidden = await a.inject({
      method: 'POST',
      url: `/api/sessions/${blindId}/macro-run`,
      payload: { macro: exampleOrbSmaMacro(), from: 'start' },
    });
    expect(hidden.statusCode).toBe(423);
  });
});
