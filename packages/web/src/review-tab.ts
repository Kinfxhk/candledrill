// SPDX-License-Identifier: AGPL-3.0-or-later
// Review tab: equity curve by closed trade, R distribution, Monte Carlo of trade order.
// Plain SVG; uses closed trades only.

import { equityCurve, monteCarlo, rDistribution } from '@candledrill/core';
import type { BottomTab } from './bottom.js';
import { t } from './i18n.js';
import { el, fmtMoney, fmtPct } from './format.js';

const NS = 'http://www.w3.org/2000/svg';
const svg = (tag: string, attrs: Record<string, string | number>) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};

function equitySvg(points: { equity: number }[], start: number): SVGSVGElement {
  const W = 360;
  const H = 120;
  const ys = [start, ...points.map((p) => p.equity)];
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const span = hi - lo || 1;
  const x = (i: number) => (i / Math.max(1, ys.length - 1)) * (W - 8) + 4;
  const y = (v: number) => H - 6 - ((v - lo) / span) * (H - 12);
  const root = svg('svg', {
    viewBox: `0 0 ${W} ${H}`,
    class: 'review-svg',
    'data-testid': 'equity-svg',
  }) as SVGSVGElement;
  root.append(svg('line', { x1: 0, x2: W, y1: y(start), y2: y(start), class: 'base' }));
  root.append(
    svg('polyline', { points: ys.map((v, i) => `${x(i)},${y(v)}`).join(' '), class: 'equity' }),
  );
  return root;
}

function histSvg(buckets: { from: number; count: number }[]): SVGSVGElement {
  const W = 360;
  const H = 120;
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const bw = W / buckets.length;
  const root = svg('svg', {
    viewBox: `0 0 ${W} ${H + 14}`,
    class: 'review-svg',
    'data-testid': 'r-hist',
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
    if (i % 2 === 0) {
      const lbl = svg('text', { x: i * bw + bw / 2, y: H + 12, 'text-anchor': 'middle' });
      lbl.textContent = String(b.from);
      root.append(lbl);
    }
  });
  return root;
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
    const curve = equityCurve(trades, s.startingBalance);
    const dist = rDistribution(trades);
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
      const r = monteCarlo(
        trades.map((x) => x.netPnl),
        { runs: Number(runs.value) || 1000, seed: 1, limit: s.trailingDrawdown },
      );
      if (!r) {
        out.replaceChildren(el('p', { class: 'muted small' }, t('v1.mcNeed')));
        return;
      }
      out.replaceChildren(
        el(
          'table',
          { class: 'data compact' },
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
        ),
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
      el(
        'div',
        { class: 'review-grid' },
        el('section', {}, el('h4', {}, t('v1.equityCurve')), equitySvg(curve, s.startingBalance)),
        el(
          'section',
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
          dist.n ? histSvg(dist.buckets) : el('p', { class: 'muted small' }, t('v1.rDistNone')),
        ),
        el(
          'section',
          {},
          el('h4', {}, t('v1.mc')),
          el('div', { class: 'row' }, runs, run),
          out,
          el('p', { class: 'muted small' }, t('v1.mcNote')),
        ),
      ),
    );
  },
};
