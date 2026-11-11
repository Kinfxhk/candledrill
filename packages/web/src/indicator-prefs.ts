// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Per-chart indicator preferences. Stored locally only; sessions keep the
// drawing shapes, indicator settings are a UI preference.
//
// v1 (`candledrill.indicators`) was a fixed slot list. v2
// (`candledrill.indicators.v2`) is a free-form instance list so several SMA/EMA
// periods can exist at once. Loading v1 merges it onto the old defaults, then
// stamps stable ids.

import type { IndicatorSource } from './indicators.js';

export type OverlayKind =
  | 'volume'
  | 'sma'
  | 'ema'
  | 'bollinger'
  | 'vwap'
  | 'orb'
  | 'donchian'
  | 'keltner'
  | 'ichimoku'
  | 'supertrend'
  | 'sar'
  | 'zigzag'
  | 'envelope'
  | 'dema'
  | 'tema'
  | 'wma'
  | 'hull'
  | 'vwma'
  | 'vwapBands'
  | 'stderr'
  | 'priceChannel';
export type PaneKind =
  | 'rsi'
  | 'macd'
  | 'atr'
  | 'stochastic'
  | 'adx'
  | 'cci'
  | 'obv'
  | 'cmf'
  | 'williams'
  | 'ao'
  | 'momentum'
  | 'roc'
  | 'aroon'
  | 'bop'
  | 'kdj'
  | 'elder';
export type IndicatorKind = OverlayKind | PaneKind;

export interface IndicatorSetting {
  id: string;
  kind: IndicatorKind;
  visible: boolean;
  period?: number;
  /** Opening-range length in minutes (ORB). */
  minutes?: number;
  source?: IndicatorSource;
  color?: string;
  stdDev?: number;
  fast?: number;
  slow?: number;
  signal?: number;
  /** Keltner / SuperTrend / standard-error band multiple. */
  multiplier?: number;
  /** Envelope width, or ZigZag reversal, in percent. */
  percent?: number;
  /** Parabolic SAR acceleration step. */
  step?: number;
  /** Parabolic SAR acceleration cap. */
  maxStep?: number;
}

export interface PaneIndicatorConfig {
  overlays: IndicatorSetting[];
  panes: IndicatorSetting[];
}

const INDICATOR_KEY = 'candledrill.indicators';
const INDICATOR_V2_KEY = 'candledrill.indicators.v2';

export const MAX_INSTANCES = 24;
export const MAX_VISIBLE_OVERLAYS = 12;

export const DEFAULT_OVERLAYS: IndicatorSetting[] = [
  { id: 'def-volume', kind: 'volume', visible: true, color: '#26a69a' },
  { id: 'def-sma-9', kind: 'sma', visible: false, period: 9, source: 'close', color: '#7cc4ff' },
  { id: 'def-sma-20', kind: 'sma', visible: false, period: 20, source: 'close', color: '#4d8fd6' },
  { id: 'def-sma-50', kind: 'sma', visible: false, period: 50, source: 'close', color: '#2a5f9e' },
  { id: 'def-ema-9', kind: 'ema', visible: false, period: 9, source: 'close', color: '#f2a93b' },
  { id: 'def-ema-21', kind: 'ema', visible: false, period: 21, source: 'close', color: '#d4892a' },
  { id: 'def-ema-50', kind: 'ema', visible: false, period: 50, source: 'close', color: '#a96414' },
  {
    id: 'def-bollinger',
    kind: 'bollinger',
    visible: false,
    period: 20,
    source: 'close',
    color: '#8d95a6',
    stdDev: 2,
  },
  { id: 'def-vwap', kind: 'vwap', visible: false, source: 'hlc3', color: '#9a6d00' },
];

export const DEFAULT_PANES: IndicatorSetting[] = [
  { id: 'def-rsi', kind: 'rsi', visible: false, period: 14, source: 'close', color: '#7cc4ff' },
  {
    id: 'def-macd',
    kind: 'macd',
    visible: false,
    fast: 12,
    slow: 26,
    signal: 9,
    source: 'close',
    color: '#7cc4ff',
  },
  { id: 'def-atr', kind: 'atr', visible: false, period: 14, source: 'close', color: '#8d95a6' },
];

const EXTRA_TEMPLATES: Record<'orb' | 'donchian' | 'stochastic' | 'adx', IndicatorSetting> = {
  orb: { id: 'orb', kind: 'orb', visible: true, minutes: 30, color: '#ef5350' },
  donchian: { id: 'donchian', kind: 'donchian', visible: true, period: 20, color: '#c792ea' },
  stochastic: {
    id: 'stochastic',
    kind: 'stochastic',
    visible: true,
    period: 14,
    fast: 3,
    signal: 3,
    color: '#f2a93b',
  },
  adx: { id: 'adx', kind: 'adx', visible: true, period: 14, color: '#26a69a' },
};

