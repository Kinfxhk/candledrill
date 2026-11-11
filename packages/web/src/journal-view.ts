// SPDX-License-Identifier: AGPL-3.0-or-later
// Journal dashboard: per-trade review fields, statistics, daily P&L and filters.
// Numbers come from closed trades only. The editor saves through the session API.

import {
  MAX_JOURNAL_LABEL,
  MAX_NOTE_LENGTH,
  MAX_PLAN_NOTE_LENGTH,
  dailyPnl,
  excursionSummary,
  filterTrades,
  journalAggregates,
  performanceStats,
  rDistribution,
  type DayPnl,
  type Excursion,
  type GroupRow,
  type Journal,
  type JournalEntry,
  type Trade,
  type TradeFilter,
} from '@candledrill/core';
import { sessionsApi, type SessionSettings } from './api.js';
import { el, fmtMoney, fmtNum, fmtPct, signClass, toast } from './format.js';
import { t, type MessageKey } from './i18n.js';
import { weekdayKeyText } from './labels.js';

const NS = 'http://www.w3.org/2000/svg';

function svg(tag: string, attrs: Record<string, string | number>): SVGElement {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

function rHist(buckets: { from: number; count: number }[]): SVGSVGElement {
  const W = 360;
  const H = 120;
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const bw = W / buckets.length;
  const root = svg('svg', {
    viewBox: `0 0 ${W} ${H + 14}`,
    class: 'review-svg',
    'data-testid': 'journal-r-hist',
  }) as SVGSVGElement;
  buckets.forEach((b, i) => {
    const h = (b.count / max) * (H - 4);
    root.append(
      svg('rect', {
        x: i * bw + 1,
        y: H - h,
        width: bw - 2,
        height: h,
        class: b.from < 0 ? 'neg' : 'pos',
      }),
    );
    const last = i === buckets.length - 1;
    if (i % 2 === 0 || last) {
      const lbl = svg('text', { x: i * bw + bw / 2, y: H + 12, 'text-anchor': 'middle' });
      lbl.textContent = i === 0 ? `≤${b.from + 0.5}` : last ? `≥${b.from}` : String(b.from);
      root.append(lbl);
    }
  });
  return root;
}

function stat(key: MessageKey, value: string, id: string): HTMLElement {
  return el(
    'div',
    { class: 'dash-stat', 'data-testid': id },
    el('span', {}, t(key)),
    el('strong', {}, value),
  );
}

function labelOf(key: string, weekday: boolean): string {
  if (!key) return t('journal.none');
  return weekday ? weekdayKeyText(key) : key;
}

function groupTable(title: MessageKey, rows: readonly GroupRow[], weekday: boolean): HTMLElement {
  return el(
    'div',
    {},
    el('h4', {}, t(title)),
    rows.length === 0
      ? el('p', { class: 'muted small' }, t('journal.none'))
      : el(
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
          ...rows.map((g) =>
            el(
              'tr',
              {},
              el('td', {}, labelOf(g.key, weekday)),
              el('td', { class: 'num' }, String(g.trades)),
              el('td', { class: 'num' }, fmtPct(g.winRate)),
              el('td', { class: `num ${signClass(g.netPnl)}` }, fmtMoney(g.netPnl)),
            ),
          ),
        ),
  );
}

function calendar(days: readonly DayPnl[]): HTMLElement {
  const months = new Map<string, DayPnl[]>();
  for (const d of days) {
    const month = d.date.slice(0, 7);
    const list = months.get(month) ?? [];
    list.push(d);
    months.set(month, list);
  }
  return el(
    'section',
    { 'data-testid': 'journal-calendar' },
    el('h4', {}, t('journal.calendar')),
    days.length === 0
      ? el('p', { class: 'muted small' }, t('journal.none'))
      : el(
          'div',
          { class: 'cal-board' },
          ...[...months.entries()].map(([month, list]) =>
            el(
              'div',
              { class: 'cal-month' },
              el('h5', {}, month),
              el(
                'div',
                { class: 'cal-grid' },
                ...list.map((d) =>
                  el(
                    'div',
                    {
                      class: `cal-cell${d.netPnl > 0 ? ' up' : d.netPnl < 0 ? ' down' : ''}`,
                      'data-testid': `cal-${d.date}`,
                      title: `${d.date} · ${d.trades}`,
                    },
                    el('span', {}, d.date.slice(8)),
                    el('span', { class: `cal-pnl ${signClass(d.netPnl)}` }, fmtMoney(d.netPnl)),
                  ),
                ),
              ),
            ),
          ),
        ),
  );
}

function field(label: string, control: HTMLElement): HTMLElement {
  return el('label', {}, el('span', {}, label), control);
}

function option(value: string, label: string): HTMLOptionElement {
  return el('option', { value }, label);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, 'en', { sensitivity: 'base' }),
  );
}

