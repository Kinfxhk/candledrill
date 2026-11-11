// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Synthetic intra-bar path. Given a bar's OHLC, a seed and a tick count, produce a
// deterministic Tick[] that starts at open, ends at close, and touches high and low.
//
// This path is invented. Replay never builds one: it only reveals bars the dataset
// already contains. Same seed + same bar + same barIndex => same ticks.

import { createRng, type Rng } from './rng.js';
import { roundToTick } from './orders.js';
import type { Bar } from './types.js';

export const DEFAULT_TICKS_PER_BAR = 24;

export interface Tick {
  readonly time: number;
  readonly price: number;
}

export interface TickPathInput {
  readonly bar: Bar;
  /** uint32 seed. Mixed with barIndex and bar.time so adjacent bars diverge. */
  readonly seed: number;
  readonly barIndex: number;
  /** Length of the bar in seconds. Ticks span [bar.time, bar.time + timeframeSeconds]. */
  readonly timeframeSeconds: number;
  /** Points in the path, including open and close. Default {@link DEFAULT_TICKS_PER_BAR}. */
  readonly ticksPerBar?: number;
  /** When set, interior prices snap to this grid. Endpoints stay the bar's own prices. */
  readonly tickSize?: number;
}

/** uint32 mix. createRng rejects anything outside [0, 2^32-1]. */
export function tickPathSeed(seed: number, barIndex: number, barTime: number): number {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new RangeError(`seed must be an integer in [0, 2^32-1], got ${seed}`);
  }
  const time = Math.floor(barTime);
  const time32 = (time >>> 0) ^ (Math.floor(time / 2 ** 32) >>> 0);
  return (seed ^ Math.imul((barIndex | 0) + 1, 0x9e3779b9) ^ time32) >>> 0;
}

function allocateSteps(distances: readonly number[], totalSteps: number): number[] {
  const positive = distances.map((d) => d > 1e-12);
  const mins = positive.map((p) => (p ? 1 : 0));
  const minSum = mins.reduce((a: number, b) => a + b, 0);
  if (totalSteps < minSum) {
    throw new RangeError(
      `ticksPerBar ${totalSteps + 1} is too small to visit both extremes (need at least ${minSum + 1})`,
    );
  }
  const extra = totalSteps - minSum;
  const weight = distances.reduce((a, b) => a + b, 0);
  const raw = distances.map((d) => (weight > 0 ? (extra * d) / weight : 0));
  const floors = raw.map((x) => Math.floor(x));
  const left = extra - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((x, i) => ({ i, frac: x - floors[i]! }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  const add = floors.slice();
  for (let k = 0; k < left; k++) add[order[k]!.i]!++;
  return mins.map((m, i) => m + add[i]!);
}

function clamp(price: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, price));
}

/** Interior points of a segment. The caller already holds `from`; the last returned price is `to`. */
function walkSegment(
  rng: Rng,
  from: number,
  to: number,
  steps: number,
  low: number,
  high: number,
  tickSize: number | undefined,
): number[] {
  if (steps <= 0) return [];
  const out: number[] = [];
  const span = high - low;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const bridge = from + (to - from) * t;
    const amp = span * Math.sqrt(Math.max(t * (1 - t), 0));
    let price = clamp(bridge + (rng.next() - 0.5) * amp, low, high);
    if (tickSize !== undefined) price = clamp(roundToTick(price, tickSize), low, high);
    out.push(price);
  }
  out.push(to);
  return out;
}

/**
 * Three-segment bridge: open → one extreme → the other extreme → close.
 * Each segment is a clamped random walk. Tick counts follow price distance, and
 * every positive-distance segment gets at least one step so high and low are hit.
 */
export function generateTickPath(input: TickPathInput): Tick[] {
  const { bar } = input;
  const ticksPerBar = input.ticksPerBar ?? DEFAULT_TICKS_PER_BAR;
  const tf = input.timeframeSeconds;
  if (!Number.isInteger(ticksPerBar) || ticksPerBar < 2) {
    throw new RangeError(`ticksPerBar must be an integer >= 2, got ${ticksPerBar}`);
  }
  if (!Number.isFinite(tf) || tf <= 0) {
    throw new RangeError(`timeframeSeconds must be > 0, got ${tf}`);
  }
  if (!Number.isInteger(input.barIndex) || input.barIndex < 0) {
    throw new RangeError(`barIndex must be an integer >= 0, got ${input.barIndex}`);
  }
  const { open, high, low, close } = bar;
  if (![open, high, low, close].every((p) => Number.isFinite(p))) {
    throw new RangeError('bar prices must be finite');
  }
  if (high < low || open < low || open > high || close < low || close > high) {
    throw new RangeError('bar OHLC is inconsistent');
  }

  const times = (n: number): number[] =>
    Array.from({ length: n }, (_, i) =>
      i === n - 1 ? bar.time + tf : bar.time + (tf * i) / (n - 1),
    );

  if (high === low) {
    return times(ticksPerBar).map((time) => ({ time, price: open }));
  }

  const rng = createRng(tickPathSeed(input.seed, input.barIndex, bar.time));
  const highFirst = rng.next() < 0.5;
  const ext1 = highFirst ? high : low;
  const ext2 = highFirst ? low : high;
  const distances = [Math.abs(ext1 - open), Math.abs(ext2 - ext1), Math.abs(close - ext2)];
  const steps = allocateSteps(distances, ticksPerBar - 1);
  const prices = [open];
  let cursor = open;
  const ends = [ext1, ext2, close];
  for (let s = 0; s < 3; s++) {
    const walked = walkSegment(rng, cursor, ends[s]!, steps[s]!, low, high, input.tickSize);
    prices.push(...walked);
    if (walked.length) cursor = walked[walked.length - 1]!;
  }

  const clock = times(prices.length);
  return prices.map((price, i) => ({ time: clock[i]!, price }));
}

/** OHLC of the ticks seen so far. `time` is the bar open, not the latest tick time. */
export function formingBar(time: number, ticks: readonly Tick[], volume = 0): Bar {
  const first = ticks[0];
  if (!first) throw new RangeError('forming bar needs at least one tick');
  let high = first.price;
  let low = first.price;
  for (const tick of ticks) {
    if (tick.price > high) high = tick.price;
    if (tick.price < low) low = tick.price;
  }
  return {
    time,
    open: first.price,
    high,
    low,
    close: ticks[ticks.length - 1]!.price,
    volume,
  };
}