type ExtraKind = Exclude<
  IndicatorKind,
  | 'volume'
  | 'sma'
  | 'ema'
  | 'bollinger'
  | 'vwap'
  | 'rsi'
  | 'macd'
  | 'atr'
  | 'orb'
  | 'donchian'
  | 'stochastic'
  | 'adx'
>;

const MORE_TEMPLATES: Record<ExtraKind, IndicatorSetting> = {
  keltner: {
    id: 'keltner',
    kind: 'keltner',
    visible: true,
    period: 20,
    fast: 10,
    multiplier: 2,
    source: 'close',
    color: '#5c6bc0',
  },
  ichimoku: {
    id: 'ichimoku',
    kind: 'ichimoku',
    visible: true,
    fast: 9,
    slow: 26,
    signal: 52,
    color: '#26a69a',
  },
  supertrend: {
    id: 'supertrend',
    kind: 'supertrend',
    visible: true,
    period: 10,
    multiplier: 3,
    color: '#ef5350',
  },
  sar: { id: 'sar', kind: 'sar', visible: true, step: 0.02, maxStep: 0.2, color: '#ab47bc' },
  zigzag: { id: 'zigzag', kind: 'zigzag', visible: true, percent: 5, color: '#8d6e63' },
  envelope: {
    id: 'envelope',
    kind: 'envelope',
    visible: true,
    period: 20,
    percent: 10,
    source: 'close',
    color: '#78909c',
  },
  dema: { id: 'dema', kind: 'dema', visible: true, period: 20, source: 'close', color: '#42a5f5' },
  tema: { id: 'tema', kind: 'tema', visible: true, period: 20, source: 'close', color: '#1e88e5' },
  wma: { id: 'wma', kind: 'wma', visible: true, period: 20, source: 'close', color: '#7e57c2' },
  hull: { id: 'hull', kind: 'hull', visible: true, period: 16, source: 'close', color: '#ec407a' },
  vwma: { id: 'vwma', kind: 'vwma', visible: true, period: 20, source: 'close', color: '#00897b' },
  vwapBands: { id: 'vwapBands', kind: 'vwapBands', visible: true, color: '#f9a825' },
  stderr: {
    id: 'stderr',
    kind: 'stderr',
    visible: true,
    period: 20,
    multiplier: 2,
    source: 'close',
    color: '#8d95a6',
  },
  priceChannel: {
    id: 'priceChannel',
    kind: 'priceChannel',
    visible: true,
    period: 20,
    color: '#6d4c41',
  },
  cci: { id: 'cci', kind: 'cci', visible: true, period: 20, source: 'hlc3', color: '#ff7043' },
  obv: { id: 'obv', kind: 'obv', visible: true, color: '#26a69a' },
  cmf: { id: 'cmf', kind: 'cmf', visible: true, period: 20, color: '#29b6f6' },
  williams: { id: 'williams', kind: 'williams', visible: true, period: 14, color: '#ab47bc' },
  ao: { id: 'ao', kind: 'ao', visible: true, fast: 5, slow: 34, color: '#66bb6a' },
  momentum: {
    id: 'momentum',
    kind: 'momentum',
    visible: true,
    period: 10,
    source: 'close',
    color: '#ffa726',
  },
  roc: { id: 'roc', kind: 'roc', visible: true, period: 10, source: 'close', color: '#ef5350' },
  aroon: { id: 'aroon', kind: 'aroon', visible: true, period: 25, color: '#5c6bc0' },
  bop: { id: 'bop', kind: 'bop', visible: true, period: 14, color: '#8d6e63' },
  kdj: { id: 'kdj', kind: 'kdj', visible: true, period: 9, color: '#f2a93b' },
  elder: {
    id: 'elder',
    kind: 'elder',
    visible: true,
    period: 13,
    source: 'close',
    color: '#26c6da',
  },
};

function isExtraKind(kind: IndicatorKind): kind is ExtraKind {
  return Object.prototype.hasOwnProperty.call(MORE_TEMPLATES, kind);
}

function defaultConfig(): PaneIndicatorConfig {
  return {
    overlays: DEFAULT_OVERLAYS.map((o) => ({ ...o })),
    panes: DEFAULT_PANES.map((p) => ({ ...p })),
  };
}

