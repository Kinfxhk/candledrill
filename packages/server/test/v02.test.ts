// SPDX-License-Identifier: AGPL-3.0-or-later
// v0.2: blind mode, session file import, full backup and restore.
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { generateSyntheticBars, WEEK_SECONDS } from '@candledrill/core';
import { buildApp } from '../src/app.js';
import { openDatabase, type Db } from '../src/db.js';
import { SETTINGS, TEST_TOKEN, withToken } from './helpers.js';

let app: FastifyInstance | undefined;
let db: Db | undefined;
const dirs: string[] = [];

async function setup(path = ':memory:') {
  db = openDatabase(path);
  app = withToken(
    buildApp({
      db,
      apiToken: TEST_TOKEN,
      now: () => new Date('2026-10-08T04:00:00Z'),
      databasePath: path,
    }),
  );
  const res = await app.inject({
    method: 'POST',
    url: '/api/datasets/synthetic',
    payload: { seed: 3, startDate: '2026-10-05', days: 3 },
  });
  return {
    a: app,
    ds: res.json().dataset as { id: number; firstTime: number; lastTime: number; symbol: string },
  };
}

afterEach(async () => {
  await app?.close();
  db?.close();
  app = undefined;
  db = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const realBars = generateSyntheticBars({ seed: 3, startDate: '2026-10-05', days: 3 }).bars;

describe('blind mode', () => {
  it('never sends a real time, price or symbol while hidden, and locks the dataset preview', async () => {
    const { a, ds } = await setup();
    const created = await a.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { datasetId: ds.id, name: 'Blind 1', blind: true, settings: SETTINGS },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().session.id;
    await a.inject({
      method: 'POST',
      url: `/api/sessions/${id}/orders`,
      payload: { side: 'buy', type: 'market', qty: 1 },
    });
    const stepped = await a.inject({
      method: 'POST',
      url: `/api/sessions/${id}/step`,
      payload: { count: 20 },
    });
    const opened = await a.inject({ method: 'GET', url: `/api/sessions/${id}` });
    const list = await a.inject({ method: 'GET', url: '/api/sessions' });
    const csv = await a.inject({ method: 'GET', url: `/api/sessions/${id}/export/trades.csv` });
    const report = await a.inject({ method: 'GET', url: `/api/sessions/${id}/export/report.html` });

    const realTimes = new Set(realBars.map((b) => b.time));
    for (const res of [created, stepped, opened, list]) {
      expect(res.statusCode).toBe(200 + (res === created ? 1 : 0));
      const text = res.body;
      expect(text).not.toContain(ds.symbol);
      expect(text).not.toMatch(/timeShift|priceOffset/);
    }
    for (const res of [csv, report]) {
      expect(res.body).not.toContain(ds.symbol);
      expect(res.body).not.toMatch(/timeShift|priceOffset/);
    }
    const view = opened.json();
    expect(view.session.settings.symbol).toBe('BLIND');
    expect(view.session.settings.blind).toEqual({ revealed: false });
    expect(realTimes.has(view.session.startTime)).toBe(false);
    for (const b of view.bars) expect(realTimes.has(b.time)).toBe(false);
    // Same shape, other level: the disguise is a whole-week and whole-tick shift.
    const i0 = realBars.findIndex((b) => (b.time - view.bars[0].time) % WEEK_SECONDS === 0);
    expect(i0).toBeGreaterThanOrEqual(0);
    const diff = view.bars[0].close - realBars[i0]!.close;
    expect(Math.abs(diff)).toBeGreaterThan(0);
    expect(view.bars[5].close - realBars[i0 + 5]!.close).toBeCloseTo(diff, 9);

    const preview = await a.inject({ method: 'GET', url: `/api/datasets/${ds.id}/bars?limit=10` });
    expect(preview.statusCode).toBe(423);
    expect(preview.json().code).toBe('blind-lock');

    const revealed = await a.inject({ method: 'POST', url: `/api/sessions/${id}/reveal` });
    expect(revealed.statusCode).toBe(200);
    const rb = revealed.json().session.settings.blind;
    expect(rb.revealed).toBe(true);
    expect(rb.symbol).toBe(ds.symbol);
    expect(rb.timeShift % WEEK_SECONDS === 0 && rb.timeShift !== 0).toBe(true);
    expect(realTimes.has(view.bars[0].time - rb.timeShift)).toBe(true);
    expect(
      (await a.inject({ method: 'GET', url: `/api/datasets/${ds.id}/bars?limit=10` })).statusCode,
    ).toBe(200);
  });

  it('each blind session gets its own random start and disguise', async () => {
    const { a, ds } = await setup();
    const starts = new Set<number>();
    for (let i = 0; i < 6; i++) {
      const r = await a.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { datasetId: ds.id, name: `B${i}`, blind: true, settings: SETTINGS },
      });
      starts.add(r.json().session.startTime);
    }
    expect(starts.size).toBeGreaterThan(1);
  });

  it('finishing the data reveals the session and unlocks the preview', async () => {
    const { a, ds } = await setup();
    const id = (
      await a.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { datasetId: ds.id, name: 'B', blind: true, settings: SETTINGS },
      })
    ).json().session.id;
    let v;
    do {
      v = (
        await a.inject({
          method: 'POST',
          url: `/api/sessions/${id}/step`,
          payload: { count: 5000 },
        })
      ).json();
    } while (v.state.status !== 'finished');
    expect(v.session.settings.blind.revealed).toBe(true);
    expect(
      (await a.inject({ method: 'GET', url: `/api/datasets/${ds.id}/bars?limit=5` })).statusCode,
    ).toBe(200);
  });

  it('a normal session still needs a start time; reveal of a normal session is refused', async () => {
    const { a, ds } = await setup();
    const r = await a.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { datasetId: ds.id, name: 'N', settings: SETTINGS },
    });
    expect(r.statusCode).toBe(400);
    const ok = await a.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { datasetId: ds.id, name: 'N', startTime: ds.firstTime + 3600, settings: SETTINGS },
    });
    expect(
      (await a.inject({ method: 'POST', url: `/api/sessions/${ok.json().session.id}/reveal` }))
        .statusCode,
    ).toBe(400);
  });
});

