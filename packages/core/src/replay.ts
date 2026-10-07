// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Replay cursor helpers. The cursor is the index of the LAST bar the user may see.
// Everything shown to the user must come from `visibleBars`, which never includes a bar
// after the cursor ("no future leak").

import type { Bar } from './types.js';

/** First visible cursor for a replay that starts at `startTime` (Unix seconds). */
export function initialCursor(bars: readonly Bar[], startTime: number): number {
  if (bars.length < 2) throw new RangeError('need at least two bars to replay');
  let lo = 0;
  let hi = bars.length - 1;
  let idx = 0; // at least one bar of history is always visible
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.time < startTime) {
      idx = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return Math.min(idx, bars.length - 2); // leave at least one bar to replay
}

export function visibleBars(bars: readonly Bar[], cursor: number): Bar[] {
  return bars.slice(0, Math.max(0, Math.min(cursor, bars.length - 1)) + 1);
}

/** Steps needed so that the cursor reaches the first bar with time >= `target`. */
export function stepsUntil(bars: readonly Bar[], cursor: number, target: number): number {
  let i = cursor;
  while (i < bars.length - 1 && bars[i]!.time < target) i++;
  return i - cursor;
}
