// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Review analytics from closed trades only (no bars, so nothing can look ahead):
// equity curve by trade, R distribution, and a Monte Carlo of the user's own trades
// (order shuffle or bootstrap resampling with replacement).
// Monte Carlo results are a simulation of past results, not a forecast.

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

export type MonteCarloMode = 'shuffle' | 'bootstrap';

export interface MonteCarloResult {
  readonly mode: MonteCarloMode;
  readonly runs: number;
  readonly trades: number;
  /** Max drawdown (currency) percentiles across runs. */
  readonly maxDrawdown: Readonly<Record<'p50' | 'p90' | 'p95' | 'p99', number>>;
  /** Final net P&L percentiles across runs (constant in shuffle mode, spread in bootstrap). */
  readonly finalPnl: Readonly<Record<'p05' | 'p50' | 'p95', number>>;
  /** Worst drawdown observed across all runs. */
  readonly worstRun: number;
  /** Share of runs whose drawdown reached `limit` (null when no limit). */
  readonly breachRate: number | null;
}

/**
 * Run a seeded, reproducible Monte Carlo over the user's closed-trade net P&Ls.
 * - `shuffle` (default): permutes trade order without replacement (same total P&L, order risk only).
 * - `bootstrap`: samples trades with replacement, exposing final-P&L confidence intervals and ruin risk.
 */
export function monteCarlo(
  pnls: readonly number[],
  opts: { runs?: number; seed?: number; limit?: number | null; mode?: MonteCarloMode } = {},
): MonteCarloResult | null {
  if (pnls.length < 2) return null;
  const mode: MonteCarloMode = opts.mode === 'bootstrap' ? 'bootstrap' : 'shuffle';
  const runs = Math.max(10, Math.min(20_000, Math.floor(opts.runs ?? 1000)));
  const rng = createRng((opts.seed ?? 1) >>> 0);
  const dds: number[] = [];
  const finals: number[] = [];
  let breaches = 0;
  const arr = [...pnls];
  const n = pnls.length;
  for (let r = 0; r < runs; r++) {
    let eq = 0;
    let peak = 0;
    let dd = 0;
    if (mode === 'bootstrap') {
      for (let i = 0; i < n; i++) {
        const p = pnls[Math.floor(rng.next() * n)]!;
        eq += p;
        peak = Math.max(peak, eq);
        dd = Math.max(dd, peak - eq);
      }
    } else {
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(rng.next() * (i + 1));
        [arr[i], arr[j]] = [arr[j]!, arr[i]!];
      }
      for (const p of arr) {
        eq += p;
        peak = Math.max(peak, eq);
        dd = Math.max(dd, peak - eq);
      }
    }
    dds.push(dd);
    finals.push(eq);
    if (opts.limit && dd >= opts.limit) breaches++;
  }
  dds.sort((a, b) => a - b);
  finals.sort((a, b) => a - b);
  const q = (sorted: number[], p: number) =>
    Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]! * 100) / 100;
  return {
    mode,
    runs,
    trades: n,
    maxDrawdown: {
      p50: q(dds, 0.5),
      p90: q(dds, 0.9),
      p95: q(dds, 0.95),
      p99: q(dds, 0.99),
    },
    finalPnl: {
      p05: q(finals, 0.05),
      p50: q(finals, 0.5),
      p95: q(finals, 0.95),
    },
    worstRun: Math.round(dds.at(-1)! * 100) / 100,
    breachRate: opts.limit ? breaches / runs : null,
  };
}
