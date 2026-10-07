// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  aggregateBars,
  BarAggregator,
  bucketStart,
  generateSyntheticBars,
  validateBars,
  type Bar,
} from '../src/index.js';

const ds = generateSyntheticBars({
  seed: 11,
  startDate: '2026-10-05',
  days: 5,
  missingBarProbability: 0.05,
});

describe('bucketStart', () => {
  it('aligns to the local clock and custom day start', () => {
    const t = Date.UTC(2026, 9, 5, 14, 37) / 1000;
    expect(bucketStart(t, 300)).toBe(Date.UTC(2026, 9, 5, 14, 35) / 1000);
    expect(bucketStart(t, 3600, { utcOffsetMinutes: 330 })).toBe(
      Date.UTC(2026, 9, 5, 14, 30) / 1000,
    );
    // Daily bar starting 17:00 local at UTC-5 -> 22:00 UTC.
    expect(bucketStart(t, 86400, { utcOffsetMinutes: -300, dayStartMinutes: 17 * 60 })).toBe(
      Date.UTC(2026, 9, 4, 22, 0) / 1000,
    );
    expect(() => bucketStart(t, 0)).toThrow(RangeError);
  });
});

describe('aggregateBars', () => {
  it.each([300, 900, 3600, 86400])('produces valid %is bars that conserve OHLCV', (tf) => {
    const out = aggregateBars(ds.bars, tf);
    expect(validateBars(out, { timeframeSeconds: tf })).toEqual([]);
    const vol = (bs: Bar[]) => bs.reduce((n, b) => n + b.volume, 0);
    expect(vol(out)).toBe(vol(ds.bars));
    expect(out[0]!.open).toBe(ds.bars[0]!.open);
    expect(out.at(-1)!.close).toBe(ds.bars.at(-1)!.close);
    expect(Math.max(...out.map((b) => b.high))).toBe(Math.max(...ds.bars.map((b) => b.high)));
    expect(Math.min(...out.map((b) => b.low))).toBe(Math.min(...ds.bars.map((b) => b.low)));
  });

  it('the forming bar only contains bars already pushed (no future leak)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: ds.bars.length }),
        fc.constantFrom(300, 900, 3600, 86400),
        (n, tf) => {
          const prefix = ds.bars.slice(0, n);
          const agg = new BarAggregator(tf);
          let last: Bar | undefined;
          for (const b of prefix) last = agg.push(b).bar;
          expect(last).toEqual(aggregateBars(prefix, tf).at(-1));
          expect(last!.close).toBe(prefix.at(-1)!.close);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('rejects out-of-order input', () => {
    const agg = new BarAggregator(300);
    agg.push(ds.bars[10]!);
    expect(() => agg.push(ds.bars[0]!)).toThrow(RangeError);
  });
});
