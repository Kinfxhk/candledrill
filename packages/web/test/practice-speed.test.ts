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
  trailingDrawdownMode: 'close' as const,
  anchorMinutes: 0,
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
  it('starts a new session at 1 bar per second', () => {
    const view = new PracticeView();
    expect(internals(view).speed).toBe(1);
    view.close();
  });

  it('restores a saved speed and ignores values outside the list', () => {
    const store = new Map<string, string>([['candledrill.playbackSpeed', '2']]);
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
    });
    const restored = new PracticeView();
    expect(internals(restored).speed).toBe(2);
    (restored as unknown as { setSpeed(n: number): void }).setSpeed(0.5);
    expect(store.get('candledrill.playbackSpeed')).toBe('0.5');
    expect(internals(restored).speed).toBe(0.5);
    (restored as unknown as { setSpeed(n: number): void }).setSpeed(7);
    expect(internals(restored).speed).toBe(0.5);
    restored.close();

    store.set('candledrill.playbackSpeed', '9');
    const fresh = new PracticeView();
    expect(internals(fresh).speed).toBe(1);
    fresh.close();
  });

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

describe('forming paint budget', () => {
  type GapView = { formingGapMs(count: number): number; speed: number; playing: boolean };
  function gapView(view: PracticeView): GapView {
    return view as unknown as GapView;
  }

  it('spaces paints across the whole budget with no 140ms cap', () => {
    const view = new PracticeView();
    const g = gapView(view);
    g.playing = true;
    g.speed = 0.5;
    // budget clamps 2000ms to 1600; 3 paints → gap = 1600 / 2.
    expect(g.formingGapMs(3)).toBe(800);
    g.speed = 1;
    expect(g.formingGapMs(3)).toBe(500);
    g.speed = 2;
    expect(g.formingGapMs(3)).toBe(250);
    g.speed = 1;
    // ÷6-sized reveal used to clamp each gap at 140ms (span 700 of 1000).
    expect(g.formingGapMs(6)).toBe(200);
    g.playing = false;
    expect(g.formingGapMs(3)).toBe(210);
    view.close();
  });

  it('play waits until the forming paints finish before the next bar', async () => {
    vi.useFakeTimers();
    const step = vi.spyOn(sessionsApi, 'step').mockImplementation(async () => {
      const base = a.cursorTime;
      return {
        ...stepped(a),
        revealed: [bar(base + 20), bar(base + 40), bar(base + 60)],
        cursorTime: base + 60,
      };
    });
    const view = new PracticeView();
    await view.open(1);
    const painted: number[] = [];
    (
      view as unknown as {
        panes: {
          chart: { updateBar(b: { time: number }): void; destroy(): void };
          agg: { push(b: unknown): { bar: unknown } };
        }[];
      }
    ).panes.push({
      chart: {
        updateBar: (b) => painted.push(b.time),
        destroy: () => {},
      },
      agg: { push: (b) => ({ bar: b }) },
    });
    internals(view).speed = 1;
    view.play();

    // Carry reaches one bar just after 1s (tenths of a bar are not exact in binary).
    await vi.advanceTimersByTimeAsync(1000);
    if (step.mock.calls.length === 0) await vi.advanceTimersByTimeAsync(100);
    expect(step).toHaveBeenCalledTimes(1);
    expect(step).toHaveBeenLastCalledWith(1, 1);
    expect(painted).toHaveLength(1);

    // 1× budget is 1000ms for 3 paints (gaps of 500). Do not fetch during the build.
    await vi.advanceTimersByTimeAsync(999);
    expect(step).toHaveBeenCalledTimes(1);
    expect(painted.length).toBeGreaterThan(1);
    expect(painted.length).toBeLessThan(3);

    await vi.advanceTimersByTimeAsync(150);
    expect(painted.slice(0, 3)).toEqual([a.cursorTime + 20, a.cursorTime + 40, a.cursorTime + 60]);
    expect(step).toHaveBeenCalledTimes(2);
    // The next bar has started forming (one source paint), not snapped in whole.
    expect(painted).toHaveLength(4);
    view.close();
  });

  it('1D Next paints three 8h steps instead of snapping the day', async () => {
    vi.useFakeTimers();
    const day = Date.UTC(2026, 9, 5) / 1000;
    const eightHours = 28800;
    const closedDay = [0, eightHours, eightHours * 2].map((off) => bar(day + off));
    const nextDay = [0, eightHours, eightHours * 2].map((off) => bar(day + 86400 + off));
    const dailySettings = { ...settings, practiceTimeframeSeconds: 86400 };
    const opened = {
      ...a,
      bars: closedDay,
      cursorTime: closedDay[2]!.time,
      session: { ...a.session, settings: dailySettings },
      state: createSession(closedDay, dailySettings, closedDay[2]!.time),
    };
    vi.mocked(sessionsApi.open).mockResolvedValue(structuredClone(opened));
    const step = vi.spyOn(sessionsApi, 'step').mockImplementation(async () => ({
      ...opened,
      state: { ...opened.state, cursor: opened.state.cursor + 3 },
      cursorTime: nextDay[2]!.time,
      revealed: nextDay,
    }));
    const view = new PracticeView();
    await view.open(1);
    const steps = (view as unknown as { practiceSteps(n: number): number }).practiceSteps(1);
    expect(steps).toBe(3);

    const painted: number[] = [];
    (
      view as unknown as {
        panes: {
          chart: { updateBar(b: { time: number }): void; destroy(): void };
          agg: { push(b: unknown): { bar: unknown } };
        }[];
      }
    ).panes.push({
      chart: {
        updateBar: (b) => painted.push(b.time),
        destroy: () => {},
      },
      agg: { push: (b) => ({ bar: b }) },
    });
    await (view as unknown as { stepBars(n: number): Promise<void> }).stepBars(1);
    expect(step).toHaveBeenCalledTimes(1);
    expect(step).toHaveBeenLastCalledWith(1, 3);
    // The first 8h print is on screen; the day is not finished in that paint.
    expect(painted).toEqual([nextDay[0]!.time]);

    await vi.advanceTimersByTimeAsync(210);
    expect(painted).toEqual([nextDay[0]!.time, nextDay[1]!.time]);
    await vi.advanceTimersByTimeAsync(210);
    expect(painted).toEqual(nextDay.map((b) => b.time));
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
