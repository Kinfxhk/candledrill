// SPDX-License-Identifier: AGPL-3.0-or-later
// Stop management helpers: auto break-even and a trailing stop, applied by the UI after each
// bar close through the normal "modify order" call. The fill model is unchanged: a moved stop
// is an ordinary user modification and fills under the same rules.

import { roundToTick, workingOrders, type Order, type TradingState } from '@candledrill/core';

export interface StopRules {
  /** Move the stop to entry once price has moved this many ticks in favour (null = off). */
  breakEvenTicks: number | null;
  /** Ticks beyond entry for break-even (covers costs); 0 = exactly entry. */
  breakEvenOffset: number;
  /** Keep the stop this many ticks behind the best close since entry (null = off). */
  trailTicks: number | null;
}

export const NO_STOP_RULES: StopRules = {
  breakEvenTicks: null,
  breakEvenOffset: 0,
  trailTicks: null,
};

/**
 * The stop-loss price the rules want now, or null to leave it alone. Only ever tightens:
 * a long stop moves up, a short stop moves down, never back.
 */
export function managedStop(
  rules: StopRules,
  side: 'long' | 'short',
  entry: number,
  currentStop: number,
  bestClose: number,
  tick: number,
): number | null {
  const dir = side === 'long' ? 1 : -1;
  let want = currentStop;
  if (rules.breakEvenTicks !== null && dir * (bestClose - entry) >= rules.breakEvenTicks * tick)
    want =
      dir > 0
        ? Math.max(want, entry + rules.breakEvenOffset * tick)
        : Math.min(want, entry - rules.breakEvenOffset * tick);
  if (rules.trailTicks !== null) {
    const trail = bestClose - dir * rules.trailTicks * tick;
    want = dir > 0 ? Math.max(want, trail) : Math.min(want, trail);
  }
  want = roundToTick(want, tick);
  return dir * (want - currentStop) > tick / 2 ? want : null;
}

/** The working stop-loss order protecting the open position, if any. */
export function protectiveStop(tr: TradingState): Order | undefined {
  const pos = tr.position;
  if (!pos || pos.qty === 0) return undefined;
  const exitSide = pos.qty > 0 ? 'sell' : 'buy';
  return workingOrders(tr).find(
    (o) => o.role === 'stop-loss' && o.side === exitSide && o.price !== null,
  );
}
