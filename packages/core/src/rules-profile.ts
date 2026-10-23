// SPDX-License-Identifier: AGPL-3.0-or-later
//
// User-defined prop-style rule profiles. CandleDrill never ships firm names or presets
// (CONTRIBUTING §4): a profile is whatever the user types, saved and shared as JSON.
//
// A profile maps onto two layers:
//  - engine rules the fill model already enforces (daily loss, max loss with a drawdown mode,
//    profit target) → `profileToSettings`;
//  - evaluation rules that only need the finished trades (consistency, minimum trading days,
//    profit days, contract cap, time cut-off, overnight, trade count, losing streak) →
//    `evaluateProfile`. They are reported, never used to change fills, so the fill model is
//    unchanged and results stay reproducible.

import type { SessionSettings, SessionState, TrailingDrawdownMode } from './session.js';
import { sessionEquity, trailingPeak } from './session.js';
import type { Trade, Fill } from './orders.js';

export const RULE_PROFILE_FORMAT = 'candledrill-rule-profile';
export const RULE_PROFILE_VERSION = 1;
export const MAX_PROFILE_NAME = 60;
export const MAX_PROFILE_NOTE = 2_000;

export interface RuleProfile {
  readonly format: typeof RULE_PROFILE_FORMAT;
  readonly version: typeof RULE_PROFILE_VERSION;
  /** Stable id (client-generated), [A-Za-z0-9_-]{1,40}. */
  readonly id: string;
  readonly name: string;
  readonly note?: string;
  readonly accountSize: number;
  readonly profitTarget: number | null;
  readonly dailyLoss: number | null;
  readonly maxLoss: number | null;
  readonly maxLossMode: TrailingDrawdownMode;
  /** Largest share (0–100 %) of total profit allowed from one trading day. */
  readonly consistencyPct: number | null;
  readonly minTradingDays: number | null;
  readonly maxTradingDays: number | null;
  /** Profitable days needed, each at least `minProfitDayAmount`. */
  readonly minProfitDays: number | null;
  readonly minProfitDayAmount: number | null;
  readonly maxContracts: number | null;
  /** Exchange-local "HH:MM": positions must be flat by then each trading day. */
  readonly flatBy: string | null;
  readonly noOvernight: boolean;
  readonly maxTradesPerDay: number | null;
  readonly maxConsecutiveLosses: number | null;
}

export function blankProfile(id: string, name = 'My rules'): RuleProfile {
  return {
    format: RULE_PROFILE_FORMAT,
    version: RULE_PROFILE_VERSION,
    id,
    name,
    accountSize: 50_000,
    profitTarget: null,
    dailyLoss: null,
    maxLoss: null,
    maxLossMode: 'eod',
    consistencyPct: null,
    minTradingDays: null,
    maxTradingDays: null,
    minProfitDays: null,
    minProfitDayAmount: null,
    maxContracts: null,
    flatBy: null,
    noOvernight: false,
    maxTradesPerDay: null,
    maxConsecutiveLosses: null,
  };
}

const NUM_KEYS = [
  'profitTarget',
  'dailyLoss',
  'maxLoss',
  'consistencyPct',
  'minTradingDays',
  'maxTradingDays',
  'minProfitDays',
  'minProfitDayAmount',
  'maxContracts',
  'maxTradesPerDay',
  'maxConsecutiveLosses',
] as const;
const INT_KEYS = new Set<string>([
  'minTradingDays',
  'maxTradingDays',
  'minProfitDays',
  'maxContracts',
  'maxTradesPerDay',
  'maxConsecutiveLosses',
]);
const KNOWN = new Set<string>([
  'format',
  'version',
  'id',
  'name',
  'note',
  'accountSize',
  'maxLossMode',
  'flatBy',
  'noOvernight',
  ...NUM_KEYS,
]);

