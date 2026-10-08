// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bar-based order simulation and position accounting (single instrument, net position).
//
// Fill model (documented in the UI and reports):
// - An order can only fill on a bar revealed AFTER it was placed.
// - Market orders fill at the next bar's open, plus adverse slippage.
// - Limit orders fill when the bar trades at or through the limit price, at the limit price,
//   or at the open if the bar opens beyond it (price improvement on gaps). No slippage.
// - Stop orders trigger when the bar trades at or through the stop price and fill at the
//   stop price (or the open if the bar gaps through it), plus adverse slippage.
// - Within one bar, orders whose price is crossed at the open fill first; then stop-type
//   orders before limit-type orders. Hence when one bar touches both a stop-loss and a
//   take-profit, the stop-loss is assumed to fill first (conservative).
// - Bracket children are created when the entry fills and use the same trigger rules on the
//   entry bar, applied to the part of the bar known to follow the entry. A child already
//   crossed at that point (gap through the stop-loss or take-profit) fills at the bar open
//   (or at the entry price for an intrabar entry), never at a price outside the bar. After an
//   intrabar entry the stop-loss fills if touched (conservative) but the take-profit does not.
// - Stop-loss, take-profit and flatten orders are reduce-only and never flip a position.

import type { Bar } from './types.js';
import { isOnTickGrid, tickDecimals } from './ticks.js';

export type Side = 'buy' | 'sell';
export type OrderType = 'market' | 'limit' | 'stop';
export type OrderRole = 'entry' | 'stop-loss' | 'take-profit' | 'flatten';
export type OrderStatus = 'working' | 'filled' | 'cancelled';
export type ExitReason = 'stop-loss' | 'take-profit' | 'manual' | 'flatten' | 'rule';

export interface Order {
  readonly id: number;
  readonly side: Side;
  readonly type: OrderType;
  readonly qty: number;
  readonly price: number | null;
  readonly role: OrderRole;
  readonly status: OrderStatus;
  /** Cursor index when placed; the order may only fill on bars with a larger index. */
  readonly placedIndex: number;
  readonly placedTime: number;
  /** Bracket prices requested with an entry order. */
  readonly stopLoss: number | null;
  readonly takeProfit: number | null;
  readonly parentId: number | null;
  /** Orders sharing an OCO group cancel each other when one fills. */
  readonly ocoGroup: number | null;
  readonly filledTime: number | null;
  readonly fillPrice: number | null;
  readonly cancelReason: string | null;
}

export interface Fill {
  readonly id: number;
  readonly orderId: number;
  readonly time: number;
  readonly side: Side;
  readonly qty: number;
  readonly price: number;
  readonly commission: number;
  readonly role: OrderRole | 'rule';
}

export interface Position {
  /** Signed quantity: > 0 long, < 0 short. */
  readonly qty: number;
  readonly avgPrice: number;
}

export interface OpenTrade {
  readonly side: 'long' | 'short';
  readonly openTime: number;
  readonly entryQty: number;
  readonly entryValue: number;
  readonly exitQty: number;
  readonly exitValue: number;
  readonly maxQty: number;
  readonly commission: number;
  readonly grossPnl: number;
  /** Currency risked at entry (|entry - stop-loss| x qty x point value), if a stop-loss was set. */
  readonly initialRisk: number | null;
}

export interface Trade {
  readonly id: number;
  readonly side: 'long' | 'short';
  readonly qty: number;
  readonly openTime: number;
  readonly closeTime: number;
  readonly entryPrice: number;
  readonly exitPrice: number;
  readonly grossPnl: number;
  readonly commission: number;
  readonly netPnl: number;
  readonly initialRisk: number | null;
  readonly rMultiple: number | null;
  readonly exitReason: ExitReason;
}

export interface TradingState {
  readonly nextId: number;
  readonly orders: readonly Order[];
  readonly fills: readonly Fill[];
  readonly position: Position | null;
  readonly openTrade: OpenTrade | null;
  readonly trades: readonly Trade[];
  /** Closed P&L net of all commissions paid so far. */
  readonly realizedPnl: number;
  readonly commissionPaid: number;
  readonly lastClose: number;
}

export interface CostModel {
  readonly tickSize: number;
  readonly pointValue: number;
  readonly commissionPerContract: number;
  readonly slippageTicks: number;
}

