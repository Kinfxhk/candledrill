// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Practice view. The browser only holds bars the server has revealed (up to the cursor);
// higher timeframes are aggregated locally from those bars, so a forming bar never
// contains future data.

import * as overlays from './overlays.js';
import {
  BarAggregator,
  aggregateBars,
  bucketStart,
  macroSignal,
  roundToTick,
  workingOrders,
  type Bar,
  type OrderChange,
  type OrderRequest,
  type SessionSettings as EngineSettings,
  type Trade,
} from '@candledrill/core';
import { sessionsApi, type SessionMeta, type SessionStateDto, type SessionViewDto } from './api.js';
import {
  PriceChart,
  readTheme,
  withAlpha,
  type Drawing,
  type MarkerSpec,
  type PriceLineSpec,
} from './chart.js';
import { IndicatorPanel } from './indicator-panel.js';
import { loadIndicatorConfig, type PaneIndicatorConfig } from './indicator-prefs.js';
import { DrawingPalette } from './drawing-palette.js';
import type { PaletteTool } from './drawing-palette.js';
import { MacroPanel } from './macro-panel.js';
import { SidePanel } from './side.js';
import { CompletionSummary } from './summary.js';
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
import { RulesView } from './rules-view.js';
import { reviewTab } from './review-tab.js';
import {
  getSettings,
  hotkeyAction,
  onSettings,
  readDrawingFlags,
  sessionProfile,
  writeDrawingFlags,
  type DrawingFlags,
} from './settings.js';
import { managedStop, protectiveStop } from './stops.js';

/** Steps kept for "Back" (rewind). Each entry is an engine state before one action. */
const MAX_UNDO = 200;
/** Compact trade-bar Flatten stays armed this long, then the first tap is forgotten. */
const FLATTEN_ARM_MS = 3000;
const CHECKPOINTS_KEY = 'candledrill.checkpoints.v1';
interface Checkpoint {
  n: number;
  cursorTime: number;
  state: SessionStateDto;
}
function loadCheckpoints(id: number): Checkpoint[] {
  try {
    const all = JSON.parse(localStorage.getItem(CHECKPOINTS_KEY) ?? '{}') as Record<
      string,
      Checkpoint[]
    >;
    return Array.isArray(all[id]) ? all[id]!.slice(0, 50) : [];
  } catch {
    return [];
  }
}
function saveCheckpoints(id: number, list: Checkpoint[]): void {
  let all: Record<string, Checkpoint[]>;
  try {
    all = JSON.parse(localStorage.getItem(CHECKPOINTS_KEY) ?? '{}') as Record<string, Checkpoint[]>;
  } catch {
    all = {};
  }
  if (list.length) all[id] = list;
  else delete all[id];
  try {
    localStorage.setItem(CHECKPOINTS_KEY, JSON.stringify(all));
  } catch {
    toast('Storage is full: delete some save points.', 'error');
  }
}

const TIMEFRAMES = [60, 300, 900, 3600, 86400];
const SPEEDS = [0.5, 1, 2, 5, 10, 30, 60, 120];
const TICK_MS = 100;
/** Last playback speed on this device. Missing or unknown values fall back to 1 bar/s. */
const SPEED_KEY = 'candledrill.playbackSpeed';

function readPlaybackSpeed(): number {
  try {
    const n = Number(localStorage.getItem(SPEED_KEY));
    if (SPEEDS.includes(n)) return n;
  } catch {
    /* private mode, or a test DOM with no storage */
  }
  return 1;
}

function rememberPlaybackSpeed(speed: number): void {
  try {
    localStorage.setItem(SPEED_KEY, String(speed));
  } catch {
    /* quota or private mode */
  }
}

type DrawMode = PaletteTool;

interface ChartPane {
  tf: number;
  muteUntil: number;
  chart: PriceChart;
  agg: BarAggregator;
  select: HTMLSelectElement;
  cell: HTMLElement;
  /** Semi-auto button in the pane head (hidden while a blind session is hidden). */
  macroBtn: HTMLButtonElement | undefined;
}

