// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Deterministic synthetic 1-minute OHLCV generator.
//
// The output is meant to LOOK like an intraday market (volatility clustering,
// U-shaped intraday activity, overnight gaps, tick-rounded prices) so the
// replay UI can be developed and demonstrated without bundling any real market
// data. It is NOT a model of any real instrument and must never be presented as
// one: every symbol is forced to start with "SYNTH-" and metadata marks it synthetic.

import { createRng } from './rng.js';
import { expandSessions } from './calendar.js';
import { assertTickSize, tickDecimals, ticksToPrice } from './ticks.js';
import type { Bar, DatasetMeta, SessionCalendar } from './types.js';

export const SYNTHETIC_GENERATOR_NAME = 'candledrill-synthetic';
/** Bump when the algorithm changes in a way that alters output for the same seed. */
export const SYNTHETIC_GENERATOR_VERSION = 1;
export const SYNTHETIC_SYMBOL_PREFIX = 'SYNTH-';
/** Hard cap to protect memory on small machines (~3.8 years of 24h minutes). */
export const MAX_SYNTHETIC_BARS = 2_000_000;

/** Generic weekday day session in UTC. Not modelled on any real exchange. */
export const DEFAULT_SYNTHETIC_CALENDAR: SessionCalendar = {
  utcOffsetMinutes: 0,
  windows: [{ days: [1, 2, 3, 4, 5], start: '08:00', end: '16:30' }],
};

export interface SyntheticOptions {
  /** uint32 seed. Same seed + same options => identical bars. */
  readonly seed: number;
  /** First exchange-local calendar date, "YYYY-MM-DD". */
  readonly startDate: string;
  /** Number of calendar days to cover (weekends/closed days produce no bars). */
  readonly days: number;
  readonly calendar?: SessionCalendar;
  /** Name suffix; the symbol becomes "SYNTH-<name>". Default "DEMO". */
  readonly name?: string;
  readonly tickSize?: number;
  readonly startPrice?: number;
  /** Annualised volatility as a fraction (0.2 = 20%). */
  readonly annualVolatility?: number;
  /** Standard deviation of the log-gap between sessions, as a fraction. */
  readonly sessionGapVolatility?: number;
  /** Probability that a minute has no trades and therefore no bar (0-0.5). */
  readonly missingBarProbability?: number;
  /** Typical contracts per minute at mid-session. */
  readonly baseVolume?: number;
}

export interface SyntheticDataset {
  readonly meta: DatasetMeta;
  readonly bars: Bar[];
}

const SUBSTEPS = 8; // intra-minute path points used to derive high/low
const VOL_PERSISTENCE = 0.995; // AR(1) coefficient of log-volatility (clustering)
const VOL_OF_VOL = 0.03;
// Stationary variance of the log-vol AR(1); used so that E[multiplier^2] = 1 (keeps the
// requested annual volatility on average while still clustering).
const LOG_VOL_VAR = (VOL_OF_VOL * VOL_OF_VOL) / (1 - VOL_PERSISTENCE * VOL_PERSISTENCE);
const TRADING_DAYS_PER_YEAR = 252;

function checkRange(name: string, v: number, min: number, max: number): void {
  if (!Number.isFinite(v) || v < min || v > max) {
    throw new RangeError(`${name} must be within [${min}, ${max}], got ${v}`);
  }
}

/** U-shaped intraday activity profile; x in [0,1] is the position within the session. */
export function intradayActivity(x: number): number {
  const u = 2 * x - 1;
  return 0.65 + 0.9 * u * u + 0.35 * Math.exp(-x * 25); // extra burst right after the open
}

