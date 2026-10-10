// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSession, placeOrder, type Bar } from '@candledrill/core';
import { sessionsApi, type SessionViewDto } from '../src/api.js';
import { PracticeView } from '../src/practice.js';
import type * as Format from '../src/format.js';

vi.mock('../src/format.js', async (original) => ({
  ...(await original<typeof Format>()),
  toast: vi.fn(),
}));

const settings = {
  symbol: 'SYNTH-SPEED',
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
const bar = (time: number): Bar => ({
  time,
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 1,
});
const FREE = { tickSize: 0.25, pointValue: 1, commissionPerContract: 0, slippageTicks: 0 };
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
const stepped = (v: typeof a) => ({
  ...v,
  state: { ...v.state, cursor: 1 },
  cursorTime: v.cursorTime + 60,
  revealed: [bar(v.cursorTime + 60)],
});

type ViewInternals = {
  speed: number;
  playing: boolean;
  els: Record<string, unknown>;
};
function internals(view: PracticeView): ViewInternals {
  return view as unknown as ViewInternals;
}

type ViewAll = {
  build(): void;
  resetCharts(): void;
};
function all(view: PracticeView): ViewAll {
  return view as unknown as ViewAll;
}

beforeEach(() => {
  const node = { hidden: false, replaceChildren: vi.fn() };
  vi.stubGlobal('document', {
    getElementById: () => node,
    addEventListener: vi.fn(),
    body: node,
    createElement: () => node,
    querySelector: () => null,
  });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
  vi.spyOn(PracticeView.prototype, 'render').mockImplementation(() => {});
  vi.spyOn(all(PracticeView.prototype), 'build').mockImplementation(() => {});
  vi.spyOn(all(PracticeView.prototype), 'resetCharts').mockImplementation(() => {});
  vi.spyOn(sessionsApi, 'open').mockImplementation(async (id) => structuredClone(id === 1 ? a : a));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('playback speed', () => {
  it('0.5 bars/s accumulates carry and steps one bar every two seconds', async () => {
    vi.useFakeTimers();
    const step = vi.spyOn(sessionsApi, 'step').mockResolvedValue(stepped(a));
    const view = new PracticeView();
    await view.open(1);
    internals(view).speed = 0.5;
    view.play();
    expect(internals(view).playing).toBe(true);

    await vi.advanceTimersByTimeAsync(100);
    expect(step).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1900);
    expect(step).toHaveBeenCalledTimes(1);
    expect(step).toHaveBeenLastCalledWith(1, 1);

    await vi.advanceTimersByTimeAsync(2000);
    expect(step).toHaveBeenCalledTimes(2);

    view.close();
  });
});

describe('drag-to-modify rejection', () => {
  it('shows an error and leaves state unchanged when a dragged price is rejected', async () => {
    const base = createSession([bar(1000), bar(1060)], settings, 1060);
    const withOrder = placeOrder(
      base.trading,
      FREE,
      { side: 'buy', type: 'limit', qty: 1, price: 99 },
      0,
      1000,
    ).trading;
    const viewState = { ...base, trading: withOrder };
    const viewFixture = { ...a, state: viewState };
    vi.mocked(sessionsApi.open).mockResolvedValueOnce(structuredClone(viewFixture));
    const toast = (await import('../src/format.js')).toast as unknown as ReturnType<typeof vi.fn>;
    vi.spyOn(sessionsApi, 'modifyOrder').mockRejectedValueOnce(
      new Error('limit 100.25 is already at or through the market'),
    );

    const view = new PracticeView();
    await view.open(1);
    const before = (view as unknown as { state: SessionViewDto['state'] }).state;
    await expect(
      (
        view as unknown as { modifyOrderPrice(orderId: number, price: number): Promise<void> }
      ).modifyOrderPrice(1, 100.25),
    ).rejects.toThrow(/through the market/);
    const after = (view as unknown as { state: SessionViewDto['state'] }).state;
    expect(after).toEqual(before);
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/through the market/), 'error');
    view.close();
  });
});
