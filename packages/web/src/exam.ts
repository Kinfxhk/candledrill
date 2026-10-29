// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Campaign exam: frozen rules, one certificate and one prefilled score submission.
// The daily round in `daily.ts` supplies the frozen data; this module supplies the
// rules, the tier and the form link. Delete both together when the campaign closes.

import type { SessionSettings } from './api.js';

export const EXAM_VERSION = 'exam-v1';
export const EXAM_ENDS_AT = Date.parse('2026-11-05T23:59:59+08:00');
export const EXAM_FORM_URL =
  'https://docs.google.com/forms/d/e/1FAIpQLSdM3UNvQ1_4iEuUCvARbI5aKzycAU1r3MFD58pVvuA_BeDeoQ/viewform';

/** Prefilled answer ids from that form. Change the form, change these. */
const ENTRY = {
  tool: 'entry.1388880711',
  tier: 'entry.281015303',
  net: 'entry.92678115',
  maxDd: 'entry.3454493',
  trades: 'entry.816234682',
  winRate: 'entry.542397379',
  rrr: 'entry.85917777',
  lots: 'entry.652454272',
  code: 'entry.973341008',
} as const;

export const EXAM = {
  startDate: '2026-09-01',
  days: 5,
  maxQty: 5,
} as const;

/** Must equal the option text in the campaign form, or the prefill is dropped. */
export const EXAM_TIER_LABEL = {
  pass: 'Pass 合格',
  distinction: 'Distinction 優異（回撤 ≤ 1,000 且 ≥ 10 筆交易）',
} as const;

export type ExamTier = keyof typeof EXAM_TIER_LABEL;

const SUBMITTED_KEY = 'candledrill.exam.submitted.v1';
const BEST_KEY = 'candledrill.exam.best.v1';

export function examOpen(now: number = Date.now()): boolean {
  return now <= EXAM_ENDS_AT;
}

/** 50,000 · +3,000 target · 2,000 static drawdown · 5 contracts · 0.25 tick at $2. */
export function examSettings(timeframeSeconds: number): Omit<SessionSettings, 'symbol' | 'blind'> {
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
    practiceTimeframeSeconds: timeframeSeconds,
  };
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
  readonly winRatePct: number | null;
  readonly rrr: number | null;
  readonly lots: string;
  readonly code: string;
};

export function examResult(input: {
  readonly net: number;
  readonly maxDrawdownUsd: number;
  readonly trades: number;
  readonly winRatePct?: number | null;
  readonly rrr?: number | null;
  readonly lots?: string;
}): ExamResult {
  const net = Math.round(input.net * 100) / 100;
  const maxDrawdownUsd = Math.round(input.maxDrawdownUsd * 100) / 100;
  const code = `EXAM-v1-${fnv1a(`${EXAM_VERSION}:${net}:${maxDrawdownUsd}:${input.trades}`)
    .toString(16)
    .padStart(8, '0')
    .slice(0, 8)
    .toUpperCase()}`;
  return {
    tier: examTier(maxDrawdownUsd, input.trades),
    net,
    maxDrawdownUsd,
    trades: input.trades,
    winRatePct: input.winRatePct ?? null,
    rrr: input.rrr ?? null,
    lots: input.lots ?? '—',
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
    [ENTRY.winRate]: result.winRatePct === null ? '—' : String(result.winRatePct),
    [ENTRY.rrr]: result.rrr === null ? '—' : String(result.rrr),
    [ENTRY.lots]: result.lots,
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
