// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSession, type Trade, type Excursion } from '@candledrill/core';
import { sessionsApi } from '../src/api.js';
import { CompletionSummary, reviewHighlights } from '../src/summary.js';

const trade = (id: number, netPnl: number, initialRisk: number | null = 10): Trade =>
  ({
    id,
    netPnl,
    initialRisk,
    rMultiple: initialRisk ? netPnl / initialRisk : null,
    commission: 0,
    qty: 1,
    side: 'long',
    openTime: 1000,
    closeTime: 1060,
    entryPrice: 100,
    exitPrice: 100 + netPnl,
  }) as Trade;
const excursion = (tradeId: number, maeR: number | null, maeTicks = 5, bars = 2): Excursion => ({
  tradeId,
  maeR,
  maeTicks,
  bars,
  mfeR: null,
  mfeTicks: 0,
});

describe('completion review ranking', () => {
  it('breaks net and MAE ties by lowest ID independently of input order', () => {
    const trades = [trade(3, -5), trade(1, -5), trade(2, 5)];
    const excursions = [excursion(3, 2), excursion(2, 2)];
    const expected = [
      { tradeId: 1, reasons: [{ metric: 'net', value: -5 }] },
      { tradeId: 2, reasons: [{ metric: 'maeR', value: 2 }] },
    ];
    expect(reviewHighlights(trades, excursions)).toEqual(expected);
    expect(reviewHighlights([...trades].reverse(), [...excursions].reverse())).toEqual(expected);
  });
  it('deduplicates the worst trade while retaining both reasons', () => {
    expect(
      reviewHighlights([trade(1, -10), trade(2, 5)], [excursion(1, 3), excursion(2, 1)]),
    ).toEqual([
      {
        tradeId: 1,
        reasons: [
          { metric: 'net', value: -10 },
          { metric: 'maeR', value: 3 },
        ],
      },
    ]);
  });
  it('selects the lowest positive net even when all trades win', () => {
    expect(reviewHighlights([trade(1, 20), trade(2, 5)], [])).toEqual([
      { tradeId: 2, reasons: [{ metric: 'net', value: 5 }] },
    ]);
  });
  it('prefers valid R over a larger tick excursion and falls back to ticks without valid risk', () => {
    const excursions = [excursion(1, null, 100), excursion(2, 2, 5)];
    expect(reviewHighlights([trade(1, -1, null), trade(2, 1)], excursions)[1]).toEqual({
      tradeId: 2,
      reasons: [{ metric: 'maeR', value: 2 }],
    });
    expect(reviewHighlights([trade(1, -1, null), trade(2, 1, 0)], excursions)).toEqual([
      {
        tradeId: 1,
        reasons: [
          { metric: 'net', value: -1 },
          { metric: 'maeTicks', value: 100 },
        ],
      },
    ]);
  });
  it('omits missing bars, unknown trades and invalid excursion metrics', () => {
    expect(
      reviewHighlights(
        [trade(1, 3, NaN)],
        [excursion(1, 100, 10, 0), excursion(9, 20, 100), excursion(1, 1, NaN)],
      ),
    ).toEqual([{ tradeId: 1, reasons: [{ metric: 'net', value: 3 }] }]);
    expect(reviewHighlights([], [excursion(9, 20)])).toEqual([]);
  });
});

