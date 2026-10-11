// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Practice view. The browser only holds bars the server has revealed (up to the cursor);
// higher timeframes are aggregated locally from those bars, so a forming bar never
// contains future data.

import {
  BarAggregator,
  aggregateBars,
  bucketStart,
  roundToTick,
  tickDecimals,
  workingOrders,
  type Bar,
  type OrderChange,
  type OrderRequest,
  type Trade,
} from '@candledrill/core';
import { sessionsApi, type SessionMeta, type SessionStateDto, type SessionViewDto } from './api.js';
import {
  PriceChart,
  readTheme,
  type Drawing,
  type MarkerSpec,
  type PriceLineSpec,
} from './chart.js';
import { SidePanel } from './side.js';
import {
  BottomPanel,
  exportTab,
  fillsTab,
  journalTab,
  statsTab,
  tradesTab,
  type BottomTab,
} from './bottom.js';
import { practiceClockText } from './clock.js';
import { getLang, t, type MessageKey } from './i18n.js';
import { statusReasonText } from './labels.js';
import { el, fmtMoney, fmtTime, fromLocalInput, tfLabel, toLocalInput, toast } from './format.js';

const TIMEFRAMES = [60, 300, 900, 3600, 86400];
const SPEEDS = [0.5, 1, 2, 5, 10, 30, 60, 120];
const TICK_MS = 100;

type DrawMode = 'hline' | 'tline' | 'rect' | 'long' | 'short';

interface ChartPane {
  tf: number;
  muteUntil: number;
  chart: PriceChart;
  agg: BarAggregator;
  select: HTMLSelectElement;
  cell: HTMLElement;
}

export class PracticeView {
  private meta: SessionMeta | undefined;
  private state: SessionStateDto | undefined;
  private bars: Bar[] = [];
  private cursorTime = 0;
  private panes: ChartPane[] = [];
  private playing = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight = false;
  /** Invalidates pending requests whenever this view is opened or closed. */
  private generation = 0;
  private speed = 5;
  private carry = 0;
  private root = document.getElementById('practice-root')!;
  private els: Record<string, HTMLElement> = {};
  private side: SidePanel | undefined;
  private bottom: BottomPanel | undefined;
  private reviewingTradeId: number | undefined;
  private drawings: Drawing[] = [];
  private blindAxisLang: string | undefined;
  private drawMode: DrawMode | null = null;
  private linkCharts = localStorage.getItem('candledrill.link') !== '0';
  private pendingPoint: { time: number; price: number } | null = null;
  /** Extra bottom tabs registered by later features (statistics, export). */
  static extraTabs: BottomTab[] = [];

  constructor(private readonly onChanged: () => void = () => {}) {
    document.addEventListener('keydown', (e) => this.onKey(e));
  }

  get sessionId(): number | undefined {
    return this.meta?.id;
  }

  get baseTf(): number {
    if (this.bars.length < 2) return 60;
    let best = Infinity;
    for (let i = 1; i < Math.min(this.bars.length, 500); i++) {
      best = Math.min(best, this.bars[i]!.time - this.bars[i - 1]!.time);
    }
    return Number.isFinite(best) && best > 0 ? best : 60;
  }

  /** True while a blind session's real period and prices are still hidden. */
  get blindHidden(): boolean {
    return this.meta?.settings.blind?.revealed === false;
  }

  private aggOpts() {
    const s = this.meta!.settings;
    return { utcOffsetMinutes: s.utcOffsetMinutes, dayStartMinutes: s.dayStartMinutes };
  }

  async open(id: number): Promise<void> {
    this.close();
    const generation = this.generation;
    let view;
    try {
      view = await sessionsApi.open(id);
    } catch (err) {
      if (generation !== this.generation) return;
      throw err;
    }
    if (generation !== this.generation) return;
    this.meta = view.session;
    this.bars = view.bars;
    this.drawings = (view.session.drawings as Drawing[]) ?? [];
    this.build();
    this.applyView(view);
    this.resetCharts();
    document.getElementById('practice-empty')!.hidden = true;
    this.root.hidden = false;
    localStorage.setItem('candledrill.lastSession', String(id));
  }

