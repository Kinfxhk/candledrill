// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  blankProfile,
  createSession,
  evaluateProfile,
  parseProfile,
  profileIssues,
  profileToSettings,
  sessionPlaceOrder,
  stepSession,
  type Bar,
  type RuleProfile,
  type SessionSettings,
  type SessionState,
} from '../src/index.js';

const BASE: SessionSettings = {
  symbol: 'SYNTH-PROFILE',
  tickSize: 0.25,
  pointValue: 50,
  commissionPerContract: 0,
  slippageTicks: 0,
  startingBalance: 50_000,
  dailyLossLimit: null,
  trailingDrawdown: null,
  profitTarget: null,
  utcOffsetMinutes: 0,
  dayStartMinutes: 0,
  trailingDrawdownMode: 'close',
  anchorMinutes: 0,
};
const CLOCK = { utcOffsetMinutes: 0, dayStartMinutes: 0 };
const DAY0 = Date.UTC(2026, 9, 5, 9, 0) / 1000;
const bar = (day: number, min: number, close: number): Bar => ({
  time: DAY0 + day * 86_400 + min * 60,
  open: close,
  high: close,
  low: close,
  close,
  volume: 1,
});

/** Run a list of (day, minute, close, action) steps; actions fill at the next bar open. */
function play(
  steps: Array<
    [
      day: number,
      min: number,
      close: number,
      action?: 'buy' | 'sell' | ['buy' | 'sell', number] | undefined,
    ]
  >,
  settings: SessionSettings = BASE,
): { state: SessionState; bars: Bar[] } {
  const bars = steps.map(([d, m, c]) => bar(d, m, c));
  let s = createSession(bars, settings, bars[0]!.time);
  for (let i = 0; i < steps.length - 1; i++) {
    const act = steps[i]![3];
    if (act) {
      const [side, qty] = Array.isArray(act) ? act : [act, 1];
      s = sessionPlaceOrder(bars, settings, s, { side, type: 'market', qty });
    }
    s = stepSession(bars, settings, s, 1).state;
  }
  return { state: s, bars };
}
const P = (patch: Partial<RuleProfile>): RuleProfile => ({ ...blankProfile('p1'), ...patch });
const result = (p: RuleProfile, run: ReturnType<typeof play>, settings = BASE) =>
  evaluateProfile(p, settings, run.state, CLOCK, run.bars[run.state.cursor]!.time);
const rule = (r: ReturnType<typeof result>, id: string) => r.results.find((x) => x.id === id)!;

describe('rule profile file', () => {
  it('accepts a blank profile and round-trips through JSON', () => {
    const p = blankProfile('abc', 'Evaluation 50K');
    expect(profileIssues(p)).toEqual([]);
    expect(parseProfile(JSON.stringify(p)).profile).toEqual(p);
  });
  it('rejects unknown fields, bad numbers, bad clock and wrong format', () => {
    const p = {
      ...blankProfile('x'),
      extra: 1,
      maxContracts: 1.5,
      flatBy: '25:00',
      consistencyPct: 150,
    };
    const issues = profileIssues(p);
    expect(issues).toContain('extra: unknown field');
    expect(issues).toContain('maxContracts: must be a whole number');
    expect(issues).toContain('flatBy: HH:MM or null');
    expect(issues).toContain('consistencyPct: 1-100');
    expect(parseProfile('{').issues).toEqual(['not valid JSON']);
    expect(profileIssues({ ...blankProfile('x'), format: 'other' })).toContain(
      'format: not a CandleDrill rule profile',
    );
  });
  it('never throws on random input', () => {
    fc.assert(fc.property(fc.anything(), (x) => Array.isArray(profileIssues(x))));
  });
  it('maps the engine rules onto session settings', () => {
    expect(
      profileToSettings(
        P({
          accountSize: 100_000,
          dailyLoss: 2_000,
          maxLoss: 3_000,
          maxLossMode: 'static',
          profitTarget: 6_000,
        }),
      ),
    ).toEqual({
      startingBalance: 100_000,
      dailyLossLimit: 2_000,
      trailingDrawdown: 3_000,
      trailingDrawdownMode: 'static',
      profitTarget: 6_000,
    });
  });
});

