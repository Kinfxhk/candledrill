// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  detectDelimiter,
  detectTimeframe,
  generateSyntheticBars,
  guessMapping,
  importCsv,
  parseCsv,
  parseTimestamp,
} from '../src/index.js';

const MAP = { time: 0, open: 1, high: 2, low: 3, close: 4, volume: 5 };

describe('parseCsv', () => {
  it('handles quotes, CRLF, BOM and blank lines', () => {
    const rows = parseCsv('\ufeffa,b\r\n"x,1","say ""hi"""\r\n\r\n3,4');
    expect(rows).toEqual([
      ['a', 'b'],
      ['x,1', 'say "hi"'],
      ['3', '4'],
    ]);
  });
  it('detects delimiters', () => {
    expect(detectDelimiter('a;b;c')).toBe(';');
    expect(detectDelimiter('a\tb\tc')).toBe('\t');
    expect(detectDelimiter('a,b')).toBe(',');
  });
});

describe('parseTimestamp', () => {
  it('parses common layouts', () => {
    const t = Date.UTC(2026, 0, 5, 9, 30) / 1000;
    expect(parseTimestamp('2026-01-05 09:30')).toBe(t);
    expect(parseTimestamp('2026-01-05T09:30:00Z')).toBe(t);
    expect(parseTimestamp('2026/01/05 09:30:00')).toBe(t);
    expect(parseTimestamp('20260105 093000')).toBe(t);
    expect(parseTimestamp(String(t))).toBe(t);
    expect(parseTimestamp(String(t * 1000))).toBe(t);
    expect(parseTimestamp('05/01/2026 09:30', 'auto', 'dmy')).toBe(t);
    expect(parseTimestamp('01/05/2026 09:30', 'auto', 'mdy')).toBe(t);
  });
  it('applies offsets', () => {
    const t = Date.UTC(2026, 0, 5, 9, 30) / 1000;
    expect(parseTimestamp('2026-01-05 17:30', 'auto', 'ymd', 480)).toBe(t);
    expect(parseTimestamp('2026-01-05T17:30:00+08:00', 'auto', 'ymd', -300)).toBe(t);
  });
  it('rejects garbage and impossible dates', () => {
    expect(parseTimestamp('hello')).toBeNaN();
    expect(parseTimestamp('2026-02-30 10:00')).toBeNaN();
    expect(parseTimestamp('')).toBeNaN();
  });
  it.each([
    '2026-01-05 24:30', // used to roll over to the next day 00:30
    '2026-01-05 24:00',
    '2026-01-05T24:00:00Z',
    '2026-01-05 23:60',
    '2026-01-05 23:59:60', // leap second: not silently normalised
    '20260105 240000',
    '05/01/2026 25:00',
    '2026-01-05T12:00:00+99:99', // used to give a wrong UTC time
    '2026-01-05T12:00:00+05:60',
    '2026-01-05T12:00:00-14:01',
    '2026-01-05T12:00:00+1500',
    '2026-01-05T12:00:00+15:00',
  ])('rejects the invalid time or offset %s', (raw) => {
    expect(parseTimestamp(raw)).toBeNaN();
  });
  it('accepts the full valid clock and offset range', () => {
    expect(parseTimestamp('2026-01-05 23:59:59')).toBe(Date.UTC(2026, 0, 5, 23, 59, 59) / 1000);
    expect(parseTimestamp('2026-01-05 00:00')).toBe(Date.UTC(2026, 0, 5) / 1000);
    expect(parseTimestamp('2026-01-05T12:00:00+14:00')).toBe(Date.UTC(2026, 0, 4, 22) / 1000);
    expect(parseTimestamp('2026-01-05T12:00:00-12:00')).toBe(Date.UTC(2026, 0, 6, 0) / 1000);
    expect(parseTimestamp('2026-01-05T12:00:00+0545')).toBe(Date.UTC(2026, 0, 5, 6, 15) / 1000);
  });
  it('rejects an invalid separate time-of-day column during import', () => {
    const mapping = { time: 0, timeOfDay: 1, open: 2, high: 3, low: 4, close: 5 };
    const csv = (tod: string) =>
      `date,time,open,high,low,close\n2026-01-05,23:29,1,1,1,1\n2026-01-05,${tod},1,1,1,1\n`;
    expect(importCsv(csv('23:30'), { mapping, tickSize: 1 }).ok).toBe(true);
    expect(importCsv(csv('24:30'), { mapping, tickSize: 1 }).ok).toBe(false);
  });
});