  close(): void {
    this.generation++;
    this.pause();
    this.inFlight = false;
    for (const p of this.panes) p.chart.destroy();
    this.panes = [];
    this.meta = undefined;
    this.state = undefined;
    this.bars = [];
    this.drawings = [];
    this.pendingPoint = null;
    this.drawMode = null;
    this.els = {};
    this.side = undefined;
    this.bottom = undefined;
    this.reviewingTradeId = undefined;
    this.root.replaceChildren();
    this.root.hidden = true;
    document.getElementById('practice-empty')!.hidden = false;
  }

  // ---------------------------------------------------------------- layout
  private build(): void {
    for (const p of this.panes) p.chart.destroy();
    this.panes = [];
    const m = this.meta!;
    const btn = (key: MessageKey, cls = '', testid = '') => {
      const b = el(
        'button',
        {
          type: 'button',
          class: cls,
          'data-i18n': key,
          ...(testid ? { 'data-testid': testid } : {}),
        },
        t(key),
      );
      return b;
    };
    const banner = el('div', {
      class: 'status-banner',
      role: 'status',
      'data-testid': 'status-banner',
    });
    const play = btn('pr.play', 'primary', 'btn-play');
    const step = btn('pr.step', '', 'btn-step');
    const step10 = btn('pr.step10', '', 'btn-step10');
    const speed = el('select', { 'aria-label': t('pr.speed'), 'data-testid': 'speed' });
    for (const s of SPEEDS) speed.append(el('option', { value: String(s) }, `${s}×/s`));
    speed.value = String(this.speed);
    const jumpInput = el('input', {
      type: 'datetime-local',
      'aria-label': t('pr.jump'),
      'data-testid': 'jump-input',
    });
    const returnLive = btn('pr.returnLive', '', 'btn-return-live');
    returnLive.hidden = true;
    const reviewStatus = el('span', {
      class: 'muted',
      role: 'status',
      'data-testid': 'review-status',
    });
    const jumpBtn = btn('pr.go', '', 'btn-jump');
    const clock = el('span', { class: 'clock', 'data-testid': 'clock' });
    const split = btn('pr.split', '', 'btn-split');
    split.setAttribute('aria-pressed', 'false');
    const hline = btn('pr.hline', '', 'btn-hline');
    const tline = btn('pr.tline', '', 'btn-tline');
    const rect = btn('pr.rect', '', 'btn-rect');
    const longTool = btn('pr.longTool', '', 'btn-long');
    const shortTool = btn('pr.shortTool', '', 'btn-short');
    const clearDraw = btn('pr.clearDrawings', 'ghost', 'btn-clear-drawings');
    for (const b of [hline, tline, rect, longTool, shortTool])
      b.setAttribute('aria-pressed', 'false');
    const link = el('label', { class: 'row muted' });
    const linkBox = el('input', { type: 'checkbox', 'data-testid': 'link-charts' });
    linkBox.checked = this.linkCharts;
    link.append(linkBox, el('span', { 'data-i18n': 'pr.syncTime' }, t('pr.syncTime')));
    linkBox.addEventListener('change', () => {
      this.linkCharts = linkBox.checked;
      localStorage.setItem('candledrill.link', this.linkCharts ? '1' : '0');
    });
    const reveal = btn('pr.reveal', 'ghost', 'btn-reveal');
    reveal.hidden = !this.blindHidden;
    reveal.addEventListener('click', () => void this.reveal());
    const revealBanner = el('div', { class: 'reveal-banner', 'data-testid': 'reveal-banner' });
    revealBanner.hidden = true;
    const jumpLabel = el(
      'label',
      { class: 'row muted' },
      el('span', { 'data-i18n': 'pr.jump' }, t('pr.jump')),
      jumpInput,
    );
    const toolbar = el(
      'div',
      { class: 'toolbar' },
      el('strong', {}, m.name),
      m.settings.blind
        ? el('span', { class: 'badge blind', 'data-testid': 'blind-badge' }, t('pr.blindBadge'))
        : el('span', { class: 'muted' }, m.settings.symbol),
      reveal,
      el('span', { class: 'sep' }),
      play,
      step,
      step10,
      el(
        'label',
        { class: 'row muted' },
        el('span', { 'data-i18n': 'pr.speed' }, t('pr.speed')),
        speed,
      ),
      el('span', { class: 'sep' }),
      jumpLabel,
      jumpBtn,
      returnLive,
      reviewStatus,
      el('span', { class: 'sep' }),
      split,
      link,
      hline,
      tline,
      rect,
      longTool,
      shortTool,
      clearDraw,
      el('span', { class: 'spacer' }),
      clock,
    );
    const charts = el('div', { class: 'charts', 'data-testid': 'charts' });
    const side = el('aside', { class: 'side', 'data-testid': 'side' });
    const workspace = el('div', { class: 'workspace' }, charts, side);
    const bottom = el('div', { class: 'bottom', 'data-testid': 'bottom' });
    // Blind: no calendar jump (it would show dates); stepping and playing are enough.
    jumpLabel.hidden = this.blindHidden;
    jumpBtn.hidden = this.blindHidden;
    this.root.replaceChildren(banner, revealBanner, toolbar, workspace, bottom);
    this.els = {
      banner,
      play,
      step,
      step10,
      clock,
      charts,
      side,
      bottom,
      jumpInput,
      jumpBtn,
      returnLive,
      reviewStatus,
      split,
      hline,
      tline,
      rect,
      long: longTool,
      short: shortTool,
      reveal,
      revealBanner,
      jumpLabel,
      link,
    };
    split.addEventListener('click', () => this.toggleSplit());
    hline.addEventListener('click', () =>
      this.setDrawMode(this.drawMode === 'hline' ? null : 'hline'),
    );
    tline.addEventListener('click', () =>
      this.setDrawMode(this.drawMode === 'tline' ? null : 'tline'),
    );
    rect.addEventListener('click', () =>
      this.setDrawMode(this.drawMode === 'rect' ? null : 'rect'),
    );
    longTool.addEventListener('click', () =>
      this.setDrawMode(this.drawMode === 'long' ? null : 'long'),
    );
    shortTool.addEventListener('click', () =>
      this.setDrawMode(this.drawMode === 'short' ? null : 'short'),
    );
    clearDraw.addEventListener('click', () => void this.saveDrawings([]));
    this.side = new SidePanel(side, {
      place: (req) => this.mutate(() => sessionsApi.placeOrder(m.id, req)),
      cancel: (oid) => this.mutate(() => sessionsApi.cancelOrder(m.id, oid)),
      modify: (oid, change) => this.mutate(() => sessionsApi.modifyOrder(m.id, oid, change)),
      flatten: () => this.mutate(() => sessionsApi.flatten(m.id)),
    });
    const generation = this.generation;
    this.bottom = new BottomPanel(
      bottom,
      [tradesTab, journalTab, statsTab, fillsTab, exportTab, ...PracticeView.extraTabs],
      {
        unavailable: (trade) => this.tradeViewReason(trade),
        view: (id) => {
          if (generation === this.generation) this.focusTrade(id);
        },
      },
    );
    returnLive.addEventListener('click', () => this.returnToCurrent());

    play.addEventListener('click', () => (this.playing ? this.pause() : this.play()));
    step.addEventListener('click', () => void this.step(1));
    step10.addEventListener('click', () => void this.step(10));
    speed.addEventListener('change', () => (this.speed = Number(speed.value)));
    jumpBtn.addEventListener('click', () => void this.jump());

    this.addPane(this.baseTf);
    if (localStorage.getItem('candledrill.split') === '1') this.toggleSplit();
  }

