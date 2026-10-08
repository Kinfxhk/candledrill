// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  BLIND_MIN_WEEKS,
  WEEK_SECONDS,
  blindIssues,
  checkSessionState,
  createSession,
  dayKeyOf,
  disguiseBars,
  generateSyntheticBars,
  parseSessionFile,
  pickBlindParams,
  pickBlindStartIndex,
  revealPrice,
  revealTime,
  sessionFlatten,
  sessionPlaceOrder,
  sessionStats,
  stepSession,
  type Bar,
  type SessionSettings,
  type SessionState,
} from '../src/index.js';

const SETTINGS: SessionSettings = {
  symbol: 'SYNTH-DEMO',
  tickSize: 0.25,
  pointValue: 50,
  commissionPerContract: 2,
  slippageTicks: 1,
  startingBalance: 50_000,
  dailyLossLimit: 1500,
  trailingDrawdown: 2500,
  profitTarget: null,
  utcOffsetMinutes: -300,
  dayStartMinutes: 18 * 60,
};
const bars = generateSyntheticBars({ seed: 11, startDate: '2026-10-05', days: 4 }).bars;

type Act =
  | { kind: 'step'; n: number }
  | {
      kind: 'order';
      side: 'buy' | 'sell';
      type: 'market' | 'limit' | 'stop';
      off: number;
      sl: number;
      tp: number;
    }
  | { kind: 'flatten' };
const act: fc.Arbitrary<Act> = fc.oneof(
  fc.record({ kind: fc.constant('step' as const), n: fc.integer({ min: 1, max: 40 }) }),
  fc.record({
    kind: fc.constant('order' as const),
    side: fc.constantFrom('buy' as const, 'sell' as const),
    type: fc.constantFrom('market' as const, 'limit' as const, 'stop' as const),
    off: fc.integer({ min: 1, max: 12 }),
    sl: fc.integer({ min: 0, max: 16 }),
    tp: fc.integer({ min: 0, max: 24 }),
  }),
  fc.record({ kind: fc.constant('flatten' as const) }),
);

/** Replay actions; prices are relative to the last close in ticks, so they mean the same in any space. */
function run(
  series: readonly Bar[],
  settings: SessionSettings,
  start: number,
  acts: Act[],
): SessionState {
  let s = createSession(series, settings, series[start]!.time);
  const tick = settings.tickSize;
  for (const a of acts) {
    if (a.kind === 'step') s = stepSession(series, settings, s, a.n).state;
    else if (a.kind === 'flatten') {
      try {
        s = sessionFlatten(series, s);
      } catch {
        /* nothing to flatten */
      }
    } else if (s.status === 'active') {
      const last = series[s.cursor]!.close;
      const dir = a.side === 'buy' ? 1 : -1;
      const price =
        a.type === 'market'
          ? null
          : a.type === 'limit'
            ? last - dir * a.off * tick
            : last + dir * a.off * tick;
      const ref = price ?? last;
      try {
        s = sessionPlaceOrder(series, settings, s, {
          side: a.side,
          type: a.type,
          qty: 1 + (a.off % 3),
          price,
          stopLoss: a.sl ? ref - dir * a.sl * tick : null,
          takeProfit: a.tp ? ref + dir * a.tp * tick : null,
        });
      } catch {
        /* invalid combos are skipped */
      }
    }
  }
  return s;
}

const rng = (seed: number) => {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 2 ** 32;
  };
};

