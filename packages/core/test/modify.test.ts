// SPDX-License-Identifier: AGPL-3.0-or-later
// Atomic bracket modification: every edit re-validates the whole bracket, is applied in
// full or rejected (state unchanged), and is logged with before/after prices.
import { describe, expect, it } from 'vitest';
import {
  emptyTrading,
  modifyOrder,
  placeOrder,
  processBar,
  workingOrders,
  OrderError,
  type Bar,
  type CostModel,
  type OrderRequest,
  type TradingState,
} from '../src/index.js';

const FREE: CostModel = { tickSize: 1, pointValue: 1, commissionPerContract: 0, slippageTicks: 0 };
const bar = (i: number, open: number, high: number, low: number, close: number): Bar => ({
  time: i * 60,
  open,
  high,
  low,
  close,
  volume: 1,
});
const place = (req: OrderRequest, t = emptyTrading(100)): TradingState =>
  placeOrder(t, FREE, req, 0, 0).trading;

describe('modifying a working entry re-validates its bracket', () => {
  it('review case: moving a buy limit below its stop-loss is rejected (state unchanged)', () => {
    const t = place({
      side: 'buy',
      type: 'limit',
      qty: 1,
      price: 99,
      stopLoss: 95,
      takeProfit: 110,
    });
    expect(() => modifyOrder(t, FREE, 1, 90)).toThrow(OrderError);
    expect(() => modifyOrder(t, FREE, 1, 90)).toThrow(/stop-loss must be below/);
    // The previously possible outcome (buy 90, "stop" at 95 above the bar high of 93)
    // cannot occur: the unmodified limit fills at the open 92, where its stop-loss 95 is
    // already crossed, so it exits at the open (fill model v2), inside the bar.
    const after = processBar(t, FREE, bar(1, 92, 93, 90, 92), 1);
    expect(after.trades[0]).toMatchObject({ entryPrice: 92, exitPrice: 92, netPnl: 0 });
  });

  it('mirror: moving a sell limit above its stop-loss is rejected', () => {
    const t = place({
      side: 'sell',
      type: 'limit',
      qty: 1,
      price: 101,
      stopLoss: 105,
      takeProfit: 90,
    });
    expect(() => modifyOrder(t, FREE, 1, 110)).toThrow(/stop-loss must be above/);
  });

  it.each([
    ['buy', 99, 95, 110, 112, /take-profit must be above/],
    ['sell', 101, 105, 90, 88, /take-profit must be below/],
  ] as const)(
    '%s: moving the entry past its take-profit is rejected',
    (side, p, sl, tp, np, msg) => {
      const t = place({ side, type: 'limit', qty: 1, price: p, stopLoss: sl, takeProfit: tp });
      expect(() => modifyOrder(t, FREE, 1, np)).toThrow(msg);
    },
  );

  it('price + new stop-loss + new take-profit in one atomic request', () => {
    const t = place({
      side: 'buy',
      type: 'limit',
      qty: 1,
      price: 99,
      stopLoss: 95,
      takeProfit: 110,
    });
    const m = modifyOrder(t, FREE, 1, { price: 90, stopLoss: 86, takeProfit: 100 }, 60);
    expect(m.orders[0]).toMatchObject({ price: 90, stopLoss: 86, takeProfit: 100 });
    expect(m.modifications).toEqual([
      {
        seq: 1,
        time: 60,
        orderId: 1,
        role: 'entry',
        before: { price: 99, stopLoss: 95, takeProfit: 110 },
        after: { price: 90, stopLoss: 86, takeProfit: 100 },
      },
    ]);
  });

  it.each([
    ['buy', 99, 95, 110, 90, [86, 101]],
    ['sell', 101, 105, 90, 110, [114, 99]],
  ] as const)('%s: shiftBracket keeps the stop/target distances', (side, p, sl, tp, np, exp) => {
    const t = place({ side, type: 'limit', qty: 1, price: p, stopLoss: sl, takeProfit: tp });
    const m = modifyOrder(t, FREE, 1, { price: np, shiftBracket: true });
    expect([m.orders[0]!.stopLoss, m.orders[0]!.takeProfit]).toEqual(exp);
  });

  it('shiftBracket rejects a bracket that would move to a non-positive price', () => {
    const t = place({ side: 'buy', type: 'limit', qty: 1, price: 50, stopLoss: 5 });
    expect(() => modifyOrder(t, FREE, 1, { price: 5, shiftBracket: true })).toThrow(/non-positive/);
  });

  it('null removes a stop-loss or take-profit; market entries validate against the last close', () => {
    const t = place({ side: 'buy', type: 'market', qty: 1, stopLoss: 95, takeProfit: 105 });
    expect(() => modifyOrder(t, FREE, 1, { price: 99 })).toThrow(/market orders have no price/);
    expect(() => modifyOrder(t, FREE, 1, { stopLoss: 101 })).toThrow(/below/);
    const m = modifyOrder(t, FREE, 1, { stopLoss: null, takeProfit: 108 });
    expect(m.orders[0]).toMatchObject({ stopLoss: null, takeProfit: 108 });
  });

  it('rejects empty changes, off-grid prices and non-working orders', () => {
    const t = place({ side: 'buy', type: 'limit', qty: 1, price: 99 });
    expect(() => modifyOrder(t, FREE, 1, {})).toThrow(/nothing to modify/);
    expect(() => modifyOrder({ ...t }, { ...FREE, tickSize: 0.25 }, 1, 99.1)).toThrow(/tick/);
    expect(() => modifyOrder(t, FREE, 9, 98)).toThrow(/not found/);
    const filled = processBar(t, FREE, bar(1, 98, 99, 97, 98), 1);
    expect(() => modifyOrder(filled, FREE, 1, 97)).toThrow(/not working/);
  });
});

