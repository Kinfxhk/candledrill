// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  createTickSim,
  stepTick,
  tickPlaceOrder,
  type CostModel,
  type Order,
  type SessionSettings,
  type Tick,
  type TickSimState,
} from '../src/index.js';

const FREE: CostModel = {
  tickSize: 0.25,
  pointValue: 50,
  commissionPerContract: 0,
  slippageTicks: 0,
};
const COSTS: CostModel = { ...FREE, commissionPerContract: 2, slippageTicks: 1 };

const BASE: SessionSettings = {
  symbol: 'SYNTH-TICK',
  tickSize: 0.25,
  pointValue: 50,
  commissionPerContract: 0,
  slippageTicks: 0,
  startingBalance: 10_000,
  dailyLossLimit: null,
  trailingDrawdown: null,
  profitTarget: null,
  utcOffsetMinutes: 0,
  dayStartMinutes: 0,
  trailingDrawdownMode: 'close',
  anchorMinutes: 0,
};

const T0 = Date.UTC(2026, 9, 5, 9, 0) / 1000;
const tick = (sec: number, price: number): Tick => ({ time: T0 + sec, price });

function buyMarket(state: TickSimState, settings = BASE, costs = FREE, price = 100): TickSimState {
  return tickPlaceOrder(
    state,
    settings,
    costs,
    { side: 'buy', type: 'market', qty: 1 },
    tick(0, price),
  );
}

describe('tick matching', () => {
  it('fills a market order immediately at the tick plus adverse slippage', () => {
    const settings = { ...BASE, slippageTicks: 1, commissionPerContract: 2 };
    let s = createTickSim(settings, 100, T0);
    s = tickPlaceOrder(s, settings, COSTS, { side: 'buy', type: 'market', qty: 2 }, tick(0, 100));
    expect(s.trading.fills).toHaveLength(1);
    expect(s.trading.fills[0]).toMatchObject({
      price: 100.25,
      qty: 2,
      commission: 4,
      role: 'entry',
    });
    expect(s.trading.position).toEqual({ qty: 2, avgPrice: 100.25 });
    expect(s.trading.lastClose).toBe(100);

    s = createTickSim(settings, 100, T0);
    s = tickPlaceOrder(s, settings, COSTS, { side: 'sell', type: 'market', qty: 1 }, tick(0, 100));
    expect(s.trading.fills[0]!.price).toBe(99.75);
    expect(s.trading.position?.qty).toBe(-1);
  });

  it('fills a resting limit at the limit, and not before the price trades there', () => {
    let s = createTickSim(BASE, 100, T0);
    s = tickPlaceOrder(
      s,
      BASE,
      FREE,
      { side: 'buy', type: 'limit', qty: 1, price: 99 },
      tick(0, 100),
    );
    expect(s.trading.fills).toHaveLength(0);
    s = stepTick(s, tick(1, 99.25), FREE, BASE);
    expect(s.trading.fills).toHaveLength(0);
    s = stepTick(s, tick(2, 99), FREE, BASE);
    expect(s.trading.fills[0]).toMatchObject({ price: 99, role: 'entry' });
    expect(s.trading.position?.qty).toBe(1);
  });

  it('fills a stop at the stop plus slippage, not at a tick beyond the stop', () => {
    const settings = { ...BASE, slippageTicks: 1 };
    let s = createTickSim(settings, 99, T0);
    s = tickPlaceOrder(
      s,
      settings,
      COSTS,
      { side: 'buy', type: 'stop', qty: 1, price: 100 },
      tick(0, 99),
    );
    expect(s.trading.fills).toHaveLength(0);
    s = stepTick(s, tick(1, 101), COSTS, settings);
    expect(s.trading.fills[0]!.price).toBe(100.25);
  });

  it('creates bracket children on the entry fill and does not evaluate them on that tick', () => {
    let s = createTickSim(BASE, 100, T0);
    s = tickPlaceOrder(
      s,
      BASE,
      FREE,
      { side: 'buy', type: 'market', qty: 1, stopLoss: 99, takeProfit: 101 },
      tick(0, 100),
    );
    expect(s.trading.position?.qty).toBe(1);
    expect(
      s.trading.orders
        .filter((o) => o.status === 'working')
        .map((o) => o.role)
        .sort(),
    ).toEqual(['stop-loss', 'take-profit']);
    expect(s.trading.trades).toHaveLength(0);
  });

  it('fills the stop-loss before the take-profit when both trigger on one tick', () => {
    let s = buyMarket(createTickSim(BASE, 100, T0));
    const sl: Order = {
      id: 10,
      side: 'sell',
      type: 'stop',
      qty: 1,
      price: 100,
      role: 'stop-loss',
      status: 'working',
      placedIndex: -1,
      placedTime: T0,
      stopLoss: null,
      takeProfit: null,
      parentId: 1,
      ocoGroup: 7,
      filledTime: null,
      fillPrice: null,
      cancelReason: null,
    };
    const tp: Order = { ...sl, id: 11, type: 'limit', role: 'take-profit' };
    s = {
      ...s,
      trading: { ...s.trading, nextId: 12, orders: [...s.trading.orders, sl, tp] },
    };
    const settings = { ...BASE, slippageTicks: 1 };
    s = stepTick(s, tick(5, 100), COSTS, settings);
    expect(s.trading.trades).toHaveLength(1);
    expect(s.trading.trades[0]).toMatchObject({ exitReason: 'stop-loss', exitPrice: 99.75 });
    expect(s.trading.orders.find((o) => o.id === 11)).toMatchObject({
      status: 'cancelled',
      cancelReason: 'OCO sibling filled',
    });
    expect(s.trading.position).toBeNull();
  });

  it('fills a bracket stop on a later tick and records R from the entry stop', () => {
    let s = createTickSim(BASE, 100, T0);
    s = tickPlaceOrder(
      s,
      BASE,
      FREE,
      { side: 'buy', type: 'market', qty: 1, stopLoss: 99, takeProfit: 103 },
      tick(0, 100),
    );
    s = stepTick(s, tick(1, 100.5), FREE, BASE);
    expect(s.trading.position).not.toBeNull();
    s = stepTick(s, tick(2, 99), FREE, BASE);
    expect(s.trading.trades[0]).toMatchObject({
      exitReason: 'stop-loss',
      exitPrice: 99,
      netPnl: -50,
      initialRisk: 50,
      rMultiple: -1,
      riskComplete: true,
    });
  });
});

