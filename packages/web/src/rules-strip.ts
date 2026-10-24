// SPDX-License-Identifier: AGPL-3.0-or-later
// Thin practice-rules strip above the chart. Daily loss, target, and trailing stay
// visible while trading. The strip docks under the toolbar, collapses to a chip,
// and can be dragged without covering the OHLC legend or the order ticket.

import {
  ruleStatus,
  sessionEquity,
  trailingFloor,
  trailingPeak,
  type SessionSettings,
  type SessionState,
  type TrailingDrawdownMode,
} from '@candledrill/core';
import { el, fmtMoney } from './format.js';
import { t, type MessageKey } from './i18n.js';

export const RULES_STRIP_COLLAPSED_KEY = 'candledrill.rulesStrip.collapsed';
export const RULES_STRIP_POS_KEY = 'candledrill.rulesStrip.pos';

/** Phone landscape and other short windows. The docked strip becomes a chip there. */
export const RULES_STRIP_SHORT_QUERY = '(max-height: 560px)';

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface StripPos {
  readonly x: number;
  readonly y: number;
}

export interface GlanceFact {
  readonly label: MessageKey;
  readonly amount: number;
}

export interface GlanceMetric {
  readonly id: 'dailyLoss' | 'trailing' | 'target';
  readonly label: MessageKey;
  readonly frac: number | null;
  readonly limit: number | null;
  /** Limit rules turn hot as they approach the cap. The profit target does not. */
  readonly hot: boolean;
  readonly goal: boolean;
  /** Shown on the strip itself (breach line and room left). */
  readonly line: readonly GlanceFact[];
  /** Peak and the mode note, available on hover so the row stays one line tall. */
  readonly title: readonly GlanceFact[];
  readonly note: MessageKey | null;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function browserStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readRulesStripCollapsed(storage: StorageLike | null = browserStorage()): boolean {
  return storage?.getItem(RULES_STRIP_COLLAPSED_KEY) === '1';
}

export function writeRulesStripCollapsed(
  on: boolean,
  storage: StorageLike | null = browserStorage(),
): void {
  storage?.setItem(RULES_STRIP_COLLAPSED_KEY, on ? '1' : '0');
}

export function readRulesStripPos(storage: StorageLike | null = browserStorage()): StripPos | null {
  const raw = storage?.getItem(RULES_STRIP_POS_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { x?: unknown; y?: unknown };
    if (typeof v.x !== 'number' || typeof v.y !== 'number') return null;
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) return null;
    return { x: v.x, y: v.y };
  } catch {
    return null;
  }
}

export function writeRulesStripPos(
  pos: StripPos | null,
  storage: StorageLike | null = browserStorage(),
): void {
  if (!storage) return;
  if (!pos) storage.removeItem(RULES_STRIP_POS_KEY);
  else storage.setItem(RULES_STRIP_POS_KEY, JSON.stringify({ x: pos.x, y: pos.y }));
}

