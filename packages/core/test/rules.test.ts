// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  createSession,
  ruleStatus,
  sessionFlatten,
  sessionPlaceOrder,
  stepSession,
  upgradeState,
  type Bar,
  type SessionSettings,
  type SessionState,
} from '../src/index.js';

const BASE: SessionSettings = {
  symbol: 'SYNTH-RULES',
  tickSize: 0.25,
  pointValue: 50,
  commissionPerContract: 0,
  slippageTicks: 0,
  startingBalance: 10_000,
  dailyLossLimit: null,
  trailingDrawdown: null,
  profitTarget: null,
  utcOffsetMinutes: 0,
  dayStartMinutes: 0,
  trailingDrawdownMode: 'close' as const,
  anchorMinutes: 0,
};

const DAY0 = Date.UTC(2026, 9, 5, 9, 0) / 1000;
/** Bar at `day` days and `min` minutes after DAY0. */
const b = (day: number, min: number, close: number, open = close): Bar => ({
  time: DAY0 + day * 86_400 + min * 60,
  open,
  high: Math.max(open, close),
  low: Math.min(open, close),
  close,
  volume: 1,
});

function start(bars: Bar[], settings: SessionSettings): SessionState {
  let s = createSession(bars, settings, bars[1]!.time); // cursor 0
  s = sessionPlaceOrder(bars, settings, s, { side: 'buy', type: 'market', qty: 1 });
  return s;
}