export interface OrderRequest {
  readonly side: Side;
  readonly type: OrderType;
  readonly qty: number;
  readonly price?: number | null;
  readonly stopLoss?: number | null;
  readonly takeProfit?: number | null;
}

export class OrderError extends Error {}

export const MAX_ORDER_QTY = 10_000;

const money = (v: number) => Math.round(v * 1e8) / 1e8;

export function roundToTick(price: number, tickSize: number): number {
  const ticks = Math.round(price / tickSize);
  return Number((ticks * tickSize).toFixed(tickDecimals(tickSize)));
}

export function emptyTrading(lastClose: number): TradingState {
  return {
    nextId: 1,
    orders: [],
    fills: [],
    position: null,
    openTrade: null,
    trades: [],
    realizedPnl: 0,
    commissionPaid: 0,
    lastClose,
  };
}

export function unrealizedPnl(t: TradingState, pointValue: number): number {
  if (!t.position) return 0;
  return money((t.lastClose - t.position.avgPrice) * t.position.qty * pointValue);
}

export function workingOrders(t: TradingState): Order[] {
  return t.orders.filter((o) => o.status === 'working');
}

function checkPrice(name: string, p: number | null | undefined, tick: number): number {
  if (p === null || p === undefined || !Number.isFinite(p) || p <= 0) {
    throw new OrderError(`${name} must be a positive price`);
  }
  if (!isOnTickGrid(p, tick))
    throw new OrderError(`${name} must be a multiple of the tick size ${tick}`);
  return roundToTick(p, tick);
}

/** Validate and add a new working order. `index`/`time` are the current cursor bar. */
export function placeOrder(
  t: TradingState,
  costs: CostModel,
  req: OrderRequest,
  index: number,
  time: number,
): { trading: TradingState; order: Order } {
  if (req.side !== 'buy' && req.side !== 'sell') throw new OrderError('side must be buy or sell');
  if (!['market', 'limit', 'stop'].includes(req.type)) throw new OrderError('invalid order type');
  if (!Number.isInteger(req.qty) || req.qty < 1 || req.qty > MAX_ORDER_QTY) {
    throw new OrderError(`qty must be an integer 1-${MAX_ORDER_QTY}`);
  }
  const price = req.type === 'market' ? null : checkPrice('price', req.price, costs.tickSize);
  const sl = req.stopLoss == null ? null : checkPrice('stopLoss', req.stopLoss, costs.tickSize);
  const tp =
    req.takeProfit == null ? null : checkPrice('takeProfit', req.takeProfit, costs.tickSize);
  const ref = price ?? t.lastClose;
  const dir = req.side === 'buy' ? 1 : -1;
  if (sl !== null && (sl - ref) * dir >= 0) {
    throw new OrderError(
      `stop-loss must be ${dir > 0 ? 'below' : 'above'} the entry reference price ${ref}`,
    );
  }
  if (tp !== null && (tp - ref) * dir <= 0) {
    throw new OrderError(
      `take-profit must be ${dir > 0 ? 'above' : 'below'} the entry reference price ${ref}`,
    );
  }
  const order: Order = {
    id: t.nextId,
    side: req.side,
    type: req.type,
    qty: req.qty,
    price,
    role: 'entry',
    status: 'working',
    placedIndex: index,
    placedTime: time,
    stopLoss: sl,
    takeProfit: tp,
    parentId: null,
    ocoGroup: null,
    filledTime: null,
    fillPrice: null,
    cancelReason: null,
  };
  return { trading: { ...t, nextId: t.nextId + 1, orders: [...t.orders, order] }, order };
}

function replaceOrder(t: TradingState, o: Order): TradingState {
  return { ...t, orders: t.orders.map((x) => (x.id === o.id ? o : x)) };
}

export function cancelOrder(
  t: TradingState,
  id: number,
  reason = 'cancelled by user',
): TradingState {
  const o = t.orders.find((x) => x.id === id);
  if (!o) throw new OrderError(`order ${id} not found`);
  if (o.status !== 'working') throw new OrderError(`order ${id} is not working`);
  return replaceOrder(t, { ...o, status: 'cancelled', cancelReason: reason });
}

export function modifyOrder(
  t: TradingState,
  costs: CostModel,
  id: number,
  price: number,
): TradingState {
  const o = t.orders.find((x) => x.id === id);
  if (!o) throw new OrderError(`order ${id} not found`);
  if (o.status !== 'working') throw new OrderError(`order ${id} is not working`);
  if (o.type === 'market') throw new OrderError('market orders have no price');
  return replaceOrder(t, { ...o, price: checkPrice('price', price, costs.tickSize) });
}

