// SPDX-License-Identifier: AGPL-3.0-or-later
// R-multiple risk basis: the denominator is the summed stop-loss risk of every entry fill;
// when any entry fill had no stop-loss the risk is incomplete and R is N/A (null). The
// first entry's own risk and R stay available under distinct names.
import { describe, expect, it } from 'vitest';
import {
  emptyTrading,
  placeOrder,
  processBar,
  type Bar,
  type CostModel,
  type OrderRequest,
  type TradingState,
} from '../src/index.js';

const FREE: CostModel = { tickSize: 1, pointValue: 1, commissionPerContract: 0, slippageTicks: 0 };
const COSTS: CostModel = { tickSize: 1, pointValue: 2, commissionPerContract: 1, slippageTicks: 0 };
const flat = (i: number, p: number): Bar => ({
  time: i * 60,
  open: p,
  high: p,
  low: p,
  close: p,
  volume: 1,
});

/** Run a script of [order or null, next bar price] steps; orders fill at the next open. */
function script(costs: CostModel, steps: [OrderRequest | null, number][]): TradingState {
  let t = emptyTrading(100);
  steps.forEach(([req, price], k) => {
    if (req) t = placeOrder(t, costs, req, k, k * 60).trading;
    t = processBar(t, costs, flat(k + 1, price), k + 1);
  });
  return t;
}

describe('R-multiple risk coverage', () => {
  it('single entry with a stop-loss: R = net / risk', () => {
    const t = script(FREE, [
      [{ side: 'buy', type: 'market', qty: 1, stopLoss: 90 }, 100],
      [{ side: 'sell', type: 'market', qty: 1 }, 120],
    ]);
    expect(t.trades[0]).toMatchObject({
      netPnl: 20,
      initialRisk: 10,
      rMultiple: 2,
      riskComplete: true,
      firstEntryRisk: 10,
      firstEntryR: 2,
      unprotectedQty: 0,
    });
  });

  it('review case: scale-in without a stop-loss -> R is N/A, firstEntryR keeps -10', () => {
    const t = script(FREE, [
      [{ side: 'buy', type: 'market', qty: 1, stopLoss: 90 }, 100],
      [{ side: 'buy', type: 'market', qty: 9 }, 100],
      [{ side: 'sell', type: 'market', qty: 10 }, 90],
    ]);
    const tr = t.trades[0]!;
    expect(tr).toMatchObject({
      qty: 10,
      netPnl: -100,
      initialRisk: null,
      rMultiple: null,
      riskComplete: false,
      firstEntryRisk: 10,
      firstEntryR: -10,
      plannedRisk: 10,
      unprotectedQty: 9,
    });
  });

  it('scale-in with its own stop-loss: risk is summed over both entries', () => {
    const t = script(FREE, [
      [{ side: 'buy', type: 'market', qty: 1, stopLoss: 90 }, 100],
      [{ side: 'buy', type: 'market', qty: 9, stopLoss: 95 }, 100],
      [{ side: 'sell', type: 'market', qty: 10 }, 96],
    ]);
    // The flat 100 bar never touched either stop; exit at 96 for -40 on 10 lots.
    const tr = t.trades[0]!;
    expect(tr.initialRisk).toBe(10 + 45);
    expect(tr.rMultiple).toBeCloseTo(-40 / 55, 4);
    expect(tr.riskComplete).toBe(true);
    expect(tr.firstEntryR).toBe(-4);
  });

  it('first entry without a stop, later add with one: still incomplete', () => {
    const t = script(FREE, [
      [{ side: 'buy', type: 'market', qty: 1 }, 100],
      [{ side: 'buy', type: 'market', qty: 1, stopLoss: 95 }, 100],
      [{ side: 'sell', type: 'market', qty: 2 }, 104],
    ]);
    expect(t.trades[0]).toMatchObject({
      initialRisk: null,
      rMultiple: null,
      riskComplete: false,
      firstEntryRisk: null,
      firstEntryR: null,
      plannedRisk: 5,
      unprotectedQty: 1,
    });
  });

  it('partial exits do not change the risk basis (short, with costs)', () => {
    const t = script(COSTS, [
      [{ side: 'sell', type: 'market', qty: 2, stopLoss: 110 }, 100],
      [{ side: 'buy', type: 'market', qty: 1 }, 100],
      [{ side: 'buy', type: 'market', qty: 1 }, 95],
      [null, 90],
    ]);
    const tr = t.trades[0]!;
    // Risk (110 - 100) x 2 lots x point value 2 = 40; gross (0 + 5) x 2 = 10; 4 commission.
    expect(tr.initialRisk).toBe(40);
    expect(tr.netPnl).toBe(6);
    expect(tr.rMultiple).toBeCloseTo(6 / 40, 4);
    expect(tr.riskComplete).toBe(true);
  });

  it('reversal: the new trade gets its own risk basis', () => {
    const t = script(FREE, [
      [{ side: 'buy', type: 'market', qty: 1, stopLoss: 95 }, 100],
      [{ side: 'sell', type: 'market', qty: 3, stopLoss: 108 }, 100],
      [{ side: 'buy', type: 'market', qty: 2 }, 104],
    ]);
    expect(t.trades).toHaveLength(2);
    expect(t.trades[0]).toMatchObject({ riskComplete: true, initialRisk: 5, netPnl: 0 });
    // Short 2 at 100 with stop 108: risk 16; covered at 104 -> -8 -> -0.5R.
    expect(t.trades[1]).toMatchObject({ side: 'short', initialRisk: 16, rMultiple: -0.5 });
  });
});
