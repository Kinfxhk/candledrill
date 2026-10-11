// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  applyFill,
  costModel,
  createSession,
  emptyTrading,
  placeOrder,
  roundToTick,
  type Bar,
  type OrderType,
  type Side,
} from '@candledrill/core';
import { previewRisk, ticketOrder, type TicketInputs } from '../src/risk.js';

const settings = {
  symbol: 'SYNTH',
  tickSize: 0.25,
  pointValue: 50,
  commissionPerContract: 2,
  slippageTicks: 1,
  startingBalance: 50000,
  dailyLossLimit: null,
  trailingDrawdown: null,
  profitTarget: null,
  utcOffsetMinutes: 0,
  dayStartMinutes: 0,
};
const bars: Bar[] = [0, 1].map((i) => ({
  time: 1000 + i * 60,
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 1,
}));
const state = createSession(bars, settings, bars[1]!.time);
const input: TicketInputs = {
  type: 'market',
  qty: '2',
  price: '',
  stopTicks: '8',
  targetTicks: '16',
};

function available(s = settings, st = state, i = input, side: Side = 'buy') {
  const preview = previewRisk(s, st, i, side);
  expect(preview.unavailable).toBeNull();
  if (preview.unavailable !== null) throw new Error('preview unexpectedly unavailable');
  return preview;
}

