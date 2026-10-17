// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Indicator catalog: typeahead search, category chips, and a free-form instance list.
// The panel shell keeps data-testid="indicator-panel".

import { t, type MessageKey } from './i18n.js';
import { el } from './format.js';
import {
  catalogPlacement,
  filterCatalog,
  instanceFromCatalog,
  type IndicatorCategory,
} from './indicator-catalog.js';
import {
  MAX_VISIBLE_OVERLAYS,
  createIndicator,
  isOverlayKind,
  loadIndicatorConfig,
  saveIndicatorConfig,
  visibleOverlayCount,
  type IndicatorKind,
  type IndicatorSetting,
  type PaneIndicatorConfig,
} from './indicator-prefs.js';
import type { IndicatorSource } from './indicators.js';

export type IndicatorChangeHandler = (cfg: PaneIndicatorConfig) => void;

const SOURCE_OPTIONS: IndicatorSource[] = ['open', 'high', 'low', 'close', 'hlc3'];
const CATEGORIES: (IndicatorCategory | 'all')[] = [
  'all',
  'trend',
  'volatility',
  'momentum',
  'volume',
  'session',
];

const KIND_KEY: Record<IndicatorKind, MessageKey> = {
  volume: 'ind.volume',
  sma: 'ind.sma',
  ema: 'ind.ema',
  bollinger: 'ind.bollinger',
  vwap: 'ind.vwap',
  orb: 'ind.orb',
  donchian: 'ind.donchian',
  rsi: 'ind.rsi',
  macd: 'ind.macd',
  atr: 'ind.atr',
  stochastic: 'ind.stochastic',
  adx: 'ind.adx',
};

export class IndicatorPanel {
  private root: HTMLElement | undefined;
  private cfg: PaneIndicatorConfig;
  private clickOutside: ((e: MouseEvent) => void) | undefined;
  private query = '';
  private category: IndicatorCategory | 'all' = 'all';
  private limitNote = '';

  constructor(
    private readonly anchor: HTMLElement,
    private readonly onChange: IndicatorChangeHandler,
  ) {
    this.cfg = loadIndicatorConfig();
  }

  isOpen(): boolean {
    return this.root !== undefined;
  }

  toggle(): void {
    if (this.isOpen()) this.close();
    else this.open();
  }

  open(): void {
    this.close();
    this.cfg = loadIndicatorConfig();
    this.root = el('div', { class: 'indicator-panel', 'data-testid': 'indicator-panel' });
    this.render();
    this.anchor.append(this.root);
    this.clickOutside = (e: MouseEvent) => {
      if (!this.root) return;
      const target = e.target as Node;
      if (this.root.contains(target)) return;
      if (this.anchor.contains(target)) return;
      this.close();
    };
    document.addEventListener('click', this.clickOutside, true);
  }

  close(): void {
    if (this.clickOutside) {
      document.removeEventListener('click', this.clickOutside, true);
      this.clickOutside = undefined;
    }
    this.root?.remove();
    this.root = undefined;
  }

  private commit(): void {
    saveIndicatorConfig(this.cfg);
    this.cfg = loadIndicatorConfig();
    this.render();
    this.onChange(this.cfg);
  }

  private render(): void {
    if (!this.root) return;
    const search = el('input', {
      type: 'search',
      class: 'ind-search',
      placeholder: t('ind.search'),
      value: this.query,
      'data-testid': 'indicator-search',
      'aria-label': t('ind.search'),
    }) as HTMLInputElement;
    search.addEventListener('input', () => {
      this.query = search.value;
      this.render();
      const next = this.root?.querySelector<HTMLInputElement>('[data-testid=indicator-search]');
      next?.focus();
      if (next) next.setSelectionRange(next.value.length, next.value.length);
    });
    const chips = el('div', { class: 'ind-chips' });
    for (const cat of CATEGORIES) {
      const b = el(
        'button',
        {
          type: 'button',
          class: `ind-chip${this.category === cat ? ' on' : ''}`,
          'data-testid': `ind-cat-${cat}`,
        },
        t(`ind.cat.${cat}` as MessageKey),
      );
      b.addEventListener('click', () => {
        this.category = cat;
        this.render();
      });
      chips.append(b);
    }
    this.root.replaceChildren(
      el('h4', {}, t('pr.indicators')),
      search,
      chips,
      this.renderCatalog(),
      el('h5', {}, t('ind.active')),
      this.renderActive(),
      this.renderQuick(),
    );
    if (this.limitNote) {
      this.root.append(el('p', { class: 'muted small' }, this.limitNote));
    }
  }

