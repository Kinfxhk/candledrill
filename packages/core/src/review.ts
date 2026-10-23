// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Review analytics from closed trades only (no bars, so nothing can look ahead):
// equity curve by trade, R distribution, and a Monte Carlo of the user's own trade order.
// Monte Carlo results are a simulation of reordering past results, not a forecast.

import { createRng } from './rng.js';
import type { Trade } from './orders.js';

export interface EquityPoint {
  readonly time: number;
  readonly equity: number;
}

/** Equity after each closed trade (net of costs), starting at the starting balance. */
export function equityCurve(trades: readonly Trade[], startingBalance: number): EquityPoint[] {
  const out: EquityPoint[] = [];
  let eq = startingBalance;
  for (const t of [...trades].sort((a, b) => a.closeTime - b.closeTime || a.id - b.id)) {
    eq += t.netPnl;
    out.push({ time: t.closeTime, equity: Math.round(eq * 100) / 100 });
  }
  return out;
}

export interface RBucket {
  /** Lower edge (inclusive) of the bucket, in R. */
  readonly from: number;
  readonly to: number;
  readonly count: number;
}

/** R-multiple histogram with fixed 0.5R buckets from -3R to +5R (outliers in the end buckets). */
export function rDistribution(trades: readonly Trade[]): {
  buckets: RBucket[];
  n: number;
  avgR: number | null;
} {
  const LO = -3;
  const HI = 5;
  const W = 0.5;
  const buckets: RBucket[] = [];
  for (let f = LO; f < HI; f += W) buckets.push({ from: f, to: f + W, count: 0 });
  const rs = trades
    .map((t) => t.rMultiple)
    .filter((r): r is number => r !== null && Number.isFinite(r));
  const counts = buckets.map(() => 0);
  for (const r of rs) {
    const i = Math.min(buckets.length - 1, Math.max(0, Math.floor((r - LO) / W)));
    counts[i]!++;
  }
  return {
    buckets: buckets.map((b, i) => ({ ...b, count: counts[i]! })),
    n: rs.length,
    avgR: rs.length ? rs.reduce((s, r) => s + r, 0) / rs.length : null,
  };
}

export interface MonteCarloResult {
  readonly runs: number;
  readonly trades: number;
  /** Max drawdown (currency) percentiles across runs. */
  readonly maxDrawdown: Readonly<Record<'p50' | 'p90' | 'p95' | 'p99', number>>;
  /** Final net result percentiles (same for every run: reordering keeps the sum). */
  readonly worstRun: number;
  /** Share of runs whose drawdown reached `limit` (null when no limit). */
  readonly breachRate: number | null;
}

/**
 * Shuffle the order of the user's own trade results `runs` times (seeded, reproducible) and
 * report the spread of maximum drawdown. Only the order changes, so the total is fixed; this
 * shows how bad the same results could have felt in a different order.
 */
export function monteCarlo(
  pnls: readonly number[],
  opts: { runs?: number; seed?: number; limit?: number | null } = {},
): MonteCarloResult | null {
  if (pnls.length < 2) return null;
  const runs = Math.max(10, Math.min(20_000, Math.floor(opts.runs ?? 1000)));
  const rng = createRng((opts.seed ?? 1) >>> 0);
  const dds: number[] = [];
  let breaches = 0;
  const arr = [...pnls];
  for (let r = 0; r < runs; r++) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      [arr[i], arr[j]] = [arr[j]!, arr[i]!];
    }
    let eq = 0;
    let peak = 0;
    let dd = 0;
    for (const p of arr) {
      eq += p;
      peak = Math.max(peak, eq);
      dd = Math.max(dd, peak - eq);
    }
    dds.push(dd);
    if (opts.limit && dd >= opts.limit) breaches++;
  }
  dds.sort((a, b) => a - b);
  const q = (p: number) =>
    Math.round(dds[Math.min(dds.length - 1, Math.floor(p * dds.length))]! * 100) / 100;
  return {
    runs,
    trades: pnls.length,
    maxDrawdown: { p50: q(0.5), p90: q(0.9), p95: q(0.95), p99: q(0.99) },
    worstRun: Math.round(dds.at(-1)! * 100) / 100,
    breachRate: opts.limit ? breaches / runs : null,
  };
}