/** Problems with a profile (empty = valid). Unknown keys are rejected, not stripped. */
export function profileIssues(raw: unknown): string[] {
  const out: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['profile: not an object'];
  const p = raw as Record<string, unknown>;
  for (const k of Object.keys(p)) if (!KNOWN.has(k)) out.push(`${k}: unknown field`);
  if (p.format !== RULE_PROFILE_FORMAT) out.push('format: not a CandleDrill rule profile');
  if (p.version !== RULE_PROFILE_VERSION) out.push('version: unsupported');
  if (typeof p.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(p.id)) out.push('id: invalid');
  if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > MAX_PROFILE_NAME)
    out.push(`name: 1-${MAX_PROFILE_NAME} characters`);
  if (p.note !== undefined && (typeof p.note !== 'string' || p.note.length > MAX_PROFILE_NOTE))
    out.push(`note: up to ${MAX_PROFILE_NOTE} characters`);
  if (typeof p.accountSize !== 'number' || !Number.isFinite(p.accountSize) || p.accountSize <= 0)
    out.push('accountSize: must be > 0');
  for (const k of NUM_KEYS) {
    const v = p[k];
    if (v === null) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      out.push(`${k}: must be > 0 or null`);
      continue;
    }
    if (INT_KEYS.has(k) && !Number.isInteger(v)) out.push(`${k}: must be a whole number`);
  }
  if (typeof p.consistencyPct === 'number' && p.consistencyPct > 100)
    out.push('consistencyPct: 1-100');
  if (
    typeof p.minTradingDays === 'number' &&
    typeof p.maxTradingDays === 'number' &&
    p.minTradingDays > p.maxTradingDays
  )
    out.push('minTradingDays: larger than maxTradingDays');
  if (!['close', 'eod', 'intraday', 'static'].includes(p.maxLossMode as string))
    out.push("maxLossMode: 'close' | 'eod' | 'intraday' | 'static'");
  if (
    p.flatBy !== null &&
    (typeof p.flatBy !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(p.flatBy))
  )
    out.push('flatBy: HH:MM or null');
  if (typeof p.noOvernight !== 'boolean') out.push('noOvernight: true or false');
  return out;
}

/** Parse a profile file; returns the profile or the reasons it was refused. */
export function parseProfile(text: string): { profile?: RuleProfile; issues: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { issues: ['not valid JSON'] };
  }
  const issues = profileIssues(raw);
  return issues.length ? { issues } : { profile: raw as RuleProfile, issues };
}

/** The engine half of a profile: the session settings it sets. */
export function profileToSettings(
  p: RuleProfile,
): Pick<
  SessionSettings,
  | 'startingBalance'
  | 'dailyLossLimit'
  | 'trailingDrawdown'
  | 'trailingDrawdownMode'
  | 'profitTarget'
> {
  return {
    startingBalance: p.accountSize,
    dailyLossLimit: p.dailyLoss,
    trailingDrawdown: p.maxLoss,
    trailingDrawdownMode: p.maxLossMode,
    profitTarget: p.profitTarget,
  };
}

// ------------------------------------------------------------------ evaluation
export type RuleId =
  | 'profitTarget'
  | 'dailyLoss'
  | 'maxLoss'
  | 'consistency'
  | 'minTradingDays'
  | 'maxTradingDays'
  | 'minProfitDays'
  | 'maxContracts'
  | 'flatBy'
  | 'noOvernight'
  | 'maxTradesPerDay'
  | 'maxConsecutiveLosses';

/** pass = met; fail = broken (with when); pending = not met yet but still reachable. */
export type RuleState = 'pass' | 'fail' | 'pending';

export interface RuleResult {
  readonly id: RuleId;
  readonly state: RuleState;
  /** Current value and the limit, in the rule's own unit (currency, %, days, contracts…). */
  readonly value: number | null;
  readonly limit: number | null;
  /** First time (Unix seconds) the rule broke, if it did. */
  readonly brokenAt?: number;
  /** Extra numbers for the UI (for consistency: best day and total profit). */
  readonly detail?: Readonly<Record<string, number>>;
}

export interface ProfileReport {
  readonly results: readonly RuleResult[];
  /** fail if any rule failed; pass if all passed; otherwise pending. */
  readonly overall: RuleState;
  readonly tradingDays: number;
  readonly dayPnl: ReadonlyArray<{ day: number; pnl: number }>;
}

export interface EvalClock {
  readonly utcOffsetMinutes: number;
  /** Trading-day boundary (exchange-local minute). */
  readonly dayStartMinutes: number;
}

function dayOf(time: number, c: EvalClock): number {
  return Math.floor((time + c.utcOffsetMinutes * 60 - c.dayStartMinutes * 60) / 86_400);
}
function localMinute(time: number, c: EvalClock): number {
  const m = Math.floor((time + c.utcOffsetMinutes * 60) / 60) % 1440;
  return m < 0 ? m + 1440 : m;
}
function minutesSinceDayStart(time: number, c: EvalClock): number {
  return (localMinute(time, c) - c.dayStartMinutes + 1440) % 1440;
}

/**
 * Evaluate a profile against a session. Uses only revealed history (fills and closed trades
 * up to the cursor), so it never looks ahead. `cursorTime` is the time of the current bar.
 */
