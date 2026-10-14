// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Simulated macro: a JSON condition list evaluated on each closed bar, then a market
// order with a fixed bracket sent through the same placeOrder / processBar path as the
// manual ticket. This module does not talk to a broker and does not change fill rules.

import {
  adx,
  atr,
  bollinger,
  donchian,
  ema,
  exchangeLocalMinute,
  macd,
  orbLevels,
  rsi,
  sma,
  stochastic,
  tradingDayKey,
  type IndicatorSource,
} from './indicators.js';
import { OrderError, roundToTick, type Side, type Trade } from './orders.js';
import {
  createSession,
  dayKeyOf,
  sessionFlatten,
  sessionPlaceOrder,
  sessionStats,
  stepSession,
  type SessionSettings,
  type SessionState,
  type SessionStatus,
} from './session.js';
import type { SessionStats } from './stats.js';
import type { Bar } from './types.js';

export const MACRO_SCHEMA_VERSION = 1 as const;

export type MaKind = 'sma' | 'ema';

export interface MaRef {
  readonly ma: MaKind;
  readonly period: number;
  readonly source?: IndicatorSource;
}

export type Condition =
  | {
      readonly type: 'price_vs_ma';
      readonly op: 'above' | 'below';
      readonly ma: MaKind;
      readonly period: number;
      readonly source?: IndicatorSource;
    }
  | {
      readonly type: 'ma_cross';
      readonly direction: 'bull' | 'bear';
      readonly fast: MaRef;
      readonly slow: MaRef;
    }
  | {
      readonly type: 'orb_break';
      readonly minutes: number;
      readonly direction: 'up' | 'down' | 'either';
    }
  | {
      readonly type: 'rsi';
      readonly op: 'gt' | 'lt' | 'cross_above' | 'cross_below';
      readonly level: number;
      readonly period?: number;
    }
  | {
      readonly type: 'bb';
      readonly which: 'upper' | 'lower' | 'middle';
      readonly op: 'touch' | 'close_beyond';
      readonly period?: number;
      readonly stdDev?: number;
    }
  | {
      readonly type: 'macd';
      readonly event: 'hist_pos' | 'hist_neg' | 'cross_bull' | 'cross_bear';
      readonly fast?: number;
      readonly slow?: number;
      readonly signal?: number;
    }
  | {
      readonly type: 'donchian_break';
      readonly period: number;
      readonly direction: 'up' | 'down';
    }
  | {
      readonly type: 'stoch_cross';
      readonly direction: 'bull' | 'bear';
      readonly kPeriod?: number;
      readonly dPeriod?: number;
      readonly smooth?: number;
      /** When set, a bull cross also requires the previous %K to be at or below this level. */
      readonly level?: number;
    }
  | {
      readonly type: 'adx';
      readonly op: 'gt' | 'lt';
      readonly level: number;
      readonly period?: number;
      readonly di?: 'plus_above' | 'minus_above' | 'any';
    }
  | {
      readonly type: 'time_window';
      /** Exchange-local minute of day, inclusive. */
      readonly startMinute: number;
      readonly endMinute: number;
    }
  | { readonly type: 'day_of_week'; readonly days: readonly number[] }
  | { readonly type: 'min_bars_since_entry'; readonly bars: number }
  | { readonly type: 'flat_only' };

export interface MacroRule {
  readonly id: string;
  /** Lower number wins when several rules are true on the same bar. */
  readonly priority: number;
  readonly enabled: boolean;
  readonly side: Side;
  /** Every condition must be true (AND). */
  readonly conditions: readonly Condition[];
}

export type StopMode = 'ticks' | 'atr_mult' | 'percent';
export type TargetMode = 'ticks' | 'atr_mult' | 'rr' | 'percent';

export interface MacroExit {
  readonly stop: { readonly mode: StopMode; readonly value: number };
  readonly target: { readonly mode: TargetMode; readonly value: number };
  /** Place a flatten when the next bar belongs to a new exchange trading day. */
  readonly flattenAtSessionEnd?: boolean;
}

