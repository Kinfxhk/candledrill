// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { managedStop, NO_STOP_RULES } from '../src/stops.js';
import { DEFAULT_KEYS, hotkeyAction, loadSettings } from '../src/settings.js';
import { measureText } from '../src/chart.js';

describe('stop management', () => {
  const tick = 0.25;
  it('break-even moves the stop to entry (+offset) after N ticks in profit, only tightening', () => {
    const rules = { ...NO_STOP_RULES, breakEvenTicks: 8, breakEvenOffset: 1 };
    expect(managedStop(rules, 'long', 100, 98, 101.75, tick)).toBeNull(); // 7 ticks: not yet
    expect(managedStop(rules, 'long', 100, 98, 102, tick)).toBe(100.25);
    expect(managedStop(rules, 'long', 100, 100.5, 105, tick)).toBeNull(); // already tighter
    expect(managedStop(rules, 'short', 100, 102, 98, tick)).toBe(99.75);
  });
  it('trailing stop follows the best close and never loosens', () => {
    const rules = { ...NO_STOP_RULES, trailTicks: 4 };
    expect(managedStop(rules, 'long', 100, 98, 101, tick)).toBe(100);
    expect(managedStop(rules, 'long', 100, 100, 100.5, tick)).toBeNull();
    expect(managedStop(rules, 'short', 100, 102, 99, tick)).toBe(100);
    expect(managedStop(NO_STOP_RULES, 'long', 100, 98, 120, tick)).toBeNull();
  });
});

describe('settings', () => {
  it('keeps defaults on junk and drops a key bound to two actions', () => {
    expect(loadSettings('nope').keys).toEqual(DEFAULT_KEYS);
    const s = loadSettings(
      JSON.stringify({ keys: { buy: 'x', sell: 'x' }, trailTicks: 0, breakEvenTicks: 6 }),
    );
    expect(s.keys.buy).toBe('x');
    expect(s.keys.sell).toBe(DEFAULT_KEYS.sell);
    expect(s.trailTicks).toBeNull();
    expect(s.breakEvenTicks).toBe(6);
    expect(hotkeyAction('ArrowRight', s.keys)).toBe('step');
    expect(hotkeyAction('X', s.keys)).toBe('buy');
    expect(hotkeyAction('q', s.keys)).toBeNull();
  });
});

describe('measure tool', () => {
  it('labels price, ticks, percent and bars', () => {
    expect(measureText({ t1: 0, p1: 100, t2: 600, p2: 101.5 }, 0.25, 60, 2)).toBe(
      '+1.50 (+6t, +1.50%) · 10 bars',
    );
  });
});
