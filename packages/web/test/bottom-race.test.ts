// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSession, type Bar } from '@candledrill/core';
import { sessionsApi } from '../src/api.js';
import { BottomPanel, journalTab, type BottomTab } from '../src/bottom.js';

// Minimal DOM with real parent/connectivity semantics; the tab lifecycle stays real.
class Element {
  children: (Element | string)[] = [];
  parent: Element | null = null;
  attrs: Record<string, string> = {};
  className = '';
  textContent = '';
  listeners: Record<string, () => void> = {};
  constructor(private readonly root = false) {}
  get isConnected(): boolean {
    return this.root || (this.parent?.isConnected ?? false);
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  addEventListener(k: string, fn: () => void) {
    this.listeners[k] = fn;
  }
  append(...children: (Element | string)[]) {
    for (const child of children) {
      if (child instanceof Element) child.parent = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children: (Element | string)[]) {
    for (const child of this.children) if (child instanceof Element) child.parent = null;
    this.children = [];
    this.append(...children);
  }
  replaceWith(next: Element) {
    if (!this.parent) return;
    const parent = this.parent;
    parent.children[parent.children.indexOf(this)] = next;
    next.parent = parent;
    this.parent = null;
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const result = (note = '') => ({
  journal: { '1': { tags: [], note } },
  excursions: [],
  byHour: [],
  byWeekday: [],
});
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
const bars: Bar[] = [0, 1].map((i) => ({
  time: 1000 + i * 60,
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 1,
}));
const state = createSession(bars, settings, bars[1]!.time);
const withTrades = {
  ...state,
  trading: { ...state.trading, trades: [{ id: 1, side: 'long', netPnl: 0, rMultiple: null }] },
} as unknown as typeof state;
const stats: BottomTab = {
  id: 'stats',
  key: 'pr.stats',
  render(panel) {
    panel.replaceChildren('stats content');
  },
};
function fixture() {
  const root = new Element(true);
  const bottom = new BottomPanel(root as unknown as HTMLElement, [journalTab, stats]);
  const panel = () => root.children[1] as Element;
  const switchToStats = () => {
    const tabbar = root.children[0] as Element;
    (tabbar.children[1] as Element).listeners.click!();
  };
  bottom.render(settings, withTrades, 1);
  return { root, bottom, panel, switchToStats };
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
beforeEach(() => {
  vi.stubGlobal('document', { createElement: () => new Element() });
  vi.stubGlobal('localStorage', { getItem: () => 'en' });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('journal response ownership', () => {
  it.each(['resolve', 'reject'] as const)(
    'ignores stale %s after switching tabs',
    async (outcome) => {
      const old = deferred<ReturnType<typeof result>>();
      vi.spyOn(sessionsApi, 'journal').mockReturnValue(old.promise);
      const f = fixture();
      f.switchToStats();
      if (outcome === 'resolve') old.resolve(result());
      else old.reject(new Error('old failure'));
      await flush();
      expect(f.panel().children).toEqual(['stats content']);
    },
  );

  it.each([1, 2])('keeps the newest journal for session %s', async (id) => {
    const old = deferred<ReturnType<typeof result>>();
    const current = deferred<ReturnType<typeof result>>();
    vi.spyOn(sessionsApi, 'journal')
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise);
    const f = fixture();
    f.bottom.render(settings, withTrades, id);
    current.resolve(result('current note'));
    await flush();
    const currentContents = [...f.panel().children];
    old.resolve(result('stale note'));
    await flush();
    expect(f.panel().children).toEqual(currentContents);
    const row = (f.panel().children[0] as Element).children[1] as Element;
    expect(((row.children[7] as Element).children[0] as Element).attrs.value).toBe('current note');
  });

  it('keeps the no-trades view after a session switch', async () => {
    const old = deferred<ReturnType<typeof result>>();
    vi.spyOn(sessionsApi, 'journal').mockReturnValue(old.promise);
    const f = fixture();
    f.bottom.render(settings, state, 2);
    const content = [...f.panel().children];
    old.resolve(result());
    await flush();
    expect(f.panel().children).toEqual(content);
  });

  it('shows current request failures and successful journal data', async () => {
    vi.spyOn(sessionsApi, 'journal')
      .mockRejectedValueOnce(new Error('current failure'))
      .mockResolvedValueOnce(result('live note'));
    const f = fixture();
    await flush();
    expect((f.panel().children[0] as Element).children).toEqual(['current failure']);
    f.bottom.render(settings, withTrades, 1);
    await flush();
    expect((f.panel().children[0] as Element).attrs['data-testid']).toBe('journal-table');
  });
});
