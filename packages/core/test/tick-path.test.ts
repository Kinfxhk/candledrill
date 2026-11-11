// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { DEFAULT_TICKS_PER_BAR, generateTickPath, type Bar } from '../src/index.js';

const bar: Bar = {
  time: 1_700_000_000,
  open: 100,
  high: 102,
  low: 98,
  close: 101,
  volume: 40,
};

const path = (seed: number, barIndex = 3, ticksPerBar = DEFAULT_TICKS_PER_BAR) =>
  generateTickPath({
    bar,
    seed,
    barIndex,
    timeframeSeconds: 60,
    ticksPerBar,
    tickSize: 0.25,
  });

describe('tick path', () => {
  it('is reproducible for the same seed, bar and index', () => {
    expect(path(42)).toEqual(path(42));
    expect(path(42, 3)).toEqual(path(42, 3));
  });

  it('changes when the seed or the bar index changes', () => {
    expect(path(42)).not.toEqual(path(43));
    expect(path(42, 3)).not.toEqual(path(42, 4));
  });

  it('starts at open, ends at close, and touches high and low', () => {
    const ticks = path(7);
    expect(ticks).toHaveLength(DEFAULT_TICKS_PER_BAR);
    expect(ticks[0]!.price).toBe(bar.open);
    expect(ticks.at(-1)!.price).toBe(bar.close);
    expect(Math.max(...ticks.map((t) => t.price))).toBe(bar.high);
    expect(Math.min(...ticks.map((t) => t.price))).toBe(bar.low);
    for (const t of ticks) {
      expect(t.price).toBeGreaterThanOrEqual(bar.low);
      expect(t.price).toBeLessThanOrEqual(bar.high);
      expect(Math.abs(t.price / 0.25 - Math.round(t.price / 0.25))).toBeLessThan(1e-6);
    }
  });

  it('spaces time uniformly across the bar', () => {
    const ticks = path(7, 1, 5);
    expect(ticks[0]!.time).toBe(bar.time);
    expect(ticks.at(-1)!.time).toBe(bar.time + 60);
    for (let i = 0; i < ticks.length; i++) {
      const expected = i === ticks.length - 1 ? bar.time + 60 : bar.time + (60 * i) / 4;
      expect(ticks[i]!.time).toBeCloseTo(expected, 8);
    }
  });

  it('stays flat when the bar has no range', () => {
    const flat: Bar = { time: 50, open: 10, high: 10, low: 10, close: 10, volume: 1 };
    const ticks = generateTickPath({
      bar: flat,
      seed: 1,
      barIndex: 0,
      timeframeSeconds: 60,
      ticksPerBar: 8,
    });
    expect(ticks.every((t) => t.price === 10)).toBe(true);
    expect(ticks).toHaveLength(8);
  });

  it('still touches both extremes when they sit on the open and the close', () => {
    const pinned: Bar = { time: 80, open: 102, high: 102, low: 98, close: 98, volume: 1 };
    const ticks = generateTickPath({
      bar: pinned,
      seed: 9,
      barIndex: 2,
      timeframeSeconds: 60,
      ticksPerBar: 12,
    });
    expect(ticks[0]!.price).toBe(102);
    expect(ticks.at(-1)!.price).toBe(98);
    expect(Math.max(...ticks.map((t) => t.price))).toBe(102);
    expect(Math.min(...ticks.map((t) => t.price))).toBe(98);
  });
});
