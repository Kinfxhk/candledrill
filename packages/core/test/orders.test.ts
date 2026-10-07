// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  emptyTrading,
  flattenAll,
  modifyOrder,
  placeOrder,
  processBar,
  cancelOrder,
  unrealizedPnl,
  workingOrders,
  OrderError,
  type Bar,
  type CostModel,
  type OrderRequest,
  type TradingState,
} from '../src/index.js';

const COSTS: CostModel = {
  tickSize: 0.25,
  pointValue: 50,
  commissionPerContract: 2,
  slippageTicks: 1,
};
const FREE: CostModel = { ...COSTS, commissionPerContract: 0, slippageTicks: 0 };

const bar = (i: number, open: number, high: number, low: number, close: number): Bar => ({
  time: 1_000_020 + i * 60,
  open,
  high,
  low,
  close,
  volume: 10,
});

/** Place `req` at bar index `at`, then process bars at indices at+1... */
function run(
  costs: CostModel,
  req: OrderRequest | OrderRequest[],
  bars: Bar[],
  at = 0,
): TradingState {
  let t = emptyTrading(100);
  for (const r of Array.isArray(req) ? req : [req])
    t = placeOrder(t, costs, r, at, bar(at, 100, 100, 100, 100).time).trading;
  bars.forEach((b, k) => (t = processBar(t, costs, b, at + 1 + k)));
  return t;
}

describe('market orders', () => {
  it('fill at the next open with adverse slippage and commission', () => {
    const t = run(COSTS, { side: 'buy', type: 'market', qty: 2 }, [bar(1, 101, 102, 100, 101.5)]);
    expect(t.fills).toHaveLength(1);
    expect(t.fills[0]).toMatchObject({ price: 101.25, qty: 2, commission: 4 });
    expect(t.position).toEqual({ qty: 2, avgPrice: 101.25 });
    expect(t.realizedPnl).toBe(-4);
    expect(unrealizedPnl(t, 50)).toBe(25); // (101.5 - 101.25) * 2 * 50
  });

  it('never fill on the bar they were placed on', () => {
    let t = emptyTrading(100);
    t = placeOrder(t, COSTS, { side: 'buy', type: 'market', qty: 1 }, 5, 0).trading;
    t = processBar(t, COSTS, bar(5, 100, 101, 99, 100), 5);
    expect(t.fills).toHaveLength(0);
    t = processBar(t, COSTS, bar(6, 100, 101, 99, 100), 6);
    expect(t.fills).toHaveLength(1);
  });
});

describe('limit and stop orders', () => {
  it('limit buy fills at the limit when touched, at the open when gapped through', () => {
    const touched = run(FREE, { side: 'buy', type: 'limit', qty: 1, price: 99 }, [
      bar(1, 100, 100.5, 99.5, 100),
      bar(2, 100, 100, 98.75, 99.5),
    ]);
    expect(touched.fills[0]).toMatchObject({ price: 99, time: bar(2, 0, 0, 0, 0).time });
    const gapped = run(FREE, { side: 'buy', type: 'limit', qty: 1, price: 99 }, [
      bar(1, 98, 98.5, 97, 98),
    ]);
    expect(gapped.fills[0]!.price).toBe(98);
  });

  it('sell limit and sell stop', () => {
    const lim = run(FREE, { side: 'sell', type: 'limit', qty: 1, price: 101 }, [
      bar(1, 100, 101.25, 99, 100),
    ]);
    expect(lim.fills[0]!.price).toBe(101);
    const stop = run(COSTS, { side: 'sell', type: 'stop', qty: 1, price: 99 }, [
      bar(1, 100, 100, 98.5, 99),
    ]);
    expect(stop.fills[0]!.price).toBe(98.75); // 99 - 1 tick slippage
    const gap = run(COSTS, { side: 'sell', type: 'stop', qty: 1, price: 99 }, [
      bar(1, 97, 98, 96, 97),
    ]);
    expect(gap.fills[0]!.price).toBe(96.75); // open 97 - slippage
  });

  it('buy stop triggers at or above the stop price', () => {
    const t = run(COSTS, { side: 'buy', type: 'stop', qty: 1, price: 101 }, [
      bar(1, 100, 100.75, 99, 100),
      bar(2, 100.5, 101, 100, 101),
    ]);
    expect(t.fills).toHaveLength(1);
    expect(t.fills[0]!.price).toBe(101.25);
  });

  it('cancel and modify working orders', () => {
    let t = placeOrder(
      emptyTrading(100),
      FREE,
      { side: 'buy', type: 'limit', qty: 1, price: 95 },
      0,
      0,
    ).trading;
    t = modifyOrder(t, FREE, 1, 99);
    expect(workingOrders(t)[0]!.price).toBe(99);
    t = cancelOrder(t, 1);
    expect(workingOrders(t)).toHaveLength(0);
    expect(() => cancelOrder(t, 1)).toThrow(OrderError);
    expect(() => modifyOrder(t, FREE, 99, 1)).toThrow(OrderError);
  });
});