function cancelWhere(t: TradingState, pred: (o: Order) => boolean, reason: string): TradingState {
  return {
    ...t,
    orders: t.orders.map((o) =>
      o.status === 'working' && pred(o) ? { ...o, status: 'cancelled', cancelReason: reason } : o,
    ),
  };
}

/** Cancel every working order and, if a position is open, queue a market order to close it. */
export function flattenAll(t: TradingState, index: number, time: number): TradingState {
  let s = cancelWhere(t, () => true, 'flatten');
  if (s.position) {
    const qty = Math.abs(s.position.qty);
    const order: Order = {
      id: s.nextId,
      side: s.position.qty > 0 ? 'sell' : 'buy',
      type: 'market',
      qty,
      price: null,
      role: 'flatten',
      status: 'working',
      placedIndex: index,
      placedTime: time,
      stopLoss: null,
      takeProfit: null,
      parentId: null,
      ocoGroup: null,
      filledTime: null,
      fillPrice: null,
      cancelReason: null,
    };
    s = { ...s, nextId: s.nextId + 1, orders: [...s.orders, order] };
  }
  return s;
}

interface Trigger {
  price: number;
  atOpen: boolean;
}

/** Would `o` trigger on `bar`, and at what price? */
export function triggerOf(o: Order, bar: Bar, costs: CostModel): Trigger | null {
  const slip = costs.slippageTicks * costs.tickSize;
  const adverse = (p: number) =>
    roundToTick(o.side === 'buy' ? p + slip : p - slip, costs.tickSize);
  if (o.type === 'market') return { price: adverse(bar.open), atOpen: true };
  const p = o.price!;
  if (o.type === 'limit') {
    if (o.side === 'buy') {
      if (bar.open <= p) return { price: bar.open, atOpen: true };
      return bar.low <= p ? { price: p, atOpen: false } : null;
    }
    if (bar.open >= p) return { price: bar.open, atOpen: true };
    return bar.high >= p ? { price: p, atOpen: false } : null;
  }
  // stop
  if (o.side === 'buy') {
    if (bar.open >= p) return { price: adverse(bar.open), atOpen: true };
    return bar.high >= p ? { price: adverse(p), atOpen: false } : null;
  }
  if (bar.open <= p) return { price: adverse(bar.open), atOpen: true };
  return bar.low <= p ? { price: adverse(p), atOpen: false } : null;
}

function exitReasonOf(role: Fill['role']): ExitReason {
  switch (role) {
    case 'stop-loss':
      return 'stop-loss';
    case 'take-profit':
      return 'take-profit';
    case 'flatten':
      return 'flatten';
    case 'rule':
      return 'rule';
    default:
      return 'manual';
  }
}

