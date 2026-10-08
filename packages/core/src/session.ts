// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Practice session engine. A session is a pure state machine over a bar series:
// (bars, settings, state, action) -> new state. The engine only ever reads
// bars[0..cursor] plus the single bar being revealed by a step, so its result can never
// depend on data the user has not seen yet.

import type { Bar } from './types.js';
import { initialCursor, stepsUntil } from './replay.js';
import {
  cancelAllWorking,
  cancelOrder,
  emptyTrading,
  flattenAll,
  modifyOrder,
  OrderError,
  placeOrder,
  processBar,
  forceClose,
  type CostModel,
  type OrderChange,
  type OrderRequest,
  type TradingState,
  unrealizedPnl,
} from './orders.js';
import { computeStats, type SessionStats } from './stats.js';

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
  /** Highest closing equity seen (starts at the starting balance). */
  readonly equityPeak: number;
  /** Largest peak-to-trough fall of closing equity, in currency and as a fraction of the peak. */
  readonly maxDrawdown: number;
  readonly maxDrawdownPct: number;
  /** Trading day (exchange-local, from dayStartMinutes) of the cursor bar. */
  readonly dayKey: number;
  /** Closing equity at the end of the previous trading day (basis of the daily loss rule). */
  readonly dayStartEquity: number;
}

export function dayKeyOf(time: number, settings: SessionSettings): number {
  return Math.floor(
    (time + settings.utcOffsetMinutes * 60 - settings.dayStartMinutes * 60) / 86_400,
  );
}

export interface RuleStatus {
  readonly dailyLossUsed: number | null;
  readonly trailingUsed: number | null;
  readonly targetProgress: number | null;
}

/** Fractions (0..1+) of each practice rule currently used; null when the rule is off. */
export function ruleStatus(settings: SessionSettings, state: SessionState): RuleStatus {
  const eq = sessionEquity(settings, state);
  return {
    dailyLossUsed: settings.dailyLossLimit
      ? Math.max(0, state.dayStartEquity - eq) / settings.dailyLossLimit
      : null,
    trailingUsed: settings.trailingDrawdown
      ? Math.max(0, state.equityPeak - eq) / settings.trailingDrawdown
      : null,
    targetProgress: settings.profitTarget
      ? Math.max(0, liquidationEquity(settings, state) - settings.startingBalance) /
        settings.profitTarget
      : null,
  };
}

/** Fill in fields added after a state was first stored (pre-1.0 forward compatibility). */
export function upgradeState(
  bars: readonly Bar[],
  settings: SessionSettings,
  raw: SessionState,
): SessionState {
  const time = bars[Math.min(raw.cursor, bars.length - 1)]!.time;
  const up: SessionState = {
    ...raw,
    trading: { ...raw.trading, modifications: raw.trading.modifications ?? [] },
    equityPeak: raw.equityPeak ?? settings.startingBalance,
    maxDrawdown: raw.maxDrawdown ?? 0,
    maxDrawdownPct: raw.maxDrawdownPct ?? 0,
    dayKey: raw.dayKey ?? dayKeyOf(time, settings),
    dayStartEquity: raw.dayStartEquity ?? settings.startingBalance,
  };
  // Sessions finished by v0.1.0 could keep orders (e.g. a flatten) that can never fill.
  return atEnd(bars, up) ? endOfData(up) : up;
}

const atEnd = (bars: readonly Bar[], s: SessionState) => s.cursor >= bars.length - 1;

/**
 * End-of-data policy "keep-open": no later bar exists, so working orders can never fill and
 * are cancelled; an open position stays open, marked to the last close, and is reported as
 * open (not as a closed trade). Flatten is unavailable because it would need a next bar.
 */
function endOfData(s: SessionState): SessionState {
  const hasWorking = s.trading.orders.some((o) => o.status === 'working');
  return {
    ...s,
    status: s.status === 'active' ? 'finished' : s.status,
    statusReason: s.status === 'active' ? 'end of data' : s.statusReason,
    trading: hasWorking ? cancelAllWorking(s.trading, 'end of data') : s.trading,
  };
}

/**
 * Estimated cost of closing the open position now: exit commission plus adverse slippage,
 * using the same cost model as a real (forced) exit.
 */
export function estimatedExitCost(settings: SessionSettings, state: SessionState): number {
  const qty = Math.abs(state.trading.position?.qty ?? 0);
  if (qty === 0) return 0;
  const slip = settings.slippageTicks * settings.tickSize * settings.pointValue;
  return Math.round(qty * (settings.commissionPerContract + slip) * 1e8) / 1e8;
}

/** Equity if the position were closed at the last close after estimated exit costs. */
export function liquidationEquity(settings: SessionSettings, state: SessionState): number {
  return sessionEquity(settings, state) - estimatedExitCost(settings, state);
}

