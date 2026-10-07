// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Bar } from './types.js';
import { isOnTickGrid } from './ticks.js';

export type BarIssueCode =
  | 'non-finite'
  | 'non-positive-price'
  | 'ohlc-inconsistent'
  | 'negative-volume'
  | 'off-tick-grid'
  | 'time-not-increasing'
  | 'time-not-aligned';

export interface BarIssue {
  readonly index: number;
  readonly code: BarIssueCode;
  readonly message: string;
}

export interface ValidateOptions {
  /** If given, every price must sit on this tick grid. */
  readonly tickSize?: number;
  /** Bar length in seconds; times must be multiples of it. Default 60. */
  readonly timeframeSeconds?: number;
}

/**
 * Check structural invariants of a bar series. Returns all issues found (empty array = valid).
 * Shared by the synthetic generator tests now and the CSV importer in M1.
 */
export function validateBars(bars: readonly Bar[], opts: ValidateOptions = {}): BarIssue[] {
  const tf = opts.timeframeSeconds ?? 60;
  const issues: BarIssue[] = [];
  let prevTime = -Infinity;
  bars.forEach((b, index) => {
    const nums = [b.time, b.open, b.high, b.low, b.close, b.volume];
    if (!nums.every(Number.isFinite)) {
      issues.push({ index, code: 'non-finite', message: 'bar contains a non-finite value' });
      return;
    }
    if (b.open <= 0 || b.high <= 0 || b.low <= 0 || b.close <= 0) {
      issues.push({ index, code: 'non-positive-price', message: 'prices must be > 0' });
    }
    if (b.high < Math.max(b.open, b.close) || b.low > Math.min(b.open, b.close) || b.low > b.high) {
      issues.push({
        index,
        code: 'ohlc-inconsistent',
        message: 'low <= open,close <= high violated',
      });
    }
    if (b.volume < 0) {
      issues.push({ index, code: 'negative-volume', message: 'volume must be >= 0' });
    }
    if (opts.tickSize !== undefined) {
      const ts = opts.tickSize;
      if (![b.open, b.high, b.low, b.close].every((p) => isOnTickGrid(p, ts))) {
        issues.push({ index, code: 'off-tick-grid', message: `price not a multiple of ${ts}` });
      }
    }
    if (b.time % tf !== 0) {
      issues.push({ index, code: 'time-not-aligned', message: `time not aligned to ${tf}s` });
    }
    if (b.time <= prevTime) {
      issues.push({ index, code: 'time-not-increasing', message: 'time must strictly increase' });
    }
    prevTime = b.time;
  });
  return issues;
}
