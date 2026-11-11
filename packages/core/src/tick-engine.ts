// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tick-granularity matching and practice-rule enforcement.
// Parallel to the bar engine in orders.ts / session.ts: those functions are not
// modified. Market orders fill immediately at the current tick ± adverse slippage.
// Limit fills at the limit; stops fill at the stop ± slippage. Bracket children
// are created on the entry fill and are not evaluated until a later tick. If a
// stop and a limit both trigger on one tick, the stop fills first (conservative,
// same priority as processBar).

import type { Tick } from './tick-path.js';
import {
  OrderError,
  applyFill,
  cancelAllWorking,
  cancelOrder,
  emptyTrading,
  forceClose,
  modifyOrder,
  placeOrder,
  roundToTick,
  type CostModel,
  type Order,
  type OrderChange,
  type OrderRequest,
  type Side,
  type TradingState,
} from './orders.js';
import {
  costModel,
  dayKeyOf,
  equityAtPrice,
  liquidationEquity,
  sessionEquity,
  type SessionSettings,
  type SessionState,
  type SessionStatus,
} from './session.js';

export type { Tick } from './tick-path.js';

export interface TickSimState extends SessionState {
  /**
   * Advances once per stepTick. Working orders fill only when placedIndex is
   * strictly less, so an order placed on this tick waits for the next one.
   * Bracket children use the current cursor and therefore also wait.
   */
  readonly tickCursor: number;
}

export function createTickSim(
  settings: SessionSettings,
  price: number,
  time: number,
  cursor = 0,
): TickSimState {
  return {
    version: 2,
    cursor,
    status: 'active',
    statusReason: null,
    trading: emptyTrading(price),
    equityPeak: settings.startingBalance,
    eodPeak: settings.startingBalance,
    intradayPeak: settings.startingBalance,
    maxDrawdown: 0,
    maxDrawdownPct: 0,
    dayKey: dayKeyOf(time, settings),
    dayStartEquity: settings.startingBalance,
    tickCursor: 0,
  };
}

/**
 * Continue a bar-replay session in the tick engine. Resting orders are remapped
 * so the next tick can fill them; their bar placedIndex is not a tick cursor.
 */
export function tickSimFromSession(state: SessionState): TickSimState {
  return {
    ...state,
    trading: {
      ...state.trading,
      orders: state.trading.orders.map((o) =>
        o.status === 'working' ? { ...o, placedIndex: -1 } : o,
      ),
    },
    tickCursor: 0,
  };
}

function replaceOrder(t: TradingState, o: Order): TradingState {
  return { ...t, orders: t.orders.map((x) => (x.id === o.id ? o : x)) };
}

function cancelWhere(t: TradingState, pred: (o: Order) => boolean, reason: string): TradingState {
  return {
    ...t,
    orders: t.orders.map((o) =>
      o.status === 'working' && pred(o) ? { ...o, status: 'cancelled', cancelReason: reason } : o,
    ),
  };
}

function makeChild(
  parent: Order,
  role: 'stop-loss' | 'take-profit',
  qty: number,
  price: number,
  id: number,
  placedIndex: number,
  time: number,
): Order {
  return {
    id,
    side: parent.side === 'buy' ? 'sell' : 'buy',
    type: role === 'stop-loss' ? 'stop' : 'limit',
    qty,
    price,
    role,
    status: 'working',
    placedIndex,
    placedTime: time,
    stopLoss: null,
    takeProfit: null,
    parentId: parent.id,
    ocoGroup: parent.id,
    filledTime: null,
    fillPrice: null,
    cancelReason: null,
  };
}

function adverse(side: Side, price: number, costs: CostModel): number {
  const slip = costs.slippageTicks * costs.tickSize;
  return roundToTick(side === 'buy' ? price + slip : price - slip, costs.tickSize);
}

/** Fill price if `order` triggers at `tickPrice`, otherwise null. Stops fill at the stop, not the tick. */
export function tickFillPrice(order: Order, tickPrice: number, costs: CostModel): number | null {
  if (order.type === 'market') return adverse(order.side, tickPrice, costs);
  const level = order.price;
  if (level === null) return null;
  if (order.type === 'limit') {
    if (order.side === 'buy') return tickPrice <= level ? level : null;
    return tickPrice >= level ? level : null;
  }
  if (order.side === 'buy') return tickPrice >= level ? adverse('buy', level, costs) : null;
  return tickPrice <= level ? adverse('sell', level, costs) : null;
}

function assertActive(state: TickSimState): void {
  if (state.status !== 'active') {
    throw new OrderError(`trading is locked: session is ${state.status}`);
  }
}

