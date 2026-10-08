// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Blind practice: the session runs on a disguised copy of the bars so the trader cannot
// recognise the period or the price level.
//
// - Time is shifted by a whole number of weeks, so the weekday, the time of day and every
//   trading-day boundary stay exactly the same (fixed UTC offset, no daylight saving).
// - Prices are shifted by a whole number of ticks, so every distance in ticks, every fill
//   rule and every P&L number is identical to a session on the real prices.
//
// The engine itself never knows: it simply receives other bars. Randomness is injected
// (the server passes a crypto-backed source) to keep this module pure and testable.

import type { Bar } from './types.js';
import { tickDecimals } from './ticks.js';

export const WEEK_SECONDS = 7 * 86_400;
/** Smallest / largest time shift in weeks (about 5 to 30 years). */
export const BLIND_MIN_WEEKS = 260;
export const BLIND_MAX_WEEKS = 1560;
/** Shown instead of the symbol while a blind session is not revealed. */
export const BLIND_SYMBOL = 'BLIND';

export interface BlindParams {
  /** Seconds added to every bar time; a non-zero multiple of WEEK_SECONDS. */
  readonly timeShift: number;
  /** Added to every price; an integer number of ticks. */
  readonly priceOffset: number;
}

/** Uniform random number in [0, 1). */
export type RandomSource = () => number;

function priceFix(tickSize: number): (p: number) => number {
  const digits = Math.min(12, tickDecimals(tickSize) + 4);
  return (p) => Number(p.toFixed(digits));
}

export function disguiseBars(bars: readonly Bar[], p: BlindParams, tickSize: number): Bar[] {
  const fix = priceFix(tickSize);
  return bars.map((b) => ({
    time: b.time + p.timeShift,
    open: fix(b.open + p.priceOffset),
    high: fix(b.high + p.priceOffset),
    low: fix(b.low + p.priceOffset),
    close: fix(b.close + p.priceOffset),
    volume: b.volume,
  }));
}

/** Map a disguised time / price back to the real one (used for the reveal). */
export function revealTime(time: number, p: BlindParams): number {
  return time - p.timeShift;
}
export function revealPrice(price: number, p: BlindParams, tickSize: number): number {
  return priceFix(tickSize)(price - p.priceOffset);
}

/** Problems with stored blind parameters (empty = valid). */
export function blindIssues(p: BlindParams, bars: readonly Bar[], tickSize: number): string[] {
  const out: string[] = [];
  if (!Number.isSafeInteger(p.timeShift) || p.timeShift === 0 || p.timeShift % WEEK_SECONDS !== 0)
    out.push('timeShift must be a non-zero whole number of weeks');
  const ticks = p.priceOffset / tickSize;
  if (!Number.isFinite(p.priceOffset) || Math.abs(ticks - Math.round(ticks)) > 1e-6)
    out.push('priceOffset must be a whole number of ticks');
  if (bars.length) {
    let minLow = Infinity;
    for (const b of bars) minLow = Math.min(minLow, b.low);
    if (minLow + p.priceOffset <= 0) out.push('priceOffset would make prices non-positive');
    if (bars[0]!.time + p.timeShift <= 0) out.push('timeShift would make times negative');
  }
  return out;
}

/**
 * Pick disguise parameters. The price level is moved to between 0.5x and 2x of the
 * typical price, never by less than 5% of it, and the lowest disguised low stays above
 * a quarter of the typical price.
 */
export function pickBlindParams(
  bars: readonly Bar[],
  tickSize: number,
  random: RandomSource,
): BlindParams {
  if (bars.length === 0) throw new RangeError('no bars');
  const weeks = BLIND_MIN_WEEKS + Math.floor(random() * (BLIND_MAX_WEEKS - BLIND_MIN_WEEKS + 1));
  let timeShift = weeks * WEEK_SECONDS * (random() < 0.5 ? -1 : 1);
  if (bars[0]!.time + timeShift <= 0) timeShift = -timeShift;

  let minLow = Infinity;
  let sum = 0;
  for (const b of bars) {
    minLow = Math.min(minLow, b.low);
    sum += b.close;
  }
  const ref = sum / bars.length;
  let offset = 0;
  for (let attempt = 0; attempt < 32; attempt++) {
    const factor = 0.5 + random() * 1.5; // target level 0.5x .. 2x
    const raw = ref * (factor - 1);
    if (Math.abs(raw) < ref * 0.05) continue;
    const candidate = Math.round(raw / tickSize) * tickSize;
    if (minLow + candidate > ref * 0.25) {
      offset = candidate;
      break;
    }
  }
  if (offset === 0) offset = Math.max(tickSize, Math.round((ref * 0.37) / tickSize) * tickSize);
  return { timeShift, priceOffset: Number(offset.toFixed(tickDecimals(tickSize))) };
}

/**
 * Pick a random start bar index that leaves history before it and bars to trade after it:
 * between 20% and 80% of the series (or the middle third for very short series).
 */
export function pickBlindStartIndex(barCount: number, random: RandomSource): number {
  if (barCount < 3) throw new RangeError('need at least 3 bars');
  const lo = Math.max(1, Math.floor(barCount * 0.2));
  const hi = Math.max(lo, Math.min(barCount - 2, Math.floor(barCount * 0.8)));
  return lo + Math.floor(random() * (hi - lo + 1));
}
