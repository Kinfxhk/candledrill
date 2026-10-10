// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Checks for a session file (format "candledrill-session") before it is imported.
//
// A session file stores the engine state, not the list of actions, so an import cannot be
// replayed. Instead every recorded fill, order and trade is checked against the dataset it
// claims to come from: fill times must be bars already revealed at the cursor, fill prices
// must lie inside that bar's range (plus the configured slippage), and the running totals
// must add up. A file edited by hand or matched to the wrong data is rejected.

import type { Bar } from './types.js';
import { applyFill, emptyTrading, MAX_ORDER_QTY, type Fill } from './orders.js';
import { validateSettings, type SessionSettings, type SessionState } from './session.js';

export const SESSION_FILE_FORMAT = 'candledrill-session';
export const SESSION_FILE_VERSION = 1;
/** Hard limits so a hostile file cannot exhaust memory or time. */
export const MAX_SESSION_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_IMPORT_RECORDS = 200_000;
const MAX_DEPTH = 8;

export interface SessionFile {
  readonly name: string;
  readonly startTime: number;
  readonly settings: SessionSettings;
  readonly state: SessionState;
  readonly drawings: unknown[];
  /** Tags and notes per trade id (checked against the trades by journalIssues). */
  readonly journal: Record<string, unknown> | null;
  /** SHA-256 of the dataset bars (written from v0.2.0 on; absent in older files). */
  readonly fingerprint: string | null;
  /** Blind-mode parameters when the session was a blind one. */
  readonly blind: {
    timeShift: number;
    priceOffset: number;
    revealed: boolean;
    symbol: string;
  } | null;
}

/** Full SQLite backups retain runtime history; portable session imports have transport limits. */
export interface SessionValidationOptions {
  readonly source?: 'backup';
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPos = (v: unknown): v is number => isNum(v) && v > 0;
const isStr = (v: unknown, max = 500): v is string => typeof v === 'string' && v.length <= max;
const oneOf = <T extends string>(v: unknown, list: readonly T[]): v is T =>
  typeof v === 'string' && (list as readonly string[]).includes(v);

/** Every number finite, no deep nesting, no oversized strings or arrays, no odd keys. */
function shapeIssues(
  v: unknown,
  path: string,
  depth: number,
  out: string[],
  options: SessionValidationOptions,
): void {
  if (out.length > 20) return;
  if (depth > MAX_DEPTH) {
    out.push(`${path}: nested too deeply`);
    return;
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) out.push(`${path}: not a finite number`);
  } else if (typeof v === 'string') {
    if (options.source !== 'backup' && v.length > 2000) out.push(`${path}: text too long`);
  } else if (Array.isArray(v)) {
    if (options.source !== 'backup' && v.length > MAX_IMPORT_RECORDS)
      out.push(`${path}: too many items`);
    else v.forEach((x, i) => shapeIssues(x, `${path}[${i}]`, depth + 1, out, options));
  } else if (v !== null && typeof v === 'object') {
    for (const k of Object.keys(v)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype' || k.length > 64)
        out.push(`${path}: key "${k.slice(0, 64)}" not allowed`);
      else shapeIssues((v as Obj)[k], `${path}.${k}`, depth + 1, out, options);
    }
  } else if (typeof v !== 'boolean' && v !== null) out.push(`${path}: unexpected value`);
}

const SETTINGS_KEYS = [
  'symbol',
  'tickSize',
  'pointValue',
  'commissionPerContract',
  'slippageTicks',
  'startingBalance',
  'dailyLossLimit',
  'trailingDrawdown',
  'profitTarget',
  'utcOffsetMinutes',
  'dayStartMinutes',
] as const;

const OPTIONAL_SETTINGS_KEYS = ['maxDailyTradeCycles', 'maxConsecutiveLosses'] as const;