  private toggleSplit(): void {
    const charts = this.els.charts!;
    if (this.panes.length === 1) {
      const higher = TIMEFRAMES.find((x) => x > this.panes[0]!.tf * 4) ?? TIMEFRAMES.at(-1)!;
      this.addPane(higher);
      this.resetPane(this.panes[1]!);
    } else {
      const p = this.panes.pop()!;
      p.chart.destroy();
      p.cell.remove();
    }
    const on = this.panes.length > 1;
    this.els.link!.hidden = !on;
    charts.classList.toggle('split', on);
    this.els.split!.setAttribute('aria-pressed', String(on));
    localStorage.setItem('candledrill.split', on ? '1' : '0');
  }

  private setDrawMode(mode: DrawMode | null): void {
    this.drawMode = mode;
    this.pendingPoint = null;
    for (const k of ['hline', 'tline', 'rect', 'long', 'short'] as const)
      this.els[k]?.setAttribute('aria-pressed', String(mode === k));
    this.els.charts?.classList.toggle('drawing', mode !== null);
    if (mode)
      toast(
        t(
          mode === 'rect'
            ? 'pr.rectHint'
            : mode === 'long' || mode === 'short'
              ? 'pr.rToolHint'
              : 'pr.drawHint',
        ),
      );
  }

