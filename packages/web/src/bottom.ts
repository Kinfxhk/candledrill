// SPDX-License-Identifier: AGPL-3.0-or-later
// Bottom panel: tabs for trades, fills and (later) statistics and export.

import type { SessionSettings, SessionStateDto } from './api.js';
import { t, type MessageKey } from './i18n.js';
import { el, fmtMoney, fmtNum, fmtTime, signClass } from './format.js';
import { fmtPrice } from './side.js';

export interface BottomTab {
  key: MessageKey;
  id: string;
  render(
    panel: HTMLElement,
    settings: SessionSettings,
    state: SessionStateDto,
    sessionId: number,
  ): void;
}

export const tradesTab: BottomTab = {
  key: 'pr.trades',
  id: 'trades',
  render(panel, s, state) {
    const trades = state.trading.trades;
    if (trades.length === 0) {
      panel.replaceChildren(el('p', { class: 'muted' }, t('pr.noTrades')));
      return;
    }
    const head = el('tr');
    for (const k of [
      '#',
      'col.side',
      'col.qty',
      'col.entryTime',
      'col.entry',
      'col.exitTime',
      'col.exit',
      'col.net',
      'col.r',
      'col.reason',
    ] as const) {
      head.append(
        el(
          'th',
          {
            class: ['col.qty', 'col.entry', 'col.exit', 'col.net', 'col.r'].includes(k)
              ? 'num'
              : '',
          },
          k === '#' ? '#' : t(k),
        ),
      );
    }
    const rows = [...trades]
      .reverse()
      .map((tr) =>
        el(
          'tr',
          {},
          el('td', {}, String(tr.id)),
          el(
            'td',
            { class: tr.side === 'long' ? 'up' : 'down' },
            t(tr.side === 'long' ? 'pr.long' : 'pr.short'),
          ),
          el('td', { class: 'num' }, String(tr.qty)),
          el('td', {}, fmtTime(tr.openTime, s.utcOffsetMinutes)),
          el('td', { class: 'num' }, fmtPrice(tr.entryPrice, s.tickSize)),
          el('td', {}, fmtTime(tr.closeTime, s.utcOffsetMinutes)),
          el('td', { class: 'num' }, fmtPrice(tr.exitPrice, s.tickSize)),
          el('td', { class: `num ${signClass(tr.netPnl)}` }, fmtMoney(tr.netPnl)),
          el('td', { class: 'num' }, tr.rMultiple === null ? '–' : fmtNum(tr.rMultiple, 2)),
          el('td', {}, tr.exitReason),
        ),
      );
    panel.replaceChildren(
      el('table', { class: 'data', 'data-testid': 'trades-table' }, head, ...rows),
    );
  },
};

export const fillsTab: BottomTab = {
  key: 'pr.fills',
  id: 'fills',
  render(panel, s, state) {
    const fills = state.trading.fills;
    if (fills.length === 0) {
      panel.replaceChildren(el('p', { class: 'muted' }, '–'));
      return;
    }
    const head = el('tr');
    for (const k of ['col.time', 'col.side', 'col.qty', 'col.price', 'col.role'] as const)
      head.append(el('th', {}, t(k)));
    const rows = [...fills]
      .reverse()
      .map((f) =>
        el(
          'tr',
          {},
          el('td', {}, fmtTime(f.time, s.utcOffsetMinutes)),
          el(
            'td',
            { class: f.side === 'buy' ? 'up' : 'down' },
            t(f.side === 'buy' ? 'pr.buy' : 'pr.sell'),
          ),
          el('td', {}, String(f.qty)),
          el('td', {}, fmtPrice(f.price, s.tickSize)),
          el('td', {}, f.role),
        ),
      );
    panel.replaceChildren(el('table', { class: 'data' }, head, ...rows));
  },
};

export class BottomPanel {
  private active: string;
  private readonly bar: HTMLElement;
  private readonly panel: HTMLElement;
  private last: { s: SessionSettings; st: SessionStateDto; id: number } | undefined;

  constructor(
    root: HTMLElement,
    private readonly tabs: BottomTab[],
  ) {
    this.active = tabs[0]!.id;
    this.bar = el('div', { class: 'tabbar', role: 'tablist' });
    this.panel = el('div', { class: 'tabpanel', role: 'tabpanel' });
    for (const tab of tabs) {
      const b = el(
        'button',
        { type: 'button', role: 'tab', 'data-i18n': tab.key, 'data-testid': `tab-${tab.id}` },
        t(tab.key),
      );
      b.addEventListener('click', () => {
        this.active = tab.id;
        this.refresh();
      });
      this.bar.append(b);
    }
    root.replaceChildren(this.bar, this.panel);
  }

  render(s: SessionSettings, st: SessionStateDto, id: number): void {
    this.last = { s, st, id };
    this.refresh();
  }

  private refresh(): void {
    this.tabs.forEach((tab, i) =>
      this.bar.children[i]!.setAttribute('aria-selected', String(tab.id === this.active)),
    );
    if (!this.last) return;
    this.tabs
      .find((x) => x.id === this.active)!
      .render(this.panel, this.last.s, this.last.st, this.last.id);
  }
}
