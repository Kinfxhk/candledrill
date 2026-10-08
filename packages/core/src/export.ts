// SPDX-License-Identifier: AGPL-3.0-or-later
// Export formats: trades CSV (plain columns for other journals), self-contained HTML report.
// Exports never include price bars, so sharing a report never redistributes market data.

import type { Trade } from './orders.js';
import type { SessionStats } from './stats.js';

export const TRADE_CSV_COLUMNS = [
  'trade_id',
  'symbol',
  'side',
  'qty',
  'open_time_utc',
  'close_time_utc',
  'entry_price',
  'exit_price',
  'gross_pnl',
  'commission',
  'net_pnl',
  'initial_risk',
  'r_multiple',
  'exit_reason',
  'risk_complete',
  'first_entry_risk',
  'first_entry_r',
  'planned_risk',
  'unprotected_qty',
] as const;

const iso = (t: number) => new Date(t * 1000).toISOString().replace('.000Z', 'Z');

function csvCell(v: string | number | null): string {
  if (v === null) return '';
  const s = String(v);
  // Neutralise spreadsheet formula injection and quote when needed.
  const safe = /^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s)) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function tradesToCsv(trades: readonly Trade[], symbol: string): string {
  const lines = [TRADE_CSV_COLUMNS.join(',')];
  for (const t of trades) {
    lines.push(
      [
        t.id,
        symbol,
        t.side,
        t.qty,
        iso(t.openTime),
        iso(t.closeTime),
        Number(t.entryPrice.toFixed(8)),
        Number(t.exitPrice.toFixed(8)),
        t.grossPnl,
        t.commission,
        t.netPnl,
        t.initialRisk,
        t.rMultiple,
        t.exitReason,
        // Trades stored by v0.1.0 lack the coverage fields; derive what is knowable.
        String(t.riskComplete ?? t.initialRisk !== null),
        t.firstEntryRisk ?? null,
        t.firstEntryR ?? null,
        t.plannedRisk ?? null,
        t.unprotectedQty ?? null,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

export interface ReportInput {
  readonly title: string;
  readonly symbol: string;
  readonly synthetic: boolean;
  readonly generatedAt: string;
  readonly settings: Readonly<Record<string, string | number | null>>;
  readonly stats: SessionStats;
  readonly trades: readonly Trade[];
  readonly riskNotice: string;
  readonly fillModel: string;
}

const money = (v: number | null) => (v === null ? '–' : v.toFixed(2));
const pct = (v: number | null) => (v === null ? '–' : `${(v * 100).toFixed(1)}%`);

/** Self-contained HTML report (no scripts, no external resources). */
export function reportHtml(r: ReportInput): string {
  const s = r.stats;
  const rows: [string, string][] = [
    ['Trades', String(s.trades)],
    ['Win rate', pct(s.winRate)],
    ['Net P&L', money(s.netPnl)],
    ['Expectancy / trade', money(s.expectancy)],
    ['Average win', money(s.avgWin)],
    ['Average loss', money(s.avgLoss)],
    ['Profit factor', s.profitFactor === null ? '–' : s.profitFactor.toFixed(2)],
    [
      'Average R',
      s.avgR === null
        ? 'N/A (no trade with a stop-loss on every entry)'
        : `${s.avgR.toFixed(2)} (${s.tradesWithR} trades with a stop-loss on every entry)`,
    ],
    ['Largest win', money(s.largestWin)],
    ['Largest loss', money(s.largestLoss)],
    ['Longest win / loss streak', `${s.longestWinStreak} / ${s.longestLossStreak}`],
    ['Commission paid', money(s.commissionPaid)],
    ['Max drawdown (closing equity)', `${money(s.maxDrawdown)} (${pct(s.maxDrawdownPct)})`],
    [
      'Starting balance → ending equity',
      `${money(s.startingBalance)} → ${money(s.endingEquity)} (${pct(s.returnPct)})`,
    ],
  ];
  const e = escapeHtml;
  const statRows = rows.map(([k, v]) => `<tr><th>${e(k)}</th><td>${e(v)}</td></tr>`).join('');
  const settingRows = Object.entries(r.settings)
    .map(([k, v]) => `<tr><th>${e(k)}</th><td>${e(v === null ? 'off' : String(v))}</td></tr>`)
    .join('');
  const tradeRows = r.trades
    .map(
      (t) =>
        `<tr><td>${t.id}</td><td>${t.side}</td><td>${t.qty}</td><td>${e(iso(t.openTime))}</td>` +
        `<td>${Number(t.entryPrice.toFixed(8))}</td><td>${e(iso(t.closeTime))}</td>` +
        `<td>${Number(t.exitPrice.toFixed(8))}</td><td>${money(t.netPnl)}</td>` +
        `<td>${t.rMultiple == null ? 'N/A' : t.rMultiple.toFixed(2)}</td><td>${e(t.exitReason)}</td></tr>`,
    )
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${e(r.title)} – CandleDrill report</title>
<style>
body{font:14px system-ui,sans-serif;max-width:960px;margin:24px auto;padding:0 16px;color:#1d2129}
h1{font-size:20px}h2{font-size:15px;margin-top:28px;border-bottom:1px solid #ddd;padding-bottom:4px}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:4px 8px;border-bottom:1px solid #eee;font-size:13px}
th{color:#555;font-weight:500}.notice{background:#fff7e6;border:1px solid #f0d7a1;padding:8px 12px;border-radius:6px}
.muted{color:#777;font-size:12px}
</style></head><body>
<h1>${e(r.title)}</h1>
<p class="muted">Symbol ${e(r.symbol)}${r.synthetic ? ' (synthetic data)' : ''} · generated ${e(r.generatedAt)} by CandleDrill</p>
<p class="notice">${e(r.riskNotice)}</p>
<h2>Statistics</h2><table>${statRows}</table>
<h2>Assumptions</h2><p>${e(r.fillModel)}</p><table>${settingRows}</table>
<h2>Trades</h2><table><tr><th>#</th><th>Side</th><th>Qty</th><th>Opened (UTC)</th><th>Entry</th><th>Closed (UTC)</th><th>Exit</th><th>Net P&amp;L</th><th>R</th><th>Exit</th></tr>${tradeRows}</table>
<p class="muted">CandleDrill is free software (AGPL-3.0-or-later). Practice results do not predict real results.</p>
</body></html>
`;
}
