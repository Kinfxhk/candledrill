// SPDX-License-Identifier: AGPL-3.0-or-later
// Bottom panel: tabs for trades, fills and (later) statistics and export.

import { sessionStats, type Trade } from '@candledrill/core';
import {
  BROWSER_BACKEND,
  downloadApi,
  sessionsApi,
  type SessionSettings,
  type SessionStateDto,
} from './api.js';
import { t, type MessageKey } from './i18n.js';
import { el, fmtMoney, fmtNum, fmtPct, fmtTime, signClass, toast } from './format.js';
import { exitReasonText, orderRoleText, weekdayKeyText } from './labels.js';
import { fmtPrice } from './side.js';

export interface TradeNavigation {
  unavailable(trade: Pick<Trade, 'openTime' | 'closeTime'>): MessageKey | null;
  view(tradeId: number): void;
}

function tradeButton(trade: Trade, navigation: TradeNavigation, prefix: string): HTMLButtonElement {
  const reason = navigation.unavailable(trade);
  const label = `${t('pr.viewChart')} #${trade.id}`;
  const button = el(
    'button',
    {
      type: 'button',
      class: 'small',
      'data-testid': `${prefix}-view-${trade.id}`,
      'aria-label': reason ? `${label}: ${t(reason)}` : label,
      title: reason ? t(reason) : label,
    },
    t('pr.viewChart'),
  );
  button.disabled = reason !== null;
  button.addEventListener('click', () => navigation.view(trade.id));
  return button;
}

export interface BottomTab {
  key: MessageKey;
  id: string;
  /**
   * Mount once into a stable panel. Later session renders leave that DOM in place
   * so inputs in the macro wizard keep focus while the chart steps.
   */
  persistent?: boolean;
  render(
    panel: HTMLElement,
    settings: SessionSettings,
    state: SessionStateDto,
    sessionId: number,
    navigation?: TradeNavigation,
  ): void;
}

export const tradesTab: BottomTab = {
  key: 'pr.trades',
  id: 'trades',
  render(panel, s, state, _id, navigation) {
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
    if (navigation) head.append(el('th', {}, t('pr.viewChart')));
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
          tr.rMultiple === null || tr.rMultiple === undefined
            ? el('td', { class: 'num muted', title: t('col.rNa') }, 'N/A')
            : el('td', { class: 'num' }, fmtNum(tr.rMultiple, 2)),
          el('td', {}, exitReasonText(tr.exitReason)),
          ...(navigation ? [el('td', {}, tradeButton(tr, navigation, 'trades'))] : []),
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
          el('td', {}, orderRoleText(f.role)),
        ),
      );
    panel.replaceChildren(el('table', { class: 'data' }, head, ...rows));
  },
};

export const statsTab: BottomTab = {
  key: 'pr.stats',
  id: 'stats',
  render(panel, s, state) {
    const st = sessionStats(s, state);
    const items: [MessageKey, string, number | null][] = [
      ['stat.trades', String(st.trades), null],
      ['stat.winRate', fmtPct(st.winRate), null],
      ['stat.netPnl', fmtMoney(st.netPnl), st.netPnl],
      ['stat.expectancy', fmtMoney(st.expectancy), st.expectancy],
      ['stat.avgWin', fmtMoney(st.avgWin), st.avgWin],
      ['stat.avgLoss', fmtMoney(st.avgLoss), st.avgLoss],
      ['stat.profitFactor', fmtNum(st.profitFactor, 2), null],
      [
        'stat.avgR',
        st.avgR === null ? 'N/A' : `${fmtNum(st.avgR, 2)} (${st.tradesWithR})`,
        st.avgR,
      ],
      ['stat.maxDd', fmtMoney(st.maxDrawdown), null],
      ['stat.maxDdPct', fmtPct(st.maxDrawdownPct), null],
      ['stat.largestWin', fmtMoney(st.largestWin), st.largestWin],
      ['stat.largestLoss', fmtMoney(st.largestLoss), st.largestLoss],
      ['stat.streakW', String(st.longestWinStreak), null],
      ['stat.streakL', String(st.longestLossStreak), null],
      ['stat.commission', fmtMoney(st.commissionPaid), null],
    ];
    panel.replaceChildren(
      el(
        'div',
        { class: 'stats-grid', 'data-testid': 'stats' },
        ...items.map(([k, v, sign]) =>
          el(
            'div',
            { class: 'stat' },
            el('div', { class: 'k' }, t(k)),
            el('div', { class: `v ${signClass(sign)}` }, v),
          ),
        ),
      ),
      el('p', { class: 'muted' }, t('pr.assumption')),
    );
  },
};

