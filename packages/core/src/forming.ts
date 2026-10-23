// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Dual-track forming. The chart reveals a source that is the practice timeframe
// divided by FORMING_PARTS (1m←20s, 5m←100s, 15m←300s, 1h←20m, 1D←8h). Fills stay
// on the practice-timeframe close. There is no separate sub-timeframe to pick.
//
// FORMING_PARTS is the one knob for how many real source bars build a practice
// candle. v1.0.4 used 6; 3 is the slow-play spacing (fewer visual steps, still a build).

import { STANDARD_TIMEFRAMES } from './aggregate.js';

/** Source bars that build one practice bar. practiceSeconds / FORMING_PARTS. */
export const FORMING_PARTS = 3;

/**
 * v1.0.4 datasets (timeframe ÷ 6). New sessions on those files keep the same
 * practice close. Not used for newly generated demos.
 */
const LEGACY_FORMING_SOURCE: ReadonlyMap<number, number> = new Map([
  [10, 60],
  [50, 300],
  [150, 900],
  [600, 3600],
  [14400, 86400],
]);

/**
 * Forming-source length for a practice timeframe. The timeframe must divide evenly
 * by {@link FORMING_PARTS} (every standard practice timeframe does).
 */
export function formingSourceSeconds(practiceTimeframeSeconds: number): number {
  if (
    !Number.isInteger(practiceTimeframeSeconds) ||
    practiceTimeframeSeconds < FORMING_PARTS ||
    practiceTimeframeSeconds % FORMING_PARTS !== 0
  ) {
    throw new RangeError(
      `practice timeframe must be a positive multiple of ${FORMING_PARTS} seconds, got ${practiceTimeframeSeconds}`,
    );
  }
  return practiceTimeframeSeconds / FORMING_PARTS;
}

/**
 * Practice timeframe whose forming source is exactly `sourceSeconds`
 * (20→60, 100→300, 300→900, 1200→3600, 28800→86400), or a v1.0.4 ÷6 pair.
 * Undefined when the spacing is not a forming source.
 */
export function pairedPracticeTimeframe(sourceSeconds: number): number | undefined {
  if (!Number.isInteger(sourceSeconds) || sourceSeconds <= 0) return undefined;
  const exact = STANDARD_TIMEFRAMES.find((tf) => formingSourceSeconds(tf) === sourceSeconds);
  if (exact !== undefined) return exact;
  return LEGACY_FORMING_SOURCE.get(sourceSeconds);
}

/**
 * Practice timeframe to bind when a session is created and the caller did not set one.
 * An exact TF÷{@link FORMING_PARTS} pair wins, including 300s → 15m (three real 5m bars).
 * A v1.0.4 ÷6 pair still wins so those datasets keep their practice close.
 * Any other sub-minute source still fills on 1m closes (V0).
 * A source that is already a practice bar and not a forming source (1m, 15m, 1h, 1D)
 * stays 1:1 — CandleDrill does not invent prices inside a closed bar.
 */
export function defaultPracticeTimeframe(sourceSeconds: number): number | undefined {
  const paired = pairedPracticeTimeframe(sourceSeconds);
  if (paired !== undefined) return paired;
  if (Number.isInteger(sourceSeconds) && sourceSeconds > 0 && sourceSeconds < 60) return 60;
  return undefined;
}

/**
 * Resolve the session practice timeframe.
 * An explicit value must be divisible by the dataset spacing (the source has to land
 * on practice closes). Omitted means {@link defaultPracticeTimeframe}.
 */
export function resolvePracticeTimeframe(
  sourceSeconds: number,
  requested: number | undefined,
): { ok: true; practiceTf: number | undefined } | { ok: false; error: string } {
  if (requested === undefined) {
    return { ok: true, practiceTf: defaultPracticeTimeframe(sourceSeconds) };
  }
  if (
    !Number.isInteger(requested) ||
    !Number.isInteger(sourceSeconds) ||
    sourceSeconds <= 0 ||
    requested % sourceSeconds !== 0
  ) {
    return { ok: false, error: 'dataset timeframe must divide the practice timeframe evenly' };
  }
  return { ok: true, practiceTf: requested };
}

/**
 * Chart menu for a dataset. Standard practice timeframes only (never the forming
 * source when it is shorter than a practice bar), at or above the bound practice
 * timeframe, and only where the source divides the pane so buckets stay aligned.
 */
export function practiceChartTimeframes(
  sourceSeconds: number,
  practiceTf?: number,
): readonly number[] {
  if (!Number.isInteger(sourceSeconds) || sourceSeconds <= 0) return STANDARD_TIMEFRAMES;
  const aligned = STANDARD_TIMEFRAMES.filter(
    (tf) => tf >= sourceSeconds && tf % sourceSeconds === 0,
  );
  const floor = practiceTf !== undefined && aligned.includes(practiceTf) ? practiceTf : aligned[0];
  if (floor === undefined) return STANDARD_TIMEFRAMES;
  return aligned.filter((tf) => tf >= floor);
}

/**
 * Bar lengths the synthetic generator can emit: divisors of one minute (the V0 set,
 * including 20s and 60s) plus TF÷{@link FORMING_PARTS} (100s, 300s, 1200s, 28800s)
 * and the v1.0.4 ÷6 sources (50s, 150s, 600s, 14400s).
 */
export function isSyntheticTimeframe(seconds: number): boolean {
  if (!Number.isInteger(seconds) || seconds <= 0) return false;
  if (60 % seconds === 0) return true;
  return pairedPracticeTimeframe(seconds) !== undefined;
}