describe('guessMapping', () => {
  it('maps typical headers including separate date/time', () => {
    expect(guessMapping(['Date', 'Time', 'Open', 'High', 'Low', 'Close', 'Volume'])).toEqual({
      time: 0,
      timeOfDay: 1,
      open: 2,
      high: 3,
      low: 4,
      close: 5,
      volume: 6,
    });
    expect(guessMapping(['timestamp', 'o', 'h', 'l', 'c'])).toEqual({
      time: 0,
      open: 1,
      high: 2,
      low: 3,
      close: 4,
    });
    expect(guessMapping(['foo', 'bar'])).toBeUndefined();
  });
});

function toCsv(
  bars: { time: number; open: number; high: number; low: number; close: number; volume: number }[],
): string {
  const lines = ['time,open,high,low,close,volume'];
  for (const b of bars) {
    const iso = new Date(b.time * 1000).toISOString().slice(0, 19).replace('T', ' ');
    lines.push(`${iso},${b.open},${b.high},${b.low},${b.close},${b.volume}`);
  }
  return lines.join('\n');
}

describe('importCsv', () => {
  const ds = generateSyntheticBars({ seed: 7, startDate: '2026-10-05', days: 1 });

  it('round-trips synthetic bars exactly', () => {
    const res = importCsv(toCsv(ds.bars), { mapping: MAP, tickSize: 0.25 });
    expect(res.ok).toBe(true);
    expect(res.bars).toEqual(ds.bars);
    expect(res.report.timeframeSeconds).toBe(60);
    expect(res.report.imported).toBe(ds.bars.length);
  });

  it('reorders descending files and drops duplicates', () => {
    const rows = toCsv(ds.bars.slice(0, 50)).split('\n');
    const body = rows.slice(1).reverse();
    body.push(body[0]!);
    const res = importCsv([rows[0], ...body].join('\n'), { mapping: MAP });
    expect(res.ok).toBe(true);
    expect(res.report.wasReordered).toBe(true);
    expect(res.report.duplicatesDropped).toBe(1);
    expect(res.bars).toEqual(ds.bars.slice(0, 50));
  });

  it('reports bad rows with line numbers and fails unless skipping', () => {
    const csv =
      'time,open,high,low,close,volume\n2026-01-05 09:30,10,11,9,10.5,1\nbad,1,1,1,1,1\n2026-01-05 09:32,10,9,9,10,1\n2026-01-05 09:33,10,11,9,10,1';
    const res = importCsv(csv, { mapping: MAP });
    expect(res.ok).toBe(false);
    expect(res.report.rowIssues[0]).toMatchObject({ line: 3 });
    expect(res.report.barIssues.map((i) => i.code)).toContain('ohlc-inconsistent');
    const skipped = importCsv(csv, { mapping: MAP, skipInvalidRows: true });
    expect(skipped.ok).toBe(true);
    expect(skipped.bars).toHaveLength(2);
    expect(skipped.report.skipped).toBe(2);
  });

  it('enforces the tick grid and bar cap', () => {
    const csv =
      'time,open,high,low,close\n2026-01-05 09:30,10.1,11,9,10\n2026-01-05 09:31,10,11,9,10';
    expect(
      importCsv(csv, { mapping: { time: 0, open: 1, high: 2, low: 3, close: 4 }, tickSize: 0.25 })
        .ok,
    ).toBe(false);
    expect(importCsv(toCsv(ds.bars), { mapping: MAP, maxBars: 10 }).ok).toBe(false);
  });

  it('supports separate date and time columns without header', () => {
    const csv = '2026.01.05;09:30;10;11;9;10;5\n2026.01.05;09:31;10;12;9;11;6';
    const res = importCsv(csv, {
      mapping: { time: 0, timeOfDay: 1, open: 2, high: 3, low: 4, close: 5, volume: 6 },
      hasHeader: false,
    });
    expect(res.ok).toBe(true);
    expect(res.bars[1]).toEqual({
      time: Date.UTC(2026, 0, 5, 9, 31) / 1000,
      open: 10,
      high: 12,
      low: 9,
      close: 11,
      volume: 6,
    });
  });

  it('detects the dominant bar spacing', () => {
    expect(detectTimeframe([0, 300, 600, 1200, 1500])).toBe(300);
  });
});
