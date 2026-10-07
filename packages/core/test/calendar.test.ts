// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  expandSessions,
  formatIsoDate,
  isInSession,
  parseClock,
  parseIsoDate,
  weekdayOf,
  DEFAULT_SYNTHETIC_CALENDAR,
  type SessionCalendar,
} from '../src/index.js';

describe('date helpers', () => {
  it('parses and formats ISO dates', () => {
    expect(parseIsoDate('1970-01-01')).toBe(0);
    expect(formatIsoDate(parseIsoDate('2026-10-07'))).toBe('2026-10-07');
  });

  it('knows weekdays', () => {
    expect(weekdayOf(parseIsoDate('1970-01-01'))).toBe(4); // Thursday
    expect(weekdayOf(parseIsoDate('2026-10-07'))).toBe(3); // Wednesday
    expect(weekdayOf(parseIsoDate('2026-10-11'))).toBe(0); // Sunday
  });

  it.each(['2026-02-30', '2026-13-01', '20261007', 'x'])('rejects bad date %s', (d) => {
    expect(() => parseIsoDate(d)).toThrow(RangeError);
  });

  it('parses clock times', () => {
    expect(parseClock('00:00')).toBe(0);
    expect(parseClock('16:30')).toBe(990);
    expect(parseClock('24:00')).toBe(1440);
    expect(() => parseClock('24:01')).toThrow(RangeError);
    expect(() => parseClock('9:30')).toThrow(RangeError);
  });
});

describe('expandSessions', () => {
  it('default calendar: 510 minutes per weekday, none at weekends', () => {
    // 2026-10-05 is a Monday; 14 days = 10 weekdays.
    const spans = expandSessions(DEFAULT_SYNTHETIC_CALENDAR, '2026-10-05', 14);
    expect(spans).toHaveLength(10);
    expect(spans.every((s) => s.minutes === 510)).toBe(true);
    expect(spans[0]!.startTime).toBe(Date.UTC(2026, 9, 5, 8, 0) / 1000);
  });

  it('applies the UTC offset', () => {
    const cal: SessionCalendar = {
      utcOffsetMinutes: 8 * 60, // UTC+8
      windows: [{ days: [1], start: '09:00', end: '10:00' }],
    };
    const [s] = expandSessions(cal, '2026-10-05', 1);
    expect(s!.startTime).toBe(Date.UTC(2026, 9, 5, 1, 0) / 1000);
  });

  it('supports windows that cross midnight', () => {
    const cal: SessionCalendar = {
      utcOffsetMinutes: 0,
      windows: [{ days: [0, 1, 2, 3, 4], start: '23:00', end: '22:00' }],
    };
    const spans = expandSessions(cal, '2026-10-04', 7); // Sun..Sat
    expect(spans).toHaveLength(5);
    expect(spans.every((s) => s.minutes === 23 * 60)).toBe(true);
  });

  it('skips closed dates', () => {
    const cal = { ...DEFAULT_SYNTHETIC_CALENDAR, closedDates: ['2026-10-06'] };
    expect(expandSessions(cal, '2026-10-05', 5)).toHaveLength(4);
  });

  it('rejects overlapping windows', () => {
    const cal: SessionCalendar = {
      utcOffsetMinutes: 0,
      windows: [
        { days: [1], start: '09:00', end: '12:00' },
        { days: [1], start: '11:00', end: '13:00' },
      ],
    };
    expect(() => expandSessions(cal, '2026-10-05', 1)).toThrow(/overlapping/);
  });

  it('rejects bad inputs', () => {
    expect(() => expandSessions(DEFAULT_SYNTHETIC_CALENDAR, '2026-10-05', 0)).toThrow(RangeError);
    expect(() => expandSessions({ utcOffsetMinutes: 0, windows: [] }, '2026-10-05', 1)).toThrow(
      RangeError,
    );
    expect(() =>
      expandSessions({ ...DEFAULT_SYNTHETIC_CALENDAR, utcOffsetMinutes: 2000 }, '2026-10-05', 1),
    ).toThrow(RangeError);
  });

  it('isInSession matches the expanded minutes', () => {
    const t = Date.UTC(2026, 9, 5, 8, 0) / 1000;
    expect(isInSession(DEFAULT_SYNTHETIC_CALENDAR, t)).toBe(true);
    expect(isInSession(DEFAULT_SYNTHETIC_CALENDAR, t - 60)).toBe(false);
    expect(isInSession(DEFAULT_SYNTHETIC_CALENDAR, t + 509 * 60)).toBe(true);
    expect(isInSession(DEFAULT_SYNTHETIC_CALENDAR, t + 510 * 60)).toBe(false);
  });
});
