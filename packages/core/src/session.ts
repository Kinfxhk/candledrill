// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Practice session engine. A session is a pure state machine over a bar series:
// (bars, settings, state, action) -> new state. The engine only ever reads
// bars[0..cursor] plus the single bar being revealed by a step, so its result can never
// depend on data the user has not seen yet.

import type { Bar } from './types.js';
import { initialCursor, stepsUntil } from './replay.js';
import {
  cancelOrder,
  emptyTrading,
  flattenAll,
  modifyOrder,
  OrderError,
  placeOrder,
  processBar,
  type CostModel,
  type OrderRequest,
  type TradingState,
} from './orders.js';

export interface SessionSettings {
  readonly symbol: string;
  readonly tickSize: number;
  /** Currency value of a 1.0 price move for one contract. */
  readonly pointValue: number;
  /** Commission per contract per side. */
  readonly commissionPerContract: number;
  /** Adverse slippage in ticks applied to market and stop fills. */
  readonly slippageTicks: number;
  readonly startingBalance: number;
  /** Practice rules (null = off). Currency amounts. */
  readonly dailyLossLimit: number | null;
  readonly trailingDrawdown: number | null;
  readonly profitTarget: number | null;
  /** Exchange-local clock used for daily bars and the trading-day boundary. */
  readonly utcOffsetMinutes: number;
  readonly dayStartMinutes: number;
}

export type SessionStatus = 'active' | 'breached' | 'passed' | 'finished';

export interface SessionState {
  readonly version: 1;
  readonly cursor: number;
  readonly status: SessionStatus;
  readonly statusReason: string | null;
  readonly trading: TradingState;
}

export const MAX_STEPS_PER_ACTION = 500_000;

export function validateSettings(s: SessionSettings): string[] {
  const errors: string[] = [];
  const pos = (n: number) => Number.isFinite(n) && n > 0;
  const nonNeg = (n: number) => Number.isFinite(n) && n >= 0;
  if (!pos(s.tickSize)) errors.push('tickSize must be > 0');
  if (!pos(s.pointValue)) errors.push('pointValue must be > 0');
  if (!nonNeg(s.commissionPerContract)) errors.push('commissionPerContract must be >= 0');
  if (!Number.isInteger(s.slippageTicks) || s.slippageTicks < 0 || s.slippageTicks > 1000)
    errors.push('slippageTicks must be an integer 0-1000');
  if (!pos(s.startingBalance)) errors.push('startingBalance must be > 0');
  for (const k of ['dailyLossLimit', 'trailingDrawdown', 'profitTarget'] as const) {
    const v = s[k];
    if (v !== null && !pos(v)) errors.push(`${k} must be > 0 or null`);
  }
  if (!Number.isInteger(s.utcOffsetMinutes) || Math.abs(s.utcOffsetMinutes) > 840)
    errors.push('utcOffsetMinutes must be an integer within ±840');
  if (!Number.isInteger(s.dayStartMinutes) || s.dayStartMinutes < 0 || s.dayStartMinutes >= 1440)
    errors.push('dayStartMinutes must be an integer 0-1439');
  return errors;
}

export function createSession(
  bars: readonly Bar[],
  settings: SessionSettings,
  startTime: number,
): SessionState {
  const errors = validateSettings(settings);
  if (errors.length) throw new RangeError(errors.join('; '));
  const cursor = initialCursor(bars, startTime);
  return {
    version: 1,
    cursor,
    status: 'active',
    statusReason: null,
    trading: emptyTrading(bars[cursor]!.close),
  };
}

export function costModel(s: SessionSettings): CostModel {
  return {
    tickSize: s.tickSize,
    pointValue: s.pointValue,
    commissionPerContract: s.commissionPerContract,
    slippageTicks: s.slippageTicks,
  };
}

function assertCanTrade(state: SessionState): void {
  if (state.status !== 'active') {
    throw new OrderError(`trading is locked: session is ${state.status}`);
  }
}

export function sessionPlaceOrder(
  bars: readonly Bar[],
  settings: SessionSettings,
  state: SessionState,
  req: OrderRequest,
): SessionState {
  assertCanTrade(state);
  const { trading } = placeOrder(
    state.trading,
    costModel(settings),
    req,
    state.cursor,
    bars[state.cursor]!.time,
  );
  return { ...state, trading };
}

export function sessionCancelOrder(state: SessionState, orderId: number): SessionState {
  return { ...state, trading: cancelOrder(state.trading, orderId) };
}

export function sessionModifyOrder(
  settings: SessionSettings,
  state: SessionState,
  orderId: number,
  price: number,
): SessionState {
  assertCanTrade(state);
  return { ...state, trading: modifyOrder(state.trading, costModel(settings), orderId, price) };
}

export function sessionFlatten(bars: readonly Bar[], state: SessionState): SessionState {
  return { ...state, trading: flattenAll(state.trading, state.cursor, bars[state.cursor]!.time) };
}

export interface StepResult {
  readonly state: SessionState;
  /** Bars revealed by this action, in order. */
  readonly revealed: Bar[];
}

/** Reveal up to `count` more bars. */
export function stepSession(
  bars: readonly Bar[],
  settings: SessionSettings,
  state: SessionState,
  count = 1,
): StepResult {
  if (!Number.isInteger(count) || count < 1 || count > MAX_STEPS_PER_ACTION) {
    throw new RangeError(`count must be an integer 1-${MAX_STEPS_PER_ACTION}`);
  }
  let s = state;
  const costs = costModel(settings);
  const revealed: Bar[] = [];
  for (let i = 0; i < count; i++) {
    if (s.cursor >= bars.length - 1) {
      if (s.status === 'active') s = { ...s, status: 'finished', statusReason: 'end of data' };
      break;
    }
    const cursor = s.cursor + 1;
    const bar = bars[cursor]!;
    revealed.push(bar);
    s = { ...s, cursor, trading: processBar(s.trading, costs, bar, cursor) };
  }
  if (s.cursor >= bars.length - 1 && s.status === 'active') {
    s = { ...s, status: 'finished', statusReason: 'end of data' };
  }
  return { state: s, revealed };
}

/** Fast-forward to the first bar at or after `time`. Jumps never go backwards. */
export function jumpSession(
  bars: readonly Bar[],
  settings: SessionSettings,
  state: SessionState,
  time: number,
): StepResult {
  const n = stepsUntil(bars, state.cursor, time);
  if (n === 0) return { state, revealed: [] };
  return stepSession(bars, settings, state, Math.min(n, MAX_STEPS_PER_ACTION));
}
