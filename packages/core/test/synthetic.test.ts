// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  DEFAULT_SYNTHETIC_CALENDAR,
  expandSessions,
  generateSyntheticBars,
  intradayActivity,
  isInSession,
  validateBars,
  MAX_SYNTHETIC_BARS,
  type SessionCalendar,
} from '../src/index.js';

const base = { seed: 20261007, startDate: '2026-10-05', days: 5 } as const;

describe('generateSyntheticBars', () => {
  it('is deterministic: same seed and options give identical output', () => {
    expect(generateSyntheticBars(base)).toEqual(generateSyntheticBars(base));
  });

  it('different seeds give different paths', () => {
    const a = generateSyntheticBars(base).bars.map((b) => b.close);
    const b = generateSyntheticBars({ ...base, seed: base.seed + 1 }).bars.map((x) => x.close);
    expect(a).not.toEqual(b);
  });

  it('labels the data as synthetic', () => {
    const { meta } = generateSyntheticBars({ ...base, name: 'ES_LIKE' });
    expect(meta.synthetic).toBe(true);
    expect(meta.source).toBe('synthetic');
    expect(meta.symbol).toBe('SYNTH-ES_LIKE');
    expect(meta.generator).toEqual({ name: 'candledrill-synthetic', version: 1, seed: base.seed });
  });

  it('emits exactly one bar per session minute when nothing is missing', () => {
    const { bars } = generateSyntheticBars({ ...base, days: 7 }); // Mon..Sun
    expect(bars).toHaveLength(5 * 510);
    expect(bars.every((b) => isInSession(DEFAULT_SYNTHETIC_CALENDAR, b.time))).toBe(true);
  });

  it('within a session each open equals the previous close', () => {
    const { bars } = generateSyntheticBars(base);
    for (let i = 1; i < bars.length; i++) {
      if (bars[i]!.time - bars[i - 1]!.time === 60) expect(bars[i]!.open).toBe(bars[i - 1]!.close);
    }
  });

  it('produces gaps between sessions', () => {
    const { bars } = generateSyntheticBars({ ...base, days: 21, sessionGapVolatility: 0.01 });
    let gaps = 0;
    for (let i = 1; i < bars.length; i++) {
      const prev = bars[i - 1]!;
      const cur = bars[i]!;
      if (cur.time - prev.time > 60 && cur.open !== prev.close) gaps++;
    }
    expect(gaps).toBeGreaterThan(5);
  });

  it('can drop minutes to mimic illiquid periods', () => {
    const full = generateSyntheticBars(base).bars.length;
    const sparse = generateSyntheticBars({ ...base, missingBarProbability: 0.2 }).bars.length;
    expect(sparse).toBeLessThan(full * 0.9);
    expect(sparse).toBeGreaterThan(full * 0.7);
  });

  it('per-minute volatility is in the requested ballpark', () => {
    const { bars } = generateSyntheticBars({ ...base, days: 28, sessionGapVolatility: 0 });
    const rets: number[] = [];
    for (let i = 1; i < bars.length; i++) rets.push(Math.log(bars[i]!.close / bars[i - 1]!.close));
    const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length);
    const target = 0.2 / Math.sqrt(252 * 510);
    expect(sd).toBeGreaterThan(target * 0.5);
    expect(sd).toBeLessThan(target * 2);
  });

  it('is busier near the open and close than at midday (U-shape)', () => {
    expect(intradayActivity(0)).toBeGreaterThan(intradayActivity(0.5));
    expect(intradayActivity(1)).toBeGreaterThan(intradayActivity(0.5));
    const { bars } = generateSyntheticBars({ ...base, days: 28 });
    const byMinute = new Map<number, number[]>();
    for (const b of bars) {
      const m = ((b.time / 60) % 1440) - 8 * 60; // minute within the 08:00 UTC session
      const bucket = m < 30 ? 0 : m >= 480 ? 2 : m >= 240 && m < 270 ? 1 : -1;
      if (bucket >= 0)
        (byMinute.get(bucket) ?? byMinute.set(bucket, []).get(bucket)!).push(b.volume);
    }
    const avg = (k: number) => {
      const v = byMinute.get(k)!;
      return v.reduce((s, x) => s + x, 0) / v.length;
    };
    expect(avg(0)).toBeGreaterThan(avg(1));
    expect(avg(2)).toBeGreaterThan(avg(1));
  });

  it('supports custom calendars, tick sizes and names', () => {
    const cal: SessionCalendar = {
      utcOffsetMinutes: -5 * 60,
      windows: [{ days: [0, 1, 2, 3, 4], start: '18:00', end: '17:00' }],
    };
    const { bars, meta } = generateSyntheticBars({
      ...base,
      calendar: cal,
      tickSize: 0.01,
      startPrice: 75,
      name: 'CL_LIKE',
    });
    expect(bars).toHaveLength(expandSessions(cal, base.startDate, base.days).length * 23 * 60);
    expect(validateBars(bars, { tickSize: 0.01 })).toEqual([]);
    expect(meta.tickSize).toBe(0.01);
  });

  it('rejects invalid options', () => {
    expect(() => generateSyntheticBars({ ...base, days: 0 })).toThrow(RangeError);
    expect(() => generateSyntheticBars({ ...base, tickSize: -1 })).toThrow(RangeError);
    expect(() => generateSyntheticBars({ ...base, missingBarProbability: 0.9 })).toThrow(
      RangeError,
    );
    expect(() => generateSyntheticBars({ ...base, name: 'bad name' })).toThrow(RangeError);
    expect(() => generateSyntheticBars({ ...base, startPrice: 0.1 })).toThrow(RangeError);
    expect(() => generateSyntheticBars({ ...base, seed: -3 })).toThrow(RangeError);
    const allDay: SessionCalendar = {
      utcOffsetMinutes: 0,
      windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '24:00' }],
    };
    const tooMany = Math.ceil(MAX_SYNTHETIC_BARS / 1440) + 1;
    expect(() => generateSyntheticBars({ ...base, calendar: allDay, days: tooMany })).toThrow(
      /max is/,
    );
  });

  it('property: any seed/options yield structurally valid bars', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0xffffffff }),
        fc.integer({ min: 1, max: 4 }),
        fc.constantFrom(0.01, 0.1, 0.25, 0.5, 1),
        fc.double({ min: 0, max: 1.5, noNaN: true }),
        fc.double({ min: 0, max: 0.05, noNaN: true }),
        fc.double({ min: 0, max: 0.5, noNaN: true }),
        (seed, days, tickSize, annualVolatility, sessionGapVolatility, missingBarProbability) => {
          const { bars } = generateSyntheticBars({
            seed,
            startDate: '2026-10-05',
            days,
            tickSize,
            startPrice: 1000 * tickSize * 10,
            annualVolatility,
            sessionGapVolatility,
            missingBarProbability,
          });
          expect(validateBars(bars, { tickSize })).toEqual([]);
          expect(bars.every((b) => Number.isInteger(b.volume) && b.volume >= 1)).toBe(true);
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe('golden output (seed 20261007, 2026-10-05, 5 days)', () => {
  // If this fails you changed the algorithm: bump SYNTHETIC_GENERATOR_VERSION and
  // update the snapshot deliberately (npx vitest run -u), never silently.
  it('matches the recorded snapshot', () => {
    const { meta, bars } = generateSyntheticBars(base);
    const digest = createHash('sha256').update(JSON.stringify(bars)).digest('hex');
    expect({
      meta,
      count: bars.length,
      first: bars.slice(0, 3),
      last: bars.at(-1),
      high: Math.max(...bars.map((b) => b.high)),
      low: Math.min(...bars.map((b) => b.low)),
      sha256: digest,
    }).toMatchSnapshot();
  });
});