function executeFill(
  state: TickSimState,
  costs: CostModel,
  order: Order,
  price: number,
  time: number,
  childPlacedIndex: number,
): TickSimState {
  let trading = state.trading;
  const live = trading.orders.find((o) => o.id === order.id) ?? order;
  if (live.status !== 'working' && order.status === 'working') return state;
  let qty = order.qty;
  if (order.role !== 'entry') {
    const pos = trading.position;
    const reduces = pos !== null && (pos.qty > 0 ? order.side === 'sell' : order.side === 'buy');
    if (!reduces) {
      return { ...state, trading: cancelOrder(trading, order.id, 'no position to reduce') };
    }
    qty = Math.min(qty, Math.abs(pos.qty));
  }
  trading = replaceOrder(trading, {
    ...order,
    status: 'filled',
    filledTime: time,
    fillPrice: price,
  });
  if (order.ocoGroup !== null) {
    trading = cancelWhere(
      trading,
      (x) => x.ocoGroup === order.ocoGroup && x.id !== order.id,
      'OCO sibling filled',
    );
  }
  trading = applyFill(
    trading,
    costs,
    {
      orderId: order.id,
      side: order.side,
      qty,
      price,
      time,
      role: order.role,
    },
    order.stopLoss,
  );
  const pos = trading.position;
  const sameDir = pos !== null && pos.qty > 0 === (order.side === 'buy');
  if (order.role === 'entry' && sameDir && (order.stopLoss !== null || order.takeProfit !== null)) {
    const childQty = Math.min(qty, Math.abs(pos.qty));
    if (order.stopLoss !== null) {
      const sl = makeChild(
        order,
        'stop-loss',
        childQty,
        order.stopLoss,
        trading.nextId,
        childPlacedIndex,
        time,
      );
      trading = { ...trading, nextId: trading.nextId + 1, orders: [...trading.orders, sl] };
    }
    if (order.takeProfit !== null) {
      const tp = makeChild(
        order,
        'take-profit',
        childQty,
        order.takeProfit,
        trading.nextId,
        childPlacedIndex,
        time,
      );
      trading = { ...trading, nextId: trading.nextId + 1, orders: [...trading.orders, tp] };
    }
  }
  return { ...state, trading };
}