export function boxesIntersect(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Slide `box` so it lies inside `bounds`. Size shrinks only when the box is larger than the bounds. */
export function clampBox(box: Box, bounds: Box): Box {
  const w = Math.min(box.w, Math.max(0, bounds.w));
  const h = Math.min(box.h, Math.max(0, bounds.h));
  const x = Math.min(Math.max(box.x, bounds.x), bounds.x + Math.max(0, bounds.w - w));
  const y = Math.min(Math.max(box.y, bounds.y), bounds.y + Math.max(0, bounds.h - h));
  return { x, y, w, h };
}

export function stripFits(box: Box, bounds: Box, obstacles: readonly Box[]): boolean {
  if (box.w > bounds.w + 0.5 || box.h > bounds.h + 0.5) return false;
  if (box.x < bounds.x - 0.5 || box.y < bounds.y - 0.5) return false;
  if (box.x + box.w > bounds.x + bounds.w + 0.5) return false;
  if (box.y + box.h > bounds.y + bounds.h + 0.5) return false;
  return !obstacles.some((o) => o.w > 0 && o.h > 0 && boxesIntersect(box, o));
}

/**
 * A dragged strip position. The proposal wins when it stays inside `bounds` and misses
 * every obstacle (OHLC legend, order ticket). Otherwise the previous legal box is kept.
 */
export function resolveStripBox(
  proposed: Box,
  previous: Box | null,
  bounds: Box,
  obstacles: readonly Box[],
): Box | null {
  const next = clampBox(proposed, bounds);
  if (stripFits(next, bounds, obstacles)) return next;
  if (previous && stripFits(previous, bounds, obstacles)) return previous;
  return null;
}

/** Near the dock slot: drop the floating position and return to the flow above the chart. */
export function shouldRedock(left: number, top: number): boolean {
  return left <= 12 && top <= 12;
}

function trailingCopy(mode: TrailingDrawdownMode): { label: MessageKey; note: MessageKey } {
  switch (mode) {
    case 'eod':
      return { label: 'pr.trailingEod', note: 'pr.drawdownNoteEod' };
    case 'intraday':
      return { label: 'pr.trailingIntraday', note: 'pr.drawdownNoteIntraday' };
    case 'static':
      return { label: 'pr.trailingStatic', note: 'pr.drawdownNoteStatic' };
    case 'close':
      return { label: 'pr.trailingClose', note: 'pr.drawdownNote' };
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

/** Glance metrics for the strip. Empty when this session has no practice rules. */
export function practiceGlance(settings: SessionSettings, state: SessionState): GlanceMetric[] {
  const rs = ruleStatus(settings, state);
  const metrics: GlanceMetric[] = [];
  const push = (
    id: GlanceMetric['id'],
    label: MessageKey,
    frac: number | null,
    limit: number | null,
    goal: boolean,
    line: GlanceFact[] = [],
    title: GlanceFact[] = [],
    note: MessageKey | null = null,
  ) => {
    if (frac === null || limit === null) return;
    metrics.push({
      id,
      label,
      frac,
      limit,
      hot: !goal && frac >= 0.8,
      goal,
      line,
      title,
      note,
    });
  };
  push('dailyLoss', 'pr.dailyLoss', rs.dailyLossUsed, settings.dailyLossLimit, false);
  if (settings.trailingDrawdown !== null && rs.trailingUsed !== null) {
    const copy = trailingCopy(settings.trailingDrawdownMode);
    const peak = trailingPeak(settings, state);
    const floor = trailingFloor(settings, state) ?? peak - settings.trailingDrawdown;
    const equity = sessionEquity(settings, state);
    push(
      'trailing',
      copy.label,
      rs.trailingUsed,
      settings.trailingDrawdown,
      false,
      [
        { label: 'pr.ddFloor', amount: floor },
        { label: 'pr.ddBuffer', amount: equity - floor },
      ],
      [
        { label: 'pr.ddPeak', amount: peak },
        { label: 'pr.ddCurrent', amount: Math.max(0, peak - equity) },
      ],
      copy.note,
    );
  }
  push('target', 'pr.target', rs.targetProgress, settings.profitTarget, true);
  return metrics;
}

const OBSTACLE_PAD = 4;

function boxOf(node: Element, pad = 0): Box | null {
  const r = node.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return null;
  return { x: r.left - pad, y: r.top - pad, w: r.width + pad * 2, h: r.height + pad * 2 };
}

/**
 * Practice-rules strip. Docked, it sits in flow at the top of the chart column
 * (below the toolbar, above the candles). On a short window (max-height 560px)
 * the docked strip stays a narrow chip so it does not cover the chart head.
 * Dragging floats it inside that column and refuses positions that cover the
 * OHLC legend or the order ticket.
 */
export class RulesStrip {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private readonly grip: HTMLButtonElement;
  private readonly toggle: HTMLButtonElement;
  private collapsed: boolean;
  private pos: StripPos | null;
  private drag: {
    pointerId: number;
    originX: number;
    originY: number;
    left: number;
    top: number;
    moved: boolean;
  } | null = null;

  constructor(private readonly host: HTMLElement) {
    this.collapsed = readRulesStripCollapsed();
    this.pos = readRulesStripPos();
    this.body = el('div', {
      class: 'rules-strip-body',
      'data-testid': 'rules',
      'data-i18n-title': 'pr.rulesBar',
      title: t('pr.rulesBar'),
    });
    this.grip = el(
      'button',
      {
        type: 'button',
        class: 'rules-strip-grip',
        'data-testid': 'rules-strip-drag',
        'data-i18n-aria': 'pr.rulesDrag',
        'aria-label': t('pr.rulesDrag'),
      },
      '⠿',
    );
    this.toggle = el('button', {
      type: 'button',
      class: 'rules-strip-toggle',
      'data-testid': 'rules-strip-toggle',
    });
    this.el = el(
      'section',
      {
        class: 'rules-strip',
        'data-testid': 'rules-strip',
        'data-i18n-aria': 'pr.rules',
        'aria-label': t('pr.rules'),
      },
      this.grip,
      this.body,
      this.toggle,
    );
    this.grip.addEventListener('pointerdown', (ev) => this.onPointerDown(ev));
    this.grip.addEventListener('pointermove', (ev) => this.onPointerMove(ev));
    this.grip.addEventListener('pointerup', (ev) => this.onPointerUp(ev));
    this.grip.addEventListener('pointercancel', (ev) => this.onPointerUp(ev));
    this.grip.addEventListener('dblclick', () => this.dock());
    this.toggle.addEventListener('click', () => {
      // A short window keeps the strip as a chip, docked or floating. Expanding
      // it would paint the metrics over Semi-auto, Indicators, and the OHLC legend.
      if (this.shortViewport()) return;
      this.setCollapsed(!this.collapsed);
    });
    if (this.pos) {
      this.el.classList.add('floating');
      this.el.style.left = `${this.pos.x}px`;
      this.el.style.top = `${this.pos.y}px`;
    } else this.el.classList.add('docked');
    this.paintToggle();
    this.host.append(this.el);
    window.addEventListener('resize', this.onResize);
    requestAnimationFrame(() => this.reclamp());
  }

  /** Short window: fold to a chip. Not written to the saved collapse preference. */
  private shortViewport(): boolean {
    return window.matchMedia(RULES_STRIP_SHORT_QUERY).matches;
  }

  private readonly onResize = (): void => {
    // Fold or expand before measuring. Reclamping the stale size docks a float
    // the chip would still fit, or leaves an expanded strip on the OHLC legend.
    this.paintToggle();
    this.reclamp();
  };

  destroy(): void {
    window.removeEventListener('resize', this.onResize);
    this.el.remove();
  }

  render(settings: SessionSettings, state: SessionState): void {
    const metrics = practiceGlance(settings, state);
    if (metrics.length === 0) {
      this.body.replaceChildren(
        el('p', { class: 'muted rules-strip-empty', 'data-i18n': 'pr.noRules' }, t('pr.noRules')),
      );
    } else {
      this.body.replaceChildren(
        ...metrics.map((m) => {
          const pct = Math.min(100, Math.max(0, (m.frac ?? 0) * 100));
          const title = [
            ...m.title.map((f) => `${t(f.label)} ${fmtMoney(f.amount)}`),
            m.note ? t(m.note) : '',
          ]
            .filter(Boolean)
            .join(' · ');
          const meter = el(
            'span',
            {
              class: 'meter',
              role: 'meter',
              'aria-valuemin': '0',
              'aria-valuemax': '100',
              'aria-valuenow': pct.toFixed(0),
              'aria-label': t(m.label),
            },
            el('span', { style: `width:${pct.toFixed(1)}%` }),
          );
          return el(
            'span',
            {
              class: `rules-metric${m.hot ? ' hot' : ''}${m.goal ? ' goal' : ''}`,
              'data-metric': m.id,
              ...(title ? { title } : {}),
            },
            el('span', { class: 'k' }, t(m.label)),
            el('span', { class: 'v num' }, `${pct.toFixed(0)}% · ${fmtMoney(m.limit)}`),
            ...m.line.map((f) =>
              el('span', { class: 'v num fact' }, `${t(f.label)} ${fmtMoney(f.amount)}`),
            ),
            meter,
          );
        }),
      );
    }
    this.paintToggle();
    if (!this.drag) this.reclamp();
  }

  private paintToggle(): void {
    const short = this.shortViewport();
    this.el.classList.toggle('is-short-chip', short && this.pos === null);
    const folded = this.collapsed || short;
    this.el.classList.toggle('is-collapsed', folded);
    this.body.hidden = folded;
    this.toggle.setAttribute('aria-expanded', String(!folded));
    this.toggle.setAttribute('aria-label', t('pr.rulesToggle'));
    this.toggle.textContent = folded ? t('pr.rules') : '▾';
  }

  private setCollapsed(on: boolean): void {
    this.collapsed = on;
    writeRulesStripCollapsed(on);
    this.paintToggle();
    this.reclamp();
  }

  private hostBox(): Box {
    const r = this.host.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }

  /** OHLC legends in this column, plus the ticket and the compact order row wherever they are. */
  private obstacles(): Box[] {
    const out: Box[] = [];
    const push = (node: Element | null) => {
      const b = node ? boxOf(node, OBSTACLE_PAD) : null;
      if (b) out.push(b);
    };
    this.host.querySelectorAll('[data-testid="ohlc-legend"]').forEach((n) => push(n));
    document.querySelectorAll('[data-testid="order-ticket"]').forEach((n) => push(n));
    document.querySelectorAll('.tb-order').forEach((n) => push(n));
    return out;
  }

  private reclamp(): void {
    if (this.pos === null) return;
    const host = this.hostBox();
    if (host.w < 8 || host.h < 8) return;
    const rect = this.el.getBoundingClientRect();
    const proposed = {
      x: host.x + this.pos.x,
      y: host.y + this.pos.y,
      w: rect.width,
      h: rect.height,
    };
    const resolved = resolveStripBox(proposed, null, host, this.obstacles());
    if (!resolved) {
      this.dock();
      return;
    }
    this.applyFloat(resolved.x - host.x, resolved.y - host.y, true);
  }

  private applyFloat(left: number, top: number, persist: boolean): void {
    this.pos = { x: left, y: top };
    this.el.classList.add('floating');
    this.el.classList.remove('docked');
    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
    if (persist) writeRulesStripPos(this.pos);
    this.paintToggle();
  }

  private dock(): void {
    this.pos = null;
    this.drag = null;
    this.el.classList.remove('floating');
    this.el.classList.add('docked');
    this.el.style.left = '';
    this.el.style.top = '';
    writeRulesStripPos(null);
    this.paintToggle();
  }

  private onPointerDown(ev: PointerEvent): void {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const host = this.hostBox();
    const rect = this.el.getBoundingClientRect();
    this.drag = {
      pointerId: ev.pointerId,
      originX: ev.clientX,
      originY: ev.clientY,
      left: this.pos ? this.pos.x : rect.left - host.x,
      top: this.pos ? this.pos.y : rect.top - host.y,
      moved: false,
    };
    this.grip.setPointerCapture(ev.pointerId);
  }

  private onPointerMove(ev: PointerEvent): void {
    const d = this.drag;
    if (!d || ev.pointerId !== d.pointerId) return;
    const dx = ev.clientX - d.originX;
    const dy = ev.clientY - d.originY;
    if (!d.moved) {
      if (dx * dx + dy * dy < 16) return;
      d.moved = true;
      if (this.pos === null) {
        const before = this.el.getBoundingClientRect();
        const hostNow = this.host.getBoundingClientRect();
        d.left = before.left - hostNow.left;
        d.top = before.top - hostNow.top;
        this.applyFloat(d.left, d.top, false);
      }
    }
    const host = this.hostBox();
    const rect = this.el.getBoundingClientRect();
    const proposed = {
      x: host.x + d.left + dx,
      y: host.y + d.top + dy,
      w: rect.width,
      h: rect.height,
    };
    const previous =
      this.pos === null
        ? null
        : { x: host.x + this.pos.x, y: host.y + this.pos.y, w: rect.width, h: rect.height };
    const resolved = resolveStripBox(proposed, previous, host, this.obstacles());
    if (!resolved) return;
    this.applyFloat(resolved.x - host.x, resolved.y - host.y, false);
  }

  private onPointerUp(ev: PointerEvent): void {
    const d = this.drag;
    if (!d || ev.pointerId !== d.pointerId) return;
    this.drag = null;
    if (!d.moved || !this.pos) return;
    if (shouldRedock(this.pos.x, this.pos.y)) this.dock();
    else this.reclamp();
  }
}