describe('practice rules', () => {
  it('daily loss limit: breach at the bar close, force-close and lock trading', () => {
    const settings = { ...BASE, dailyLossLimit: 100 };
    const bars = [b(0, 0, 100), b(0, 1, 100), b(0, 2, 99), b(0, 3, 97.75), b(0, 4, 101)];
    let s = start(bars, settings);
    s = stepSession(bars, settings, s, 2).state; // entry 100, close 99 -> -50
    expect(s.status).toBe('active');
    expect(ruleStatus(settings, s).dailyLossUsed).toBeCloseTo(0.5);
    s = stepSession(bars, settings, s, 1).state; // close 97.75 -> -112.5
    expect(s.status).toBe('breached');
    expect(s.statusReason).toMatch(/daily loss/);
    expect(s.trading.position).toBeNull();
    expect(s.trading.trades[0]).toMatchObject({
      exitReason: 'rule',
      exitPrice: 97.75,
      netPnl: -112.5,
    });
    expect(() =>
      sessionPlaceOrder(bars, settings, s, { side: 'buy', type: 'market', qty: 1 }),
    ).toThrow(/locked/);
    // Replay continues for review; status stays breached.
    s = stepSession(bars, settings, s, 1).state;
    expect(s.status).toBe('breached');
    expect(s.trading.realizedPnl).toBe(-112.5);
  });

  it('daily loss resets on a new trading day (custom day start)', () => {
    const settings = { ...BASE, dailyLossLimit: 100, dayStartMinutes: 17 * 60 };
    // 09:00 and 09:01 day 0, then next session after 17:00 day 0 counts as a new day.
    const bars = [
      b(0, 0, 100),
      b(0, 1, 100),
      b(0, 2, 98.5),
      b(0, 8 * 60 + 30, 98.5),
      b(0, 8 * 60 + 31, 97),
      b(0, 8 * 60 + 32, 97),
    ];
    let s = start(bars, settings);
    s = stepSession(bars, settings, s, 2).state; // -75 on day 0
    expect(s.status).toBe('active');
    s = stepSession(bars, settings, s, 1).state; // 17:30 -> new day, basis = 9925
    expect(s.dayStartEquity).toBe(9_925);
    s = stepSession(bars, settings, s, 1).state; // -75 more today (total -150) -> still within today's 100
    expect(s.status).toBe('active');
    expect(ruleStatus(settings, s).dailyLossUsed).toBeCloseTo(0.75);
  });

  it('trailing drawdown follows the closing-equity high-water mark', () => {
    const settings = { ...BASE, trailingDrawdown: 120 };
    const bars = [b(0, 0, 100), b(0, 1, 100), b(0, 2, 104), b(0, 3, 102), b(0, 4, 101.5)];
    let s = start(bars, settings);
    s = stepSession(bars, settings, s, 2).state; // +200 peak 10200
    expect(s.equityPeak).toBe(10_200);
    s = stepSession(bars, settings, s, 1).state; // 10100, dd 100
    expect(s.status).toBe('active');
    s = stepSession(bars, settings, s, 1).state; // 10075, dd 125 -> breach
    expect(s.status).toBe('breached');
    expect(s.statusReason).toMatch(/trailing/);
    expect(s.trading.trades[0]!.netPnl).toBe(75);
  });

  it('profit target passes the session and flattens', () => {
    const settings = { ...BASE, profitTarget: 150 };
    const bars = [b(0, 0, 100), b(0, 1, 100), b(0, 2, 102), b(0, 3, 103.5)];
    let s = start(bars, settings);
    s = stepSession(bars, settings, s, 2).state;
    expect(s.status).toBe('active');
    expect(ruleStatus(settings, s).targetProgress).toBeCloseTo(100 / 150);
    s = stepSession(bars, settings, s, 1).state;
    expect(s.status).toBe('passed');
    expect(s.trading.position).toBeNull();
    expect(s.trading.realizedPnl).toBe(175);
  });

  it('rules off -> ruleStatus is null; flatten is refused at the end of the data', () => {
    const bars = [b(0, 0, 100), b(0, 1, 100), b(0, 2, 90)];
    let s = start(bars, BASE);
    s = stepSession(bars, BASE, s, 2).state;
    expect(ruleStatus(BASE, s)).toEqual({
      dailyLossUsed: null,
      trailingUsed: null,
      targetProgress: null,
    });
    // End-of-data policy keep-open: no later bar can fill a flatten order (fill model v2).
    expect(s.status).toBe('finished');
    expect(() => sessionFlatten(bars, s)).toThrow(/end of data/);
  });

  it('upgrades states stored before rules existed', () => {
    const bars = [b(0, 0, 100), b(0, 1, 100)];
    const s = createSession(bars, BASE, bars[1]!.time);
    const { dayKey: _a, dayStartEquity: _b, equityPeak: _c, ...old } = s;
    void [_a, _b, _c];
    expect(upgradeState(bars, BASE, old as SessionState)).toEqual(s);
  });

  it('trailing modes: +2000 then reverse — close/intraday breach, eod/static do not', () => {
    // pointValue 50: +40 points = +2000 equity. Trailing amount 2000.
    const bars = [
      b(0, 0, 100),
      b(0, 1, 100),
      b(0, 2, 140), // +2000
      b(0, 3, 100), // back to entry
      b(0, 4, 100),
    ];
    const run = (mode: 'close' | 'eod' | 'intraday' | 'static') => {
      const settings = {
        ...BASE,
        trailingDrawdown: 2000,
        trailingDrawdownMode: mode,
      };
      let s = start(bars, settings);
      s = stepSession(bars, settings, s, 2).state; // fill + peak bar
      expect(s.status).toBe('active');
      s = stepSession(bars, settings, s, 1).state; // reverse to entry
      return s;
    };
    expect(run('close').status).toBe('breached');
    expect(run('intraday').status).toBe('breached');
    expect(run('eod').status).toBe('active');
    expect(run('static').status).toBe('active');
  });

  it('eod trailing updates peak only at the day boundary', () => {
    const settings = {
      ...BASE,
      trailingDrawdown: 100,
      trailingDrawdownMode: 'eod' as const,
      dayStartMinutes: 0,
      anchorMinutes: 0,
    };
    const bars = [
      b(0, 0, 100),
      b(0, 1, 100),
      b(0, 2, 104), // +200, eodPeak still 10000
      b(1, 0, 104), // new day → eodPeak becomes 10200
      b(1, 1, 101.5), // equity 10075, dd from 10200 = 125 → breach
    ];
    let s = start(bars, settings);
    s = stepSession(bars, settings, s, 2).state;
    expect(s.status).toBe('active');
    expect(s.eodPeak).toBe(10_000);
    s = stepSession(bars, settings, s, 1).state; // day boundary
    expect(s.eodPeak).toBe(10_200);
    expect(s.status).toBe('active');
    s = stepSession(bars, settings, s, 1).state;
    expect(s.status).toBe('breached');
  });

  it('static floor is startingBalance − amount', () => {
    const settings = {
      ...BASE,
      trailingDrawdown: 150,
      trailingDrawdownMode: 'static' as const,
    };
    // equity drop of 150 from start breaches; peak rise does not move floor
    const bars = [b(0, 0, 100), b(0, 1, 100), b(0, 2, 104), b(0, 3, 96.5)];
    let s = start(bars, settings);
    s = stepSession(bars, settings, s, 2).state; // +200
    expect(s.status).toBe('active');
    s = stepSession(bars, settings, s, 1).state; // close 96.5 → -175 from start
    expect(s.status).toBe('breached');
  });

  it('intraday trailing force-closes at the adverse extreme, not the close', () => {
    const settings = {
      ...BASE,
      trailingDrawdown: 100,
      trailingDrawdownMode: 'intraday' as const,
      commissionPerContract: 0,
      slippageTicks: 0,
    };
    // Long: favourable high 104 (+200), adverse low 101 (+50) → dd 150 from peak → breach at low
    const bars: Bar[] = [
      b(0, 0, 100),
      b(0, 1, 100),
      {
        time: DAY0 + 2 * 60,
        open: 100,
        high: 104,
        low: 101,
        close: 103,
        volume: 1,
      },
    ];
    let s = start(bars, settings);
    // start() leaves cursor on the flat entry bar; one more step reveals the wide bar.
    s = stepSession(bars, settings, s, 2).state;
    expect(s.status).toBe('breached');
    expect(s.trading.trades[0]!.exitPrice).toBe(101);
  });
});