async function exported(a: FastifyInstance, id: number): Promise<string> {
  return (await a.inject({ method: 'GET', url: `/api/sessions/${id}/export/session.json` })).body;
}

describe('session file import', () => {
  async function practised(
    a: FastifyInstance,
    ds: { id: number; firstTime: number },
    blind = false,
  ) {
    const created = await a.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        datasetId: ds.id,
        name: 'Practice',
        ...(blind ? { blind: true } : { startTime: ds.firstTime + 7200 }),
        settings: SETTINGS,
      },
    });
    const id = created.json().session.id as number;
    await a.inject({
      method: 'POST',
      url: `/api/sessions/${id}/orders`,
      payload: { side: 'sell', type: 'market', qty: 2 },
    });
    await a.inject({ method: 'POST', url: `/api/sessions/${id}/step`, payload: { count: 30 } });
    await a.inject({ method: 'POST', url: `/api/sessions/${id}/flatten` });
    await a.inject({ method: 'POST', url: `/api/sessions/${id}/step`, payload: { count: 3 } });
    await a.inject({
      method: 'PUT',
      url: `/api/sessions/${id}/drawings`,
      payload: { drawings: [{ kind: 'hline', id: 'h1', price: 100 }] },
    });
    return id;
  }

  it('round trip: export, import, same state, stats and drawings', async () => {
    const { a, ds } = await setup();
    const id = await practised(a, ds);
    const file = await exported(a, id);
    expect(JSON.parse(file).dataset.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const imp = await a.inject({ method: 'POST', url: '/api/sessions/import', payload: { file } });
    expect(imp.statusCode).toBe(201);
    const orig = (await a.inject({ method: 'GET', url: `/api/sessions/${id}` })).json();
    const copy = (
      await a.inject({ method: 'GET', url: `/api/sessions/${imp.json().session.id}` })
    ).json();
    expect(copy.state).toEqual(orig.state);
    expect(copy.session.drawings).toEqual(orig.session.drawings);
    expect(copy.state.trading.trades.length).toBeGreaterThan(0);
  });

  it('rejects fabricated profit in an otherwise valid no-fill session without inserting it', async () => {
    const { a, ds } = await setup();
    const created = await a.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        datasetId: ds.id,
        name: 'No trades',
        startTime: ds.firstTime + 7200,
        settings: SETTINGS,
      },
    });
    const forged = JSON.parse(await exported(a, created.json().session.id));
    forged.state.trading.realizedPnl = 1_000_000;
    const result = await a.inject({
      method: 'POST',
      url: '/api/sessions/import',
      payload: {
        file: JSON.stringify(forged),
      },
    });
    expect(result.statusCode).toBe(400);
    expect(result.json().issues).toContain('state.trading.realizedPnl does not match the fills');
    expect((await a.inject({ method: 'GET', url: '/api/sessions' })).json().sessions).toHaveLength(
      1,
    );
  });

  it('blind sessions keep their disguise through export and import', async () => {
    const { a, ds } = await setup();
    const id = await practised(a, ds, true);
    const file = await exported(a, id);
    const imp = await a.inject({ method: 'POST', url: '/api/sessions/import', payload: { file } });
    expect(imp.statusCode).toBe(201);
    expect(imp.json().session.settings.blind).toEqual({ revealed: false });
    const orig = (await a.inject({ method: 'GET', url: `/api/sessions/${id}` })).json();
    const copy = (
      await a.inject({ method: 'GET', url: `/api/sessions/${imp.json().session.id}` })
    ).json();
    expect(copy.bars.at(-1)).toEqual(orig.bars.at(-1));
    expect(copy.state).toEqual(orig.state);
  });

  it('refuses files for other data, tampered files and junk', async () => {
    const { a, ds } = await setup();
    const id = await practised(a, ds);
    const file = await exported(a, id);
    const j = JSON.parse(file);
    const send = (f: unknown, extra: Record<string, unknown> = {}) =>
      a.inject({
        method: 'POST',
        url: '/api/sessions/import',
        payload: { file: typeof f === 'string' ? f : JSON.stringify(f), ...extra },
      });

    const other = structuredClone(j);
    other.dataset.fingerprint = 'a'.repeat(64);
    expect((await send(other)).statusCode).toBe(409);

    const tampered = structuredClone(j);
    tampered.state.trading.fills[0].price += 40;
    const t = await send(tampered);
    expect(t.statusCode).toBe(400);
    expect(t.json().issues.join(' ')).toMatch(/outside that bar/);

    const old = structuredClone(j);
    delete old.dataset;
    expect((await send(old)).json().code).toBe('choose-dataset');
    expect((await send(old, { datasetId: ds.id })).statusCode).toBe(201);
    const wrongSymbol = structuredClone(old);
    wrongSymbol.settings.symbol = 'OTHER';
    expect((await send(wrongSymbol, { datasetId: ds.id })).statusCode).toBe(400);

    const ds2 = (
      await a.inject({
        method: 'POST',
        url: '/api/datasets/synthetic',
        payload: { seed: 77, startDate: '2026-11-02', days: 3 },
      })
    ).json().dataset;
    expect((await send(j, { datasetId: ds2.id })).json().code).toBe('dataset-mismatch');
    expect((await send(old, { datasetId: ds2.id })).statusCode).toBe(400);

    const blindForged = structuredClone(j);
    blindForged.blind = { timeShift: 123, priceOffset: 0.25, revealed: false, symbol: ds.symbol };
    expect((await send(blindForged)).statusCode).toBe(400);

    for (const junk of ['nope', '{}', '[]', '{"format":"candledrill-session","formatVersion":1}'])
      expect((await send(junk)).statusCode).toBe(400);
    const sessions = (await a.inject({ method: 'GET', url: '/api/sessions' })).json().sessions;
    expect(sessions).toHaveLength(2); // the original and the one valid older-file import
  });

  it('import needs the API token', async () => {
    const { a, ds } = await setup();
    const file = await exported(a, await practised(a, ds));
    const raw = (a as unknown as { rawInject: FastifyInstance['inject'] }).rawInject;
    expect(
      (await raw({ method: 'POST', url: '/api/sessions/import', payload: { file } })).statusCode,
    ).toBe(403);
  });
});

