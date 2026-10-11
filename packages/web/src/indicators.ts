// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Built-in technical indicators. Pure functions over revealed bars only; no look-ahead.
// Calculations are intentionally simple and standard. They are for visual reference during
// practice, not trading signals.

import { bucketStart, type AggregateOptions } from '@candledrill/core';
import type { Bar } from '@candledrill/core';

export type IndicatorSource = 'open' | 'high' | 'low' | 'close' | 'hlc3';

export function sourceValue(bar: Bar, source: IndicatorSource): number {
  if (source === 'hlc3') return (bar.high + bar.low + bar.close) / 3;
  return bar[source];
}

/** Arithmetic mean of `values`. */
function mean(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Sample standard deviation. */
function stdev(values: readonly number[]): number {
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length);
}

/**
 * Simple Moving Average. Returns an array the same length as `bars`; the first
 * `period - 1` entries are `null`.
 */
export function sma(
  bars: readonly Bar[],
  period: number,
  source: IndicatorSource = 'close',
): (number | null)[] {
  if (period < 1) throw new RangeError('period must be positive');
  const out: (number | null)[] = [];
  const vals: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    vals.push(sourceValue(bars[i]!, source));
    if (vals.length > period) vals.shift();
    out.push(vals.length === period ? mean(vals) : null);
  }
  return out;
}

/**
 * Exponential Moving Average. The first value is seeded with the SMA of the first
 * `period` bars, then EMA = alpha * value + (1 - alpha) * prev, where alpha = 2/(period+1).
 */
export function ema(
  bars: readonly Bar[],
  period: number,
  source: IndicatorSource = 'close',
): (number | null)[] {
  if (period < 1) throw new RangeError('period must be positive');
  const alpha = 2 / (period + 1);
  const out: (number | null)[] = [];
  let prev: number | null = null;
  const vals: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const v = sourceValue(bars[i]!, source);
    vals.push(v);
    if (vals.length > period) vals.shift();
    if (vals.length < period) {
      out.push(null);
      continue;
    }
    if (prev === null) prev = mean(vals);
    else prev = alpha * v + (1 - alpha) * prev;
    out.push(prev);
  }
  return out;
}

export interface BollingerResult {
  upper: (number | null)[];
  middle: (number | null)[];
  lower: (number | null)[];
}

/** Bollinger Bands: middle = SMA(period), upper/lower = middle ± stdDev * stdev. */
export function bollinger(
  bars: readonly Bar[],
  period: number,
  stdDev: number,
  source: IndicatorSource = 'close',
): BollingerResult {
  if (period < 1) throw new RangeError('period must be positive');
  const mid = sma(bars, period, source);
  const upper: (number | null)[] = [];
  const lower: (number | null)[] = [];
  const vals: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    vals.push(sourceValue(bars[i]!, source));
    if (vals.length > period) vals.shift();
    if (vals.length === period && mid[i] !== null) {
      const sd = stdev(vals);
      upper.push(mid[i]! + stdDev * sd);
      lower.push(mid[i]! - stdDev * sd);
    } else {
      upper.push(null);
      lower.push(null);
    }
  }
  return { upper, middle: mid, lower };
}

export interface VwapPoint {
  time: number;
  value: number | null;
}

/**
 * Session VWAP anchored to the exchange trading day. Cumulative typical-price volume
 * divided by cumulative volume, reset when the bar belongs to a new trading day.
 */
export function vwap(bars: readonly Bar[], opts: AggregateOptions = {}): VwapPoint[] {
  const out: VwapPoint[] = [];
  let dayStart: number | null = null;
  let cumPV = 0;
  let cumVol = 0;
  for (const b of bars) {
    const start = bucketStart(b.time, 86_400, opts);
    if (dayStart === null || start !== dayStart) {
      dayStart = start;
      cumPV = 0;
      cumVol = 0;
    }
    const typical = (b.high + b.low + b.close) / 3;
    cumPV += typical * b.volume;
    cumVol += b.volume;
    out.push({ time: b.time, value: cumVol > 0 ? cumPV / cumVol : null });
  }
  return out;
}