class Element {
  children: (Element | string)[] = [];
  attrs: Record<string, string> = {};
  listeners: Record<string, () => void> = {};
  hidden = false;
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  addEventListener(k: string, fn: () => void) {
    this.listeners[k] = fn;
  }
  append(...children: (Element | string)[]) {
    this.children.push(...children);
  }
  replaceChildren(...children: (Element | string)[]) {
    this.children = children;
  }
  focus() {}
  querySelector(selector: string): Element | null {
    const id = selector.match(/data-testid=['"]?([^\]'" ]+)/)?.[1];
    for (const child of this.children) {
      if (!(child instanceof Element)) continue;
      if (child.attrs['data-testid'] === id) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
}
const settings = {
  symbol: 'TEST',
  tickSize: 1,
  pointValue: 1,
  commissionPerContract: 0,
  slippageTicks: 0,
  startingBalance: 50000,
  dailyLossLimit: null,
  trailingDrawdown: null,
  profitTarget: null,
  utcOffsetMinutes: 0,
  dayStartMinutes: 0,
};
const bars = [1000, 1060].map((time) => ({
  time,
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 1,
}));
const active = createSession(bars, settings, 1060);
const terminal = (trades = [trade(1, -10)]) => ({
  ...active,
  status: 'finished' as const,
  trading: { ...active.trading, trades },
});
const journal = (excursions: Excursion[] = []) => ({
  journal: {},
  excursions,
  byHour: [],
  byWeekday: [],
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
function fixture() {
  const root = new Element();
  const openJournal = vi.fn();
  const summary = new CompletionSummary(root as unknown as HTMLElement, openJournal);
  const find = (id: string) => root.querySelector(`[data-testid=${id}]`);
  return { root, summary, find, openJournal };
}
beforeEach(() => {
  vi.stubGlobal('document', { createElement: () => new Element() });
  vi.stubGlobal('localStorage', { getItem: () => 'en' });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('completion summary lifecycle', () => {
  it.each(['resolve', 'reject'] as const)('ignores stale %s after destroy', async (outcome) => {
    const old = deferred<ReturnType<typeof journal>>();
    vi.spyOn(sessionsApi, 'journal').mockReturnValue(old.promise);
    const f = fixture();
    f.summary.update(settings, terminal(), 1);
    const contents = [...f.root.children];
    f.summary.destroy();
    if (outcome === 'resolve') old.resolve(journal([excursion(1, 20)]));
    else old.reject(new Error('old failure'));
    await flush();
    expect(f.root.children).toEqual(contents);
  });
  it.each(['resolve', 'reject'] as const)(
    'ignores old session %s after a newer result',
    async (outcome) => {
      const old = deferred<ReturnType<typeof journal>>();
      vi.spyOn(sessionsApi, 'journal')
        .mockReturnValueOnce(old.promise)
        .mockResolvedValueOnce(journal([excursion(2, 2)]));
      const f = fixture();
      f.summary.update(settings, terminal(), 1);
      f.summary.update(settings, terminal([trade(2, -5)]), 2);
      await flush();
      const contents = [...f.root.children];
      if (outcome === 'resolve') old.resolve(journal([excursion(1, 20)]));
      else old.reject(new Error('old failure'));
      await flush();
      expect(f.root.children).toEqual(contents);
      expect(f.find('summary-trade-2')).not.toBeNull();
      expect(f.find('summary-trade-1')).toBeNull();
    },
  );
  it('retains the net prompt when excursion loading fails', async () => {
    vi.spyOn(sessionsApi, 'journal').mockRejectedValue(new Error('offline'));
    const f = fixture();
    f.summary.update(settings, terminal(), 1);
    await flush();
    expect(f.find('summary-trade-1')?.children.join('')).toContain('-10.00');
    expect(f.find('completion-details')).not.toBeNull();
  });
  it('expands once, preserves dismissal on refresh, reopens without refetch or API writes', async () => {
    const read = vi.spyOn(sessionsApi, 'journal').mockResolvedValue(journal());
    const write = vi.spyOn(sessionsApi, 'saveJournal');
    const f = fixture();
    const state = terminal();
    f.summary.update(settings, state, 1);
    await flush();
    expect(f.find('btn-summary')?.attrs['aria-expanded']).toBe('true');
    f.find('btn-summary')!.listeners.click!();
    f.summary.update(settings, structuredClone(state), 1);
    expect(f.find('completion-details')).toBeNull();
    expect(f.find('btn-summary')?.attrs['aria-expanded']).toBe('false');
    f.find('btn-summary')!.listeners.click!();
    expect(f.find('completion-details')).not.toBeNull();
    f.find('summary-journal')!.listeners.click!();
    expect(f.openJournal).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
    expect(state).toEqual(terminal());
  });
  it('hides active sessions and renders no-trades terminal sessions without fetching', () => {
    const read = vi.spyOn(sessionsApi, 'journal');
    const f = fixture();
    f.summary.update(settings, active, 1);
    expect(f.root.hidden).toBe(true);
    f.summary.update(settings, terminal([]), 1);
    expect(f.root.hidden).toBe(false);
    expect(f.find('completion-details')).not.toBeNull();
    expect(f.find('summary-highlights')).toBeNull();
    expect(f.find('summary-journal')).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
});
