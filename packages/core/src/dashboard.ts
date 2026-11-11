// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Closed-trade journal statistics. Does not touch fill, rule, or indicator math.
//
// Sharpe is the per-trade mean of net P&L divided by the sample standard deviation
// (n − 1). It is not annualised. Null when there are fewer than two trades or the
// deviation is zero.
//
// Max drawdown is the largest peak-to-trough decline of cumulative closed-trade net
// P&L, starting from 0, in close-time order. It is a magnitude (>= 0). It is not the
// session equity drawdown, which includes the starting balance and lives on the session.

import type { Trade } from './orders.js';
import type { SessionSettings } from './session.js';
import { groupTrades, type GroupRow, type Journal } from './journal.js';

export interface PerformanceStats {
  readonly trades: number;
  readonly winRate: number | null;
  readonly profitFactor: number | null;
  readonly expectancy: number | null;
  /** Per-trade Sharpe (mean / sample std). Not annualised. */
  readonly sharpe: number | null;
  readonly avgWin: number | null;
  readonly avgLoss: number | null;
  readonly avgR: number | null;
  readonly maxDrawdown: number;
  readonly netPnl: number;
}

export interface DayPnl {
  /** Exchange-local close date, YYYY-MM-DD. */
  readonly date: string;
  readonly trades: number;
  readonly wins: number;
  readonly netPnl: number;
}

export interface TradeFilter {
  /** Case-insensitive substring over id, side, tags, note and review fields. */
  readonly text?: string;
  /** Case-insensitive exact tag. */
  readonly tag?: string;
  /** Case-insensitive exact setup. */
  readonly setup?: string;
  readonly direction?: 'long' | 'short' | '';
  readonly result?: 'win' | 'loss' | 'flat' | '';
  /** Inclusive exchange-local close date, YYYY-MM-DD. */
  readonly from?: string;
  readonly to?: string;
}

export interface ExcursionAverages {
  readonly avgMaeTicks: number | null;
  readonly avgMfeTicks: number | null;
  readonly avgMaeR: number | null;
  readonly avgMfeR: number | null;
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const r8 = (v: number) => Math.round(v * 1e8) / 1e8;

function ordered(trades: readonly Trade[]): Trade[] {
  return [...trades].sort((a, b) => a.closeTime - b.closeTime || a.id - b.id);
}

function maxDrawdownOf(trades: readonly Trade[]): number {
  let eq = 0;
  let peak = 0;
  let dd = 0;
  for (const t of trades) {
    eq += t.netPnl;
    if (eq > peak) peak = eq;
    dd = Math.max(dd, peak - eq);
  }
  return dd;
}

const EMPTY_STATS: PerformanceStats = {
  trades: 0,
  winRate: null,
  profitFactor: null,
  expectancy: null,
  sharpe: null,
  avgWin: null,
  avgLoss: null,
  avgR: null,
  maxDrawdown: 0,
  netPnl: 0,
};

/** Win rate, profit factor, expectancy, per-trade Sharpe, averages, drawdown, net. */
export function performanceStats(trades: readonly Trade[]): PerformanceStats {
  const n = trades.length;
  if (n === 0) return EMPTY_STATS;
  const wins = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl < 0);
  const grossProfit = wins.reduce((s, t) => s + t.netPnl, 0);
  const grossLoss = losses.reduce((s, t) => s + t.netPnl, 0);
  const net = trades.reduce((s, t) => s + t.netPnl, 0);
  const withR = trades.filter((t) => t.rMultiple !== null && Number.isFinite(t.rMultiple));
  const mean = net / n;
  let sharpe: number | null = null;
  if (n >= 2) {
    let ss = 0;
    for (const t of trades) {
      const d = t.netPnl - mean;
      ss += d * d;
    }
    const std = Math.sqrt(ss / (n - 1));
    if (std > 0) sharpe = r6(mean / std);
  }
  return {
    trades: n,
    winRate: wins.length / n,
    profitFactor: losses.length ? r3(grossProfit / -grossLoss) : null,
    expectancy: r2(mean),
    sharpe,
    avgWin: wins.length ? r2(grossProfit / wins.length) : null,
    avgLoss: losses.length ? r2(grossLoss / losses.length) : null,
    avgR: withR.length
      ? r3(withR.reduce((s, t) => s + (t.rMultiple ?? 0), 0) / withR.length)
      : null,
    maxDrawdown: r2(maxDrawdownOf(ordered(trades))),
    netPnl: r2(net),
  };
}

type Acc = { trades: number; wins: number; net: number };

function add(map: Map<string, Acc>, key: string, t: Trade): void {
  const g = map.get(key) ?? { trades: 0, wins: 0, net: 0 };
  g.trades++;
  if (t.netPnl > 0) g.wins++;
  g.net += t.netPnl;
  map.set(key, g);
}

function rowsFrom(map: Map<string, Acc>): GroupRow[] {
  return [...map.entries()]
    .sort((a, b) => {
      if (a[0] === '') return 1;
      if (b[0] === '') return -1;
      return a[0].localeCompare(b[0], 'en', { sensitivity: 'base' }) || a[0].localeCompare(b[0]);
    })
    .map(([key, g]) => ({
      key,
      trades: g.trades,
      wins: g.wins,
      netPnl: r8(g.net),
      winRate: g.wins / g.trades,
    }));
}

