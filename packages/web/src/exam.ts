// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Campaign exam: frozen rules, one certificate and one prefilled score submission.
// The daily round in `daily.ts` supplies the frozen data; this module supplies the
// rules, the tier and the form link. Delete both together when the campaign closes.

import type { SessionSettings } from './api.js';

export const EXAM_VERSION = 'exam-v1';
export const EXAM_ENDS_AT = Date.parse('2026-11-05T23:59:59+08:00');
export const EXAM_FORM_URL =
  'https://docs.google.com/forms/d/e/1FAIpQLSc15qDeKCZd-J7jGPQu6LF_45DY9VBS1U-QUU3qCJTNllZSbQ/viewform';

/** Prefilled answer ids from that form. Change the form, change these. */
const ENTRY = { token: 'entry.1153110697' } as const;

export const EXAM = {
  startDate: '2026-09-01',
  /** Ten sessions: a five-day round ended before a player behind could trade back. */
  days: 10,
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

/**
 * The cap only applies to orders that add exposure: closing or reducing a position
 * must always be allowed, or a 5-lot entry could never be flattened.
 */
export function examQtyAllowed(input: {
  readonly positionQty: number;
  readonly workingQty: number;
  readonly side: 'buy' | 'sell';
  readonly qty: number;
}): boolean {
  const adds = input.positionQty === 0 || input.positionQty > 0 === (input.side === 'buy');
  if (!adds) return true;
  return Math.abs(input.positionQty) + input.workingQty + input.qty <= 5;
}

export function examTier(net: number, maxDrawdownUsd: number, trades: number): ExamTier | null {
  if (!(net >= 3_000)) return null;
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
  readonly tier: ExamTier | null;
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
  const tier = examTier(net, maxDrawdownUsd, input.trades);
  const code = `EXAM-v1-${fnv1a(`${EXAM_VERSION}:${net}:${maxDrawdownUsd}:${input.trades}`)
    .toString(16)
    .padStart(8, '0')
    .slice(0, 8)
    .toUpperCase()}`;
  return {
    tier,
    net,
    maxDrawdownUsd,
    trades: input.trades,
    winRatePct: input.winRatePct ?? null,
    rrr: input.rrr ?? null,
    lots: input.lots ?? '—',
    code,
  };
}

function checksum(text: string): string {
  return fnv1a(text).toString(36).toUpperCase().padStart(6, '0').slice(0, 6);
}

/**
 * One pipe-delimited line so nothing on the form is a number a player can retype.
 * KFX1|tool|tier|net|maxDD|trades|winRate|rrr|lots|code|checksum
 */
export function examToken(result: ExamResult): string {
  const fields = [
    'KFX1',
    'CD',
    result.tier === 'distinction' ? 'DIST' : 'PASS',
    String(result.net),
    String(result.maxDrawdownUsd),
    String(result.trades),
    result.winRatePct === null ? '-' : String(result.winRatePct),
    result.rrr === null ? '-' : String(result.rrr),
    result.lots,
    result.code,
  ];
  return [...fields, checksum(fields.join('|'))].join('|');
}

/** True when the code still matches its own checksum. */
export function examTokenValid(token: string): boolean {
  const parts = token.split('|');
  if (parts.length !== 11 || parts[0] !== 'KFX1') return false;
  return checksum(parts.slice(0, 10).join('|')) === parts[10];
}

/** One prefilled link: the score travels as a checksummed code, the player types email only. */
export function examSubmitUrl(result: ExamResult): string {
  if (result.tier === null) throw new Error('not a passing run');
  const params = new URLSearchParams({
    usp: 'pp_url',
    [ENTRY.token]: examToken(result),
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
