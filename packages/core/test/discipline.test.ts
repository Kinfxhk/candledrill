// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  applyFill,
  createSession,
  dayKeyOf,
  disciplineStatus,
  emptyTrading,
  parseSessionFile,
  sessionFlatten,
  sessionPlaceOrder,
  stepSession,
  validateSettings,
  type Bar,
  type SessionSettings,
} from '../src/index.js';
const settings: SessionSettings = {
  symbol: 'TEST',
  tickSize: 1,
  pointValue: 1,
  commissionPerContract: 0,
  slippageTicks: 0,
  startingBalance: 10000,
  dailyLossLimit: null,
  trailingDrawdown: null,
  profitTarget: null,
  utcOffsetMinutes: 0,
  dayStartMinutes: 0,
};
const bars: Bar[] = [0, 60, 120, 180, 240, 300, 86400, 86460, 86520].map((time) => ({
  time,
  open: 100,
  high: 110,
  low: 90,
  close: 100,
  volume: 1,
}));
const start = (s = settings) => createSession(bars, s, 60);
const place = (
  state: ReturnType<typeof start>,
  s: SessionSettings,
  side: 'buy' | 'sell',
  qty = 1,
) => sessionPlaceOrder(bars, s, state, { side, qty, type: 'market' });

describe('optional practice discipline', () => {
  it('counts opened cycles, not scale-ins/partial exits, and counts a reversal once', () => {
    const s = { ...settings, maxDailyTradeCycles: 2 };
    let state = place(place(start(s), s, 'buy', 2), s, 'buy');
    state = stepSession(bars, s, state).state;
    expect(state.trading.position?.qty).toBe(3);
    expect(disciplineStatus(s, state).cycles).toBe(1);
    state = stepSession(bars, s, place(state, s, 'sell')).state;
    expect(disciplineStatus(s, state).cycles).toBe(1);
    state = stepSession(bars, s, place(state, s, 'sell', 4)).state;
    expect(state.trading.position?.qty).toBe(-2);
    expect(disciplineStatus(s, state).cycles).toBe(2);
    expect(() => place(state, s, 'sell')).toThrow('new exposure paused');
    expect(() => place(state, s, 'buy', 3)).toThrow('new exposure paused');
    state = stepSession(bars, s, place(state, s, 'buy')).state;
    expect(state.trading.position?.qty).toBe(-1);
    state = stepSession(bars, s, sessionFlatten(bars, state)).state;
    expect(state.trading.position).toBeNull();
    expect(state.status).toBe('active');
  });
  it('enforces a reached cycle limit between queued same-bar fills, cancelling only exposure', () => {
    const s = { ...settings, maxDailyTradeCycles: 1 };
    const queued = place(place(place(start(s), s, 'buy', 2), s, 'buy'), s, 'sell');
    const state = stepSession(bars, s, queued).state;
    expect(state.trading.fills.map((f) => [f.side, f.qty])).toEqual([
      ['buy', 2],
      ['sell', 1],
    ]);
    expect(state.trading.orders[1]?.status).toBe('cancelled');
    expect(state.trading.position?.qty).toBe(1);
  });
  it('protective same-bar losses pause later queued entries; replay resets on the next day', () => {
    const s = { ...settings, maxConsecutiveLosses: 1 };
    let state = sessionPlaceOrder(bars, s, start(s), {
      side: 'buy',
      type: 'market',
      qty: 1,
      stopLoss: 99,
    });
    state = place(state, s, 'buy');
    state = stepSession(bars, s, state).state;
    expect(state.trading.trades).toHaveLength(1);
    expect(state.trading.trades[0]?.netPnl).toBe(-1);
    expect(state.trading.orders[1]?.status).toBe('cancelled');
    expect(disciplineStatus(s, state).lossPause).toBe(true);
    expect(() => place(state, s, 'buy')).toThrow('consecutive-loss limit');
    state = stepSession(bars, s, state, 5).state;
    expect(disciplineStatus(s, state).reason).toBeNull();
    expect(() => place(state, s, 'buy')).not.toThrow();
  });
  it('latches after a losing close even when a later same-bar close wins; zero breaks before threshold', () => {
    const ledger = (profits: number[]) => {
      let trading = emptyTrading(100);
      for (const profit of profits) {
        trading = applyFill(trading, settings, {
          orderId: 0,
          side: 'buy',
          qty: 1,
          price: 100,
          time: 60,
          role: 'rule',
        });
        trading = applyFill(trading, settings, {
          orderId: 0,
          side: 'sell',
          qty: 1,
          price: 100 + profit,
          time: 60,
          role: 'rule',
        });
      }
      return { dayKey: 0, trading };
    };
    const s = { ...settings, maxConsecutiveLosses: 2 };
    expect(disciplineStatus(s, ledger([-1, 0, -1]))).toMatchObject({
      losingStreak: 1,
      lossPause: false,
    });
    expect(disciplineStatus(s, ledger([-1, -1, 1]))).toMatchObject({
      losingStreak: 0,
      lossPause: true,
    });
    expect(disciplineStatus(s, { ...ledger([-1, -1]), dayKey: 1 }).lossPause).toBe(false);
  });
  it('cancels a whole reversal if its close would hit the loss threshold; a separate reduction remains available', () => {
    const s = { ...settings, maxConsecutiveLosses: 1, commissionPerContract: 1 };
    let state = stepSession(bars, s, place(start(s), s, 'buy')).state;
    state = stepSession(bars, s, place(state, s, 'sell', 2)).state;
    expect(state.trading.position?.qty).toBe(1);
    expect(state.trading.trades).toHaveLength(0);
    expect(state.trading.orders[1]?.status).toBe('cancelled');
    state = stepSession(bars, s, place(state, s, 'sell')).state;
    expect(state.trading.position).toBeNull();
    expect(disciplineStatus(s, state).lossPause).toBe(true);
  });
  it('uses exchange-local boundary and permits an unfilled queued entry on the new day', () => {
    const s = { ...settings, maxDailyTradeCycles: 1, utcOffsetMinutes: 60, dayStartMinutes: 60 };
    let state = stepSession(bars, s, place(start(s), s, 'buy')).state;
    state = stepSession(bars, s, sessionFlatten(bars, state)).state;
    expect(disciplineStatus(s, state).reason).toBe('daily-trade-cycle limit');
    // A previously queued, untouched limit order becomes eligible at the new boundary.
    const order = {
      ...state.trading.orders[0]!,
      id: 99,
      status: 'working' as const,
      type: 'limit' as const,
      price: 95,
      placedIndex: state.cursor,
      filledTime: null,
      fillPrice: null,
    };
    state = { ...state, trading: { ...state.trading, orders: [...state.trading.orders, order] } };
    const quiet = bars.map((b, i) => (i < 6 ? { ...b, low: 99 } : b));
    state = stepSession(quiet, s, state, 4).state;
    expect(state.cursor).toBe(6);
    expect(state.trading.position?.qty).toBe(1);
    expect(disciplineStatus(s, state).cycles).toBe(1);
    expect(dayKeyOf(86399, { ...s, dayStartMinutes: 120 })).toBe(0);
    expect(dayKeyOf(3600, { ...s, dayStartMinutes: 120 })).toBe(0);
    expect(dayKeyOf(3599, { ...s, dayStartMinutes: 120 })).toBe(-1);
  });
  it('keeps legacy settings and optional off settings importable, rejects invalid limits', () => {
    for (const extra of [
      {},
      { maxDailyTradeCycles: null, maxConsecutiveLosses: null },
      { maxDailyTradeCycles: 1, maxConsecutiveLosses: 2 },
    ]) {
      const s = { ...settings, ...extra };
      expect(
        parseSessionFile(
          JSON.stringify({
            format: 'candledrill-session',
            formatVersion: 1,
            name: 'Legacy',
            startTime: 60,
            settings: s,
            state: start(s),
            drawings: [],
          }),
        ).issues,
      ).toEqual([]);
    }
    for (const value of [0, -1, 1.5, NaN, Infinity]) {
      expect(validateSettings({ ...settings, maxDailyTradeCycles: value }).length).toBeGreaterThan(
        0,
      );
      expect(validateSettings({ ...settings, maxConsecutiveLosses: value }).length).toBeGreaterThan(
        0,
      );
    }
    let state = place(place(start(), settings, 'buy'), settings, 'buy');
    state = stepSession(bars, settings, state).state;
    expect(state.trading.fills).toHaveLength(2);
  });
});
