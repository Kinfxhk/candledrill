// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { equityCurve, monteCarlo, rDistribution, type Trade } from '../src/index.js';

const trade = (id: number, closeTime: number, netPnl: number, r: number | null = null): Trade =>
  ({ id, closeTime, netPnl, rMultiple: r }) as unknown as Trade;

describe('review analytics', () => {
  it('equity curve adds net results in close-time order', () => {
    const c = equityCurve([trade(2, 200, -50), trade(1, 100, 120), trade(3, 300, 30.555)], 1000);
    expect(c).toEqual([
      { time: 100, equity: 1120 },
      { time: 200, equity: 1070 },
      { time: 300, equity: 1100.56 },
    ]);
  });

  it('R distribution buckets every R-defined trade once and clamps outliers', () => {
    const d = rDistribution([
      trade(1, 1, 0, -1),
      trade(2, 2, 0, 0.2),
      trade(3, 3, 0, 9),
      trade(4, 4, 0, null),
    ]);
    expect(d.n).toBe(3);
    expect(d.buckets.reduce((s, b) => s + b.count, 0)).toBe(3);
    expect(d.buckets.at(-1)!.count).toBe(1); // 9R lands in the top bucket
    expect(d.avgR).toBeCloseTo((-1 + 0.2 + 9) / 3);
  });

  it('Monte Carlo is reproducible and bounded by the real path', () => {
    const pnls = [100, -50, -50, -50, 200, -30, 80];
    const a = monteCarlo(pnls, { runs: 500, seed: 7, limit: 120 });
    const b = monteCarlo(pnls, { runs: 500, seed: 7, limit: 120 });
    expect(a).toEqual(b);
    // All losses in a row is the worst possible order.
    expect(a!.worstRun).toBeLessThanOrEqual(180);
    expect(a!.maxDrawdown.p50).toBeLessThanOrEqual(a!.maxDrawdown.p99);
    expect(a!.breachRate).toBeGreaterThanOrEqual(0);
    expect(monteCarlo([1])).toBeNull();
  });

  it('Monte Carlo drawdown never exceeds the sum of all losses', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -500, max: 500 }), { minLength: 2, maxLength: 40 }),
        fc.nat(),
        (pnls, seed) => {
          const r = monteCarlo(pnls, { runs: 50, seed })!;
          const losses = -pnls.filter((p) => p < 0).reduce((s, p) => s + p, 0);
          expect(r.worstRun).toBeLessThanOrEqual(losses + 1e-9);
          expect(r.maxDrawdown.p50).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 80 },
    );
  });
});
