// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Technical indicators. Pure functions over a bar prefix; no look-ahead.
// The same formulas drive chart overlays and simulated macro conditions.

import { bucketStart, type AggregateOptions } from './aggregate.js';
import type { Bar } from './types.js';

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
  const vwapOpts: AggregateOptions = {
    ...(opts.utcOffsetMinutes !== undefined ? { utcOffsetMinutes: opts.utcOffsetMinutes } : {}),
    dayStartMinutes: opts.anchorMinutes ?? opts.dayStartMinutes ?? 0,
  };
  for (const b of bars) {
    const start = bucketStart(b.time, 86_400, vwapOpts);
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

export interface DonchianResult {
  upper: (number | null)[];
  middle: (number | null)[];
  lower: (number | null)[];
}

/**
 * Donchian channel. Upper is the highest high of the last `period` bars (including the
 * current bar); lower is the lowest low; middle is the midpoint. The first `period - 1`
 * bars are null.
 */
export function donchian(bars: readonly Bar[], period: number): DonchianResult {
  if (period < 1) throw new RangeError('period must be positive');
  const upper: (number | null)[] = [];
  const lower: (number | null)[] = [];
  const middle: (number | null)[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i < period - 1) {
      upper.push(null);
      lower.push(null);
      middle.push(null);
      continue;
    }
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      hh = Math.max(hh, bars[j]!.high);
      ll = Math.min(ll, bars[j]!.low);
    }
    upper.push(hh);
    lower.push(ll);
    middle.push((hh + ll) / 2);
  }
  return { upper, middle, lower };
}

export interface StochResult {
  /** Smoothed %K. */
  k: (number | null)[];
  /** SMA of smoothed %K. */
  d: (number | null)[];
}

function smaNullable(values: readonly (number | null)[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  const window: number[] = [];
  for (const v of values) {
    if (v === null) {
      window.length = 0;
      out.push(null);
      continue;
    }
    window.push(v);
    if (window.length > period) window.shift();
    out.push(window.length === period ? mean(window) : null);
  }
  return out;
}

/**
 * Stochastic oscillator. Raw %K = 100 * (close - lowest low) / (highest high - lowest low)
 * over `kPeriod` bars. Smoothed %K is an SMA of raw %K (`smooth`, use 1 for unsmoothed).
 * %D is an SMA of smoothed %K over `dPeriod`. A zero range yields 50.
 */
export function stochastic(
  bars: readonly Bar[],
  kPeriod: number,
  dPeriod: number,
  smooth = 1,
): StochResult {
  if (kPeriod < 1 || dPeriod < 1 || smooth < 1) throw new RangeError('periods must be positive');
  const raw: (number | null)[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i < kPeriod - 1) {
      raw.push(null);
      continue;
    }
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      hh = Math.max(hh, bars[j]!.high);
      ll = Math.min(ll, bars[j]!.low);
    }
    const close = bars[i]!.close;
    raw.push(hh === ll ? 50 : (100 * (close - ll)) / (hh - ll));
  }
  const k = smaNullable(raw, smooth);
  return { k, d: smaNullable(k, dPeriod) };
}

export interface AdxResult {
  adx: (number | null)[];
  plusDi: (number | null)[];
  minusDi: (number | null)[];
}

/**
 * Wilder ADX / +DI / −DI.
 *
 * +DM is the up-move when it exceeds the down-move and is positive; −DM is the mirror.
 * True range, +DM and −DM are Wilder-smoothed: the seed at index `period` is the sum of
 * the first `period` values (bars 1..period), then sm = sm − sm/period + current.
 * DX = 100 * |+DI − −DI| / (+DI + −DI). The first ADX is the simple average of the first
 * `period` DX values (index `2 * period - 1`); later values use Wilder smoothing.
 */