describe('backup and restore', () => {
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'cd-test-'));
    dirs.push(d);
    return d;
  };
  const restore = (a: FastifyInstance, body: Buffer) =>
    a.inject({
      method: 'POST',
      url: '/api/restore',
      payload: body,
      headers: { 'content-type': 'application/vnd.sqlite3' },
    });

  it('restores everything exactly and keeps the previous database', async () => {
    const dir = tmp();
    const { a, ds } = await setup(join(dir, 'candledrill.db'));
    const s = await a.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        datasetId: ds.id,
        name: 'Keep',
        startTime: ds.firstTime + 3600,
        settings: SETTINGS,
      },
    });
    await a.inject({
      method: 'POST',
      url: `/api/sessions/${s.json().session.id}/step`,
      payload: { count: 50 },
    });
    const backup = await a.inject({ method: 'GET', url: '/api/backup' });
    expect(backup.statusCode).toBe(200);
    expect(backup.headers['content-disposition']).toMatch(/candledrill-backup-20261008-040000\.db/);
    const before = (
      await a.inject({ method: 'GET', url: `/api/sessions/${s.json().session.id}` })
    ).json();

    // Change things after the backup.
    await a.inject({ method: 'DELETE', url: `/api/sessions/${s.json().session.id}` });
    await a.inject({
      method: 'POST',
      url: '/api/datasets/synthetic',
      payload: { seed: 9, startDate: '2026-10-05', days: 1 },
    });

    const r = await restore(a, backup.rawPayload);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ datasets: 1, sessions: 1 });
    expect(existsSync(r.json().previousCopy)).toBe(true);
    expect(readdirSync(dir).some((f) => f.startsWith('candledrill.db.before-restore-'))).toBe(true);
    const after = (
      await a.inject({ method: 'GET', url: `/api/sessions/${s.json().session.id}` })
    ).json();
    expect(after.state).toEqual(before.state);
    expect(after.bars).toEqual(before.bars);
    expect((await a.inject({ method: 'GET', url: '/api/datasets' })).json().datasets).toHaveLength(
      1,
    );
    // New rows continue after the restored ids.
    const next = await a.inject({
      method: 'POST',
      url: '/api/datasets/synthetic',
      payload: { seed: 1, startDate: '2026-10-05', days: 1 },
    });
    expect(next.json().dataset.id).toBe(ds.id + 1);
  });

  it('rejects unusable runtime data before replacing the library or writing a previous copy', async () => {
    const dir = tmp();
    const { a, ds } = await setup(join(dir, 'candledrill.db'));
    const created = await a.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        datasetId: ds.id,
        name: 'Keep',
        startTime: ds.firstTime + 3600,
        settings: SETTINGS,
      },
    });
    const id = created.json().session.id;
    const before = (await a.inject({ method: 'GET', url: `/api/sessions/${id}` })).body;
    const good = (await a.inject({ method: 'GET', url: '/api/backup' })).rawPayload;
    for (const sql of [
      "UPDATE sessions SET settings_json='{}', state_json='{}'",
      "UPDATE sessions SET state_json='{}'",
      "UPDATE sessions SET state_json=json_set(state_json, '$.trading.realizedPnl', 1000000)",
      "UPDATE sessions SET settings_json='[]'",
      'UPDATE datasets SET tick_size=0',
      'UPDATE datasets SET timeframe_seconds=-60',
      "UPDATE sessions SET state_json=json_set(state_json, '$.cursor', 999999)",
      "UPDATE sessions SET drawings_json='{}'",
      `UPDATE sessions SET journal_json='{"999":{"tags":[],"note":"orphan"}}'`,
      'UPDATE bars SET low=high+1',
    ]) {
      const candidate = new Database(good);
      candidate.exec(sql);
      const bytes = candidate.serialize();
      candidate.close();
      expect((await restore(a, bytes)).statusCode, sql).toBe(400);
      expect((await a.inject({ method: 'GET', url: `/api/sessions/${id}` })).body, sql).toBe(
        before,
      );
      expect(
        readdirSync(dir).filter((f) => f.includes('.before-restore-')),
        sql,
      ).toEqual([]);
    }
  });

  it('restores runtime history beyond portable import limits and preserves API-accepted names', async () => {
    const { a, ds } = await setup();
    const created = await a.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { datasetId: ds.id, name: ' ', startTime: ds.firstTime + 3600, settings: SETTINGS },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().session.id;
    const state = created.json().state;
    state.trading.modifications = Array.from({ length: 200_001 }, (_, i) => ({
      seq: i + 1,
      time: ds.firstTime + 3600,
      orderId: 1,
      role: 'entry',
      before: { price: 100, stopLoss: null, takeProfit: null },
      after: { price: 101, stopLoss: null, takeProfit: null },
    }));
    const serialized = JSON.stringify(state);
    expect(serialized.length).toBeGreaterThan(20 * 1024 * 1024);
    db!.prepare('UPDATE sessions SET state_json = ? WHERE id = ?').run(serialized, id);
    const backup = (await a.inject({ method: 'GET', url: '/api/backup' })).rawPayload;
    expect((await restore(a, backup)).statusCode).toBe(200);
    const reopened = await a.inject({ method: 'GET', url: `/api/sessions/${id}` });
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json().session.name).toBe(' ');
    expect(reopened.json().state.trading.modifications).toEqual(state.trading.modifications);
  }, 20_000);

  it('restores schema 3 sessions with legacy optional state fields and upgrades them on open', async () => {
    const { a, ds } = await setup();
    const created = await a.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        datasetId: ds.id,
        name: 'Legacy',
        startTime: ds.firstTime + 3600,
        settings: SETTINGS,
      },
    });
    const id = created.json().session.id;
    const good = (await a.inject({ method: 'GET', url: '/api/backup' })).rawPayload;
    const old = new Database(good);
    old.exec(`ALTER TABLE sessions DROP COLUMN journal_json;
      UPDATE sessions SET state_json=json_remove(state_json,
        '$.equityPeak', '$.maxDrawdown', '$.maxDrawdownPct', '$.dayKey',
        '$.dayStartEquity', '$.trading.modifications');`);
    old.pragma('user_version = 3');
    const bytes = old.serialize();
    old.close();
    expect((await restore(a, bytes)).statusCode).toBe(200);
    const reopened = await a.inject({ method: 'GET', url: `/api/sessions/${id}` });
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json().state.trading.modifications).toEqual([]);
    expect(reopened.json().state.equityPeak).toBe(SETTINGS.startingBalance);
    expect(reopened.json().session.journal).toEqual({});
  });

  it('refuses damaged, foreign, newer and booby-trapped files and changes nothing', async () => {
    const dir = tmp();
    const { a } = await setup();
    const good = (await a.inject({ method: 'GET', url: '/api/backup' })).rawPayload;
    const make = (name: string, f: (d: Database.Database) => void) => {
      const p = join(dir, name);
      const d = new Database(p);
      d.close();
      const src = new Database(good);
      const buf = src.serialize();
      src.close();
      const w = new Database(buf);
      f(w);
      const out = w.serialize();
      w.close();
      return out;
    };
    const cases: [string, Buffer][] = [
      ['garbage', Buffer.from('hello world'.repeat(100))],
      ['truncated', good.subarray(0, 600)],
      [
        'other app',
        (() => {
          const d = new Database(':memory:');
          d.exec('CREATE TABLE notes(x)');
          const b = d.serialize();
          d.close();
          return b;
        })(),
      ],
      [
        'trigger',
        make('t.db', (d) =>
          d.exec('CREATE TRIGGER evil AFTER INSERT ON datasets BEGIN DELETE FROM bars; END;'),
        ),
      ],
      ['view', make('v.db', (d) => d.exec('CREATE VIEW v AS SELECT 1'))],
      ['newer version', make('n.db', (d) => d.pragma('user_version = 99'))],
      [
        'unreadable session',
        make('s.db', (d) =>
          d.exec(
            "INSERT INTO sessions (dataset_id,name,start_time,settings_json,state_json,created_at,updated_at) VALUES (1,'x',1,'{bad','{}','a','a')",
          ),
        ),
      ],
      [
        'broken link',
        make('f.db', (d) => {
          d.pragma('foreign_keys = OFF');
          d.exec(
            "INSERT INTO sessions (dataset_id,name,start_time,settings_json,state_json,created_at,updated_at) VALUES (999,'x',1,'{}','{}','a','a')",
          );
        }),
      ],
    ];
    const before = (await a.inject({ method: 'GET', url: '/api/datasets' })).body;
    for (const [name, buf] of cases) {
      const r = await restore(a, buf);
      expect(r.statusCode, name).toBe(400);
      expect(typeof r.json().error, name).toBe('string');
    }
    expect((await a.inject({ method: 'GET', url: '/api/datasets' })).body).toBe(before);
    expect(
      (await a.inject({ method: 'POST', url: '/api/restore', payload: { x: 1 } })).statusCode,
    ).toBe(415);

    // A file that passes every read-only check but fails half-way through the copy (its
    // bars table lacks the NOT NULL constraints and holds a NULL) must change nothing:
    // the swap is one transaction.
    const halfway = make('h.db', (d) => {
      d.exec(`CREATE TABLE bars2 (dataset_id INTEGER, time INTEGER, open REAL, high REAL,
        low REAL, close REAL, volume REAL, PRIMARY KEY (dataset_id, time)) WITHOUT ROWID;
        INSERT INTO bars2 SELECT * FROM bars; DROP TABLE bars; ALTER TABLE bars2 RENAME TO bars;
        UPDATE bars SET close = NULL WHERE time = (SELECT MAX(time) FROM bars);`);
    });
    const r2 = await restore(a, halfway);
    expect(r2.statusCode).toBe(400);
    expect((await a.inject({ method: 'GET', url: '/api/datasets' })).body).toBe(before);
    const one = (await a.inject({ method: 'GET', url: '/api/datasets' })).json().datasets[0];
    const barsAfter = await a.inject({
      method: 'GET',
      url: `/api/datasets/${one.id}/bars?limit=5`,
    });
    expect(barsAfter.json().bars).toHaveLength(5);
    const raw = (a as unknown as { rawInject: FastifyInstance['inject'] }).rawInject;
    expect(
      (
        await raw({
          method: 'POST',
          url: '/api/restore',
          payload: good,
          headers: { 'content-type': 'application/vnd.sqlite3' },
        })
      ).statusCode,
    ).toBe(403);
  });
});

