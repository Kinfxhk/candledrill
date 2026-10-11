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
  type IPaneApi,
  type Logical,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { roundToTick, tickDecimals, type Bar } from '@candledrill/core';
import type { AggregateOptions } from '@candledrill/core';
import { weekdayName } from './labels.js';
import { atr, bollinger, ema, macd, rsi, sma, vwap } from './indicators.js';
import type { PaneIndicatorConfig, IndicatorSetting } from './indicator-prefs.js';

/** A bounded window within loaded, revealed bars; both trade endpoints must exist. */
export function tradeWindow(
  times: readonly number[],
  start: number,
  end: number,
  context = 5,
): { from: number; to: number } | null {
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end < start ||
    !Number.isInteger(context) ||
    context < 0
  )
    return null;
  const first = times.indexOf(start);
  const last = times.indexOf(end);
  if (first < 0 || last < first) return null;
  const from = Math.max(0, first - context);
  const to = Math.min(times.length - 1, last + context);
  // A single loaded bar still needs non-zero logical width; the extra slot has no data.
  return { from, to: Math.max(from + 1, to) };
}

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
  /** If set, the line gets a draggable handle on the price scale. */
  orderId?: number;
}

export interface MarkerSpec {
  time: number; // real (unshifted) Unix seconds, already snapped to this chart's bars
  side: 'buy' | 'sell';
  text: string;
}

export type Drawing =
  | { kind: 'hline'; id: string; price: number; color?: string }
  | { kind: 'tline'; id: string; t1: number; p1: number; t2: number; p2: number; color?: string }
  | { kind: 'rect'; id: string; t1: number; p1: number; t2: number; p2: number; color?: string }
  | {
      kind: 'position';
      id: string;
      side: 'long' | 'short';
      t1: number;
      t2: number;
      entry: number;
      stop: number;
      target: number;
      color?: string;
    }
  | { kind: 'text'; id: string; t: number; price: number; text: string; color?: string }
  | { kind: 'arrow'; id: string; t1: number; p1: number; t2: number; p2: number; color?: string }
  | { kind: 'freehand'; id: string; points: { t: number; p: number }[]; color?: string };

/**
 * Keep a long/short R tool consistent while dragging: the stop stays on the losing side
 * and the target on the winning side of the entry, at least one tick away.
 */
