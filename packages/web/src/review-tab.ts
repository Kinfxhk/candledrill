// SPDX-License-Identifier: AGPL-3.0-or-later
// Review tab: KPI summary strip, equity curve by closed trade, R distribution,
// and Monte Carlo (order shuffle or bootstrap resampling).
// Plain SVG; uses closed trades only.

import {
  equityCurve,
  monteCarlo,
  performanceStats,
  rDistribution,
  type MonteCarloMode,
} from '@candledrill/core';
import type { BottomTab } from './bottom.js';
import { t } from './i18n.js';
import { el, fmtMoney, fmtPct } from './format.js';

const NS = 'http://www.w3.org/2000/svg';
const svg = (tag: string, attrs: Record<string, string | number>) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};

let gradSeq = 0;

function equitySvg(points: { equity: number }[], start: number): SVGSVGElement {
  const W = 360;
  const H = 124;
  const ys = [start, ...points.map((p) => p.equity)];
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const span = hi - lo || 1;
  const x = (i: number) => (i / Math.max(1, ys.length - 1)) * (W - 16) + 8;
  const y = (v: number) => H - 14 - ((v - lo) / span) * (H - 26);
  const last = ys.at(-1)!;
  const isUp = last >= start;
  const gradId = `cd-eq-grad-${++gradSeq}`;
  const root = svg('svg', {
    viewBox: `0 0 ${W} ${H}`,
    class: 'review-svg',
    'data-testid': 'equity-svg',
  }) as SVGSVGElement;

  const defs = svg('defs', {});
  const grad = svg('linearGradient', { id: gradId, x1: '0', y1: '0', x2: '0', y2: '1' });
  grad.append(
    svg('stop', {
      offset: '0%',
      'stop-color': isUp ? 'var(--up)' : 'var(--down)',
      'stop-opacity': '0.28',
    }),
    svg('stop', {
      offset: '100%',
      'stop-color': isUp ? 'var(--up)' : 'var(--down)',
      'stop-opacity': '0',
    }),
  );
  defs.append(grad);
  root.append(defs);

  const baseY = y(start);
  root.append(svg('line', { x1: 8, x2: W - 8, y1: baseY, y2: baseY, class: 'base' }));

  const polyPts = ys.map((v, i) => `${x(i)},${y(v)}`).join(' ');
  const areaPts = `${x(0)},${H - 10} ${polyPts} ${x(ys.length - 1)},${H - 10}`;
  root.append(svg('polygon', { points: areaPts, fill: `url(#${gradId})` }));
  root.append(
    svg('polyline', {
      points: polyPts,
      class: `equity ${isUp ? 'is-up' : 'is-down'}`,
    }),
  );
  root.append(
    svg('circle', {
      cx: x(ys.length - 1),
      cy: y(last),
      r: 3,
      class: isUp ? 'pos' : 'neg',
    }),
  );

  const hiLbl = svg('text', { x: 8, y: 10, 'text-anchor': 'start' });
  hiLbl.textContent = fmtMoney(hi);
  const loLbl = svg('text', { x: 8, y: H - 2, 'text-anchor': 'start' });
  loLbl.textContent = fmtMoney(lo);
  const endLbl = svg('text', { x: W - 8, y: 10, 'text-anchor': 'end', class: 'eq-end' });
  endLbl.textContent = fmtMoney(last);
  root.append(hiLbl, loLbl, endLbl);
  return root;
}

function histSvg(buckets: { from: number; count: number }[]): SVGSVGElement {
  const W = 360;
  const H = 114;
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const bw = W / buckets.length;
  const root = svg('svg', {
    viewBox: `0 0 ${W} ${H + 18}`,
    class: 'review-svg',
    'data-testid': 'r-hist',
  }) as SVGSVGElement;
  root.append(svg('line', { x1: 0, x2: W, y1: H, y2: H, class: 'base' }));
  buckets.forEach((b, i) => {
    const h = (b.count / max) * (H - 16);
    if (b.count > 0) {
      root.append(
        svg('rect', {
          x: i * bw + 1.5,
          y: H - h,
          width: Math.max(2, bw - 3),
          height: h,
          rx: 2,
          class: b.from < 0 ? 'neg' : 'pos',
        }),
      );
      const cnt = svg('text', {
        x: i * bw + bw / 2,
        y: Math.max(9, H - h - 3),
        'text-anchor': 'middle',
      });
      cnt.textContent = String(b.count);
      root.append(cnt);
    }
    const last = i === buckets.length - 1;
    if (i % 2 === 0 || last) {
      const lbl = svg('text', { x: i * bw + bw / 2, y: H + 13, 'text-anchor': 'middle' });
      lbl.textContent = i === 0 ? `≤${b.from + 0.5}` : last ? `≥${b.from}` : String(b.from);
      root.append(lbl);
    }
  });
  return root;
}

function kpiTile(label: string, value: string, tone: 'up' | 'down' | '' = ''): HTMLElement {
  return el(
    'div',
    { class: `review-kpi ${tone}`.trim() },
    el('span', { class: 'review-kpi-k' }, label),
    el('strong', { class: 'review-kpi-v num' }, value),
  );
}