describe('flat-entry ticket risk preview', () => {
  it.each(['buy', 'sell'] as const)(
    'shows cost-inclusive market risk for %s and leaves state unchanged',
    (side) => {
      const before = structuredClone(state);
      const p = available(settings, state, input, side);
      expect(p).toMatchObject({
        stopTicks: 8,
        priceRisk: 200,
        commission: 8,
        slippage: 50,
        loss: 258,
        netReward: 367,
      });
      expect(p.entry).toBe(side === 'buy' ? 100.25 : 99.75);
      expect(p.equityPercent).toBeCloseTo(0.516);
      expect(p.rewardRisk).toBeCloseTo(367 / 258);
      expect(state).toEqual(before);
    },
  );

  it('limit entries have no entry slippage and preserve one-sided order validity', () => {
    const i: TicketInputs = { ...input, type: 'limit', price: '99' };
    expect(available(settings, state, i)).toMatchObject({
      entry: 99,
      priceRisk: 200,
      slippage: 25,
      loss: 233,
      netReward: 392,
    });
    expect(previewRisk(settings, state, i, 'sell')).toEqual({ unavailable: 'invalid' });
    expect(previewRisk(settings, state, { ...i, price: '100' }, 'buy')).toEqual({
      unavailable: 'invalid',
    });
  });

  it('uses rounded ticket references, not raw fractional input distances', () => {
    const i: TicketInputs = {
      ...input,
      type: 'stop',
      price: '100.12',
      stopTicks: '1.2',
      targetTicks: '2.2',
    };
    expect(ticketOrder(settings, 100, i, 'buy')).toMatchObject({
      price: 100,
      stopLoss: 99.75,
      takeProfit: 100.5,
    });
    expect(available(settings, state, i)).toMatchObject({ stopTicks: 1, priceRisk: 25 });
  });

  it('has unavailable target metrics without a target and can show a target net loss after costs', () => {
    expect(available(settings, state, { ...input, targetTicks: '' })).toMatchObject({
      netReward: null,
      rewardRisk: null,
    });
    expect(
      available({ ...settings, commissionPerContract: 100 }, state, { ...input, targetTicks: '1' })
        .netReward,
    ).toBeLessThan(0);
  });

  it('equity percentage uses current flat equity, unavailable at zero/negative equity', () => {
    const changed = { ...state, trading: { ...state.trading, realizedPnl: -25000 } };
    expect(available(settings, changed).equityPercent).toBeCloseTo(1.032);
    for (const realizedPnl of [-50000, -60000]) {
      const p = available(settings, { ...state, trading: { ...state.trading, realizedPnl } });
      expect(p.equityPercent).toBeNull();
      expect(p.loss).toBe(258);
    }
  });

  it('never reports zero percent for non-finite equity', () => {
    for (const realizedPnl of [Infinity, NaN, 1e308]) {
      const s = { ...settings, startingBalance: 1e308 };
      const changed = { ...state, trading: { ...state.trading, realizedPnl } };
      const p = available(s, changed);
      expect(p.equityPercent).toBeNull();
      expect(p.loss).toBe(258);
    }
  });

  it('marks missing stops, existing positions, queued entries and ended sessions unavailable', () => {
    expect(previewRisk(settings, state, { ...input, stopTicks: '' }, 'buy')).toEqual({
      unavailable: 'stop',
    });
    expect(previewRisk(settings, { ...state, status: 'finished' }, input, 'buy')).toEqual({
      unavailable: 'locked',
    });
    const trading = applyFill(state.trading, costModel(settings), {
      orderId: 0,
      side: 'buy',
      qty: 1,
      price: 100,
      time: 1000,
      role: 'entry',
    });
    expect(previewRisk(settings, { ...state, trading }, input, 'buy')).toEqual({
      unavailable: 'position',
    });
    const queued = placeOrder(
      state.trading,
      costModel(settings),
      ticketOrder(settings, 100, input, 'buy'),
      0,
      1000,
    ).trading;
    expect(previewRisk(settings, { ...state, trading: queued }, input, 'buy')).toEqual({
      unavailable: 'pending',
    });
  });

  it.each([
    { qty: '' },
    { qty: '0' },
    { qty: '-1' },
    { qty: '1.5' },
    { qty: '10001' },
    { qty: 'NaN' },
    { qty: 'Infinity' },
    { stopTicks: '-1' },
    { stopTicks: '0' },
    { stopTicks: 'Infinity' },
    { targetTicks: '-1' },
    { targetTicks: 'NaN' },
    { type: 'limit' as const, price: '' },
    { type: 'stop' as const, price: '-1' },
    { type: 'stop' as const, price: 'Infinity' },
  ])('rejects invalid preview input %j', (update) => {
    expect(previewRisk(settings, state, { ...input, ...update }, 'buy')).toEqual({
      unavailable: 'invalid',
    });
  });

  it('does not turn overflowing or non-positive assumed fill prices into finite-looking estimates', () => {
    expect(previewRisk({ ...settings, pointValue: 1e308 }, state, input, 'buy')).toEqual({
      unavailable: 'invalid',
    });
    expect(previewRisk({ ...settings, slippageTicks: 1000 }, state, input, 'sell')).toEqual({
      unavailable: 'invalid',
    });
  });

  it('agrees with the engine accounting for no-gap stop/target fills across order types and sides', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<Side>('buy', 'sell'),
        fc.constantFrom<OrderType>('market', 'limit', 'stop'),
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 2, max: 40 }),
        fc.integer({ min: 0, max: 2 }),
        (side, type, qty, distance, slip) => {
          const s = { ...settings, slippageTicks: slip, commissionPerContract: 1.23456789 };
          const dir = side === 'buy' ? 1 : -1;
          const reference =
            type === 'limit' ? 100 - dir * 5 : type === 'stop' ? 100 + dir * 5 : 100;
          const i: TicketInputs = {
            type,
            qty: String(qty),
            price: String(reference),
            stopTicks: String(distance),
            targetTicks: String(distance * 2),
          };
          const req = ticketOrder(s, 100, i, side);
          const p = available(s, state, i, side);
          const entered = applyFill(emptyTrading(100), costModel(s), {
            orderId: 0,
            side,
            qty,
            price: p.entry,
            time: 1000,
            role: 'entry',
          });
          const exit = (price: number, role: 'stop-loss' | 'take-profit') =>
            applyFill(entered, costModel(s), {
              orderId: 0,
              side: side === 'buy' ? 'sell' : 'buy',
              qty,
              price,
              time: 1060,
              role,
            }).realizedPnl;
          expect(
            -exit(roundToTick(req.stopLoss! - dir * slip * s.tickSize, s.tickSize), 'stop-loss'),
          ).toBeCloseTo(p.loss, 6);
          expect(exit(req.takeProfit!, 'take-profit')).toBeCloseTo(p.netReward!, 6);
        },
      ),
      { numRuns: 150, seed: 5 },
    );
  });
});
