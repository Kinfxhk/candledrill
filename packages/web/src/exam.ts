// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One-week campaign exam. The rules and the data are frozen here so every entrant
// gets the same bars; the whole feature is two modules plus a URL entry and is
// meant to be deleted when the campaign closes.

import { api, sessionsApi, type SessionSettings } from './api.js';

export const EXAM_VERSION = 'exam-v1';
export const EXAM_ENDS_AT = Date.parse('2026-11-05T23:59:59+08:00');
export const EXAM_FORM_URL =
  'https://docs.google.com/forms/d/e/1FAIpQLSd5lt961M8uiH8CviqyIksoaWcx_wEGbMBxLRxQrLtICIYXQw/viewform';

/** Prefilled answer ids from that form. Change the form, change these. */
const ENTRY = {
  tool: 'entry.561917348',
  tier: 'entry.1707438033',
  net: 'entry.337949414',
  maxDd: 'entry.412360479',
  trades: 'entry.459475028',
  code: 'entry.723542441',
} as const;

export const EXAM = {
  seed: 20_261_105,
  startDate: '2026-09-01',
  days: 5,
  timeframeSeconds: 300,
  maxQty: 5,
} as const;

/** Must equal the option text in the campaign form, or the prefill is dropped. */
export const EXAM_TIER_LABEL = {
  pass: 'Pass 合格',
  distinction: 'Distinction 優異（回撤 ≤ 1,000 且 ≥ 10 筆交易）',
} as const;

export type ExamTier = keyof typeof EXAM_TIER_LABEL;

const SESSION_KEY = 'candledrill.exam.session.v1';
const DATASET_KEY = 'candledrill.exam.dataset.v1';
const SUBMITTED_KEY = 'candledrill.exam.submitted.v1';
const BEST_KEY = 'candledrill.exam.best.v1';
const SHOWN_KEY = 'candledrill.exam.shown.v1';

export function examOpen(now: number = Date.now()): boolean {
  return now <= EXAM_ENDS_AT;
}

/** 50,000 · +3,000 target · 2,000 static drawdown · 5 contracts · 0.25 tick at $2. */
export function examSettings(): Omit<SessionSettings, 'symbol' | 'blind'> {
  return {
    tickSize: 0.25,
    pointValue: 2,
    commissionPerContract: 0.35,
    slippageTicks: 1,
    startingBalance: 50_000,
    dailyLossLimit: null,
    trailingDrawdown: 2_000,
    trailingDrawdownMode: 'static',
    profitTarget: 3_000,
    utcOffsetMinutes: 0,
    dayStartMinutes: 480,
    anchorMinutes: 480,
    practiceTimeframeSeconds: EXAM.timeframeSeconds,
  };
}

/** The dataset id plus its first bar time: a session needs a start time. */
async function examDataset(): Promise<{ id: number; firstTime: number | null }> {
  const stored = Number(localStorage.getItem(DATASET_KEY));
  if (stored > 0) {
    const { datasets } = await api.datasets();
    const row = datasets.find((dataset) => dataset.id === stored);
    if (row !== undefined && row.firstTime !== null) {
      return { id: row.id, firstTime: row.firstTime };
    }
  }
  const { dataset } = await api.createSynthetic(EXAM.seed, EXAM.startDate, EXAM.days, {
    timeframeSeconds: EXAM.timeframeSeconds,
  });
  localStorage.setItem(DATASET_KEY, String(dataset.id));
  return { id: dataset.id, firstTime: dataset.firstTime };
}

/** Create (or reopen) the one exam session this browser owns. */
export async function startExam(): Promise<number> {
  const current = examSessionId();
  if (current !== null) {
    const { sessions } = await sessionsApi.list();
    const row = sessions.find((session) => session.id === current);
    if (row !== undefined && row.status === 'active') return current;
  }
  const dataset = await examDataset();
  if (dataset.firstTime === null) throw new Error('exam dataset has no bars');
  const view = await sessionsApi.create({
    datasetId: dataset.id,
    name: `${EXAM_VERSION} · 50K`,
    startTime: dataset.firstTime,
    settings: examSettings(),
  });
  localStorage.setItem(SESSION_KEY, String(view.session.id));
  return view.session.id;
}