export const reviewTab: BottomTab = {
  key: 'v1.review',
  id: 'review',
  render(panel, s, state) {
    const trades = state.trading.trades;
    if (trades.length === 0) {
      panel.replaceChildren(el('p', { class: 'muted' }, t('v1.reviewNone')));
      return;
    }
    const stats = performanceStats(trades);
    const curve = equityCurve(trades, s.startingBalance);
    const dist = rDistribution(trades);

    const kpiStrip = el(
      'div',
      { class: 'review-kpi-strip', 'data-testid': 'review-kpis' },
      kpiTile(
        t('v1.kpiNet'),
        fmtMoney(stats.netPnl),
        stats.netPnl > 0 ? 'up' : stats.netPnl < 0 ? 'down' : '',
      ),
      kpiTile(t('v1.kpiWinRate'), stats.winRate === null ? '—' : fmtPct(stats.winRate)),
      kpiTile(t('v1.kpiPf'), stats.profitFactor === null ? '—' : stats.profitFactor.toFixed(2)),
      kpiTile(
        t('v1.kpiAvgR'),
        stats.avgR === null ? '—' : `${stats.avgR >= 0 ? '+' : ''}${stats.avgR.toFixed(2)}R`,
        stats.avgR !== null ? (stats.avgR >= 0 ? 'up' : 'down') : '',
      ),
      kpiTile(
        t('v1.kpiExp'),
        stats.expectancy === null ? '—' : fmtMoney(stats.expectancy),
        stats.expectancy !== null ? (stats.expectancy >= 0 ? 'up' : 'down') : '',
      ),
      kpiTile(t('v1.kpiMaxDd'), fmtMoney(stats.maxDrawdown), stats.maxDrawdown > 0 ? 'down' : ''),
    );

    const modeSelect = el(
      'select',
      { 'aria-label': t('v1.mcMode'), 'data-testid': 'mc-mode' },
      el('option', { value: 'shuffle' }, t('v1.mcShuffle')),
      el('option', { value: 'bootstrap' }, t('v1.mcBootstrap')),
    );
    const runs = el('input', {
      type: 'number',
      min: '100',
      max: '20000',
      step: '100',
      value: '1000',
      inputmode: 'numeric',
      'aria-label': t('v1.mcRuns'),
    });
    const out = el('div', { 'data-testid': 'mc-result' });
    const run = el(
      'button',
      { type: 'button', class: 'small primary', 'data-testid': 'mc-run' },
      t('v1.mcRun'),
    );
    run.addEventListener('click', () => {
      const mode: MonteCarloMode = modeSelect.value === 'bootstrap' ? 'bootstrap' : 'shuffle';
      const r = monteCarlo(
        trades.map((x) => x.netPnl),
        { runs: Number(runs.value) || 1000, seed: 1, limit: s.trailingDrawdown, mode },
      );
      if (!r) {
        out.replaceChildren(el('p', { class: 'muted small' }, t('v1.mcNeed')));
        return;
      }
      const rows = [
        el(
          'tr',
          {},
          el('th', {}, t('v1.mcMaxDd')),
          el('th', { class: 'num' }, 'p50'),
          el('th', { class: 'num' }, 'p90'),
          el('th', { class: 'num' }, 'p95'),
          el('th', { class: 'num' }, 'p99'),
        ),
        el(
          'tr',
          {},
          el('td', {}, `${r.runs} × ${r.trades}`),
          el('td', { class: 'num' }, fmtMoney(r.maxDrawdown.p50)),
          el('td', { class: 'num' }, fmtMoney(r.maxDrawdown.p90)),
          el('td', { class: 'num' }, fmtMoney(r.maxDrawdown.p95)),
          el('td', { class: 'num' }, fmtMoney(r.maxDrawdown.p99)),
        ),
      ];
      if (r.mode === 'bootstrap') {
        rows.push(
          el(
            'tr',
            {},
            el('th', {}, t('v1.mcFinalPnl')),
            el('th', { class: 'num' }, 'p05'),
            el('th', { class: 'num' }, 'p50'),
            el('th', { class: 'num' }, 'p95'),
            el('th', { class: 'num' }, ''),
          ),
          el(
            'tr',
            {},
            el('td', {}, t('v1.mcBootstrap')),
            el('td', { class: 'num' }, fmtMoney(r.finalPnl.p05)),
            el('td', { class: 'num' }, fmtMoney(r.finalPnl.p50)),
            el('td', { class: 'num' }, fmtMoney(r.finalPnl.p95)),
            el('td', {}, ''),
          ),
        );
      }
      out.replaceChildren(
        el('table', { class: 'data compact' }, ...rows),
        ...(r.breachRate !== null
          ? [
              el(
                'p',
                { class: 'small' },
                t('v1.mcBreach', {
                  pct: fmtPct(r.breachRate),
                  limit: fmtMoney(s.trailingDrawdown),
                }),
              ),
            ]
          : []),
      );
    });
    panel.replaceChildren(
      kpiStrip,
      el(
        'div',
        { class: 'review-grid' },
        el(
          'section',
          { class: 'review-card' },
          el('h4', {}, t('v1.equityCurve')),
          equitySvg(curve, s.startingBalance),
        ),
        el(
          'section',
          { class: 'review-card' },
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
          dist.n ? histSvg(dist.buckets) : el('p', { class: 'muted small' }, t('v1.rDistNone')),
        ),
        el(
          'section',
          { class: 'review-card' },
          el('h4', {}, t('v1.mc')),
          el('div', { class: 'row' }, modeSelect, runs, run),
          out,
          el('p', { class: 'muted small' }, t('v1.mcNote')),
        ),
      ),
    );
  },
};
