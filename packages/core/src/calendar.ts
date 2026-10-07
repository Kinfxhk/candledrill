// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SessionCalendar, Weekday } from './types.js';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;

/** Days since 1970-01-01 for an ISO date string ("YYYY-MM-DD"). Pure; does not read the clock. */
export function parseIsoDate(date: string): number {
  const m = DATE_RE.exec(date);
  if (!m) throw new RangeError(`invalid date "${date}", expected YYYY-MM-DD`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const ms = Date.UTC(y, mo - 1, d);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    throw new RangeError(`invalid calendar date "${date}"`);
  }
  return ms / 86_400_000;
}

export function formatIsoDate(epochDay: number): string {
  return new Date(epochDay * 86_400_000).toISOString().slice(0, 10);
}

export function weekdayOf(epochDay: number): Weekday {
  // 1970-01-01 was a Thursday (4).
  return ((((epochDay + 4) % 7) + 7) % 7) as Weekday;
}

/** "HH:MM" -> minutes after midnight. Accepts 00:00-24:00. */
export function parseClock(hhmm: string): number {
  const m = TIME_RE.exec(hhmm);
  if (!m) throw new RangeError(`invalid time "${hhmm}", expected HH:MM`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59 || h > 24 || (h === 24 && min !== 0)) {
    throw new RangeError(`invalid time "${hhmm}"`);
  }
  return h * 60 + min;
}

/** A contiguous block of trading minutes (one window on one day). */
export interface SessionSpan {
  /** Exchange-local date the session starts on. */
  readonly date: string;
  /** Unix seconds (UTC) of the first minute (inclusive). */
  readonly startTime: number;
  /** Number of one-minute bars in the session. */
  readonly minutes: number;
}

/**
 * Expand a calendar into concrete session spans for `days` calendar days starting at `startDate`.
 * Spans are returned in chronological order. Overlapping windows are a configuration error.
 */
export function expandSessions(
  calendar: SessionCalendar,
  startDate: string,
  days: number,
): SessionSpan[] {
  if (!Number.isInteger(days) || days <= 0) {
    throw new RangeError(`days must be a positive integer, got ${days}`);
  }
  const off = calendar.utcOffsetMinutes;
  if (!Number.isInteger(off) || off < -14 * 60 || off > 14 * 60) {
    throw new RangeError(`utcOffsetMinutes out of range: ${off}`);
  }
  if (calendar.windows.length === 0) throw new RangeError('calendar needs at least one window');

  const closed = new Set<number>((calendar.closedDates ?? []).map(parseIsoDate));
  const first = parseIsoDate(startDate);
  const spans: SessionSpan[] = [];

  for (let day = first; day < first + days; day++) {
    if (closed.has(day)) continue;
    const wd = weekdayOf(day);
    for (const w of calendar.windows) {
      if (!w.days.includes(wd)) continue;
      const s = parseClock(w.start);
      let e = parseClock(w.end);
      if (e <= s) e += 1440;
      const startTime = (day * 1440 + s - off) * 60;
      spans.push({ date: formatIsoDate(day), startTime, minutes: e - s });
    }
  }

  spans.sort((a, b) => a.startTime - b.startTime);
  for (let i = 1; i < spans.length; i++) {
    const prev = spans[i - 1]!;
    const cur = spans[i]!;
    if (prev.startTime + prev.minutes * 60 > cur.startTime) {
      throw new RangeError(`overlapping session windows on ${prev.date} and ${cur.date}`);
    }
  }
  return spans;
}

/** True if the minute starting at `time` (Unix seconds) is inside any session of the calendar. */
export function isInSession(calendar: SessionCalendar, time: number): boolean {
  const localDay = Math.floor((time / 60 + calendar.utcOffsetMinutes) / 1440);
  // A session may start on the previous local day if it crosses midnight.
  const spans = expandSessions(calendar, formatIsoDate(localDay - 1), 2);
  return spans.some((s) => time >= s.startTime && time < s.startTime + s.minutes * 60);
}
