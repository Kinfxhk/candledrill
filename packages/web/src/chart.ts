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
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type Logical,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { roundToTick, tickDecimals, type Bar } from '@candledrill/core';

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
  | { kind: 'tline'; id: string; t1: number; p1: number; t2: number; p2: number }
  | { kind: 'rect'; id: string; t1: number; p1: number; t2: number; p2: number }
  | {
      kind: 'position';
      id: string;
      side: 'long' | 'short';
      t1: number;
      t2: number;
      entry: number;
      stop: number;
      target: number;
    };

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

  /** Blind mode: the time axis and crosshair show weekday and clock time, never a date. */
  setBlindAxis(on: boolean): void {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const clock = (t: Time) => {
      const d = new Date(Number(t) * 1000);
      const hm = d.toISOString().slice(11, 16);
      return { day: days[d.getUTCDay()]!, hm };
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
      if (param.point === undefined || param.time === undefined) return handler(null);
      if (!param.sourceEvent) return; // set by another chart: do not echo it back
      handler(Number(param.time) - this.timeShiftSeconds);
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
      if (this.drawings.length) this.loop();
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
    const sig = `${w}|${this.selected}|${JSON.stringify(pts)}|${this.drag ? JSON.stringify(this.drawings) : ''}`;
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
    // Clip shapes to the plot area so they never cover the price scale.
    const clipId = this.clipId;
    const defs = svg('defs', {});
    const clip = svg('clipPath', { id: clipId });
    clip.append(svg('rect', { x: 0, y: 0, width: plotW, height: this.overlay.clientHeight }));
    defs.append(clip);
    const g = svg('g', { 'clip-path': `url(#${clipId})` });
    g.append(...nodes);
    this.overlay.replaceChildren(defs, g);
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
    // Capture phase: the chart library may stop these events from bubbling.
    this.container.addEventListener(
      'pointerdown',
      (e) => {
        down = { x: e.clientX, y: e.clientY };
      },
      true,
    );
    this.container.addEventListener(
      'click',
      (e) => {
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
