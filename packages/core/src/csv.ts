// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Generic OHLCV CSV importer. Pure: takes text, returns bars plus a detailed report.
// The user maps columns; nothing about any vendor's export format is assumed.

import type { Bar } from './types.js';
import { validateBars, type BarIssue } from './validate.js';

export type CsvTimeFormat = 'auto' | 'unix-s' | 'unix-ms' | 'datetime';
export type CsvDateOrder = 'ymd' | 'dmy' | 'mdy';

export interface CsvMapping {
  /** Column index of the timestamp (or of the date when `timeOfDay` is used). */
  readonly time: number;
  /** Optional separate time-of-day column (e.g. "09:30"). */
  readonly timeOfDay?: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  /** Optional volume column; missing volume becomes 0. */
  readonly volume?: number;
}

export interface CsvImportOptions {
  readonly mapping: CsvMapping;
  readonly hasHeader?: boolean;
  /** Field delimiter. Default: auto-detect from the first line. */
  readonly delimiter?: string;
  readonly timeFormat?: CsvTimeFormat;
  /** How to read numeric dates such as 03/04/2026. Default "ymd". */
  readonly dateOrder?: CsvDateOrder;
  /** Offset applied to timestamps WITHOUT an explicit zone, in minutes east of UTC. */
  readonly utcOffsetMinutes?: number;
  /** Bar length in seconds. Default: auto-detect (most common spacing). */
  readonly timeframeSeconds?: number;
  /** If given, prices must sit on this tick grid. */
  readonly tickSize?: number;
  /** Drop rows that cannot be parsed or that fail validation instead of failing the import. */
  readonly skipInvalidRows?: boolean;
  /** Hard cap on bars (memory protection). Default MAX_IMPORT_BARS. */
  readonly maxBars?: number;
}

export interface CsvRowIssue {
  /** 1-based line number in the file. */
  readonly line: number;
  readonly message: string;
}

export interface CsvImportReport {
  readonly rows: number;
  readonly imported: number;
  readonly skipped: number;
  readonly duplicatesDropped: number;
  readonly wasReordered: boolean;
  readonly timeframeSeconds: number;
  /** Number of spacings larger than one bar (sessions breaks included; informational). */
  readonly gaps: number;
  readonly firstTime: number | null;
  readonly lastTime: number | null;
  readonly rowIssues: readonly CsvRowIssue[];
  readonly barIssues: readonly BarIssue[];
}

export interface CsvImportResult {
  readonly ok: boolean;
  readonly bars: Bar[];
  readonly report: CsvImportReport;
}

export const MAX_IMPORT_BARS = 1_000_000;
const MAX_REPORTED_ISSUES = 50;

/** Pick the most likely delimiter from a sample line. */
export function detectDelimiter(line: string): string {
  const candidates = [',', ';', '\t', '|'];
  let best = ',';
  let bestCount = 0;
  for (const c of candidates) {
    const n = line.split(c).length - 1;
    if (n > bestCount) {
      best = c;
      bestCount = n;
    }
  }
  return best;
}

/** Minimal RFC 4180-style parser (quoted fields, doubled quotes, CRLF/LF). */
export function parseCsv(text: string, delimiter?: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const firstLineEnd = src.search(/\r?\n/);
  const delim =
    delimiter ?? detectDelimiter(firstLineEnd === -1 ? src : src.slice(0, firstLineEnd));
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') inQuotes = true;
    else if (ch === delim) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0]!.trim() === ''));
}

const HEADER_HINTS: Record<keyof Required<CsvMapping>, RegExp> = {
  time: /^(date[ _-]?time|timestamp|time|date|datetime|日期時間|日期|時間|ts)$/i,
  timeOfDay: /^(time|hour|clock|時間)$/i,
  open: /^(open|o|開|開盤|開盤價|開市)$/i,
  high: /^(high|h|高|最高|最高價)$/i,
  low: /^(low|l|低|最低|最低價)$/i,
  close: /^(close|c|last|price|收|收盤|收盤價|收市)$/i,
  volume: /^(volume|vol|v|qty|成交量|量)$/i,
};

