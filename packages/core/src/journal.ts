// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Trade journal: tags, notes and optional review fields per closed trade, maximum adverse /
// favourable excursion (MAE / MFE) and results grouped by hour of day and weekday.
//
// MAE / MFE are bar-based: they use the high and low of every bar from the bar the trade
// opened on to the bar it closed on, so they can include price moves in those two bars that
// happened before the entry or after the exit. They are an upper bound, never an under-count.

import type { Bar } from './types.js';
import type { Trade } from './orders.js';
import type { SessionSettings } from './session.js';

export const MAX_TAGS = 8;
export const MAX_TAG_LENGTH = 24;
export const MAX_NOTE_LENGTH = 2000;
/** Setup, market condition and emotion are short labels, not essays. */
export const MAX_JOURNAL_LABEL = 80;
/** Plan reflection uses the same cap as the trade note. */
export const MAX_PLAN_NOTE_LENGTH = MAX_NOTE_LENGTH;

export interface JournalEntry {
  readonly tags: readonly string[];
  readonly note: string;
  /** Setup / strategy name. Omitted on entries saved before this field existed. */
  readonly setup?: string | null;
  /** Free-text market state (trend, range, news, choppy, …). */
  readonly marketCondition?: string | null;
  /** Psychology label (disciplined, fomo, revenge, neutral, …). */
  readonly emotion?: string | null;
  /** True when the trade followed the plan, false when it deviated. */
  readonly planFollowed?: boolean | null;
  /** Free-text reflection on plan versus execution. */
  readonly planNote?: string | null;
}
/** Keyed by trade id (as a string). */
export type Journal = Readonly<Record<string, JournalEntry>>;

/** Trim, collapse spaces, drop empties and duplicates (case-insensitive), keep order. */
export function normalizeTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const t = raw.replace(/\s+/g, ' ').trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out;
}

// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const KNOWN_FIELDS = new Set([
  'tags',
  'note',
  'setup',
  'marketCondition',
  'emotion',
  'planFollowed',
  'planNote',
]);

function textIssues(name: string, v: unknown, max: number): string[] {
  if (v === undefined || v === null) return [];
  if (typeof v !== 'string' || v.length > max || CONTROL.test(v))
    return [`${name}: up to ${max} characters, no control characters`];
  return [];
}

export function journalEntryIssues(v: unknown): string[] {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return ['entry: not an object'];
  const e = v as Record<string, unknown>;
  const out: string[] = [];
  if (Object.keys(e).some((k) => !KNOWN_FIELDS.has(k))) out.push('entry: unknown field');
  if (!Array.isArray(e.tags) || e.tags.length > MAX_TAGS) out.push(`tags: at most ${MAX_TAGS}`);
  else
    for (const t of e.tags)
      if (typeof t !== 'string' || t.trim() === '' || t.length > MAX_TAG_LENGTH || CONTROL.test(t))
        out.push(`tag: 1-${MAX_TAG_LENGTH} characters, no control characters`);
  if (typeof e.note !== 'string' || e.note.length > MAX_NOTE_LENGTH || CONTROL.test(e.note))
    out.push(`note: up to ${MAX_NOTE_LENGTH} characters, no control characters`);
  out.push(...textIssues('setup', e.setup, MAX_JOURNAL_LABEL));
  out.push(...textIssues('marketCondition', e.marketCondition, MAX_JOURNAL_LABEL));
  out.push(...textIssues('emotion', e.emotion, MAX_JOURNAL_LABEL));
  out.push(...textIssues('planNote', e.planNote, MAX_PLAN_NOTE_LENGTH));
  if (
    e.planFollowed !== undefined &&
    e.planFollowed !== null &&
    typeof e.planFollowed !== 'boolean'
  )
    out.push('planFollowed: boolean or null');
  return out;
}

function cleanLabel(v: string | null | undefined): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t === '' ? undefined : t;
}

/**
 * Trim text, drop blank optional fields, and normalise tags. Callers still run
 * `journalEntryIssues` — this does not accept bad types or over-long text.
 * Unset optional fields are omitted so older `{ tags, note }` entries stay identical.
 */
export function normalizeJournalEntry(raw: {
  tags?: readonly string[];
  note?: string;
  setup?: string | null;
  marketCondition?: string | null;
  emotion?: string | null;
  planFollowed?: boolean | null;
  planNote?: string | null;
}): JournalEntry {
  const setup = cleanLabel(raw.setup);
  const marketCondition = cleanLabel(raw.marketCondition);
  const emotion = cleanLabel(raw.emotion);
  const planNote = cleanLabel(raw.planNote);
  const planFollowed =
    raw.planFollowed === true || raw.planFollowed === false ? raw.planFollowed : undefined;
  return {
    tags: normalizeTags(raw.tags ?? []),
    note: (raw.note ?? '').trim(),
    ...(setup !== undefined ? { setup } : {}),
    ...(marketCondition !== undefined ? { marketCondition } : {}),
    ...(emotion !== undefined ? { emotion } : {}),
    ...(planFollowed !== undefined ? { planFollowed } : {}),
    ...(planNote !== undefined ? { planNote } : {}),
  };
}

/** True when the entry carries no tags, note, or review fields (safe to delete). */
export function journalEntryBlank(e: JournalEntry): boolean {
  return (
    e.tags.length === 0 &&
    e.note === '' &&
    !e.setup &&
    !e.marketCondition &&
    !e.emotion &&
    (e.planFollowed === undefined || e.planFollowed === null) &&
    !e.planNote
  );
}

/**
 * Validate a journal PUT body, then return the stored entry. Tags are normalised
 * before the length check, matching the previous tags-and-note route.
 */
