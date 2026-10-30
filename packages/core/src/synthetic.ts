// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Deterministic synthetic OHLCV generator (default 1-minute; optional finer bars).
//
// The output is meant to LOOK like an intraday market (volatility clustering,
// U-shaped intraday activity, overnight gaps, tick-rounded prices) so the
// replay UI can be developed and demonstrated without bundling any real market
// data. It is NOT a model of any real instrument and must never be presented as
// one: every symbol is forced to start with "SYNTH-" and metadata marks it synthetic.
// Finer bars (practice timeframe / FORMING_PARTS: 20s, 100s, 300s, …) exist so a
// practice chart can show a real forming candle. They are not a model of tick/trade flow.
// The 1D forming source is 8h. The 08:00–16:30 session holds one of those, so a
// daily demo with no explicit calendar uses a midnight-aligned full day instead
// (three 8h prints, then the daily close). Passing `calendar` leaves it unchanged.

import { createRng } from './rng.js';
import { publicGeneratorSuffix } from './sample-ids.js';
import { DAY_SECONDS } from './aggregate.js';
import {
  FORMING_PARTS,
  demoSessionSeconds,
  formingSourceSeconds,
  isSyntheticTimeframe,
  pairedPracticeTimeframe,
} from './forming.js';
import { expandSessions } from './calendar.js';
import { assertTickSize, tickDecimals, ticksToPrice } from './ticks.js';
import type { Bar, DatasetMeta, SessionCalendar } from './types.js';

export const SYNTHETIC_GENERATOR_NAME = 'candledrill-synthetic';
/**
 * Bump when the price path for a given seed and calendar changes.
 * 1.0.7 changes which calendar an 8h demo uses when `calendar` is omitted.
 * The path inside a session is the same, and the 1-minute series is unchanged.
 */
export const SYNTHETIC_GENERATOR_VERSION = 1;
export const SYNTHETIC_SYMBOL_PREFIX = 'SYNTH-';
/** Hard cap to protect memory on small machines (~3.8 years of 24h minutes). */
export const MAX_SYNTHETIC_BARS = 2_000_000;

/** Generic weekday day session in UTC. Not modelled on any real exchange. */
export const DEFAULT_SYNTHETIC_CALENDAR: SessionCalendar = {
  utcOffsetMinutes: 0,
  windows: [{ days: [1, 2, 3, 4, 5], start: '08:00', end: '16:30' }],
};

/**
 * Weekday session for the 1D forming source (8h). 00:00–24:00 is exactly three
 * 8h bars, and with the default trading-day start (midnight) they share one
 * daily bucket. The 08:00–16:30 session holds only the first of those bars.
 */
export const DAILY_FORMING_CALENDAR: SessionCalendar = {
  utcOffsetMinutes: 0,
  windows: [{ days: [1, 2, 3, 4, 5], start: '00:00', end: '24:00' }],
};

/**
 * Calendar for a synthetic request. An explicit calendar is kept. Otherwise the
 * intraday demo session is used, except for the current 1D forming source, which
 * needs {@link DAILY_FORMING_CALENDAR} so the daily candle can form.
 */
export function syntheticCalendar(
  timeframeSeconds: number,
  calendar: SessionCalendar | undefined,
): SessionCalendar {
  if (calendar) return calendar;
  const practice = pairedPracticeTimeframe(timeframeSeconds);
  // Only the current ÷3 source. A legacy ÷6 file (4h → 1D) keeps the intraday
  // session so an explicit replay of that spacing does not change shape.
  // The stretched window is one midnight-aligned day, which is exactly three 8h
  // bars. A longer practice bar would need its own window.
  if (
    practice !== undefined &&
    formingSourceSeconds(practice) === timeframeSeconds &&
    demoSessionSeconds(practice) === DAY_SECONDS
  ) {
    return DAILY_FORMING_CALENDAR;
  }
  return DEFAULT_SYNTHETIC_CALENDAR;
}