describe('blind mode', () => {
  it('picked parameters are always valid and far from the real period', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2 ** 31 }), (seed) => {
        const p = pickBlindParams(bars, SETTINGS.tickSize, rng(seed));
        expect(blindIssues(p, bars, SETTINGS.tickSize)).toEqual([]);
        expect(Math.abs(p.timeShift)).toBeGreaterThanOrEqual(BLIND_MIN_WEEKS * WEEK_SECONDS);
        expect(p.timeShift % WEEK_SECONDS === 0).toBe(true);
        expect(
          Math.abs(
            p.priceOffset / SETTINGS.tickSize - Math.round(p.priceOffset / SETTINGS.tickSize),
          ),
        ).toBeLessThan(1e-9);
        expect(p.priceOffset).not.toBe(0);
        const d = disguiseBars(bars, p, SETTINGS.tickSize);
        expect(d.every((b) => b.low > 0)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('stored parameters that would break weekday/time or P&L are refused', () => {
    const ok = { timeShift: 300 * WEEK_SECONDS, priceOffset: 40 * SETTINGS.tickSize };
    expect(blindIssues(ok, bars, SETTINGS.tickSize)).toEqual([]);
    for (const timeShift of [0, 86_400, 3600, 60, WEEK_SECONDS + 1, 1.5 * WEEK_SECONDS, NaN])
      expect(
        blindIssues({ ...ok, timeShift }, bars, SETTINGS.tickSize).length,
        String(timeShift),
      ).toBe(1);
    for (const priceOffset of [SETTINGS.tickSize / 2, 0.1, Infinity, -1e9])
      expect(
        blindIssues({ ...ok, priceOffset }, bars, SETTINGS.tickSize).length,
        String(priceOffset),
      ).toBeGreaterThan(0);
    expect(
      blindIssues({ ...ok, timeShift: -1e5 * WEEK_SECONDS }, bars, SETTINGS.tickSize),
    ).toContain('timeShift would make times negative');
  });

  it('start index leaves history and bars to trade', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 3, max: 100_000 }),
        fc.double({ min: 0, max: 0.999999, noNaN: true }),
        (n, r) => {
          const i = pickBlindStartIndex(n, () => r);
          expect(i).toBeGreaterThanOrEqual(1);
          expect(i).toBeLessThanOrEqual(n - 2);
        },
      ),
    );
  });

  it('disguise keeps weekday, time of day and trading day boundaries', () => {
    const p = pickBlindParams(bars, SETTINGS.tickSize, rng(7));
    const d = disguiseBars(bars, p, SETTINGS.tickSize);
    for (let i = 0; i < bars.length; i += 37) {
      const a = new Date(bars[i]!.time * 1000);
      const b = new Date(d[i]!.time * 1000);
      expect(b.getUTCDay()).toBe(a.getUTCDay());
      expect(b.getUTCHours() * 60 + b.getUTCMinutes()).toBe(
        a.getUTCHours() * 60 + a.getUTCMinutes(),
      );
      expect(dayKeyOf(d[i]!.time, SETTINGS) - dayKeyOf(bars[i]!.time, SETTINGS)).toBe(
        p.timeShift / 86_400,
      );
      expect(revealTime(d[i]!.time, p)).toBe(bars[i]!.time);
      expect(revealPrice(d[i]!.close, p, SETTINGS.tickSize)).toBe(bars[i]!.close);
    }
  });

  it('property: a blind session trades exactly like the real one (same P&L, same rules)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2 ** 31 }),
        fc.integer({ min: 30, max: 900 }),
        fc.array(act, { minLength: 1, maxLength: 30 }),
        (seed, start, acts) => {
          const p = pickBlindParams(bars, SETTINGS.tickSize, rng(seed));
          const d = disguiseBars(bars, p, SETTINGS.tickSize);
          const real = run(bars, SETTINGS, start, acts);
          const blind = run(d, SETTINGS, start, acts);
          expect(blind.cursor).toBe(real.cursor);
          expect(blind.status).toBe(real.status);
          expect(blind.trading.fills.length).toBe(real.trading.fills.length);
          blind.trading.fills.forEach((f, i) => {
            const r = real.trading.fills[i]!;
            expect(f.time - p.timeShift).toBe(r.time);
            expect(revealPrice(f.price, p, SETTINGS.tickSize)).toBeCloseTo(r.price, 9);
            expect(f.qty).toBe(r.qty);
          });
          expect(blind.trading.realizedPnl).toBeCloseTo(real.trading.realizedPnl, 6);
          const a = sessionStats(SETTINGS, blind);
          const b = sessionStats(SETTINGS, real);
          expect(a.trades).toBe(b.trades);
          expect(a.netPnl).toBeCloseTo(b.netPnl, 6);
        },
      ),
      { numRuns: 150 },
    );
  });
});

function exportFile(state: SessionState, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: 'candledrill-session',
    formatVersion: 1,
    name: 'Practice',
    startTime: bars[100]!.time,
    settings: SETTINGS,
    state,
    drawings: [{ kind: 'hline', id: 'a1', price: 100 }],
    ...extra,
  });
}