export function prepareJournalEntry(body: unknown): { entry: JournalEntry; issues: string[] } {
  const blank = { tags: [], note: '' };
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    return { entry: blank, issues: ['entry: not an object'] };
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some((k) => !KNOWN_FIELDS.has(k)))
    return { entry: blank, issues: ['entry: unknown field'] };
  const tagsOk = Array.isArray(b.tags) && b.tags.every((t) => typeof t === 'string');
  const noteOk = typeof b.note === 'string';
  const labelOk = (['setup', 'marketCondition', 'emotion', 'planNote'] as const).every(
    (k) => b[k] === undefined || b[k] === null || typeof b[k] === 'string',
  );
  const planOk =
    b.planFollowed === undefined || b.planFollowed === null || typeof b.planFollowed === 'boolean';
  if (!tagsOk || !noteOk || !labelOk || !planOk)
    return { entry: blank, issues: journalEntryIssues(b) };
  const entry = normalizeJournalEntry({
    tags: b.tags as string[],
    note: b.note as string,
    ...(b.setup !== undefined ? { setup: b.setup as string | null } : {}),
    ...(b.marketCondition !== undefined
      ? { marketCondition: b.marketCondition as string | null }
      : {}),
    ...(b.emotion !== undefined ? { emotion: b.emotion as string | null } : {}),
    ...(b.planFollowed !== undefined ? { planFollowed: b.planFollowed as boolean | null } : {}),
    ...(b.planNote !== undefined ? { planNote: b.planNote as string | null } : {}),
  });
  return { entry, issues: journalEntryIssues(entry) };
}

/** Problems with a whole journal against the trades it describes (empty = valid). */
export function journalIssues(j: unknown, trades: readonly Trade[]): string[] {
  if (typeof j !== 'object' || j === null || Array.isArray(j)) return ['journal: not an object'];
  const ids = new Set(trades.map((t) => String(t.id)));
  const out: string[] = [];
  for (const [k, v] of Object.entries(j)) {
    if (!ids.has(k)) out.push(`journal: no trade ${k.slice(0, 20)}`);
    else out.push(...journalEntryIssues(v).map((m) => `journal ${k}: ${m}`));
    if (out.length > 20) break;
  }
  return out;
}

export interface Excursion {
  readonly tradeId: number;
  /** Worst move against the trade from its average entry, in ticks (>= 0). */
  readonly maeTicks: number;
  /** Best move in favour of the trade from its average entry, in ticks (>= 0). */
  readonly mfeTicks: number;
  /** The same in R (per-contract planned risk); null when the trade had no complete stop. */
  readonly maeR: number | null;
  readonly mfeR: number | null;
  readonly bars: number;
}

function lowerBound(bars: readonly Bar[], time: number): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.time < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

export function tradeExcursions(
  bars: readonly Bar[],
  trades: readonly Trade[],
  settings: Pick<SessionSettings, 'tickSize' | 'pointValue'>,
): Excursion[] {
  return trades.map((t) => {
    let hi = -Infinity;
    let lo = Infinity;
    let n = 0;
    for (
      let i = lowerBound(bars, t.openTime);
      i < bars.length && bars[i]!.time <= t.closeTime;
      i++
    ) {
      hi = Math.max(hi, bars[i]!.high);
      lo = Math.min(lo, bars[i]!.low);
      n++;
    }
    if (n === 0)
      return { tradeId: t.id, maeTicks: 0, mfeTicks: 0, maeR: null, mfeR: null, bars: 0 };
    const long = t.side === 'long';
    const adverse = Math.max(0, long ? t.entryPrice - lo : hi - t.entryPrice);
    const favour = Math.max(0, long ? hi - t.entryPrice : t.entryPrice - lo);
    const riskPerUnit =
      t.initialRisk !== null && t.initialRisk > 0
        ? t.initialRisk / (t.qty * settings.pointValue)
        : null;
    return {
      tradeId: t.id,
      maeTicks: round6(adverse / settings.tickSize),
      mfeTicks: round6(favour / settings.tickSize),
      maeR: riskPerUnit ? round6(adverse / riskPerUnit) : null,
      mfeR: riskPerUnit ? round6(favour / riskPerUnit) : null,
      bars: n,
    };
  });
}

export interface GroupRow {
  /** "09" for an hour (exchange-local), "Mon".."Sun" for a weekday. */
  readonly key: string;
  readonly trades: number;
  readonly wins: number;
  readonly netPnl: number;
  readonly winRate: number;
}

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/** Closed trades grouped by the exchange-local hour or weekday they were opened in. */
export function groupTrades(
  trades: readonly Trade[],
  settings: Pick<SessionSettings, 'utcOffsetMinutes'>,
  by: 'hour' | 'weekday',
): GroupRow[] {
  const map = new Map<number, { trades: number; wins: number; net: number }>();
  for (const t of trades) {
    const d = new Date((t.openTime + settings.utcOffsetMinutes * 60) * 1000);
    const k = by === 'hour' ? d.getUTCHours() : (d.getUTCDay() + 6) % 7;
    const g = map.get(k) ?? { trades: 0, wins: 0, net: 0 };
    g.trades++;
    if (t.netPnl > 0) g.wins++;
    g.net += t.netPnl;
    map.set(k, g);
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([k, g]) => ({
      key: by === 'hour' ? String(k).padStart(2, '0') : WEEKDAYS[k]!,
      trades: g.trades,
      wins: g.wins,
      netPnl: Math.round(g.net * 1e8) / 1e8,
      winRate: g.wins / g.trades,
    }));
}