  private async reveal(): Promise<void> {
    if (!this.meta || !confirm(t('pr.revealConfirm'))) return;
    const generation = this.generation;
    try {
      const view = await sessionsApi.reveal(this.meta.id);
      if (generation !== this.generation) return;
      this.meta = view.session;
      this.els.reveal!.hidden = true;
      this.applyView(view);
    } catch (err) {
      if (generation !== this.generation) return;
      toast((err as Error).message, 'error');
    }
  }

  /** Label of a long/short R tool: risk and reward in ticks and money, and the R multiple. */
  private positionLabel(d: Extract<Drawing, { kind: 'position' }>): string {
    const s = this.meta!.settings;
    const risk = Math.round(Math.abs(d.entry - d.stop) / s.tickSize);
    const reward = Math.round(Math.abs(d.target - d.entry) / s.tickSize);
    return t('pr.rLabel', {
      side: t(d.side === 'long' ? 'pr.long' : 'pr.short'),
      risk,
      money: fmtMoney(Math.abs(d.entry - d.stop) * s.pointValue),
      reward,
      r: risk > 0 ? (reward / risk).toFixed(2) : '–',
    });
  }

  private deleteDrawing(id: string): void {
    void this.saveDrawings(this.drawings.filter((d) => d.id !== id));
  }

  private renderDrawings(): void {
    for (const p of this.panes) p.chart.setDrawings(this.drawings, (time) => this.snap(p, time));
  }

  private async saveDrawings(next: Drawing[]): Promise<void> {
    if (!this.meta) return;
    const generation = this.generation;
    try {
      const r = await sessionsApi.saveDrawings(this.meta.id, next);
      if (generation !== this.generation) return;
      this.drawings = r.drawings as Drawing[];
      this.renderDrawings();
    } catch (err) {
      if (generation !== this.generation) return;
      toast((err as Error).message, 'error');
    }
  }