export class PracticeView {
  private meta: SessionMeta | undefined;
  private state: SessionStateDto | undefined;
  private summary: CompletionSummary | undefined;
  private bars: Bar[] = [];
  private cursorTime = 0;
  private panes: ChartPane[] = [];
  private playing = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight = false;
  /** Compact-bar Flatten: first tap arms, second tap within this window confirms. */
  private flattenBtn: HTMLButtonElement | undefined;
  private flattenArmTimer: ReturnType<typeof setTimeout> | undefined;
  private flattenWatchInstalled = false;
  /** Invalidates pending requests whenever this view is opened or closed. */
  private generation = 0;
  private speed = readPlaybackSpeed();
  /** Toolbar dropdown and the compact trade-bar dropdown, kept on the same value. */
  private speedSelects: HTMLSelectElement[] = [];
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
  private indicatorConfig: PaneIndicatorConfig = loadIndicatorConfig();
  private indicatorPanels: IndicatorPanel[] = [];
  private macroPanel: MacroPanel | undefined;
  private macroArmed = false;
  private palettes: DrawingPalette[] = [];
  /** Extra bottom tabs registered by later features (statistics, export). */
  static extraTabs: BottomTab[] = [];
  /** Engine states before each action, newest last (rewind). */
  private undo: SessionStateDto[] = [];
  private checkpoints: Checkpoint[] = [];
  private rulesView: RulesView | undefined;
  private unsubscribeSettings: (() => void) | undefined;

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
    return {
      utcOffsetMinutes: s.utcOffsetMinutes,
      dayStartMinutes: s.dayStartMinutes,
      anchorMinutes: s.anchorMinutes,
    };
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
    document.body?.classList?.add('in-practice');
    // The open session, readable by tests and tools without guessing from the session list.
    this.root.setAttribute?.('data-session-id', String(id));
    localStorage.setItem('candledrill.lastSession', String(id));
  }

  close(): void {
    this.disarmFlatten();
    this.summary?.destroy();
    this.summary = undefined;
    this.generation++;
    this.pause();
    this.inFlight = false;
    for (const p of this.panes) p.chart.destroy();
    this.indicatorPanels.forEach((p) => p.close());
    this.indicatorPanels = [];
    this.macroArmed = false;
    this.macroPanel = undefined;
    this.palettes.forEach((p) => p.destroy());
    this.palettes = [];
    this.panes = [];
    this.meta = undefined;
    this.state = undefined;
    this.bars = [];
    this.drawings = [];
    this.pendingPoint = null;
    this.drawMode = null;
    this.els = {};
    this.speedSelects = [];
    this.side = undefined;
    this.bottom = undefined;
    this.reviewingTradeId = undefined;
    this.undo = [];
    this.checkpoints = [];
    this.rulesView = undefined;
    this.unsubscribeSettings?.();
    this.unsubscribeSettings = undefined;
    overlays.closeAll();
    this.sheetOpen = false;
    document.body?.classList?.remove('in-practice', 'sheet-open');
    this.root.replaceChildren();
    // Attribute API: the unit tests use a minimal DOM without `dataset`.
    this.root.removeAttribute?.('data-session-id');
    this.root.hidden = true;
    document.getElementById('practice-empty')!.hidden = false;
  }

  // ---------------------------------------------------------------- layout
  private build(): void {
    for (const p of this.panes) p.chart.destroy();
    this.panes = [];
    this.speedSelects = [];
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
    const back = btn('v1.rewind', '', 'btn-back');
    back.title = t('v1.rewindTitle');
    back.addEventListener('click', () => void this.rewind());
    const saveCp = btn('v1.checkpoint', 'ghost', 'btn-checkpoint');
    saveCp.addEventListener('click', () => this.addCheckpoint());
    this.pnlChip = el('span', { class: 'pnl-chip num', 'data-testid': 'pnl-chip' });
    this.checkpointList = el('ul', { class: 'checkpoint-list', 'data-testid': 'checkpoints' });
    this.objectsList = el('ul', { class: 'object-list', 'data-testid': 'objects' });
    this.flags = readDrawingFlags(m.id);
    this.checkpointCard = el(
      'section',
      { class: 'card' },
      el('h3', { 'data-i18n': 'v1.checkpoints' }, t('v1.checkpoints')),
      this.checkpointList,
    );
    const sheetBtn = btn('v1.panel', 'ghost sheet-toggle', 'btn-sheet');
    sheetBtn.setAttribute('aria-expanded', 'false');
    sheetBtn.addEventListener('click', () => this.setSheet(!this.sheetOpen));
    const speed = this.bindSpeedSelect('speed');
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
    const macroBlind = el(
      'p',
      {
        class: 'notice macro-blind-notice',
        'data-testid': 'macro-blind-notice',
        'data-i18n': 'macro.blindStart',
      },
      t('macro.blindStart'),
    );
    macroBlind.hidden = !this.blindHidden;
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
        ? el(
            'span',
            {
              class: 'badge blind',
              'data-testid': 'blind-badge',
              'data-i18n': 'pr.blindBadge',
            },
            t('pr.blindBadge'),
          )
        : el('span', { class: 'muted' }, m.settings.symbol),
      reveal,
      el(
        'div',
        { class: 'replay', role: 'group', 'aria-label': t('pr.play') },
        back,
        play,
        step,
        step10,
        el(
          'label',
          { class: 'row muted speed' },
          el('span', { 'data-i18n': 'pr.speed' }, t('pr.speed')),
          speed,
        ),
      ),
      saveCp,
      el('span', { class: 'sep tb-wide' }),
      el('span', { class: 'tb-wide row' }, jumpLabel, jumpBtn),
      returnLive,
      reviewStatus,
      el('span', { class: 'sep tb-wide' }),
      el('span', { class: 'tb-wide row' }, split, link),
      el('span', { class: 'spacer' }),
      clock,
      this.pnlChip!,
      sheetBtn,
    );
    const charts = el('div', { class: 'charts', 'data-testid': 'charts' });
    const side = el('aside', { class: 'side', 'data-testid': 'side' });
    const workspace = el('div', { class: 'workspace' }, charts, side);
    const bottom = el('div', { class: 'bottom', 'data-testid': 'bottom' });
    const summary = el('section', {
      class: 'completion-summary',
      'data-testid': 'completion-summary',
      'aria-label': t('summary.title'),
    });
    summary.hidden = true;
    // Blind: no calendar jump (it would show dates); stepping and playing are enough.
    jumpLabel.hidden = this.blindHidden;
    jumpBtn.hidden = this.blindHidden;
    const tradeBar = this.buildTradeBar();
    this.root.replaceChildren(
      macroBlind,
      banner,
      revealBanner,
      toolbar,
      summary,
      workspace,
      tradeBar,
      bottom,
    );
    this.els = {
      summary,
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
      reveal,
      revealBanner,
      macroBlind,
      jumpLabel,
      link,
      back,
      saveCp,
      sheetBtn,
      // Set while building the trade bar above; keep it (this literal replaces this.els).
      ...(this.els.tbPlay ? { tbPlay: this.els.tbPlay } : {}),
    };
    split.addEventListener('click', () => this.toggleSplit());
    this.rulesView = new RulesView();
    this.rulesView.setProfile(sessionProfile(m.id));
    this.checkpoints = loadCheckpoints(m.id);
    this.side = new SidePanel(side, {
      place: (req) => this.placeOrder(req),
      cancel: (oid) => this.mutate(() => sessionsApi.cancelOrder(m.id, oid)),
      modify: (oid, change) => this.mutate(() => sessionsApi.modifyOrder(m.id, oid, change)),
      flatten: () => this.flattenAll(),
      ticketChanged: () => this.decorate(),
      closeSheet: () => this.setSheet(false),
    });
    this.side.extra.prepend(this.rulesView.el);
    this.side.extra.append(
      this.checkpointCard!,
      el(
        'section',
        { class: 'card' },
        el('h3', { 'data-i18n': 'v1.objects' }, t('v1.objects')),
        this.objectsList!,
      ),
    );
    this.renderCheckpoints();
    this.unsubscribeSettings = onSettings(() => {
      for (const p of this.panes) p.chart.applyTheme();
      this.side?.applyDefaults();
    });
    this.side.applyDefaults();
    this.macroPanel = new MacroPanel({
      blind: () => this.blindHidden,
      onArmed: (armed) => {
        this.macroArmed = armed;
      },
      run: (macro, from) => {
        if (!this.meta) throw new Error('no session');
        return sessionsApi.macroRun(this.meta.id, { macro, mode: 'to_end', from });
      },
    });
    const ordersTab: BottomTab = {
      key: 'pr.orders',
      id: 'orders',
      persistent: true,
      render: (panel) => {
        panel.replaceChildren(this.side!.ordersSection);
      },
    };
    const macroTab: BottomTab = {
      key: 'macro.title',
      id: 'macro',
      persistent: true,
      render: (panel) => {
        panel.replaceChildren(this.macroPanel!.el);
      },
    };
    const generation = this.generation;
    this.bottom = new BottomPanel(
      bottom,
      [
        tradesTab,
        ordersTab,
        macroTab,
        journalTab,
        statsTab,
        reviewTab,
        fillsTab,
        exportTab,
        ...PracticeView.extraTabs,
      ],
      {
        unavailable: (trade) => this.tradeViewReason(trade),
        view: (id) => {
          if (generation === this.generation) this.focusTrade(id);
        },
      },
      (id) => {
        this.bottomTab = id;
        this.syncMacroOpen();
      },
    );
    // Only an actually open panel is an overlay (onSelect also runs on every render).
    this.bottom.onExpandedChange = (on) => {
      if (on) this.bottomOpened();
      else overlays.closed('bottom');
      this.syncMacroOpen();
    };
    returnLive.addEventListener('click', () => this.returnToCurrent());

    this.summary = new CompletionSummary(summary, () => {
      this.bottom?.select('journal');
      (
        this.els.bottom?.querySelector('[data-testid=tab-journal]') as HTMLButtonElement | null
      )?.focus();
    });

    play.addEventListener('click', () => (this.playing ? this.pause() : this.play()));
    step.addEventListener('click', () => void this.stepBars(1));
    step10.addEventListener('click', () => void this.stepBars(10));
    jumpBtn.addEventListener('click', () => void this.jump());

    // Pane menu stays on STANDARD timeframes (≥60s); never offer a sub-minute chart option.
    const defaultTf = TIMEFRAMES.find((x) => x >= this.baseTf) ?? TIMEFRAMES[0]!;
    this.addPane(defaultTf);
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
      const palette = this.palettes.pop();
      palette?.destroy();
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
    const prev = this.drawMode;
    this.drawMode = mode;
    this.pendingPoint = null;
    for (const p of this.panes) p.chart.setPendingAnchor(null);
    this.els.charts?.classList.toggle('drawing', mode !== null);
    for (const p of this.palettes) p.setActive(mode);
    if (prev === 'freehand') for (const p of this.panes) p.chart.stopFreehand();
    if (mode === 'freehand') {
      for (const p of this.panes) {
        const pts: { t: number; p: number }[] = [];
        p.chart.startFreehand(
          (pt) => pts.push(pt),
          () => {
            const stroke = [...pts];
            pts.length = 0;
            if (stroke.length < 2) {
              this.setDrawMode(null);
              return;
            }
            const strokeId = `d${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
            this.setDrawMode(null);
            void this.saveDrawings([
              ...this.drawings,
              { kind: 'freehand', id: strokeId, points: stroke },
            ]);
          },
        );
      }
    }
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

  private flags: DrawingFlags = { hidden: [], locked: [] };
  private objectsList: HTMLElement | undefined;

  private renderDrawings(): void {
    const hidden = new Set(this.flags.hidden);
    const locked = new Set(this.flags.locked);
    for (const p of this.panes) {
      p.chart.setDrawingFlags(hidden, locked);
      p.chart.setDrawings(this.drawings, (time) => this.snap(p, time));
    }
    this.renderObjects();
  }

  /** Object list: show / hide, lock / unlock, delete each drawing. */
  private renderObjects(): void {
    const list = this.objectsList;
    if (!list || !this.meta) return;
    if (!this.drawings.length) {
      list.replaceChildren(el('li', { class: 'muted small' }, t('v1.objectsNone')));
      return;
    }
    const toggle = (key: 'hidden' | 'locked', id: string) => {
      const set = new Set(this.flags[key]);
      if (set.has(id)) set.delete(id);
      else set.add(id);
      this.flags = { ...this.flags, [key]: [...set] };
      writeDrawingFlags(this.meta!.id, this.flags);
      this.renderDrawings();
    };
    list.replaceChildren(
      ...this.drawings.map((d) => {
        const isHidden = this.flags.hidden.includes(d.id);
        const isLocked = this.flags.locked.includes(d.id);
        const eye = el(
          'button',
          {
            type: 'button',
            class: 'small ghost',
            'aria-pressed': String(!isHidden),
            title: t('v1.objectShow'),
          },
          isHidden ? '◌' : '●',
        );
        eye.addEventListener('click', () => toggle('hidden', d.id));
        const lock = el(
          'button',
          {
            type: 'button',
            class: 'small ghost',
            'aria-pressed': String(isLocked),
            title: t('v1.objectLock'),
          },
          isLocked ? '🔒' : '🔓',
        );
        lock.addEventListener('click', () => toggle('locked', d.id));
        const del = el(
          'button',
          { type: 'button', class: 'small ghost', title: t('pr.deleteDrawing') },
          '✕',
        );
        del.addEventListener('click', () => this.deleteDrawing(d.id));
        return el(
          'li',
          { 'data-object': d.id },
          el('span', {}, this.drawingName(d)),
          eye,
          lock,
          del,
        );
      }),
    );
  }

  private drawingName(d: Drawing): string {
    const names: Partial<Record<Drawing['kind'], MessageKey>> = {
      hline: 'pr.hline',
      tline: 'pr.tline',
      ray: 'v1.toolRay',
      vline: 'v1.toolVline',
      channel: 'v1.toolChannel',
      fib: 'v1.toolFib',
      measure: 'v1.toolMeasure',
      rect: 'pr.rect',
      text: 'pr.textTool',
      arrow: 'pr.arrowTool',
      freehand: 'pr.freehandTool',
    };
    if (d.kind === 'position') return t(d.side === 'long' ? 'pr.longTool' : 'pr.shortTool');
    const key = names[d.kind];
    return key ? t(key) : d.kind;
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

  /** Chart Macro button: open the bottom wizard and move focus there. */
  private showMacro(): void {
    this.macroPanel?.enable();
    this.bottom?.select('macro');
    this.macroPanel?.el.scrollIntoView({ block: 'nearest' });
    this.macroPanel?.focus();
  }

  private addPane(tf: number): void {
    const select = el('select', {
      'aria-label': t('pr.tf'),
      'data-testid': `tf-${this.panes.length}`,
    });
    for (const x of TIMEFRAMES.filter((x) => x >= this.baseTf))
      select.append(el('option', { value: String(x) }, tfLabel(x)));
    select.value = String(tf);
    const indBtn = el(
      'button',
      { type: 'button', class: 'small ghost', 'data-i18n': 'pr.indicators' },
      t('pr.indicators'),
    );
    const macroBtn = el(
      'button',
      {
        type: 'button',
        class: 'small ghost',
        'data-i18n': 'macro.open',
        'data-testid': 'macro-open',
      },
      t('macro.open'),
    );
    macroBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showMacro();
    });
    // Semi-auto needs real dates; in a hidden blind session the button is not offered at all.
    macroBtn.hidden = this.blindHidden;
    const head = el(
      'div',
      { class: 'chart-head' },
      select,
      el('span', { class: 'spacer' }),
      macroBtn,
      indBtn,
    );
    const body = el('div', { class: 'chart-body' });
    const cell = el('div', { class: 'chart-cell' }, head, body);
    this.els.charts!.append(cell);
    const chart = new PriceChart(body, this.meta!.settings.utcOffsetMinutes * 60);
    chart.setTickSize(this.meta!.settings.tickSize);
    chart.setBarSeconds(tf);
    chart.setBlindAxis(this.blindHidden);
    chart.setIndicators(this.indicatorConfig, this.aggOpts());
    const palette = new DrawingPalette(body, {
      select: (tool) => this.setDrawMode(tool),
      clear: () => void this.saveDrawings([]),
    });
    this.palettes.push(palette);
    const pane: ChartPane = {
      tf,
      muteUntil: 0,
      chart,
      agg: new BarAggregator(tf, this.aggOpts()),
      select,
      cell,
      macroBtn,
    };
    const panel = new IndicatorPanel(head, (cfg) => {
      this.indicatorConfig = cfg;
      for (const p of this.panes) p.chart.setIndicators(cfg, this.aggOpts());
    });
    this.indicatorPanels.push(panel);
    panel.onClose = () => indBtn.setAttribute('aria-expanded', 'false');
    indBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      panel.toggle();
      indBtn.setAttribute('aria-expanded', String(panel.isOpen()));
    });
    indBtn.setAttribute('aria-expanded', 'false');
    indBtn.setAttribute('data-testid', 'indicators-toggle');
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
    p.chart.setIndicators(this.indicatorConfig, this.aggOpts());
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
    if (this.drawMode === 'text') {
      if (time === null) return;
      const text = prompt(t('pr.textPrompt') ?? 'Text');
      this.setDrawMode(null);
      if (!text) return;
      void this.saveDrawings([...this.drawings, { kind: 'text', id, t: time, price: px, text }]);
      return;
    }
    if (this.drawMode === 'freehand') {
      // Handled by pointer capture in PriceChart; the click itself does nothing.
      return;
    }
    if (this.drawMode === 'vline') {
      if (time === null) return;
      this.setDrawMode(null);
      void this.saveDrawings([
        ...this.drawings,
        { kind: 'vline', id, t1: time, p1: px, t2: time, p2: px },
      ]);
      return;
    }
    if (
      this.drawMode === 'tline' ||
      this.drawMode === 'rect' ||
      this.drawMode === 'arrow' ||
      this.drawMode === 'ray' ||
      this.drawMode === 'fib' ||
      this.drawMode === 'measure' ||
      this.drawMode === 'channel'
    ) {
      if (time === null) return;
      if (!this.pendingPoint) {
        this.pendingPoint = { time, price: px };
        for (const p of this.panes) p.chart.setPendingAnchor({ t: time, p: px });
        return;
      }
      const a = this.pendingPoint;
      const kind = this.drawMode;
      this.setDrawMode(null);
      for (const p of this.panes) p.chart.setPendingAnchor(null);
      if (a.time === time && (kind === 'tline' || kind === 'ray' || kind === 'channel')) return;
      const t1 = a.time;
      const t2 = time;
      const next: Drawing =
        kind === 'channel'
          ? // Default width: 1% of price, user drags the middle handle to adjust.
            { kind, id, t1, p1: a.price, t2, p2: px, w: roundToTick(a.price * 0.01, tick) || tick }
          : { kind, id, t1, p1: a.price, t2, p2: px };
      void this.saveDrawings([...this.drawings, next]);
      return;
    }
    this.side?.setPrice(price);
  }

  private async mutate(fn: () => Promise<SessionViewDto>): Promise<void> {
    const generation = this.generation;
    const before = this.state;
    try {
      const view = await fn();
      if (generation !== this.generation) return;
      if (before && !this.blindHidden) {
        // During Play, automatic changes (stop management, macro fills) fold into the one undo
        // point taken when Play started, so Back undoes the whole run.
        if (!this.playing) {
          this.undo.push(before);
          if (this.undo.length > MAX_UNDO) this.undo.shift();
        } else this.pushUndoState(before);
      }
      this.applyView(view);
    } catch (err) {
      if (generation !== this.generation) return;
      toast((err as Error).message, 'error');
    }
  }

  private engineSettings(): EngineSettings {
    const s = this.meta!.settings;
    return {
      symbol: s.symbol,
      tickSize: s.tickSize,
      pointValue: s.pointValue,
      commissionPerContract: s.commissionPerContract,
      slippageTicks: s.slippageTicks,
      startingBalance: s.startingBalance,
      dailyLossLimit: s.dailyLossLimit,
      trailingDrawdown: s.trailingDrawdown,
      profitTarget: s.profitTarget,
      utcOffsetMinutes: s.utcOffsetMinutes,
      dayStartMinutes: s.dayStartMinutes,
      trailingDrawdownMode: s.trailingDrawdownMode,
      anchorMinutes: s.anchorMinutes,
    };
  }

  /** After a revealed bar closes, an armed macro may send one simulated market order. */
  private async watchMacro(): Promise<void> {
    if (!this.macroArmed || !this.meta || !this.state || this.blindHidden || !this.macroPanel)
      return;
    const macro = this.macroPanel.current();
    // The browser holds a prefix (or the last 50k bars). Evaluate the last bar it has.
    const cursor = this.bars.length - 1;
    const local = cursor === this.state.cursor ? this.state : { ...this.state, cursor };
    const signal = macroSignal(this.bars, this.engineSettings(), local, macro);
    if (signal) this.macroPanel.noteSignal(signal.side);
    if (!signal) return;
    await this.mutate(() =>
      sessionsApi.placeOrder(this.meta!.id, {
        side: signal.side,
        type: 'market',
        qty: macro.qty,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit,
      }),
    );
  }

  async placeOrder(req: OrderRequest): Promise<void> {
    if (!this.meta) return;
    if (this.inFlight) {
      toast(t('pr.busy'));
      return;
    }
    const generation = this.generation;
    this.inFlight = true;
    try {
      await this.mutate(() => sessionsApi.placeOrder(this.meta!.id, req));
    } finally {
      if (generation === this.generation) this.inFlight = false;
    }
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

  /** Auto break-even / trailing stop: tighten the protective stop after a bar close. */
  private async manageStop(): Promise<void> {
    const st = getSettings();
    if ((st.breakEvenTicks === null && st.trailTicks === null) || !this.meta || !this.state) return;
    const tr = this.state.trading;
    const stop = protectiveStop(tr);
    if (!stop || !tr.position || !tr.openTrade) return;
    const side = tr.position.qty > 0 ? 'long' : 'short';
    // Best close since the position opened, from revealed bars only.
    let best = tr.position.avgPrice;
    for (let i = this.bars.length - 1; i >= 0 && this.bars[i]!.time >= tr.openTrade.openTime; i--) {
      const c = this.bars[i]!.close;
      best = side === 'long' ? Math.max(best, c) : Math.min(best, c);
    }
    const want = managedStop(
      {
        breakEvenTicks: st.breakEvenTicks,
        breakEvenOffset: st.breakEvenOffset,
        trailTicks: st.trailTicks,
      },
      side,
      tr.position.avgPrice,
      stop.price!,
      best,
      this.meta.settings.tickSize,
    );
    if (want === null) return;
    // A stop on the wrong side of the last close would fill at once: leave it.
    if (side === 'long' ? want >= tr.lastClose : want <= tr.lastClose) return;
    await this.mutate(() => sessionsApi.modifyOrder(this.meta!.id, stop.id, { price: want }));
  }

  // ---------------------------------------------------------------- rewind / save points
  private async restore(state: SessionStateDto): Promise<boolean> {
    if (!this.meta || this.inFlight) return false;
    const generation = this.generation;
    this.pause();
    this.inFlight = true;
    try {
      const r = await sessionsApi.restoreState(this.meta.id, state);
      if (generation !== this.generation) return false;
      this.bars = r.bars;
      this.applyView(r);
      this.resetCharts();
      return true;
    } catch (err) {
      if (generation === this.generation) toast((err as Error).message, 'error');
      return false;
    } finally {
      if (generation === this.generation) this.inFlight = false;
    }
  }

  async rewind(): Promise<void> {
    if (this.blindHidden) return toast(t('v1.rewindBlind'));
    const prev = this.undo.pop();
    if (!prev) return toast(t('v1.rewindNone'));
    if (!(await this.restore(prev))) this.undo.push(prev);
  }

  private checkpointList: HTMLElement | undefined;
  private checkpointCard: HTMLElement | undefined;

  private addCheckpoint(): void {
    if (!this.meta || !this.state) return;
    if (this.blindHidden) return toast(t('v1.rewindBlind'));
    const n = (this.checkpoints.at(-1)?.n ?? 0) + 1;
    this.checkpoints = [
      ...this.checkpoints,
      { n, cursorTime: this.cursorTime, state: this.state },
    ].slice(-50);
    saveCheckpoints(this.meta.id, this.checkpoints);
    this.renderCheckpoints();
    toast(
      t('v1.checkpointSaved', {
        n,
        time: fmtTime(this.cursorTime, this.meta.settings.utcOffsetMinutes),
      }),
    );
  }

  private renderCheckpoints(): void {
    if (!this.checkpointList) return;
    const off = this.meta?.settings.utcOffsetMinutes ?? 0;
    if (!this.checkpoints.length) {
      this.checkpointList.replaceChildren(
        el('li', { class: 'muted small' }, t('v1.checkpointNone')),
      );
      return;
    }
    this.checkpointList.replaceChildren(
      ...[...this.checkpoints].reverse().map((cp) => {
        const go = el(
          'button',
          { type: 'button', class: 'small', 'data-testid': `cp-go-${cp.n}` },
          t('v1.checkpointRestore'),
        );
        go.addEventListener('click', async () => {
          if (this.state) this.undo.push(this.state);
          if (!(await this.restore(cp.state))) this.undo.pop();
        });
        const del = el(
          'button',
          { type: 'button', class: 'small ghost' },
          t('v1.checkpointDelete'),
        );
        del.addEventListener('click', () => {
          this.checkpoints = this.checkpoints.filter((x) => x.n !== cp.n);
          if (this.meta) saveCheckpoints(this.meta.id, this.checkpoints);
          this.renderCheckpoints();
        });
        const pnl = cp.state.trading.realizedPnl;
        return el(
          'li',
          {},
          el('span', { class: 'num' }, `#${cp.n} · ${fmtTime(cp.cursorTime, off)}`),
          el('span', { class: `num ${pnl > 0 ? 'up' : pnl < 0 ? 'down' : ''}` }, fmtMoney(pnl)),
          go,
          del,
        );
      }),
    );
  }

  private async flattenAll(): Promise<void> {
    if (!this.meta) return;
    if (this.inFlight) {
      toast(t('pr.busy'));
      return;
    }
    if (getSettings().confirmFlatten && !confirm(`${t('pr.flatten')}?`)) return;
    const generation = this.generation;
    this.inFlight = true;
    try {
      await this.mutate(() => sessionsApi.flatten(this.meta!.id));
    } finally {
      if (generation === this.generation) this.inFlight = false;
    }
  }

  /** First tap on the compact Flatten control only arms it; a second tap confirms. */
  private onFlattenTap(): void {
    const btn = this.flattenBtn;
    if (!btn) return;
    if (this.inFlight) {
      toast(t('pr.busy'));
      return;
    }
    if (btn.classList.contains('armed')) {
      this.disarmFlatten();
      void this.flattenAll();
      return;
    }
    btn.classList.add('armed');
    btn.textContent = t('v1.flattenConfirm');
    btn.setAttribute('aria-pressed', 'true');
    btn.setAttribute('aria-label', t('v1.flattenHint'));
    toast(t('v1.flattenHint'));
    clearTimeout(this.flattenArmTimer);
    this.flattenArmTimer = setTimeout(() => this.disarmFlatten(), FLATTEN_ARM_MS);
  }

  private disarmFlatten(): void {
    clearTimeout(this.flattenArmTimer);
    this.flattenArmTimer = undefined;
    const btn = this.flattenBtn;
    if (!btn) return;
    btn.classList.remove('armed');
    btn.textContent = t('v1.flatten');
    btn.setAttribute('aria-pressed', 'false');
    btn.removeAttribute('aria-label');
  }

  /** A tap anywhere except Flatten itself cancels an armed close. */
  private watchFlattenArm(): void {
    if (this.flattenWatchInstalled || typeof window === 'undefined') return;
    this.flattenWatchInstalled = true;
    window.addEventListener(
      'pointerdown',
      (e) => {
        const btn = this.flattenBtn;
        if (!btn?.classList.contains('armed')) return;
        const target = e.target;
        if (target instanceof Node && btn.contains(target)) return;
        this.disarmFlatten();
      },
      true,
    );
  }

  /** Active bottom tab, and the tall semi-auto layout only while that panel is open. */
  private bottomTab = '';
  private syncMacroOpen(): void {
    const on = this.bottomTab === 'macro' && !!this.bottom?.isExpanded;
    this.els.bottom?.classList.toggle('macro-open', on);
  }

  // ---------------------------------------------------------------- phone panels
  private sheetOpen = false;
  /** Rail drawer (phone / tablet portrait). Closes on a tap outside, Escape or its ✕. */
  private setSheet(on: boolean): void {
    this.sheetOpen = on;
    document.body.classList.toggle('sheet-open', on);
    this.els.sheetBtn?.setAttribute('aria-expanded', String(on));
    if (on)
      overlays.opened({
        id: 'sheet',
        contains: (n) => !!this.side?.root.contains(n) || !!this.els.sheetBtn?.contains(n),
        close: () => this.setSheet(false),
      });
    else overlays.closed('sheet');
  }

  /** Bottom panel opened from a tab: on phones it is an overlay that folds on an outside tap. */
  private bottomOpened(): void {
    if (!window.matchMedia?.('(max-width: 899px), (max-height: 520px)').matches) return;
    overlays.opened({
      id: 'bottom',
      contains: (n) => !!this.els.bottom?.contains(n),
      close: () => this.bottom?.setExpanded(false),
    });
  }

  // ---------------------------------------------------------------- compact trade bar (phone / tablet)
  private pnlChip: HTMLElement | undefined;
  private tradeQty: HTMLInputElement | undefined;
  private buildTradeBar(): HTMLElement {
    const qty = el('input', {
      type: 'number',
      min: '1',
      max: '10000',
      step: '1',
      value: String(getSettings().qtyPresets[0] ?? 1),
      inputmode: 'numeric',
      'aria-label': t('pr.qty'),
      'data-testid': 'tb-qty',
    });
    this.tradeQty = qty;
    const order = (side: 'buy' | 'sell') => {
      const q = Math.max(1, Math.floor(Number(qty.value) || 1));
      void this.side?.submitWith(side, q);
    };
    const buy = el(
      'button',
      { type: 'button', class: 'buy', 'data-testid': 'tb-buy' },
      t('pr.buy'),
    );
    buy.addEventListener('click', () => order('buy'));
    const sell = el(
      'button',
      { type: 'button', class: 'sell', 'data-testid': 'tb-sell' },
      t('pr.sell'),
    );
    sell.addEventListener('click', () => order('sell'));
    const flat = el(
      'button',
      { type: 'button', class: 'flat', 'data-testid': 'tb-flatten', 'aria-pressed': 'false' },
      t('v1.flatten'),
    );
    this.flattenBtn = flat;
    this.watchFlattenArm();
    flat.addEventListener('click', () => this.onFlattenTap());
    const back = el(
      'button',
      { type: 'button', 'aria-label': t('v1.rewind'), 'data-testid': 'tb-back' },
      '|◀',
    );
    back.addEventListener('click', () => void this.rewind());
    const next = el(
      'button',
      { type: 'button', 'aria-label': t('pr.step'), 'data-testid': 'tb-step' },
      '▶|',
    );
    next.addEventListener('click', () => void this.stepBars(1));
    const ten = el('button', { type: 'button', 'data-testid': 'tb-step10' }, '+10');
    ten.addEventListener('click', () => void this.stepBars(10));
    const playBtn = el(
      'button',
      {
        type: 'button',
        class: 'primary',
        'data-testid': 'tb-play',
        'aria-label': t('pr.play'),
        'aria-pressed': 'false',
      },
      '▶',
    );
    playBtn.addEventListener('click', () => (this.playing ? this.pause() : this.play()));
    this.els.tbPlay = playBtn;
    // Same row as Play: a second row steals the chart height the landscape fit depends on.
    const speed = this.bindSpeedSelect('tb-speed');
    return el(
      'div',
      { class: 'trade-bar', 'data-testid': 'trade-bar' },
      el('div', { class: 'tb-replay' }, back, playBtn, next, ten, speed),
      el(
        'div',
        { class: 'tb-order' },
        sell,
        qty,
        buy,
        el('span', { class: 'tb-sep', 'aria-hidden': 'true' }),
        flat,
      ),
    );
  }

  private renderPnl(): void {
    if (!this.state || !this.meta || !this.pnlChip) return;
    const tr = this.state.trading;
    const s = this.meta.settings;
    const open = tr.position
      ? (tr.lastClose - tr.position.avgPrice) * tr.position.qty * s.pointValue
      : 0;
    const total = tr.realizedPnl + open;
    const pos = tr.position ? `${tr.position.qty > 0 ? '+' : ''}${tr.position.qty}` : t('v1.flat');
    this.pnlChip.textContent = `${pos} · ${t('v1.pnl')} ${fmtMoney(total)}`;
    this.pnlChip.className = `pnl-chip num ${total > 0 ? 'up' : total < 0 ? 'down' : ''}`;
  }

  // ---------------------------------------------------------------- state
  private applyView(view: SessionViewDto): void {
    if (view.state.status !== 'active' && this.state?.status !== view.state.status) this.pause();
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

  /**
   * Source bars to advance `n` practice bars. With 10s data and a 1m practice timeframe,
   * "Next bar" must show the next *whole* 1m bar: if the current 1m bar is still forming it
   * is finished first, then `n` full bars follow. A market order placed now fills at the open
   * of the next 1m bar, so one press is enough to see the fill.
   * shortcut: assumes no missing source bars inside a practice bar (gaps make it land a few
   * bars early or late; the next press realigns), upgrade if real tick data has gaps.
   */
  private practiceSteps(n: number): number {
    const ptf = this.meta?.settings.practiceTimeframeSeconds;
    const last = this.bars.at(-1);
    if (!ptf || !last || ptf <= this.baseTf) return n;
    const perBar = Math.max(1, Math.round(ptf / this.baseTf));
    const inBar = Math.round(
      (last.time - bucketStart(last.time, ptf, this.aggOpts())) / this.baseTf,
    );
    const toClose = Math.max(0, perBar - 1 - inBar);
    return toClose + n * perBar;
  }

  /** Step `n` practice bars (the buttons, keys and play all count in practice bars). */
  async stepBars(n: number): Promise<void> {
    await this.step(this.practiceSteps(n));
  }

  async step(count: number): Promise<void> {
    if (!this.meta || this.inFlight) return;
    const generation = this.generation;
    this.inFlight = true;
    const before = this.state;
    try {
      const r = await sessionsApi.step(this.meta.id, count);
      if (generation !== this.generation) return;
      if (before && !this.blindHidden) this.pushUndoState(before);
      this.appendBars(r.revealed);
      this.applyView(r);
      if (r.revealed.length > 0) await this.manageStop();
      if (this.macroArmed && r.revealed.length > 0) await this.watchMacro();
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

  /** While playing, one undo point per play run (the state when Play was pressed). */
  private playUndoTaken = false;
  private pushUndoState(st: SessionStateDto): void {
    if (this.playing) {
      if (this.playUndoTaken) return;
      this.playUndoTaken = true;
    }
    this.undo.push(st);
    if (this.undo.length > MAX_UNDO) this.undo.shift();
  }

  play(): void {
    if (!this.meta || this.state?.status === 'finished') return;
    this.playUndoTaken = false;
    this.playing = true;
    this.carry = 0;
    this.timer = setInterval(() => {
      this.carry += (this.speed * TICK_MS) / 1000;
      const n = Math.floor(this.carry);
      if (n < 1 || this.inFlight) return;
      // Speed is practice bars per second (one 1m bar on 10s data), like Next and +10.
      // An armed watch checks every closed practice bar, so it advances one per tick.
      const bars = this.macroArmed ? 1 : n;
      this.carry -= bars;
      // The step route accepts at most 5000 source bars per call.
      void this.step(Math.min(this.practiceSteps(bars), 5000));
    }, TICK_MS);
    this.renderPlay();
  }

  pause(): void {
    this.playing = false;
    clearInterval(this.timer);
    this.renderPlay();
  }

  private renderPlay(): void {
    const label = t(this.playing ? 'pr.pause' : 'pr.play');
    const b = this.els.play;
    if (b) {
      b.dataset.i18n = this.playing ? 'pr.pause' : 'pr.play';
      b.textContent = label;
      b.setAttribute('aria-pressed', String(this.playing));
    }
    const tb = this.els.tbPlay;
    if (tb) {
      // Pause bars while playing, play triangle when stopped; the label says the same.
      tb.textContent = this.playing ? '❚❚' : '▶';
      tb.setAttribute('aria-label', label);
      tb.setAttribute('aria-pressed', String(this.playing));
      tb.classList.toggle('playing', this.playing);
    }
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
    // Ghost bracket: where the ticket's stop / target would go for a buy (flat only).
    const ghost = getSettings().previewBracket && !tr.position ? this.side?.previewBracket() : null;
    if (ghost) {
      if (ghost.stopLoss !== null)
        lines.push({
          price: ghost.stopLoss,
          color: withAlpha(theme.down, 0.55),
          title: 'SL?',
          dashed: true,
        });
      if (ghost.takeProfit !== null)
        lines.push({
          price: ghost.takeProfit,
          color: withAlpha(theme.up, 0.55),
          title: 'TP?',
          dashed: true,
        });
    }
    for (const p of this.panes) {
      const markers: MarkerSpec[] = tr.fills.map((f) => ({
        time: this.snap(p, f.time),
        side: f.side,
        // Short label keeps candles readable; the fill price is on the Fills tab.
        text: `${f.side === 'buy' ? 'B' : 'S'}${f.qty}`,
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
    this.els.summary?.setAttribute('aria-label', t('summary.title'));
    this.summary?.update(this.meta.settings, this.state, this.meta.id);
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
    this.renderDrawings();
    // Ticket first: the chart's bracket preview reads the ticket's current last close.
    this.side?.render(this.meta.settings, this.state);
    this.decorate();
    this.rulesView?.render(this.engineSettings(), this.state, this.cursorTime);
    this.renderPnl();
    const back = this.els.back as HTMLButtonElement | undefined;
    if (back) back.disabled = this.blindHidden || this.undo.length === 0;
    const cp = this.els.saveCp as HTMLButtonElement | undefined;
    if (cp) cp.hidden = this.blindHidden;
    const macroBlind = this.els.macroBlind;
    if (macroBlind) macroBlind.hidden = !this.blindHidden;
    for (const p of this.panes) if (p.macroBtn) p.macroBtn.hidden = this.blindHidden;
    this.bottom?.setTabHidden('macro', this.blindHidden);
    this.macroPanel?.sync(this.blindHidden, getLang());
    this.bottom?.render(this.meta.settings, this.state, this.meta.id);
    this.onChanged();
  }

  applyTheme(): void {
    for (const p of this.panes) {
      p.chart.applyTheme();
    }
    this.resetCharts();
  }

  private bindSpeedSelect(testid: 'speed' | 'tb-speed'): HTMLSelectElement {
    const speed = el('select', { 'aria-label': t('pr.speed'), 'data-testid': testid });
    if (testid === 'tb-speed') speed.className = 'tb-speed';
    for (const s of SPEEDS) speed.append(el('option', { value: String(s) }, `${s}×/s`));
    speed.value = String(this.speed);
    speed.addEventListener('change', () => this.setSpeed(Number(speed.value)));
    this.speedSelects.push(speed);
    return speed;
  }

  private setSpeed(next: number): void {
    if (!SPEEDS.includes(next)) return;
    this.speed = next;
    const value = String(next);
    for (const sel of this.speedSelects) sel.value = value;
    rememberPlaybackSpeed(next);
  }

  private setSpeedIndex(delta: number): void {
    const i = SPEEDS.indexOf(this.speed);
    const base = i < 0 ? SPEEDS.indexOf(1) : i;
    this.setSpeed(SPEEDS[Math.min(Math.max(base + delta, 0), SPEEDS.length - 1)]!);
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
      if (this.drawMode !== null) this.setDrawMode(null);
      else for (const p of this.palettes) p.collapse();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const sel = this.panes.map((p) => p.chart.selectedDrawing).find((x) => x !== null);
      if (sel) this.deleteDrawing(sel);
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const action = hotkeyAction(e.key, getSettings().keys);
    if (!action) return;
    e.preventDefault();
    if (action === 'play') {
      if (this.playing) this.pause();
      else this.play();
    } else if (action === 'step') void this.stepBars(e.shiftKey ? 10 : 1);
    else if (action === 'back') void this.rewind();
    else if (action === 'checkpoint') this.addCheckpoint();
    else if (action === 'buy') void this.side?.submit('buy');
    else if (action === 'sell') void this.side?.submit('sell');
    else if (action === 'flatten') {
      if (this.meta && this.state?.status !== 'finished') void this.flattenAll();
    } else if (action === 'slower') this.setSpeedIndex(-1);
    else if (action === 'faster') this.setSpeedIndex(1);
  }
}
