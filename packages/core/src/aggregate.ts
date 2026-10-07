// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Timeframe aggregation (e.g. 1m -> 5m/15m/60m/daily). Buckets are aligned to the
// exchange-local clock given by a fixed UTC offset; daily bars can start at a custom
// local time (e.g. 17:00 for sessions that cross midnight).

import type { Bar } from './types.js';

export interface AggregateOptions {
  /** Exchange-local offset east of UTC, minutes. Default 0. */
  readonly utcOffsetMinutes?: number;
  /** Local minute-of-day at which a daily bar starts. Default 0 (midnight). */
  readonly dayStartMinutes?: number;
}

export const DAY_SECONDS = 86_400;

/** Common practice timeframes, in seconds. */
export const STANDARD_TIMEFRAMES: readonly number[] = [60, 300, 900, 3600, DAY_SECONDS];

/** Start time (Unix seconds) of the bucket that contains `time`. */
export function bucketStart(
  time: number,
  timeframeSeconds: number,
  opts: AggregateOptions = {},
): number {
  if (!Number.isInteger(timeframeSeconds) || timeframeSeconds <= 0) {
    throw new RangeError(`timeframeSeconds must be a positive integer, got ${timeframeSeconds}`);
  }
  const shift =
    (opts.utcOffsetMinutes ?? 0) * 60 -
    (timeframeSeconds >= DAY_SECONDS ? (opts.dayStartMinutes ?? 0) * 60 : 0);
  return Math.floor((time + shift) / timeframeSeconds) * timeframeSeconds - shift;
}

/**
 * Incremental aggregator. Feed source bars in time order with `push`; it returns the
 * (possibly still forming) target bar that the source bar belongs to. Because it only
 * ever sees bars already pushed, a forming bar never contains future data.
 */
export class BarAggregator {
  private current: Bar | undefined;

  constructor(
    readonly timeframeSeconds: number,
    private readonly opts: AggregateOptions = {},
  ) {
    bucketStart(0, timeframeSeconds); // validates
  }

  push(bar: Bar): { bar: Bar; isNew: boolean } {
    const start = bucketStart(bar.time, this.timeframeSeconds, this.opts);
    const cur = this.current;
    if (cur && start < cur.time) {
      throw new RangeError('bars must be pushed in time order');
    }
    if (!cur || start !== cur.time) {
      this.current = {
        time: start,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
      };
      return { bar: this.current, isNew: true };
    }
    this.current = {
      time: cur.time,
      open: cur.open,
      high: Math.max(cur.high, bar.high),
      low: Math.min(cur.low, bar.low),
      close: bar.close,
      volume: cur.volume + bar.volume,
    };
    return { bar: this.current, isNew: false };
  }

  get last(): Bar | undefined {
    return this.current;
  }
}

/** Aggregate a whole series. `timeframeSeconds` must not be smaller than the source spacing. */
export function aggregateBars(
  bars: readonly Bar[],
  timeframeSeconds: number,
  opts: AggregateOptions = {},
): Bar[] {
  const agg = new BarAggregator(timeframeSeconds, opts);
  const out: Bar[] = [];
  for (const b of bars) {
    const { bar, isNew } = agg.push(b);
    if (isNew) out.push(bar);
    else out[out.length - 1] = bar;
  }
  return out;
}
