// SPDX-License-Identifier: AGPL-3.0-or-later
// Regression tests for bracket children created on their entry bar (fill model v2):
// a child whose price is already crossed when it becomes active fills at the first
// executable price (the bar open, or the entry price after an intrabar entry), and no
// child ever fills at a price outside the bar. Symmetric: long/short, SL/TP, gap/no gap,
// with and without costs.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  emptyTrading,
  placeOrder,
  processBar,
  workingOrders,
  type Bar,
  type CostModel,
  type OrderRequest,
  type TradingState,
} from '../src/index.js';

const FREE: CostModel = { tickSize: 1, pointValue: 1, commissionPerContract: 0, slippageTicks: 0 };
const COSTS: CostModel = { tickSize: 1, pointValue: 1, commissionPerContract: 1, slippageTicks: 1 };

const bar = (i: number, open: number, high: number, low: number, close: number): Bar => ({
  time: i * 60,
  open,
  high,
  low,
  close,
  volume: 1,
});

/** Place at bar 0 (last close 100), reveal `next` as bar 1. */
function one(costs: CostModel, req: OrderRequest, next: Bar): TradingState {
  let t = emptyTrading(100);
  t = placeOrder(t, costs, req, 0, 0).trading;
  return processBar(t, costs, next, 1);
}

interface Case {
  name: string;
  req: OrderRequest;
  bar: Bar;
  /** Expected [entry, exit, exitReason] without costs and with 1 tick slippage + 1/side. */
  free: [number, number, string];
  costs: [number, number, string];
}

const cases: Case[] = [
  // ----- long -----
  {
    name: 'long, gap through stop-loss -> exit at the open',
    req: { side: 'buy', type: 'market', qty: 1, stopLoss: 98 },
    bar: bar(1, 95, 96, 94, 95),
    free: [95, 95, 'stop-loss'],
    costs: [96, 94, 'stop-loss'],
  },
  {
    name: 'long, gap through take-profit -> exit at the open',
    req: { side: 'buy', type: 'market', qty: 1, takeProfit: 102 },
    bar: bar(1, 105, 106, 104, 105),
    free: [105, 105, 'take-profit'],
    costs: [106, 105, 'take-profit'],
  },
  {
    name: 'long, no gap, stop-loss touched later in the bar',
    req: { side: 'buy', type: 'market', qty: 1, stopLoss: 98, takeProfit: 104 },
    bar: bar(1, 100, 101, 97, 99),
    free: [100, 98, 'stop-loss'],
    costs: [101, 97, 'stop-loss'],
  },
  {
    name: 'long, no gap, take-profit touched later in the bar',
    req: { side: 'buy', type: 'market', qty: 1, stopLoss: 97, takeProfit: 102 },
    bar: bar(1, 100, 103, 99, 102),
    free: [100, 102, 'take-profit'],
    costs: [101, 102, 'take-profit'],
  },
  // ----- short (mirror) -----
  {
    name: 'short, gap through stop-loss -> exit at the open',
    req: { side: 'sell', type: 'market', qty: 1, stopLoss: 102 },
    bar: bar(1, 105, 106, 104, 105),
    free: [105, 105, 'stop-loss'],
    costs: [104, 106, 'stop-loss'],
  },
  {
    name: 'short, gap through take-profit -> exit at the open',
    req: { side: 'sell', type: 'market', qty: 1, takeProfit: 98 },
    bar: bar(1, 95, 96, 94, 95),
    free: [95, 95, 'take-profit'],
    costs: [94, 95, 'take-profit'],
  },
  {
    name: 'short, no gap, stop-loss touched later in the bar',
    req: { side: 'sell', type: 'market', qty: 1, stopLoss: 102, takeProfit: 96 },
    bar: bar(1, 100, 103, 99, 101),
    free: [100, 102, 'stop-loss'],
    costs: [99, 103, 'stop-loss'],
  },
  {
    name: 'short, no gap, take-profit touched later in the bar',
    req: { side: 'sell', type: 'market', qty: 1, stopLoss: 103, takeProfit: 98 },
    bar: bar(1, 100, 101, 97, 98),
    free: [100, 98, 'take-profit'],
    costs: [99, 98, 'take-profit'],
  },
];

