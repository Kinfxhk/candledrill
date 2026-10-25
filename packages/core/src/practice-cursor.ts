// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Practice-bar cursor math for chart playback. Frames are produced by calling
// stepSession one source bar at a time — the same function a batch step uses —
// so a later restore is an engine state that already happened. This module does
// not place, modify, or fill orders.

import { bucketStart, type AggregateOptions } from './aggregate.js';
import { stepSession, type SessionSettings, type SessionState } from './session.js';
import type { Bar } from './types.js';

/** How many practice-bar states one open page keeps. The earliest snapshot stays. */
export const TAPE_CAP = 2000;

/**
 * Local replay of one user step stops after this many source bars.
 * The state before the step and the state after it are still kept.
 * 6000 × 20s is a little over a day of demo data.
 */
export const MAX_FRAME_SOURCE_BARS = 6000;

export function practiceAggregateOptions(settings: SessionSettings): AggregateOptions {
  return {
    utcOffsetMinutes: settings.utcOffsetMinutes,
    dayStartMinutes: settings.dayStartMinutes,
    anchorMinutes: settings.anchorMinutes,
  };
}

/** True when `index` is the last source bar of its practice bucket (or every bar is one). */
export function isPracticeClose(
  bars: readonly Bar[],
  index: number,
  settings: SessionSettings,
): boolean {
  if (index < 0 || index >= bars.length) return false;
  const ptf = settings.practiceTimeframeSeconds;
  if (ptf === undefined) return true;
  const opts = practiceAggregateOptions(settings);
  const bucket = bucketStart(bars[index]!.time, ptf, opts);
  const next = bars[index + 1];
  if (!next) return true;
  return bucketStart(next.time, ptf, opts) !== bucket;
}

/**
 * Source cursor at the end of the previous practice bar.
 * Null when `cursor` is already inside the first practice bucket.
 */
export function previousPracticeCursor(
  bars: readonly Bar[],
  cursor: number,
  settings: SessionSettings,
): number | null {
  if (!Number.isInteger(cursor) || cursor <= 0 || cursor >= bars.length) return null;
  const ptf = settings.practiceTimeframeSeconds;
  if (ptf === undefined) return cursor - 1;
  const opts = practiceAggregateOptions(settings);
  const bucket = bucketStart(bars[cursor]!.time, ptf, opts);
  let i = cursor;
  while (i > 0 && bucketStart(bars[i]!.time, ptf, opts) === bucket) i -= 1;
  if (bucketStart(bars[i]!.time, ptf, opts) === bucket) return null;
  return i;
}

/**
 * Engine states at each practice close from `start.cursor` up to `endCursor`,
 * plus the state at `endCursor` when that index is not itself a close.
 * `bars[i]` must be dataset index `i`. An over-long span returns no frames.
 */
export function practiceFrames(
  bars: readonly Bar[],
  settings: SessionSettings,
  start: SessionState,
  endCursor: number,
): SessionState[] {
  if (!Number.isInteger(endCursor) || endCursor <= start.cursor || endCursor >= bars.length)
    return [];
  if (endCursor - start.cursor > MAX_FRAME_SOURCE_BARS) return [];
  const frames: SessionState[] = [];
  let s = start;
  while (s.cursor < endCursor) {
    const next = stepSession(bars, settings, s, 1);
    if (next.state.cursor === s.cursor || next.revealed.length === 0) break;
    s = next.state;
    if (isPracticeClose(bars, s.cursor, settings) || s.cursor === endCursor) frames.push(s);
  }
  return frames;
}

/** Remember `state`. Past the cap, drop the oldest cursors except the earliest one. */
export function noteTape(
  tape: Map<number, SessionState>,
  state: SessionState,
  cap = TAPE_CAP,
): void {
  tape.set(state.cursor, state);
  if (tape.size <= cap) return;
  const oldest = [...tape.keys()].sort((a, b) => a - b);
  const keep = oldest[0];
  if (keep === undefined) return;
  for (const k of oldest) {
    if (tape.size <= cap) break;
    if (k === keep) continue;
    tape.delete(k);
  }
}

/** Drop snapshots that belong to bars after `cursor` (a rewind invalidates them). */
export function forgetTapeAfter(tape: Map<number, SessionState>, cursor: number): void {
  for (const k of [...tape.keys()]) if (k > cursor) tape.delete(k);
}

/** Latest saved state at or before `cursor`, or null. */
export function tapeAtOrBefore(
  tape: ReadonlyMap<number, SessionState>,
  cursor: number,
): SessionState | null {
  let best = -1;
  for (const k of tape.keys()) if (k <= cursor && k > best) best = k;
  if (best < 0) return null;
  return tape.get(best) ?? null;
}

/**
 * Last source index in the chart candle that contains `barTime`, not past `limitCursor`.
 * `barSeconds` is the width of the candle that was clicked.
 */
export function replayCursorForBarTime(
  bars: readonly Bar[],
  limitCursor: number,
  barTime: number,
  barSeconds: number,
  opts: AggregateOptions = {},
): number | null {
  if (!Number.isInteger(barSeconds) || barSeconds <= 0) return null;
  if (!Number.isFinite(barTime) || !Number.isInteger(limitCursor) || limitCursor < 0) return null;
  const bucket = bucketStart(barTime, barSeconds, opts);
  const last = Math.min(limitCursor, bars.length - 1);
  let found = -1;
  for (let i = 0; i <= last; i += 1) {
    if (bucketStart(bars[i]!.time, barSeconds, opts) === bucket) found = i;
  }
  return found >= 0 ? found : null;
}
