// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional indicators. Same contract as indicators.ts: pure functions over a bar
// prefix, no look-ahead, null during warm-up. Output[i] is final once it is non-null,
// except Ichimoku Chikou and ZigZag, which may fill a previous null when a later bar
// in the same prefix confirms it — a filled value does not change afterwards.

import { bucketStart, type AggregateOptions } from './aggregate.js';
import { atr, ema, sma, sourceValue, type IndicatorSource } from './indicators.js';
import type { Bar } from './types.js';

function assertPeriod(period: number, min = 1): void {
  if (!Number.isInteger(period) || period < min) {
    throw new RangeError('period must be a positive integer');
  }
}

function assertPositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive`);
}

/** EMA over a series that may start with nulls. Seed matches `ema`: SMA, then alpha = 2/(period+1). */
function emaOf(values: readonly (number | null)[], period: number): (number | null)[] {
  const alpha = 2 / (period + 1);
  const out: (number | null)[] = [];
  const window: number[] = [];
  let prev: number | null = null;
  for (const v of values) {
    if (v === null) {
      window.length = 0;
      prev = null;
      out.push(null);
      continue;
    }
    window.push(v);
    if (window.length > period) window.shift();
    if (window.length < period) {
      out.push(null);
      continue;
    }
    if (prev === null) {
      let sum = 0;
      for (const x of window) sum += x;
      prev = sum / period;
    } else {
      prev = alpha * v + (1 - alpha) * prev;
    }
    out.push(prev);
  }
  return out;
}

/** Linearly weighted moving average. The newest sample has weight `period`. */
function wmaOf(values: readonly (number | null)[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  const window: number[] = [];
  const denom = (period * (period + 1)) / 2;
  for (const v of values) {
    if (v === null) {
      window.length = 0;
      out.push(null);
      continue;
    }
    window.push(v);
    if (window.length > period) window.shift();
    if (window.length < period) {
      out.push(null);
      continue;
    }
    let acc = 0;
    for (let k = 0; k < period; k++) acc += window[k]! * (k + 1);
    out.push(acc / denom);
  }
  return out;
}

function sourceSeries(bars: readonly Bar[], source: IndicatorSource): number[] {
  return bars.map((b) => sourceValue(b, source));
}

export interface BandResult {
  upper: (number | null)[];
  middle: (number | null)[];
  lower: (number | null)[];
}

/**
 * Keltner channel. Middle is EMA(`emaPeriod`); bands are `multiplier` × ATR(`atrPeriod`).
 * A bar is null until both the EMA and the ATR exist.
 */
export function keltner(
  bars: readonly Bar[],
  emaPeriod: number,
  atrPeriod: number,
  multiplier: number,
  source: IndicatorSource = 'close',
): BandResult {
  assertPeriod(emaPeriod);
  assertPeriod(atrPeriod);
  assertPositive(multiplier, 'multiplier');
  const middle = ema(bars, emaPeriod, source);
  const ranges = atr(bars, atrPeriod);
  const upper: (number | null)[] = [];
  const lower: (number | null)[] = [];
  for (let i = 0; i < bars.length; i++) {
    const mid = middle[i] ?? null;
    const range = ranges[i] ?? null;
    if (mid === null || range === null) {
      upper.push(null);
      lower.push(null);
    } else {
      upper.push(mid + multiplier * range);
      lower.push(mid - multiplier * range);
    }
  }
  return { upper, middle, lower };
}

export interface IchimokuResult {
  tenkan: (number | null)[];
  kijun: (number | null)[];
  /** (Tenkan + Kijun) / 2 from `displacement` bars earlier. Not projected past the last bar. */
  senkouA: (number | null)[];
  /** Midpoint of the Senkou period, shifted forward by `displacement` within the array. */
  senkouB: (number | null)[];
  /**
   * Close from `displacement` bars later. Null on the last `displacement` bars, so a prefix
   * never reads a bar it does not contain. A non-null value does not change when the prefix grows.
   */
  chikou: (number | null)[];
}

function donchianMid(bars: readonly Bar[], end: number, period: number): number | null {
  if (end < period - 1) return null;
  let hh = -Infinity;
  let ll = Infinity;
  for (let j = end - period + 1; j <= end; j++) {
    hh = Math.max(hh, bars[j]!.high);
    ll = Math.min(ll, bars[j]!.low);
  }
  return (hh + ll) / 2;
}

/**
 * Ichimoku cloud. Tenkan / Kijun / Senkou B are high-low midpoints of their periods, including
 * the current bar. Senkou spans are shifted forward by `displacement` (default: Kijun period)
 * and therefore use only older bars. Chikou is the close shifted back; the unfinished tail is null.
 */
export function ichimoku(
  bars: readonly Bar[],
  tenkanPeriod = 9,
  kijunPeriod = 26,
  senkouPeriod = 52,
  displacement = kijunPeriod,
): IchimokuResult {
  assertPeriod(tenkanPeriod);
  assertPeriod(kijunPeriod);
  assertPeriod(senkouPeriod);
  assertPeriod(displacement);
  const n = bars.length;
  const tenkan: (number | null)[] = [];
  const kijun: (number | null)[] = [];
  const senkouBRaw: (number | null)[] = [];
  for (let i = 0; i < n; i++) {
    tenkan.push(donchianMid(bars, i, tenkanPeriod));
    kijun.push(donchianMid(bars, i, kijunPeriod));
    senkouBRaw.push(donchianMid(bars, i, senkouPeriod));
  }
  const senkouA: (number | null)[] = [];
  const senkouB: (number | null)[] = [];
  const chikou: (number | null)[] = [];
  for (let i = 0; i < n; i++) {
    const src = i - displacement;
    const t = src >= 0 ? (tenkan[src] ?? null) : null;
    const k = src >= 0 ? (kijun[src] ?? null) : null;
    senkouA.push(t === null || k === null ? null : (t + k) / 2);
    senkouB.push(src >= 0 ? (senkouBRaw[src] ?? null) : null);
    const ahead = i + displacement;
    chikou.push(ahead < n ? bars[ahead]!.close : null);
  }
  return { tenkan, kijun, senkouA, senkouB, chikou };
}

export interface SuperTrendResult {
  line: (number | null)[];
  /** +1 when the line is below price (uptrend), −1 when the line is above price. */
  trend: (1 | -1 | null)[];
}

/**
 * SuperTrend. Bands are HL2 ± multiplier × Wilder ATR, trailed so the upper band only falls
 * and the lower band only rises until price closes through. The first ATR bar seeds a downtrend
 * (line on the upper band), matching the common TradingView seed.
 */
export function supertrend(
  bars: readonly Bar[],
  atrPeriod: number,
  multiplier: number,
): SuperTrendResult {
  assertPeriod(atrPeriod);
  assertPositive(multiplier, 'multiplier');
  const ranges = atr(bars, atrPeriod);
  const line: (number | null)[] = bars.map(() => null);
  const trend: (1 | -1 | null)[] = bars.map(() => null);
  let prevUpper = 0;
  let prevLower = 0;
  let down = true;
  let started = false;
  for (let i = 0; i < bars.length; i++) {
    if (ranges[i] === null) continue;
    const hl2 = (bars[i]!.high + bars[i]!.low) / 2;
    let upper = hl2 + multiplier * ranges[i]!;
    let lower = hl2 - multiplier * ranges[i]!;
    if (!started) {
      line[i] = upper;
      trend[i] = -1;
      prevUpper = upper;
      prevLower = lower;
      down = true;
      started = true;
      continue;
    }
    const prevClose = bars[i - 1]!.close;
    if (!(lower > prevLower || prevClose < prevLower)) lower = prevLower;
    if (!(upper < prevUpper || prevClose > prevUpper)) upper = prevUpper;
    const close = bars[i]!.close;
    down = down ? !(close > upper) : close < lower;
    line[i] = down ? upper : lower;
    trend[i] = down ? -1 : 1;
    prevUpper = upper;
    prevLower = lower;
  }
  return { line, trend };
}

/**
 * Commodity Channel Index. (source − SMA) / (0.015 × mean absolute deviation).
 * A zero deviation is 0. Default source is typical price.
 */
export function cci(
  bars: readonly Bar[],
  period: number,
  source: IndicatorSource = 'hlc3',
): (number | null)[] {
  assertPeriod(period);
  const out: (number | null)[] = [];
  const vals: number[] = [];
  for (const bar of bars) {
    vals.push(sourceValue(bar, source));
    if (vals.length > period) vals.shift();
    if (vals.length < period) {
      out.push(null);
      continue;
    }
    let sum = 0;
    for (const v of vals) sum += v;
    const m = sum / period;
    let dev = 0;
    for (const v of vals) dev += Math.abs(v - m);
    dev /= period;
    const last = vals[vals.length - 1]!;
    out.push(dev === 0 ? 0 : (last - m) / (0.015 * dev));
  }
  return out;
}

/**
 * On-balance volume. The first bar is 0. Later bars add volume when close rises, subtract
 * it when close falls, and hold it when close is unchanged.
 */
export function obv(bars: readonly Bar[]): number[] {
  const out: number[] = [];
  let acc = 0;
  for (let i = 0; i < bars.length; i++) {
    if (i > 0) {
      const close = bars[i]!.close;
      const prev = bars[i - 1]!.close;
      if (close > prev) acc += bars[i]!.volume;
      else if (close < prev) acc -= bars[i]!.volume;
    }
    out.push(acc);
  }
  return out;
}

/** Chaikin Money Flow. Sum of money-flow volume / sum of volume over `period`. Flat bars contribute 0. */
export function cmf(bars: readonly Bar[], period: number): (number | null)[] {
  assertPeriod(period);
  const out: (number | null)[] = [];
  const mfv: number[] = [];
  const vol: number[] = [];
  for (const b of bars) {
    const range = b.high - b.low;
    const mult = range === 0 ? 0 : (b.close - b.low - (b.high - b.close)) / range;
    mfv.push(mult * b.volume);
    vol.push(b.volume);
    if (mfv.length > period) {
      mfv.shift();
      vol.shift();
    }
    if (mfv.length < period) {
      out.push(null);
      continue;
    }
    let sumF = 0;
    let sumV = 0;
    for (let k = 0; k < period; k++) {
      sumF += mfv[k]!;
      sumV += vol[k]!;
    }
    out.push(sumV === 0 ? null : sumF / sumV);
  }
  return out;
}

/**
 * Wilder parabolic SAR. Index 0 is null. Index 1 is the prior bar's low (up) or high (down),
 * chosen by whether bar 1's close is at least bar 0's close. Later values accelerate by `step`
 * toward the extreme, capped at `maxStep`, and flip when price crosses the stop.
 */
export function parabolicSar(bars: readonly Bar[], step = 0.02, maxStep = 0.2): (number | null)[] {
  assertPositive(step, 'step');
  assertPositive(maxStep, 'max step');
  const cap = Math.max(step, maxStep);
  const out: (number | null)[] = bars.map(() => null);
  if (bars.length < 2) return out;
  let trendUp = bars[1]!.close >= bars[0]!.close;
  let sar = trendUp ? bars[0]!.low : bars[0]!.high;
  let ep = trendUp ? bars[1]!.high : bars[1]!.low;
  let af = step;
  out[1] = sar;
  for (let i = 2; i < bars.length; i++) {
    let next = sar + af * (ep - sar);
    const b = bars[i]!;
    const p1 = bars[i - 1]!;
    const p2 = bars[i - 2]!;
    if (trendUp) {
      next = Math.min(next, p1.low, p2.low);
      if (b.low < next) {
        trendUp = false;
        next = ep;
        ep = b.low;
        af = step;
      } else if (b.high > ep) {
        ep = b.high;
        af = Math.min(cap, af + step);
      }
    } else {
      next = Math.max(next, p1.high, p2.high);
      if (b.high > next) {
        trendUp = true;
        next = ep;
        ep = b.high;
        af = step;
      } else if (b.low < ep) {
        ep = b.low;
        af = Math.min(cap, af + step);
      }
    }
    sar = next;
    out[i] = sar;
  }
  return out;
}

/** Williams %R, from −100 to 0. A zero range is −50. The window includes the current bar. */
export function williamsR(bars: readonly Bar[], period: number): (number | null)[] {
  assertPeriod(period);
  const out: (number | null)[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i < period - 1) {
      out.push(null);
      continue;
    }
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      hh = Math.max(hh, bars[j]!.high);
      ll = Math.min(ll, bars[j]!.low);
    }
    out.push(hh === ll ? -50 : (-100 * (hh - bars[i]!.close)) / (hh - ll));
  }
  return out;
}

/**
 * Non-repainting ZigZag. A pivot is written only after price has reversed by `deviationPercent`
 * from that extreme. The line is the straight segment between confirmed pivots; bars after the
 * last confirmed pivot stay null, so the live leg is not drawn and cannot repaint.
 * Percent moves use a positive extreme; a non-positive extreme is not confirmed.
 */
export function zigzag(bars: readonly Bar[], deviationPercent: number): (number | null)[] {
  assertPositive(deviationPercent, 'deviation');
  const thr = deviationPercent / 100;
  const out: (number | null)[] = bars.map(() => null);
  if (bars.length === 0) return out;
  const pivots: { index: number; price: number }[] = [];
  let dir: 1 | -1 | 0 = 0;
  let upI = 0;
  let dnI = 0;
  let upP = bars[0]!.high;
  let dnP = bars[0]!.low;
  let extI = 0;
  let extP = 0;
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]!;
    if (dir === 0) {
      if (b.high > upP) {
        upI = i;
        upP = b.high;
      }
      if (b.low < dnP) {
        dnI = i;
        dnP = b.low;
      }
      if (!(dnP > 0 && (upP - dnP) / dnP >= thr)) continue;
      if (upI >= dnI) {
        pivots.push({ index: dnI, price: dnP });
        dir = 1;
        extI = upI;
        extP = upP;
      } else {
        pivots.push({ index: upI, price: upP });
        dir = -1;
        extI = dnI;
        extP = dnP;
      }
    }
    if (dir === 1) {
      if (b.high >= extP) {
        extP = b.high;
        extI = i;
      }
      if (extP > 0 && (extP - b.low) / extP >= thr) {
        pivots.push({ index: extI, price: extP });
        dir = -1;
        extI = i;
        extP = b.low;
      }
    } else if (dir === -1) {
      if (b.low <= extP) {
        extP = b.low;
        extI = i;
      }
      if (extP > 0 && (b.high - extP) / extP >= thr) {
        pivots.push({ index: extI, price: extP });
        dir = 1;
        extI = i;
        extP = b.high;
      }
    }
  }
  for (let p = 1; p < pivots.length; p++) {
    const a = pivots[p - 1]!;
    const c = pivots[p]!;
    const span = c.index - a.index;
    if (span <= 0) {
      out[c.index] = c.price;
      continue;
    }
    for (let i = a.index; i <= c.index; i++) {
      out[i] = a.price + ((c.price - a.price) * (i - a.index)) / span;
    }
  }
  return out;
}

/** Awesome Oscillator: SMA(median, fast) − SMA(median, slow). Median is (high + low) / 2. */
export function awesomeOscillator(bars: readonly Bar[], fast = 5, slow = 34): (number | null)[] {
  assertPeriod(fast);
  assertPeriod(slow);
  const synthetic: Bar[] = bars.map((b) => {
    const m = (b.high + b.low) / 2;
    return { time: b.time, open: m, high: m, low: m, close: m, volume: 0 };
  });
  const fastSma = sma(synthetic, fast);
  const slowSma = sma(synthetic, slow);
  return fastSma.map((f, i) => (f === null || slowSma[i] === null ? null : f - slowSma[i]!));
}

/** SMA envelope. Upper/lower = middle × (1 ± percent/100). */
export function envelope(
  bars: readonly Bar[],
  period: number,
  percent: number,
  source: IndicatorSource = 'close',
): BandResult {
  assertPeriod(period);
  assertPositive(percent, 'percent');
  const middle = sma(bars, period, source);
  const scale = percent / 100;
  return {
    upper: middle.map((m) => (m === null ? null : m * (1 + scale))),
    middle,
    lower: middle.map((m) => (m === null ? null : m * (1 - scale))),
  };
}

/** DEMA = 2 × EMA − EMA(EMA). The inner EMA uses the same SMA seed as `ema`. */
export function dema(
  bars: readonly Bar[],
  period: number,
  source: IndicatorSource = 'close',
): (number | null)[] {
  assertPeriod(period);
  const e1 = ema(bars, period, source);
  const e2 = emaOf(e1, period);
  return e1.map((v, i) => (v === null || e2[i] === null ? null : 2 * v - e2[i]!));
}

/** TEMA = 3×EMA − 3×EMA(EMA) + EMA(EMA(EMA)). */
export function tema(
  bars: readonly Bar[],
  period: number,
  source: IndicatorSource = 'close',
): (number | null)[] {
  assertPeriod(period);
  const e1 = ema(bars, period, source);
  const e2 = emaOf(e1, period);
  const e3 = emaOf(e2, period);
  return e1.map((v, i) => {
    const a = e2[i] ?? null;
    const b = e3[i] ?? null;
    return v === null || a === null || b === null ? null : 3 * v - 3 * a + b;
  });
}

/** Weighted moving average. Weight 1 is the oldest bar in the window, weight `period` the newest. */
export function wma(
  bars: readonly Bar[],
  period: number,
  source: IndicatorSource = 'close',
): (number | null)[] {
  assertPeriod(period);
  return wmaOf(sourceSeries(bars, source), period);
}

/**
 * Hull moving average. WMA(2×WMA(n/2) − WMA(n), round(sqrt(n))).
 * Half-length uses floor; the square-root length uses the nearest integer, at least 1.
 */
export function hull(
  bars: readonly Bar[],
  period: number,
  source: IndicatorSource = 'close',
): (number | null)[] {
  assertPeriod(period, 2);
  const half = Math.max(1, Math.floor(period / 2));
  const sqrtP = Math.max(1, Math.round(Math.sqrt(period)));
  const src = sourceSeries(bars, source);
  const fast = wmaOf(src, half);
  const slow = wmaOf(src, period);
  const diff = fast.map((f, i) => (f === null || slow[i] === null ? null : 2 * f - slow[i]!));
  return wmaOf(diff, sqrtP);
}

/** Momentum: source[i] − source[i − period]. Null for the first `period` bars. */
export function momentum(
  bars: readonly Bar[],
  period: number,
  source: IndicatorSource = 'close',
): (number | null)[] {
  assertPeriod(period);
  return bars.map((b, i) =>
    i < period ? null : sourceValue(b, source) - sourceValue(bars[i - period]!, source),
  );
}

/**
 * Rate of change, in percent: 100 × (source[i] − source[i − period]) / source[i − period].
 * Null during warm-up and when the older source is 0.
 */
export function roc(
  bars: readonly Bar[],
  period: number,
  source: IndicatorSource = 'close',
): (number | null)[] {
  assertPeriod(period);
  return bars.map((b, i) => {
    if (i < period) return null;
    const prev = sourceValue(bars[i - period]!, source);
    if (prev === 0) return null;
    return (100 * (sourceValue(b, source) - prev)) / prev;
  });
}

export interface AroonResult {
  up: (number | null)[];
  down: (number | null)[];
}

/**
 * Aroon. The window is the current bar plus `period` bars before it. 100 means the extreme
 * is the current bar; 0 means it is `period` bars ago. Ties use the most recent bar.
 */
export function aroon(bars: readonly Bar[], period: number): AroonResult {
  assertPeriod(period);
  const up: (number | null)[] = [];
  const down: (number | null)[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i < period) {
      up.push(null);
      down.push(null);
      continue;
    }
    let highAt = i - period;
    let lowAt = i - period;
    for (let j = i - period; j <= i; j++) {
      if (bars[j]!.high >= bars[highAt]!.high) highAt = j;
      if (bars[j]!.low <= bars[lowAt]!.low) lowAt = j;
    }
    up.push((100 * (period - (i - highAt))) / period);
    down.push((100 * (period - (i - lowAt))) / period);
  }
  return { up, down };
}

export interface VwapBandResult {
  vwap: (number | null)[];
  upper1: (number | null)[];
  lower1: (number | null)[];
  upper2: (number | null)[];
  lower2: (number | null)[];
}

/**
 * Session VWAP with ±1 and ±2 volume-weighted standard-deviation bands of typical price.
 * Resets on the same trading-day boundary as `vwap`. The first bar of a session has zero deviation.
 */
export function vwapBands(bars: readonly Bar[], opts: AggregateOptions = {}): VwapBandResult {
  const vwap: (number | null)[] = [];
  const upper1: (number | null)[] = [];
  const lower1: (number | null)[] = [];
  const upper2: (number | null)[] = [];
  const lower2: (number | null)[] = [];
  let dayStart: number | null = null;
  let cumPV = 0;
  let cumV = 0;
  let cumP2V = 0;
  const vwapOpts: AggregateOptions = {
    ...(opts.utcOffsetMinutes !== undefined ? { utcOffsetMinutes: opts.utcOffsetMinutes } : {}),
    dayStartMinutes: opts.anchorMinutes ?? opts.dayStartMinutes ?? 0,
  };
  for (const b of bars) {
    const start = bucketStart(b.time, 86_400, vwapOpts);
    if (dayStart === null || start !== dayStart) {
      dayStart = start;
      cumPV = 0;
      cumV = 0;
      cumP2V = 0;
    }
    const typical = (b.high + b.low + b.close) / 3;
    cumPV += typical * b.volume;
    cumV += b.volume;
    cumP2V += typical * typical * b.volume;
    if (cumV <= 0) {
      vwap.push(null);
      upper1.push(null);
      lower1.push(null);
      upper2.push(null);
      lower2.push(null);
      continue;
    }
    const mid = cumPV / cumV;
    const variance = Math.max(0, cumP2V / cumV - mid * mid);
    const sd = Math.sqrt(variance);
    vwap.push(mid);
    upper1.push(mid + sd);
    lower1.push(mid - sd);
    upper2.push(mid + 2 * sd);
    lower2.push(mid - 2 * sd);
  }
  return { vwap, upper1, lower1, upper2, lower2 };
}

/**
 * Standard-error bands. Middle is the linear-regression fitted value at the current bar
 * (x = 0 on the oldest bar of the window). Bands are middle ± multiplier × standard error,
 * with SE = sqrt(SSE / (period − 2)). Null until `period` bars exist; period must be at least 3.
 */
export function standardErrorBands(
  bars: readonly Bar[],
  period: number,
  multiplier: number,
  source: IndicatorSource = 'close',
): BandResult {
  assertPeriod(period, 3);
  assertPositive(multiplier, 'multiplier');
  const upper: (number | null)[] = [];
  const middle: (number | null)[] = [];
  const lower: (number | null)[] = [];
  const vals: number[] = [];
  for (const bar of bars) {
    vals.push(sourceValue(bar, source));
    if (vals.length > period) vals.shift();
    if (vals.length < period) {
      upper.push(null);
      middle.push(null);
      lower.push(null);
      continue;
    }
    const n = period;
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumXX = 0;
    for (let i = 0; i < n; i++) {
      const y = vals[i]!;
      sumX += i;
      sumY += y;
      sumXY += i * y;
      sumXX += i * i;
    }
    const den = n * sumXX - sumX * sumX;
    if (den === 0) {
      upper.push(null);
      middle.push(null);
      lower.push(null);
      continue;
    }
    const slope = (n * sumXY - sumX * sumY) / den;
    const intercept = (sumY - slope * sumX) / n;
    const fitted = intercept + slope * (n - 1);
    let sse = 0;
    for (let i = 0; i < n; i++) {
      const yhat = intercept + slope * i;
      sse += (vals[i]! - yhat) ** 2;
    }
    const se = Math.sqrt(sse / (n - 2));
    middle.push(fitted);
    upper.push(fitted + multiplier * se);
    lower.push(fitted - multiplier * se);
  }
  return { upper, middle, lower };
}

/**
 * Balance of Power, smoothed with an SMA of `period`. Raw value is (close − open) / (high − low);
 * a flat bar is 0.
 */
export function balanceOfPower(bars: readonly Bar[], period: number): (number | null)[] {
  assertPeriod(period);
  const out: (number | null)[] = [];
  const window: number[] = [];
  for (const b of bars) {
    const range = b.high - b.low;
    const raw = range === 0 ? 0 : (b.close - b.open) / range;
    window.push(raw);
    if (window.length > period) window.shift();
    if (window.length < period) {
      out.push(null);
      continue;
    }
    let sum = 0;
    for (const v of window) sum += v;
    out.push(sum / period);
  }
  return out;
}

export interface KdjResult {
  k: (number | null)[];
  d: (number | null)[];
  j: (number | null)[];
}

/**
 * KDJ. RSV is the stochastic raw %K over `period` (a zero range is 50). K and D use the
 * classic 1/3 smoother, seeded with the first RSV. J = 3K − 2D and is not clipped.
 */
export function kdj(bars: readonly Bar[], period: number): KdjResult {
  assertPeriod(period);
  const k: (number | null)[] = [];
  const d: (number | null)[] = [];
  const j: (number | null)[] = [];
  let prevK: number | null = null;
  let prevD: number | null = null;
  for (let i = 0; i < bars.length; i++) {
    if (i < period - 1) {
      k.push(null);
      d.push(null);
      j.push(null);
      continue;
    }
    let hh = -Infinity;
    let ll = Infinity;
    for (let t = i - period + 1; t <= i; t++) {
      hh = Math.max(hh, bars[t]!.high);
      ll = Math.min(ll, bars[t]!.low);
    }
    const rsv = hh === ll ? 50 : (100 * (bars[i]!.close - ll)) / (hh - ll);
    const nextK: number = prevK === null ? rsv : (2 / 3) * prevK + (1 / 3) * rsv;
    const nextD: number = prevD === null ? nextK : (2 / 3) * prevD + (1 / 3) * nextK;
    prevK = nextK;
    prevD = nextD;
    k.push(nextK);
    d.push(nextD);
    j.push(3 * nextK - 2 * nextD);
  }
  return { k, d, j };
}

/** Volume-weighted moving average. Null during warm-up and when the window's volume is 0. */
export function vwma(
  bars: readonly Bar[],
  period: number,
  source: IndicatorSource = 'close',
): (number | null)[] {
  assertPeriod(period);
  const out: (number | null)[] = [];
  const pv: number[] = [];
  const vol: number[] = [];
  for (const b of bars) {
    pv.push(sourceValue(b, source) * b.volume);
    vol.push(b.volume);
    if (pv.length > period) {
      pv.shift();
      vol.shift();
    }
    if (pv.length < period) {
      out.push(null);
      continue;
    }
    let sumPV = 0;
    let sumV = 0;
    for (let k = 0; k < period; k++) {
      sumPV += pv[k]!;
      sumV += vol[k]!;
    }
    out.push(sumV === 0 ? null : sumPV / sumV);
  }
  return out;
}

/**
 * Price channel of the previous `period` bars, excluding the current bar.
 * Unlike Donchian, a breakout bar does not widen the channel it is breaking.
 */
export function priceChannel(bars: readonly Bar[], period: number): BandResult {
  assertPeriod(period);
  const upper: (number | null)[] = [];
  const middle: (number | null)[] = [];
  const lower: (number | null)[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i < period) {
      upper.push(null);
      middle.push(null);
      lower.push(null);
      continue;
    }
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - period; j < i; j++) {
      hh = Math.max(hh, bars[j]!.high);
      ll = Math.min(ll, bars[j]!.low);
    }
    upper.push(hh);
    lower.push(ll);
    middle.push((hh + ll) / 2);
  }
  return { upper, middle, lower };
}

export interface ElderRayResult {
  bull: (number | null)[];
  bear: (number | null)[];
}

/** Elder Ray. Bull power = high − EMA(source); bear power = low − EMA(source). */
export function elderRay(
  bars: readonly Bar[],
  period: number,
  source: IndicatorSource = 'close',
): ElderRayResult {
  assertPeriod(period);
  const basis = ema(bars, period, source);
  const bull: (number | null)[] = [];
  const bear: (number | null)[] = [];
  for (let i = 0; i < bars.length; i++) {
    const e = basis[i] ?? null;
    if (e === null) {
      bull.push(null);
      bear.push(null);
    } else {
      bull.push(bars[i]!.high - e);
      bear.push(bars[i]!.low - e);
    }
  }
  return { bull, bear };
}