  private addPane(tf: number): void {
    const select = el('select', {
      'aria-label': t('pr.tf'),
      'data-testid': `tf-${this.panes.length}`,
    });
    for (const x of TIMEFRAMES.filter((x) => x >= this.baseTf))
      select.append(el('option', { value: String(x) }, tfLabel(x)));
    select.value = String(tf);
    const body = el('div', { class: 'chart-body' });
    const cell = el(
      'div',
      { class: 'chart-cell' },
      el('div', { class: 'chart-head' }, select),
      body,
    );
    this.els.charts!.append(cell);
    const chart = new PriceChart(body, this.meta!.settings.utcOffsetMinutes * 60);
    chart.setTickSize(this.meta!.settings.tickSize);
    chart.setBarSeconds(tf);
    chart.setBlindAxis(this.blindHidden);
    const pane: ChartPane = {
      tf,
      muteUntil: 0,
      chart,
      agg: new BarAggregator(tf, this.aggOpts()),
      select,
      cell,
    };
    chart.onClick((c) => this.onChartClick(pane, c.time, c.price));
    chart.setPositionLabeler((d) => this.positionLabel(d));
    chart.onDrawingEdit(
      (d) => void this.saveDrawings(this.drawings.map((x) => (x.id === d.id ? d : x))),
    );
    chart.onDrawingDelete((id) => this.deleteDrawing(id));
    chart.onOrderLineDrag((orderId, price) => this.modifyOrderPrice(orderId, price));
    // Crosshair always follows across charts; the time axis follows when "Link charts" is on.
    chart.onCrosshair((time) => {
      for (const o of this.panes)
        if (o !== pane) o.chart.showCrosshair(time === null ? null : this.snap(o, time));
    });
    chart.onRangeChange((edge) => {
      if (!this.linkCharts || Date.now() < pane.muteUntil) return;
      for (const o of this.panes)
        if (o !== pane) {
          o.muteUntil = Date.now() + 200;
          o.chart.alignRightEdge(edge);
        }
    });
    select.addEventListener('change', () => {
      pane.tf = Number(select.value);
      this.resetPane(pane);
    });
    this.panes.push(pane);
  }

  private resetPane(p: ChartPane): void {
    p.chart.setBarSeconds(p.tf);
    p.agg = new BarAggregator(p.tf, this.aggOpts());
    for (const b of this.bars) p.agg.push(b);
    p.chart.setBars(aggregateBars(this.bars, p.tf, this.aggOpts()));
    requestAnimationFrame(() => {
      if (!this.panes.includes(p)) return;
      const trade = this.state?.trading.trades.find((t) => t.id === this.reviewingTradeId);
      if (trade && !this.tradeViewReason(trade)) {
        for (const pane of this.panes) pane.muteUntil = Date.now() + 200;
        this.focusPane(p, trade);
      } else p.chart.showRecent(150);
    });
    p.chart.setDrawings(this.drawings, (time) => this.snap(p, time));
    this.decorate();
  }

  private resetCharts(): void {
    for (const p of this.panes) this.resetPane(p);
  }

  private tradeViewReason(trade: Pick<Trade, 'openTime' | 'closeTime'>): MessageKey | null {
    if (this.blindHidden) return 'pr.reviewBlind';
    if (
      !this.bars.length ||
      trade.openTime < this.bars[0]!.time ||
      trade.closeTime > this.bars.at(-1)!.time
    )
      return 'pr.reviewMissing';
    return null;
  }

  private focusPane(pane: ChartPane, trade: Trade): boolean {
    return pane.chart.focusInterval(
      this.snap(pane, trade.openTime),
      this.snap(pane, trade.closeTime),
    );
  }

  private focusTrade(id: number): void {
    const trade = this.state?.trading.trades.find((t) => t.id === id);
    if (!trade) return;
    const reason = this.tradeViewReason(trade);
    if (reason || this.inFlight) {
      toast(t(reason ?? 'pr.reviewBusy'));
      return;
    }
    this.pause();
    // Prevent linked-pane scroll events from overriding each pane's focused interval.
    for (const pane of this.panes) pane.muteUntil = Date.now() + 200;
    if (!this.panes.length || !this.panes.every((pane) => this.focusPane(pane, trade))) {
      toast(t('pr.reviewMissing'));
      return;
    }
    this.reviewingTradeId = id;
    this.renderReviewControls();
  }

