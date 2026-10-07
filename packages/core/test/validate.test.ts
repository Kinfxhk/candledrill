// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { isOnTickGrid, tickDecimals, ticksToPrice, validateBars, type Bar } from '../src/index.js';

const good: Bar = { time: 120, open: 10, high: 11, low: 9.5, close: 10.5, volume: 3 };

describe('ticks', () => {
  it('computes decimals', () => {
    expect(tickDecimals(0.25)).toBe(2);
    expect(tickDecimals(1)).toBe(0);
    expect(tickDecimals(0.00001)).toBe(5);
    expect(() => tickDecimals(0)).toThrow(RangeError);
  });

  it('converts ticks to clean prices', () => {
    expect(ticksToPrice(16001, 0.25)).toBe(4000.25);
    expect(ticksToPrice(3, 0.1)).toBe(0.3); // not 0.30000000000000004
    expect(isOnTickGrid(4000.25, 0.25)).toBe(true);
    expect(isOnTickGrid(4000.3, 0.25)).toBe(false);
  });
});

describe('validateBars', () => {
  it('accepts a valid series', () => {
    expect(validateBars([good, { ...good, time: 180 }], { tickSize: 0.5 })).toEqual([]);
  });

  it('reports each kind of issue', () => {
    const codes = (bars: Bar[], tickSize?: number) =>
      validateBars(bars, tickSize === undefined ? {} : { tickSize }).map((i) => i.code);
    expect(codes([{ ...good, high: 9 }])).toContain('ohlc-inconsistent');
    expect(codes([{ ...good, low: -1 }])).toContain('non-positive-price');
    expect(codes([{ ...good, volume: -1 }])).toContain('negative-volume');
    expect(codes([{ ...good, close: 10.3 }], 0.25)).toContain('off-tick-grid');
    expect(codes([{ ...good, time: 61 }])).toContain('time-not-aligned');
    expect(codes([good, good])).toContain('time-not-increasing');
    expect(codes([{ ...good, open: Number.NaN }])).toEqual(['non-finite']);
  });
});