describe('session file import checks', () => {
  it('property: every genuine session passes the checks', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 30, max: 900 }),
        fc.array(act, { minLength: 1, maxLength: 30 }),
        (start, acts) => {
          const s = run(bars, SETTINGS, start, acts);
          const parsed = parseSessionFile(exportFile(s));
          expect(parsed.issues).toEqual([]);
          expect(checkSessionState(bars, SETTINGS, parsed.file!.state)).toEqual([]);
        },
      ),
      { numRuns: 200 },
    );
  });

  // A session with at least one fill, used as the base for tampering.
  const base = (() => {
    let s = createSession(bars, SETTINGS, bars[200]!.time);
    s = sessionPlaceOrder(bars, SETTINGS, s, { side: 'buy', type: 'market', qty: 2 });
    s = stepSession(bars, SETTINGS, s, 5).state;
    return s;
  })();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tampering needs free-form access
  type Loose = any;
  const tamper = (f: (s: Loose) => void): unknown => {
    const s = JSON.parse(JSON.stringify(base));
    f(s);
    return s;
  };

  it('base session is accepted', () => {
    expect(base.trading.fills.length).toBeGreaterThan(0);
    expect(checkSessionState(bars, SETTINGS, base)).toEqual([]);
  });

  const cases: [string, (s: Loose) => void][] = [
    ['fill price moved far outside its bar', (s) => (s.trading.fills[0].price += 50)],
    ['fill time not a bar', (s) => (s.trading.fills[0].time += 1)],
    [
      'fill time in the unrevealed future',
      (s) => (s.trading.fills[0].time = bars[s.cursor + 1]!.time),
    ],
    ['commissionPaid edited', (s) => (s.trading.commissionPaid = 0)],
    ['position qty edited', (s) => (s.trading.position.qty = 5)],
    ['cursor past the data', (s) => (s.cursor = bars.length)],
    ['negative cursor', (s) => (s.cursor = -1)],
    ['status unknown', (s) => (s.status = 'won')],
    ['qty zero', (s) => (s.trading.fills[0].qty = 0)],
    ['qty fractional', (s) => (s.trading.fills[0].qty = 1.5)],
    ['order placed after cursor', (s) => (s.trading.orders[0].placedIndex = s.cursor + 1)],
    ['duplicate order id', (s) => s.trading.orders.push({ ...s.trading.orders[0] })],
    ['fills is not a list', (s) => (s.trading.fills = {})],
    ['version 2', (s) => (s.version = 2)],
    ['string where number expected', (s) => (s.trading.realizedPnl = '100')],
    [
      'extra position with no fills',
      (s) => ((s.trading.fills = []), (s.trading.commissionPaid = 0)),
    ],
    [
      'invented winning trade',
      (s) =>
        s.trading.trades.push({
          id: 99,
          side: 'long',
          qty: 1,
          openTime: bars[0]!.time,
          closeTime: bars[s.cursor]!.time,
          entryPrice: 1,
          exitPrice: 2,
          grossPnl: 1e6,
          commission: 0,
          netPnl: 2e6,
          exitReason: 'manual',
        }),
    ],
    [
      'trade closing in the future',
      (s) =>
        s.trading.trades.push({
          id: 9,
          side: 'long',
          qty: 1,
          openTime: 0,
          closeTime: 4e9,
          entryPrice: 1,
          exitPrice: 2,
          grossPnl: 1,
          commission: 0,
          netPnl: 1,
          exitReason: 'manual',
        }),
    ],
  ];
  for (const [name, f] of cases)
    it(`rejects: ${name}`, () => {
      expect(checkSessionState(bars, SETTINGS, tamper(f)).length).toBeGreaterThan(0);
    });

  it('rejects a session matched to other data', () => {
    const other = generateSyntheticBars({ seed: 99, startDate: '2026-10-05', days: 4 }).bars;
    expect(checkSessionState(other, SETTINGS, base).length).toBeGreaterThan(0);
  });

  it('file layer rejects hostile input without throwing', () => {
    const bad = [
      '',
      'null',
      '[]',
      '{"format":"x"}',
      '{"format":"candledrill-session","formatVersion":2}',
      exportFile(base).replace('"realizedPnl":', '"realizedPnl":1e999,"x":'),
      exportFile(base, { name: '' }),
      exportFile(base, { name: 'x'.repeat(81) }),
      exportFile(base, { startTime: 1.5 }),
      exportFile(base, { settings: { ...SETTINGS, evil: 1 } }),
      exportFile(base, { settings: { ...SETTINGS, tickSize: -1 } }),
      exportFile(base, { drawings: [{ kind: 'hline', id: '<img>', price: 1 }] }),
      exportFile(base, {
        drawings: Array.from({ length: 201 }, (_, i) => ({ kind: 'hline', id: `a${i}`, price: 1 })),
      }),
      exportFile(base, { dataset: { fingerprint: 'abc' } }),
      exportFile(base, { blind: { timeShift: 'x' } }),
      exportFile(base).replace('"state":{', '"state":{"__proto__":{"polluted":1},'),
      '{"format":"candledrill-session","formatVersion":1,"a":' +
        '['.repeat(50) +
        ']'.repeat(50) +
        '}',
      'x'.repeat(21 * 1024 * 1024),
    ];
    for (const text of bad) {
      const r = parseSessionFile(text);
      expect(r.file, text.slice(0, 80)).toBeUndefined();
      expect(r.issues.length).toBeGreaterThan(0);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('property: arbitrary JSON never throws and never passes as a state', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        expect(() => parseSessionFile(JSON.stringify(v) ?? 'null')).not.toThrow();
        expect(() => checkSessionState(bars, SETTINGS, v)).not.toThrow();
        expect(checkSessionState(bars, SETTINGS, v).length).toBeGreaterThan(0);
      }),
      { numRuns: 300 },
    );
  });
});
