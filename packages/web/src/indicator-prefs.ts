// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Per-chart-pane indicator preferences. Stored locally only; sessions keep the
// drawing shapes, indicator settings are a UI preference.

import type { IndicatorSource } from './indicators.js';

export type OverlayKind = 'sma' | 'ema' | 'bollinger' | 'vwap';
export type PaneKind = 'rsi' | 'macd' | 'atr';
export type IndicatorKind = OverlayKind | PaneKind;

export interface IndicatorSetting {
  kind: IndicatorKind;
  visible: boolean;
  period?: number;
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

export const DEFAULT_OVERLAYS: IndicatorSetting[] = [
  { kind: 'sma', visible: false, period: 9, source: 'close', color: '#7cc4ff' },
  { kind: 'sma', visible: false, period: 20, source: 'close', color: '#4d8fd6' },
  { kind: 'sma', visible: false, period: 50, source: 'close', color: '#2a5f9e' },
  { kind: 'ema', visible: false, period: 9, source: 'close', color: '#f2a93b' },
  { kind: 'ema', visible: false, period: 21, source: 'close', color: '#d4892a' },
  { kind: 'ema', visible: false, period: 50, source: 'close', color: '#a96414' },
  { kind: 'bollinger', visible: false, period: 20, source: 'close', color: '#8d95a6', stdDev: 2 },
  { kind: 'vwap', visible: false, source: 'hlc3', color: '#9a6d00' },
];

export const DEFAULT_PANES: IndicatorSetting[] = [
  { kind: 'rsi', visible: false, period: 14, source: 'close', color: '#7cc4ff' },
  {
    kind: 'macd',
    visible: false,
    fast: 12,
    slow: 26,
    signal: 9,
    source: 'close',
    color: '#7cc4ff',
  },
  { kind: 'atr', visible: false, period: 14, source: 'close', color: '#8d95a6' },
];

function defaultConfig(): PaneIndicatorConfig {
  return {
    overlays: DEFAULT_OVERLAYS.map((o) => ({ ...o })),
    panes: DEFAULT_PANES.map((p) => ({ ...p })),
  };
}

function isValidSource(s: unknown): s is IndicatorSource {
  return s === 'open' || s === 'high' || s === 'low' || s === 'close' || s === 'hlc3';
}

function isValidKind(s: unknown): s is IndicatorKind {
  return (
    s === 'sma' ||
    s === 'ema' ||
    s === 'bollinger' ||
    s === 'vwap' ||
    s === 'rsi' ||
    s === 'macd' ||
    s === 'atr'
  );
}

function sanitizeNumber(n: unknown, fallback: number): number {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

function sanitizeColor(c: unknown, fallback: string): string {
  return typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c : fallback;
}

function sanitizeSetting(raw: unknown, fallback: IndicatorSetting): IndicatorSetting {
  if (!raw || typeof raw !== 'object') return { ...fallback };
  const r = raw as Record<string, unknown>;
  const kind = isValidKind(r.kind) ? r.kind : fallback.kind;
  return {
    kind,
    visible: typeof r.visible === 'boolean' ? r.visible : fallback.visible,
    period: sanitizeNumber(r.period, fallback.period ?? 14),
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

export function loadIndicatorConfig(): PaneIndicatorConfig {
  try {
    const raw = JSON.parse(localStorage.getItem(INDICATOR_KEY) ?? '{}');
    return sanitizeConfig(raw);
  } catch {
    return defaultConfig();
  }
}

export function saveIndicatorConfig(cfg: PaneIndicatorConfig): void {
  localStorage.setItem(INDICATOR_KEY, JSON.stringify(cfg));
}

export function findSetting(
  cfg: PaneIndicatorConfig,
  kind: IndicatorKind,
): IndicatorSetting | undefined {
  return cfg.overlays.find((o) => o.kind === kind) ?? cfg.panes.find((p) => p.kind === kind);
}