describe('tick rules', () => {
  it('breaches the daily loss limit on a tick, before any bar close', () => {
    const settings = { ...BASE, dailyLossLimit: 100 };
    let s = buyMarket(createTickSim(settings, 100, T0), settings);
    s = stepTick(s, tick(1, 99), FREE, settings);
    expect(s.status).toBe('active');
    // Interior tick. A bar that closed at 101 would not breach; this tick does.
    s = stepTick(s, tick(2, 97.75), FREE, settings);
    expect(s.status).toBe('breached');
    expect(s.statusReason).toBe('daily loss limit 100');
    expect(s.trading.position).toBeNull();
    expect(s.trading.trades[0]).toMatchObject({
      exitReason: 'rule',
      exitPrice: 97.75,
      netPnl: -112.5,
    });
    expect(() =>
      tickPlaceOrder(s, settings, FREE, { side: 'buy', type: 'market', qty: 1 }, tick(3, 101)),
    ).toThrow(/locked/);
  });

  it('trails on each tick in close mode, and only at the day boundary in eod mode', () => {
    const close = { ...BASE, trailingDrawdown: 150, trailingDrawdownMode: 'close' as const };
    let s = buyMarket(createTickSim(close, 100, T0), close);
    s = stepTick(s, tick(1, 102), FREE, close);
    expect(s.equityPeak).toBe(10_100);
    s = stepTick(s, tick(2, 98), FREE, close);
    expect(s.status).toBe('breached');

    const eod = { ...BASE, trailingDrawdown: 150, trailingDrawdownMode: 'eod' as const };
    s = buyMarket(createTickSim(eod, 100, T0), eod);
    s = stepTick(s, tick(1, 102), FREE, eod);
    s = stepTick(s, tick(2, 98), FREE, eod);
    expect(s.status).toBe('active');
    expect(s.eodPeak).toBe(10_000);
  });

  it('ratchets the intraday peak on a favourable tick, then breaches on a later adverse tick', () => {
    const settings = { ...BASE, trailingDrawdown: 150, trailingDrawdownMode: 'intraday' as const };
    let s = buyMarket(createTickSim(settings, 100, T0), settings);
    s = stepTick(s, tick(1, 102), FREE, settings);
    expect(s.intradayPeak).toBe(10_100);
    expect(s.status).toBe('active');
    s = stepTick(s, tick(2, 98), FREE, settings);
    expect(s.status).toBe('breached');
    expect(s.statusReason).toBe('trailing drawdown 150');
    expect(s.trading.trades[0]!.exitReason).toBe('rule');
  });

  it('uses a static floor from the starting balance', () => {
    const settings = { ...BASE, trailingDrawdown: 150, trailingDrawdownMode: 'static' as const };
    let s = buyMarket(createTickSim(settings, 100, T0), settings);
    s = stepTick(s, tick(1, 102), FREE, settings);
    s = stepTick(s, tick(2, 98), FREE, settings);
    expect(s.status).toBe('active');
    s = stepTick(s, tick(3, 96), FREE, settings);
    expect(s.status).toBe('breached');
    expect(s.trading.trades[0]!.exitPrice).toBe(96);
  });

  it('passes the profit target on the tick that clears it, after estimated exit cost', () => {
    const settings = { ...BASE, profitTarget: 100 };
    let s = buyMarket(createTickSim(settings, 100, T0), settings);
    s = stepTick(s, tick(1, 101.75), FREE, settings);
    expect(s.status).toBe('active');
    s = stepTick(s, tick(2, 102), FREE, settings);
    expect(s.status).toBe('passed');
    expect(s.statusReason).toBe('profit target 100');
    expect(s.trading.position).toBeNull();
    expect(s.trading.trades[0]!.exitReason).toBe('rule');
  });

  it('rolls the daily-loss basis at the trading-day boundary before the new tick fills', () => {
    const settings = { ...BASE, dailyLossLimit: 100, dayStartMinutes: 17 * 60 };
    let s = buyMarket(createTickSim(settings, 100, T0), settings);
    s = stepTick(s, tick(60, 98.5), FREE, settings);
    expect(s.status).toBe('active');
    const nextDay = T0 + 8 * 3600;
    s = stepTick(s, { time: nextDay, price: 98 }, FREE, settings);
    expect(s.status).toBe('active');
    expect(s.dayStartEquity).toBe(10_000 + (98.5 - 100) * 50);
  });
});