function fieldLabel(
  journal: Journal,
  id: number,
  field: 'setup' | 'marketCondition' | 'emotion',
): string {
  const v = journal[String(id)]?.[field];
  return typeof v === 'string' ? v.trim() : '';
}

/** A trade with several tags is counted in full in each tag. Untagged trades use "". */
export function groupByTag(trades: readonly Trade[], journal: Journal): GroupRow[] {
  const map = new Map<string, Acc>();
  for (const t of trades) {
    const tags = journal[String(t.id)]?.tags ?? [];
    if (tags.length === 0) add(map, '', t);
    else for (const tag of tags) add(map, tag, t);
  }
  return rowsFrom(map);
}

/** Missing or blank labels use "". */
export function groupByField(
  trades: readonly Trade[],
  journal: Journal,
  field: 'setup' | 'marketCondition' | 'emotion',
): GroupRow[] {
  const map = new Map<string, Acc>();
  for (const t of trades) add(map, fieldLabel(journal, t.id, field), t);
  return rowsFrom(map);
}

export function journalAggregates(
  trades: readonly Trade[],
  journal: Journal,
  settings: Pick<SessionSettings, 'utcOffsetMinutes'>,
): {
  byTag: GroupRow[];
  bySetup: GroupRow[];
  byMarketCondition: GroupRow[];
  byEmotion: GroupRow[];
  byHour: GroupRow[];
  byWeekday: GroupRow[];
} {
  return {
    byTag: groupByTag(trades, journal),
    bySetup: groupByField(trades, journal, 'setup'),
    byMarketCondition: groupByField(trades, journal, 'marketCondition'),
    byEmotion: groupByField(trades, journal, 'emotion'),
    byHour: groupTrades(trades, settings, 'hour'),
    byWeekday: groupTrades(trades, settings, 'weekday'),
  };
}

/** Exchange-local calendar date of a unix-second timestamp. */
export function localDate(time: number, utcOffsetMinutes: number): string {
  return new Date((time + utcOffsetMinutes * 60) * 1000).toISOString().slice(0, 10);
}

/** One row per exchange-local close date that has at least one trade. */
export function dailyPnl(
  trades: readonly Trade[],
  settings: Pick<SessionSettings, 'utcOffsetMinutes'>,
): DayPnl[] {
  const map = new Map<string, Acc>();
  for (const t of ordered(trades)) {
    const date = localDate(t.closeTime, settings.utcOffsetMinutes);
    const g = map.get(date) ?? { trades: 0, wins: 0, net: 0 };
    g.trades++;
    if (t.netPnl > 0) g.wins++;
    g.net += t.netPnl;
    map.set(date, g);
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, g]) => ({
      date,
      trades: g.trades,
      wins: g.wins,
      netPnl: r8(g.net),
    }));
}

function haystack(t: Trade, journal: Journal): string {
  const e = journal[String(t.id)];
  return [
    String(t.id),
    t.side,
    ...(e?.tags ?? []),
    e?.note ?? '',
    e?.setup ?? '',
    e?.marketCondition ?? '',
    e?.emotion ?? '',
    e?.planNote ?? '',
  ]
    .join('\n')
    .toLowerCase();
}

/** Keep trades matching every set filter. Empty strings do not filter. */
export function filterTrades(
  trades: readonly Trade[],
  journal: Journal,
  settings: Pick<SessionSettings, 'utcOffsetMinutes'>,
  filter: TradeFilter,
): Trade[] {
  const text = filter.text?.trim().toLowerCase() ?? '';
  const tag = filter.tag?.trim().toLowerCase() ?? '';
  const setup = filter.setup?.trim().toLowerCase() ?? '';
  return trades.filter((t) => {
    if (filter.direction && t.side !== filter.direction) return false;
    if (filter.result === 'win' && !(t.netPnl > 0)) return false;
    if (filter.result === 'loss' && !(t.netPnl < 0)) return false;
    if (filter.result === 'flat' && t.netPnl !== 0) return false;
    const date = localDate(t.closeTime, settings.utcOffsetMinutes);
    if (filter.from && date < filter.from) return false;
    if (filter.to && date > filter.to) return false;
    if (tag) {
      const tags = (journal[String(t.id)]?.tags ?? []).map((x) => x.toLowerCase());
      if (!tags.includes(tag)) return false;
    }
    if (setup && (journal[String(t.id)]?.setup ?? '').trim().toLowerCase() !== setup) return false;
    if (text && !haystack(t, journal).includes(text)) return false;
    return true;
  });
}

/** Mean MAE / MFE. R averages skip trades that had no complete stop. */
export function excursionSummary(
  rows: readonly {
    maeTicks: number;
    mfeTicks: number;
    maeR: number | null;
    mfeR: number | null;
  }[],
): ExcursionAverages {
  if (rows.length === 0)
    return { avgMaeTicks: null, avgMfeTicks: null, avgMaeR: null, avgMfeR: null };
  const avg = (xs: readonly number[]) =>
    xs.length ? r6(xs.reduce((s, v) => s + v, 0) / xs.length) : null;
  const maeR = rows.map((r) => r.maeR).filter((v): v is number => v !== null && Number.isFinite(v));
  const mfeR = rows.map((r) => r.mfeR).filter((v): v is number => v !== null && Number.isFinite(v));
  return {
    avgMaeTicks: avg(rows.map((r) => r.maeTicks)),
    avgMfeTicks: avg(rows.map((r) => r.mfeTicks)),
    avgMaeR: avg(maeR),
    avgMfeR: avg(mfeR),
  };
}