describe('drawings v0.2', () => {
  it('stores rectangles and R tools, refuses inconsistent ones', async () => {
    const { a, ds } = await setup();
    const id = (
      await a.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: {
          datasetId: ds.id,
          name: 'D',
          startTime: ds.firstTime + 3600,
          settings: SETTINGS,
        },
      })
    ).json().session.id;
    const put = (drawings: unknown[]) =>
      a.inject({ method: 'PUT', url: `/api/sessions/${id}/drawings`, payload: { drawings } });
    const rect = { kind: 'rect', id: 'r1', t1: 100, p1: 10, t2: 200, p2: 12 };
    const long = {
      kind: 'position',
      id: 'p1',
      side: 'long',
      t1: 100,
      t2: 160,
      entry: 100,
      stop: 95,
      target: 110,
    };
    const short = { ...long, id: 'p2', side: 'short', stop: 105, target: 90 };
    expect((await put([rect, long, short])).statusCode).toBe(200);
    expect(
      (await a.inject({ method: 'GET', url: `/api/sessions/${id}` })).json().session.drawings,
    ).toEqual([rect, long, short]);
    for (const bad of [
      [{ ...long, stop: 101 }],
      [{ ...long, target: 99 }],
      [{ ...short, stop: 95 }],
      [{ ...long, t2: 100 }],
      [{ ...long, side: 'up' }],
      [{ ...rect, p1: -1 }],
      [rect, { ...rect }],
      [{ ...long, extra: 1, kind: 'triangle' }],
    ])
      expect((await put(bad)).statusCode, JSON.stringify(bad)).toBe(400);
  });
});