describe('bracket orders', () => {
  const entry: OrderRequest = {
    side: 'buy',
    type: 'market',
    qty: 1,
    stopLoss: 98,
    takeProfit: 103,
  };

  it('take-profit fills, stop-loss is cancelled, R-multiple uses the initial risk', () => {
    const t = run(FREE, entry, [bar(1, 100, 100.5, 99.5, 100), bar(2, 101, 103.5, 100.5, 103)]);
    expect(t.trades).toHaveLength(1);
    const tr = t.trades[0]!;
    expect(tr).toMatchObject({
      side: 'long',
      entryPrice: 100,
      exitPrice: 103,
      netPnl: 150,
      exitReason: 'take-profit',
    });
    expect(tr.initialRisk).toBe(100); // (100 - 98) * 50
    expect(tr.rMultiple).toBe(1.5);
    expect(workingOrders(t)).toHaveLength(0);
    expect(t.orders.find((o) => o.role === 'stop-loss')!.status).toBe('cancelled');
  });

  it('when one bar touches both stop-loss and take-profit, the stop-loss wins', () => {
    const t = run(FREE, entry, [bar(1, 100, 100.5, 99.5, 100), bar(2, 100, 104, 97, 101)]);
    expect(t.trades[0]).toMatchObject({ exitReason: 'stop-loss', exitPrice: 98, rMultiple: -1 });
    expect(t.position).toBeNull();
  });

  it('a gap through the stop fills at the open (worse) with slippage', () => {
    const t = run(COSTS, entry, [bar(1, 100, 100.5, 99.5, 100), bar(2, 97, 97.5, 96, 97)]);
    expect(t.trades[0]).toMatchObject({ exitReason: 'stop-loss', exitPrice: 96.75 });
  });

  it('a gap through the target fills at the open (better)', () => {
    const t = run(FREE, entry, [bar(1, 100, 100.5, 99.5, 100), bar(2, 104, 105, 103.5, 104)]);
    expect(t.trades[0]).toMatchObject({ exitReason: 'take-profit', exitPrice: 104 });
  });

  it('entry bar: stop-loss touched after a limit entry -> stopped out on the same bar', () => {
    const t = run(
      FREE,
      { side: 'buy', type: 'limit', qty: 1, price: 99, stopLoss: 98, takeProfit: 101 },
      [bar(1, 100, 101.5, 97.5, 100)],
    );
    expect(t.trades[0]).toMatchObject({ exitReason: 'stop-loss', entryPrice: 99, exitPrice: 98 });
  });

  it('entry bar: take-profit only fills on the entry bar if the entry was at the open', () => {
    const atOpen = run(FREE, entry, [bar(1, 100, 103.5, 99, 103)]);
    expect(atOpen.trades[0]).toMatchObject({ exitReason: 'take-profit' });
    const limitEntry = run(
      FREE,
      { side: 'buy', type: 'limit', qty: 1, price: 99.5, stopLoss: 98, takeProfit: 101 },
      [bar(1, 100, 101.5, 99, 101)],
    );
    expect(limitEntry.trades).toHaveLength(0);
    expect(limitEntry.position).toEqual({ qty: 1, avgPrice: 99.5 });
    expect(
      workingOrders(limitEntry)
        .map((o) => o.role)
        .sort(),
    ).toEqual(['stop-loss', 'take-profit']);
  });

  it('short bracket with commission and slippage (golden numbers)', () => {
    const t = run(COSTS, { side: 'sell', type: 'market', qty: 2, stopLoss: 102, takeProfit: 97 }, [
      bar(1, 100, 100.5, 99.5, 100),
      bar(2, 99, 99.5, 96.5, 97),
    ]);
    // Entry 100 - 0.25 slip = 99.75; exit at target 97 (limit, no slippage).
    const tr = t.trades[0]!;
    expect(tr.entryPrice).toBe(99.75);
    expect(tr.exitPrice).toBe(97);
    expect(tr.grossPnl).toBe(275); // 2.75 * 2 * 50
    expect(tr.commission).toBe(8); // 2 contracts * 2 sides * 2
    expect(tr.netPnl).toBe(267);
    expect(tr.initialRisk).toBe(225); // (102 - 99.75) * 2 * 50
    expect(tr.rMultiple).toBeCloseTo(267 / 225, 4);
    expect(t.realizedPnl).toBe(267);
    expect(t.commissionPaid).toBe(8);
  });

  it('validates bracket sides, qty and tick grid', () => {
    const t = emptyTrading(100);
    const bad = (r: OrderRequest) => () => placeOrder(t, COSTS, r, 0, 0);
    expect(bad({ side: 'buy', type: 'market', qty: 1, stopLoss: 101 })).toThrow(/below/);
    expect(bad({ side: 'sell', type: 'market', qty: 1, takeProfit: 101 })).toThrow(/below/);
    expect(bad({ side: 'buy', type: 'limit', qty: 1, price: 99.1 })).toThrow(/tick/);
    expect(bad({ side: 'buy', type: 'limit', qty: 0, price: 99 })).toThrow(/qty/);
    expect(bad({ side: 'buy', type: 'stop', qty: 1 })).toThrow(/price/);
  });
});

