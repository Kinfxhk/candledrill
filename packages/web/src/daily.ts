// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One frozen exam round per day: the day string picks the seed and the timeframe, so
// everyone who opens that day trades the same bars. One scored attempt per day.

import { formingSourceSeconds, isSyntheticTimeframe } from '@candledrill/core';
import { api, sessionsApi } from './api.js';
import { EXAM, examSettings } from './exam.js';

const STORE_KEY = 'candledrill.daily.v2';
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Fast instruments only: an hourly bar makes a one-day round feel like waiting. */
const TIMEFRAMES = [60, 300, 900] as const;

export type DailyResult = {
  readonly status: 'passed' | 'breached' | 'finished';
  readonly net: number;
  readonly maxDrawdown: number;
  readonly trades: number;
  readonly at: number;
};

type DailyEntry = {
  readonly datasetId: number;
  readonly sessionId: number;
  result?: DailyResult;
};

type DailyStore = Readonly<Record<string, DailyEntry>>;

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function isDailyDay(value: string): boolean {
  if (!DAY_PATTERN.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

/** Local calendar day, so the round turns over at the entrant's midnight. */
export function todayDay(now: number = Date.now()): string {
  const date = new Date(now);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function dailySeed(day: string): number {
  return fnv1a(`candledrill-daily:${day}`);
}

export function dailyTimeframe(day: string): number {
  const seed = dailySeed(day);
  return TIMEFRAMES[(seed >>> 8) % TIMEFRAMES.length] ?? 300;
}

/**
 * The generator only accepts bar spacings it can form: 1m and 5m stand alone, while a
 * 15m practice round is built from 5m bars with fills every third close.
 */
export function dailySourceSeconds(day: string): number {
  const practice = dailyTimeframe(day);
  return isSyntheticTimeframe(practice) ? practice : formingSourceSeconds(practice);
}

function readStore(): DailyStore {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}');
    if (typeof raw !== 'object' || raw === null) return {};
    const store: Record<string, DailyEntry> = {};
    for (const [day, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!isDailyDay(day)) continue;
      const entry = value as Record<string, unknown>;
      if (typeof entry.datasetId !== 'number' || typeof entry.sessionId !== 'number') continue;
      const result =
        typeof entry.result === 'object' && entry.result !== null
          ? (entry.result as DailyResult)
          : undefined;
      store[day] = {
        datasetId: entry.datasetId,
        sessionId: entry.sessionId,
        ...(result === undefined ? {} : { result }),
      };
    }
    return store;
  } catch {
    return {};
  }
}

function writeStore(store: DailyStore): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    // Storage is optional; the round still runs.
  }
}

export function dailyEntry(day: string): DailyEntry | null {
  return readStore()[day] ?? null;
}

export function dailyResult(day: string): DailyResult | null {
  return dailyEntry(day)?.result ?? null;
}

export function dailySessionDay(sessionId: number): string | null {
  for (const [day, entry] of Object.entries(readStore())) {
    if (entry.sessionId === sessionId) return day;
  }
  return null;
}

/** One scored attempt per day; later attempts stay practice. */
export function recordDailyResult(day: string, sessionId: number, result: DailyResult): boolean {
  const store = readStore();
  const entry = store[day];
  if (entry === undefined || entry.sessionId !== sessionId || entry.result !== undefined) {
    return false;
  }
  writeStore({ ...store, [day]: { ...entry, result } });
  return true;
}

async function dailyDataset(
  day: string,
  storedId: number | undefined,
): Promise<{ id: number; firstTime: number }> {
  if (storedId !== undefined) {
    const { datasets } = await api.datasets();
    const row = datasets.find((dataset) => dataset.id === storedId);
    if (row !== undefined && row.firstTime !== null) {
      return { id: row.id, firstTime: row.firstTime };
    }
  }
  const { dataset } = await api.createSynthetic(dailySeed(day), EXAM.startDate, EXAM.days, {
    timeframeSeconds: dailySourceSeconds(day),
  });
  if (dataset.firstTime === null) throw new Error('daily dataset has no bars');
  return { id: dataset.id, firstTime: dataset.firstTime };
}

/** Create (or reopen) today's round. */
export async function startDaily(day: string): Promise<number> {
  if (!isDailyDay(day)) throw new Error('bad day');
  const entry = dailyEntry(day);
  if (entry !== null) {
    const { sessions } = await sessionsApi.list();
    const row = sessions.find((session) => session.id === entry.sessionId);
    if (row !== undefined && row.status === 'active') return entry.sessionId;
  }
  const dataset = await dailyDataset(day, entry?.datasetId);
  const view = await sessionsApi.create({
    datasetId: dataset.id,
    name: `每日一局 · ${day}`,
    startTime: dataset.firstTime,
    settings: examSettings(dailyTimeframe(day)),
  });
  writeStore({
    ...readStore(),
    [day]: {
      datasetId: dataset.id,
      sessionId: view.session.id,
      ...(entry?.result ? { result: entry.result } : {}),
    },
  });
  return view.session.id;
}