/** Best-effort column mapping from header names. Returns undefined if required columns are missing. */
export function guessMapping(header: readonly string[]): CsvMapping | undefined {
  const norm = header.map((h) => h.trim().replace(/^<|>$/g, ''));
  const find = (re: RegExp, exclude: number[] = []): number =>
    norm.findIndex((h, i) => re.test(h) && !exclude.includes(i));
  let time = find(HEADER_HINTS.time);
  let timeOfDay: number | undefined;
  if (time !== -1 && /^date$|^日期$/i.test(norm[time]!)) {
    const t = find(HEADER_HINTS.timeOfDay, [time]);
    if (t !== -1) timeOfDay = t;
  }
  if (time === -1) time = 0;
  const open = find(HEADER_HINTS.open);
  const high = find(HEADER_HINTS.high);
  const low = find(HEADER_HINTS.low);
  const close = find(HEADER_HINTS.close);
  const volume = find(HEADER_HINTS.volume);
  if ([open, high, low, close].includes(-1)) return undefined;
  return {
    time,
    ...(timeOfDay !== undefined ? { timeOfDay } : {}),
    open,
    high,
    low,
    close,
    ...(volume !== -1 ? { volume } : {}),
  };
}

const DT_RE =
  /^(\d{4}|\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{1,2})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;
const COMPACT_RE = /^(\d{4})(\d{2})(\d{2})(?:[ T]?(\d{2}):?(\d{2})(?::?(\d{2}))?)?$/;
const TOD_RE = /^(\d{1,2}):?(\d{2})(?::?(\d{2})(?:[.,]\d+)?)?$/;

function utcSeconds(y: number, mo: number, d: number, h: number, mi: number, s: number): number {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 24 || mi > 59 || s > 60) return Number.NaN;
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return Number.NaN;
  return ms / 1000;
}

/**
 * Parse one timestamp to Unix seconds (UTC). Naive date-times are interpreted with
 * `utcOffsetMinutes`. Returns NaN when the value cannot be parsed.
 */
export function parseTimestamp(
  raw: string,
  format: CsvTimeFormat = 'auto',
  dateOrder: CsvDateOrder = 'ymd',
  utcOffsetMinutes = 0,
): number {
  const v = raw.trim();
  if (v === '') return Number.NaN;
  if (format === 'unix-s' || format === 'unix-ms' || (format === 'auto' && /^\d{9,13}$/.test(v))) {
    if (!/^\d+(\.\d+)?$/.test(v)) return Number.NaN;
    const n = Number(v);
    const isMs = format === 'unix-ms' || (format === 'auto' && v.length >= 12);
    return Math.floor(isMs ? n / 1000 : n);
  }
  let y: number, mo: number, d: number, h: number, mi: number, s: number;
  let zone: string | undefined;
  const m = DT_RE.exec(v);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const c = Number(m[3]);
    if (m[1]!.length === 4) {
      [y, mo, d] = [a, b, c];
    } else if (m[3]!.length === 4) {
      if (dateOrder === 'mdy') [mo, d, y] = [a, b, c];
      else [d, mo, y] = [a, b, c];
    } else return Number.NaN;
    h = m[4] ? Number(m[4]) : 0;
    mi = m[5] ? Number(m[5]) : 0;
    s = m[6] ? Number(m[6]) : 0;
    zone = m[7];
  } else {
    const c = COMPACT_RE.exec(v);
    if (!c) return Number.NaN;
    [y, mo, d] = [Number(c[1]), Number(c[2]), Number(c[3])];
    h = c[4] ? Number(c[4]) : 0;
    mi = c[5] ? Number(c[5]) : 0;
    s = c[6] ? Number(c[6]) : 0;
  }
  const base = utcSeconds(y, mo, d, h, mi, s);
  let offset = utcOffsetMinutes;
  if (zone) {
    if (zone.toUpperCase() === 'Z') offset = 0;
    else {
      const zm = /^([+-])(\d{2}):?(\d{2})$/.exec(zone)!;
      offset = (zm[1] === '-' ? -1 : 1) * (Number(zm[2]) * 60 + Number(zm[3]));
    }
  }
  return base - offset * 60;
}

function parseTimeOfDay(raw: string): number {
  const m = TOD_RE.exec(raw.trim());
  if (!m) return Number.NaN;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  const s = m[3] ? Number(m[3]) : 0;
  if (h > 24 || mi > 59 || s > 59) return Number.NaN;
  return h * 3600 + mi * 60 + s;
}

function parseNumber(raw: string | undefined): number {
  if (raw === undefined) return Number.NaN;
  const v = raw.trim().replace(/_/g, '');
  if (v === '' || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v)) return Number.NaN;
  return Number(v);
}

