// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSession, type Bar, type Order } from '@candledrill/core';
import { sessionsApi, type SessionViewDto } from '../src/api.js';
import { PracticeView } from '../src/practice.js';
import type { Drawing } from '../src/chart.js';
import type * as Format from '../src/format.js';

vi.mock('../src/format.js', async (original) => ({
  ...(await original<typeof Format>()),
  toast: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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
  trailingDrawdownMode: 'close' as const,
  anchorMinutes: 0,
};
const bar = (time: number): Bar => ({ time, open: 100, high: 101, low: 99, close: 100, volume: 1 });
function fixture(id: number, time: number): SessionViewDto & { bars: Bar[] } {
  const bars = [bar(time), bar(time + 60)];
  return {
    session: {
      id,
      datasetId: id,
      name: `Session ${id}`,
      startTime: time + 60,
      settings,
      drawings: [],
      createdAt: '',
      updatedAt: '',
    },
    state: createSession(bars, settings, time + 60),
    cursorTime: time,
    bars: bars.slice(0, 1),
  };
}
const a = fixture(1, 1_000);
const b = fixture(2, 10_000);
const stepped = (v: typeof a) => ({
  ...v,
  state: { ...v.state, cursor: 1 },
  cursorTime: v.cursorTime + 60,
  revealed: [bar(v.cursorTime + 60)],
});

// Stub rendering only: requests, lifecycle, state changes and bar insertion stay real.
type ViewInternals = {
  build(): void;
  resetCharts(): void;
  state: SessionViewDto['state'] | undefined;
  bars: Bar[];
  cursorTime: number;
  drawings: Drawing[];
  playing: boolean;
  panes: {
    chart: { updateBar(bar: Bar): void; destroy(): void };
    agg: { push(bar: Bar): { bar: Bar } };
  }[];
  els: Record<string, unknown>;
  jump(): Promise<void>;
  reveal(): Promise<void>;
  modifyOrderPrice(orderId: number, price: number): Promise<void>;
  mutate(fn: () => Promise<SessionViewDto>): Promise<void>;
  saveDrawings(drawings: Drawing[]): Promise<void>;
};
function internals(view: PracticeView): ViewInternals {
  return view as unknown as ViewInternals;
}

beforeEach(() => {
  const node = { hidden: false, replaceChildren: vi.fn() };
  vi.stubGlobal('document', { getElementById: () => node, addEventListener: vi.fn() });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
  vi.stubGlobal('confirm', () => true);
  vi.spyOn(PracticeView.prototype, 'render').mockImplementation(() => {});
  vi.spyOn(internals(PracticeView.prototype), 'build').mockImplementation(() => {});
  vi.spyOn(internals(PracticeView.prototype), 'resetCharts').mockImplementation(() => {});
  vi.spyOn(sessionsApi, 'open').mockImplementation(async (id) => structuredClone(id === 1 ? a : b));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('practice request ownership', () => {
  it('ignores an old step and its finally while the new session is stepping', async () => {
    const old = deferred<ReturnType<typeof stepped>>();
    const current = deferred<ReturnType<typeof stepped>>();
    const step = vi.spyOn(sessionsApi, 'step');
    step.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const view = new PracticeView();
    await view.open(1);
    const pendingA = view.step(1);
    await view.open(2);
    const pendingB = view.step(1);
    expect(step.mock.calls.map(([id]) => id)).toEqual([1, 2]);
    old.resolve(stepped(a));
    await pendingA;
    expect(view.sessionId).toBe(2);
    expect(internals(view).bars).toEqual(b.bars);
    expect(internals(view).cursorTime).toBe(b.cursorTime);
    await view.step(1);
    expect(step).toHaveBeenCalledTimes(2); // A's finally must not unlock B's request.
    current.resolve(stepped(b));
    await pendingB;
    expect(internals(view).bars).toEqual([...b.bars, bar(10_060)]);
    expect(internals(view).cursorTime).toBe(10_060);
    view.close();
  });

  it('ignores out-of-order opens, including reopening the same session', async () => {
    const old = deferred<typeof a>();
    const open = vi.mocked(sessionsApi.open);
    open.mockReturnValueOnce(old.promise).mockResolvedValueOnce(b).mockResolvedValueOnce(a);
    const view = new PracticeView();
    const first = view.open(1);
    await view.open(2);
    await view.open(1);
    old.resolve({ ...a, cursorTime: 999, bars: [bar(999)] });
    await first;
    expect(view.sessionId).toBe(1);
    expect(internals(view).cursorTime).toBe(a.cursorTime);
    expect(internals(view).bars).toEqual(a.bars);
    view.close();
  });

  it('does not resurrect a closed view when an open finishes', async () => {
    const old = deferred<typeof a>();
    vi.mocked(sessionsApi.open).mockReturnValueOnce(old.promise);
    const view = new PracticeView();
    const pending = view.open(1);
    view.close();
    old.resolve(a);
    await pending;
    expect(view.sessionId).toBeUndefined();
  });

  it('ignores an old order response after switching', async () => {
    const old = deferred<SessionViewDto>();
    vi.spyOn(sessionsApi, 'placeOrder').mockReturnValueOnce(old.promise);
    const view = new PracticeView();
    await view.open(1);
    const pending = view.placeOrder({ side: 'buy', type: 'market', qty: 1 });
    await view.open(2);
    old.resolve(stepped(a));
    await pending;
    expect(internals(view).state).toEqual(b.state);
    expect(internals(view).cursorTime).toBe(b.cursorTime);
    view.close();
  });

  it('ignores old drawing and reveal responses', async () => {
    const drawing = deferred<{ drawings: unknown[] }>();
    const reveal = deferred<SessionViewDto>();
    vi.spyOn(sessionsApi, 'saveDrawings').mockReturnValueOnce(drawing.promise);
    vi.spyOn(sessionsApi, 'reveal').mockReturnValueOnce(reveal.promise);
    const view = new PracticeView();
    await view.open(1);
    const pendingDrawing = internals(view).saveDrawings([{ kind: 'hline', id: 'a', price: 100 }]);
    const pendingReveal = internals(view).reveal();
    await view.open(2);
    drawing.resolve({ drawings: [{ kind: 'hline', id: 'a', price: 100 }] });
    reveal.resolve(a);
    await Promise.all([pendingDrawing, pendingReveal]);
    expect(view.sessionId).toBe(2);
    expect(internals(view).drawings).toEqual([]);
    view.close();
  });

  it('does not reload the new session because an old jump was truncated', async () => {
    const old = deferred<ReturnType<typeof stepped> & { truncated: boolean }>();
    vi.spyOn(sessionsApi, 'jump').mockReturnValueOnce(old.promise);
    const view = new PracticeView();
    await view.open(1);
    internals(view).els.jumpInput = { value: '2026-01-05T00:00' };
    const pending = internals(view).jump();
    await view.open(2);
    old.resolve({ ...stepped(a), truncated: true });
    await pending;
    expect(sessionsApi.open).toHaveBeenCalledTimes(2);
    expect(internals(view).bars).toEqual(b.bars);
    view.close();
  });

  it('does not let an old failed step pause playback of the new session', async () => {
    vi.useFakeTimers();
    const old = deferred<ReturnType<typeof stepped>>();
    vi.spyOn(sessionsApi, 'step').mockReturnValueOnce(old.promise);
    const view = new PracticeView();
    await view.open(1);
    const pending = view.step(1);
    await view.open(2);
    view.play();
    old.reject(new Error('old session failed'));
    await pending;
    expect(internals(view).playing).toBe(true);
    view.close();
  });
});

const stopOrder = (time: number): Order => ({
  id: 7,
  side: 'sell',
  type: 'stop',
  qty: 1,
  price: 90,
  role: 'stop-loss',
  status: 'working',
  placedIndex: 0,
  placedTime: time,
  stopLoss: null,
  takeProfit: null,
  parentId: null,
  ocoGroup: null,
  filledTime: null,
  fillPrice: null,
  cancelReason: null,
});

function withPnl<T extends SessionViewDto>(view: T, realizedPnl: number): T {
  return {
    ...view,
    state: { ...view.state, trading: { ...view.state.trading, realizedPnl } },
  };
}

/** A forming step: 2–12 source bars, so the chart paints on a timer instead of all at once. */
function formingStep(marker: number) {
  const count = 6;
  const revealed = Array.from({ length: count }, (_, i) => bar(a.cursorTime + 60 * (i + 1)));
  const base = structuredClone(a);
  return {
    ...base,
    cursorTime: a.cursorTime + 60 * count,
    state: {
      ...base.state,
      cursor: count,
      trading: {
        ...base.state.trading,
        realizedPnl: marker,
        orders: [stopOrder(a.cursorTime)],
      },
    },
    revealed,
  };
}

describe('forming paint does not overwrite newer session state', () => {
  it('keeps a cancel that lands while the forming candle is still painting', async () => {
    vi.useFakeTimers();
    const stepped = formingStep(0);
    vi.spyOn(sessionsApi, 'step').mockResolvedValue(structuredClone(stepped));
    const view = new PracticeView();
    await view.open(1);
    const painted: Bar[] = [];
    internals(view).panes.push({
      chart: {
        updateBar: (b) => painted.push(b),
        destroy: () => {},
      },
      agg: { push: (b) => ({ bar: b }) },
    });
    await view.step(1);
    expect(internals(view).bars).toHaveLength(a.bars.length + 6);
    expect(internals(view).cursorTime).toBe(stepped.cursorTime);
    expect(painted).toHaveLength(1);

    const cancelled = withPnl(structuredClone(stepped), 77);
    vi.spyOn(sessionsApi, 'cancelOrder').mockResolvedValue(cancelled);
    await internals(view).mutate(() => sessionsApi.cancelOrder(1, 7));
    expect(internals(view).state?.trading.realizedPnl).toBe(77);

    await vi.runAllTimersAsync();
    expect(painted).toHaveLength(6);
    expect(internals(view).state?.trading.realizedPnl).toBe(77);
    expect(internals(view).cursorTime).toBe(stepped.cursorTime);
    view.close();
  });

  it('keeps an order edit that lands while the forming candle is still painting', async () => {
    vi.useFakeTimers();
    const stepped = formingStep(0);
    vi.spyOn(sessionsApi, 'step').mockResolvedValue(structuredClone(stepped));
    const view = new PracticeView();
    await view.open(1);
    await view.step(1);

    const edited = withPnl(structuredClone(stepped), 42);
    vi.spyOn(sessionsApi, 'modifyOrder').mockResolvedValue(edited);
    await internals(view).modifyOrderPrice(7, 95);
    expect(sessionsApi.modifyOrder).toHaveBeenCalledWith(1, 7, { price: 95 });
    expect(internals(view).state?.trading.realizedPnl).toBe(42);

    await vi.runAllTimersAsync();
    expect(internals(view).state?.trading.realizedPnl).toBe(42);

    view.close();
  });

  it('accepts an order while the forming candle is still painting', async () => {
    vi.useFakeTimers();
    const stepped = formingStep(0);
    vi.spyOn(sessionsApi, 'step').mockResolvedValue(structuredClone(stepped));
    const view = new PracticeView();
    await view.open(1);
    await view.step(1);
    const filled = withPnl(structuredClone(stepped), 5);
    const order = vi.spyOn(sessionsApi, 'placeOrder').mockResolvedValue(filled);
    await view.placeOrder({ side: 'buy', type: 'market', qty: 1 });
    expect(order).toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(internals(view).state?.trading.realizedPnl).toBe(5);
    expect(internals(view).cursorTime).toBe(stepped.cursorTime);
    view.close();
  });

  it('drops a stop edit that resolves after a newer step snapshot', async () => {
    const pending = deferred<SessionViewDto>();
    vi.spyOn(sessionsApi, 'modifyOrder').mockReturnValueOnce(pending.promise);
    const view = new PracticeView();
    await view.open(1);
    const openState = internals(view).state!;
    internals(view).state = {
      ...openState,
      trading: { ...openState.trading, orders: [stopOrder(a.cursorTime)] },
    };
    const edit = internals(view).modifyOrderPrice(7, 95);

    const stepped = { ...formingStep(3), revealed: [bar(a.cursorTime + 60)] };
    vi.spyOn(sessionsApi, 'step').mockResolvedValue(stepped);
    await view.step(1);
    expect(internals(view).state?.trading.realizedPnl).toBe(3);

    const stale = withPnl(structuredClone(a), 99);
    pending.resolve({ ...stale, cursorTime: 1 });
    await edit;
    expect(internals(view).state?.trading.realizedPnl).toBe(3);
    expect(internals(view).cursorTime).toBe(stepped.cursorTime);
    view.close();
  });
});
