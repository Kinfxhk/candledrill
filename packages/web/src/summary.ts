// SPDX-License-Identifier: AGPL-3.0-or-later
import { sessionStats, type Excursion, type Trade } from '@candledrill/core';
import { sessionsApi, type SessionSettings, type SessionStateDto } from './api.js';
import { el, fmtMoney, fmtNum, fmtPct } from './format.js';
import { t, type MessageKey } from './i18n.js';

export interface ReviewHighlight {
  readonly tradeId: number;
  readonly reasons: readonly { metric: 'net' | 'maeR' | 'maeTicks'; value: number }[];
}

/** At most two unique prompts. Ties use the lowest trade ID, independent of input order. */
export function reviewHighlights(
  trades: readonly Trade[],
  excursions: readonly Excursion[],
): ReviewHighlight[] {
  const result: { tradeId: number; reasons: ReviewHighlight['reasons'][number][] }[] = [];
  const add = (
    tradeId: number,
    metric: ReviewHighlight['reasons'][number]['metric'],
    value: number,
  ) => {
    const row = result.find((h) => h.tradeId === tradeId);
    const reason = { metric, value };
    if (row) row.reasons.push(reason);
    else result.push({ tradeId, reasons: [reason] });
  };
  const lowest = [...trades]
    .filter((tr) => Number.isFinite(tr.netPnl))
    .sort((a, b) => a.netPnl - b.netPnl || a.id - b.id)[0];
  if (lowest) add(lowest.id, 'net', lowest.netPnl);
  const byId = new Map(trades.map((tr) => [tr.id, tr]));
  const available = excursions.filter((e) => byId.has(e.tradeId) && e.bars > 0);
  const withR = available.filter((e) => {
    const risk = byId.get(e.tradeId)!.initialRisk;
    return (
      risk !== null &&
      Number.isFinite(risk) &&
      risk > 0 &&
      e.maeR !== null &&
      Number.isFinite(e.maeR) &&
      e.maeR >= 0
    );
  });
  if (withR.length) {
    const worst = [...withR].sort((a, b) => b.maeR! - a.maeR! || a.tradeId - b.tradeId)[0]!;
    add(worst.tradeId, 'maeR', worst.maeR!);
  } else {
    const worst = available
      .filter((e) => Number.isFinite(e.maeTicks) && e.maeTicks >= 0)
      .sort((a, b) => b.maeTicks - a.maeTicks || a.tradeId - b.tradeId)[0];
    if (worst) add(worst.tradeId, 'maeTicks', worst.maeTicks);
  }
  return result;
}

/** Read-only completion panel; request ownership is invalidated on close/session changes. */
export class CompletionSummary {
  private current: { settings: SessionSettings; state: SessionStateDto; id: number } | undefined;
  private key = '';
  private requestVersion = 0;
  private expanded = false;
  private excursions: Excursion[] = [];
  private pending = false;
  private unavailable = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly openJournal: () => void,
  ) {}

  destroy(): void {
    this.requestVersion++;
    this.current = undefined;
  }

  update(settings: SessionSettings, state: SessionStateDto, id: number): void {
    this.current = { settings, state, id };
    if (state.status === 'active') {
      this.root.hidden = true;
      return;
    }
    const key = `${id}:${state.status}:${state.trading.trades.length}`;
    if (key !== this.key) {
      this.key = key;
      this.expanded = true;
      this.excursions = [];
      this.unavailable = false;
      this.pending = state.trading.trades.length > 0;
      const version = ++this.requestVersion;
      if (this.pending) {
        void sessionsApi
          .journal(id)
          .then((journal) => {
            if (version !== this.requestVersion || !this.current) return;
            this.excursions = journal.excursions;
            this.pending = false;
            this.draw();
          })
          .catch(() => {
            if (version !== this.requestVersion || !this.current) return;
            this.pending = false;
            this.unavailable = true;
            this.draw();
          });
      }
    }
    this.root.hidden = false;
    this.draw();
  }

  private draw(): void {
    if (!this.current) return;
    const { settings, state } = this.current;
    const toggle = el(
      'button',
      {
        type: 'button',
        'data-testid': 'btn-summary',
        'aria-expanded': String(this.expanded),
        'aria-controls': 'completion-details',
      },
      t(this.expanded ? 'summary.hide' : 'summary.show'),
    );
    toggle.addEventListener('click', () => {
      this.expanded = !this.expanded;
      this.draw();
      this.root.querySelector<HTMLButtonElement>('[data-testid=btn-summary]')?.focus();
    });
    const heading = el(
      'div',
      { class: 'row' },
      el('strong', { role: 'status' }, t('summary.title')),
      toggle,
    );
    if (!this.expanded) {
      this.root.replaceChildren(heading);
      return;
    }
    const stats = sessionStats(settings, state);
    const items: [MessageKey, string][] = [
      ['stat.trades', String(stats.trades)],
      ['summary.closedNet', fmtMoney(stats.netPnl)],
      ['stat.winRate', fmtPct(stats.winRate)],
      ['stat.maxDd', fmtMoney(stats.maxDrawdown)],
    ];
    const grid = el(
      'div',
      { class: 'stats-grid' },
      ...items.map(([key, value]) =>
        el(
          'div',
          { class: 'stat' },
          el('div', { class: 'k' }, t(key)),
          el('div', { class: 'v' }, value),
        ),
      ),
    );
    const content = el(
      'div',
      { id: 'completion-details', 'data-testid': 'completion-details' },
      grid,
    );
    if (stats.openQty !== 0)
      content.append(
        el(
          'p',
          { 'data-testid': 'summary-open' },
          t('summary.open', { qty: stats.openQty, pnl: fmtMoney(stats.unrealizedPnl) }),
        ),
      );
    if (!stats.trades) content.append(el('p', {}, t('pr.noTrades')));
    else {
      content.append(el('p', { class: 'muted small' }, t('summary.prompts')));
      const list = el('ul', { 'data-testid': 'summary-highlights' });
      for (const highlight of reviewHighlights(state.trading.trades, this.excursions)) {
        const reasons = highlight.reasons.map((r) => {
          if (r.metric === 'net') return t('summary.lowestNet', { value: fmtMoney(r.value) });
          if (r.metric === 'maeR') return t('summary.maeR', { value: fmtNum(r.value) });
          return t('summary.maeTicks', { value: fmtNum(r.value) });
        });
        list.append(
          el(
            'li',
            { 'data-testid': `summary-trade-${highlight.tradeId}` },
            `#${highlight.tradeId}: ${reasons.join('; ')}`,
          ),
        );
      }
      content.append(list);
      if (this.pending || this.unavailable)
        content.append(
          el(
            'p',
            { class: 'muted small', role: 'status' },
            t(this.pending ? 'summary.loading' : 'summary.unavailable'),
          ),
        );
      content.append(el('p', { class: 'muted small' }, t('pr.maeNote')));
      const journal = el(
        'button',
        { type: 'button', 'data-testid': 'summary-journal' },
        t('summary.journal'),
      );
      journal.addEventListener('click', this.openJournal);
      content.append(journal);
    }
    this.root.replaceChildren(heading, content);
  }
}
