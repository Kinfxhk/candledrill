// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { adx, donchian, orbLevels, stochastic } from '../src/indicators.js';
import type { Bar } from '../src/types.js';

function bar(i: number, close: number, high = close + 1, low = close - 1): Bar {
  return { time: i * 60, open: close, high, low, close, volume: 1 };
}

describe('donchian', () => {
  it('uses the highest high and lowest low of the window, including the current bar', () => {
    const bars = [bar(0, 1, 2, 0), bar(1, 2, 4, 1), bar(2, 3, 5, 2), bar(3, 2, 3, 0)];
    const r = donchian(bars, 3);
    expect(r.upper).toEqual([null, null, 5, 5]);
    expect(r.lower).toEqual([null, null, 0, 0]);
    expect(r.middle[2]).toBe(2.5);
  });
});

describe('stochastic', () => {
  it('puts %K at 100 when close is the highest high, and smooths %D', () => {
    const bars = [bar(0, 10, 11, 9), bar(1, 12, 13, 10), bar(2, 14, 15, 12)];
    const r = stochastic(bars, 3, 1, 1);
    expect(r.k[0]).toBeNull();
    expect(r.k[1]).toBeNull();
    // hh 15, ll 9, close 14 → 100 * (14-9) / (15-9)
    expect(r.k[2]).toBeCloseTo((100 * 5) / 6, 9);
    expect(r.d[2]).toBeCloseTo((100 * 5) / 6, 9);
  });

  it('returns 50 when the range is zero', () => {
    const flat: Bar = { time: 0, open: 5, high: 5, low: 5, close: 5, volume: 1 };
    const r = stochastic([flat, { ...flat, time: 60 }], 2, 1, 1);
    expect(r.k[1]).toBe(50);
  });
});

describe('adx', () => {
  it('reads a one-way rally as +DI above −DI once the seed is ready', () => {
    const bars: Bar[] = [];
    for (let i = 0; i < 40; i++) {
      const close = 100 + i;
      bars.push({
        time: i * 60,
        open: close - 0.5,
        high: close + 1,
        low: close - 1,
        close,
        volume: 1,
      });
    }
    const r = adx(bars, 5);
    const last = bars.length - 1;
    expect(r.plusDi[5]).not.toBeNull();
    expect(r.adx[9]).not.toBeNull();
    expect(r.plusDi[last]!).toBeGreaterThan(r.minusDi[last]!);
    expect(r.adx[last]!).toBeGreaterThan(20);
  });
});

describe('orbLevels', () => {
  it('freezes the opening range and ignores later extremes', () => {
    const bars: Bar[] = [];
    for (let i = 0; i < 30; i++) {
      bars.push({ time: i * 60, open: 100, high: 110, low: 90, close: 100, volume: 1 });
    }
    bars.push({ time: 30 * 60, open: 112, high: 140, low: 80, close: 130, volume: 1 });
    const r = orbLevels(bars, 30, { utcOffsetMinutes: 0, dayStartMinutes: 0 });
    expect(r.complete[29]).toBe(false);
    expect(r.high[29]).toBe(110);
    expect(r.low[29]).toBe(90);
    expect(r.complete[30]).toBe(true);
    expect(r.high[30]).toBe(110);
    expect(r.low[30]).toBe(90);
  });

  it('resets on the next trading day', () => {
    const first = { time: 0, open: 10, high: 12, low: 9, close: 10, volume: 1 };
    const nextDay = { time: 86_400, open: 20, high: 22, low: 19, close: 20, volume: 1 };
    const r = orbLevels([first, nextDay], 30);
    expect(r.high[1]).toBe(22);
    expect(r.complete[1]).toBe(false);
  });
});