describe('modifying protective children', () => {
  /** Enter long (or short) at 100 with SL/TP and leave the bracket working. */
  function opened(side: 'buy' | 'sell'): TradingState {
    const dir = side === 'buy' ? 1 : -1;
    let t = place({
      side,
      type: 'market',
      qty: 1,
      stopLoss: 100 - 5 * dir,
      takeProfit: 100 + 5 * dir,
    });
    t = processBar(t, FREE, bar(1, 100, 101, 99, 100), 1);
    expect(workingOrders(t)).toHaveLength(2);
    return t;
  }
  const idOf = (t: TradingState, role: string) => workingOrders(t).find((o) => o.role === role)!.id;

  it.each([
    ['buy', 'stop-loss', 97, 100, /below the last price/],
    ['buy', 'take-profit', 103, 99, /above the last price/],
    ['sell', 'stop-loss', 103, 100, /above the last price/],
    ['sell', 'take-profit', 97, 101, /below the last price/],
  ] as const)(
    '%s position, %s: valid move accepted, marketable move rejected',
    (side, role, ok, bad, msg) => {
      const t = opened(side);
      const id = idOf(t, role);
      const m = modifyOrder(t, FREE, id, ok, 120);
      expect(m.orders.find((o) => o.id === id)!.price).toBe(ok);
      expect(m.modifications.at(-1)).toMatchObject({ orderId: id, role, time: 120 });
      expect(() => modifyOrder(t, FREE, id, bad)).toThrow(msg);
      // Rejection leaves the original state untouched.
      expect(t.orders.find((o) => o.id === id)!.price).not.toBe(bad);
      expect(t.modifications).toHaveLength(0);
    },
  );

  it('children only accept a price', () => {
    const t = opened('buy');
    expect(() => modifyOrder(t, FREE, idOf(t, 'stop-loss'), { stopLoss: 90 })).toThrow(/price/);
  });

  it('a moved stop-loss then fills at its new price on a later bar', () => {
    const t = opened('buy');
    const m = modifyOrder(t, FREE, idOf(t, 'stop-loss'), 98);
    const after = processBar(m, FREE, bar(2, 100, 100, 97, 98), 2);
    expect(after.trades[0]).toMatchObject({ exitPrice: 98, exitReason: 'stop-loss' });
  });
});