export const exportTab: BottomTab = {
  key: 'pr.export',
  id: 'export',
  render(panel, s, _state, id) {
    // The session file must carry the disguise (symbol and offsets) to be re-importable,
    // so offering it before the reveal would hand over the answer.
    const blindHidden = s.blind?.revealed === false;
    const link = (key: MessageKey, file: string) => {
      const url = `/api/sessions/${id}/export/${file}`;
      const a = el(
        'a',
        { href: url, download: '', class: 'badge', 'data-testid': `export-${file}` },
        t(key),
      );
      // Browser build: there is no server to answer the link, so build the file here.
      if (BROWSER_BACKEND)
        a.addEventListener('click', (e) => {
          e.preventDefault();
          void downloadApi(url);
        });
      return a;
    };
    panel.replaceChildren(
      el(
        'div',
        { class: 'row' },
        link('pr.exportTrades', 'trades.csv'),
        link('pr.exportReport', 'report.html'),
        ...(blindHidden ? [] : [link('pr.exportSession', 'session.json')]),
      ),
      el('p', { class: 'muted' }, t('pr.exportNote')),
      ...(blindHidden
        ? [el('p', { class: 'muted', 'data-testid': 'export-blind-note' }, t('pr.exportBlindNote'))]
        : []),
    );
  },
};

/** Tags, notes and MAE/MFE per trade, plus results by hour and weekday. */
export const journalTab: BottomTab = {
  key: 'pr.journal',
  id: 'journal',
  render(panel, s, state, id, navigation) {
    const trades = state.trading.trades;
    if (trades.length === 0) {
      panel.replaceChildren(el('p', { class: 'muted' }, t('pr.noTrades')));
      return;
    }
    panel.replaceChildren(el('p', { class: 'muted' }, '…'));
    void sessionsApi
      .journal(id)
      .then((j) => {
        if (!panel.isConnected) return;
        const ex = new Map(j.excursions.map((e) => [e.tradeId, e]));
        const head = el('tr');
        for (const k of [
          '#',
          'col.side',
          'col.net',
          'col.r',
          'col.mae',
          'col.mfe',
          'col.tags',
          'col.note',
        ] as const)
          head.append(
            el(
              'th',
              { class: ['col.net', 'col.r', 'col.mae', 'col.mfe'].includes(k) ? 'num' : '' },
              k === '#' ? '#' : t(k),
            ),
          );
        if (navigation) head.append(el('th', {}, t('pr.viewChart')));
        const rows = [...trades].reverse().map((tr) => {
          const e = ex.get(tr.id);
          const entry = j.journal[String(tr.id)] ?? { tags: [], note: '' };
          const tags = el('input', {
            type: 'text',
            value: entry.tags.join(', '),
            'aria-label': `${t('col.tags')} ${tr.id}`,
            'data-testid': `tags-${tr.id}`,
            maxlength: '200',
          });
          const note = el('input', {
            type: 'text',
            value: entry.note,
            'aria-label': `${t('col.note')} ${tr.id}`,
            'data-testid': `note-${tr.id}`,
            maxlength: '2000',
          });
          const save = () =>
            void sessionsApi
              .saveJournal(id, tr.id, tags.value.split(','), note.value)
              .then(() => toast(t('pr.journalSaved')))
              .catch((err: Error) => toast(err.message, 'error'));
          tags.addEventListener('change', save);
          note.addEventListener('change', save);
          const exc = (ticks: number | undefined, r: number | null | undefined) =>
            ticks === undefined
              ? '–'
              : `${fmtNum(ticks, 0)} ${t('unit.tick')}${r === null || r === undefined ? '' : ` · ${fmtNum(r)}R`}`;
          return el(
            'tr',
            { 'data-testid': `journal-row-${tr.id}` },
            el('td', {}, String(tr.id)),
            el('td', {}, t(tr.side === 'long' ? 'pr.long' : 'pr.short')),
            el('td', { class: `num ${signClass(tr.netPnl)}` }, fmtMoney(tr.netPnl)),
            el('td', { class: 'num' }, tr.rMultiple === null ? 'N/A' : fmtNum(tr.rMultiple)),
            el('td', { class: 'num', 'data-testid': `mae-${tr.id}` }, exc(e?.maeTicks, e?.maeR)),
            el('td', { class: 'num', 'data-testid': `mfe-${tr.id}` }, exc(e?.mfeTicks, e?.mfeR)),
            el('td', {}, tags),
            el('td', {}, note),
            ...(navigation ? [el('td', {}, tradeButton(tr, navigation, 'journal'))] : []),
          );
        });
        const group = (title: MessageKey, rowsIn: typeof j.byHour) =>
          el(
            'div',
            {},
            el('h4', {}, t(title)),
            el(
              'table',
              { class: 'data compact' },
              el(
                'tr',
                {},
                el('th', {}, ''),
                el('th', { class: 'num' }, t('stat.trades')),
                el('th', { class: 'num' }, t('stat.winRate')),
                el('th', { class: 'num' }, t('stat.netPnl')),
              ),
              ...rowsIn.map((g) =>
                el(
                  'tr',
                  {},
                  el('td', {}, weekdayKeyText(g.key)),
                  el('td', { class: 'num' }, String(g.trades)),
                  el('td', { class: 'num' }, fmtPct(g.winRate)),
                  el('td', { class: `num ${signClass(g.netPnl)}` }, fmtMoney(g.netPnl)),
                ),
              ),
            ),
          );
        panel.replaceChildren(
          el('table', { class: 'data', 'data-testid': 'journal-table' }, head, ...rows),
          el('p', { class: 'muted small' }, t('pr.maeNote')),
          el(
            'div',
            { class: 'row wrap groups' },
            group('pr.byHour', j.byHour),
            group('pr.byWeekday', j.byWeekday),
          ),
        );
      })
      .catch((err: Error) => {
        if (panel.isConnected) panel.replaceChildren(el('p', { class: 'muted' }, err.message));
      });
    void s;
  },
};