describe('bracket children on the entry bar', () => {
  for (const c of cases) {
    for (const [label, costs, exp] of [
      ['no costs', FREE, c.free],
      ['with costs', COSTS, c.costs],
    ] as const) {
      it(`${c.name} (${label})`, () => {
        const t = one(costs, c.req, c.bar);
        expect(t.trades).toHaveLength(1);
        const tr = t.trades[0]!;
        expect([tr.entryPrice, tr.exitPrice, tr.exitReason]).toEqual(exp);
        // Commission is charged on both sides; slippage only moves stop/market prices.
        expect(tr.commission).toBe(2 * costs.commissionPerContract);
        const slip = costs.slippageTicks * costs.tickSize;
        expect(tr.exitPrice).toBeGreaterThanOrEqual(c.bar.low - slip);
        expect(tr.exitPrice).toBeLessThanOrEqual(c.bar.high + slip);
        expect(t.position).toBeNull();
        expect(workingOrders(t)).toHaveLength(0);
      });
    }
  }

  it('reproduces the review cases: no exit outside the bar range', () => {
    // Previously: bought 95 and "stopped" at 98 above the bar high of 96 (net +3).
    const stop = one(
      FREE,
      { side: 'buy', type: 'market', qty: 1, stopLoss: 98 },
      bar(1, 95, 96, 94, 95),
    );
    expect(stop.trades[0]).toMatchObject({ entryPrice: 95, exitPrice: 95, netPnl: 0 });
    // Previously: bought 105 and "took profit" at 102 below the bar low of 104 (net -3).
    const target = one(
      FREE,
      { side: 'buy', type: 'market', qty: 1, takeProfit: 102 },
      bar(1, 105, 106, 104, 105),
    );
    expect(target.trades[0]).toMatchObject({ entryPrice: 105, exitPrice: 105, netPnl: 0 });
  });

  it('an entry filled beyond its own stop-loss has zero planned risk, so R is N/A', () => {
    for (const [side, sl, b] of [
      ['buy', 98, bar(1, 95, 96, 94, 95)],
      ['sell', 102, bar(1, 105, 106, 104, 105)],
    ] as const) {
      const t = one(FREE, { side, type: 'market', qty: 1, stopLoss: sl }, b);
      expect(t.trades[0]).toMatchObject({ initialRisk: 0, rMultiple: null, firstEntryR: null });
    }
  });

  it('limit entry gapped through at the open, stop-loss also gapped -> both at the open', () => {
    for (const costs of [FREE, COSTS]) {
      const long = one(
        costs,
        { side: 'buy', type: 'limit', qty: 1, price: 99, stopLoss: 97 },
        bar(1, 95, 96, 94, 95),
      );
      expect(long.trades[0]).toMatchObject({ entryPrice: 95, exitReason: 'stop-loss' });
      expect(long.trades[0]!.exitPrice).toBe(95 - costs.slippageTicks);
      const short = one(
        costs,
        { side: 'sell', type: 'limit', qty: 1, price: 101, stopLoss: 103 },
        bar(1, 105, 106, 104, 105),
      );
      expect(short.trades[0]).toMatchObject({ entryPrice: 105, exitReason: 'stop-loss' });
      expect(short.trades[0]!.exitPrice).toBe(105 + costs.slippageTicks);
    }
  });

  it('intrabar entry: stop-loss may fill (conservative), take-profit may not', () => {
    // Long limit at 99 inside a wide bar: the low may have come after the entry.
    const long = one(
      FREE,
      { side: 'buy', type: 'limit', qty: 1, price: 99, stopLoss: 97, takeProfit: 103 },
      bar(1, 100, 104, 96, 100),
    );
    expect(long.trades[0]).toMatchObject({
      entryPrice: 99,
      exitPrice: 97,
      exitReason: 'stop-loss',
    });
    const short = one(
      FREE,
      { side: 'sell', type: 'limit', qty: 1, price: 101, stopLoss: 103, takeProfit: 97 },
      bar(1, 100, 104, 96, 100),
    );
    expect(short.trades[0]).toMatchObject({
      entryPrice: 101,
      exitPrice: 103,
      exitReason: 'stop-loss',
    });
    // Stop-loss not reached: the take-profit stays working even though the bar touched it.
    for (const [req, b] of [
      [
        { side: 'buy', type: 'limit', qty: 1, price: 99, stopLoss: 97, takeProfit: 103 },
        bar(1, 100, 104, 98, 100),
      ],
      [
        { side: 'sell', type: 'limit', qty: 1, price: 101, stopLoss: 103, takeProfit: 97 },
        bar(1, 100, 102, 96, 100),
      ],
    ] as const) {
      const t = one(FREE, req, b);
      expect(t.trades).toHaveLength(0);
      expect(
        workingOrders(t)
          .map((o) => o.role)
          .sort(),
      ).toEqual(['stop-loss', 'take-profit']);
    }
  });

  it('intrabar stop entry with slippage: stop-loss fills at its price when reached', () => {
    const t = one(
      COSTS,
      { side: 'buy', type: 'stop', qty: 1, price: 102, stopLoss: 100 },
      bar(1, 101, 103, 99, 101),
    );
    // Entry 102 + 1 slip; stop-loss 100 - 1 slip.
    expect(t.trades[0]).toMatchObject({ entryPrice: 103, exitPrice: 99, exitReason: 'stop-loss' });
  });
});

