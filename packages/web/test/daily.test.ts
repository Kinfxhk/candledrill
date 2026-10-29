// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  dailySeed,
  dailySourceSeconds,
  dailyStartAllowed,
  dailyTimeframe,
  isDailyDay,
  todayDay,
} from '../src/daily.js';

describe('daily round identity', () => {
  it('derives the same seed for the same day', () => {
    expect(dailySeed('2026-10-29')).toBe(dailySeed('2026-10-29'));
    expect(dailySeed('2026-10-29')).not.toBe(dailySeed('2026-10-30'));
    expect(Number.isInteger(dailySeed('2026-10-29'))).toBe(true);
  });

  it('rotates only 1m, 5m and 15m', () => {
    const days = [
      '2026-10-26',
      '2026-10-27',
      '2026-10-28',
      '2026-10-29',
      '2026-10-30',
      '2026-11-01',
    ];
    for (const day of days) expect([60, 300, 900]).toContain(dailyTimeframe(day));
  });

  it('builds a 15m round from 5m source bars', () => {
    for (const day of ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30']) {
      const practice = dailyTimeframe(day);
      const source = dailySourceSeconds(day);
      expect([60, 300, 900]).toContain(practice);
      expect([60, 300]).toContain(source);
      if (practice === 900) expect(source).toBe(300);
      else expect(source).toBe(practice);
    }
  });

  it('refuses to start a past round that was never opened', () => {
    expect(dailyStartAllowed('2026-10-29', '2026-10-29', false)).toBe(true);
    expect(dailyStartAllowed('2026-10-30', '2026-10-29', false)).toBe(true);
    expect(dailyStartAllowed('2026-10-28', '2026-10-29', false)).toBe(false);
    expect(dailyStartAllowed('2026-10-28', '2026-10-29', true)).toBe(true);
    expect(dailyStartAllowed('not-a-day', '2026-10-29', true)).toBe(false);
  });

  it('rejects a day that is not a real calendar date', () => {
    expect(isDailyDay('2026-10-29')).toBe(true);
    expect(isDailyDay('2026-02-30')).toBe(false);
    expect(isDailyDay('29-10-2026')).toBe(false);
  });

  it('uses the local calendar day', () => {
    expect(todayDay(Date.parse('2026-10-29T13:00:00+08:00'))).toBe('2026-10-29');
    expect(todayDay(Date.parse('2026-10-29T23:30:00+08:00'))).toBe('2026-10-29');
  });
});