/** Apply one execution to the position and trade ledger. */
export function applyFill(
  t: TradingState,
  costs: CostModel,
  f: { orderId: number; side: Side; qty: number; price: number; time: number; role: Fill['role'] },
  stopLossForRisk: number | null = null,
): TradingState {
  const commission = money(costs.commissionPerContract * f.qty);
  const fill: Fill = { id: t.nextId, commission, ...f };
  let s: TradingState = {
    ...t,
    nextId: t.nextId + 1,
    fills: [...t.fills, fill],
    realizedPnl: money(t.realizedPnl - commission),
    commissionPaid: money(t.commissionPaid + commission),
  };
  const signed = f.side === 'buy' ? f.qty : -f.qty;
  const open = (qty: number, comm: number): void => {
    const risk =
      stopLossForRisk === null
        ? null
        : money(Math.abs(f.price - stopLossForRisk) * qty * costs.pointValue);
    s = {
      ...s,
      position: { qty: f.side === 'buy' ? qty : -qty, avgPrice: f.price },
      openTrade: {
        side: f.side === 'buy' ? 'long' : 'short',
        openTime: f.time,
        entryQty: qty,
        entryValue: qty * f.price,
        exitQty: 0,
        exitValue: 0,
        maxQty: qty,
        commission: comm,
        grossPnl: 0,
        initialRisk: risk,
      },
    };
  };
  const pos = s.position;
  const ot = s.openTrade;
  if (!pos || !ot) {
    open(f.qty, commission);
    return s;
  }
  if (Math.sign(pos.qty) === Math.sign(signed)) {
    const absQ = Math.abs(pos.qty);
    const avg = (absQ * pos.avgPrice + f.qty * f.price) / (absQ + f.qty);
    s = {
      ...s,
      position: { qty: pos.qty + signed, avgPrice: avg },
      openTrade: {
        ...ot,
        entryQty: ot.entryQty + f.qty,
        entryValue: ot.entryValue + f.qty * f.price,
        maxQty: Math.max(ot.maxQty, absQ + f.qty),
        commission: money(ot.commission + commission),
      },
    };
    return s;
  }
  const dir = Math.sign(pos.qty);
  const closeQty = Math.min(f.qty, Math.abs(pos.qty));
  const gross = money((f.price - pos.avgPrice) * closeQty * dir * costs.pointValue);
  const closeComm = money((commission * closeQty) / f.qty);
  const trade: OpenTrade = {
    ...ot,
    exitQty: ot.exitQty + closeQty,
    exitValue: ot.exitValue + closeQty * f.price,
    commission: money(ot.commission + closeComm),
    grossPnl: money(ot.grossPnl + gross),
  };
  s = { ...s, realizedPnl: money(s.realizedPnl + gross) };
  const remaining = Math.abs(pos.qty) - closeQty;
  if (remaining > 0) {
    s = { ...s, position: { qty: dir * remaining, avgPrice: pos.avgPrice }, openTrade: trade };
    return s;
  }
  const net = money(trade.grossPnl - trade.commission);
  const closed: Trade = {
    id: s.trades.length + 1,
    side: trade.side,
    qty: trade.maxQty,
    openTime: trade.openTime,
    closeTime: f.time,
    entryPrice: trade.entryValue / trade.entryQty,
    exitPrice: trade.exitValue / trade.exitQty,
    grossPnl: trade.grossPnl,
    commission: trade.commission,
    netPnl: net,
    initialRisk: trade.initialRisk,
    rMultiple: trade.initialRisk ? Math.round((net / trade.initialRisk) * 1e4) / 1e4 : null,
    exitReason: exitReasonOf(f.role),
  };
  s = { ...s, position: null, openTrade: null, trades: [...s.trades, closed] };
  // Protective orders of a closed position are no longer needed.
  s = cancelWhere(s, (o) => o.role === 'stop-loss' || o.role === 'take-profit', 'position closed');
  const leftover = f.qty - closeQty;
  if (leftover > 0) open(leftover, money(commission - closeComm));
  return s;
}

function isStopLike(o: Order): boolean {
  return o.type === 'stop';
}