describe('property: no fill outside what the bar model allows', () => {
  const reqArb = fc.record({
    side: fc.constantFrom('buy' as const, 'sell' as const),
    type: fc.constantFrom('market' as const, 'limit' as const, 'stop' as const),
    qty: fc.integer({ min: 1, max: 3 }),
    off: fc.integer({ min: -8, max: 8 }),
    sl: fc.integer({ min: 0, max: 10 }),
    tp: fc.integer({ min: 0, max: 10 }),
  });
  const barArb = fc
    .record({
      open: fc.integer({ min: 80, max: 120 }),
      up: fc.integer({ min: 0, max: 8 }),
      down: fc.integer({ min: 0, max: 8 }),
      closeFrac: fc.double({ min: 0, max: 1, noNaN: true }),
    })
    .map(({ open, up, down, closeFrac }) => {
      const high = open + up;
      const low = Math.max(1, open - down);
      return { open, high, low, close: Math.round(low + (high - low) * closeFrac) };
    });

  it('every fill price lies within [low, high] (stop/market fills: +/- slippage)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.option(reqArb, { nil: null }), barArb), {
          minLength: 1,
          maxLength: 25,
        }),
        fc.constantFrom(FREE, COSTS),
        (steps, costs) => {
          let t = emptyTrading(100);
          const bars: Bar[] = [bar(0, 100, 100, 100, 100)];
          steps.forEach(([req, b], k) => {
            const i = k + 1;
            if (req) {
              const ref = t.lastClose;
              const dir = req.side === 'buy' ? 1 : -1;
              const price = req.type === 'market' ? null : ref + req.off;
              const entryRef = price ?? ref;
              try {
                t = placeOrder(
                  t,
                  costs,
                  {
                    side: req.side,
                    type: req.type,
                    qty: req.qty,
                    price,
                    stopLoss: req.sl > 0 ? entryRef - dir * req.sl : null,
                    takeProfit: req.tp > 0 ? entryRef + dir * req.tp : null,
                  },
                  i - 1,
                  bars[i - 1]!.time,
                ).trading;
              } catch {
                // invalid combination (e.g. non-positive price): skip
              }
            }
            const nb = bar(i, b.open, b.high, b.low, b.close);
            bars.push(nb);
            t = processBar(t, costs, nb, i);
          });
          const slip = costs.slippageTicks * costs.tickSize;
          for (const f of t.fills) {
            const b = bars.find((x) => x.time === f.time)!;
            const o = t.orders.find((x) => x.id === f.orderId)!;
            const pad = o.type === 'limit' ? 0 : slip;
            expect(f.price).toBeGreaterThanOrEqual(b.low - pad);
            expect(f.price).toBeLessThanOrEqual(b.high + pad);
            // Adverse slippage only ever makes the fill worse, never better than the bar.
            if (o.type !== 'limit') {
              if (f.side === 'buy') expect(f.price).toBeGreaterThanOrEqual(b.low);
              else expect(f.price).toBeLessThanOrEqual(b.high);
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
