// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  dailyPnl,
  excursionSummary,
  filterTrades,
  groupByField,
  groupByTag,
  journalAggregates,
  journalEntryBlank,
  journalEntryIssues,
  journalIssues,
  MAX_JOURNAL_LABEL,
  normalizeJournalEntry,
  performanceStats,
  type Journal,
  type Trade,
} from '../src/index.js';

const trade = (id: number, netPnl: number, extra: Partial<Trade> = {}): Trade => ({
  id,
  side: 'long',
  qty: 1,
  openTime: 1_705_312_200 + id,
  closeTime: 1_705_312_200 + id,
  entryPrice: 100,
  exitPrice: 100,
  grossPnl: netPnl,
  commission: 0,
  netPnl,
  initialRisk: extra.rMultiple === undefined ? null : 50,
  rMultiple: null,
  riskComplete: extra.rMultiple !== undefined && extra.rMultiple !== null,
  firstEntryRisk: null,
  firstEntryR: null,
  plannedRisk: 0,
  unprotectedQty: 1,
  exitReason: 'manual',
  ...extra,
});

describe('journal entry fields', () => {
  const base = { tags: ['orb'], note: 'ok' };

  it('accepts a legacy tags-and-note entry and the new optional fields', () => {
    expect(journalEntryIssues(base)).toEqual([]);
    expect(
      journalEntryIssues({
        ...base,
        setup: 'ORB',
        marketCondition: 'trend',
        emotion: 'disciplined',
        planFollowed: false,
        planNote: 'moved the stop',
      }),
    ).toEqual([]);
    expect(journalEntryIssues({ ...base, setup: null, planFollowed: null })).toEqual([]);
  });

  it('rejects unknown fields, over-long labels, control characters and a non-boolean plan', () => {
    expect(journalEntryIssues({ ...base, mood: 'fine' })).toContain('entry: unknown field');
    expect(journalEntryIssues({ ...base, setup: 'x'.repeat(MAX_JOURNAL_LABEL + 1) })).toContain(
      `setup: up to ${MAX_JOURNAL_LABEL} characters, no control characters`,
    );
    expect(journalEntryIssues({ ...base, emotion: 'fo\u0007mo' })).toContain(
      `emotion: up to ${MAX_JOURNAL_LABEL} characters, no control characters`,
    );
    expect(journalEntryIssues({ ...base, planFollowed: 'yes' })).toContain(
      'planFollowed: boolean or null',
    );
    expect(journalIssues({ '1': { ...base, setup: 3 } }, [trade(1, 1)])).toEqual([
      'journal 1: setup: up to 80 characters, no control characters',
    ]);
  });

  it('omits blank optional fields and keeps a deliberate false planFollowed', () => {
    expect(
      normalizeJournalEntry({
        tags: [' ORB ', 'orb'],
        note: '  waited  ',
        setup: '  ',
        marketCondition: null,
        emotion: ' fomo ',
        planFollowed: false,
        planNote: '',
      }),
    ).toEqual({
      tags: ['ORB'],
      note: 'waited',
      emotion: 'fomo',
      planFollowed: false,
    });
    expect(journalEntryBlank(normalizeJournalEntry({ tags: [], note: '  ' }))).toBe(true);
    expect(
      journalEntryBlank(normalizeJournalEntry({ tags: [], note: '', planFollowed: false })),
    ).toBe(false);
  });
});

describe('performanceStats', () => {
  it('computes win rate, profit factor, expectancy, Sharpe, R and drawdown', () => {
    // +100, −50, +50. Cumulative from 0: 100, 50, 100. Peak-to-trough = 50.
    // mean = 100/3, sample variance = (105000/9)/2, Sharpe = (100/3) / sqrt(17500/3).
    const trades = [
      trade(1, 100, { rMultiple: 2, closeTime: 30, openTime: 10 }),
      trade(2, -50, { rMultiple: -1, closeTime: 10, openTime: 1 }),
      trade(3, 50, { closeTime: 20, openTime: 5 }),
    ];
    const s = performanceStats(trades);
    expect(s.trades).toBe(3);
    expect(s.winRate).toBeCloseTo(2 / 3);
    expect(s.profitFactor).toBe(3);
    expect(s.expectancy).toBe(33.33);
    expect(s.avgWin).toBe(75);
    expect(s.avgLoss).toBe(-50);
    expect(s.avgR).toBe(0.5);
    expect(s.netPnl).toBe(100);
    expect(s.maxDrawdown).toBe(50);
    expect(s.sharpe).toBeCloseTo(0.436436, 6);
  });

  it('returns nulls for an empty list, a lone trade, and zero deviation', () => {
    expect(performanceStats([])).toMatchObject({
      trades: 0,
      winRate: null,
      profitFactor: null,
      sharpe: null,
      maxDrawdown: 0,
      netPnl: 0,
    });
    expect(performanceStats([trade(1, 40)]).sharpe).toBeNull();
    expect(performanceStats([trade(1, 40)]).profitFactor).toBeNull();
    expect(performanceStats([trade(1, 10), trade(2, 10)]).sharpe).toBeNull();
    // First trade loses 100 from a flat start, then recovers 40. Drawdown stays 100.
    expect(
      performanceStats([trade(1, -100, { closeTime: 1 }), trade(2, 40, { closeTime: 2 })])
        .maxDrawdown,
    ).toBe(100);
  });
});