export class BottomPanel {
  private active: string;
  private readonly bar: HTMLElement;
  private panel: HTMLElement;
  private last: { s: SessionSettings; st: SessionStateDto; id: number } | undefined;
  private readonly stable = new Map<string, HTMLElement>();
  private readonly mounted = new Set<string>();

  constructor(
    root: HTMLElement,
    private readonly tabs: BottomTab[],
    private readonly navigation?: TradeNavigation,
    private readonly onSelect?: (id: string) => void,
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
        // A tab click always opens the panel; the ▾ toggle folds it back to the strip.
        this.active = tab.id;
        this.setExpanded(true);
        this.refresh();
      });
      this.bar.append(b);
    }
    // The panel starts as a tab strip; a tab click (or the toggle) opens it.
    this.toggle = el(
      'button',
      {
        type: 'button',
        class: 'small ghost bottom-toggle',
        'data-testid': 'bottom-toggle',
        'aria-label': 'toggle',
      },
      '▴',
    );
    this.toggle.addEventListener('click', () => this.setExpanded(!this.expanded));
    this.bar.append(this.toggle);
    this.root = root;
    root.replaceChildren(this.bar, this.panel);
  }

  private readonly root: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  private expanded = false;
  setExpanded(on: boolean): void {
    this.expanded = on;
    // Plain attribute API: the unit tests use a minimal DOM without classList.
    const cls = (this.root.className || '').split(/\s+/).filter((c) => c && c !== 'expanded');
    if (on) cls.push('expanded');
    this.root.className = cls.join(' ');
    this.toggle.textContent = on ? '▾' : '▴';
  }

  render(s: SessionSettings, st: SessionStateDto, id: number): void {
    this.last = { s, st, id };
    this.refresh();
  }

  select(id: string): void {
    if (!this.tabs.some((tab) => tab.id === id)) return;
    this.active = id;
    this.setExpanded(true);
    this.refresh();
  }

  private refresh(): void {
    this.tabs.forEach((tab, i) =>
      this.bar.children[i]!.setAttribute('aria-selected', String(tab.id === this.active)),
    );
    // Badge counts: closed trades and working orders, so a folded panel still informs.
    if (this.last) {
      const counts: Record<string, number> = {
        trades: this.last.st.trading.trades.length,
        orders: this.last.st.trading.orders.filter((o) => o.status === 'working').length,
        fills: this.last.st.trading.fills.length,
      };
      this.tabs.forEach((tab, i) => {
        const n = counts[tab.id];
        (this.bar.children[i] as HTMLElement).setAttribute('data-count', n ? String(n) : '');
      });
    }
    const tab = this.tabs.find((x) => x.id === this.active)!;
    if (tab.persistent) {
      this.refreshPersistent(tab);
      this.onSelect?.(this.active);
      return;
    }
    if (!this.last) return;
    // Each render owns its DOM: pending journal responses retain a detached panel.
    const scrollTop = this.panel.scrollTop;
    const panel = el('div', { class: 'tabpanel', role: 'tabpanel' });
    this.panel.replaceWith(panel);
    this.panel = panel;
    tab.render(this.panel, this.last.s, this.last.st, this.last.id, this.navigation);
    this.panel.scrollTop = scrollTop;
    this.onSelect?.(this.active);
  }

  /** Show a host-owned node without rebuilding it on every session tick. */
  private refreshPersistent(tab: BottomTab): void {
    let stable = this.stable.get(tab.id);
    if (!stable) {
      stable = el('div', { class: 'tabpanel', role: 'tabpanel' });
      this.stable.set(tab.id, stable);
    }
    if (this.last && !this.mounted.has(tab.id)) {
      tab.render(stable, this.last.s, this.last.st, this.last.id, this.navigation);
      this.mounted.add(tab.id);
    }
    if (this.panel !== stable) {
      this.panel.replaceWith(stable);
      this.panel = stable;
    }
  }
}