  private returnToCurrent(): void {
    this.reviewingTradeId = undefined;
    for (const pane of this.panes) pane.muteUntil = Date.now() + 200;
    for (const pane of this.panes) pane.chart.showRecent(150);
    this.renderReviewControls();
  }

  private renderReviewControls(): void {
    if (this.els.returnLive) this.els.returnLive.hidden = this.reviewingTradeId === undefined;
    if (this.els.reviewStatus)
      this.els.reviewStatus.textContent =
        this.reviewingTradeId === undefined
          ? ''
          : t('pr.reviewingTrade', { id: this.reviewingTradeId });
  }

  /** Snap a real time to the bar start of a pane's timeframe. */
  protected snap(p: ChartPane, time: number): number {
    return bucketStart(time, p.tf, this.aggOpts());
  }

  protected onChartClick(_p: ChartPane, time: number | null, price: number | null): void {
    if (time !== null) time = this.snap(_p, time);
    if (price === null) return;
    const tick = this.meta!.settings.tickSize;
    const px = roundToTick(price, tick);
    const id = `d${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    if (this.drawMode === 'hline') {
      this.setDrawMode(null);
      void this.saveDrawings([...this.drawings, { kind: 'hline', id, price: px }]);
      return;
    }
    if (this.drawMode === 'long' || this.drawMode === 'short') {
      if (time === null) return;
      const dir = this.drawMode === 'long' ? 1 : -1;
      const side = this.drawMode;
      this.setDrawMode(null);
      void this.saveDrawings([
        ...this.drawings,
        {
          kind: 'position',
          id,
          side,
          t1: time,
          t2: time + 30 * _p.tf,
          entry: px,
          stop: roundToTick(px - dir * 20 * tick, tick),
          target: roundToTick(px + dir * 40 * tick, tick),
        },
      ]);
      return;
    }
    if (this.drawMode === 'tline' || this.drawMode === 'rect') {
      if (time === null) return;
      if (!this.pendingPoint) {
        this.pendingPoint = { time, price: px };
        return;
      }
      const a = this.pendingPoint;
      const kind = this.drawMode;
      this.setDrawMode(null);
      if (a.time === time && kind === 'tline') return;
      void this.saveDrawings([
        ...this.drawings,
        { kind, id, t1: a.time, p1: a.price, t2: time, p2: px },
      ]);
      return;
    }
    this.side?.setPrice(price);
  }

  private async mutate(fn: () => Promise<SessionViewDto>): Promise<void> {
    const generation = this.generation;
    try {
      const view = await fn();
      if (generation !== this.generation) return;
      this.applyView(view);
    } catch (err) {
      if (generation !== this.generation) return;
      toast((err as Error).message, 'error');
    }
  }

  async placeOrder(req: OrderRequest): Promise<void> {
    if (this.meta) await this.mutate(() => sessionsApi.placeOrder(this.meta!.id, req));
  }

  private async modifyOrderPrice(orderId: number, price: number): Promise<void> {
    if (!this.meta || !this.state) throw new Error('no session');
    const o = workingOrders(this.state.trading).find((x) => x.id === orderId);
    if (!o) throw new Error('order not found');
    const change: OrderChange = o.role === 'entry' ? { price } : { price };
    const generation = this.generation;
    try {
      const view = await sessionsApi.modifyOrder(this.meta.id, orderId, change);
      if (generation !== this.generation) return;
      this.applyView(view);
    } catch (err) {
      if (generation !== this.generation) throw err;
      toast((err as Error).message, 'error');
      throw err;
    }
  }

  // ---------------------------------------------------------------- state
  private applyView(view: SessionViewDto): void {
    this.state = view.state;
    this.cursorTime = view.cursorTime;
    this.render();
  }

  private appendBars(revealed: Bar[]): void {
    for (const b of revealed) {
      this.bars.push(b);
      for (const p of this.panes) p.chart.updateBar(p.agg.push(b).bar);
    }
  }

  async step(count: number): Promise<void> {
    if (!this.meta || this.inFlight) return;
    const generation = this.generation;
    this.inFlight = true;
    try {
      const r = await sessionsApi.step(this.meta.id, count);
      if (generation !== this.generation) return;
      this.appendBars(r.revealed);
      this.applyView(r);
      if (r.state.status === 'finished') this.pause();
    } catch (err) {
      if (generation !== this.generation) return;
      this.pause();
      toast((err as Error).message, 'error');
    } finally {
      if (generation === this.generation) this.inFlight = false;
    }
  }

  private async jump(): Promise<void> {
    if (!this.meta || this.inFlight) return;
    const generation = this.generation;
    const id = this.meta.id;
    const time = fromLocalInput(
      (this.els.jumpInput as HTMLInputElement).value,
      this.meta.settings.utcOffsetMinutes,
    );
    if (!Number.isFinite(time)) return;
    this.pause();
    this.inFlight = true;
    try {
      const r = await sessionsApi.jump(id, time);
      if (generation !== this.generation) return;
      if (r.truncated) {
        await this.open(id);
        return;
      }
      this.appendBars(r.revealed);
      this.applyView(r);
      for (const p of this.panes) p.chart.scrollToEnd();
    } catch (err) {
      if (generation !== this.generation) return;
      toast((err as Error).message, 'error');
    } finally {
      if (generation === this.generation) this.inFlight = false;
    }
  }

  play(): void {
    if (!this.meta || this.state?.status === 'finished') return;
    this.playing = true;
    this.carry = 0;
    this.timer = setInterval(() => {
      this.carry += (this.speed * TICK_MS) / 1000;
      const n = Math.floor(this.carry);
      if (n < 1 || this.inFlight) return;
      this.carry -= n;
      void this.step(Math.min(n, 5000));
    }, TICK_MS);
    this.renderPlay();
  }

  pause(): void {
    this.playing = false;
    clearInterval(this.timer);
    this.renderPlay();
  }

  private renderPlay(): void {
    const b = this.els.play;
    if (!b) return;
    b.dataset.i18n = this.playing ? 'pr.pause' : 'pr.play';
    b.textContent = t(this.playing ? 'pr.pause' : 'pr.play');
  }

  // ---------------------------------------------------------------- render
  protected decorate(): void {
    if (!this.state || !this.meta) return;
    const theme = readTheme();
    const tr = this.state.trading;
    const lines: PriceLineSpec[] = workingOrders(tr)
      .filter((o) => o.price !== null)
      .map((o) => ({
        price: o.price!,
        color:
          o.role === 'stop-loss' ? theme.down : o.role === 'take-profit' ? theme.up : theme.accent,
        title: `${o.role === 'entry' ? o.type : o.role === 'stop-loss' ? 'SL' : 'TP'} ${o.side === 'buy' ? '+' : '-'}${o.qty}`,
        dashed: true,
        orderId: o.id,
      }));
    if (tr.position) {
      lines.push({
        price: tr.position.avgPrice,
        color: theme.text,
        title: `${tr.position.qty > 0 ? '+' : ''}${tr.position.qty}`,
      });
    }
    const dp = tickDecimals(this.meta!.settings.tickSize);
    for (const p of this.panes) {
      const markers: MarkerSpec[] = tr.fills.map((f) => ({
        time: this.snap(p, f.time),
        side: f.side,
        text: `${f.side === 'buy' ? 'B' : 'S'}${f.qty}@${f.price.toFixed(dp)}`,
      }));
      p.chart.setMarkers(markers);
      p.chart.setPriceLines(lines);
    }
  }

  render(): void {
    if (!this.meta || !this.state) return;
    const off = this.meta.settings.utcOffsetMinutes;
    const blind = this.meta.settings.blind;
    this.els.clock!.textContent = practiceClockText({
      cursorTime: this.cursorTime,
      startTime: this.meta.startTime,
      utcOffsetMinutes: off,
      blind,
    });
    if (this.blindHidden && this.blindAxisLang !== getLang()) {
      this.blindAxisLang = getLang();
      for (const pane of this.panes) pane.chart.setBlindAxis(true);
    }
    const rb = this.els.revealBanner!;
    if (blind?.revealed && blind.timeShift !== undefined && blind.priceOffset !== undefined) {
      rb.hidden = false;
      rb.textContent = t('pr.revealed', {
        symbol: blind.symbol ?? '',
        start: fmtTime(this.meta.startTime - blind.timeShift, off),
        now: fmtTime(this.cursorTime - blind.timeShift, off),
        sign: blind.priceOffset >= 0 ? '+' : '−',
        offset: String(Math.abs(blind.priceOffset)),
      });
      this.els.reveal!.hidden = true;
    } else rb.hidden = true;
    const ji = this.els.jumpInput as HTMLInputElement;
    if (!ji.value || fromLocalInput(ji.value, off) <= this.cursorTime)
      ji.value = toLocalInput(this.cursorTime + 3600, off);
    const st = this.state.status;
    const banner = this.els.banner!;
    banner.className = `status-banner ${st === 'active' ? '' : `show ${st}`}`;
    banner.textContent =
      st === 'breached'
        ? t('st.breached', { reason: statusReasonText(this.state.statusReason) })
        : st === 'passed'
          ? t('st.passed')
          : st === 'finished'
            ? t('st.finished')
            : '';
    const ended = st === 'finished';
    (this.els.step as HTMLButtonElement).disabled = ended;
    (this.els.step10 as HTMLButtonElement).disabled = ended;
    (this.els.play as HTMLButtonElement).disabled = ended;
    this.renderReviewControls();
    this.decorate();
    this.side?.render(this.meta.settings, this.state);
    this.bottom?.render(this.meta.settings, this.state, this.meta.id);
    this.onChanged();
  }

  applyTheme(): void {
    for (const p of this.panes) {
      p.chart.applyTheme();
    }
    this.resetCharts();
  }

  private setSpeedIndex(delta: number): void {
    const i = SPEEDS.indexOf(this.speed);
    const next = i < 0 ? 2 : Math.min(Math.max(i + delta, 0), SPEEDS.length - 1);
    this.speed = SPEEDS[next]!;
    const sel = this.els.speed as HTMLSelectElement | undefined;
    if (sel) sel.value = String(this.speed);
  }

  private onKey(e: KeyboardEvent): void {
    if (
      !this.meta ||
      document.getElementById('view-practice')?.classList.contains('active') !== true
    )
      return;
    const target = e.target as HTMLElement;
    if (
      ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName) ||
      document.querySelector('dialog[open]')
    )
      return;
    if (e.key === 'Escape') {
      this.setDrawMode(null);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      const sel = this.panes.map((p) => p.chart.selectedDrawing).find((x) => x !== null);
      if (sel) this.deleteDrawing(sel);
    } else if (e.key === ' ') {
      e.preventDefault();
      if (this.playing) this.pause();
      else this.play();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      void this.step(e.shiftKey ? 10 : 1);
    } else if (e.key === 'b' || e.key === 'B') {
      void this.side?.submit('buy');
    } else if (e.key === 's' || e.key === 'S') {
      void this.side?.submit('sell');
    } else if (e.key === 'f' || e.key === 'F') {
      if (this.meta && this.state?.status !== 'finished')
        void this.mutate(() => sessionsApi.flatten(this.meta!.id));
    } else if (e.key === '[' || e.key === '-') {
      e.preventDefault();
      this.setSpeedIndex(-1);
    } else if (e.key === ']' || e.key === '=') {
      e.preventDefault();
      this.setSpeedIndex(1);
    }
  }
}