function settingsIssues(s: unknown): string[] {
  if (!isObj(s)) return ['settings: missing'];
  const out: string[] = [];
  for (const k of SETTINGS_KEYS) if (!(k in s)) out.push(`settings.${k}: missing`);
  for (const k of Object.keys(s))
    if (
      !(SETTINGS_KEYS as readonly string[]).includes(k) &&
      !(OPTIONAL_SETTINGS_KEYS as readonly string[]).includes(k)
    )
      out.push(`settings.${k}: unknown`);
  if (out.length) return out;
  if (!isStr(s.symbol, 64) || s.symbol.length === 0) out.push('settings.symbol: invalid');
  for (const k of SETTINGS_KEYS.slice(1)) {
    const v = s[k];
    if (v !== null && typeof v !== 'number') out.push(`settings.${k}: not a number`);
  }
  if (!isInt(s.utcOffsetMinutes) || Math.abs(s.utcOffsetMinutes) > 840)
    out.push('settings.utcOffsetMinutes: invalid');
  if (!isInt(s.dayStartMinutes) || s.dayStartMinutes < 0 || s.dayStartMinutes > 1439)
    out.push('settings.dayStartMinutes: invalid');
  if (out.length) return out;
  return validateSettings(s as unknown as SessionSettings).map((e) => `settings: ${e}`);
}

function drawingIssues(d: unknown): string[] {
  if (!Array.isArray(d)) return ['drawings: not a list'];
  if (d.length > 200) return ['drawings: too many'];
  const out: string[] = [];
  const id = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(v);
  d.forEach((x, i) => {
    if (!isObj(x)) out.push(`drawings[${i}]: invalid`);
    else if (x.kind === 'hline') {
      if (Object.keys(x).length !== 3 || !id(x.id) || !isPos(x.price))
        out.push(`drawings[${i}]: invalid`);
    } else if (x.kind === 'position') {
      const dir = x.side === 'long' ? 1 : x.side === 'short' ? -1 : 0;
      if (
        Object.keys(x).length !== 8 ||
        !id(x.id) ||
        dir === 0 ||
        !isInt(x.t1) ||
        !isInt(x.t2) ||
        x.t2 <= x.t1 ||
        !isPos(x.entry) ||
        !isPos(x.stop) ||
        !isPos(x.target) ||
        dir * (x.entry - x.stop) <= 0 ||
        dir * (x.target - x.entry) <= 0
      )
        out.push(`drawings[${i}]: invalid`);
    } else if (x.kind === 'tline' || x.kind === 'rect') {
      if (
        Object.keys(x).length !== 6 ||
        !id(x.id) ||
        !isInt(x.t1) ||
        !isInt(x.t2) ||
        !isPos(x.p1) ||
        !isPos(x.p2)
      )
        out.push(`drawings[${i}]: invalid`);
    } else out.push(`drawings[${i}]: unknown kind`);
  });
  return out;
}

/**
 * Parse and check the outer layer of a session file. Returns the file or a list of
 * problems. The state still has to be checked against the bars with checkSessionState.
 */
