// SPDX-License-Identifier: AGPL-3.0-or-later
// A limit already at or through the last close must be rejected. Before 0.2.2, triggerOf
// treated the next open as a gap-through, so the limit filled even though price never
// traded there (a short covered by a buy limit above the market, and the long mirror).
import { describe, expect, it } from 'vitest';
import {
  emptyTrading,
  modifyOrder,
  placeOrder,
  processBar,
  OrderError,
  type Bar,
  type CostModel,
  type TradingState,
} from '../src/index.js';

const FREE: CostModel = {
  tickSize: 0.25,
  pointValue: 50,
  commissionPerContract: 0,
  slippageTicks: 0,
};

const bar = (i: number, open: number, high: number, low: number, close: number): Bar => ({
  time: 1_000_000 + i * 60,
  open,
  high,
  low,
  close,
  volume: 1,
});

function enter(side: 'buy' | 'sell'): TradingState {
  let t = emptyTrading(100);
  t = placeOrder(t, FREE, { side, type: 'market', qty: 1 }, 0, 0).trading;
  t = processBar(t, FREE, bar(1, 100, 100.5, 99.5, 100), 1);
  expect(t.position?.qty).toBe(side === 'buy' ? 1 : -1);
  expect(t.lastClose).toBe(100);
  return t;
}

describe('marketable limits are rejected', () => {
  it('short then buy limit above the last price stays short after bars that never trade it', () => {
    const t = enter('sell');
    expect(() =>
      placeOrder(t, FREE, { side: 'buy', type: 'limit', qty: 1, price: 110 }, 1, 0),
    ).toThrow(OrderError);
    expect(() =>
      placeOrder(t, FREE, { side: 'buy', type: 'limit', qty: 1, price: 110 }, 1, 0),
    ).toThrow(/already at or through the market/);
    expect(() =>
      placeOrder(t, FREE, { side: 'buy', type: 'limit', qty: 1, price: 110 }, 1, 0),
    ).toThrow(/would fill at the next open/);
    // Equal to the last price is marketable too: the next open at 100 would fill it.
    expect(() =>
      placeOrder(t, FREE, { side: 'buy', type: 'limit', qty: 1, price: 100 }, 1, 0),
    ).toThrow(/resting side/);
    let after = t;
    after = processBar(after, FREE, bar(2, 100, 100.5, 99.5, 100), 2);
    after = processBar(after, FREE, bar(3, 100, 101, 99, 100.25), 3);
    after = processBar(after, FREE, bar(4, 100.25, 102, 98, 101), 4);
    expect(after.position?.qty).toBe(-1);
    expect(after.trades).toHaveLength(0);
    expect(after.orders).toEqual(t.orders);
  });

  it('long then sell limit below the last price stays long', () => {
    const t = enter('buy');
    expect(() =>
      placeOrder(t, FREE, { side: 'sell', type: 'limit', qty: 1, price: 90 }, 1, 0),
    ).toThrow(/already at or through the market/);
    expect(() =>
      placeOrder(t, FREE, { side: 'sell', type: 'limit', qty: 1, price: 100 }, 1, 0),
    ).toThrow(/buy below the last price, sell above it/);
    let after = t;
    after = processBar(after, FREE, bar(2, 100, 100.5, 99.5, 100), 2);
    after = processBar(after, FREE, bar(3, 100, 101, 99.25, 100.5), 3);
    expect(after.position?.qty).toBe(1);
    expect(after.trades).toHaveLength(0);
  });

  it('buy limit below the market rests, then fills only when touched or truly gapped', () => {
    let rested = emptyTrading(100);
    rested = placeOrder(
      rested,
      FREE,
      { side: 'buy', type: 'limit', qty: 1, price: 90 },
      0,
      0,
    ).trading;
    rested = processBar(rested, FREE, bar(1, 100, 101, 99, 100), 1);
    rested = processBar(rested, FREE, bar(2, 100, 100.5, 98, 99), 2);
    expect(rested.fills).toHaveLength(0);
    expect(rested.position).toBeNull();
    const touched = processBar(rested, FREE, bar(3, 99, 99.5, 90, 98), 3);
    expect(touched.fills[0]).toMatchObject({ price: 90, side: 'buy' });
    expect(touched.position?.qty).toBe(1);

    let gapped = emptyTrading(100);
    gapped = placeOrder(
      gapped,
      FREE,
      { side: 'buy', type: 'limit', qty: 1, price: 99 },
      0,
      0,
    ).trading;
    gapped = processBar(gapped, FREE, bar(1, 100, 100.5, 99.5, 100), 1);
    expect(gapped.fills).toHaveLength(0);
    gapped = processBar(gapped, FREE, bar(2, 98, 98.5, 97, 98), 2);
    expect(gapped.fills[0]).toMatchObject({ price: 98, side: 'buy' });
  });

  it('sell limit above the market rests, then fills only when touched or truly gapped', () => {
    let rested = emptyTrading(100);
    rested = placeOrder(
      rested,
      FREE,
      { side: 'sell', type: 'limit', qty: 1, price: 110 },
      0,
      0,
    ).trading;
    rested = processBar(rested, FREE, bar(1, 100, 101, 99, 100), 1);
    rested = processBar(rested, FREE, bar(2, 100, 102, 99.5, 101), 2);
    expect(rested.fills).toHaveLength(0);
    const touched = processBar(rested, FREE, bar(3, 101, 110, 100.5, 109), 3);
    expect(touched.fills[0]).toMatchObject({ price: 110, side: 'sell' });
    expect(touched.position?.qty).toBe(-1);

    let gapped = emptyTrading(100);
    gapped = placeOrder(
      gapped,
      FREE,
      { side: 'sell', type: 'limit', qty: 1, price: 101 },
      0,
      0,
    ).trading;
    gapped = processBar(gapped, FREE, bar(1, 100, 100.5, 99.5, 100), 1);
    expect(gapped.fills).toHaveLength(0);
    gapped = processBar(gapped, FREE, bar(2, 102, 103, 101.5, 102.5), 2);
    expect(gapped.fills[0]).toMatchObject({ price: 102, side: 'sell' });
  });

  it('a buy stop above the market still covers a short when price trades it', () => {
    let t = enter('sell');
    t = placeOrder(t, FREE, { side: 'buy', type: 'stop', qty: 1, price: 110 }, 1, 0).trading;
    t = processBar(t, FREE, bar(2, 100, 100.5, 99.5, 100), 2);
    expect(t.position?.qty).toBe(-1);
    expect(t.trades).toHaveLength(0);
    t = processBar(t, FREE, bar(3, 100, 110, 99.75, 109), 3);
    expect(t.position).toBeNull();
    expect(t.trades[0]).toMatchObject({ side: 'short', exitPrice: 110 });
  });

  it('moving a resting limit through the last price is rejected and the order is unchanged', () => {
    const t = placeOrder(
      emptyTrading(100),
      FREE,
      { side: 'buy', type: 'limit', qty: 1, price: 95 },
      0,
      0,
    ).trading;
    expect(() => modifyOrder(t, FREE, 1, 100)).toThrow(/already at or through the market/);
    expect(() => modifyOrder(t, FREE, 1, 110)).toThrow(OrderError);
    expect(t.orders[0]!.price).toBe(95);
    expect(t.modifications).toHaveLength(0);
    const moved = modifyOrder(t, FREE, 1, 99);
    expect(moved.orders[0]!.price).toBe(99);
  });
});