export function clampPosition<D extends Extract<Drawing, { kind: 'position' }>>(
  d: D,
  tick: number,
): D {
  const dir = d.side === 'long' ? 1 : -1;
  const stop = dir * (d.entry - d.stop) < tick ? d.entry - dir * tick : d.stop;
  const target = dir * (d.target - d.entry) < tick ? d.entry + dir * tick : d.target;
  return { ...d, stop, target };
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

function arrowHeadPath(x: number, y: number, angle: number, size = 8): string {
  const a1 = angle + Math.PI - 0.5;
  const a2 = angle + Math.PI + 0.5;
  return `M${x} ${y} L${x + size * Math.cos(a1)} ${y + size * Math.sin(a1)} M${x} ${y} L${x + size * Math.cos(a2)} ${y + size * Math.sin(a2)}`;
}

type DragPart = 'p1' | 'p2' | 'body' | 'price' | 'entry' | 'stop' | 'target' | 't2';

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
  private tick = 0.01;
  private barSeconds = 60;
  private drawings: Drawing[] = [];
  private snapFn: (t: number) => number = (t) => t;
  private readonly overlay: SVGSVGElement;
  private overlaySig = '';
  private raf = 0;
  private selected: string | null = null;
  private drag: { id: string; part: DragPart; start: Drawing; t0: number; p0: number } | null =
    null;
  private editHandler: ((d: Drawing) => void) | undefined;
  private deleteHandler: ((id: string) => void) | undefined;
  private labeler: ((d: Extract<Drawing, { kind: 'position' }>) => string) | undefined;
  private orderLineSpecs: PriceLineSpec[] = [];
  private orderLineById = new Map<number, IPriceLine>();
  private orderDragHandler: ((orderId: number, price: number) => Promise<void>) | undefined;
  private orderDrag: {
    orderId: number;
    startPrice: number;
    priceLine: IPriceLine;
    handle: SVGRectElement;
  } | null = null;
  // Indicators
  private indicatorConfig?: PaneIndicatorConfig;
  private indicatorAgg?: AggregateOptions;
  private indicatorBars: Bar[] = [];
  private overlaySeries = new Map<string, ISeriesApi<'Line'>>();
  private paneIndicatorSeries = new Map<string, ISeriesApi<'Line' | 'Histogram'>>();
  private indicatorPane: IPaneApi<Time> | undefined = undefined;
  // Freehand capture
  private freehandMode = false;
  private freehandPoints: { t: number; p: number }[] = [];
  private freehandHandler: ((points: { t: number; p: number }[]) => void) | undefined = undefined;
  private freehandDone: (() => void) | undefined = undefined;
  private pendingAnchor: { t: number; p: number } | null = null;
  private crosshair: { t: number; p: number } | null = null;

  constructor(
    private readonly container: HTMLElement,
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
    this.overlay = svg('svg', { class: 'draw-overlay', 'data-testid': 'draw-overlay' });
    container.append(this.overlay);
  }

  setTickSize(tickSize: number): void {
    this.tick = tickSize;
    // Decimal places of the tick itself (0.25 → 2). ceil(-log10(tick)) is 1 for
    // 0.25 and makes lightweight-charts print 4145.75 as 4145.5.
    const precision = tickDecimals(tickSize);
    this.candles.applyOptions({ priceFormat: { type: 'price', precision, minMove: tickSize } });
  }

  setTimeShift(seconds: number): void {
    this.timeShiftSeconds = seconds;
  }

  /** Bar length of this chart, used to place drawings to the right of the last bar. */
  setBarSeconds(seconds: number): void {
    this.barSeconds = seconds;
  }

  /** Indicator configuration for this pane and the calendar options used by VWAP. */
  setIndicators(config: PaneIndicatorConfig, agg: AggregateOptions): void {
    this.indicatorConfig = config;
    this.indicatorAgg = agg;
    this.renderIndicators();
  }

  /** Show a large anchor and rubber-band line while waiting for the second click. */
  setPendingAnchor(point: { t: number; p: number } | null): void {
    this.pendingAnchor = point;
    this.overlaySig = '';
    this.renderOverlay();
  }

  /** Blind mode: the time axis and crosshair show weekday and clock time, never a date. */
  setBlindAxis(on: boolean): void {
    const clock = (time: Time) => {
      const d = new Date(Number(time) * 1000);
      const hm = d.toISOString().slice(11, 16);
      return { day: weekdayName(d.getUTCDay()), hm };
    };
    if (on) {
      this.chart.applyOptions({
        localization: {
          timeFormatter: (t: Time) => {
            const c = clock(t);
            return `${c.day} ${c.hm}`;
          },
        },
        timeScale: {
          tickMarkFormatter: (t: Time) => {
            const c = clock(t);
            return c.hm === '00:00' ? c.day : c.hm;
          },
        },
      });
    }
  }

  // ------------------------------------------------------------------ crosshair / range sync
  /** Called with the real time under the mouse (null when the mouse leaves the chart). */
  onCrosshair(handler: (time: number | null) => void): void {
    this.chart.subscribeCrosshairMove((param) => {
      if (param.point === undefined || param.time === undefined) {
        this.crosshair = null;
        this.overlaySig = '';
        this.renderOverlay();
        return handler(null);
      }
      if (!param.sourceEvent) return; // set by another chart: do not echo it back
      const time = Number(param.time) - this.timeShiftSeconds;
      const price = this.candles.coordinateToPrice(param.point.y);
      this.crosshair = { t: time, p: price === null ? NaN : Number(price) };
      this.overlaySig = '';
      this.renderOverlay();
      handler(time);
    });
  }

  /** Show the crosshair on the bar containing `time` (already snapped), or hide it. */
  showCrosshair(time: number | null): void {
    if (time === null) return this.chart.clearCrosshairPosition();
    const shown = this.ts(time);
    const idx = this.chart.timeScale().timeToIndex(shown, true);
    const bar = idx === null ? null : this.candles.dataByIndex(idx);
    if (!bar || !('close' in bar)) return this.chart.clearCrosshairPosition();
    this.chart.setCrosshairPosition(Number(bar.close), bar.time, this.candles);
  }

  /** Called with the real time at the right edge of the view whenever it scrolls or zooms. */
  onRangeChange(handler: (rightEdge: number) => void): void {
    this.chart.timeScale().subscribeVisibleLogicalRangeChange((r) => {
      const data = this.candles.data();
      if (!r || data.length < 2) return;
      const n = data.length;
      const lastShown = Number(data[n - 1]!.time);
      const t =
        r.to >= n - 1
          ? lastShown + (r.to - (n - 1)) * this.barSeconds
          : Number(data[Math.max(0, Math.round(r.to))]!.time);
      handler(t - this.timeShiftSeconds);
    });
  }

  /** Scroll so the right edge is at `time`, keeping this chart's own zoom (bar count). */
  alignRightEdge(time: number): void {
    const ts = this.chart.timeScale();
    const r = ts.getVisibleLogicalRange();
    const data = this.candles.data();
    if (!r || data.length < 2) return;
    const width = r.to - r.from;
    const shown = this.ts(time);
    const lastShown = Number(data[data.length - 1]!.time);
    const idx =
      shown > lastShown
        ? data.length - 1 + (shown - lastShown) / this.barSeconds
        : ts.timeToIndex(shown, true);
    if (idx === null || Math.abs(Number(idx) - r.to) < 1) return;
    ts.setVisibleLogicalRange({ from: Number(idx) - width, to: Number(idx) });
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
    this.indicatorBars = [...bars];
    this.renderIndicators();
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
    if (this.indicatorBars.length && b.time < this.indicatorBars.at(-1)!.time) return;
    if (this.indicatorBars.length && b.time === this.indicatorBars.at(-1)!.time) {
      this.indicatorBars[this.indicatorBars.length - 1] = b;
    } else {
      this.indicatorBars.push(b);
    }
    this.renderIndicators();
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
    this.orderLineSpecs = [...lines];
    this.orderLineById.clear();
    this.priceLines = lines.map((l) => {
      const pl = this.candles.createPriceLine({
        price: l.price,
        color: l.color,
        lineWidth: 1,
        lineStyle: l.dashed ? LineStyle.Dashed : LineStyle.Solid,
        axisLabelVisible: true,
        title: l.title,
      });
      if (l.orderId !== undefined) this.orderLineById.set(l.orderId, pl);
      return pl;
    });
    this.overlaySig = '';
    this.renderOverlay();
    if (
      !this.raf &&
      (this.drawings.length || this.orderLineSpecs.some((l) => l.orderId !== undefined))
    )
      this.loop();
  }

  onOrderLineDrag(handler: (orderId: number, price: number) => Promise<void>): void {
    this.orderDragHandler = handler;
  }

  /** Render user drawings. `snap` maps a real time to a bar time of this chart's timeframe. */
  setDrawings(drawings: readonly Drawing[], snap: (t: number) => number): void {
    this.drawings = [...drawings];
    this.snapFn = snap;
    if (this.selected && !drawings.some((d) => d.id === this.selected)) this.selected = null;
    this.renderPriceLines();
    this.overlaySig = '';
    this.renderOverlay();
    if (!this.raf) this.loop();
  }

  onDrawingEdit(handler: (d: Drawing) => void): void {
    this.editHandler = handler;
  }
  onDrawingDelete(handler: (id: string) => void): void {
    this.deleteHandler = handler;
  }
  setPositionLabeler(fn: (d: Extract<Drawing, { kind: 'position' }>) => string): void {
    this.labeler = fn;
  }
  get selectedDrawing(): string | null {
    return this.selected;
  }

  private renderPriceLines(): void {
    for (const pl of this.drawingLines) this.candles.removePriceLine(pl);
    for (const s of this.drawingSeries) this.chart.removeSeries(s);
    this.drawingSeries = [];
    this.drawingLines = this.drawings
      .filter((d): d is Extract<Drawing, { kind: 'hline' }> => d.kind === 'hline')
      .map((d) =>
        this.candles.createPriceLine({
          price: d.price,
          color: this.theme.accent,
          lineWidth: 1,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: '',
        }),
      );
  }

  /** Re-render the overlay whenever the view moves (cheap: skipped when nothing changed). */
  private loop(): void {
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      if (!this.overlay.isConnected) return;
      this.renderOverlay();
      if (this.drawings.length || this.orderLineSpecs.some((l) => l.orderId !== undefined))
        this.loop();
    });
  }

  /** x pixel of a real time (extrapolated to the right of the last bar). */
  private xOf(time: number): number | null {
    const ts = this.timeScale();
    const data = this.candles.data();
    if (data.length === 0) return null;
    const shown = this.ts(this.snapFn(time));
    const lastShown = Number(data[data.length - 1]!.time);
    let logical: number;
    if (shown > lastShown) logical = data.length - 1 + (shown - lastShown) / this.barSeconds;
    else {
      const idx = ts.timeToIndex(shown as UTCTimestamp, true);
      if (idx === null) return null;
      logical = idx;
    }
    return ts.logicalToCoordinate(logical as Logical);
  }

  private timeAt(x: number): number | null {
    const data = this.candles.data();
    const logical = this.timeScale().coordinateToLogical(x);
    if (logical === null || data.length === 0) return null;
    const i = Math.round(logical);
    const lastShown = Number(data[data.length - 1]!.time);
    if (i >= data.length - 1)
      return lastShown + (i - (data.length - 1)) * this.barSeconds - this.timeShiftSeconds;
    return Number(data[Math.max(0, i)]!.time) - this.timeShiftSeconds;
  }

  private yOf(price: number): number | null {
    return this.candles.priceToCoordinate(price);
  }

  private priceAt(y: number): number | null {
    const p = this.candles.coordinateToPrice(y);
    if (p === null) return null;
    return roundToTick(Number(p), this.tick);
  }

  private timeScale() {
    return this.chart.timeScale();
  }

  private renderOverlay(): void {
    const w = this.overlay.clientWidth;
    const plotW = Math.max(0, w - this.chart.priceScale('right').width());
    const pts = this.drawings.map((d) => {
      if (d.kind === 'hline') return [this.yOf(d.price)];
      if (d.kind === 'text') return [this.xOf(d.t), this.yOf(d.price)];
      if (d.kind === 'freehand') return d.points.map((p) => [this.xOf(p.t), this.yOf(p.p)]).flat();
      if (d.kind === 'position')
        return [
          this.xOf(d.t1),
          this.xOf(d.t2),
          this.yOf(d.entry),
          this.yOf(d.stop),
          this.yOf(d.target),
        ];
      return [this.xOf(d.t1), this.yOf(d.p1), this.xOf(d.t2), this.yOf(d.p2)];
    });
    const orderPts = this.orderLineSpecs.map((l) =>
      l.orderId === undefined ? null : this.yOf(l.price),
    );
    const sig = `${w}|${this.selected}|${JSON.stringify(pts)}|${this.drag ? JSON.stringify(this.drawings) : ''}|${JSON.stringify(orderPts)}|${this.orderDrag?.orderId ?? ''}|${JSON.stringify(this.pendingAnchor)}|${JSON.stringify(this.crosshair)}`;
    if (sig === this.overlaySig) return;
    this.overlaySig = sig;
    const nodes: SVGElement[] = [];
    const accent = this.theme.accent;
    const handle = (
      d: Drawing,
      part: DragPart,
      x: number | null,
      y: number | null,
      body = false,
    ) => {
      if (x === null || y === null) return;
      const h = svg('rect', {
        x: x - 5,
        y: y - 5,
        width: 10,
        height: 10,
        rx: body ? 5 : 2,
        class: `handle${body ? ' body' : ''}${this.selected === d.id ? ' active' : ''}`,
        'data-drawing': d.id,
        'data-part': part,
      });
      h.addEventListener('pointerdown', (ev) => this.startDrag(ev, d, part));
      nodes.push(h);
    };
    this.drawings.forEach((d, i) => {
      const p = pts[i]!;
      if (d.kind === 'hline') {
        handle(d, 'price', plotW - 24, p[0]!);
      } else if (d.kind === 'text') {
        const [x, y] = p;
        if (x == null || y == null) return;
        const t = svg('text', {
          x,
          y: y - 6,
          fill: d.color ?? accent,
          'font-size': '13px',
          'font-weight': '600',
          class: 'drawing-text',
          'data-drawing': d.id,
        });
        t.textContent = d.text;
        nodes.push(t);
        handle(d, 'body', x, y, true);
      } else if (d.kind === 'arrow') {
        const [x1, y1, x2, y2] = p;
        if (x1 == null || y1 == null || x2 == null || y2 == null) return;
        const color = d.color ?? accent;
        nodes.push(
          svg('line', { x1, y1, x2, y2, stroke: color, 'stroke-width': 2 }),
          this.arrowHead(x2, y2, Math.atan2(y2 - y1, x2 - x1), color),
        );
        handle(d, 'p1', x1, y1);
        handle(d, 'p2', x2, y2);
      } else if (d.kind === 'freehand') {
        const coords: number[] = [];
        for (let j = 0; j < p.length; j += 2) {
          const x = p[j]!;
          const y = p[j + 1]!;
          if (x == null || y == null) continue;
          coords.push(x, y);
        }
        if (coords.length < 4) return;
        const dstr =
          `M${coords[0]} ${coords[1]} ` +
          coords
            .slice(2)
            .map((v, idx) => (idx % 2 === 0 ? `L${v}` : v))
            .join(' ');
        nodes.push(
          svg('path', {
            d: dstr,
            fill: 'none',
            stroke: d.color ?? accent,
            'stroke-width': 2,
            'stroke-linejoin': 'round',
            'stroke-linecap': 'round',
            class: 'drawing-freehand-path',
            'data-drawing': d.id,
          }),
        );
        handle(d, 'body', coords[0]!, coords[1]!, true);
      } else if (d.kind === 'tline' || d.kind === 'rect') {
        const [x1, y1, x2, y2] = p;
        if (x1 == null || y1 == null || x2 == null || y2 == null) return;
        if (d.kind === 'tline')
          nodes.push(svg('line', { x1, y1, x2, y2, stroke: accent, 'stroke-width': 2 }));
        else
          nodes.push(
            svg('rect', {
              x: Math.min(x1, x2),
              y: Math.min(y1, y2),
              width: Math.abs(x2 - x1),
              height: Math.abs(y2 - y1),
              fill: withAlpha(accent, 0.12),
              stroke: accent,
              'stroke-width': 1,
              'data-kind': 'rect',
            }),
          );
        handle(d, 'p1', x1, y1);
        handle(d, 'p2', x2, y2);
        handle(d, 'body', (x1 + x2) / 2, (y1 + y2) / 2, true);
      } else {
        const [x1, x2, ye, ys, yt] = p;
        if (x1 == null || x2 == null || ye == null || ys == null || yt == null) return;
        const left = Math.min(x1, x2);
        const width = Math.max(4, Math.abs(x2 - x1));
        nodes.push(
          svg('rect', {
            x: left,
            y: Math.min(ye, ys),
            width,
            height: Math.abs(ys - ye),
            fill: withAlpha(this.theme.down, 0.2),
            'data-kind': 'risk',
          }),
          svg('rect', {
            x: left,
            y: Math.min(ye, yt),
            width,
            height: Math.abs(yt - ye),
            fill: withAlpha(this.theme.up, 0.2),
            'data-kind': 'reward',
          }),
          svg('line', {
            x1: left,
            x2: left + width,
            y1: ye,
            y2: ye,
            stroke: this.theme.text,
            'stroke-width': 1,
          }),
        );
        if (this.labeler) {
          const text = this.labeler(d);
          // Keep the label inside the plot (rough width estimate; no layout pass needed).
          const lx = Math.max(4, Math.min(left + 4, plotW - text.length * 6.2 - 4));
          const label = svg('text', {
            x: lx,
            y: Math.max(12, Math.min(ys, yt) - 4),
            'data-testid': `rlabel-${d.id}`,
          });
          label.textContent = text;
          nodes.push(label);
        }
        handle(d, 'entry', left, ye, true);
        handle(d, 'stop', left + width / 2, ys);
        handle(d, 'target', left + width / 2, yt);
        handle(d, 't2', left + width, ye);
      }
      if (this.selected === d.id && this.deleteHandler) {
        const anchor =
          d.kind === 'hline'
            ? [plotW - 44, p[0]]
            : d.kind === 'position'
              ? [p[0], p[3]]
              : d.kind === 'text'
                ? [p[0], p[1]]
                : d.kind === 'freehand'
                  ? [p[0], p[1]]
                  : [p[0], p[1]];
        const [ax, ay] = anchor as [number | null, number | null];
        if (ax != null && ay != null) {
          const g = svg('g', { class: 'del', 'data-testid': 'delete-drawing', role: 'button' });
          g.append(
            svg('circle', { cx: ax - 14, cy: ay - 14, r: 8, fill: this.theme.down }),
            svg('path', {
              d: `M${ax - 17} ${ay - 17} l6 6 m0 -6 l-6 6`,
              stroke: '#fff',
              'stroke-width': 1.5,
            }),
          );
          const title = svg('title', {});
          title.textContent = 'Delete';
          g.append(title);
          g.addEventListener('pointerdown', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            this.deleteHandler?.(d.id);
          });
          nodes.push(g);
        }
      }
    });
    // Rubber-band for trendline / arrow while waiting for the second click.
    if (this.pendingAnchor && this.crosshair) {
      const x1 = this.xOf(this.pendingAnchor.t);
      const y1 = this.yOf(this.pendingAnchor.p);
      const x2 = this.xOf(this.crosshair.t);
      const y2 = this.yOf(this.crosshair.p);
      if (x1 != null && y1 != null && x2 != null && y2 != null) {
        nodes.push(
          svg('line', {
            x1,
            y1,
            x2,
            y2,
            stroke: accent,
            'stroke-width': 2,
            'stroke-dasharray': '4 4',
          }),
          svg('circle', { cx: x1, cy: y1, r: 6, fill: accent }),
        );
      }
    }

    // Clip shapes to the plot area so they never cover the price scale.
    const clipId = this.clipId;
    const defs = svg('defs', {});
    const clip = svg('clipPath', { id: clipId });
    clip.append(svg('rect', { x: 0, y: 0, width: plotW, height: this.overlay.clientHeight }));
    defs.append(clip);
    const g = svg('g', { 'clip-path': `url(#${clipId})` });
    g.append(...nodes);
    const orderGroup = svg('g', { class: 'order-handles' });
    for (const spec of this.orderLineSpecs) {
      const orderId = spec.orderId;
      if (orderId === undefined) continue;
      const y = this.yOf(spec.price);
      if (y === null) continue;
      const h = svg('rect', {
        x: w - 12,
        y: y - 5,
        width: 12,
        height: 10,
        rx: 2,
        fill: spec.color,
        stroke: this.theme.text,
        'stroke-width': 1,
        class: 'order-handle',
        'data-order-id': String(orderId),
      });
      h.addEventListener('pointerdown', (ev) => this.startOrderDrag(ev, orderId));
      orderGroup.append(h);
    }
    this.overlay.replaceChildren(defs, g, orderGroup);
  }

  private arrowHead(x: number, y: number, angle: number, color: string): SVGPathElement {
    return svg('path', {
      d: arrowHeadPath(x, y, angle),
      stroke: color,
      'stroke-width': 2,
      fill: 'none',
    });
  }

  private readonly clipId = `clip-${Math.random().toString(36).slice(2)}`;

  private startDrag(ev: PointerEvent, d: Drawing, part: DragPart): void {
    ev.stopPropagation();
    this.selected = d.id;
    const rect = this.overlay.getBoundingClientRect();
    const t0 = this.timeAt(ev.clientX - rect.left) ?? 0;
    const p0 = this.priceAt(ev.clientY - rect.top) ?? 0;
    this.drag = { id: d.id, part, start: d, t0, p0 };
    // Cover the chart while dragging so it never sees the moves (no panning, no stuck state).
    this.overlay.classList.add('dragging');
    let moved = false;
    const move = (e: PointerEvent) => {
      const t = this.timeAt(e.clientX - rect.left);
      const p = this.priceAt(e.clientY - rect.top);
      if (t === null || p === null || !this.drag) return;
      moved = true;
      const next = this.dragged(
        this.drag.start,
        this.drag.part,
        t,
        p,
        t - this.drag.t0,
        p - this.drag.p0,
      );
      this.drawings = this.drawings.map((x) => (x.id === next.id ? next : x));
      this.overlaySig = '';
      this.renderOverlay();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.overlay.classList.remove('dragging');
      const done = this.drawings.find((x) => x.id === this.drag?.id);
      this.drag = null;
      this.overlaySig = '';
      this.renderOverlay();
      if (moved && done) {
        this.renderPriceLines();
        this.editHandler?.(done);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    this.overlaySig = '';
    this.renderOverlay();
  }

  private startOrderDrag(ev: PointerEvent, orderId: number): void {
    ev.stopPropagation();
    ev.preventDefault();
    const priceLine = this.orderLineById.get(orderId);
    const handler = this.orderDragHandler;
    if (!priceLine || !handler) return;
    const spec = this.orderLineSpecs.find((l) => l.orderId === orderId);
    if (!spec) return;
    const startPrice = spec.price;
    const handle = this.overlay.querySelector(`rect[data-order-id="${orderId}"]`) as SVGRectElement;
    this.orderDrag = { orderId, startPrice, priceLine, handle };
    this.overlay.classList.add('dragging');
    let moved = false;
    const move = (e: PointerEvent) => {
      const rect = this.overlay.getBoundingClientRect();
      const p = this.priceAt(e.clientY - rect.top);
      const drag = this.orderDrag;
      if (p === null || !drag) return;
      moved = true;
      spec.price = p;
      drag.priceLine.applyOptions({ price: p });
      if (drag.handle) {
        const y = this.yOf(p);
        if (y !== null) drag.handle.setAttribute('y', String(y - 5));
      }
    };
    const up = async () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.overlay.classList.remove('dragging');
      const drag = this.orderDrag;
      this.orderDrag = null;
      if (!drag || !moved) {
        this.overlaySig = '';
        this.renderOverlay();
        return;
      }
      try {
        await handler(drag.orderId, spec.price);
      } catch {
        // The caller shows the error. Snap the line back to the last accepted price.
        drag.priceLine.applyOptions({ price: drag.startPrice });
        spec.price = drag.startPrice;
      }
      this.overlaySig = '';
      this.renderOverlay();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  private dragged(
    d: Drawing,
    part: DragPart,
    t: number,
    p: number,
    dt: number,
    dp: number,
  ): Drawing {
    const shiftP = (v: number) => Number((v + dp).toFixed(10));
    if (d.kind === 'hline') return { ...d, price: p };
    if (d.kind === 'text') return { ...d, t: d.t + dt, price: shiftP(d.price) };
    if (d.kind === 'freehand') {
      return {
        ...d,
        points: d.points.map((pt) => ({ t: pt.t + dt, p: shiftP(pt.p) })),
      };
    }
    if (d.kind === 'arrow') {
      if (part === 'p1') return { ...d, t1: t, p1: p };
      if (part === 'p2') return { ...d, t2: t, p2: p };
      return {
        ...d,
        t1: d.t1 + dt,
        t2: d.t2 + dt,
        p1: shiftP(d.p1),
        p2: shiftP(d.p2),
      };
    }
    if (d.kind === 'tline' || d.kind === 'rect') {
      if (part === 'p1') return { ...d, t1: t, p1: p };
      if (part === 'p2') return { ...d, t2: t, p2: p };
      return { ...d, t1: d.t1 + dt, t2: d.t2 + dt, p1: shiftP(d.p1), p2: shiftP(d.p2) };
    }
    let n = d;
    if (part === 'entry')
      n = {
        ...d,
        t1: d.t1 + dt,
        t2: d.t2 + dt,
        entry: shiftP(d.entry),
        stop: shiftP(d.stop),
        target: shiftP(d.target),
      };
    else if (part === 'stop') n = { ...d, stop: p };
    else if (part === 'target') n = { ...d, target: p };
    else if (part === 't2') n = { ...d, t2: Math.max(t, d.t1 + this.barSeconds) };
    return clampPosition(n, this.tick);
  }

  onClick(handler: (c: ChartClick) => void): void {
    // Native clicks (not the library's click events, which merge quick clicks into a
    // double-click): every click counts, a click that was really a pan (moved > 4 px) does not.
    let down: { x: number; y: number } | null = null;
    let freehandMoved = false;
    // Capture phase: the chart library may stop these events from bubbling.
    this.container.addEventListener(
      'pointerdown',
      (e) => {
        down = { x: e.clientX, y: e.clientY };
        if (!this.freehandMode) return;
        e.preventDefault();
        e.stopPropagation();
        this.pushFreehandPoint(e.clientX, e.clientY);
        freehandMoved = false;
      },
      true,
    );
    this.container.addEventListener(
      'pointermove',
      (e) => {
        if (!this.freehandMode) return;
        e.preventDefault();
        freehandMoved = true;
        this.pushFreehandPoint(e.clientX, e.clientY);
      },
      true,
    );
    this.container.addEventListener(
      'pointerup',
      (e) => {
        if (!this.freehandMode) return;
        e.preventDefault();
        e.stopPropagation();
        if (!freehandMoved) this.pushFreehandPoint(e.clientX, e.clientY);
        const pts = PriceChart.simplifyFreehand(this.freehandPoints);
        const cb = this.freehandHandler;
        this.stopFreehand();
        if (pts.length >= 2 && cb) cb(pts);
      },
      true,
    );
    this.container.addEventListener(
      'click',
      (e) => {
        if (this.freehandMode) return;
        if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
        if ((e.target as Element).closest?.('.handle, .del')) return;
        const rect = this.container.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const plotW = rect.width - this.chart.priceScale('right').width();
        if (x > plotW) return;
        const price = this.candles.coordinateToPrice(y);
        const time = this.timeAt(x);
        handler({ time, price: price === null ? null : Number(price) });
      },
      true,
    );
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

  // ---------------------------------------------------------------- freehand
  startFreehand(onPoint: (point: { t: number; p: number }) => void, onDone: () => void): void {
    this.freehandMode = true;
    this.freehandPoints = [];
    this.freehandHandler = (pts) => {
      for (const p of pts) onPoint(p);
    };
    this.freehandDone = onDone;
    this.overlay.classList.add('drawing-freehand');
  }

  stopFreehand(): void {
    this.freehandMode = false;
    this.freehandPoints = [];
    this.freehandHandler = undefined;
    this.freehandDone = undefined;
    this.overlay.classList.remove('drawing-freehand');
  }

  private pushFreehandPoint(clientX: number, clientY: number): void {
    const rect = this.overlay.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const t = this.timeAt(x);
    const p = this.priceAt(y);
    if (t === null || p === null) return;
    this.freehandPoints.push({ t, p });
  }

  /** Simplify a freehand stroke with a basic distance threshold. */
  static simplifyFreehand(
    points: { t: number; p: number }[],
    threshold = 8,
  ): { t: number; p: number }[] {
    if (points.length < 3) return points;
    const out: { t: number; p: number }[] = [points[0]!];
    for (let i = 1; i < points.length - 1; i++) {
      const a = out[out.length - 1]!;
      const b = points[i]!;
      const dx = b.t - a.t;
      const dy = b.p - a.p;
      if (Math.hypot(dx, dy) >= threshold) out.push(b);
    }
    out.push(points[points.length - 1]!);
    return out;
  }

  // ---------------------------------------------------------------- indicators
  private indicatorLineData(
    values: readonly (number | null)[],
    bars: readonly Bar[],
  ): { time: UTCTimestamp; value: number | null }[] {
    return bars.map((b, i) => ({ time: this.ts(b.time), value: values[i] ?? null }));
  }

  private indicatorSeriesOptions(setting: IndicatorSetting) {
    return {
      color: setting.color ?? '#888888',
      lineWidth: 2 as const,
      lastValueVisible: false,
      priceLineVisible: false,
    };
  }

  private renderIndicators(): void {
    if (!this.indicatorConfig || !this.indicatorAgg) return;
    const bars = this.indicatorBars;
    if (bars.length === 0) return;

    const overlayWanted = new Set<string>();
    for (const s of this.indicatorConfig.overlays) {
      if (!s.visible) continue;
      if (s.kind === 'bollinger') {
        overlayWanted.add('ov-bollinger-upper');
        overlayWanted.add('ov-bollinger-middle');
        overlayWanted.add('ov-bollinger-lower');
      } else {
        overlayWanted.add(`ov-${s.kind}`);
      }
    }
    for (const [key, series] of [...this.overlaySeries]) {
      if (!overlayWanted.has(key)) {
        this.chart.removeSeries(series);
        this.overlaySeries.delete(key);
      }
    }

    for (const s of this.indicatorConfig.overlays) {
      if (!s.visible) continue;
      if (s.kind === 'sma' && s.period) {
        const key = 'ov-sma';
        this.ensureOverlayLine(key, s).setData(
          this.indicatorLineData(sma(bars, s.period, s.source), bars),
        );
      } else if (s.kind === 'ema' && s.period) {
        const key = 'ov-ema';
        this.ensureOverlayLine(key, s).setData(
          this.indicatorLineData(ema(bars, s.period, s.source), bars),
        );
      } else if (s.kind === 'bollinger' && s.period && s.stdDev) {
        const r = bollinger(bars, s.period, s.stdDev, s.source);
        this.ensureOverlayLine('ov-bollinger-upper', s).setData(
          this.indicatorLineData(r.upper, bars),
        );
        this.ensureOverlayLine('ov-bollinger-middle', s).setData(
          this.indicatorLineData(r.middle, bars),
        );
        this.ensureOverlayLine('ov-bollinger-lower', s).setData(
          this.indicatorLineData(r.lower, bars),
        );
      } else if (s.kind === 'vwap') {
        const r = vwap(bars, this.indicatorAgg);
        this.ensureOverlayLine('ov-vwap', s).setData(
          r.map((p) => ({ time: this.ts(p.time), value: p.value })),
        );
      }
    }

    const paneWanted = new Set<string>();
    for (const s of this.indicatorConfig.panes) {
      if (!s.visible) continue;
      if (s.kind === 'macd') {
        paneWanted.add('pi-macd');
        paneWanted.add('pi-signal');
        paneWanted.add('pi-histogram');
      } else {
        paneWanted.add(`pi-${s.kind}`);
      }
    }
    const hasPane = paneWanted.size > 0;
    if (!hasPane && this.indicatorPane) {
      this.chart.removePane(1);
      this.indicatorPane = undefined;
      this.paneIndicatorSeries.clear();
    } else if (hasPane && !this.indicatorPane) {
      this.indicatorPane = this.chart.addPane();
      this.indicatorPane.setHeight(120);
    }
    for (const [key, series] of [...this.paneIndicatorSeries]) {
      if (!paneWanted.has(key)) {
        this.chart.removeSeries(series);
        this.paneIndicatorSeries.delete(key);
      }
    }

    for (const s of this.indicatorConfig.panes) {
      if (!s.visible) continue;
      if (s.kind === 'rsi' && s.period) {
        const data = this.indicatorLineData(rsi(bars, s.period, s.source), bars);
        this.ensurePaneLine('pi-rsi', s, 1).setData(data);
      } else if (s.kind === 'atr' && s.period) {
        const data = this.indicatorLineData(atr(bars, s.period), bars);
        this.ensurePaneLine('pi-atr', s, 1).setData(data);
      } else if (s.kind === 'macd' && s.fast && s.slow && s.signal) {
        const r = macd(bars, s.fast, s.slow, s.signal, s.source);
        this.ensurePaneLine('pi-macd', s, 1).setData(this.indicatorLineData(r.macd, bars));
        this.ensurePaneLine('pi-signal', s, 1).setData(this.indicatorLineData(r.signal, bars));
        this.ensurePaneHistogram('pi-histogram', s, 1).setData(
          this.indicatorLineData(r.histogram, bars),
        );
      }
    }
  }

  private ensureOverlayLine(key: string, setting: IndicatorSetting): ISeriesApi<'Line'> {
    let s = this.overlaySeries.get(key);
    if (!s) {
      s = this.chart.addSeries(LineSeries, this.indicatorSeriesOptions(setting));
      this.overlaySeries.set(key, s);
    }
    return s;
  }

  private ensurePaneLine(key: string, setting: IndicatorSetting, pane: number): ISeriesApi<'Line'> {
    let s = this.paneIndicatorSeries.get(key);
    if (!s) {
      s = this.chart.addSeries(LineSeries, this.indicatorSeriesOptions(setting), pane);
      this.paneIndicatorSeries.set(key, s);
    }
    return s as ISeriesApi<'Line'>;
  }

  private ensurePaneHistogram(
    key: string,
    setting: IndicatorSetting,
    pane: number,
  ): ISeriesApi<'Histogram'> {
    let s = this.paneIndicatorSeries.get(key);
    if (!s) {
      s = this.chart.addSeries(
        HistogramSeries,
        {
          color: setting.color ?? '#888888',
          priceScaleId: 'hist',
          priceFormat: { type: 'price', precision: 4, minMove: 0.0001 },
          lastValueVisible: false,
          priceLineVisible: false,
        },
        pane,
      );
      this.chart.priceScale('hist', pane).applyOptions({ scaleMargins: { top: 0.1, bottom: 0.1 } });
      this.paneIndicatorSeries.set(key, s);
    }
    return s as ISeriesApi<'Histogram'>;
  }

  /** Focus already-loaded history. Times use the same snapped buckets as fill markers. */
  focusInterval(start: number, end: number): boolean {
    const range = tradeWindow(
      this.candles.data().map((bar) => Number(bar.time)),
      Number(this.ts(start)),
      Number(this.ts(end)),
    );
    if (!range) return false;
    this.chart.timeScale().setVisibleLogicalRange(range);
    return true;
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
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.overlay.remove();
    this.chart.remove();
  }
}
