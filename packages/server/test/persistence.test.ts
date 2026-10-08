// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { SETTINGS, TEST_TOKEN, withToken } from './helpers.js';

const dir = mkdtempSync(join(tmpdir(), 'candledrill-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('session persistence', () => {
  it('resumes exactly where the user stopped after a restart', async () => {
    const file = join(dir, 'test.db');
    let db = openDatabase(file);
    let app = withToken(buildApp({ db, apiToken: TEST_TOKEN }));
    const ds = (
      await app.inject({
        method: 'POST',
        url: '/api/datasets/synthetic',
        payload: { seed: 9, startDate: '2026-10-05', days: 2 },
      })
    ).json().dataset;
    const s = (
      await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: {
          datasetId: ds.id,
          name: 'resume',
          startTime: ds.firstTime + 7200,
          settings: SETTINGS,
        },
      })
    ).json();
    const id = s.session.id;
    const last = s.state.trading.lastClose;
    await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/orders`,
      payload: { side: 'buy', type: 'market', qty: 1, stopLoss: last - 25, takeProfit: last + 25 },
    });
    await app.inject({ method: 'POST', url: `/api/sessions/${id}/step`, payload: { count: 7 } });
    const before = (await app.inject({ method: 'GET', url: `/api/sessions/${id}` })).json();
    await app.close();
    db.close();

    db = openDatabase(file);
    app = withToken(buildApp({ db, apiToken: TEST_TOKEN }));
    const after = (await app.inject({ method: 'GET', url: `/api/sessions/${id}` })).json();
    expect(after.state).toEqual(before.state);
    expect(after.cursorTime).toBe(before.cursorTime);
    expect(after.bars).toEqual(before.bars);
    // ...and it keeps running from there.
    const next = (
      await app.inject({ method: 'POST', url: `/api/sessions/${id}/step`, payload: {} })
    ).json();
    expect(next.state.cursor).toBe(before.state.cursor + 1);
    await app.close();
    db.close();
  });
});
