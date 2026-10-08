// SPDX-License-Identifier: AGPL-3.0-or-later
// End-of-data policy "keep-open": when the replay reaches the last bar, working orders are
// cancelled (they could never fill), an open position stays open and is marked to the last
// close, flatten/new orders are refused, and the reports show the open position separately.
import { describe, expect, it } from 'vitest';
import {
  createSession,
  reportHtml,
  sessionEquity,
  sessionFlatten,
  sessionPlaceOrder,
  sessionStats,
  stepSession,
  upgradeState,
  workingOrders,
  type Bar,
  type SessionSettings,
  type SessionState,
} from '../src/index.js';

const SETTINGS: SessionSettings = {
  symbol: 'SYNTH-EOD',
  tickSize: 1,
  pointValue: 1,
  commissionPerContract: 1,
  slippageTicks: 0,
  startingBalance: 10_000,
  dailyLossLimit: null,
  trailingDrawdown: null,
  profitTarget: null,
  utcOffsetMinutes: 0,
  dayStartMinutes: 0,
};
const bar = (i: number, o: number, h: number, l: number, c: number): Bar => ({
  time: i * 60,
  open: o,
  high: h,
  low: l,
  close: c,
  volume: 1,
});

describe('end of data (keep-open policy)', () => {
  it.each(['buy', 'sell'] as const)(
    'review case (%s): position filled on the last bar stays open, no stuck flatten',
    (side) => {
      const bars = [bar(0, 100, 100, 100, 100), bar(1, 100, 106, 94, 103)];
      let s = createSession(bars, SETTINGS, 60);
      s = sessionPlaceOrder(bars, SETTINGS, s, {
        side,
        type: 'market',
        qty: 1,
        stopLoss: side === 'buy' ? 90 : 110,
        takeProfit: side === 'buy' ? 110 : 90,
      });
      s = stepSession(bars, SETTINGS, s, 1).state;
      expect(s.status).toBe('finished');
      expect(s.statusReason).toBe('end of data');
      const dir = side === 'buy' ? 1 : -1;
      expect(s.trading.position).toEqual({ qty: dir, avgPrice: 100 });
      // Bracket children could never fill: cancelled with an explicit reason.
      expect(workingOrders(s.trading)).toHaveLength(0);
      expect(
        s.trading.orders.filter((o) => o.cancelReason === 'end of data').map((o) => o.role),
      ).toEqual(['stop-loss', 'take-profit']);
      // Flatten and new orders are refused instead of queueing an order that never fills.
      expect(() => sessionFlatten(bars, s)).toThrow(/end of data/);
      expect(() =>
        sessionPlaceOrder(bars, SETTINGS, s, { side: 'sell', type: 'market', qty: 1 }),
      ).toThrow(/locked|end of data/);
      // Stepping again is a no-op.
      const again = stepSession(bars, SETTINGS, s, 1);
      expect(again.revealed).toHaveLength(0);
      expect(again.state).toEqual(s);
      // Equity, stats and report agree: open P&L 3 x dir, entry commission 1 paid.
      const upnl = 3 * dir;
      expect(sessionEquity(SETTINGS, s)).toBe(10_000 - 1 + upnl);
      const st = sessionStats(SETTINGS, s);
      expect(st).toMatchObject({ trades: 0, openQty: dir, unrealizedPnl: upnl });
      expect(st.endingEquity).toBe(10_000 - 1 + upnl);
      const html = reportHtml({
        title: 't',
        symbol: 'SYNTH-EOD',
        synthetic: true,
        generatedAt: 'x',
        settings: {},
        stats: st,
        trades: [],
        riskNotice: 'n',
        fillModel: 'f',
      });
      expect(html).toContain(
        `${side === 'buy' ? 'long' : 'short'} 1, open P&amp;L ${upnl.toFixed(2)}`,
      );
    },
  );

  it('flat at the end: nothing changes and the report shows no open position', () => {
    const bars = [bar(0, 100, 100, 100, 100), bar(1, 100, 101, 99, 100), bar(2, 100, 101, 99, 100)];
    let s = createSession(bars, SETTINGS, 60);
    s = sessionPlaceOrder(bars, SETTINGS, s, { side: 'buy', type: 'limit', qty: 1, price: 90 });
    s = stepSession(bars, SETTINGS, s, 5).state;
    expect(s.status).toBe('finished');
    expect(s.trading.position).toBeNull();
    expect(s.trading.orders[0]).toMatchObject({ status: 'cancelled', cancelReason: 'end of data' });
    expect(sessionStats(SETTINGS, s).openQty).toBe(0);
  });

  it('a flatten placed on the second-to-last bar still fills on the last bar', () => {
    const bars = [
      bar(0, 100, 100, 100, 100),
      bar(1, 100, 101, 99, 100),
      bar(2, 104, 105, 103, 104),
    ];
    let s = createSession(bars, SETTINGS, 60);
    s = sessionPlaceOrder(bars, SETTINGS, s, { side: 'buy', type: 'market', qty: 1 });
    s = stepSession(bars, SETTINGS, s, 1).state;
    s = sessionFlatten(bars, s);
    s = stepSession(bars, SETTINGS, s, 1).state;
    expect(s.trading.position).toBeNull();
    expect(s.trading.trades[0]).toMatchObject({ exitPrice: 104, exitReason: 'flatten', netPnl: 2 });
  });

  it('upgrades a session finished by v0.1.0 with a stuck flatten order', () => {
    const bars = [bar(0, 100, 100, 100, 100), bar(1, 100, 101, 99, 100)];
    let s = createSession(bars, SETTINGS, 60);
    s = sessionPlaceOrder(bars, SETTINGS, s, { side: 'buy', type: 'market', qty: 1 });
    s = stepSession(bars, SETTINGS, s, 1).state;
    // Simulate the old state: a working flatten order left behind.
    const legacy: SessionState = {
      ...s,
      trading: {
        ...s.trading,
        orders: [
          ...s.trading.orders,
          {
            ...s.trading.orders[0]!,
            id: 99,
            side: 'sell',
            role: 'flatten',
            status: 'working',
            fillPrice: null,
            filledTime: null,
          },
        ],
      },
    };
    const up = upgradeState(bars, SETTINGS, legacy);
    expect(workingOrders(up.trading)).toHaveLength(0);
    expect(up.trading.position).toEqual({ qty: 1, avgPrice: 100 });
  });
});
