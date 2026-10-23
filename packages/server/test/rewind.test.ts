// SPDX-License-Identifier: AGPL-3.0-or-later
// Rewind / checkpoints: PUT /api/sessions/:id/state restores an earlier state of the same session.
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { openDatabase, type Db } from '../src/db.js';
import { SETTINGS, TEST_TOKEN, withToken } from './helpers.js';

let app: FastifyInstance | undefined;
let db: Db | undefined;
afterEach(async () => {
  await app?.close();
  db?.close();
});

async function setup() {
  db = openDatabase(':memory:');
  app = withToken(
    buildApp({ db, apiToken: TEST_TOKEN, now: () => new Date('2026-10-23T04:00:00Z') }),
  );
  const ds = (
    await app.inject({
      method: 'POST',
      url: '/api/datasets/synthetic',
      payload: { seed: 4, startDate: '2026-10-05', days: 2 },
    })
  ).json().dataset as { id: number; firstTime: number };
  return { a: app, ds };
}

describe('state restore (rewind)', () => {
  it('restores an earlier state, then stepping again reproduces the same result', async () => {
    const { a, ds } = await setup();
    const s = (
      await a.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: {
          datasetId: ds.id,
          name: 'rw',
          startTime: ds.firstTime + 600,
          settings: SETTINGS,
        },
      })
    ).json();
    const id = s.session.id as number;
    await a.inject({
      method: 'POST',
      url: `/api/sessions/${id}/orders`,
      payload: { side: 'buy', type: 'market', qty: 1 },
    });
    const snap = (
      await a.inject({ method: 'POST', url: `/api/sessions/${id}/step`, payload: { count: 3 } })
    ).json().state;
    const later = (
      await a.inject({ method: 'POST', url: `/api/sessions/${id}/step`, payload: { count: 40 } })
    ).json().state;
    const back = await a.inject({
      method: 'PUT',
      url: `/api/sessions/${id}/state`,
      payload: { state: snap },
    });
    expect(back.statusCode).toBe(200);
    expect(back.json().state).toEqual(snap);
    expect(back.json().bars.at(-1).time).toBe(back.json().cursorTime);
    const again = (
      await a.inject({ method: 'POST', url: `/api/sessions/${id}/step`, payload: { count: 40 } })
    ).json().state;
    expect(again).toEqual(later);
  });

  it('refuses a state with invented fills and refuses rewind in a hidden blind session', async () => {
    const { a, ds } = await setup();
    const s = (
      await a.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { datasetId: ds.id, name: 'f', startTime: ds.firstTime + 600, settings: SETTINGS },
      })
    ).json();
    await a.inject({
      method: 'POST',
      url: `/api/sessions/${s.session.id}/orders`,
      payload: { side: 'buy', type: 'market', qty: 1 },
    });
    const st = (
      await a.inject({
        method: 'POST',
        url: `/api/sessions/${s.session.id}/step`,
        payload: { count: 2 },
      })
    ).json().state;
    const forged = structuredClone(st);
    forged.trading.fills.push({ ...forged.trading.fills[0], id: 999, price: 1 });
    expect(
      (
        await a.inject({
          method: 'PUT',
          url: `/api/sessions/${s.session.id}/state`,
          payload: { state: forged },
        })
      ).statusCode,
    ).toBe(400);

    const blind = (
      await a.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { datasetId: ds.id, name: 'b', blind: true, settings: SETTINGS },
      })
    ).json();
    const r = await a.inject({
      method: 'PUT',
      url: `/api/sessions/${blind.session.id}/state`,
      payload: { state: blind.state },
    });
    expect(r.statusCode).toBe(423);
  });
});
