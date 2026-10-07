// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Chart wrapper around TradingView Lightweight Charts™ (Apache-2.0).
// Attribution: the library's `attributionLogo` stays enabled (link to tradingview.com) and
// the NOTICE text is shown in the page footer and About dialog. Do not disable either.

import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type MouseEventParams,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Bar } from '@candledrill/core';

export interface ChartTheme {
  background: string;
  text: string;
  grid: string;
  border: string;
  up: string;
  down: string;
  accent: string;
}

export function readTheme(): ChartTheme {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  return {
    background: v('--bg'),
    text: v('--muted'),
    grid: v('--panel-2'),
    border: v('--border'),
    up: v('--up'),
    down: v('--down'),
    accent: v('--accent'),
  };
}

/** "#rrggbb" -> "rgba(r,g,b,a)"; other formats are returned unchanged. */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  return `rgba(${parseInt(m[1]!, 16)}, ${parseInt(m[2]!, 16)}, ${parseInt(m[3]!, 16)}, ${alpha})`;
}

export interface PriceLineSpec {
  price: number;
  color: string;
  title: string;
  dashed?: boolean;
}

export interface MarkerSpec {
  time: number; // real (unshifted) Unix seconds, already snapped to this chart's bars
  side: 'buy' | 'sell';
  text: string;
}

export type Drawing =
  | { kind: 'hline'; id: string; price: number }
  | { kind: 'tline'; id: string; t1: number; p1: number; t2: number; p2: number };

export interface ChartClick {
  time: number | null; // real Unix seconds of the bar under the cursor
  price: number | null;
}

/**
 * One price chart (candles + volume). Times are shifted by `timeShiftSeconds` for display
 * so the axis shows exchange-local time; the public API always uses real Unix seconds.
 */
export class PriceChart {
  private readonly chart: IChartApi;
  private readonly candles: ISeriesApi<'Candlestick'>;
  private readonly volume: ISeriesApi<'Histogram'>;
  private readonly markers: ISeriesMarkersPluginApi<Time>;
  private priceLines: IPriceLine[] = [];
  private drawingLines: IPriceLine[] = [];
  private drawingSeries: ISeriesApi<'Line'>[] = [];
  private theme: ChartTheme;
  private lastBarTime: number | undefined;

