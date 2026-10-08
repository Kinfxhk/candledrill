// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Writes random practice sessions (and blind-mode / backup scenarios) as JSON so that the
// independent Python oracle (check.py) can re-check them without sharing any code.
// Usage: node --import tsx tools/oracle/dump.ts <out.json> [cases=300] [seed=1]
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSession,
  disguiseBars,
  generateSyntheticBars,
  pickBlindParams,
  sessionFlatten,
  sessionModifyOrder,
  sessionPlaceOrder,
  stepSession,
  tradeExcursions,
  workingOrders,
  type Bar,
  type SessionSettings,
  type SessionState,
} from '@candledrill/core';
import type Database from 'better-sqlite3';
import { buildApp } from '../../packages/server/src/app.js';
import { openDatabase } from '../../packages/server/src/db.js';

const out = process.argv[2] ?? 'oracle-cases.json';
const N = Number(process.argv[3] ?? 300);
let seed = Number(process.argv[4] ?? 1) >>> 0 || 1;
const rnd = () => {
  seed ^= seed << 13;
  seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  seed >>>= 0;
  return seed / 2 ** 32;
};
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

function randomSettings(tick: number): SessionSettings {
  return {
    symbol: 'SYNTH-ORACLE',
    tickSize: tick,
    pointValue: pick([1, 5, 20, 50]),
    commissionPerContract: pick([0, 0.5, 2.25]),
    slippageTicks: int(0, 2),
    startingBalance: 50_000,
    dailyLossLimit: pick([null, 400, 1500]),
    trailingDrawdown: pick([null, 2500]),
    profitTarget: pick([null, 3000]),
    utcOffsetMinutes: pick([0, -300, 480]),
    dayStartMinutes: pick([0, 18 * 60]),
  };
}

function play(
  bars: readonly Bar[],
  st: SessionSettings,
  start: number,
  steps: number[][],
): SessionState {
  let s = createSession(bars, st, bars[start]!.time);
  const tick = st.tickSize;
  for (const a of steps) {
    const k = a[0]!;
    try {
      if (k === 0) s = stepSession(bars, st, s, a[1]!).state;
      else if (k === 1) s = sessionFlatten(bars, s);
      else if (k === 2) {
        const w = workingOrders(s.trading).filter((o) => o.price !== null);
        if (w.length) {
          const o = w[a[1]! % w.length]!;
          s = sessionModifyOrder(
            st,
            s,
            o.id,
            { price: o.price! + (a[2]! - 3) * tick, shiftBracket: a[2]! % 2 === 0 },
            bars[s.cursor]!.time,
          );
        }
      } else if (s.status === 'active') {
        const [, sideN, typeN, off, sl, tp, qty] = a as [
          number,
          number,
          number,
          number,
          number,
          number,
          number,
        ];
        const side = sideN ? 'buy' : 'sell';
        const type = (['market', 'limit', 'stop'] as const)[typeN]!;
        const last = bars[s.cursor]!.close;
        const dir = side === 'buy' ? 1 : -1;
        const price =
          type === 'market'
            ? null
            : type === 'limit'
              ? last - dir * off * tick
              : last + dir * off * tick;
        const ref = price ?? last;
        s = sessionPlaceOrder(bars, st, s, {
          side,
          type,
          qty,
          price,
          stopLoss: sl ? ref - dir * sl * tick : null,
          takeProfit: tp ? ref + dir * tp * tick : null,
        });
      }
    } catch {
      /* invalid combinations are skipped, like a user's rejected order */
    }
  }
  return s;
}

function randomSteps(): number[][] {
  return Array.from({ length: int(5, 40) }, () => {
    const r = rnd();
    if (r < 0.45) return [0, int(1, 30)];
    if (r < 0.5) return [1];
    if (r < 0.58) return [2, int(0, 5), int(0, 6)];
    return [
      3,
      int(0, 1),
      int(0, 2),
      int(1, 14),
      int(0, 1) ? int(1, 20) : 0,
      int(0, 1) ? int(1, 30) : 0,
      int(1, 3),
    ];
  });
}

const sessions: unknown[] = [];
for (let i = 0; i < N; i++) {
  const tick = pick([0.25, 0.1, 1, 0.01]);
  const ds = generateSyntheticBars({
    seed: int(1, 1e6),
    startDate: '2026-03-02',
    days: int(1, 3),
    tickSize: tick,
  });
  const bars = ds.bars;
  const st = randomSettings(tick);
  const start = int(5, Math.max(6, bars.length - 50));
  const steps = randomSteps();
  const state = play(bars, st, start, steps);
  // Blind twin of every 5th case: same actions on disguised bars.
  let blind: unknown = null;
  if (i % 5 === 0) {
    const p = pickBlindParams(bars, tick, rnd);
    const d = disguiseBars(bars, p, tick);
    const bs = play(d, st, start, steps);
    blind = { params: p, bars: d, trades: bs.trading.trades, fills: bs.trading.fills };
  }
  sessions.push({
    settings: st,
    bars: bars.slice(0, state.cursor + 2),
    cursor: state.cursor,
    orders: state.trading.orders,
    fills: state.trading.fills,
    trades: state.trading.trades,
    position: state.trading.position,
    openTrade: state.trading.openTrade,
    realizedPnl: state.trading.realizedPnl,
    commissionPaid: state.trading.commissionPaid,
    modifications: state.trading.modifications?.length ?? 0,
    excursions: tradeExcursions(bars, state.trading.trades, st),
    blind,
  });
}