describe('evaluateProfile', () => {
  it('consistency: best day share of total profit', () => {
    // Day 0: +1000 (20 points). Day 1: +250 (5 points). Best share 80 %.
    const run = play([
      [0, 0, 100, 'buy'],
      [0, 1, 100],
      [0, 2, 120, 'sell'],
      [0, 3, 120],
      [1, 0, 120, 'buy'],
      [1, 1, 120],
      [1, 2, 125, 'sell'],
      [1, 3, 125],
    ]);
    const r = result(P({ consistencyPct: 50 }), run);
    expect(rule(r, 'consistency')).toMatchObject({ state: 'pending', value: 80, limit: 50 });
    expect(rule(r, 'consistency').detail).toEqual({ bestDay: 1000, totalProfit: 1250 });
    expect(rule(result(P({ consistencyPct: 80 }), run), 'consistency').state).toBe('pass');
    expect(r.dayPnl).toEqual([
      { day: Math.floor(DAY0 / 86_400), pnl: 1000 },
      { day: Math.floor(DAY0 / 86_400) + 1, pnl: 250 },
    ]);
  });

  it('minimum trading days and profit days', () => {
    const run = play([
      [0, 0, 100, 'buy'],
      [0, 1, 100],
      [0, 2, 102, 'sell'], // +100
      [0, 3, 102],
      [1, 0, 102, 'buy'],
      [1, 1, 102],
      [1, 2, 101, 'sell'], // -50
      [1, 3, 101],
      [2, 0, 101, 'buy'],
      [2, 1, 101],
      [2, 2, 105, 'sell'], // +200
      [2, 3, 105],
    ]);
    const r = result(P({ minTradingDays: 3, minProfitDays: 2, minProfitDayAmount: 150 }), run);
    expect(rule(r, 'minTradingDays')).toMatchObject({ state: 'pass', value: 3 });
    expect(rule(r, 'minProfitDays')).toMatchObject({ state: 'pending', value: 1, limit: 2 });
    expect(r.tradingDays).toBe(3);
    expect(rule(result(P({ minProfitDays: 2 }), run), 'minProfitDays').state).toBe('pass');
  });

  it('contract cap, losing streak and trades per day', () => {
    const run = play([
      [0, 0, 100, ['buy', 3]],
      [0, 1, 100],
      [0, 2, 99, ['sell', 3]], // loss 1
      [0, 3, 99, 'buy'],
      [0, 4, 99],
      [0, 5, 98, 'sell'], // loss 2
      [0, 6, 98, 'buy'],
      [0, 7, 98],
      [0, 8, 97, 'sell'], // loss 3
      [0, 9, 97],
    ]);
    const r = result(P({ maxContracts: 2, maxConsecutiveLosses: 2, maxTradesPerDay: 2 }), run);
    expect(rule(r, 'maxContracts')).toMatchObject({
      state: 'fail',
      value: 3,
      limit: 2,
      brokenAt: run.bars[1]!.time,
    });
    expect(rule(r, 'maxConsecutiveLosses')).toMatchObject({ state: 'fail', value: 3 });
    expect(rule(r, 'maxTradesPerDay')).toMatchObject({ state: 'fail', value: 3 });
    expect(r.overall).toBe('fail');
  });

  it('flat-by time and no overnight', () => {
    const run = play([
      [0, 0, 100, 'buy'], // 09:00
      [0, 1, 100],
      [0, 420, 101], // 16:00 still long
      [1, 0, 102, 'sell'], // next day
      [1, 1, 102],
    ]);
    const r = result(P({ flatBy: '15:55', noOvernight: true }), run);
    expect(rule(r, 'flatBy')).toMatchObject({ state: 'fail' });
    expect(rule(r, 'noOvernight')).toMatchObject({
      state: 'fail',
      brokenAt: DAY0 - 9 * 3600 + 86_400,
    });
    expect(rule(r, 'flatBy').brokenAt).toBe(DAY0 + (6 * 60 + 55) * 60);
    const clean = play([
      [0, 0, 100, 'buy'],
      [0, 1, 100],
      [0, 300, 101, 'sell'], // 14:00 exit
      [0, 301, 101],
    ]);
    const ok = result(P({ flatBy: '15:55', noOvernight: true }), clean);
    expect(ok.results.every((x) => x.state === 'pass')).toBe(true);
    expect(ok.overall).toBe('pass');
  });

  it('engine rules follow the engine outcome (never disagree with the fill model)', () => {
    const settings = { ...BASE, ...profileToSettings(P({ dailyLoss: 100, accountSize: 50_000 })) };
    const run = play(
      [
        [0, 0, 100, 'buy'],
        [0, 1, 100],
        [0, 2, 97],
        [0, 3, 96],
      ],
      settings,
    );
    expect(run.state.status).toBe('breached');
    const r = result(P({ dailyLoss: 100 }), run, settings);
    expect(rule(r, 'dailyLoss').state).toBe('fail');
  });

  it('only uses revealed history: results at a cursor do not depend on later bars', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 95, max: 105 }), { minLength: 6, maxLength: 30 }),
        fc.nat(),
        (closes, cut) => {
          const steps = closes.map(
            (c, i) =>
              [0, i, c, i % 3 === 0 ? 'buy' : i % 3 === 2 ? 'sell' : undefined] as [
                number,
                number,
                number,
                'buy' | 'sell' | undefined,
              ],
          );
          const k = 2 + (cut % (steps.length - 2));
          const short = play(steps.slice(0, k));
          const long = play(steps);
          const p = P({
            maxConsecutiveLosses: 1,
            maxTradesPerDay: 2,
            consistencyPct: 40,
            minTradingDays: 1,
          });
          // Re-play the long run only up to the same cursor.
          const bars = long.bars;
          let s = createSession(bars, BASE, bars[0]!.time);
          for (let i = 0; i < k - 1; i++) {
            const act = steps[i]![3];
            if (act) s = sessionPlaceOrder(bars, BASE, s, { side: act, type: 'market', qty: 1 });
            s = stepSession(bars, BASE, s, 1).state;
          }
          expect(evaluateProfile(p, BASE, s, CLOCK, bars[s.cursor]!.time)).toEqual(
            evaluateProfile(p, BASE, short.state, CLOCK, short.bars[short.state.cursor]!.time),
          );
        },
      ),
      { numRuns: 60 },
    );
  });
});