function markEquity(settings: SessionSettings, s: TickSimState): TickSimState {
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

/**
 * Daily loss, trailing drawdown (close / eod / intraday / static) and profit
 * target, using the same thresholds and priority as the bar engine, but marked
 * at the tick. A breach force-closes at the tick (plus the cost model's slippage).
 */
function applyTickRules(
  settings: SessionSettings,
  s: TickSimState,
  tick: Tick,
  costs: CostModel,
): TickSimState {
  if (s.status !== 'active') return s;
  const eq = sessionEquity(settings, s);
  let status: SessionStatus | null = null;
  let reason: string | null = null;
  if (settings.dailyLossLimit !== null && s.dayStartEquity - eq >= settings.dailyLossLimit) {
    status = 'breached';
    reason = `daily loss limit ${settings.dailyLossLimit}`;
  } else if (settings.trailingDrawdown !== null) {
    const amount = settings.trailingDrawdown;
    const mode = settings.trailingDrawdownMode;
    const peak =
      mode === 'static'
        ? settings.startingBalance
        : mode === 'eod'
          ? s.eodPeak
          : mode === 'intraday'
            ? s.intradayPeak
            : s.equityPeak;
    if (peak - eq >= amount) {
      status = 'breached';
      reason = `trailing drawdown ${amount}`;
    }
  }
  if (
    !status &&
    settings.profitTarget !== null &&
    liquidationEquity(settings, s) - settings.startingBalance >= settings.profitTarget - 1e-9
  ) {
    status = 'passed';
    reason = `profit target ${settings.profitTarget}`;
  }
  if (!status) return s;
  const trading = forceClose(s.trading, costs, tick.price, tick.time);
  return markEquity(settings, { ...s, trading, status, statusReason: reason });
}

function afterMark(
  settings: SessionSettings,
  s: TickSimState,
  tick: Tick,
  costs: CostModel,
): TickSimState {
  let next: TickSimState = { ...s, trading: { ...s.trading, lastClose: tick.price } };
  next = markEquity(settings, next);
  if (settings.trailingDrawdownMode === 'intraday') {
    const fav = equityAtPrice(settings, next, tick.price);
    if (fav > next.intradayPeak) next = { ...next, intradayPeak: fav };
  }
  return applyTickRules(settings, next, tick, costs);
}

function triggeredNow(req: OrderRequest, tickPrice: number): boolean {
  if (req.type === 'market') return true;
  const level = req.price;
  if (level == null) return false;
  if (req.type === 'limit') return req.side === 'buy' ? tickPrice <= level : tickPrice >= level;
  return req.side === 'buy' ? tickPrice >= level : tickPrice <= level;
}

/** A last close on the resting side of a limit, so placeOrder accepts an order we will fill now. */
function scratchClose(req: OrderRequest, tickPrice: number, tickSize: number): number {
  if (req.type === 'limit' && req.price != null) {
    return req.side === 'buy' ? req.price + tickSize : req.price / 2;
  }
  return tickPrice;
}

export function tickPlaceOrder(
  state: TickSimState,
  settings: SessionSettings,
  costs: CostModel,
  req: OrderRequest,
  tick: Tick,
): TickSimState {
  assertActive(state);
  const placed = placeOrder(
    { ...state.trading, lastClose: scratchClose(req, tick.price, costs.tickSize) },
    costs,
    req,
    state.tickCursor,
    tick.time,
  );
  const order = placed.order;
  let next: TickSimState = {
    ...state,
    trading: {
      ...state.trading,
      nextId: placed.trading.nextId,
      orders: [...state.trading.orders, order],
    },
  };
  if (!triggeredNow(req, tick.price)) return next;
  const px = tickFillPrice(order, tick.price, costs);
  if (px === null) return next;
  // Children wait for a later tick (placedIndex === tickCursor, stepTick requires strictly less).
  next = executeFill(next, costs, order, px, tick.time, state.tickCursor);
  return afterMark(settings, next, tick, costs);
}

export function tickCancelOrder(state: TickSimState, orderId: number): TickSimState {
  assertActive(state);
  return { ...state, trading: cancelOrder(state.trading, orderId) };
}

export function tickModifyOrder(
  state: TickSimState,
  costs: CostModel,
  orderId: number,
  change: number | OrderChange,
  time = 0,
): TickSimState {
  assertActive(state);
  return { ...state, trading: modifyOrder(state.trading, costs, orderId, change, time) };
}

/** Cancel working orders and close immediately at the tick ± slippage. */
export function tickFlatten(
  state: TickSimState,
  settings: SessionSettings,
  costs: CostModel,
  tick: Tick,
): TickSimState {
  assertActive(state);
  let trading = cancelAllWorking(state.trading, 'flatten');
  if (trading.position) {
    const side: Side = trading.position.qty > 0 ? 'sell' : 'buy';
    trading = applyFill(trading, costs, {
      orderId: 0,
      side,
      qty: Math.abs(trading.position.qty),
      price: adverse(side, tick.price, costs),
      time: tick.time,
      role: 'flatten',
    });
  }
  return afterMark(settings, { ...state, trading }, tick, costs);
}

function isStop(o: Order): boolean {
  return o.type === 'stop';
}

/**
 * Advance one tick: roll the trading day, fill resting orders, mark to the tick,
 * then apply practice rules. Locked sessions only update the mark.
 */
export function stepTick(
  state: TickSimState,
  tick: Tick,
  costs: CostModel,
  settings: SessionSettings,
): TickSimState {
  if (state.status !== 'active') {
    return { ...state, trading: { ...state.trading, lastClose: tick.price } };
  }
  let s = state;
  const key = dayKeyOf(tick.time, settings);
  if (key !== s.dayKey) {
    const prev = sessionEquity(settings, s);
    s = {
      ...s,
      dayKey: key,
      dayStartEquity: prev,
      eodPeak: Math.max(s.eodPeak, prev),
    };
  }
  const cursor = s.tickCursor + 1;
  s = { ...s, tickCursor: cursor };
  const candidates = s.trading.orders
    .filter((o) => o.status === 'working' && o.placedIndex < cursor)
    .map((o) => ({ o, price: tickFillPrice(o, tick.price, costs) }))
    .filter((c): c is { o: Order; price: number } => c.price !== null)
    .sort((a, b) => (isStop(a.o) ? 0 : 1) - (isStop(b.o) ? 0 : 1) || a.o.id - b.o.id);

  for (const { o, price } of candidates) {
    const live = s.trading.orders.find((x) => x.id === o.id);
    if (!live || live.status !== 'working') continue;
    s = executeFill(s, costs, live, price, tick.time, cursor);
  }
  return afterMark(settings, s, tick, costs);
}

/** Costs from the session settings. Exposed so the UI does not rebuild the object by hand. */
export function tickCosts(settings: SessionSettings): CostModel {
  return costModel(settings);
}
