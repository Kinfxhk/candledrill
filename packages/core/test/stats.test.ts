// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  computeStats,
  createSession,
  generateSyntheticBars,
  reportHtml,
  sessionPlaceOrder,
  sessionStats,
  stepSession,
  tradesToCsv,
  TRADE_CSV_COLUMNS,
  type SessionSettings,
  type Trade,
} from '../src/index.js';

const trade = (id: number, netPnl: number, rMultiple: number | null = null): Trade => ({
  id,
  side: 'long',
  qty: 1,
  openTime: 1_767_600_000 + id * 600,
  closeTime: 1_767_600_300 + id * 600,
  entryPrice: 100,
  exitPrice: 100 + netPnl / 50,
  grossPnl: netPnl + 4,
  commission: 4,
  netPnl,
  initialRisk: rMultiple === null ? null : Math.abs(netPnl / rMultiple),
  rMultiple,
  riskComplete: rMultiple !== null,
  firstEntryRisk: rMultiple === null ? null : Math.abs(netPnl / rMultiple),
  firstEntryR: rMultiple,
  plannedRisk: rMultiple === null ? 0 : Math.abs(netPnl / rMultiple),
  unprotectedQty: rMultiple === null ? 1 : 0,
  exitReason: 'manual',
});

describe('computeStats (golden)', () => {
  it('computes win rate, expectancy, profit factor, R and streaks', () => {
    const trades = [
      trade(1, 200, 2),
      trade(2, -100, -1),
      trade(3, -100, -1),
      trade(4, 300, 3),
      trade(5, 0),
      trade(6, 150),
    ];
    const s = computeStats({
      trades,
      startingBalance: 10_000,
      commissionPaid: 24,
      equity: 10_450,
      maxDrawdown: 250,
      maxDrawdownPct: 0.025,
    });
    expect(s).toMatchObject({
      trades: 6,
      wins: 3,
      losses: 2,
      breakeven: 1,
      winRate: 0.5,
      netPnl: 450,
      grossProfit: 650,
      grossLoss: -200,
      profitFactor: 3.25,
      avgWin: 216.67,
      avgLoss: -100,
      expectancy: 75,
      avgR: 0.75,
      tradesWithR: 4,
      largestWin: 300,
      largestLoss: -100,
      longestWinStreak: 1,
      longestLossStreak: 2,
      commissionPaid: 24,
      maxDrawdown: 250,
      endingEquity: 10_450,
    });
    expect(s.returnPct).toBeCloseTo(0.045);
  });

  it('handles an empty session', () => {
    const s = computeStats({
      trades: [],
      startingBalance: 1,
      commissionPaid: 0,
      equity: 1,
      maxDrawdown: 0,
      maxDrawdownPct: 0,
    });
    expect(s).toMatchObject({
      trades: 0,
      winRate: null,
      expectancy: null,
      profitFactor: null,
      avgR: null,
    });
  });
});

describe('drawdown tracking', () => {
  it('tracks closing-equity peak and max drawdown through the session', () => {
    const settings: SessionSettings = {
      symbol: 'SYNTH-DEMO',
      tickSize: 0.25,
      pointValue: 50,
      commissionPerContract: 0,
      slippageTicks: 0,
      startingBalance: 50_000,
      dailyLossLimit: null,
      trailingDrawdown: null,
      profitTarget: null,
      utcOffsetMinutes: 0,
      dayStartMinutes: 0,
    };
    const { bars } = generateSyntheticBars({ seed: 21, startDate: '2026-10-05', days: 1 });
    let s = createSession(bars, settings, bars[30]!.time);
    s = sessionPlaceOrder(bars, settings, s, { side: 'buy', type: 'market', qty: 1 });
    let peak = 50_000;
    let maxDd = 0;
    for (let i = 0; i < 200; i++) {
      s = stepSession(bars, settings, s, 1).state;
      const eq = 50_000 + (bars[s.cursor]!.close - s.trading.fills[0]!.price) * 50;
      peak = Math.max(peak, eq);
      maxDd = Math.max(maxDd, peak - eq);
    }
    expect(s.equityPeak).toBeCloseTo(peak, 6);
    expect(s.maxDrawdown).toBeCloseTo(maxDd, 6);
    expect(sessionStats(settings, s).maxDrawdown).toBeCloseTo(maxDd, 2);
  });
});

describe('exports', () => {
  it('writes a plain trades CSV and guards against formula injection', () => {
    const csv = tradesToCsv([trade(1, 200, 2), trade(2, -100)], '=EVIL');
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe(TRADE_CSV_COLUMNS.join(','));
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe(
      "1,'=EVIL,long,1,2026-01-05T08:10:00Z,2026-01-05T08:15:00Z,100,104,204,4,200,100,2,manual," +
        'true,100,2,100,0',
    );
    const second = lines[2]!.split(',');
    expect(second[11]).toBe(''); // no initial risk
    expect(second[12]).toBe(''); // R is N/A
    expect(second.slice(14)).toEqual(['false', '', '', '0', '1']);
  });

  it('renders an escaped, script-free HTML report', () => {
    const stats = computeStats({
      trades: [trade(1, 50)],
      startingBalance: 100,
      commissionPaid: 4,
      equity: 150,
      maxDrawdown: 0,
      maxDrawdownPct: 0,
    });
    const html = reportHtml({
      title: '<script>alert(1)</script>',
      symbol: 'SYNTH-DEMO',
      synthetic: true,
      generatedAt: '2026-10-08T00:00:00Z',
      settings: { tickSize: 0.25, dailyLossLimit: null },
      stats,
      trades: [trade(1, 50)],
      riskNotice: 'not investment advice',
      fillModel: 'stop-loss first',
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('not investment advice');
    expect(html).toContain('stop-loss first');
    expect(html).toContain('(synthetic data)');
    expect(html).toContain("default-src 'none'");
  });
});