export function examSessionId(): number | null {
  const stored = Number(localStorage.getItem(SESSION_KEY));
  return stored > 0 ? stored : null;
}

export function isExamSession(id: number): boolean {
  return examSessionId() === id;
}

export function examTier(maxDrawdownUsd: number, trades: number): ExamTier {
  return maxDrawdownUsd <= 1_000 && trades >= 10 ? 'distinction' : 'pass';
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export type ExamResult = {
  readonly tier: ExamTier;
  readonly net: number;
  readonly maxDrawdownUsd: number;
  readonly trades: number;
  readonly code: string;
};

export function examResult(input: {
  readonly net: number;
  readonly maxDrawdownUsd: number;
  readonly trades: number;
}): ExamResult {
  const net = Math.round(input.net * 100) / 100;
  const maxDrawdownUsd = Math.round(input.maxDrawdownUsd * 100) / 100;
  const code = `EXAM-v1-${fnv1a(`${EXAM.seed}:${net}:${maxDrawdownUsd}:${input.trades}`)
    .toString(16)
    .padStart(8, '0')
    .slice(0, 8)
    .toUpperCase()}`;
  return {
    tier: examTier(maxDrawdownUsd, input.trades),
    net,
    maxDrawdownUsd,
    trades: input.trades,
    code,
  };
}

/** One prefilled link; the respondent only types their email. */
export function examSubmitUrl(result: ExamResult): string {
  const params = new URLSearchParams({
    usp: 'pp_url',
    [ENTRY.tool]: 'CandleDrill',
    [ENTRY.tier]: EXAM_TIER_LABEL[result.tier],
    [ENTRY.net]: String(result.net),
    [ENTRY.maxDd]: String(result.maxDrawdownUsd),
    [ENTRY.trades]: String(result.trades),
    [ENTRY.code]: result.code,
  });
  return `${EXAM_FORM_URL}?${params.toString()}`;
}

export type Submitted = { readonly at: number; readonly code: string };

export function readSubmitted(): Submitted | null {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(SUBMITTED_KEY) ?? 'null');
    if (typeof raw !== 'object' || raw === null) return null;
    const value = raw as Record<string, unknown>;
    if (typeof value.at !== 'number' || typeof value.code !== 'string') return null;
    return { at: value.at, code: value.code };
  } catch {
    return null;
  }
}

export function markSubmitted(result: ExamResult): void {
  try {
    localStorage.setItem(SUBMITTED_KEY, JSON.stringify({ at: Date.now(), code: result.code }));
  } catch {
    // Storage is optional; the card still shows the result.
  }
}

export function readBest(): ExamResult | null {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(BEST_KEY) ?? 'null');
    if (typeof raw !== 'object' || raw === null) return null;
    const value = raw as Record<string, unknown>;
    if (typeof value.net !== 'number') return null;
    return examResult({
      net: value.net,
      maxDrawdownUsd: typeof value.maxDrawdownUsd === 'number' ? value.maxDrawdownUsd : 0,
      trades: typeof value.trades === 'number' ? value.trades : 0,
    });
  } catch {
    return null;
  }
}

export function recordBest(result: ExamResult): void {
  const best = readBest();
  const better =
    best === null
      ? true
      : result.tier !== best.tier
        ? result.tier === 'distinction'
        : result.maxDrawdownUsd < best.maxDrawdownUsd ||
          (result.maxDrawdownUsd === best.maxDrawdownUsd && result.net > best.net);
  if (!better) return;
  try {
    localStorage.setItem(
      BEST_KEY,
      JSON.stringify({
        net: result.net,
        maxDrawdownUsd: result.maxDrawdownUsd,
        trades: result.trades,
      }),
    );
  } catch {
    // Storage is optional.
  }
}

/** The card fires once per session, on the transition that ends it. */
export function takeExamCardFor(sessionId: number, status: string): boolean {
  if (status !== 'passed' || !isExamSession(sessionId)) return false;
  const shown = localStorage.getItem(SHOWN_KEY);
  if (shown === String(sessionId)) return false;
  localStorage.setItem(SHOWN_KEY, String(sessionId));
  return true;
}