export interface SyntheticOptions {
  /** uint32 seed. Same seed + same options => identical bars. */
  readonly seed: number;
  /** First exchange-local calendar date, "YYYY-MM-DD". */
  readonly startDate: string;
  /** Number of calendar days to cover (weekends/closed days produce no bars). */
  readonly days: number;
  readonly calendar?: SessionCalendar;
  /**
   * Name suffix; the symbol becomes "SYNTH-<name>". Default "DEMO".
   * A retired suffix is rewritten to the public id. The price path does not use this string.
   */
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
  /**
   * Bar length in seconds. Default 60. Either a positive divisor of 60
   * (1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60) or the forming source of a
   * standard practice timeframe (practice / FORMING_PARTS: 100, 300, 1200, 28800;
   * v1.0.4 ÷6 sources 50, 150, 600, 14400 still generate).
   */
  readonly timeframeSeconds?: number;
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
  const timeframeSeconds = options.timeframeSeconds ?? 60;
  const calendar = syntheticCalendar(timeframeSeconds, options.calendar);
  const tickSize = options.tickSize ?? 0.25;
  const startPrice = options.startPrice ?? 4000;
  const annualVol = options.annualVolatility ?? 0.2;
  const gapVol = options.sessionGapVolatility ?? 0.004;
  const missingP = options.missingBarProbability ?? 0;
  const baseVolume = options.baseVolume ?? 400;
  const requestedName = options.name ?? 'DEMO';

  assertTickSize(tickSize);
  checkRange('startPrice', startPrice, tickSize * 10, 1e9);
  checkRange('annualVolatility', annualVol, 0, 3);
  checkRange('sessionGapVolatility', gapVol, 0, 0.2);
  checkRange('missingBarProbability', missingP, 0, 0.5);
  checkRange('baseVolume', baseVolume, 1, 1e9);
  if (!isSyntheticTimeframe(timeframeSeconds)) {
    throw new RangeError(
      `timeframeSeconds must be a positive divisor of 60 or a practice timeframe divided by ${FORMING_PARTS}, got ${timeframeSeconds}`,
    );
  }
  if (!/^[A-Z0-9_-]{1,24}$/.test(requestedName)) {
    throw new RangeError('name must be 1-24 chars of A-Z, 0-9, "_" or "-"');
  }
  const name = publicGeneratorSuffix(requestedName);

  const spans = expandSessions(calendar, options.startDate, options.days);
  const totalMinutes = spans.reduce((n, s) => n + s.minutes, 0);
  // Divisors of 60 keep the original per-minute loop (same bars for the same seed).
  const minuteAligned = 60 % timeframeSeconds === 0;
  const barsPerMinute = minuteAligned ? 60 / timeframeSeconds : 0;
  const totalBars = minuteAligned
    ? totalMinutes * barsPerMinute
    : spans.reduce((n, s) => n + Math.floor((s.minutes * 60) / timeframeSeconds), 0);
  if (totalBars > MAX_SYNTHETIC_BARS) {
    throw new RangeError(`requested ${totalBars} bars, max is ${MAX_SYNTHETIC_BARS}`);
  }

  const rng = createRng(options.seed);
  const decimals = tickDecimals(tickSize);
  const avgSessionMinutes = spans.length ? totalMinutes / spans.length : 1;
  // Per-bar volatility so that one average session ~ one trading day of annual vol.
  const barsPerSession = minuteAligned
    ? avgSessionMinutes * barsPerMinute
    : spans.length
      ? totalBars / spans.length
      : 1;
  const barVol = annualVol / Math.sqrt(TRADING_DAYS_PER_YEAR * barsPerSession);
  // Scale "per minute" base volume down to each finer bar.
  const barBaseVolume = minuteAligned
    ? baseVolume / barsPerMinute
    : (baseVolume * timeframeSeconds) / 60;
  const minTicks = 1;

  let logPrice = Math.log(startPrice);
  let logVolState = 0; // log of the volatility multiplier, mean-reverting to 0
  const bars: Bar[] = [];

  spans.forEach((span, spanIndex) => {
    if (spanIndex > 0 && gapVol > 0) {
      logPrice += gapVol * rng.normal(); // overnight / between-session gap
    }
    const nBars = minuteAligned
      ? span.minutes * barsPerMinute
      : Math.floor((span.minutes * 60) / timeframeSeconds);
    for (let i = 0; i < nBars; i++) {
      const x = nBars > 1 ? i / (nBars - 1) : 0.5;
      logVolState = VOL_PERSISTENCE * logVolState + VOL_OF_VOL * rng.normal();
      const activity = intradayActivity(x);
      const volMultiplier = Math.exp(logVolState - LOG_VOL_VAR);
      const sigma = barVol * activity * volMultiplier;
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
          barBaseVolume *
            activity *
            volMultiplier ** 0.7 *
            Math.exp(0.45 * rng.normal()) *
            (0.6 + 0.25 * rangeInSigmas),
        ),
      );

      const skip = missingP > 0 && rng.next() < missingP;
      if (skip) continue;
      bars.push({
        time: span.startTime + i * timeframeSeconds,
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
      timeframeSeconds,
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