export function parseSessionFile(
  text: string,
  options: SessionValidationOptions = {},
): { file?: SessionFile; issues: string[] } {
  if (options.source !== 'backup' && text.length > MAX_SESSION_FILE_BYTES)
    return { issues: ['file too large'] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { issues: ['not a JSON file'] };
  }
  if (!isObj(raw)) return { issues: ['not a session file'] };
  if (raw.format !== SESSION_FILE_FORMAT) return { issues: ['not a CandleDrill session file'] };
  if (raw.formatVersion !== SESSION_FILE_VERSION)
    return { issues: [`unsupported formatVersion (this version reads ${SESSION_FILE_VERSION})`] };
  const issues: string[] = [];
  shapeIssues(raw, 'file', 0, issues, options);
  if (issues.length) return { issues };
  if (
    !isStr(raw.name, 80) ||
    (options.source === 'backup' ? raw.name.length === 0 : raw.name.trim() === '')
  )
    issues.push('name: invalid');
  if (!isInt(raw.startTime)) issues.push('startTime: invalid');
  issues.push(...settingsIssues(raw.settings));
  issues.push(...drawingIssues(raw.drawings ?? []));
  let fingerprint: string | null = null;
  if (raw.dataset !== undefined) {
    const d = raw.dataset;
    if (!isObj(d) || typeof d.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(d.fingerprint))
      issues.push('dataset.fingerprint: invalid');
    else fingerprint = d.fingerprint;
  }
  let blind: SessionFile['blind'] = null;
  if (raw.blind !== undefined && raw.blind !== null) {
    const b = raw.blind;
    if (
      !isObj(b) ||
      !isInt(b.timeShift) ||
      !isNum(b.priceOffset) ||
      typeof b.revealed !== 'boolean' ||
      !isStr(b.symbol, 64)
    )
      issues.push('blind: invalid');
    else
      blind = {
        timeShift: b.timeShift,
        priceOffset: b.priceOffset,
        revealed: b.revealed,
        symbol: b.symbol,
      };
  }
  if (!isObj(raw.state)) issues.push('state: missing');
  if (raw.journal !== undefined && !isObj(raw.journal)) issues.push('journal: not an object');
  if (issues.length) return { issues };
  return {
    issues: [],
    file: {
      name: options.source === 'backup' ? (raw.name as string) : (raw.name as string).trim(),
      startTime: raw.startTime as number,
      settings: raw.settings as unknown as SessionSettings,
      state: raw.state as unknown as SessionState,
      drawings: (raw.drawings ?? []) as unknown[],
      journal: (raw.journal as Record<string, unknown> | undefined) ?? null,
      fingerprint,
      blind,
    },
  };
}

const close = (a: number, b: number) =>
  Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));

/**
 * Check an imported engine state against the bars it will run on (the disguised bars for a
 * blind session). Returns a list of problems; empty means the state is consistent.
 */