export interface MacroV1 {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly qty: number;
  readonly exit: MacroExit;
  readonly rules: readonly MacroRule[];
  /** Default true: do not send a new entry while a position or working entry exists. */
  readonly onePositionOnly?: boolean;
  readonly maxTradesPerDay?: number;
}

export interface MacroSignal {
  readonly ruleId: string;
  readonly side: Side;
  readonly stopLoss: number;
  readonly takeProfit: number;
}

export interface MacroRunOptions {
  readonly mode: 'to_end' | 'n_bars';
  readonly count?: number;
  /** `start` rebuilds a fresh session at the first bar. `cursor` continues a copy of `state`. */
  readonly from: 'start' | 'cursor';
}

export interface MacroRunResult {
  readonly simulated: true;
  readonly from: 'start' | 'cursor';
  readonly mode: 'to_end' | 'n_bars';
  readonly barsProcessed: number;
  readonly signals: number;
  readonly stats: SessionStats;
  readonly trades: readonly Trade[];
  readonly openQty: number;
  readonly status: SessionStatus;
}

const MAX_RULES = 20;
const MAX_CONDITIONS = 12;
const ATR_PERIOD = 14;

function fail(message: string): never {
  throw new Error(message);
}

function assertNever(value: never): never {
  return fail(`unhandled variant ${JSON.stringify(value)}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function positiveInt(v: unknown, name: string, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > max) {
    fail(`${name} must be an integer 1-${max}`);
  }
  return v;
}

function positiveNum(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) fail(`${name} must be > 0`);
  return v;
}

function oneOf<T extends string>(v: unknown, name: string, allowed: readonly T[]): T {
  if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T;
  fail(`${name} must be ${allowed.join('|')}`);
}

function optPeriod(v: unknown, fallback: number): number {
  if (v === undefined) return fallback;
  return positiveInt(v, 'period', 500);
}

function optSource(v: unknown): IndicatorSource | undefined {
  if (v === undefined) return undefined;
  return oneOf(v, 'source', ['open', 'high', 'low', 'close', 'hlc3'] as const);
}

function parseMaRef(raw: unknown, name: string): MaRef {
  if (!isRecord(raw)) fail(`${name} must be an object`);
  const source = optSource(raw.source);
  return {
    ma: oneOf(raw.ma, `${name}.ma`, ['sma', 'ema'] as const),
    period: positiveInt(raw.period, `${name}.period`, 500),
    ...(source ? { source } : {}),
  };
}

function parseCondition(raw: unknown): Condition {
  if (!isRecord(raw)) fail('condition must be an object');
  const type = raw.type;
  switch (type) {
    case 'price_vs_ma': {
      const source = optSource(raw.source);
      return {
        type,
        op: oneOf(raw.op, 'op', ['above', 'below'] as const),
        ma: oneOf(raw.ma, 'ma', ['sma', 'ema'] as const),
        period: positiveInt(raw.period, 'period', 500),
        ...(source ? { source } : {}),
      };
    }
    case 'ma_cross':
      return {
        type,
        direction: oneOf(raw.direction, 'direction', ['bull', 'bear'] as const),
        fast: parseMaRef(raw.fast, 'fast'),
        slow: parseMaRef(raw.slow, 'slow'),
      };
    case 'orb_break':
      return {
        type,
        minutes: positiveInt(raw.minutes, 'minutes', 1439),
        direction: oneOf(raw.direction, 'direction', ['up', 'down', 'either'] as const),
      };
    case 'rsi':
      return {
        type,
        op: oneOf(raw.op, 'op', ['gt', 'lt', 'cross_above', 'cross_below'] as const),
        level: positiveNum(raw.level, 'level'),
        period: optPeriod(raw.period, 14),
      };
    case 'bb':
      return {
        type,
        which: oneOf(raw.which, 'which', ['upper', 'lower', 'middle'] as const),
        op: oneOf(raw.op, 'op', ['touch', 'close_beyond'] as const),
        period: optPeriod(raw.period, 20),
        stdDev: raw.stdDev === undefined ? 2 : positiveNum(raw.stdDev, 'stdDev'),
      };
    case 'macd':
      return {
        type,
        event: oneOf(raw.event, 'event', [
          'hist_pos',
          'hist_neg',
          'cross_bull',
          'cross_bear',
        ] as const),
        fast: optPeriod(raw.fast, 12),
        slow: optPeriod(raw.slow, 26),
        signal: optPeriod(raw.signal, 9),
      };
    case 'donchian_break':
      return {
        type,
        period: positiveInt(raw.period, 'period', 500),
        direction: oneOf(raw.direction, 'direction', ['up', 'down'] as const),
      };
    case 'stoch_cross': {
      const level = raw.level === undefined ? undefined : positiveNum(raw.level, 'level');
      return {
        type,
        direction: oneOf(raw.direction, 'direction', ['bull', 'bear'] as const),
        kPeriod: optPeriod(raw.kPeriod, 14),
        dPeriod: optPeriod(raw.dPeriod, 3),
        smooth: optPeriod(raw.smooth, 3),
        ...(level !== undefined ? { level } : {}),
      };
    }
    case 'adx':
      return {
        type,
        op: oneOf(raw.op, 'op', ['gt', 'lt'] as const),
        level: positiveNum(raw.level, 'level'),
        period: optPeriod(raw.period, 14),
        di:
          raw.di === undefined
            ? 'any'
            : oneOf(raw.di, 'di', ['plus_above', 'minus_above', 'any'] as const),
      };
    case 'time_window': {
      const startMinute = raw.startMinute;
      const endMinute = raw.endMinute;
      if (
        typeof startMinute !== 'number' ||
        typeof endMinute !== 'number' ||
        !Number.isInteger(startMinute) ||
        !Number.isInteger(endMinute) ||
        startMinute < 0 ||
        endMinute < 0 ||
        startMinute > 1439 ||
        endMinute > 1439
      ) {
        fail('time window minutes must be integers 0-1439');
      }
      return { type, startMinute, endMinute };
    }
    case 'day_of_week': {
      if (!Array.isArray(raw.days) || raw.days.length < 1) fail('days must be a non-empty array');
      const days = raw.days.map((d) => {
        if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 6) {
          fail('day of week must be an integer 0-6 (Sunday = 0, UTC of the bar open)');
        }
        return d;
      });
      return { type, days };
    }
    case 'min_bars_since_entry':
      return { type, bars: positiveInt(raw.bars, 'bars', 100_000) };
    case 'flat_only':
      return { type };
    default:
      fail(`unknown condition type ${String(type)}`);
  }
}

function parseExit(raw: unknown): MacroExit {
  if (!isRecord(raw)) fail('exit must be an object');
  if (!isRecord(raw.stop) || !isRecord(raw.target)) fail('exit.stop and exit.target are required');
  return {
    stop: {
      mode: oneOf(raw.stop.mode, 'stop.mode', ['ticks', 'atr_mult', 'percent'] as const),
      value: positiveNum(raw.stop.value, 'stop.value'),
    },
    target: {
      mode: oneOf(raw.target.mode, 'target.mode', ['ticks', 'atr_mult', 'rr', 'percent'] as const),
      value: positiveNum(raw.target.value, 'target.value'),
    },
    ...(raw.flattenAtSessionEnd === undefined
      ? {}
      : { flattenAtSessionEnd: raw.flattenAtSessionEnd === true }),
  };
}

function parseRule(raw: unknown, index: number): MacroRule {
  if (!isRecord(raw)) fail(`rule ${index} must be an object`);
  if (typeof raw.id !== 'string' || raw.id.length < 1 || raw.id.length > 64) {
    fail(`rule ${index} id must be a string of 1-64 characters`);
  }
  if (
    !Array.isArray(raw.conditions) ||
    raw.conditions.length < 1 ||
    raw.conditions.length > MAX_CONDITIONS
  ) {
    fail(`rule ${index} needs 1-${MAX_CONDITIONS} conditions`);
  }
  if (typeof raw.priority !== 'number' || !Number.isInteger(raw.priority)) {
    fail(`rule ${index} priority must be an integer`);
  }
  return {
    id: raw.id,
    priority: raw.priority,
    enabled: raw.enabled !== false,
    side: oneOf(raw.side, 'side', ['buy', 'sell'] as const),
    conditions: raw.conditions.map((c) => parseCondition(c)),
  };
}

/** Validate and normalise a macro document. Throws Error with a short reason. */
export function parseMacro(raw: unknown): MacroV1 {
  if (!isRecord(raw)) fail('macro must be an object');
  if (raw.schemaVersion !== 1) fail('schemaVersion must be 1');
  if (typeof raw.name !== 'string' || raw.name.trim().length < 1 || raw.name.length > 80) {
    fail('name must be 1-80 characters');
  }
  if (!Array.isArray(raw.rules) || raw.rules.length < 1 || raw.rules.length > MAX_RULES) {
    fail(`rules must contain 1-${MAX_RULES} rules`);
  }
  const ids = new Set<string>();
  const rules = raw.rules.map((r, i) => {
    const rule = parseRule(r, i);
    if (ids.has(rule.id)) fail(`duplicate rule id ${rule.id}`);
    ids.add(rule.id);
    return rule;
  });
  const maxTrades =
    raw.maxTradesPerDay === undefined
      ? undefined
      : positiveInt(raw.maxTradesPerDay, 'maxTradesPerDay', 10_000);
  return {
    schemaVersion: 1,
    name: raw.name.trim(),
    qty: positiveInt(raw.qty, 'qty', 10_000),
    exit: parseExit(raw.exit),
    rules,
    onePositionOnly: raw.onePositionOnly !== false,
    ...(maxTrades !== undefined ? { maxTradesPerDay: maxTrades } : {}),
  };
}

/** Ready-made ORB(30) long break with close above SMA(21), 40-tick stop and 2R target. */
export function exampleOrbSmaMacro(): MacroV1 {
  return parseMacro({
    schemaVersion: 1,
    name: 'ORB + SMA',
    qty: 1,
    onePositionOnly: true,
    exit: {
      stop: { mode: 'ticks', value: 40 },
      target: { mode: 'rr', value: 2 },
    },
    rules: [
      {
        id: 'orb-sma-long',
        priority: 1,
        enabled: true,
        side: 'buy',
        conditions: [
          { type: 'orb_break', minutes: 30, direction: 'up' },
          { type: 'price_vs_ma', op: 'above', ma: 'sma', period: 21, source: 'close' },
          { type: 'flat_only' },
        ],
      },
    ],
  });
}

class SeriesCache {
  private readonly smaCache = new Map<string, (number | null)[]>();
  private readonly emaCache = new Map<string, (number | null)[]>();
  private readonly rsiCache = new Map<string, (number | null)[]>();
  private readonly macdCache = new Map<string, ReturnType<typeof macd>>();
  private readonly bbCache = new Map<string, ReturnType<typeof bollinger>>();
  private readonly donchianCache = new Map<number, ReturnType<typeof donchian>>();
  private readonly stochCache = new Map<string, ReturnType<typeof stochastic>>();
  private readonly adxCache = new Map<number, ReturnType<typeof adx>>();
  private readonly orbCache = new Map<number, ReturnType<typeof orbLevels>>();
  private atrLine: (number | null)[] | undefined;

  constructor(
    private readonly bars: readonly Bar[],
    private readonly settings: SessionSettings,
  ) {}

  sma(period: number, source: IndicatorSource): (number | null)[] {
    const key = `${period}:${source}`;
    let hit = this.smaCache.get(key);
    if (!hit) {
      hit = sma(this.bars, period, source);
      this.smaCache.set(key, hit);
    }
    return hit;
  }

  ema(period: number, source: IndicatorSource): (number | null)[] {
    const key = `${period}:${source}`;
    let hit = this.emaCache.get(key);
    if (!hit) {
      hit = ema(this.bars, period, source);
      this.emaCache.set(key, hit);
    }
    return hit;
  }

  ma(ref: MaRef): (number | null)[] {
    const source = ref.source ?? 'close';
    return ref.ma === 'sma' ? this.sma(ref.period, source) : this.ema(ref.period, source);
  }

  rsi(period: number): (number | null)[] {
    const key = String(period);
    let hit = this.rsiCache.get(key);
    if (!hit) {
      hit = rsi(this.bars, period, 'close');
      this.rsiCache.set(key, hit);
    }
    return hit;
  }

  macd(fast: number, slow: number, signal: number): ReturnType<typeof macd> {
    const key = `${fast}:${slow}:${signal}`;
    let hit = this.macdCache.get(key);
    if (!hit) {
      hit = macd(this.bars, fast, slow, signal, 'close');
      this.macdCache.set(key, hit);
    }
    return hit;
  }

  bb(period: number, stdDev: number): ReturnType<typeof bollinger> {
    const key = `${period}:${stdDev}`;
    let hit = this.bbCache.get(key);
    if (!hit) {
      hit = bollinger(this.bars, period, stdDev, 'close');
      this.bbCache.set(key, hit);
    }
    return hit;
  }

  donchian(period: number): ReturnType<typeof donchian> {
    let hit = this.donchianCache.get(period);
    if (!hit) {
      hit = donchian(this.bars, period);
      this.donchianCache.set(period, hit);
    }
    return hit;
  }

  stoch(kPeriod: number, dPeriod: number, smooth: number): ReturnType<typeof stochastic> {
    const key = `${kPeriod}:${dPeriod}:${smooth}`;
    let hit = this.stochCache.get(key);
    if (!hit) {
      hit = stochastic(this.bars, kPeriod, dPeriod, smooth);
      this.stochCache.set(key, hit);
    }
    return hit;
  }

  adx(period: number): ReturnType<typeof adx> {
    let hit = this.adxCache.get(period);
    if (!hit) {
      hit = adx(this.bars, period);
      this.adxCache.set(period, hit);
    }
    return hit;
  }

  orb(minutes: number): ReturnType<typeof orbLevels> {
    let hit = this.orbCache.get(minutes);
    if (!hit) {
      hit = orbLevels(this.bars, minutes, this.settings);
      this.orbCache.set(minutes, hit);
    }
    return hit;
  }

  atr(): (number | null)[] {
    if (!this.atrLine) this.atrLine = atr(this.bars, ATR_PERIOD);
    return this.atrLine;
  }
}

function clockOf(settings: SessionSettings) {
  return { utcOffsetMinutes: settings.utcOffsetMinutes, dayStartMinutes: settings.dayStartMinutes };
}

function crossed(prevA: number, prevB: number, a: number, b: number, bull: boolean): boolean {
  return bull ? prevA <= prevB && a > b : prevA >= prevB && a < b;
}

function flat(state: SessionState): boolean {
  if (state.trading.position && state.trading.position.qty !== 0) return false;
  return !state.trading.orders.some((o) => o.status === 'working' && o.role === 'entry');
}

function entriesOnDay(state: SessionState, settings: SessionSettings): number {
  const day = state.dayKey;
  let n = 0;
  for (const t of state.trading.trades) if (dayKeyOf(t.openTime, settings) === day) n++;
  if (state.trading.openTrade && dayKeyOf(state.trading.openTrade.openTime, settings) === day) n++;
  for (const o of state.trading.orders) {
    if (o.role === 'entry' && o.status === 'working' && dayKeyOf(o.placedTime, settings) === day)
      n++;
  }
  return n;
}

function lastEntryIndex(state: SessionState): number | null {
  let idx: number | null = null;
  for (const o of state.trading.orders) {
    if (o.role !== 'entry') continue;
    if (o.status !== 'filled' && o.status !== 'working') continue;
    if (idx === null || o.placedIndex > idx) idx = o.placedIndex;
  }
  return idx;
}

function inTimeWindow(minute: number, start: number, end: number): boolean {
  if (start === end) return true;
  if (start < end) return minute >= start && minute < end;
  return minute >= start || minute < end;
}

function conditionTrue(
  cond: Condition,
  bars: readonly Bar[],
  index: number,
  settings: SessionSettings,
  state: SessionState,
  cache: SeriesCache,
): boolean {
  const bar = bars[index];
  if (!bar) return false;
  switch (cond.type) {
    case 'price_vs_ma': {
      const line = cache.ma({
        ma: cond.ma,
        period: cond.period,
        ...(cond.source ? { source: cond.source } : {}),
      });
      const ma = line[index];
      if (ma === null || ma === undefined) return false;
      const price = bar.close;
      return cond.op === 'above' ? price > ma : price < ma;
    }
    case 'ma_cross': {
      if (index < 1) return false;
      const fast = cache.ma(cond.fast);
      const slow = cache.ma(cond.slow);
      const f0 = fast[index - 1];
      const s0 = slow[index - 1];
      const f1 = fast[index];
      const s1 = slow[index];
      if (f0 == null || s0 == null || f1 == null || s1 == null) return false;
      return crossed(f0, s0, f1, s1, cond.direction === 'bull');
    }
    case 'orb_break': {
      const levels = cache.orb(cond.minutes);
      if (!levels.complete[index]) return false;
      const hi = levels.high[index];
      const lo = levels.low[index];
      if (hi == null || lo == null) return false;
      const up = bar.close > hi;
      const down = bar.close < lo;
      if (cond.direction === 'up') return up;
      if (cond.direction === 'down') return down;
      return up || down;
    }
    case 'rsi': {
      const period = cond.period ?? 14;
      const line = cache.rsi(period);
      const cur = line[index];
      if (cur == null) return false;
      if (cond.op === 'gt') return cur > cond.level;
      if (cond.op === 'lt') return cur < cond.level;
      if (index < 1) return false;
      const prev = line[index - 1];
      if (prev == null) return false;
      return cond.op === 'cross_above'
        ? prev <= cond.level && cur > cond.level
        : prev >= cond.level && cur < cond.level;
    }
    case 'bb': {
      const bands = cache.bb(cond.period ?? 20, cond.stdDev ?? 2);
      const line =
        cond.which === 'upper' ? bands.upper : cond.which === 'lower' ? bands.lower : bands.middle;
      const level = line[index];
      if (level == null) return false;
      if (cond.op === 'touch') {
        if (cond.which === 'upper') return bar.high >= level;
        if (cond.which === 'lower') return bar.low <= level;
        return bar.low <= level && bar.high >= level;
      }
      if (cond.which === 'upper') return bar.close > level;
      if (cond.which === 'lower') return bar.close < level;
      return bar.close > level;
    }
    case 'macd': {
      const m = cache.macd(cond.fast ?? 12, cond.slow ?? 26, cond.signal ?? 9);
      const hist = m.histogram[index];
      if (cond.event === 'hist_pos') return hist != null && hist > 0;
      if (cond.event === 'hist_neg') return hist != null && hist < 0;
      if (index < 1) return false;
      const a0 = m.macd[index - 1];
      const b0 = m.signal[index - 1];
      const a1 = m.macd[index];
      const b1 = m.signal[index];
      if (a0 == null || b0 == null || a1 == null || b1 == null) return false;
      return crossed(a0, b0, a1, b1, cond.event === 'cross_bull');
    }
    case 'donchian_break': {
      // Break of the prior channel: the current bar is not part of the reference range.
      if (index < cond.period) return false;
      let hh = -Infinity;
      let ll = Infinity;
      for (let j = index - cond.period; j < index; j++) {
        hh = Math.max(hh, bars[j]!.high);
        ll = Math.min(ll, bars[j]!.low);
      }
      return cond.direction === 'up' ? bar.close > hh : bar.close < ll;
    }
    case 'stoch_cross': {
      if (index < 1) return false;
      const s = cache.stoch(cond.kPeriod ?? 14, cond.dPeriod ?? 3, cond.smooth ?? 3);
      const k0 = s.k[index - 1];
      const d0 = s.d[index - 1];
      const k1 = s.k[index];
      const d1 = s.d[index];
      if (k0 == null || d0 == null || k1 == null || d1 == null) return false;
      const bull = cond.direction === 'bull';
      if (!crossed(k0, d0, k1, d1, bull)) return false;
      if (cond.level === undefined) return true;
      return bull ? k0 <= cond.level : k0 >= cond.level;
    }
    case 'adx': {
      const line = cache.adx(cond.period ?? 14);
      const value = line.adx[index];
      const plus = line.plusDi[index];
      const minus = line.minusDi[index];
      if (value == null || plus == null || minus == null) return false;
      const levelOk = cond.op === 'gt' ? value > cond.level : value < cond.level;
      if (!levelOk) return false;
      const di = cond.di ?? 'any';
      if (di === 'any') return true;
      if (di === 'plus_above') return plus > minus;
      return minus > plus;
    }
    case 'time_window':
      return inTimeWindow(
        exchangeLocalMinute(bar.time, settings.utcOffsetMinutes),
        cond.startMinute,
        cond.endMinute,
      );
    case 'day_of_week': {
      const shifted = bar.time + settings.utcOffsetMinutes * 60;
      const day = new Date(shifted * 1000).getUTCDay();
      return cond.days.includes(day);
    }
    case 'min_bars_since_entry': {
      const prev = lastEntryIndex(state);
      if (prev === null) return true;
      return index - prev >= cond.bars;
    }
    case 'flat_only':
      return flat(state);
    default:
      return assertNever(cond);
  }
}

function ruleMatches(
  rule: MacroRule,
  bars: readonly Bar[],
  index: number,
  settings: SessionSettings,
  state: SessionState,
  cache: SeriesCache,
): boolean {
  return rule.conditions.every((c) => conditionTrue(c, bars, index, settings, state, cache));
}

function priceDistance(
  mode: StopMode | 'rr',
  value: number,
  tickSize: number,
  ref: number,
  atrValue: number | null,
): number | null {
  if (mode === 'rr') return null;
  let raw: number;
  if (mode === 'ticks') raw = value * tickSize;
  else if (mode === 'atr_mult') {
    if (atrValue === null || !Number.isFinite(atrValue) || atrValue <= 0) return null;
    raw = atrValue * value;
  } else if (mode === 'percent') raw = Math.abs(ref) * (value / 100);
  else return assertNever(mode);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const ticks = Math.max(1, Math.round(raw / tickSize));
  return ticks * tickSize;
}

/** Bracket prices referenced to the last close, rounded to the tick grid. */
export function bracketPrices(
  side: Side,
  ref: number,
  tickSize: number,
  exit: MacroExit,
  atrValue: number | null,
): { stopLoss: number; takeProfit: number } | null {
  if (!Number.isFinite(ref) || ref <= 0 || !Number.isFinite(tickSize) || tickSize <= 0) return null;
  const stopDist = priceDistance(exit.stop.mode, exit.stop.value, tickSize, ref, atrValue);
  if (stopDist === null) return null;
  const targetDist =
    exit.target.mode === 'rr'
      ? stopDist * exit.target.value
      : priceDistance(exit.target.mode, exit.target.value, tickSize, ref, atrValue);
  if (targetDist === null || !Number.isFinite(targetDist) || targetDist <= 0) return null;
  const dir = side === 'buy' ? 1 : -1;
  const stopLoss = roundToTick(ref - dir * stopDist, tickSize);
  const takeProfit = roundToTick(ref + dir * Math.max(tickSize, targetDist), tickSize);
  if (stopLoss <= 0 || takeProfit <= 0) return null;
  if ((stopLoss - ref) * dir >= 0) return null;
  if ((takeProfit - ref) * dir <= 0) return null;
  return { stopLoss, takeProfit };
}

/**
 * First enabled rule, in priority order, whose conditions are all true on the closed bar
 * at `state.cursor`, plus bracket prices. Returns null when nothing should be sent.
 * Does not place an order.
 */
export function macroSignal(
  bars: readonly Bar[],
  settings: SessionSettings,
  state: SessionState,
  macro: MacroV1,
  cache: SeriesCache = new SeriesCache(bars, settings),
): MacroSignal | null {
  if (state.status !== 'active') return null;
  if (state.cursor < 0 || state.cursor >= bars.length) return null;
  if (macro.onePositionOnly !== false && !flat(state)) return null;
  if (
    macro.maxTradesPerDay !== undefined &&
    entriesOnDay(state, settings) >= macro.maxTradesPerDay
  ) {
    return null;
  }
  const ranked = macro.rules
    .map((rule, index) => ({ rule, index }))
    .filter((x) => x.rule.enabled)
    .sort((a, b) => a.rule.priority - b.rule.priority || a.index - b.index);
  for (const { rule } of ranked) {
    if (!ruleMatches(rule, bars, state.cursor, settings, state, cache)) continue;
    const atrValue = cache.atr()[state.cursor] ?? null;
    const prices = bracketPrices(
      rule.side,
      state.trading.lastClose,
      settings.tickSize,
      macro.exit,
      atrValue,
    );
    if (!prices) continue;
    return { ruleId: rule.id, side: rule.side, ...prices };
  }
  return null;
}

/** True when the condition holds on the closed bar at `state.cursor`. Exported for unit tests. */
export function conditionHolds(
  cond: Condition,
  bars: readonly Bar[],
  settings: SessionSettings,
  state: SessionState,
): boolean {
  return conditionTrue(cond, bars, state.cursor, settings, state, new SeriesCache(bars, settings));
}

function shouldFlatten(
  bars: readonly Bar[],
  settings: SessionSettings,
  state: SessionState,
  exit: MacroExit,
): boolean {
  if (!exit.flattenAtSessionEnd) return false;
  if (!state.trading.position || state.trading.position.qty === 0) return false;
  const next = bars[state.cursor + 1];
  if (!next) return false;
  return tradingDayKey(next.time, clockOf(settings)) !== state.dayKey;
}

/**
 * Run a macro on a copy of the session. Does not mutate `state`. Orders go through
 * `sessionPlaceOrder` and `stepSession` (fill model v3). The practice cursor is left
 * where the caller had it; this function only returns a result.
 */
export function runMacro(
  bars: readonly Bar[],
  settings: SessionSettings,
  state: SessionState,
  macro: MacroV1,
  options: MacroRunOptions,
): MacroRunResult {
  if (bars.length < 2) fail('need at least two bars');
  if (options.mode === 'n_bars' && (options.count === undefined || options.count < 1)) {
    fail('count is required when mode is n_bars');
  }
  const limit = options.mode === 'n_bars' ? options.count! : Number.POSITIVE_INFINITY;
  let cursorState = options.from === 'start' ? createSession(bars, settings, bars[0]!.time) : state;
  const cache = new SeriesCache(bars, settings);
  let signals = 0;
  let barsProcessed = 0;
  while (
    cursorState.status === 'active' &&
    cursorState.cursor < bars.length - 1 &&
    barsProcessed < limit
  ) {
    if (shouldFlatten(bars, settings, cursorState, macro.exit)) {
      try {
        cursorState = sessionFlatten(bars, cursorState);
      } catch (err) {
        if (!(err instanceof OrderError)) throw err;
      }
    } else {
      const signal = macroSignal(bars, settings, cursorState, macro, cache);
      if (signal) {
        try {
          cursorState = sessionPlaceOrder(bars, settings, cursorState, {
            side: signal.side,
            type: 'market',
            qty: macro.qty,
            stopLoss: signal.stopLoss,
            takeProfit: signal.takeProfit,
          });
          signals++;
        } catch (err) {
          if (!(err instanceof OrderError)) throw err;
        }
      }
    }
    const stepped = stepSession(bars, settings, cursorState, 1);
    cursorState = stepped.state;
    barsProcessed++;
  }
  const stats = sessionStats(settings, cursorState);
  return {
    simulated: true,
    from: options.from,
    mode: options.mode,
    barsProcessed,
    signals,
    stats,
    trades: cursorState.trading.trades,
    openQty: cursorState.trading.position?.qty ?? 0,
    status: cursorState.status,
  };
}
