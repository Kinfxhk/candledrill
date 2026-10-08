// SPDX-License-Identifier: AGPL-3.0-or-later
// Display names for engine tokens. The stored values stay English (imports check them);
// the UI always goes through these maps, in both languages.

import { t, type MessageKey } from './i18n.js';

const EXIT: Record<string, MessageKey> = {
  'stop-loss': 'x.stopLoss',
  'take-profit': 'x.takeProfit',
  flatten: 'x.flatten',
  rule: 'x.rule',
  manual: 'x.manual',
};

const ORDER_TYPE: Record<string, MessageKey> = {
  market: 'pr.market',
  limit: 'pr.limit',
  stop: 'pr.stop',
};

const ROLE: Record<string, MessageKey> = {
  entry: 'x.entry',
  'stop-loss': 'x.stopLoss',
  'take-profit': 'x.takeProfit',
  flatten: 'x.flatten',
  rule: 'x.rule',
};

const STATUS: Record<string, MessageKey> = {
  active: 'status.active',
  breached: 'status.breached',
  passed: 'status.passed',
  finished: 'status.finished',
};

function mapped(table: Record<string, MessageKey>, raw: string): string {
  const key = table[raw];
  return key ? t(key) : raw;
}

export function exitReasonText(raw: string): string {
  return mapped(EXIT, raw);
}

export function orderTypeText(raw: string): string {
  return mapped(ORDER_TYPE, raw);
}

export function orderRoleText(raw: string): string {
  return mapped(ROLE, raw);
}

export function sessionStatusText(raw: string): string {
  return mapped(STATUS, raw);
}

/** Engine statusReason strings such as "daily loss limit 300" or "end of data". */
export function statusReasonText(reason: string | null | undefined): string {
  if (!reason) return '';
  if (reason === 'end of data') return t('reason.endOfData');
  const rules: [string, MessageKey][] = [
    ['daily loss limit ', 'reason.dailyLoss'],
    ['trailing drawdown ', 'reason.trailing'],
    ['profit target ', 'reason.profitTarget'],
  ];
  for (const [prefix, key] of rules) {
    if (reason.startsWith(prefix)) return t(key, { n: reason.slice(prefix.length) });
  }
  return reason;
}