/** Most common positive spacing between consecutive times (seconds). */
export function detectTimeframe(times: readonly number[]): number {
  const counts = new Map<number, number>();
  for (let i = 1; i < times.length && i < 20_000; i++) {
    const d = times[i]! - times[i - 1]!;
    if (d > 0) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  let best = 60;
  let bestN = 0;
  for (const [d, n] of counts) {
    if (n > bestN || (n === bestN && d < best)) {
      best = d;
      bestN = n;
    }
  }
  return best;
}

/** Parse and validate a CSV of OHLCV bars. Never throws for bad data; see `report`. */
export function importCsv(text: string, options: CsvImportOptions): CsvImportResult {
  const { mapping } = options;
  const format = options.timeFormat ?? 'auto';
  const dateOrder = options.dateOrder ?? 'ymd';
  const offset = options.utcOffsetMinutes ?? 0;
  const maxBars = options.maxBars ?? MAX_IMPORT_BARS;
  const skipInvalid = options.skipInvalidRows ?? false;
  const rows = parseCsv(text, options.delimiter);
  const startRow = options.hasHeader === false ? 0 : 1;

  const rowIssues: CsvRowIssue[] = [];
  let rowIssueCount = 0;
  const addRowIssue = (line: number, message: string) => {
    rowIssueCount++;
    if (rowIssues.length < MAX_REPORTED_ISSUES) rowIssues.push({ line, message });
  };

  type Parsed = Bar & { line: number };
  const parsed: Parsed[] = [];
  for (let r = startRow; r < rows.length; r++) {
    const cells = rows[r]!;
    const line = r + 1;
    let time = parseTimestamp(cells[mapping.time] ?? '', format, dateOrder, offset);
    if (mapping.timeOfDay !== undefined) {
      const tod = parseTimeOfDay(cells[mapping.timeOfDay] ?? '');
      time = Number.isNaN(tod) ? Number.NaN : time + tod;
    }
    const open = parseNumber(cells[mapping.open]);
    const high = parseNumber(cells[mapping.high]);
    const low = parseNumber(cells[mapping.low]);
    const close = parseNumber(cells[mapping.close]);
    const volume = mapping.volume === undefined ? 0 : parseNumber(cells[mapping.volume]);
    if (Number.isNaN(time)) {
      addRowIssue(line, `cannot parse time "${cells[mapping.time] ?? ''}"`);
      continue;
    }
    if (![open, high, low, close, volume].every(Number.isFinite)) {
      addRowIssue(line, 'cannot parse a price or volume value');
      continue;
    }
    parsed.push({ time, open, high, low, close, volume, line });
  }

  let wasReordered = false;
  for (let i = 1; i < parsed.length; i++) {
    if (parsed[i]!.time < parsed[i - 1]!.time) {
      wasReordered = true;
      break;
    }
  }
  if (wasReordered) parsed.sort((a, b) => a.time - b.time || a.line - b.line);

  let duplicatesDropped = 0;
  const unique: Parsed[] = [];
  for (const p of parsed) {
    const last = unique.at(-1);
    if (last && last.time === p.time) {
      duplicatesDropped++;
      continue;
    }
    unique.push(p);
  }

  const tf = options.timeframeSeconds ?? detectTimeframe(unique.map((b) => b.time));
  const toBar = (p: Parsed): Bar => ({
    time: p.time,
    open: p.open,
    high: p.high,
    low: p.low,
    close: p.close,
    volume: p.volume,
  });
  let bars = unique.map(toBar);
  const vopts = {
    timeframeSeconds: tf,
    ...(options.tickSize ? { tickSize: options.tickSize } : {}),
  };
  let barIssues = validateBars(bars, vopts);
  let skipped = rows.length - startRow - parsed.length;

  if (skipInvalid && barIssues.length > 0) {
    const bad = new Set(barIssues.map((i) => i.index));
    for (const i of bad) addRowIssue(unique[i]!.line, 'invalid bar skipped');
    bars = bars.filter((_, i) => !bad.has(i));
    skipped += bad.size;
    barIssues = validateBars(bars, vopts);
  }

  if (bars.length > maxBars) {
    addRowIssue(0, `file has ${bars.length} bars; the limit is ${maxBars}`);
  }

  let gaps = 0;
  for (let i = 1; i < bars.length; i++) if (bars[i]!.time - bars[i - 1]!.time > tf) gaps++;

  const parseFailed = !skipInvalid && rowIssueCount > 0;
  const ok = bars.length > 0 && !parseFailed && barIssues.length === 0 && bars.length <= maxBars;
  return {
    ok,
    bars,
    report: {
      rows: Math.max(0, rows.length - startRow),
      imported: ok ? bars.length : 0,
      skipped,
      duplicatesDropped,
      wasReordered,
      timeframeSeconds: tf,
      gaps,
      firstTime: bars[0]?.time ?? null,
      lastTime: bars.at(-1)?.time ?? null,
      rowIssues,
      barIssues: barIssues.slice(0, MAX_REPORTED_ISSUES),
    },
  };
}