export function templateFor(kind: IndicatorKind): IndicatorSetting {
  if (isExtraKind(kind)) return { ...MORE_TEMPLATES[kind] };
  switch (kind) {
    case 'volume':
      return { ...DEFAULT_OVERLAYS[0]! };
    case 'sma':
      return { ...DEFAULT_OVERLAYS[2]!, id: 'sma' };
    case 'ema':
      return { ...DEFAULT_OVERLAYS[5]!, id: 'ema' };
    case 'bollinger':
      return { ...DEFAULT_OVERLAYS[7]!, id: 'bollinger' };
    case 'vwap':
      return { ...DEFAULT_OVERLAYS[8]!, id: 'vwap' };
    case 'rsi':
      return { ...DEFAULT_PANES[0]!, id: 'rsi' };
    case 'macd':
      return { ...DEFAULT_PANES[1]!, id: 'macd' };
    case 'atr':
      return { ...DEFAULT_PANES[2]!, id: 'atr' };
    case 'orb':
    case 'donchian':
    case 'stochastic':
    case 'adx':
      return { ...EXTRA_TEMPLATES[kind] };
    default: {
      const leftover: never = kind;
      throw new Error(`unknown indicator ${String(leftover)}`);
    }
  }
}

function isValidSource(s: unknown): s is IndicatorSource {
  return s === 'open' || s === 'high' || s === 'low' || s === 'close' || s === 'hlc3';
}

function isValidKind(s: unknown): s is IndicatorKind {
  return typeof s === 'string' && (isExtraKind(s as IndicatorKind) || isOriginalKind(s));
}

function isOriginalKind(s: unknown): s is IndicatorKind {
  return (
    s === 'volume' ||
    s === 'sma' ||
    s === 'ema' ||
    s === 'bollinger' ||
    s === 'vwap' ||
    s === 'orb' ||
    s === 'donchian' ||
    s === 'rsi' ||
    s === 'macd' ||
    s === 'atr' ||
    s === 'stochastic' ||
    s === 'adx'
  );
}

export function isOverlayKind(kind: IndicatorKind): kind is OverlayKind {
  switch (kind) {
    case 'volume':
    case 'sma':
    case 'ema':
    case 'bollinger':
    case 'vwap':
    case 'orb':
    case 'donchian':
    case 'keltner':
    case 'ichimoku':
    case 'supertrend':
    case 'sar':
    case 'zigzag':
    case 'envelope':
    case 'dema':
    case 'tema':
    case 'wma':
    case 'hull':
    case 'vwma':
    case 'vwapBands':
    case 'stderr':
    case 'priceChannel':
      return true;
    case 'rsi':
    case 'macd':
    case 'atr':
    case 'stochastic':
    case 'adx':
    case 'cci':
    case 'obv':
    case 'cmf':
    case 'williams':
    case 'ao':
    case 'momentum':
    case 'roc':
    case 'aroon':
    case 'bop':
    case 'kdj':
    case 'elder':
      return false;
    default: {
      const leftover: never = kind;
      return leftover;
    }
  }
}

