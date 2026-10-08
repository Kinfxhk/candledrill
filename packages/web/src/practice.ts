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
  workingOrders,
  type Bar,
  type OrderRequest,
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
import { BottomPanel, exportTab, fillsTab, statsTab, tradesTab, type BottomTab } from './bottom.js';
import { t, type MessageKey } from './i18n.js';
import { el, fmtTime, fromLocalInput, tfLabel, toLocalInput, toast } from './format.js';

const TIMEFRAMES = [60, 300, 900, 3600, 86400];
const SPEEDS = [1, 2, 5, 10, 30, 60, 120];
const TICK_MS = 100;

interface ChartPane {
  tf: number;
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
  private speed = 5;
  private carry = 0;
  private root = document.getElementById('practice-root')!;
  private els: Record<string, HTMLElement> = {};
  private side: SidePanel | undefined;
  private bottom: BottomPanel | undefined;
  private drawings: Drawing[] = [];
  private drawMode: 'hline' | 'tline' | null = null;
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

  private aggOpts() {
    const s = this.meta!.settings;
    return { utcOffsetMinutes: s.utcOffsetMinutes, dayStartMinutes: s.dayStartMinutes };
  }

  async open(id: number): Promise<void> {
    this.pause();
    const view = await sessionsApi.open(id);
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
    this.pause();
    for (const p of this.panes) p.chart.destroy();
    this.panes = [];
    this.meta = undefined;
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
    const jumpBtn = btn('pr.go', '', 'btn-jump');
    const clock = el('span', { class: 'clock', 'data-testid': 'clock' });
    const split = btn('pr.split', '', 'btn-split');
    split.setAttribute('aria-pressed', 'false');
    const hline = btn('pr.hline', '', 'btn-hline');
    const tline = btn('pr.tline', '', 'btn-tline');
    const clearDraw = btn('pr.clearDrawings', 'ghost', 'btn-clear-drawings');
    hline.setAttribute('aria-pressed', 'false');
    tline.setAttribute('aria-pressed', 'false');
    const toolbar = el(
      'div',
      { class: 'toolbar' },
      el('strong', {}, m.name),
      el('span', { class: 'muted' }, m.settings.symbol),
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
      el(
        'label',
        { class: 'row muted' },
        el('span', { 'data-i18n': 'pr.jump' }, t('pr.jump')),
        jumpInput,
      ),
      jumpBtn,
      el('span', { class: 'sep' }),
      split,
      hline,
      tline,
      clearDraw,
      el('span', { class: 'spacer' }),
      clock,
    );
    const charts = el('div', { class: 'charts', 'data-testid': 'charts' });
    const side = el('aside', { class: 'side', 'data-testid': 'side' });
    const workspace = el('div', { class: 'workspace' }, charts, side);
    const bottom = el('div', { class: 'bottom', 'data-testid': 'bottom' });
    this.root.replaceChildren(banner, toolbar, workspace, bottom);
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
      split,
      hline,
      tline,
    };
    split.addEventListener('click', () => this.toggleSplit());
    hline.addEventListener('click', () =>
      this.setDrawMode(this.drawMode === 'hline' ? null : 'hline'),
    );
    tline.addEventListener('click', () =>
      this.setDrawMode(this.drawMode === 'tline' ? null : 'tline'),
    );
    clearDraw.addEventListener('click', () => void this.saveDrawings([]));
    this.side = new SidePanel(side, {
      place: (req) => this.mutate(() => sessionsApi.placeOrder(m.id, req)),
      cancel: (oid) => this.mutate(() => sessionsApi.cancelOrder(m.id, oid)),
      flatten: () => this.mutate(() => sessionsApi.flatten(m.id)),
    });
    this.bottom = new BottomPanel(bottom, [
      tradesTab,
      statsTab,
      fillsTab,
      exportTab,
      ...PracticeView.extraTabs,
    ]);

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
    charts.classList.toggle('split', on);
    this.els.split!.setAttribute('aria-pressed', String(on));
    localStorage.setItem('candledrill.split', on ? '1' : '0');
  }

  private setDrawMode(mode: 'hline' | 'tline' | null): void {
    this.drawMode = mode;
    this.pendingPoint = null;
    this.els.hline?.setAttribute('aria-pressed', String(mode === 'hline'));
    this.els.tline?.setAttribute('aria-pressed', String(mode === 'tline'));
    this.els.charts?.classList.toggle('drawing', mode !== null);
    if (mode) toast(t('pr.drawHint'));
  }

  private renderDrawings(): void {
    for (const p of this.panes) p.chart.setDrawings(this.drawings, (time) => this.snap(p, time));
  }

  private async saveDrawings(next: Drawing[]): Promise<void> {
    if (!this.meta) return;
    try {
      const r = await sessionsApi.saveDrawings(this.meta.id, next);
      this.drawings = r.drawings as Drawing[];
      this.renderDrawings();
    } catch (err) {
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
    const pane: ChartPane = { tf, chart, agg: new BarAggregator(tf, this.aggOpts()), select, cell };
    chart.onClick((c) => this.onChartClick(pane, c.time, c.price));
    select.addEventListener('change', () => {
      pane.tf = Number(select.value);
      this.resetPane(pane);
    });
    this.panes.push(pane);
  }

  private resetPane(p: ChartPane): void {
    p.agg = new BarAggregator(p.tf, this.aggOpts());
    for (const b of this.bars) p.agg.push(b);
    p.chart.setBars(aggregateBars(this.bars, p.tf, this.aggOpts()));
    requestAnimationFrame(() => p.chart.showRecent(150));
    p.chart.setDrawings(this.drawings, (time) => this.snap(p, time));
    this.decorate();
  }

  private resetCharts(): void {
    for (const p of this.panes) this.resetPane(p);
  }

  /** Snap a real time to the bar start of a pane's timeframe. */
  protected snap(p: ChartPane, time: number): number {
    return bucketStart(time, p.tf, this.aggOpts());
  }

  protected onChartClick(_p: ChartPane, time: number | null, price: number | null): void {
    if (price === null) return;
    const tick = this.meta!.settings.tickSize;
    const px = roundToTick(price, tick);
    const id = `d${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    if (this.drawMode === 'hline') {
      this.setDrawMode(null);
      void this.saveDrawings([...this.drawings, { kind: 'hline', id, price: px }]);
      return;
    }
    if (this.drawMode === 'tline') {
      if (time === null) return;
      if (!this.pendingPoint) {
        this.pendingPoint = { time, price: px };
        return;
      }
      const a = this.pendingPoint;
      this.setDrawMode(null);
      if (a.time === time) return;
      void this.saveDrawings([
        ...this.drawings,
        { kind: 'tline', id, t1: a.time, p1: a.price, t2: time, p2: px },
      ]);
      return;
    }
    this.side?.setPrice(price);
  }

  private async mutate(fn: () => Promise<SessionViewDto>): Promise<void> {
    try {
      this.applyView(await fn());
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  async placeOrder(req: OrderRequest): Promise<void> {
    if (this.meta) await this.mutate(() => sessionsApi.placeOrder(this.meta!.id, req));
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
    this.inFlight = true;
    try {
      const r = await sessionsApi.step(this.meta.id, count);
      this.appendBars(r.revealed);
      this.applyView(r);
      if (r.state.status === 'finished') this.pause();
    } catch (err) {
      this.pause();
      toast((err as Error).message, 'error');
    } finally {
      this.inFlight = false;
    }
  }

  private async jump(): Promise<void> {
    if (!this.meta) return;
    const time = fromLocalInput(
      (this.els.jumpInput as HTMLInputElement).value,
      this.meta.settings.utcOffsetMinutes,
    );
    if (!Number.isFinite(time)) return;
    this.pause();
    const r = await sessionsApi.jump(this.meta.id, time);
    if (r.truncated) {
      await this.open(this.meta.id);
      return;
    }
    this.appendBars(r.revealed);
    this.applyView(r);
    for (const p of this.panes) p.chart.scrollToEnd();
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
      }));
    if (tr.position) {
      lines.push({
        price: tr.position.avgPrice,
        color: theme.text,
        title: `${tr.position.qty > 0 ? '+' : ''}${tr.position.qty}`,
      });
    }
    for (const p of this.panes) {
      const markers: MarkerSpec[] = tr.fills.map((f) => ({
        time: this.snap(p, f.time),
        side: f.side,
        text: `${f.side === 'buy' ? 'B' : 'S'}${f.qty}@${f.price}`,
      }));
      p.chart.setMarkers(markers);
      p.chart.setPriceLines(lines);
    }
  }

  render(): void {
    if (!this.meta || !this.state) return;
    const off = this.meta.settings.utcOffsetMinutes;
    this.els.clock!.textContent = fmtTime(this.cursorTime, off);
    const ji = this.els.jumpInput as HTMLInputElement;
    if (!ji.value || fromLocalInput(ji.value, off) <= this.cursorTime)
      ji.value = toLocalInput(this.cursorTime + 3600, off);
    const st = this.state.status;
    const banner = this.els.banner!;
    banner.className = `status-banner ${st === 'active' ? '' : `show ${st}`}`;
    banner.textContent =
      st === 'breached'
        ? t('st.breached', { reason: this.state.statusReason ?? '' })
        : st === 'passed'
          ? t('st.passed')
          : st === 'finished'
            ? t('st.finished')
            : '';
    const ended = st === 'finished';
    (this.els.step as HTMLButtonElement).disabled = ended;
    (this.els.step10 as HTMLButtonElement).disabled = ended;
    (this.els.play as HTMLButtonElement).disabled = ended;
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
    }
  }
}