export function generateSyntheticBars(options: SyntheticOptions): SyntheticDataset {
  const calendar = options.calendar ?? DEFAULT_SYNTHETIC_CALENDAR;
  const tickSize = options.tickSize ?? 0.25;
  const startPrice = options.startPrice ?? 4000;
  const annualVol = options.annualVolatility ?? 0.2;
  const gapVol = options.sessionGapVolatility ?? 0.004;
  const missingP = options.missingBarProbability ?? 0;
  const baseVolume = options.baseVolume ?? 400;
  const name = options.name ?? 'DEMO';

  assertTickSize(tickSize);
  checkRange('startPrice', startPrice, tickSize * 10, 1e9);
  checkRange('annualVolatility', annualVol, 0, 3);
  checkRange('sessionGapVolatility', gapVol, 0, 0.2);
  checkRange('missingBarProbability', missingP, 0, 0.5);
  checkRange('baseVolume', baseVolume, 1, 1e9);
  if (!/^[A-Z0-9_-]{1,24}$/.test(name)) {
    throw new RangeError('name must be 1-24 chars of A-Z, 0-9, "_" or "-"');
  }

  const spans = expandSessions(calendar, options.startDate, options.days);
  const totalMinutes = spans.reduce((n, s) => n + s.minutes, 0);
  if (totalMinutes > MAX_SYNTHETIC_BARS) {
    throw new RangeError(`requested ${totalMinutes} bars, max is ${MAX_SYNTHETIC_BARS}`);
  }

  const rng = createRng(options.seed);
  const decimals = tickDecimals(tickSize);
  const avgSessionMinutes = spans.length ? totalMinutes / spans.length : 1;
  // Per-minute volatility so that one average session ~ one trading day.
  const minuteVol = annualVol / Math.sqrt(TRADING_DAYS_PER_YEAR * avgSessionMinutes);
  const minTicks = 1;

  let logPrice = Math.log(startPrice);
  let logVolState = 0; // log of the volatility multiplier, mean-reverting to 0
  const bars: Bar[] = [];

  spans.forEach((span, spanIndex) => {
    if (spanIndex > 0 && gapVol > 0) {
      logPrice += gapVol * rng.normal(); // overnight / between-session gap
    }
    for (let i = 0; i < span.minutes; i++) {
      const x = span.minutes > 1 ? i / (span.minutes - 1) : 0.5;
      logVolState = VOL_PERSISTENCE * logVolState + VOL_OF_VOL * rng.normal();
      const activity = intradayActivity(x);
      const volMultiplier = Math.exp(logVolState - LOG_VOL_VAR);
      const sigma = minuteVol * activity * volMultiplier;
      const subSigma = sigma / Math.sqrt(SUBSTEPS);

      const openTicks = Math.max(minTicks, Math.round(Math.exp(logPrice) / tickSize));
      let hi = openTicks;
      let lo = openTicks;
      let lp = logPrice;
      for (let k = 0; k < SUBSTEPS; k++) {
        lp += subSigma * rng.normal() - 0.5 * subSigma * subSigma;
        const t = Math.max(minTicks, Math.round(Math.exp(lp) / tickSize));
        if (t > hi) hi = t;
        if (t < lo) lo = t;
      }
      logPrice = lp;
      const closeTicks = Math.max(minTicks, Math.round(Math.exp(logPrice) / tickSize));
      hi = Math.max(hi, closeTicks);
      lo = Math.min(lo, closeTicks);

      // Volume: U-shaped, noisy, and higher on larger moves.
      const rangeInSigmas = sigma > 0 ? ((hi - lo) * tickSize) / Math.exp(logPrice) / sigma : 0;
      const volume = Math.max(
        1,
        Math.round(
          baseVolume *
            activity *
            volMultiplier ** 0.7 *
            Math.exp(0.45 * rng.normal()) *
            (0.6 + 0.25 * rangeInSigmas),
        ),
      );

      const skip = missingP > 0 && rng.next() < missingP;
      if (skip) continue;
      bars.push({
        time: span.startTime + i * 60,
        open: ticksToPrice(openTicks, tickSize, decimals),
        high: ticksToPrice(hi, tickSize, decimals),
        low: ticksToPrice(lo, tickSize, decimals),
        close: ticksToPrice(closeTicks, tickSize, decimals),
        volume,
      });
    }
  });

  return {
    meta: {
      source: 'synthetic',
      synthetic: true,
      symbol: `${SYNTHETIC_SYMBOL_PREFIX}${name}`,
      timeframeSeconds: 60,
      tickSize,
      generator: {
        name: SYNTHETIC_GENERATOR_NAME,
        version: SYNTHETIC_GENERATOR_VERSION,
        seed: options.seed,
      },
    },
    bars,
  };
}
