// SPDX-License-Identifier: AGPL-3.0-or-later
// Searchable catalog metadata for the indicator picker. Formulas live in core.

import {
  isOverlayKind,
  templateFor,
  type IndicatorKind,
  type IndicatorSetting,
} from './indicator-prefs.js';

export type IndicatorCategory = 'trend' | 'volatility' | 'momentum' | 'volume' | 'session';

export interface CatalogItem {
  kind: IndicatorKind;
  category: IndicatorCategory;
  /** Lower-case names and aliases matched by the typeahead. */
  aliases: readonly string[];
  singleton: boolean;
}

export const CATALOG: readonly CatalogItem[] = [
  {
    kind: 'sma',
    category: 'trend',
    aliases: ['sma', 'ma', 'moving average', 'simple'],
    singleton: false,
  },
  {
    kind: 'ema',
    category: 'trend',
    aliases: ['ema', 'exponential', 'moving average'],
    singleton: false,
  },
  {
    kind: 'adx',
    category: 'trend',
    aliases: ['adx', 'dmi', 'di', 'directional'],
    singleton: false,
  },
  {
    kind: 'bollinger',
    category: 'volatility',
    aliases: ['bollinger', 'bb', 'bands'],
    singleton: false,
  },
  {
    kind: 'atr',
    category: 'volatility',
    aliases: ['atr', 'average true range', 'range'],
    singleton: false,
  },
  {
    kind: 'donchian',
    category: 'volatility',
    aliases: ['donchian', 'channel', 'highest', 'lowest'],
    singleton: false,
  },
  { kind: 'rsi', category: 'momentum', aliases: ['rsi', 'relative strength'], singleton: false },
  { kind: 'macd', category: 'momentum', aliases: ['macd'], singleton: false },
  {
    kind: 'stochastic',
    category: 'momentum',
    aliases: ['stochastic', 'stoch', 'kd'],
    singleton: false,
  },
  { kind: 'volume', category: 'volume', aliases: ['volume', 'vol'], singleton: true },
  { kind: 'vwap', category: 'session', aliases: ['vwap', 'volume weighted'], singleton: false },
  {
    kind: 'orb',
    category: 'session',
    aliases: ['orb', 'opening range', '30orb', 'session'],
    singleton: false,
  },
];

export function filterCatalog(query: string, category: IndicatorCategory | 'all'): CatalogItem[] {
  const q = query.trim().toLowerCase();
  return CATALOG.filter((item) => {
    if (category !== 'all' && item.category !== category) return false;
    if (!q) return true;
    if (item.aliases.some((a) => a.includes(q))) return true;
    if (item.kind.includes(q)) return true;
    const period = q.match(/(\d+)/);
    if (period && (item.kind === 'sma' || item.kind === 'ema' || item.kind === 'orb')) return true;
    return false;
  });
}

/** Pull a period out of "sma 200" / "ema21" / "orb 30". */
export function periodFromQuery(query: string, kind: IndicatorKind): number | undefined {
  const m = query.match(/(\d{1,3})/);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n < 1) return undefined;
  if (
    kind === 'sma' ||
    kind === 'ema' ||
    kind === 'donchian' ||
    kind === 'rsi' ||
    kind === 'atr' ||
    kind === 'adx'
  ) {
    return n;
  }
  if (kind === 'orb') return n;
  return undefined;
}

export function instanceFromCatalog(kind: IndicatorKind, query = ''): IndicatorSetting {
  const setting = templateFor(kind);
  const n = periodFromQuery(query, kind);
  if (n === undefined) return { ...setting, visible: true };
  if (kind === 'orb') return { ...setting, visible: true, minutes: n };
  return { ...setting, visible: true, period: n };
}

export function catalogPlacement(kind: IndicatorKind): 'overlay' | 'pane' {
  return isOverlayKind(kind) ? 'overlay' : 'pane';
}