describe('journal aggregations, calendar and filter', () => {
  // 2024-01-15 09:30:00 UTC is a Monday. Offset −600 crosses into Sunday the 14th.
  const monday = Date.UTC(2024, 0, 15, 9, 30) / 1000;
  const tuesday = Date.UTC(2024, 0, 16, 14, 0) / 1000;
  const trades = [
    trade(1, 100, { openTime: monday, closeTime: monday, side: 'long' }),
    trade(2, -40, { openTime: monday + 3600, closeTime: tuesday, side: 'short' }),
    trade(3, 10, { openTime: tuesday, closeTime: tuesday + 60, side: 'long' }),
  ];
  const journal: Journal = {
    '1': {
      tags: ['breakout', 'ORB'],
      note: 'clean',
      setup: 'ORB',
      marketCondition: 'trend',
      emotion: 'disciplined',
      planFollowed: true,
    },
    '2': {
      tags: ['breakout'],
      note: 'chased',
      setup: 'ORB',
      marketCondition: 'news',
      emotion: 'fomo',
      planFollowed: false,
      planNote: 'late entry',
    },
  };

  it('counts a multi-tag trade in each tag and buckets missing labels as empty', () => {
    expect(groupByTag(trades, journal)).toEqual([
      { key: 'breakout', trades: 2, wins: 1, netPnl: 60, winRate: 0.5 },
      { key: 'ORB', trades: 1, wins: 1, netPnl: 100, winRate: 1 },
      { key: '', trades: 1, wins: 1, netPnl: 10, winRate: 1 },
    ]);
    expect(groupByField(trades, journal, 'setup')).toEqual([
      { key: 'ORB', trades: 2, wins: 1, netPnl: 60, winRate: 0.5 },
      { key: '', trades: 1, wins: 1, netPnl: 10, winRate: 1 },
    ]);
    expect(groupByField(trades, journal, 'emotion').map((r) => r.key)).toEqual([
      'disciplined',
      'fomo',
      '',
    ]);
    const groups = journalAggregates(trades, journal, { utcOffsetMinutes: 0 });
    expect(groups.byHour.map((r) => r.key)).toEqual(['09', '10', '14']);
    expect(groups.byWeekday.map((r) => [r.key, r.trades])).toEqual([
      ['Mon', 2],
      ['Tue', 1],
    ]);
  });

  it('builds a daily P&L calendar from the exchange-local close date', () => {
    expect(dailyPnl(trades, { utcOffsetMinutes: 0 })).toEqual([
      { date: '2024-01-15', trades: 1, wins: 1, netPnl: 100 },
      { date: '2024-01-16', trades: 2, wins: 1, netPnl: -30 },
    ]);
    expect(dailyPnl([trades[0]!], { utcOffsetMinutes: -600 })[0]).toMatchObject({
      date: '2024-01-14',
      netPnl: 100,
    });
  });

  it('filters by text, tag, setup, direction, result and close date', () => {
    const settings = { utcOffsetMinutes: 0 };
    expect(filterTrades(trades, journal, settings, { text: 'LATE' }).map((t) => t.id)).toEqual([2]);
    expect(filterTrades(trades, journal, settings, { tag: 'orb' }).map((t) => t.id)).toEqual([1]);
    expect(
      filterTrades(trades, journal, settings, { setup: 'orb', result: 'loss' }).map((t) => t.id),
    ).toEqual([2]);
    expect(
      filterTrades(trades, journal, settings, { direction: 'short' }).map((t) => t.id),
    ).toEqual([2]);
    expect(
      filterTrades(trades, journal, settings, { from: '2024-01-16', to: '2024-01-16' }).map(
        (t) => t.id,
      ),
    ).toEqual([2, 3]);
    expect(filterTrades(trades, journal, settings, { result: 'flat' })).toEqual([]);
  });

  it('averages MAE and MFE and skips incomplete R', () => {
    expect(
      excursionSummary([
        { maeTicks: 4, mfeTicks: 8, maeR: 1, mfeR: 2 },
        { maeTicks: 2, mfeTicks: 4, maeR: null, mfeR: null },
      ]),
    ).toEqual({ avgMaeTicks: 3, avgMfeTicks: 6, avgMaeR: 1, avgMfeR: 2 });
    expect(excursionSummary([])).toEqual({
      avgMaeTicks: null,
      avgMfeTicks: null,
      avgMaeR: null,
      avgMfeR: null,
    });
  });
});