  constructor(
    container: HTMLElement,
    private timeShiftSeconds = 0,
  ) {
    this.theme = readTheme();
    this.chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: this.theme.background },
        textColor: this.theme.text,
        fontSize: 11,
        attributionLogo: true,
      },
      grid: {
        vertLines: { color: this.theme.grid },
        horzLines: { color: this.theme.grid },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: this.theme.border },
      timeScale: { borderColor: this.theme.border, timeVisible: true, secondsVisible: false },
    });
    this.candles = this.chart.addSeries(CandlestickSeries, {
      upColor: this.theme.up,
      downColor: this.theme.down,
      wickUpColor: this.theme.up,
      wickDownColor: this.theme.down,
      borderVisible: false,
    });
    this.volume = this.chart.addSeries(HistogramSeries, {
      priceScaleId: 'vol',
      priceFormat: { type: 'volume' },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    this.chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    this.markers = createSeriesMarkers(this.candles, []);
  }

  setTickSize(tickSize: number): void {
    const precision = Math.min(10, Math.max(0, Math.ceil(-Math.log10(tickSize) - 1e-9)));
    this.candles.applyOptions({ priceFormat: { type: 'price', precision, minMove: tickSize } });
  }

  setTimeShift(seconds: number): void {
    this.timeShiftSeconds = seconds;
  }

  private ts(time: number): UTCTimestamp {
    return (time + this.timeShiftSeconds) as UTCTimestamp;
  }

  private volColor(b: Bar): string {
    return withAlpha(b.close >= b.open ? this.theme.up : this.theme.down, 0.45);
  }

  setBars(bars: readonly Bar[]): void {
    this.candles.setData(
      bars.map((b) => ({
        time: this.ts(b.time),
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      })),
    );
    this.volume.setData(
      bars.map((b) => ({ time: this.ts(b.time), value: b.volume, color: this.volColor(b) })),
    );
    this.lastBarTime = bars.at(-1)?.time;
  }

  /** Append or update the last bar (bar.time must be >= the last bar time). */
  updateBar(b: Bar): void {
    this.candles.update({
      time: this.ts(b.time),
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
    });
    this.volume.update({ time: this.ts(b.time), value: b.volume, color: this.volColor(b) });
    this.lastBarTime = b.time;
  }

  get lastTime(): number | undefined {
    return this.lastBarTime;
  }

  setMarkers(markers: readonly MarkerSpec[]): void {
    const sorted = [...markers].sort((a, b) => a.time - b.time);
    const out: SeriesMarker<Time>[] = sorted.map((m) => ({
      time: this.ts(m.time),
      position: m.side === 'buy' ? 'belowBar' : 'aboveBar',
      shape: m.side === 'buy' ? 'arrowUp' : 'arrowDown',
      color: m.side === 'buy' ? this.theme.up : this.theme.down,
      text: m.text,
    }));
    this.markers.setMarkers(out);
  }

  setPriceLines(lines: readonly PriceLineSpec[]): void {
    for (const pl of this.priceLines) this.candles.removePriceLine(pl);
    this.priceLines = lines.map((l) =>
      this.candles.createPriceLine({
        price: l.price,
        color: l.color,
        lineWidth: 1,
        lineStyle: l.dashed ? LineStyle.Dashed : LineStyle.Solid,
        axisLabelVisible: true,
        title: l.title,
      }),
    );
  }

  /** Render user drawings. `snap` maps a real time to a bar time of this chart's timeframe. */
  setDrawings(drawings: readonly Drawing[], snap: (t: number) => number): void {
    for (const pl of this.drawingLines) this.candles.removePriceLine(pl);
    for (const s of this.drawingSeries) this.chart.removeSeries(s);
    this.drawingLines = [];
    this.drawingSeries = [];
    for (const d of drawings) {
      if (d.kind === 'hline') {
        this.drawingLines.push(
          this.candles.createPriceLine({
            price: d.price,
            color: this.theme.accent,
            lineWidth: 1,
            lineStyle: LineStyle.Solid,
            axisLabelVisible: true,
            title: '',
          }),
        );
      } else {
        const a = { time: snap(d.t1), value: d.p1 };
        const b = { time: snap(d.t2), value: d.p2 };
        if (a.time === b.time) continue;
        const pts = a.time < b.time ? [a, b] : [b, a];
        const s = this.chart.addSeries(LineSeries, {
          color: this.theme.accent,
          lineWidth: 2,
          lastValueVisible: false,
          priceLineVisible: false,
          crosshairMarkerVisible: false,
        });
        s.setData(pts.map((p) => ({ time: this.ts(p.time), value: p.value })));
        this.drawingSeries.push(s);
      }
    }
  }

  onClick(handler: (c: ChartClick) => void): void {
    this.chart.subscribeClick((param: MouseEventParams<Time>) => {
      const price = param.point ? this.candles.coordinateToPrice(param.point.y) : null;
      const time = typeof param.time === 'number' ? param.time - this.timeShiftSeconds : null;
      handler({ time, price: price === null ? null : Number(price) });
    });
  }

  applyTheme(): void {
    this.theme = readTheme();
    this.chart.applyOptions({
      layout: {
        background: { type: ColorType.Solid, color: this.theme.background },
        textColor: this.theme.text,
      },
      grid: { vertLines: { color: this.theme.grid }, horzLines: { color: this.theme.grid } },
      rightPriceScale: { borderColor: this.theme.border },
      timeScale: { borderColor: this.theme.border },
    });
    this.candles.applyOptions({
      upColor: this.theme.up,
      downColor: this.theme.down,
      wickUpColor: this.theme.up,
      wickDownColor: this.theme.down,
    });
  }

  scrollToEnd(): void {
    this.chart.timeScale().scrollToRealTime();
  }

  fit(): void {
    this.chart.timeScale().fitContent();
  }

  showRecent(bars: number): void {
    const n = this.candles.data().length;
    if (n === 0) return;
    this.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - bars), to: n + 5 });
  }

  destroy(): void {
    this.chart.remove();
  }
}