export function renderJournalPanel(
  panel: HTMLElement,
  settings: Pick<SessionSettings, 'utcOffsetMinutes'>,
  trades: readonly Trade[],
  sessionId: number,
  payload: { journal: Journal; excursions: readonly Excursion[] },
  viewButton?: (trade: Trade) => HTMLElement,
): void {
  const live: Record<string, JournalEntry> = { ...payload.journal };
  const ex = new Map(payload.excursions.map((e) => [e.tradeId, e]));
  const text = el('input', {
    type: 'search',
    'aria-label': t('journal.search'),
    placeholder: t('journal.search'),
    'data-testid': 'journal-search',
  });
  const tag = el('select', {
    'aria-label': t('journal.filterTag'),
    'data-testid': 'journal-filter-tag',
  });
  const setup = el('select', {
    'aria-label': t('journal.filterSetup'),
    'data-testid': 'journal-filter-setup',
  });
  const side = el('select', {
    'aria-label': t('journal.filterSide'),
    'data-testid': 'journal-filter-side',
  });
  const result = el('select', {
    'aria-label': t('journal.filterResult'),
    'data-testid': 'journal-filter-result',
  });
  const from = el('input', {
    type: 'date',
    'aria-label': t('journal.from'),
    'data-testid': 'journal-filter-from',
  });
  const to = el('input', {
    type: 'date',
    'aria-label': t('journal.to'),
    'data-testid': 'journal-filter-to',
  });
  side.append(
    option('', t('journal.all')),
    option('long', t('pr.long')),
    option('short', t('pr.short')),
  );
  result.append(
    option('', t('journal.all')),
    option('win', t('journal.win')),
    option('loss', t('journal.loss')),
    option('flat', t('journal.flat')),
  );
  const fillLists = () => {
    const tagValue = tag.value;
    const setupValue = setup.value;
    tag.replaceChildren(
      option('', t('journal.all')),
      ...unique(trades.flatMap((tr) => live[String(tr.id)]?.tags ?? [])).map((v) => option(v, v)),
    );
    setup.replaceChildren(
      option('', t('journal.all')),
      ...unique(trades.map((tr) => live[String(tr.id)]?.setup ?? '')).map((v) => option(v, v)),
    );
    tag.value = tagValue;
    setup.value = setupValue;
  };
  const results = el('div', { class: 'journal-dash', 'data-testid': 'journal-results' });
  const readFilter = (): TradeFilter => ({
    text: text.value,
    tag: tag.value,
    setup: setup.value,
    direction: side.value === 'long' || side.value === 'short' ? side.value : '',
    result:
      result.value === 'win' || result.value === 'loss' || result.value === 'flat'
        ? result.value
        : '',
    from: from.value,
    to: to.value,
  });
  const paint = () => {
    fillLists();
    const filtered = filterTrades(trades, live, settings, readFilter());
    const stats = performanceStats(filtered);
    const groups = journalAggregates(filtered, live, settings);
    const dist = rDistribution(filtered);
    const mae = excursionSummary(
      filtered.flatMap((tr) => {
        const e = ex.get(tr.id);
        return e ? [e] : [];
      }),
    );
    const pf = stats.profitFactor === null ? '–' : fmtNum(stats.profitFactor, 2);
    results.replaceChildren(
      el(
        'p',
        { class: 'muted small', 'data-testid': 'journal-showing' },
        t('journal.showing', {
          n: filtered.length,
          total: trades.length,
        }),
      ),
      el(
        'div',
        { class: 'dash-stats', 'data-testid': 'journal-stats' },
        stat('stat.trades', String(stats.trades), 'stat-trades'),
        stat('stat.winRate', fmtPct(stats.winRate), 'stat-win-rate'),
        stat('stat.profitFactor', pf, 'stat-profit-factor'),
        stat('stat.expectancy', fmtMoney(stats.expectancy), 'stat-expectancy'),
        stat('stat.sharpe', fmtNum(stats.sharpe, 3), 'stat-sharpe'),
        stat('stat.avgWin', fmtMoney(stats.avgWin), 'stat-avg-win'),
        stat('stat.avgLoss', fmtMoney(stats.avgLoss), 'stat-avg-loss'),
        stat('stat.avgR', stats.avgR === null ? '–' : fmtNum(stats.avgR, 2), 'stat-avg-r'),
        stat('stat.maxDd', fmtMoney(stats.maxDrawdown), 'stat-max-dd'),
        stat('stat.netPnl', fmtMoney(stats.netPnl), 'stat-net'),
      ),
      el(
        'div',
        { class: 'row wrap groups' },
        groupTable('journal.byTag', groups.byTag, false),
        groupTable('journal.bySetup', groups.bySetup, false),
        groupTable('journal.byMarket', groups.byMarketCondition, false),
        groupTable('journal.byEmotion', groups.byEmotion, false),
        groupTable('pr.byHour', groups.byHour, true),
        groupTable('pr.byWeekday', groups.byWeekday, true),
      ),
      calendar(dailyPnl(filtered, settings)),
      el(
        'section',
        { class: 'review-grid' },
        el(
          'div',
          {},
          el(
            'h4',
            {},
            t('v1.rDist'),
            ' ',
            el(
              'span',
              { class: 'muted small' },
              dist.avgR === null ? '' : `n=${dist.n} · avg ${dist.avgR.toFixed(2)}R`,
            ),
          ),
          dist.n ? rHist(dist.buckets) : el('p', { class: 'muted small' }, t('v1.rDistNone')),
        ),
        el(
          'div',
          { 'data-testid': 'journal-excursions' },
          el('h4', {}, t('journal.avgMae')),
          el(
            'p',
            {},
            `${fmtNum(mae.avgMaeTicks, 1)} ${t('unit.tick')}`,
            mae.avgMaeR === null ? '' : ` · ${fmtNum(mae.avgMaeR)}R`,
          ),
          el('h4', {}, t('journal.avgMfe')),
          el(
            'p',
            {},
            `${fmtNum(mae.avgMfeTicks, 1)} ${t('unit.tick')}`,
            mae.avgMfeR === null ? '' : ` · ${fmtNum(mae.avgMfeR)}R`,
          ),
        ),
      ),
      filtered.length === 0 ? el('p', { class: 'muted' }, t('journal.noMatch')) : editor(filtered),
      el('p', { class: 'muted small' }, t('pr.maeNote')),
    );
  };
  function editor(rows: readonly Trade[]): HTMLElement {
    const head = el('tr');
    for (const k of [
      '#',
      'col.side',
      'col.net',
      'col.r',
      'col.mae',
      'col.mfe',
      'col.tags',
      'journal.setup',
      'journal.market',
      'journal.emotion',
      'journal.plan',
      'journal.planNote',
      'col.note',
    ] as const)
      head.append(
        el(
          'th',
          { class: ['col.net', 'col.r', 'col.mae', 'col.mfe'].includes(k) ? 'num' : '' },
          k === '#' ? '#' : t(k),
        ),
      );
    if (viewButton) head.append(el('th', {}, t('pr.viewChart')));
    const body = rows
      .slice()
      .reverse()
      .map((tr) => {
        const e = ex.get(tr.id);
        const entry = live[String(tr.id)] ?? { tags: [], note: '' };
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
          maxlength: String(MAX_NOTE_LENGTH),
        });
        const setupInput = el('input', {
          type: 'text',
          value: entry.setup ?? '',
          'aria-label': `${t('journal.setup')} ${tr.id}`,
          'data-testid': `setup-${tr.id}`,
          maxlength: String(MAX_JOURNAL_LABEL),
        });
        const market = el('input', {
          type: 'text',
          value: entry.marketCondition ?? '',
          'aria-label': `${t('journal.market')} ${tr.id}`,
          'data-testid': `market-${tr.id}`,
          maxlength: String(MAX_JOURNAL_LABEL),
        });
        const emotion = el('input', {
          type: 'text',
          value: entry.emotion ?? '',
          'aria-label': `${t('journal.emotion')} ${tr.id}`,
          'data-testid': `emotion-${tr.id}`,
          maxlength: String(MAX_JOURNAL_LABEL),
        });
        const plan = el('select', {
          'aria-label': `${t('journal.plan')} ${tr.id}`,
          'data-testid': `plan-${tr.id}`,
        });
        plan.append(
          option('', t('journal.planUnset')),
          option('yes', t('journal.planYes')),
          option('no', t('journal.planNo')),
        );
        plan.value = entry.planFollowed === true ? 'yes' : entry.planFollowed === false ? 'no' : '';
        const planNote = el('input', {
          type: 'text',
          value: entry.planNote ?? '',
          'aria-label': `${t('journal.planNote')} ${tr.id}`,
          'data-testid': `plan-note-${tr.id}`,
          maxlength: String(MAX_PLAN_NOTE_LENGTH),
        });
        const save = () => {
          const body = {
            tags: tags.value.split(','),
            note: note.value,
            setup: setupInput.value,
            marketCondition: market.value,
            emotion: emotion.value,
            ...(plan.value === 'yes'
              ? { planFollowed: true }
              : plan.value === 'no'
                ? { planFollowed: false }
                : {}),
            planNote: planNote.value,
          };
          void sessionsApi
            .saveJournal(sessionId, tr.id, body)
            .then((res) => {
              const key = String(tr.id);
              const saved = res.journal[key];
              if (saved) live[key] = saved;
              else delete live[key];
              toast(t('pr.journalSaved'));
              paint();
            })
            .catch((err: Error) => toast(err.message, 'error'));
        };
        for (const input of [tags, note, setupInput, market, emotion, plan, planNote])
          input.addEventListener('change', save);
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
          el('td', {}, setupInput),
          el('td', {}, market),
          el('td', {}, emotion),
          el('td', {}, plan),
          el('td', {}, planNote),
          el('td', {}, note),
          ...(viewButton ? [el('td', {}, viewButton(tr))] : []),
        );
      });
    return el(
      'table',
      { class: 'data journal-editor', 'data-testid': 'journal-table' },
      head,
      ...body,
    );
  }
  for (const input of [text, tag, setup, side, result, from, to])
    input.addEventListener('input', paint);
  for (const input of [tag, setup, side, result]) input.addEventListener('change', paint);
  fillLists();
  paint();
  panel.replaceChildren(
    el('h4', {}, t('journal.dash')),
    el(
      'div',
      { class: 'journal-filters' },
      field(t('journal.search'), text),
      field(t('journal.filterTag'), tag),
      field(t('journal.filterSetup'), setup),
      field(t('journal.filterSide'), side),
      field(t('journal.filterResult'), result),
      field(t('journal.from'), from),
      field(t('journal.to'), to),
    ),
    results,
  );
}
