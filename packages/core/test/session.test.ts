// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  createSession,
  generateSyntheticBars,
  initialCursor,
  jumpSession,
  stepSession,
  stepsUntil,
  visibleBars,
  type SessionSettings,
} from '../src/index.js';

export const SETTINGS: SessionSettings = {
  symbol: 'SYNTH-DEMO',
  tickSize: 0.25,
  pointValue: 50,
  commissionPerContract: 2,
  slippageTicks: 1,
  startingBalance: 50_000,
  dailyLossLimit: null,
  trailingDrawdown: null,
  profitTarget: null,
  utcOffsetMinutes: 0,
  dayStartMinutes: 0,
};

const ds = generateSyntheticBars({ seed: 5, startDate: '2026-10-05', days: 3 });
const bars = ds.bars;

describe('replay cursor', () => {
  it('starts just before the requested time and keeps a bar to replay', () => {
    const t = bars[100]!.time;
    expect(initialCursor(bars, t)).toBe(99);
    expect(initialCursor(bars, t + 1)).toBe(100);
    expect(initialCursor(bars, 0)).toBe(0);
    expect(initialCursor(bars, Number.MAX_SAFE_INTEGER)).toBe(bars.length - 2);
    expect(() => initialCursor(bars.slice(0, 1), 0)).toThrow(RangeError);
  });

  it('visibleBars is exactly the prefix up to the cursor', () => {
    expect(visibleBars(bars, 9)).toEqual(bars.slice(0, 10));
    expect(stepsUntil(bars, 5, bars[20]!.time)).toBe(15);
    expect(stepsUntil(bars, 5, bars[2]!.time)).toBe(0);
  });
});

describe('session stepping', () => {
  it('steps, finishes at the end and validates counts', () => {
    let s = createSession(bars, SETTINGS, bars[10]!.time);
    expect(s.cursor).toBe(9);
    const r = stepSession(bars, SETTINGS, s, 3);
    expect(r.revealed).toEqual(bars.slice(10, 13));
    s = r.state;
    expect(s.cursor).toBe(12);
    const end = stepSession(bars, SETTINGS, s, 500_000);
    expect(end.state.status).toBe('finished');
    expect(end.state.cursor).toBe(bars.length - 1);
    expect(() => stepSession(bars, SETTINGS, s, 0)).toThrow(RangeError);
  });

  it('jumps forward only', () => {
    const s = createSession(bars, SETTINGS, bars[10]!.time);
    const j = jumpSession(bars, SETTINGS, s, bars[200]!.time);
    expect(bars[j.state.cursor]!.time).toBe(bars[200]!.time);
    expect(j.revealed).toHaveLength(191);
    const back = jumpSession(bars, SETTINGS, j.state, bars[5]!.time);
    expect(back.state).toBe(j.state);
    expect(back.revealed).toHaveLength(0);
  });

  it('rejects invalid settings', () => {
    expect(() => createSession(bars, { ...SETTINGS, tickSize: 0 }, bars[5]!.time)).toThrow(
      /tickSize/,
    );
    expect(() => createSession(bars, { ...SETTINGS, dailyLossLimit: -1 }, bars[5]!.time)).toThrow(
      /dailyLossLimit/,
    );
  });

  it('property: replay never depends on unrevealed bars', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: bars.length - 3 }),
        fc.array(fc.integer({ min: 1, max: 40 }), { minLength: 1, maxLength: 20 }),
        (start, steps) => {
          let full = createSession(bars, SETTINGS, bars[start + 1]!.time);
          let seen = full.cursor;
          for (const n of steps) {
            const r = stepSession(bars, SETTINGS, full, n);
            full = r.state;
            for (const b of r.revealed) expect(b.time).toBeLessThanOrEqual(bars[full.cursor]!.time);
            seen = full.cursor;
          }
          // Replaying the same actions on a series truncated right after the cursor gives
          // the same cursor: nothing beyond what was revealed influenced the state.
          const cut = bars.slice(0, seen + 2);
          let trunc = createSession(cut, SETTINGS, bars[start + 1]!.time);
          for (const n of steps) trunc = stepSession(cut, SETTINGS, trunc, n).state;
          expect(trunc.cursor).toBe(Math.min(full.cursor, cut.length - 1));
        },
      ),
      { numRuns: 80 },
    );
  });
});
