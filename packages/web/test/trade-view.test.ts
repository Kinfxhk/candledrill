// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyFill, createSession, emptyTrading, type Bar } from '@candledrill/core';
import { sessionsApi, type SessionViewDto } from '../src/api.js';
import { tradeWindow, type Drawing } from '../src/chart.js';
import { PracticeView } from '../src/practice.js';
import type * as Format from '../src/format.js';

vi.mock('../src/format.js', async (original) => ({
  ...(await original<typeof Format>()),
  toast: vi.fn(),
}));
const settings = {
  symbol: 'SYNTH-TEST',
  tickSize: 0.25,
  pointValue: 1,
  commissionPerContract: 0,
  slippageTicks: 0,
  startingBalance: 50_000,
  dailyLossLimit: null,
  trailingDrawdown: null,
  profitTarget: null,
  utcOffsetMinutes: 0,
  dayStartMinutes: 0,
};
const bars: Bar[] = Array.from({ length: 12 }, (_, i) => ({
  time: 6000 + i * 60,
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 1,
}));
let trading = emptyTrading(100);
trading = applyFill(trading, settings, {
  orderId: 0,
  side: 'buy',
  qty: 1,
  price: 100,
  time: bars[2]!.time,
  role: 'rule',
});
trading = applyFill(trading, settings, {
  orderId: 0,
  side: 'sell',
  qty: 1,
  price: 101,
  time: bars[5]!.time,
  role: 'rule',
});
const fixture: SessionViewDto & { bars: Bar[] } = {
  session: {
    id: 1,
    datasetId: 1,
    name: 'Review',
    startTime: bars[0]!.time,
    settings,
    drawings: [{ kind: 'hline', id: 'keep', price: 100 }],
    createdAt: '',
    updatedAt: '',
  },
  state: { ...createSession(bars, settings, bars[0]!.time), cursor: 11, trading },
  cursorTime: bars[11]!.time,
  bars,
};
type Pane = {
  tf: number;
  muteUntil: number;
  chart: {
    focusInterval: ReturnType<typeof vi.fn>;
    showRecent: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    setBarSeconds: ReturnType<typeof vi.fn>;
    setBars: ReturnType<typeof vi.fn>;
    setDrawings: ReturnType<typeof vi.fn>;
  };
};
type Internals = {
  build(): void;
  resetCharts(): void;
  resetPane(pane: Pane): void;
  decorate(): void;
  focusTrade(id: number): void;
  returnToCurrent(): void;
  state: SessionViewDto['state'];
  bars: Bar[];
  cursorTime: number;
  drawings: Drawing[];
  panes: Pane[];
  playing: boolean;
  inFlight: boolean;
  reviewingTradeId?: number;
  els: { returnLive: { hidden: boolean }; reviewStatus: { textContent: string } };
  meta: SessionViewDto['session'];
};
const inside = (view: PracticeView) => view as unknown as Internals;
let view: PracticeView;
let value: Internals;
let requests: ReturnType<typeof vi.spyOn>[];
beforeEach(async () => {
  vi.stubGlobal('document', {
    getElementById: () => ({ hidden: false, replaceChildren: vi.fn() }),
    addEventListener: vi.fn(),
  });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
  vi.spyOn(PracticeView.prototype, 'render').mockImplementation(() => {});
  vi.spyOn(inside(PracticeView.prototype), 'build').mockImplementation(() => {});
  vi.spyOn(inside(PracticeView.prototype), 'resetCharts').mockImplementation(() => {});
  vi.spyOn(sessionsApi, 'open').mockResolvedValue(structuredClone(fixture));
  view = new PracticeView();
  await view.open(1);
  value = inside(view);
  value.els = { returnLive: { hidden: true }, reviewStatus: { textContent: '' } };
  value.panes = [60, 300].map((tf) => ({
    tf,
    muteUntil: 0,
    chart: {
      focusInterval: vi.fn(() => true),
      showRecent: vi.fn(),
      destroy: vi.fn(),
      setBarSeconds: vi.fn(),
      setBars: vi.fn(),
      setDrawings: vi.fn(),
    },
  }));
  requests = ['step', 'jump', 'placeOrder', 'flatten', 'saveDrawings'].map((method) =>
    vi.spyOn(sessionsApi, method as 'step'),
  );
});
afterEach(() => {
  view.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('tradeWindow', () => {
  it('uses endpoint indices and context rather than elapsed time', () => {
    expect(tradeWindow([10, 20, 100, 200, 1000, 2000], 100, 200, 1)).toEqual({ from: 1, to: 4 });
  });
  it('bounds context and gives a single bar nonzero width', () => {
    expect(tradeWindow([10, 20, 30], 10, 30)).toEqual({ from: 0, to: 2 });
    expect(tradeWindow([10], 10, 10)).toEqual({ from: 0, to: 1 });
    expect(tradeWindow([10, 20, 30], 20, 20, 0)).toEqual({ from: 1, to: 2 });
  });
  it('rejects missing history and invalid bounds or context', () => {
    for (const [start, end, context] of [
      [10, 30, 5],
      [0, 20, 5],
      [20, 10, 5],
      [NaN, 20, 5],
      [10, Infinity, 5],
      [10, 20, -1],
      [10, 20, 0.5],
    ])
      expect(tradeWindow([10, 20], start!, end!, context)).toBeNull();
    expect(tradeWindow([], 10, 20)).toBeNull();
  });
});

describe('trade focus is a chart-only review', () => {
  it('pauses, focuses each timeframe and returns to current without mutating practice data', () => {
    value.playing = true;
    const before = structuredClone({
      state: value.state,
      bars: value.bars,
      cursorTime: value.cursorTime,
      drawings: value.drawings,
    });
    value.focusTrade(1);
    expect(value.playing).toBe(false);
    expect(value.panes[0]!.chart.focusInterval).toHaveBeenCalledWith(6120, 6300);
    expect(value.panes[1]!.chart.focusInterval).toHaveBeenCalledWith(6000, 6300);
    expect(value.reviewingTradeId).toBe(1);
    expect(value.els.returnLive.hidden).toBe(false);
    expect(value.els.reviewStatus.textContent).not.toBe('');
    value.returnToCurrent();
    expect(value.reviewingTradeId).toBeUndefined();
    expect(value.els.returnLive.hidden).toBe(true);
    expect(value.els.reviewStatus.textContent).toBe('');
    for (const pane of value.panes) {
      expect(pane.chart.showRecent).toHaveBeenCalledWith(150);
      expect(pane.muteUntil).toBeGreaterThan(Date.now());
    }
    expect({
      state: value.state,
      bars: value.bars,
      cursorTime: value.cursorTime,
      drawings: value.drawings,
    }).toEqual(before);
    for (const request of requests) expect(request).not.toHaveBeenCalled();
  });
  it.each(['blind', 'history', 'busy', 'unknown'] as const)(
    'blocks %s review without changing playback or charts',
    (reason) => {
      value.playing = true;
      if (reason === 'blind')
        value.meta = { ...value.meta, settings: { ...settings, blind: { revealed: false } } };
      if (reason === 'history') value.bars = bars.slice(3);
      if (reason === 'busy') value.inFlight = true;
      value.focusTrade(reason === 'unknown' ? 99 : 1);
      expect(value.playing).toBe(true);
      expect(value.reviewingTradeId).toBeUndefined();
      for (const pane of value.panes) expect(pane.chart.focusInterval).not.toHaveBeenCalled();
      for (const request of requests) expect(request).not.toHaveBeenCalled();
    },
  );
  it('renews both panes scroll suppression before delayed timeframe refocus', () => {
    let frame!: FrameRequestCallback;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    vi.spyOn(value, 'decorate').mockImplementation(() => {});
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    value.focusTrade(1);
    expect(value.panes.map((p) => p.muteUntil)).toEqual([1200, 1200]);
    now.mockReturnValue(2000);
    const pane = value.panes[0]!;
    pane.tf = 300;
    pane.chart.focusInterval.mockClear();
    pane.chart.focusInterval.mockImplementationOnce(() => {
      expect(value.panes.map((p) => p.muteUntil)).toEqual([2200, 2200]);
      return true;
    });
    value.resetPane(pane);
    expect(pane.chart.focusInterval).not.toHaveBeenCalled();
    frame(2000);
    expect(pane.chart.focusInterval).toHaveBeenCalledWith(6000, 6300);
    expect(value.reviewingTradeId).toBe(1);
    for (const request of requests) expect(request).not.toHaveBeenCalled();
  });

  it('does not enter review when a pane cannot find both trade endpoints', () => {
    value.panes[0]!.chart.focusInterval.mockReturnValue(false);
    value.focusTrade(1);
    expect(value.reviewingTradeId).toBeUndefined();
    expect(value.els.returnLive.hidden).toBe(true);
  });
});