  private renderCatalog(): HTMLElement {
    const box = el('div', { class: 'ind-catalog', 'data-testid': 'indicator-catalog' });
    const show = this.query.trim() !== '' || this.category !== 'all';
    if (!show) {
      box.append(el('p', { class: 'muted small' }, t('ind.searchHint')));
      return box;
    }
    const hits = filterCatalog(this.query, this.category).slice(0, 8);
    if (hits.length === 0) {
      box.append(el('p', { class: 'muted small' }, t('ind.emptySearch')));
      return box;
    }
    for (const item of hits) {
      const add = el(
        'button',
        { type: 'button', class: 'small', 'data-testid': `indicator-add-${item.kind}` },
        t('ind.add'),
      );
      add.addEventListener('click', () => this.add(item.kind));
      const row = el('div', { class: 'catalog-hit' }, el('span', {}, t(KIND_KEY[item.kind])), add);
      box.append(row);
    }
    return box;
  }

  private add(kind: IndicatorKind): void {
    this.limitNote = '';
    if (kind === 'volume') {
      const existing = this.cfg.overlays.find((o) => o.kind === 'volume');
      if (existing) {
        existing.visible = true;
        this.commit();
        return;
      }
    }
    const drafted = instanceFromCatalog(kind, this.query);
    const patch: Partial<IndicatorSetting> = { visible: true, color: drafted.color ?? '#7cc4ff' };
    if (drafted.period !== undefined) patch.period = drafted.period;
    if (drafted.minutes !== undefined) patch.minutes = drafted.minutes;
    if (drafted.stdDev !== undefined) patch.stdDev = drafted.stdDev;
    if (drafted.fast !== undefined) patch.fast = drafted.fast;
    if (drafted.slow !== undefined) patch.slow = drafted.slow;
    if (drafted.signal !== undefined) patch.signal = drafted.signal;
    if (drafted.source !== undefined) patch.source = drafted.source;
    const inst = createIndicator(kind, patch);
    if (
      isOverlayKind(kind) &&
      kind !== 'volume' &&
      visibleOverlayCount(this.cfg) >= MAX_VISIBLE_OVERLAYS
    ) {
      inst.visible = false;
      this.limitNote = t('ind.limit');
    }
    if (catalogPlacement(kind) === 'overlay') this.cfg.overlays.push(inst);
    else this.cfg.panes.push(inst);
    this.commit();
  }

  private renderActive(): HTMLElement {
    const g = el('div', { class: 'indicator-group' });
    const all = [...this.cfg.overlays, ...this.cfg.panes];
    for (const s of all) g.append(this.renderRow(s));
    return g;
  }

  private renderRow(s: IndicatorSetting): HTMLElement {
    const row = el('label', { class: 'indicator-row' });
    const box = el('input', { type: 'checkbox' }) as HTMLInputElement;
    box.checked = s.visible;
    box.addEventListener('change', () => {
      if (box.checked && s.kind !== 'volume' && isOverlayKind(s.kind)) {
        const others = visibleOverlayCount({
          overlays: this.cfg.overlays.filter((o) => o.id !== s.id),
          panes: this.cfg.panes,
        });
        if (others >= MAX_VISIBLE_OVERLAYS) {
          box.checked = false;
          this.limitNote = t('ind.limit');
          this.render();
          return;
        }
      }
      s.visible = box.checked;
      this.limitNote = '';
      this.commit();
    });
    row.append(box, el('span', {}, this.rowLabel(s)));
    if (s.visible && s.kind !== 'volume') row.append(this.renderControls(s));
    const remove = el(
      'button',
      { type: 'button', class: 'small ghost', 'data-testid': `indicator-remove-${s.id}` },
      t('ind.remove'),
    );
    remove.addEventListener('click', (e) => {
      e.preventDefault();
      this.cfg.overlays = this.cfg.overlays.filter((o) => o.id !== s.id);
      this.cfg.panes = this.cfg.panes.filter((o) => o.id !== s.id);
      this.commit();
    });
    row.append(remove);
    return row;
  }