export function evaluateProfile(
  p: RuleProfile,
  settings: SessionSettings,
  state: SessionState,
  clock: EvalClock,
  cursorTime: number,
): ProfileReport {
  const trades: readonly Trade[] = state.trading.trades;
  const fills: readonly Fill[] = state.trading.fills;
  const results: RuleResult[] = [];

  // Net P&L per trading day, by trade close (the usual way profit days are counted).
  const pnlByDay = new Map<number, number>();
  const daysTraded = new Set<number>();
  for (const f of fills) daysTraded.add(dayOf(f.time, clock));
  for (const t of trades) {
    const d = dayOf(t.closeTime, clock);
    pnlByDay.set(d, (pnlByDay.get(d) ?? 0) + t.netPnl);
  }
  const dayPnl = [...pnlByDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, pnl]) => ({ day, pnl: Math.round(pnl * 100) / 100 }));
  const totalNet = trades.reduce((s, t) => s + t.netPnl, 0);
  const engineBreach = state.status === 'breached' ? (state.statusReason ?? '') : '';

  // Engine rules: read the engine's own outcome so the report can never disagree with it.
  if (p.profitTarget !== null) {
    const gain = sessionEquity(settings, state) - settings.startingBalance;
    results.push({
      id: 'profitTarget',
      state: state.status === 'passed' ? 'pass' : 'pending',
      value: Math.round(gain * 100) / 100,
      limit: p.profitTarget,
    });
  }
  if (p.dailyLoss !== null) {
    const used = Math.max(0, state.dayStartEquity - sessionEquity(settings, state));
    results.push({
      id: 'dailyLoss',
      state: engineBreach.startsWith('daily loss') ? 'fail' : 'pass',
      value: Math.round(used * 100) / 100,
      limit: p.dailyLoss,
    });
  }
  if (p.maxLoss !== null) {
    // Same basis as the engine rule: distance below the mode's peak (or the static floor).
    const used = Math.max(0, trailingPeak(settings, state) - sessionEquity(settings, state));
    results.push({
      id: 'maxLoss',
      state: engineBreach.startsWith('trailing drawdown') ? 'fail' : 'pass',
      value: Math.round(used * 100) / 100,
      limit: p.maxLoss,
    });
  }

  // Consistency: best day ≤ X % of total profit (only meaningful once there is profit).
  if (p.consistencyPct !== null) {
    const best = dayPnl.reduce((m, d) => Math.max(m, d.pnl), 0);
    const share = totalNet > 0 ? (best / totalNet) * 100 : null;
    results.push({
      id: 'consistency',
      state: share === null ? 'pending' : share <= p.consistencyPct + 1e-9 ? 'pass' : 'pending',
      value: share === null ? null : Math.round(share * 10) / 10,
      limit: p.consistencyPct,
      detail: {
        bestDay: Math.round(best * 100) / 100,
        totalProfit: Math.round(totalNet * 100) / 100,
      },
    });
  }
  if (p.minTradingDays !== null)
    results.push({
      id: 'minTradingDays',
      state: daysTraded.size >= p.minTradingDays ? 'pass' : 'pending',
      value: daysTraded.size,
      limit: p.minTradingDays,
    });
  if (p.maxTradingDays !== null) {
    const firstDay = fills.length ? dayOf(fills[0]!.time, clock) : null;
    const elapsed = firstDay === null ? 0 : dayOf(cursorTime, clock) - firstDay + 1;
    results.push({
      id: 'maxTradingDays',
      state: daysTraded.size > p.maxTradingDays ? 'fail' : 'pass',
      value: daysTraded.size,
      limit: p.maxTradingDays,
      detail: { calendarDays: elapsed },
    });
  }
  if (p.minProfitDays !== null) {
    const min = p.minProfitDayAmount ?? 0;
    const n = dayPnl.filter((d) => d.pnl > 0 && d.pnl >= min).length;
    results.push({
      id: 'minProfitDays',
      state: n >= p.minProfitDays ? 'pass' : 'pending',
      value: n,
      limit: p.minProfitDays,
      ...(p.minProfitDayAmount !== null ? { detail: { minAmount: p.minProfitDayAmount } } : {}),
    });
  }

  // Position-based rules: replay the fills to get the open size over time, then check each
  // interval the position was open, [fill time, next fill time or the current bar).
  const cut = p.flatBy ? Number(p.flatBy.slice(0, 2)) * 60 + Number(p.flatBy.slice(3)) : null;
  const cutAfterStart = cut === null ? null : (cut - clock.dayStartMinutes + 1440) % 1440;
  /** Instant of the cut-off on trading day `d`. */
  const cutInstant = (d: number) =>
    d * 86_400 + (clock.dayStartMinutes - clock.utcOffsetMinutes + (cutAfterStart ?? 0)) * 60;
  /** Instant trading day `d` starts. */
  const dayStartInstant = (d: number) =>
    d * 86_400 + (clock.dayStartMinutes - clock.utcOffsetMinutes) * 60;
  let pos = 0;
  let maxPos = 0;
  let maxPosAt: number | undefined;
  let flatByBreak: number | undefined;
  let overnightBreak: number | undefined;
  const checkOpenInterval = (a: number, b: number) => {
    if (cutAfterStart !== null && flatByBreak === undefined) {
      if (minutesSinceDayStart(a, clock) >= cutAfterStart) flatByBreak = a;
      else {
        const c = cutInstant(dayOf(a, clock));
        if (c < b) flatByBreak = c;
      }
    }
    if (p.noOvernight && overnightBreak === undefined && dayOf(b, clock) > dayOf(a, clock))
      overnightBreak = dayStartInstant(dayOf(a, clock) + 1);
  };
  for (let i = 0; i < fills.length; i++) {
    const f = fills[i]!;
    pos += f.side === 'buy' ? f.qty : -f.qty;
    if (Math.abs(pos) > maxPos) {
      maxPos = Math.abs(pos);
      if (p.maxContracts !== null && maxPos > p.maxContracts && maxPosAt === undefined)
        maxPosAt = f.time;
    }
    if (pos === 0) continue;
    // Fills at the same instant (a bracket exit and the next entry) do not open a gap.
    const next = fills[i + 1]?.time ?? cursorTime;
    if (next > f.time || i === fills.length - 1) checkOpenInterval(f.time, Math.max(next, f.time));
  }

  if (p.maxContracts !== null)
    results.push({
      id: 'maxContracts',
      state: maxPosAt === undefined ? 'pass' : 'fail',
      value: maxPos,
      limit: p.maxContracts,
      ...(maxPosAt !== undefined ? { brokenAt: maxPosAt } : {}),
    });
  if (p.flatBy !== null)
    results.push({
      id: 'flatBy',
      state: flatByBreak === undefined ? 'pass' : 'fail',
      value: null,
      limit: cut,
      ...(flatByBreak !== undefined ? { brokenAt: flatByBreak } : {}),
    });
  if (p.noOvernight)
    results.push({
      id: 'noOvernight',
      state: overnightBreak === undefined ? 'pass' : 'fail',
      value: null,
      limit: null,
      ...(overnightBreak !== undefined ? { brokenAt: overnightBreak } : {}),
    });

  // Trades per day (counted at entry) and losing streak (completed trades, net of costs).
  if (p.maxTradesPerDay !== null) {
    const perDay = new Map<number, number>();
    let worst = 0;
    let brokenAt: number | undefined;
    for (const t of trades) {
      const d = dayOf(t.openTime, clock);
      const n = (perDay.get(d) ?? 0) + 1;
      perDay.set(d, n);
      worst = Math.max(worst, n);
      if (n > p.maxTradesPerDay && brokenAt === undefined) brokenAt = t.openTime;
    }
    results.push({
      id: 'maxTradesPerDay',
      state: brokenAt === undefined ? 'pass' : 'fail',
      value: worst,
      limit: p.maxTradesPerDay,
      ...(brokenAt !== undefined ? { brokenAt } : {}),
    });
  }
  if (p.maxConsecutiveLosses !== null) {
    let run = 0;
    let worst = 0;
    let brokenAt: number | undefined;
    for (const t of trades) {
      run = t.netPnl < 0 ? run + 1 : 0;
      worst = Math.max(worst, run);
      if (run > p.maxConsecutiveLosses && brokenAt === undefined) brokenAt = t.closeTime;
    }
    results.push({
      id: 'maxConsecutiveLosses',
      state: brokenAt === undefined ? 'pass' : 'fail',
      value: worst,
      limit: p.maxConsecutiveLosses,
      ...(brokenAt !== undefined ? { brokenAt } : {}),
    });
  }

  const overall: RuleState = results.some((r) => r.state === 'fail')
    ? 'fail'
    : results.length && results.every((r) => r.state === 'pass')
      ? 'pass'
      : 'pending';
  return { results, overall, tradingDays: daysTraded.size, dayPnl };
}