describe('position accounting', () => {
  it('scales in, partially exits, and reverses', () => {
    let t = run(
      FREE,
      [
        { side: 'buy', type: 'market', qty: 1 },
        { side: 'buy', type: 'limit', qty: 1, price: 99 },
      ],
      [bar(1, 100, 100, 98.5, 99)],
    );
    expect(t.position).toEqual({ qty: 2, avgPrice: 99.5 });
    t = placeOrder(t, FREE, { side: 'sell', type: 'market', qty: 3 }, 1, 0).trading;
    t = processBar(t, FREE, bar(2, 101, 101, 100, 100.5), 2);
    expect(t.trades).toHaveLength(1);
    expect(t.trades[0]).toMatchObject({
      side: 'long',
      qty: 2,
      grossPnl: 150,
      exitReason: 'manual',
    });
    expect(t.position).toEqual({ qty: -1, avgPrice: 101 });
  });

  it('flatten cancels everything and closes at the next open', () => {
    let t = run(
      FREE,
      [
        { side: 'buy', type: 'market', qty: 1, stopLoss: 95 },
        { side: 'buy', type: 'limit', qty: 1, price: 90 },
      ],
      [bar(1, 100, 100, 99, 99.5)],
    );
    t = flattenAll(t, 1, 0);
    expect(workingOrders(t).map((o) => o.role)).toEqual(['flatten']);
    t = processBar(t, FREE, bar(2, 99, 99, 98, 98.5), 2);
    expect(t.position).toBeNull();
    expect(t.trades[0]).toMatchObject({ exitReason: 'flatten', netPnl: -50 });
    expect(workingOrders(t)).toHaveLength(0);
  });

  it('protective orders never flip a position', () => {
    let t = run(FREE, { side: 'buy', type: 'market', qty: 2, stopLoss: 95 }, [
      bar(1, 100, 100, 99, 99.5),
    ]);
    t = placeOrder(t, FREE, { side: 'sell', type: 'market', qty: 1 }, 1, 0).trading;
    t = processBar(t, FREE, bar(2, 99, 99, 98, 98.5), 2);
    expect(t.position).toEqual({ qty: 1, avgPrice: 100 });
    t = processBar(t, FREE, bar(3, 96, 96, 94, 94.5), 3);
    expect(t.position).toBeNull();
    expect(t.fills.at(-1)).toMatchObject({ role: 'stop-loss', qty: 1, price: 95 });
  });
});