  private rowLabel(s: IndicatorSetting): string {
    const name = t(KIND_KEY[s.kind]);
    if ((s.kind === 'sma' || s.kind === 'ema' || s.kind === 'donchian') && s.period) {
      return `${name} ${s.period}`;
    }
    if (s.kind === 'orb') return `${name} ${s.minutes ?? 30}`;
    return name;
  }

  private renderControls(s: IndicatorSetting): HTMLElement {
    const wrap = el('div', { class: 'indicator-controls' });
    if (s.kind === 'orb') {
      wrap.append(
        this.numControl(t('ind.minutes'), s.minutes ?? 30, (v) => {
          s.minutes = v;
          this.commit();
        }),
      );
    } else if (s.period !== undefined && s.kind !== 'macd') {
      wrap.append(
        this.numControl(
          t(s.kind === 'stochastic' ? 'ind.kPeriod' : 'ind.period'),
          s.period,
          (v) => {
            s.period = v;
            this.commit();
          },
        ),
      );
    }
    if (s.kind !== 'orb' && s.kind !== 'donchian' && s.kind !== 'adx' && s.source !== undefined) {
      const sel = el('select', {}) as HTMLSelectElement;
      for (const src of SOURCE_OPTIONS) {
        sel.append(
          el(
            'option',
            s.source === src ? { value: src, selected: 'selected' } : { value: src },
            src,
          ),
        );
      }
      sel.addEventListener('change', () => {
        s.source = sel.value as IndicatorSource;
        this.commit();
      });
      wrap.append(el('label', { class: 'ind-ctrl' }, t('ind.source'), sel));
    }
    if (s.kind === 'bollinger' && s.stdDev !== undefined) {
      wrap.append(
        this.numControl(t('ind.stdDev'), s.stdDev, (v) => {
          s.stdDev = v;
          this.commit();
        }),
      );
    }
    if (s.kind === 'macd') {
      wrap.append(
        this.numControl(t('ind.fast'), s.fast ?? 12, (v) => {
          s.fast = v;
          this.commit();
        }),
        this.numControl(t('ind.slow'), s.slow ?? 26, (v) => {
          s.slow = v;
          this.commit();
        }),
        this.numControl(t('ind.signal'), s.signal ?? 9, (v) => {
          s.signal = v;
          this.commit();
        }),
      );
    }
    if (s.kind === 'stochastic') {
      wrap.append(
        this.numControl(t('ind.smooth'), s.fast ?? 3, (v) => {
          s.fast = v;
          this.commit();
        }),
        this.numControl(t('ind.dPeriod'), s.signal ?? 3, (v) => {
          s.signal = v;
          this.commit();
        }),
      );
    }
    const color = el('input', {
      type: 'color',
      value: s.color ?? '#888888',
      'data-testid': `ind-color-${s.id}`,
    }) as HTMLInputElement;
    color.addEventListener('input', () => {
      s.color = color.value;
      saveIndicatorConfig(this.cfg);
      this.onChange(this.cfg);
    });
    wrap.append(el('label', { class: 'ind-ctrl' }, t('ind.color'), color));
    return wrap;
  }

  private renderQuick(): HTMLElement {
    const details = el('details', { class: 'ind-quick' });
    details.append(el('summary', {}, t('ind.quick')));
    const volume = this.cfg.overlays.find((o) => o.kind === 'volume');
    const sma20 = this.cfg.overlays.find((o) => o.id === 'def-sma-20');
    const row = (label: string, setting: IndicatorSetting | undefined) => {
      if (!setting) return;
      const box = el('input', { type: 'checkbox' }) as HTMLInputElement;
      box.checked = setting.visible;
      box.addEventListener('change', () => {
        setting.visible = box.checked;
        this.commit();
      });
      details.append(el('label', { class: 'indicator-row' }, box, el('span', {}, label)));
    };
    row(t('ind.volume'), volume);
    row(`${t('ind.sma')} 20`, sma20);
    return details;
  }

  private numControl(label: string, value: number, set: (v: number) => void): HTMLElement {
    const input = el('input', {
      type: 'number',
      min: '1',
      step: '1',
      value: String(value),
    }) as HTMLInputElement;
    input.addEventListener('change', () => {
      const v = Number(input.value);
      if (Number.isFinite(v) && v > 0) set(Math.floor(v));
    });
    return el('label', { class: 'ind-ctrl' }, label, input);
  }
}
