// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  createSession,
  noteTape,
  practiceFrames,
  previousPracticeCursor,
  replayCursorForBarTime,
  sessionPlaceOrder,
  stepSession,
  tapeAtOrBefore,
  TAPE_CAP,
  type Bar,
  type SessionSettings,
} from '../src/index.js';

const SETTINGS: SessionSettings = {
  symbol: 'SYNTH-TAPE',
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
  trailingDrawdownMode: 'close',
  anchorMinutes: 0,
  practiceTimeframeSeconds: 60,
};

function sourceBars(n: number): Bar[] {
  const start = Math.ceil(1_700_000_000 / 60) * 60;
  const out: Bar[] = [];
  for (let i = 0; i < n; i += 1) {
    const px = 100 + i * 0.25;
    out.push({
      time: start + i * 20,
      open: px,
      high: px + 1,
      low: px - 1,
      close: px + 0.25,
      volume: 1,
    });
  }
  return out;
}

describe('practice cursor tape', () => {
  const bars = sourceBars(24);

  it('steps one source bar at a time to the same state as one batch', () => {
    const start = createSession(bars, SETTINGS, bars[3]!.time);
    expect(start.cursor).toBe(2);
    const batch = stepSession(bars, SETTINGS, start, 9);
    const frames = practiceFrames(bars, SETTINGS, start, batch.state.cursor);
    expect(frames.map((f) => f.cursor)).toEqual([5, 8, 11]);
    expect(frames.at(-1)).toEqual(batch.state);
    expect(previousPracticeCursor(bars, batch.state.cursor, SETTINGS)).toBe(8);
  });

  it('keeps the pre-fill book at the previous practice bar', () => {
    let start = createSession(bars, SETTINGS, bars[3]!.time);
    start = sessionPlaceOrder(bars, SETTINGS, start, {
      side: 'buy',
      type: 'market',
      qty: 1,
      stopLoss: 90,
      takeProfit: 130,
    });
    expect(start.trading.fills).toHaveLength(0);
    const batch = stepSession(bars, SETTINGS, start, 3);
    expect(batch.state.cursor).toBe(5);
    expect(batch.state.trading.fills.length).toBeGreaterThan(0);
    const frames = practiceFrames(bars, SETTINGS, start, batch.state.cursor);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(batch.state);
    const back = previousPracticeCursor(bars, batch.state.cursor, SETTINGS);
    expect(back).toBe(start.cursor);
    expect(start.trading.orders.some((o) => o.role === 'entry' && o.status === 'working')).toBe(
      true,
    );
  });

  it('maps a clicked candle to the last source bar of that bucket', () => {
    const start = bars[0]!.time;
    expect(replayCursorForBarTime(bars, 11, start, 60)).toBe(2);
    expect(replayCursorForBarTime(bars, 11, start + 60, 60)).toBe(5);
    expect(replayCursorForBarTime(bars, 4, start + 60, 60)).toBe(4);
    expect(replayCursorForBarTime(bars, 11, start + 10_000, 60)).toBeNull();
  });

  it('one-to-one data treats every source bar as a practice bar', () => {
    const { practiceTimeframeSeconds: _practiceTf, ...plain } = SETTINGS;
    void _practiceTf;
    const start = createSession(bars, plain, bars[3]!.time);
    const batch = stepSession(bars, plain, start, 4);
    const frames = practiceFrames(bars, plain, start, batch.state.cursor);
    expect(frames).toHaveLength(4);
    expect(frames.at(-1)).toEqual(batch.state);
    expect(previousPracticeCursor(bars, batch.state.cursor, plain)).toBe(batch.state.cursor - 1);
  });

  it('keeps the earliest snapshot and the newest cursors when the tape is full', () => {
    const tape = new Map();
    const start = createSession(bars, SETTINGS, bars[3]!.time);
    for (let cursor = 0; cursor < 5; cursor += 1) noteTape(tape, { ...start, cursor }, 3);
    expect([...tape.keys()].sort((a, b) => a - b)).toEqual([0, 3, 4]);
    expect(tapeAtOrBefore(tape, 2)?.cursor).toBe(0);
    expect(tape.size).toBeLessThanOrEqual(TAPE_CAP);
  });

  it('returns no frames for a span longer than the local replay cap', () => {
    const many = sourceBars(6010);
    const start = createSession(many, SETTINGS, many[3]!.time);
    expect(practiceFrames(many, SETTINGS, start, start.cursor + 6001)).toEqual([]);
  });
});
