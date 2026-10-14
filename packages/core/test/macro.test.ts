// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  bracketPrices,
  conditionHolds,
  exampleOrbSmaMacro,
  macroSignal,
  parseMacro,
  runMacro,
} from '../src/macro.js';
import { createSession, stepSession, type SessionSettings } from '../src/session.js';
import type { Bar } from '../src/types.js';

const settings: SessionSettings = {
  symbol: 'TEST',
  tickSize: 1,
  pointValue: 1,
  commissionPerContract: 0,
  slippageTicks: 0,
  startingBalance: 10_000,
  dailyLossLimit: null,
  trailingDrawdown: null,
  profitTarget: null,
  utcOffsetMinutes: 0,
  dayStartMinutes: 0,
};

function sessionAt(bars: Bar[], index: number) {
  let state = createSession(bars, settings, bars[0]!.time);
  if (index > 0) state = stepSession(bars, settings, state, index).state;
  return state;
}

function rangeThenBreak(): Bar[] {
  const bars: Bar[] = [];
  for (let i = 0; i < 30; i++) {
    bars.push({ time: i * 60, open: 100, high: 110, low: 90, close: 100, volume: 1 });
  }
  bars.push({ time: 30 * 60, open: 112, high: 125, low: 111, close: 120, volume: 1 });
  // Touches the 10-tick target (130) without touching the stop (110), then closes back inside.
  bars.push({ time: 31 * 60, open: 121, high: 140, low: 115, close: 108, volume: 1 });
  bars.push({ time: 32 * 60, open: 100, high: 105, low: 95, close: 100, volume: 1 });
  return bars;
}

describe('parseMacro', () => {
  it('accepts the ORB + SMA example and rejects an empty rule list', () => {
    const macro = exampleOrbSmaMacro();
    expect(macro.onePositionOnly).toBe(true);
    expect(macro.rules[0]?.conditions.map((c) => c.type)).toEqual([
      'orb_break',
      'price_vs_ma',
      'flat_only',
    ]);
    expect(() => parseMacro({ ...macro, rules: [] })).toThrow(/rules/);
  });
});

describe('condition engine', () => {
  it('detects an ORB close break only after the opening window', () => {
    const bars = rangeThenBreak();
    const inside = sessionAt(bars, 29);
    const broken = sessionAt(bars, 30);
    const up = { type: 'orb_break' as const, minutes: 30, direction: 'up' as const };
    expect(conditionHolds(up, bars, settings, inside)).toBe(false);
    expect(conditionHolds(up, bars, settings, broken)).toBe(true);
    expect(
      conditionHolds(
        { type: 'price_vs_ma', op: 'above', ma: 'sma', period: 21 },
        bars,
        settings,
        broken,
      ),
    ).toBe(true);
  });

  it('treats a time window as exchange-local minutes, wrapping past midnight', () => {
    const bars: Bar[] = [
      { time: 0, open: 1, high: 2, low: 1, close: 1, volume: 1 },
      { time: 23 * 3600, open: 1, high: 2, low: 1, close: 1, volume: 1 },
    ];
    const early = sessionAt(bars, 0);
    const late = sessionAt(bars, 1);
    const morning = { type: 'time_window' as const, startMinute: 0, endMinute: 60 };
    const overnight = { type: 'time_window' as const, startMinute: 22 * 60, endMinute: 60 };
    expect(conditionHolds(morning, bars, settings, early)).toBe(true);
    expect(conditionHolds(morning, bars, settings, late)).toBe(false);
    expect(conditionHolds(overnight, bars, settings, late)).toBe(true);
  });

  it('requires a flat book for flat_only and honours priority', () => {
    const bars: Bar[] = [
      { time: 0, open: 10, high: 11, low: 9, close: 10, volume: 1 },
      { time: 60, open: 10, high: 11, low: 9, close: 10, volume: 1 },
      { time: 120, open: 10, high: 11, low: 9, close: 10, volume: 1 },
    ];
    const flatState = sessionAt(bars, 0);
    expect(conditionHolds({ type: 'flat_only' }, bars, settings, flatState)).toBe(true);
    const macro = parseMacro({
      schemaVersion: 1,
      name: 'priority',
      qty: 1,
      exit: { stop: { mode: 'ticks', value: 2 }, target: { mode: 'ticks', value: 4 } },
      rules: [
        {
          id: 'late-buy',
          priority: 5,
          enabled: true,
          side: 'buy',
          conditions: [{ type: 'flat_only' }],
        },
        {
          id: 'first-sell',
          priority: 1,
          enabled: true,
          side: 'sell',
          conditions: [{ type: 'flat_only' }],
        },
      ],
    });
    expect(macroSignal(bars, settings, flatState, macro)?.ruleId).toBe('first-sell');
  });

  it('prices a 2R target from the stop distance', () => {
    const prices = bracketPrices(
      'buy',
      100,
      1,
      { stop: { mode: 'ticks', value: 10 }, target: { mode: 'rr', value: 2 } },
      null,
    );
    expect(prices).toEqual({ stopLoss: 90, takeProfit: 120 });
  });
});

describe('runMacro', () => {
  it('backtests ORB + SMA through placeOrder and reports computeStats', () => {
    const bars = rangeThenBreak();
    const start = createSession(bars, settings, bars[0]!.time);
    const cursor = start.cursor;
    const macro = parseMacro({
      schemaVersion: 1,
      name: 'ORB + SMA',
      qty: 1,
      onePositionOnly: true,
      exit: { stop: { mode: 'ticks', value: 10 }, target: { mode: 'ticks', value: 10 } },
      rules: [
        {
          id: 'long',
          priority: 1,
          enabled: true,
          side: 'buy',
          conditions: [
            { type: 'orb_break', minutes: 30, direction: 'up' },
            { type: 'price_vs_ma', op: 'above', ma: 'sma', period: 21 },
            { type: 'flat_only' },
          ],
        },
      ],
    });
    const result = runMacro(bars, settings, start, macro, { mode: 'to_end', from: 'start' });
    expect(start.cursor).toBe(cursor);
    expect(start.trading.trades).toHaveLength(0);
    expect(result.simulated).toBe(true);
    expect(result.signals).toBeGreaterThanOrEqual(1);
    expect(result.stats.trades).toBe(1);
    expect(result.stats.winRate).toBe(1);
    expect(result.trades[0]?.exitReason).toBe('take-profit');
    expect(result.stats.maxDrawdown).toBeGreaterThanOrEqual(0);
    expect(result.openQty).toBe(0);
  });

  it('does not take a second position while one is open', () => {
    const bars: Bar[] = [];
    for (let i = 0; i < 8; i++) {
      const close = 100 + i;
      bars.push({ time: i * 60, open: close, high: close + 1, low: close - 1, close, volume: 1 });
    }
    const macro = parseMacro({
      schemaVersion: 1,
      name: 'always',
      qty: 1,
      onePositionOnly: true,
      exit: { stop: { mode: 'ticks', value: 50 }, target: { mode: 'ticks', value: 50 } },
      rules: [
        {
          id: 'buy',
          priority: 1,
          enabled: true,
          side: 'buy',
          conditions: [{ type: 'time_window', startMinute: 0, endMinute: 0 }],
        },
      ],
    });
    const result = runMacro(bars, settings, createSession(bars, settings, bars[0]!.time), macro, {
      mode: 'to_end',
      from: 'start',
    });
    expect(result.signals).toBe(1);
    expect(result.openQty).not.toBe(0);
  });
});