export function checkSessionState(
  bars: readonly Bar[],
  settings: SessionSettings,
  state: unknown,
  options: SessionValidationOptions = {},
): string[] {
  const out: string[] = [];
  const shape: string[] = [];
  shapeIssues(state, 'state', 0, shape, options);
  if (shape.length) return shape;
  if (!isObj(state)) return ['state: missing'];
  if (bars.length === 0) return ['dataset has no bars'];
  if (state.version !== 1) out.push('state.version: unsupported');
  if (!isInt(state.cursor) || state.cursor < 0 || state.cursor > bars.length - 1)
    return [...out, 'state.cursor: outside the dataset'];
  const cursor = state.cursor;
  const cursorTime = bars[cursor]!.time;
  if (!oneOf(state.status, ['active', 'breached', 'passed', 'finished'] as const))
    out.push('state.status: invalid');
  if (state.statusReason !== null && !isStr(state.statusReason))
    out.push('state.statusReason: invalid');
  for (const k of ['equityPeak', 'maxDrawdown', 'maxDrawdownPct', 'dayStartEquity'] as const)
    if (state[k] !== undefined && !isNum(state[k])) out.push(`state.${k}: invalid`);
  if (state.dayKey !== undefined && !isInt(state.dayKey)) out.push('state.dayKey: invalid');
  const tr = state.trading;
  if (!isObj(tr)) return [...out, 'state.trading: missing'];
  for (const k of ['orders', 'fills', 'trades'] as const)
    if (!Array.isArray(tr[k])) out.push(`state.trading.${k}: not a list`);
  if (tr.modifications !== undefined && !Array.isArray(tr.modifications))
    out.push('state.trading.modifications: not a list');
  if (!isInt(tr.nextId) || tr.nextId < 1) out.push('state.trading.nextId: invalid');
  for (const k of ['realizedPnl', 'commissionPaid', 'lastClose'] as const)
    if (!isNum(tr[k])) out.push(`state.trading.${k}: invalid`);
  if (out.length) return out;

  const indexOf = new Map<number, number>();
  for (let i = 0; i <= cursor; i++) indexOf.set(bars[i]!.time, i);
  const tol = settings.slippageTicks * settings.tickSize + settings.tickSize / 2 + 1e-9;

  const orders = tr.orders as unknown[];
  const orderIds = new Set<number>();
  orders.forEach((o, i) => {
    const p = `order ${i + 1}`;
    if (!isObj(o)) return void out.push(`${p}: invalid`);
    if (!isInt(o.id) || o.id < 1 || orderIds.has(o.id)) out.push(`${p}: id invalid or repeated`);
    else orderIds.add(o.id);
    if (!oneOf(o.side, ['buy', 'sell'] as const)) out.push(`${p}: side invalid`);
    if (!oneOf(o.type, ['market', 'limit', 'stop'] as const)) out.push(`${p}: type invalid`);
    if (!oneOf(o.role, ['entry', 'stop-loss', 'take-profit', 'flatten'] as const))
      out.push(`${p}: role invalid`);
    if (!oneOf(o.status, ['working', 'filled', 'cancelled'] as const))
      out.push(`${p}: status invalid`);
    if (!isInt(o.qty) || o.qty < 1 || o.qty > MAX_ORDER_QTY) out.push(`${p}: qty invalid`);
    if (!isInt(o.placedIndex) || o.placedIndex < 0 || o.placedIndex > cursor)
      out.push(`${p}: placed after the cursor`);
    for (const k of ['price', 'stopLoss', 'takeProfit', 'fillPrice'] as const)
      if (o[k] !== null && !isPos(o[k])) out.push(`${p}: ${k} invalid`);
    if (o.filledTime !== null && !(isInt(o.filledTime) && indexOf.has(o.filledTime)))
      out.push(`${p}: filled at a time that is not a revealed bar`);
  });

  const fills = tr.fills as unknown[];
  const fillIds = new Set<number>();
  let net = 0;
  let commission = 0;
  fills.forEach((f, i) => {
    const p = `fill ${i + 1}`;
    if (!isObj(f)) return void out.push(`${p}: invalid`);
    if (!isInt(f.id) || fillIds.has(f.id)) out.push(`${p}: id invalid or repeated`);
    else fillIds.add(f.id);
    if (!isInt(f.orderId) || f.orderId < 0) out.push(`${p}: orderId invalid`);
    if (!oneOf(f.side, ['buy', 'sell'] as const)) out.push(`${p}: side invalid`);
    if (!oneOf(f.role, ['entry', 'stop-loss', 'take-profit', 'flatten', 'rule'] as const))
      out.push(`${p}: role invalid`);
    if (!isInt(f.qty) || f.qty < 1 || f.qty > MAX_ORDER_QTY) out.push(`${p}: qty invalid`);
    if (!isNum(f.commission) || f.commission < 0) out.push(`${p}: commission invalid`);
    else commission += f.commission;
    if (isInt(f.qty)) net += f.side === 'buy' ? f.qty : -f.qty;
    const idx = isInt(f.time) ? indexOf.get(f.time) : undefined;
    if (idx === undefined) return void out.push(`${p}: time is not a revealed bar of this dataset`);
    const bar = bars[idx]!;
    if (!isNum(f.price) || f.price < bar.low - tol || f.price > bar.high + tol)
      out.push(`${p}: price ${String(f.price)} is outside that bar (${bar.low}–${bar.high})`);
  });

  const trades = tr.trades as unknown[];
  trades.forEach((t, i) => {
    const p = `trade ${i + 1}`;
    if (!isObj(t)) return void out.push(`${p}: invalid`);
    if (!oneOf(t.side, ['long', 'short'] as const)) out.push(`${p}: side invalid`);
    if (!isInt(t.qty) || t.qty < 1) out.push(`${p}: qty invalid`);
    if (
      !isInt(t.openTime) ||
      !isInt(t.closeTime) ||
      t.openTime > t.closeTime ||
      t.closeTime > cursorTime
    )
      out.push(`${p}: times invalid`);
    for (const k of ['entryPrice', 'exitPrice'] as const)
      if (!isPos(t[k])) out.push(`${p}: ${k} invalid`);
    for (const k of ['grossPnl', 'commission', 'netPnl'] as const)
      if (!isNum(t[k])) out.push(`${p}: ${k} invalid`);
    if (
      isNum(t.grossPnl) &&
      isNum(t.commission) &&
      isNum(t.netPnl) &&
      !close(t.netPnl, t.grossPnl - t.commission)
    )
      out.push(`${p}: net P&L does not add up`);
    if (!oneOf(t.exitReason, ['stop-loss', 'take-profit', 'manual', 'flatten', 'rule'] as const))
      out.push(`${p}: exitReason invalid`);
  });

  if (!close(commission, tr.commissionPaid as number))
    out.push('state.trading.commissionPaid does not match the fills');
  const pos = tr.position;
  if (pos !== null) {
    if (!isObj(pos) || !isInt(pos.qty) || pos.qty === 0 || !isPos(pos.avgPrice))
      out.push('state.trading.position: invalid');
    else if (pos.qty !== net) out.push('state.trading.position does not match the fills');
  } else if (net !== 0) out.push('state.trading.position does not match the fills');
  if (tr.openTrade !== null && !isObj(tr.openTrade)) out.push('state.trading.openTrade: invalid');
  if ((tr.openTrade === null) !== (pos === null))
    out.push('state.trading.openTrade does not match the position');
  // Reuse the engine's rounded accounting, without accumulating copies of its history.
  // Risk annotations cannot be reconstructed from fills (entry stop-loss is not stored).
  if (!out.length) {
    let ledger = emptyTrading(bars[cursor]!.close);
    let closedCount = 0;
    let previousTime = -Infinity;
    const sameMoney = (a: unknown, b: number) => isNum(a) && Math.abs(a - b) <= 1e-7;
    for (const fill of fills as Fill[]) {
      if (fill.time < previousTime) {
        out.push('fills are not in execution order');
        break;
      }
      previousTime = fill.time;
      ledger = applyFill({ ...ledger, fills: [], trades: [] }, settings, {
        orderId: fill.orderId,
        side: fill.side,
        qty: fill.qty,
        price: fill.price,
        time: fill.time,
        role: fill.role,
      });
      if (!sameMoney(fill.commission, ledger.fills[0]!.commission))
        out.push('fill commission does not match the settings');
      const closed = ledger.trades[0];
      if (closed) {
        const actual = trades[closedCount++] as Obj | undefined;
        if (
          !actual ||
          ['grossPnl', 'commission', 'netPnl'].some(
            (k) => !sameMoney(actual[k], closed[k as 'grossPnl' | 'commission' | 'netPnl']),
          )
        )
          out.push('trade accounting does not match the fills');
      }
    }
    if (closedCount !== trades.length) out.push('trade count does not match the fills');
    if (!sameMoney(tr.realizedPnl, ledger.realizedPnl))
      out.push('state.trading.realizedPnl does not match the fills');
    if (!sameMoney(tr.commissionPaid, ledger.commissionPaid))
      out.push('state.trading.commissionPaid does not match the fills');
    if (!sameMoney(tr.lastClose, bars[cursor]!.close))
      out.push('state.trading.lastClose does not match the cursor bar');
    if (isObj(pos) && ledger.position && !close(pos.avgPrice as number, ledger.position.avgPrice))
      out.push('state.trading.position.avgPrice does not match the fills');
    if (isObj(tr.openTrade) && ledger.openTrade) {
      for (const key of [
        'entryQty',
        'entryValue',
        'exitQty',
        'exitValue',
        'maxQty',
        'commission',
        'grossPnl',
      ] as const)
        if (!sameMoney(tr.openTrade[key], ledger.openTrade[key]))
          out.push(`state.trading.openTrade.${key} does not match the fills`);
    }
  }
  return out.slice(0, 50);
}