describe('journal, MAE/MFE and grouping', () => {
  it('stores tags and notes per trade, exports them, and validates input', async () => {
    const { a, ds } = await setup();
    const id = (
      await a.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: {
          datasetId: ds.id,
          name: 'J',
          startTime: ds.firstTime + 3600,
          settings: SETTINGS,
        },
      })
    ).json().session.id;
    await a.inject({
      method: 'POST',
      url: `/api/sessions/${id}/orders`,
      payload: { side: 'buy', type: 'market', qty: 1, stopLoss: null },
    });
    await a.inject({ method: 'POST', url: `/api/sessions/${id}/step`, payload: { count: 10 } });
    await a.inject({ method: 'POST', url: `/api/sessions/${id}/flatten` });
    await a.inject({ method: 'POST', url: `/api/sessions/${id}/step`, payload: { count: 2 } });
    const j0 = (await a.inject({ method: 'GET', url: `/api/sessions/${id}/journal` })).json();
    expect(j0.excursions).toHaveLength(1);
    expect(j0.excursions[0].maeTicks).toBeGreaterThanOrEqual(0);
    expect(j0.byHour[0].trades).toBe(1);
    const put = (tradeId: number, body: Record<string, unknown>) =>
      a.inject({ method: 'PUT', url: `/api/sessions/${id}/journal/${tradeId}`, payload: body });
    const ok = await put(1, {
      tags: [' breakout ', 'Breakout', 'late  entry'],
      note: ' chased it ',
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().journal['1']).toEqual({ tags: ['breakout', 'late entry'], note: 'chased it' });
    expect((await put(2, { tags: [], note: 'x' })).statusCode).toBe(404);
    expect(
      (await put(1, { tags: Array.from({ length: 9 }, (_, i) => `t${i}`), note: '' })).statusCode,
    ).toBe(400);
    expect((await put(1, { tags: ['x'.repeat(25)], note: '' })).statusCode).toBe(400);
    expect((await put(1, { tags: ['a\u0007b'], note: '' })).statusCode).toBe(400);
    expect((await put(1, { tags: [], note: 'line\u0000break' })).statusCode).toBe(400);
    const csv = (await a.inject({ method: 'GET', url: `/api/sessions/${id}/export/trades.csv` }))
      .body;
    expect(csv).toContain('breakout; late entry,chased it');
    const file = await exported(a, id);
    expect(JSON.parse(file).journal['1'].note).toBe('chased it');
    const imp = await a.inject({ method: 'POST', url: '/api/sessions/import', payload: { file } });
    expect(imp.statusCode).toBe(201);
    expect(
      (
        await a.inject({ method: 'GET', url: `/api/sessions/${imp.json().session.id}/journal` })
      ).json().journal['1'].tags,
    ).toEqual(['breakout', 'late entry']);
    const forged = JSON.parse(file);
    forged.journal = { '99': { tags: [], note: 'ghost' } };
    expect(
      (
        await a.inject({
          method: 'POST',
          url: '/api/sessions/import',
          payload: { file: JSON.stringify(forged) },
        })
      ).statusCode,
    ).toBe(400);
    expect((await put(1, { tags: [], note: 'two\nlines\tok' })).statusCode).toBe(200);
    // Clearing both removes the entry.
    expect((await put(1, { tags: [], note: '' })).json().journal).toEqual({});
  });

  it('restores a backup made by v0.1 (schema 3) and upgrades it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cd-v3-'));
    dirs.push(dir);
    const old = openDatabase(join(dir, 'old.db'));
    old.exec('ALTER TABLE sessions DROP COLUMN journal_json');
    old.pragma('user_version = 3');
    old.exec(
      `INSERT INTO datasets (name,symbol,source,synthetic,timeframe_seconds,tick_size,bar_count,created_at) VALUES ('d','S','synthetic',1,60,0.25,0,'x')`,
    );
    const bytes = old.serialize();
    old.close();
    const { a } = await setup();
    const r = await a.inject({
      method: 'POST',
      url: '/api/restore',
      payload: bytes,
      headers: { 'content-type': 'application/vnd.sqlite3' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().datasets).toBe(1);
    expect(
      (await a.inject({ method: 'GET', url: '/api/datasets' })).json().datasets[0].symbol,
    ).toBe('S');
  });
});
