// SPDX-License-Identifier: AGPL-3.0-or-later
// Performance statistics for a practice session. All money values include commissions.

import type { Trade } from './orders.js';

export interface SessionStats {
  readonly trades: number;
  readonly wins: number;
  readonly losses: number;
  readonly breakeven: number;
  /** wins / trades (0..1), null without trades. */
  readonly winRate: number | null;
  readonly netPnl: number;
  readonly grossProfit: number;
  readonly grossLoss: number;
  /** grossProfit / |grossLoss|; null when there are no losing trades. */
  readonly profitFactor: number | null;
  readonly avgWin: number | null;
  readonly avgLoss: number | null;
  /** Average net P&L per trade. */
  readonly expectancy: number | null;
  /** Average R-multiple over trades that had a stop-loss at entry. */
  readonly avgR: number | null;
  readonly tradesWithR: number;
  readonly largestWin: number | null;
  readonly largestLoss: number | null;
  readonly longestWinStreak: number;
  readonly longestLossStreak: number;
  readonly commissionPaid: number;
  readonly maxDrawdown: number;
  readonly maxDrawdownPct: number;
  readonly startingBalance: number;
  readonly endingEquity: number;
  readonly returnPct: number;
}

export interface StatsInput {
  readonly trades: readonly Trade[];
  readonly startingBalance: number;
  readonly commissionPaid: number;
  readonly equity: number;
  readonly maxDrawdown: number;
  readonly maxDrawdownPct: number;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

export function computeStats(input: StatsInput): SessionStats {
  const { trades } = input;
  const wins = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl < 0);
  const grossProfit = wins.reduce((n, t) => n + t.netPnl, 0);
  const grossLoss = losses.reduce((n, t) => n + t.netPnl, 0);
  const net = trades.reduce((n, t) => n + t.netPnl, 0);
  const withR = trades.filter((t) => t.rMultiple !== null);
  let streakW = 0;
  let streakL = 0;
  let curW = 0;
  let curL = 0;
  for (const t of trades) {
    if (t.netPnl > 0) {
      curW++;
      curL = 0;
    } else if (t.netPnl < 0) {
      curL++;
      curW = 0;
    } else {
      curW = 0;
      curL = 0;
    }
    streakW = Math.max(streakW, curW);
    streakL = Math.max(streakL, curL);
  }
  const n = trades.length;
  return {
    trades: n,
    wins: wins.length,
    losses: losses.length,
    breakeven: n - wins.length - losses.length,
    winRate: n ? wins.length / n : null,
    netPnl: r2(net),
    grossProfit: r2(grossProfit),
    grossLoss: r2(grossLoss),
    profitFactor: losses.length ? Math.round((grossProfit / -grossLoss) * 1000) / 1000 : null,
    avgWin: wins.length ? r2(grossProfit / wins.length) : null,
    avgLoss: losses.length ? r2(grossLoss / losses.length) : null,
    expectancy: n ? r2(net / n) : null,
    avgR: withR.length
      ? Math.round((withR.reduce((s, t) => s + t.rMultiple!, 0) / withR.length) * 1000) / 1000
      : null,
    tradesWithR: withR.length,
    largestWin: wins.length ? r2(Math.max(...wins.map((t) => t.netPnl))) : null,
    largestLoss: losses.length ? r2(Math.min(...losses.map((t) => t.netPnl))) : null,
    longestWinStreak: streakW,
    longestLossStreak: streakL,
    commissionPaid: r2(input.commissionPaid),
    maxDrawdown: r2(input.maxDrawdown),
    maxDrawdownPct: input.maxDrawdownPct,
    startingBalance: input.startingBalance,
    endingEquity: r2(input.equity),
    returnPct: (input.equity - input.startingBalance) / input.startingBalance,
  };
}
