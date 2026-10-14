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

export type OverlayKind = 'volume' | 'sma' | 'ema' | 'bollinger' | 'vwap' | 'orb' | 'donchian';
export type PaneKind = 'rsi' | 'macd' | 'atr' | 'stochastic' | 'adx';
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

function defaultConfig(): PaneIndicatorConfig {
  return {
    overlays: DEFAULT_OVERLAYS.map((o) => ({ ...o })),
    panes: DEFAULT_PANES.map((p) => ({ ...p })),
  };
}

export function templateFor(kind: IndicatorKind): IndicatorSetting {
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
  return (
    kind === 'volume' ||
    kind === 'sma' ||
    kind === 'ema' ||
    kind === 'bollinger' ||
    kind === 'vwap' ||
    kind === 'orb' ||
    kind === 'donchian'
  );
}

function sanitizeNumber(n: unknown, fallback: number): number {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
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
