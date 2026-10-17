// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { atr, bollinger, ema, macd, rsi, sma, sourceValue, vwap } from '../src/indicators.js';
import type { Bar } from '@candledrill/core';

function bars(values: number[]): Bar[] {
  return values.map((close, i) => ({
    time: i * 60,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1,
  }));
}

const OSC: Bar[] = [
  { time: 0, open: 10, high: 12, low: 9, close: 10, volume: 1 },
  { time: 60, open: 10, high: 13, low: 9, close: 11, volume: 1 },
  { time: 120, open: 11, high: 14, low: 10, close: 12, volume: 1 },
  { time: 180, open: 12, high: 13, low: 11, close: 11, volume: 1 },
  { time: 240, open: 11, high: 12, low: 10, close: 10, volume: 1 },
];

describe('sourceValue', () => {
  const b: Bar = { time: 0, open: 1, high: 3, low: 0, close: 2, volume: 1 };
  it('returns requested source', () => {
    expect(sourceValue(b, 'open')).toBe(1);
    expect(sourceValue(b, 'high')).toBe(3);
    expect(sourceValue(b, 'low')).toBe(0);
    expect(sourceValue(b, 'close')).toBe(2);
    expect(sourceValue(b, 'hlc3')).toBeCloseTo((3 + 0 + 2) / 3, 9);
  });
});

describe('sma', () => {
  it('pads with null until the period is filled', () => {
    const r = sma(bars([1, 2, 3, 4, 5]), 3);
    expect(r).toEqual([null, null, 2, 3, 4]);
  });
  it('respects the source', () => {
    const r = sma(OSC, 2, 'high');
    expect(r[1]).toBeCloseTo(12.5, 9);
  });
});

describe('ema', () => {
  it('starts after period bars and then decays', () => {
    const r = ema(bars([10, 11, 12, 11, 10]), 3);
    expect(r[0]).toBeNull();
    expect(r[1]).toBeNull();
    expect(r[2]).toBeCloseTo(11, 9);
    expect(r[3]).toBeCloseTo(11, 9);
    expect(r[4]).toBeLessThan(r[3]!);
  });
});

describe('bollinger', () => {
  it('keeps the middle SMA and symmetrical bands', () => {
    const r = bollinger(bars([1, 2, 3, 4, 5]), 2, 2);
    expect(r.middle).toEqual([null, 1.5, 2.5, 3.5, 4.5]);
    expect(r.upper[2]! - r.middle[2]!).toBeCloseTo(r.middle[2]! - r.lower[2]!, 9);
  });
});

describe('vwap', () => {
  it('resets on a new exchange trading day', () => {
    const bs: Bar[] = [
      { time: 0, open: 10, high: 12, low: 9, close: 10, volume: 2 },
      { time: 3600, open: 11, high: 13, low: 10, close: 12, volume: 2 },
      { time: 86_400, open: 20, high: 22, low: 19, close: 20, volume: 1 },
    ];
    const r = vwap(bs);
    expect(r[0]!.value).toBeCloseTo((12 + 9 + 10) / 3, 9);
    expect(r[1]!.value).toBeCloseTo((((12 + 9 + 10) / 3) * 2 + ((13 + 10 + 12) / 3) * 2) / 4, 9);
    expect(r[2]!.value).toBeCloseTo((22 + 19 + 20) / 3, 9);
  });
});

describe('rsi', () => {
  it('is 100 during straight up moves and near 0 during straight down moves', () => {
    const up = rsi(bars([10, 11, 12, 13, 14, 15]), 2);
    expect(up.at(-1)).toBe(100);
    const down = rsi(bars([15, 14, 13, 12, 11, 10]), 2);
    expect(down.at(-1)).toBe(0);
  });
  it('pads with nulls', () => {
    const r = rsi(OSC, 14);
    expect(r.filter((x) => x === null).length).toBeGreaterThan(0);
  });
});

describe('macd', () => {
  it('produces aligned macd, signal and histogram lines', () => {
    const r = macd(bars([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]), 3, 5, 2);
    expect(r.macd.length).toBe(11);
    expect(r.signal.length).toBe(11);
    expect(r.histogram.length).toBe(11);
    expect(r.macd[0]).toBeNull();
    // In a steady uptrend fast EMA > slow EMA, so MACD > 0.
    expect(r.macd.at(-1)).toBeGreaterThan(0);
  });
});

describe('atr', () => {
  it('uses Wilder smoothing and handles gaps', () => {
    const bs: Bar[] = [
      { time: 0, open: 10, high: 12, low: 9, close: 10, volume: 1 },
      { time: 60, open: 15, high: 16, low: 14, close: 15, volume: 1 },
      { time: 120, open: 15, high: 17, low: 13, close: 14, volume: 1 },
    ];
    const r = atr(bs, 2);
    expect(r[0]).toBeNull();
    // Bar 2 true range includes the gap from prev close 15 to low 13.
    expect(r[2]).toBeCloseTo((5 + 4) / 2 + (1 / 2) * (Math.max(4, 2, 2) - (5 + 4) / 2), 9);
  });
});