export function adx(bars: readonly Bar[], period: number): AdxResult {
  if (period < 1) throw new RangeError('period must be positive');
  const n = bars.length;
  const plusDi: (number | null)[] = bars.map(() => null);
  const minusDi: (number | null)[] = bars.map(() => null);
  const adxLine: (number | null)[] = bars.map(() => null);
  if (n <= period) return { adx: adxLine, plusDi, minusDi };

  const tr: number[] = [0];
  const plusDm: number[] = [0];
  const minusDm: number[] = [0];
  for (let i = 1; i < n; i++) {
    const b = bars[i]!;
    const prev = bars[i - 1]!;
    const up = b.high - prev.high;
    const down = prev.low - b.low;
    plusDm.push(up > down && up > 0 ? up : 0);
    minusDm.push(down > up && down > 0 ? down : 0);
    tr.push(Math.max(b.high - b.low, Math.abs(b.high - prev.close), Math.abs(b.low - prev.close)));
  }

  let smTr = 0;
  let smPlus = 0;
  let smMinus = 0;
  for (let i = 1; i <= period; i++) {
    smTr += tr[i]!;
    smPlus += plusDm[i]!;
    smMinus += minusDm[i]!;
  }

  const dx: number[] = bars.map(() => 0);
  const writeDi = (i: number) => {
    if (smTr === 0) {
      plusDi[i] = 0;
      minusDi[i] = 0;
      dx[i] = 0;
      return;
    }
    const pdi = (100 * smPlus) / smTr;
    const mdi = (100 * smMinus) / smTr;
    plusDi[i] = pdi;
    minusDi[i] = mdi;
    const sum = pdi + mdi;
    dx[i] = sum === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / sum;
  };
  writeDi(period);
  for (let i = period + 1; i < n; i++) {
    smTr = smTr - smTr / period + tr[i]!;
    smPlus = smPlus - smPlus / period + plusDm[i]!;
    smMinus = smMinus - smMinus / period + minusDm[i]!;
    writeDi(i);
  }

  const first = 2 * period - 1;
  if (n <= first) return { adx: adxLine, plusDi, minusDi };
  let sumDx = 0;
  for (let i = period; i <= first; i++) sumDx += dx[i]!;
  let prevAdx = sumDx / period;
  adxLine[first] = prevAdx;
  for (let i = first + 1; i < n; i++) {
    prevAdx = (prevAdx * (period - 1) + dx[i]!) / period;
    adxLine[i] = prevAdx;
  }
  return { adx: adxLine, plusDi, minusDi };
}

export interface SessionClock {
  readonly utcOffsetMinutes?: number;
  readonly dayStartMinutes?: number;
  /** Opening-range anchor; when set, ORB uses this instead of dayStartMinutes. */
  readonly anchorMinutes?: number;
}

/** Exchange trading-day key. Same formula as `dayKeyOf` in the session engine. */
export function tradingDayKey(time: number, clock: SessionClock = {}): number {
  const utc = clock.utcOffsetMinutes ?? 0;
  const start = clock.dayStartMinutes ?? 0;
  return Math.floor((time + utc * 60 - start * 60) / 86_400);
}

/** Minutes since the exchange trading-day boundary (0 .. 1439). */
export function minutesIntoSession(time: number, clock: SessionClock = {}): number {
  const utc = clock.utcOffsetMinutes ?? 0;
  const start = clock.dayStartMinutes ?? 0;
  const sec = (((time + utc * 60 - start * 60) % 86_400) + 86_400) % 86_400;
  return Math.floor(sec / 60);
}

/** Exchange-local minute of the civil day (0 .. 1439), ignoring `dayStartMinutes`. */
export function exchangeLocalMinute(time: number, utcOffsetMinutes = 0): number {
  const sec = (((time + utcOffsetMinutes * 60) % 86_400) + 86_400) % 86_400;
  return Math.floor(sec / 60);
}

export interface OrbLevels {
  /** Developing or frozen opening-range high. Null when the day has no range bar yet. */
  high: (number | null)[];
  low: (number | null)[];
  /** True once the current bar is at or after the opening window (range is frozen). */
  complete: boolean[];
}

/**
 * Opening-range high/low for each bar, using only bars up to that index.
 * Bars with `minutesIntoSession < minutes` update a running high/low (the range is still
 * forming). Later bars in the same trading day repeat the frozen high/low and do not
 * widen it. A day that never prints a bar inside the window has null levels.
 */
export function orbLevels(
  bars: readonly Bar[],
  minutes: number,
  clock: SessionClock = {},
): OrbLevels {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1439) {
    throw new RangeError('minutes must be an integer 1-1439');
  }
  // ORB window is anchored to market open, not the daily-loss day boundary.
  const orbClock: SessionClock = {
    ...(clock.utcOffsetMinutes !== undefined ? { utcOffsetMinutes: clock.utcOffsetMinutes } : {}),
    dayStartMinutes: clock.anchorMinutes ?? clock.dayStartMinutes ?? 0,
  };
  const high: (number | null)[] = [];
  const low: (number | null)[] = [];
  const complete: boolean[] = [];
  let day: number | null = null;
  let runHigh = 0;
  let runLow = 0;
  let seen = false;
  let frozen = false;
  let freezeHigh = 0;
  let freezeLow = 0;
  for (const b of bars) {
    const key = tradingDayKey(b.time, orbClock);
    const minute = minutesIntoSession(b.time, orbClock);
    if (day !== key) {
      day = key;
      runHigh = b.high;
      runLow = b.low;
      seen = false;
      frozen = false;
    }
    if (minute < minutes) {
      if (!seen) {
        runHigh = b.high;
        runLow = b.low;
        seen = true;
      } else {
        runHigh = Math.max(runHigh, b.high);
        runLow = Math.min(runLow, b.low);
      }
      high.push(seen ? runHigh : null);
      low.push(seen ? runLow : null);
      complete.push(false);
    } else {
      if (!frozen) {
        frozen = true;
        freezeHigh = runHigh;
        freezeLow = runLow;
      }
      high.push(seen ? freezeHigh : null);
      low.push(seen ? freezeLow : null);
      complete.push(true);
    }
  }
  return { high, low, complete };
}