function sanitizeNumber(n: unknown, fallback: number): number {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

function sanitizePositive(n: unknown, fallback: number): number {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function sanitizeColor(c: unknown, fallback: string): string {
  return typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c : fallback;
}

function sanitizeId(id: unknown, fallback: string): string {
  return typeof id === 'string' && id.length > 0 && id.length <= 64 ? id : fallback;
}

function sanitizeSetting(raw: unknown, fallback: IndicatorSetting): IndicatorSetting {
  if (!raw || typeof raw !== 'object') return { ...fallback };
  const r = raw as Record<string, unknown>;
  const kind = isValidKind(r.kind) ? r.kind : fallback.kind;
  return {
    id: sanitizeId(r.id, fallback.id),
    kind,
    visible: typeof r.visible === 'boolean' ? r.visible : fallback.visible,
    period: sanitizeNumber(r.period, fallback.period ?? 14),
    minutes: sanitizeNumber(r.minutes, fallback.minutes ?? 30),
    source: isValidSource(r.source) ? r.source : (fallback.source ?? 'close'),
    color: sanitizeColor(r.color, fallback.color ?? '#888888'),
    stdDev: sanitizeNumber(r.stdDev, fallback.stdDev ?? 2),
    fast: sanitizeNumber(r.fast, fallback.fast ?? 12),
    slow: sanitizeNumber(r.slow, fallback.slow ?? 26),
    signal: sanitizeNumber(r.signal, fallback.signal ?? 9),
    multiplier: sanitizePositive(r.multiplier, fallback.multiplier ?? 2),
    percent: sanitizePositive(r.percent, fallback.percent ?? 10),
    step: sanitizePositive(r.step, fallback.step ?? 0.02),
    maxStep: sanitizePositive(r.maxStep, fallback.maxStep ?? 0.2),
  };
}

function sanitizeConfig(raw: unknown): PaneIndicatorConfig {
  const defs = defaultConfig();
  if (!raw || typeof raw !== 'object') return defs;
  const r = raw as Record<string, unknown>;
  const merge = (arr: unknown, fallbacks: IndicatorSetting[]): IndicatorSetting[] => {
    if (!Array.isArray(arr)) return fallbacks.map((x) => ({ ...x }));
    if (arr.length === fallbacks.length)
      return fallbacks.map((fb, i) => sanitizeSetting(arr[i], fb));
    // Migrate shorter prefs (e.g. one SMA + one EMA) onto the new multi-line defaults.
    const used = new Set<number>();
    return fallbacks.map((fb) => {
      const idx = arr.findIndex(
        (x, i) =>
          !used.has(i) && x && typeof x === 'object' && (x as { kind?: string }).kind === fb.kind,
      );
      if (idx >= 0) {
        used.add(idx);
        return sanitizeSetting(arr[idx], fb);
      }
      return { ...fb };
    });
  };
  return {
    overlays: merge(r.overlays, defs.overlays),
    panes: merge(r.panes, defs.panes),
  };
}

function placementOf(kind: IndicatorKind): 'overlay' | 'pane' {
  return isOverlayKind(kind) ? 'overlay' : 'pane';
}

function sanitizeInstanceList(raw: unknown, placement: 'overlay' | 'pane'): IndicatorSetting[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: IndicatorSetting[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const kind = (item as { kind?: unknown }).kind;
    if (!isValidKind(kind) || placementOf(kind) !== placement) continue;
    const base = templateFor(kind);
    const setting = sanitizeSetting(item, { ...base, id: `inst-${kind}-${out.length}` });
    if (seen.has(setting.id)) setting.id = `${setting.id}-${out.length}`;
    seen.add(setting.id);
    out.push(setting);
    if (out.length >= MAX_INSTANCES) break;
  }
  return out;
}

function sanitizeV2(raw: unknown): PaneIndicatorConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== 2) return null;
  const overlays = sanitizeInstanceList(r.overlays, 'overlay');
  const panes = sanitizeInstanceList(r.panes, 'pane');
  if (!overlays.some((o) => o.kind === 'volume')) {
    overlays.unshift({ ...DEFAULT_OVERLAYS[0]! });
  }
  return { overlays, panes };
}

export function visibleOverlayCount(cfg: PaneIndicatorConfig): number {
  return cfg.overlays.filter((o) => o.visible && o.kind !== 'volume').length;
}

let instanceSeq = 0;

export function createIndicator(
  kind: IndicatorKind,
  patch: Partial<IndicatorSetting> = {},
): IndicatorSetting {
  instanceSeq += 1;
  const base = templateFor(kind);
  const setting = sanitizeSetting(
    { ...base, ...patch, id: patch.id, kind, visible: patch.visible ?? true },
    { ...base, id: `${kind}-${Date.now().toString(36)}-${instanceSeq}` },
  );
  setting.kind = kind;
  if (patch.period !== undefined)
    setting.period = sanitizeNumber(patch.period, setting.period ?? 14);
  if (patch.minutes !== undefined)
    setting.minutes = sanitizeNumber(patch.minutes, setting.minutes ?? 30);
  return setting;
}

export function loadIndicatorConfig(): PaneIndicatorConfig {
  try {
    const v2 = localStorage.getItem(INDICATOR_V2_KEY);
    if (v2) {
      const parsed = sanitizeV2(JSON.parse(v2));
      if (parsed) return parsed;
    }
    const raw = localStorage.getItem(INDICATOR_KEY);
    return sanitizeConfig(raw ? JSON.parse(raw) : {});
  } catch {
    return defaultConfig();
  }
}

export function saveIndicatorConfig(cfg: PaneIndicatorConfig): void {
  const clean =
    sanitizeV2({ version: 2, overlays: cfg.overlays, panes: cfg.panes }) ?? defaultConfig();
  localStorage.setItem(INDICATOR_V2_KEY, JSON.stringify({ version: 2, ...clean }));
}

export function findSetting(
  cfg: PaneIndicatorConfig,
  kind: IndicatorKind,
): IndicatorSetting | undefined {
  return cfg.overlays.find((o) => o.kind === kind) ?? cfg.panes.find((p) => p.kind === kind);
}