function makeChild(
  parent: Order,
  role: 'stop-loss' | 'take-profit',
  qty: number,
  price: number,
  id: number,
  index: number,
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
    placedIndex: index,
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

/**
 * Resolve freshly created bracket children on the bar their entry filled on, with the SAME
 * trigger rules as any other working order (`triggerOf`), applied to the part of the bar
 * that is known to come after the entry:
 *
 * - Entry filled at the open: the whole bar follows the entry, so the children see the bar
 *   as is. A child whose price is already crossed at the open (a gap through the stop-loss
 *   or take-profit) fills at the open, exactly like a working order would.
 * - Entry filled intrabar at price P: the only price known to follow the entry is P itself,
 *   so the children see a bar that "opens" at P with the same high/low. A child already
 *   crossed at P exits at P (plus stop slippage). The stop-loss may still fill at its price
 *   if the bar reached it (conservative: the order of high and low is unknown), but the
 *   take-profit may not, because the favourable extreme may have happened before the entry.
 *
 * Fills therefore never happen at a price the bar model does not allow.
 */
function resolveEntryBarChildren(
  t: TradingState,
  costs: CostModel,
  bar: Bar,
  entry: Order,
  entryTrig: Trigger,
  qty: number,
  sl: Order | null,
  tp: Order | null,
): TradingState {
  const after: Bar = entryTrig.atOpen ? bar : { ...bar, open: entry.price! };
  const options: { child: Order; trig: Trigger }[] = [];
  if (sl) {
    const trig = triggerOf(sl, after, costs);
    if (trig) options.push({ child: sl, trig });
  }
  if (tp) {
    const trig = triggerOf(tp, after, costs);
    // On an intrabar entry the take-profit may only fill if it is marketable at the entry.
    if (trig && (entryTrig.atOpen || trig.atOpen)) options.push({ child: tp, trig });
  }
  if (options.length === 0) return t;
  // Same priority as processBar: crossed-at-open first, then stop-loss before take-profit.
  options.sort((a, b) =>
    a.trig.atOpen !== b.trig.atOpen
      ? a.trig.atOpen
        ? -1
        : 1
      : (isStopLike(a.child) ? 0 : 1) - (isStopLike(b.child) ? 0 : 1),
  );
  const { child, trig } = options[0]!;
  let s = replaceOrder(t, {
    ...child,
    status: 'filled',
    filledTime: bar.time,
    fillPrice: trig.price,
  });
  s = cancelWhere(
    s,
    (x) => x.ocoGroup === child.ocoGroup && x.id !== child.id,
    'OCO sibling filled',
  );
  return applyFill(s, costs, {
    orderId: child.id,
    side: child.side,
    qty,
    price: trig.price,
    time: bar.time,
    role: child.role,
  });
}

/** Fill working orders against a newly revealed bar, then mark to market at its close. */
export function processBar(
  t: TradingState,
  costs: CostModel,
  bar: Bar,
  index: number,
): TradingState {
  let s = t;
  const candidates = s.orders
    .filter((o) => o.status === 'working' && o.placedIndex < index)
    .map((o) => ({ o, trig: triggerOf(o, bar, costs) }))
    .filter((c): c is { o: Order; trig: Trigger } => c.trig !== null)
    .sort((a, b) => {
      if (a.trig.atOpen !== b.trig.atOpen) return a.trig.atOpen ? -1 : 1;
      const sa = isStopLike(a.o) ? 0 : 1;
      const sb = isStopLike(b.o) ? 0 : 1;
      return sa - sb || a.o.id - b.o.id;
    });

  for (const { o: original, trig } of candidates) {
    const o = s.orders.find((x) => x.id === original.id)!;
    if (o.status !== 'working') continue;
    let qty = o.qty;
    if (o.role !== 'entry') {
      const pos = s.position;
      const reduces = pos !== null && (pos.qty > 0 ? o.side === 'sell' : o.side === 'buy');
      if (!reduces) {
        s = cancelOrder(s, o.id, 'no position to reduce');
        continue;
      }
      qty = Math.min(qty, Math.abs(pos.qty));
    }
    s = replaceOrder(s, { ...o, status: 'filled', filledTime: bar.time, fillPrice: trig.price });
    if (o.ocoGroup !== null) {
      s = cancelWhere(s, (x) => x.ocoGroup === o.ocoGroup && x.id !== o.id, 'OCO sibling filled');
    }
    s = applyFill(
      s,
      costs,
      { orderId: o.id, side: o.side, qty, price: trig.price, time: bar.time, role: o.role },
      o.stopLoss,
    );

    const pos = s.position;
    const sameDir = pos !== null && pos.qty > 0 === (o.side === 'buy');
    if (o.role === 'entry' && sameDir && (o.stopLoss !== null || o.takeProfit !== null)) {
      qty = Math.min(qty, Math.abs(pos.qty));
      let sl: Order | null = null;
      let tp: Order | null = null;
      if (o.stopLoss !== null) {
        sl = makeChild(o, 'stop-loss', qty, o.stopLoss, s.nextId, index, bar.time);
        s = { ...s, nextId: s.nextId + 1, orders: [...s.orders, sl] };
      }
      if (o.takeProfit !== null) {
        tp = makeChild(o, 'take-profit', qty, o.takeProfit, s.nextId, index, bar.time);
        s = { ...s, nextId: s.nextId + 1, orders: [...s.orders, tp] };
      }
      s = resolveEntryBarChildren(s, costs, bar, o, trig, qty, sl, tp);
    }
  }
  return { ...s, lastClose: bar.close };
}

/** Immediately close the position at `price` (used by practice rules at a bar close). */
export function forceClose(
  t: TradingState,
  costs: CostModel,
  price: number,
  time: number,
): TradingState {
  let s = cancelWhere(t, () => true, 'practice rule');
  if (!s.position) return s;
  const side: Side = s.position.qty > 0 ? 'sell' : 'buy';
  const slip = costs.slippageTicks * costs.tickSize;
  const px = roundToTick(side === 'sell' ? price - slip : price + slip, costs.tickSize);
  s = applyFill(s, costs, {
    orderId: 0,
    side,
    qty: Math.abs(s.position.qty),
    price: px,
    time,
    role: 'rule',
  });
  return s;
}