/**
 * RSI using Wilder's smoothing. Gain/loss averages are seeded with the simple average
 * of the first `period` changes, then smoothed with alpha = 1/period.
 */
export function rsi(
  bars: readonly Bar[],
  period: number,
  source: IndicatorSource = 'close',
): (number | null)[] {
  if (period < 1) throw new RangeError('period must be positive');
  if (bars.length < period + 1) return bars.map(() => null);
  const changes: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    changes.push(sourceValue(bars[i]!, source) - sourceValue(bars[i - 1]!, source));
  }
  const alpha = 1 / period;
  const out: (number | null)[] = [null];
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < changes.length; i++) {
    const g = Math.max(0, changes[i]!);
    const l = Math.max(0, -changes[i]!);
    if (i < period - 1) {
      out.push(null);
      continue;
    }
    if (i === period - 1) {
      let sg = 0;
      let sl = 0;
      for (let j = 0; j < period; j++) {
        sg += Math.max(0, changes[j]!);
        sl += Math.max(0, -changes[j]!);
      }
      avgGain = sg / period;
      avgLoss = sl / period;
    } else {
      avgGain = alpha * g + (1 - alpha) * avgGain;
      avgLoss = alpha * l + (1 - alpha) * avgLoss;
    }
    if (avgLoss === 0) out.push(avgGain === 0 ? 50 : 100);
    else {
      const rs = avgGain / avgLoss;
      out.push(100 - 100 / (1 + rs));
    }
  }
  return out;
}

export interface MacdResult {
  macd: (number | null)[];
  signal: (number | null)[];
  histogram: (number | null)[];
}

/** MACD = EMA(fast) - EMA(slow); signal = EMA(signalPeriod) of MACD; histogram = difference. */
export function macd(
  bars: readonly Bar[],
  fast: number,
  slow: number,
  signalPeriod: number,
  source: IndicatorSource = 'close',
): MacdResult {
  if (fast < 1 || slow < 1 || signalPeriod < 1) throw new RangeError('periods must be positive');
  const fastEma = ema(bars, fast, source);
  const slowEma = ema(bars, slow, source);
  const macdLine: (number | null)[] = fastEma.map((f, i) =>
    f === null || slowEma[i] === null ? null : f - slowEma[i]!,
  );
  // Build a synthetic Bar array from the MACD line so we can reuse ema().
  const synthetic: Bar[] = macdLine.map((v, i) => ({
    time: bars[i]!.time,
    open: v ?? 0,
    high: v ?? 0,
    low: v ?? 0,
    close: v ?? 0,
    volume: 0,
  }));
  const sig = ema(synthetic, signalPeriod, 'close');
  const signal: (number | null)[] = [];
  const histogram: (number | null)[] = [];
  for (let i = 0; i < macdLine.length; i++) {
    const m = macdLine[i] ?? null;
    const s = sig[i] ?? null;
    signal.push(s);
    histogram.push(m !== null && s !== null ? m - s : null);
  }
  return { macd: macdLine, signal, histogram };
}

/**
 * Average True Range using Wilder's smoothing. True range = max(high-low, |high-prevClose|,
 * |low-prevClose|). The first value is the simple average of the first `period` ranges.
 */
export function atr(bars: readonly Bar[], period: number): (number | null)[] {
  if (period < 1) throw new RangeError('period must be positive');
  const tr: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    const r1 = b.high - b.low;
    if (i === 0) {
      tr.push(r1);
      continue;
    }
    const prevClose = bars[i - 1]!.close;
    tr.push(Math.max(r1, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose)));
  }
  const alpha = 1 / period;
  const out: (number | null)[] = [];
  let prev: number | null = null;
  for (let i = 0; i < tr.length; i++) {
    if (i < period - 1) {
      out.push(null);
      continue;
    }
    if (i === period - 1) {
      let sum = 0;
      for (let j = 0; j < period; j++) sum += tr[j]!;
      prev = sum / period;
    } else {
      prev = alpha * tr[i]! + (1 - alpha) * prev!;
    }
    out.push(prev);
  }
  return out;
}