// Server scenarios: blind leakage and backup / restore round trip.
const TOKEN = 'oracle-token-0123456789';
async function serverCases() {
  const dir = mkdtempSync(join(tmpdir(), 'cd-oracle-'));
  const dbPath = join(dir, 'candledrill.db');
  const db = openDatabase(dbPath);
  const app = buildApp({ db, apiToken: TOKEN, databasePath: dbPath });
  const inject = (
    method: string,
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method: method as 'GET',
      url,
      payload: payload as string,
      headers: { 'x-candledrill-token': TOKEN, ...headers },
    });
  const SET = {
    tickSize: 0.25,
    pointValue: 50,
    commissionPerContract: 2,
    slippageTicks: 1,
    startingBalance: 50000,
    dailyLossLimit: null,
    trailingDrawdown: null,
    profitTarget: null,
    utcOffsetMinutes: 0,
    dayStartMinutes: 0,
  };
  const blindRuns: unknown[] = [];
  for (let k = 0; k < 8; k++) {
    const ds = (
      await inject('POST', '/api/datasets/synthetic', {
        seed: 100 + k,
        startDate: '2026-04-06',
        days: 2,
      })
    ).json().dataset;
    const realBars = (await inject('GET', `/api/datasets/${ds.id}/bars?limit=50000`)).json()
      .bars as Bar[];
    const bodies: string[] = [];
    const c = await inject('POST', '/api/sessions', {
      datasetId: ds.id,
      name: `Blind ${k}`,
      blind: true,
      settings: SET,
    });
    bodies.push(c.body);
    const id = c.json().session.id;
    bodies.push(
      (
        await inject('POST', `/api/sessions/${id}/orders`, {
          side: k % 2 ? 'buy' : 'sell',
          type: 'market',
          qty: 1,
        })
      ).body,
    );
    for (let j = 0; j < 4; j++)
      bodies.push((await inject('POST', `/api/sessions/${id}/step`, { count: 25 })).body);
    bodies.push((await inject('GET', `/api/sessions/${id}`)).body);
    bodies.push((await inject('GET', '/api/sessions')).body);
    bodies.push((await inject('GET', `/api/sessions/${id}/journal`)).body);
    bodies.push((await inject('GET', `/api/sessions/${id}/export/trades.csv`)).body);
    bodies.push((await inject('GET', `/api/sessions/${id}/export/report.html`)).body);
    const locked = (await inject('GET', `/api/datasets/${ds.id}/bars?limit=10`)).statusCode;
    const revealed = (await inject('POST', `/api/sessions/${id}/reveal`)).json().session.settings
      .blind;
    blindRuns.push({
      symbol: ds.symbol,
      realTimes: realBars.map((b) => b.time),
      bodies,
      locked,
      revealed,
      firstShownTime: JSON.parse(bodies.at(-5)!).bars[0].time,
    });
  }
  const dump = (d: Database.Database) =>
    Object.fromEntries(
      ['datasets', 'bars', 'sessions'].map((t) => [
        t,
        d.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).raw().all(),
      ]),
    );
  const original = dump(db);
  const backup = (await inject('GET', '/api/backup')).rawPayload;
  const backupPath = join(dir, 'backup.db');
  writeFileSync(backupPath, backup);
  // Restore into a fresh library and dump again.
  const db2 = openDatabase(':memory:');
  const app2 = buildApp({ db: db2, apiToken: TOKEN });
  const r = await app2.inject({
    method: 'POST',
    url: '/api/restore',
    payload: backup,
    headers: { 'x-candledrill-token': TOKEN, 'content-type': 'application/vnd.sqlite3' },
  });
  const restored = dump(db2);
  await app.close();
  await app2.close();
  db.close();
  db2.close();
  const backupB64 = backup.toString('base64');
  rmSync(dir, { recursive: true, force: true });
  return { blindRuns, backup: { original, restored, restoreStatus: r.statusCode, backupB64 } };
}

const server = await serverCases();
writeFileSync(out, JSON.stringify({ sessions, server }));
console.info(
  `wrote ${out}: ${sessions.length} sessions, ${server.blindRuns.length} blind runs, backup round trip`,
);