function applyRules(settings: SessionSettings, s: SessionState, bar: Bar): SessionState {
  if (s.status !== 'active') return s;
  const eq = sessionEquity(settings, s);
  let status: SessionStatus | null = null;
  let reason: string | null = null;
  if (settings.dailyLossLimit !== null && s.dayStartEquity - eq >= settings.dailyLossLimit) {
    status = 'breached';
    reason = `daily loss limit ${settings.dailyLossLimit}`;
  } else if (settings.trailingDrawdown !== null && s.equityPeak - eq >= settings.trailingDrawdown) {
    status = 'breached';
    reason = `trailing drawdown ${settings.trailingDrawdown}`;
  } else if (
    // Profit target basis: net after estimated exit costs, so the final realized result
    // after the forced exit is never below the target.
    settings.profitTarget !== null &&
    liquidationEquity(settings, s) - settings.startingBalance >= settings.profitTarget - 1e-9
  ) {
    status = 'passed';
    reason = `profit target ${settings.profitTarget}`;
  }
  if (!status) return s;
  const trading = forceClose(s.trading, costModel(settings), bar.close, bar.time);
  return markEquity(settings, { ...s, trading, status, statusReason: reason });
}
export const FILL_MODEL_NOTE =
  'Orders only fill on bars revealed after they were placed. Market orders fill at the next open; ' +
  'limit orders at their price (or the open if it gaps through); stop orders at their price or the ' +
  'open if gapped, plus slippage. Bracket children follow the same rules from the moment their ' +
  'entry fills: if the stop-loss or take-profit is already crossed, they fill at the bar open (or ' +
  'the entry price), never outside the bar. When one bar touches both the stop-loss and the ' +
  'take-profit, the stop-loss is assumed to fill first. Drawdown and practice rules use closing ' +
  'prices of each bar; the profit target counts only after estimated exit commission and ' +
  'slippage. At the end of the data an open position stays open, valued at the last close. ' +
  'R is N/A unless every entry of a trade had a stop-loss.';

export function sessionEquity(settings: SessionSettings, state: SessionState): number {
  return (
    settings.startingBalance +
    state.trading.realizedPnl +
    unrealizedPnl(state.trading, settings.pointValue)
  );
}

export function sessionStats(settings: SessionSettings, state: SessionState): SessionStats {
  return computeStats({
    trades: state.trading.trades,
    startingBalance: settings.startingBalance,
    commissionPaid: state.trading.commissionPaid,
    equity: sessionEquity(settings, state),
    maxDrawdown: state.maxDrawdown,
    maxDrawdownPct: state.maxDrawdownPct,
    openQty: state.trading.position?.qty ?? 0,
    unrealizedPnl: unrealizedPnl(state.trading, settings.pointValue),
  });
}

function markEquity(settings: SessionSettings, s: SessionState): SessionState {
  const equity = sessionEquity(settings, s);
  const peak = Math.max(s.equityPeak, equity);
  const dd = peak - equity;
  if (peak === s.equityPeak && dd <= s.maxDrawdown) return s;
  return {
    ...s,
    equityPeak: peak,
    maxDrawdown: Math.max(s.maxDrawdown, dd),
    maxDrawdownPct: Math.max(s.maxDrawdownPct, peak > 0 ? dd / peak : 0),
  };
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
    equityPeak: settings.startingBalance,
    maxDrawdown: 0,
    maxDrawdownPct: 0,
    dayKey: dayKeyOf(bars[cursor]!.time, settings),
    dayStartEquity: settings.startingBalance,
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

function assertCanTrade(bars: readonly Bar[], state: SessionState): void {
  if (state.status !== 'active') {
    throw new OrderError(`trading is locked: session is ${state.status}`);
  }
  if (atEnd(bars, state)) throw new OrderError(END_OF_DATA_MESSAGE);
}

export const END_OF_DATA_MESSAGE =
  'end of data: there is no later bar to fill an order; an open position stays open, ' +
  'valued at the last close';

export function sessionPlaceOrder(
  bars: readonly Bar[],
  settings: SessionSettings,
  state: SessionState,
  req: OrderRequest,
): SessionState {
  assertCanTrade(bars, state);
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
  change: number | OrderChange,
  time = 0,
): SessionState {
  if (state.status !== 'active') {
    throw new OrderError(`trading is locked: session is ${state.status}`);
  }
  return {
    ...state,
    trading: modifyOrder(state.trading, costModel(settings), orderId, change, time),
  };
}

export function sessionFlatten(bars: readonly Bar[], state: SessionState): SessionState {
  if (atEnd(bars, state)) throw new OrderError(END_OF_DATA_MESSAGE);
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
    if (atEnd(bars, s)) break;
    const cursor = s.cursor + 1;
    const bar = bars[cursor]!;
    revealed.push(bar);
    const key = dayKeyOf(bar.time, settings);
    if (key !== s.dayKey) s = { ...s, dayKey: key, dayStartEquity: sessionEquity(settings, s) };
    s = markEquity(settings, { ...s, cursor, trading: processBar(s.trading, costs, bar, cursor) });
    s = applyRules(settings, s, bar);
  }
  if (atEnd(bars, s)) s = endOfData(s);
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
