// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Indicator catalog: typeahead search, category chips, and a free-form instance list.
// The panel shell keeps data-testid="indicator-panel".

import * as overlays from './overlays.js';
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
  keltner: 'ind.keltner',
  ichimoku: 'ind.ichimoku',
  supertrend: 'ind.supertrend',
  sar: 'ind.sar',
  zigzag: 'ind.zigzag',
  envelope: 'ind.envelope',
  dema: 'ind.dema',
  tema: 'ind.tema',
  wma: 'ind.wma',
  hull: 'ind.hull',
  vwma: 'ind.vwma',
  vwapBands: 'ind.vwapBands',
  stderr: 'ind.stderr',
  priceChannel: 'ind.priceChannel',
  cci: 'ind.cci',
  obv: 'ind.obv',
  cmf: 'ind.cmf',
  williams: 'ind.williams',
  ao: 'ind.ao',
  momentum: 'ind.momentum',
  roc: 'ind.roc',
  aroon: 'ind.aroon',
  bop: 'ind.bop',
  kdj: 'ind.kdj',
  elder: 'ind.elder',
};

const DESC_KEY: Partial<Record<IndicatorKind, MessageKey>> = {
  keltner: 'ind.keltnerDesc',
  ichimoku: 'ind.ichimokuDesc',
  supertrend: 'ind.supertrendDesc',
  sar: 'ind.sarDesc',
  zigzag: 'ind.zigzagDesc',
  envelope: 'ind.envelopeDesc',
  dema: 'ind.demaDesc',
  tema: 'ind.temaDesc',
  wma: 'ind.wmaDesc',
  hull: 'ind.hullDesc',
  vwma: 'ind.vwmaDesc',
  vwapBands: 'ind.vwapBandsDesc',
  stderr: 'ind.stderrDesc',
  priceChannel: 'ind.priceChannelDesc',
  cci: 'ind.cciDesc',
  obv: 'ind.obvDesc',
  cmf: 'ind.cmfDesc',
  williams: 'ind.williamsDesc',
  ao: 'ind.aoDesc',
  momentum: 'ind.momentumDesc',
  roc: 'ind.rocDesc',
  aroon: 'ind.aroonDesc',
  bop: 'ind.bopDesc',
  kdj: 'ind.kdjDesc',
  elder: 'ind.elderDesc',
};

export class IndicatorPanel {
  private root: HTMLElement | undefined;
  private cfg: PaneIndicatorConfig;
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

  private readonly overlayId = `ind-${Math.random().toString(36).slice(2, 8)}`;

  open(): void {
    this.close();
    this.cfg = loadIndicatorConfig();
    this.root = el('div', { class: 'indicator-panel', 'data-testid': 'indicator-panel' });
    this.render();
    this.anchor.append(this.root);
    // Tap outside / Escape / opening another panel closes it (shared rule, overlays.ts).
    overlays.opened({
      id: this.overlayId,
      contains: (n) => !!this.root?.contains(n) || this.anchor.contains(n),
      close: () => this.close(),
    });
  }

  close(): void {
    overlays.closed(this.overlayId);
    this.root?.remove();
    this.root = undefined;
    this.onClose?.();
  }

  /** Called after the panel closes for any reason (keeps the toggle's aria-expanded right). */
  onClose: (() => void) | undefined;

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
    const close = el(
      'button',
      {
        type: 'button',
        class: 'ghost panel-close',
        'data-testid': 'indicator-close',
        'aria-label': t('v1.closePanel'),
      },
      '✕',
    );
    close.addEventListener('click', () => this.close());
    this.root.replaceChildren(
      el('div', { class: 'panel-head' }, el('h4', {}, t('pr.indicators')), close),
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
      const desc = DESC_KEY[item.kind];
      const row = el(
        'div',
        desc ? { class: 'catalog-hit', title: t(desc) } : { class: 'catalog-hit' },
        el('span', {}, t(KIND_KEY[item.kind])),
        add,
      );
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
    if (drafted.multiplier !== undefined) patch.multiplier = drafted.multiplier;
    if (drafted.percent !== undefined) patch.percent = drafted.percent;
    if (drafted.step !== undefined) patch.step = drafted.step;
    if (drafted.maxStep !== undefined) patch.maxStep = drafted.maxStep;
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
    if (s.kind === 'zigzag') return `${name} ${s.percent ?? 5}`;
    if (
      s.period &&
      (s.kind === 'wma' ||
        s.kind === 'dema' ||
        s.kind === 'tema' ||
        s.kind === 'hull' ||
        s.kind === 'vwma' ||
        s.kind === 'keltner' ||
        s.kind === 'envelope' ||
        s.kind === 'priceChannel' ||
        s.kind === 'cci' ||
        s.kind === 'cmf' ||
        s.kind === 'williams' ||
        s.kind === 'momentum' ||
        s.kind === 'roc' ||
        s.kind === 'aroon' ||
        s.kind === 'bop' ||
        s.kind === 'kdj' ||
        s.kind === 'elder' ||
        s.kind === 'supertrend' ||
        s.kind === 'stderr')
    ) {
      return `${name} ${s.period}`;
    }
    return name;
  }

  private renderControls(s: IndicatorSetting): HTMLElement {
    const wrap = el('div', { class: 'indicator-controls' });
    if (this.appendExtraControls(s, wrap)) {
      wrap.append(this.colorControl(s));
      return wrap;
    }
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

  private colorControl(s: IndicatorSetting): HTMLElement {
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
    return el('label', { class: 'ind-ctrl' }, t('ind.color'), color);
  }

  /** Returns true when this kind has its own controls, so the original 11 stay untouched. */
  private appendExtraControls(s: IndicatorSetting, wrap: HTMLElement): boolean {
    const period = (label: MessageKey, value: number, set: (v: number) => void) => {
      wrap.append(this.numControl(t(label), value, set));
    };
    const source = () => wrap.append(this.sourceControl(s));
    switch (s.kind) {
      case 'keltner':
        period('ind.period', s.period ?? 20, (v) => {
          s.period = v;
          this.commit();
        });
        period('ind.atrPeriod', s.fast ?? 10, (v) => {
          s.fast = v;
          this.commit();
        });
        wrap.append(
          this.numControl(
            t('ind.multiplier'),
            s.multiplier ?? 2,
            (v) => {
              s.multiplier = v;
              this.commit();
            },
            true,
          ),
        );
        source();
        return true;
      case 'ichimoku':
        period('ind.tenkan', s.fast ?? 9, (v) => {
          s.fast = v;
          this.commit();
        });
        period('ind.kijun', s.slow ?? 26, (v) => {
          s.slow = v;
          this.commit();
        });
        period('ind.senkou', s.signal ?? 52, (v) => {
          s.signal = v;
          this.commit();
        });
        return true;
      case 'supertrend':
        period('ind.atrPeriod', s.period ?? 10, (v) => {
          s.period = v;
          this.commit();
        });
        wrap.append(
          this.numControl(
            t('ind.multiplier'),
            s.multiplier ?? 3,
            (v) => {
              s.multiplier = v;
              this.commit();
            },
            true,
          ),
        );
        return true;
      case 'sar':
        wrap.append(
          this.numControl(
            t('ind.step'),
            s.step ?? 0.02,
            (v) => {
              s.step = v;
              this.commit();
            },
            true,
          ),
          this.numControl(
            t('ind.maxStep'),
            s.maxStep ?? 0.2,
            (v) => {
              s.maxStep = v;
              this.commit();
            },
            true,
          ),
        );
        return true;
      case 'zigzag':
        wrap.append(
          this.numControl(
            t('ind.deviation'),
            s.percent ?? 5,
            (v) => {
              s.percent = v;
              this.commit();
            },
            true,
          ),
        );
        return true;
      case 'envelope':
        period('ind.period', s.period ?? 20, (v) => {
          s.period = v;
          this.commit();
        });
        wrap.append(
          this.numControl(
            t('ind.percent'),
            s.percent ?? 10,
            (v) => {
              s.percent = v;
              this.commit();
            },
            true,
          ),
        );
        source();
        return true;
      case 'stderr':
        period('ind.period', s.period ?? 20, (v) => {
          s.period = v;
          this.commit();
        });
        wrap.append(
          this.numControl(
            t('ind.multiplier'),
            s.multiplier ?? 2,
            (v) => {
              s.multiplier = v;
              this.commit();
            },
            true,
          ),
        );
        source();
        return true;
      case 'ao':
        period('ind.fast', s.fast ?? 5, (v) => {
          s.fast = v;
          this.commit();
        });
        period('ind.slow', s.slow ?? 34, (v) => {
          s.slow = v;
          this.commit();
        });
        return true;
      case 'dema':
      case 'tema':
      case 'wma':
      case 'hull':
      case 'vwma':
      case 'momentum':
      case 'roc':
      case 'elder':
        period('ind.period', s.period ?? 14, (v) => {
          s.period = v;
          this.commit();
        });
        source();
        return true;
      case 'cci':
        period('ind.period', s.period ?? 20, (v) => {
          s.period = v;
          this.commit();
        });
        source();
        return true;
      case 'cmf':
      case 'williams':
      case 'aroon':
      case 'bop':
      case 'kdj':
      case 'priceChannel':
        period('ind.period', s.period ?? 14, (v) => {
          s.period = v;
          this.commit();
        });
        return true;
      case 'obv':
      case 'vwapBands':
        return true;
      default:
        return false;
    }
  }

  private sourceControl(s: IndicatorSetting): HTMLElement {
    const sel = el('select', {}) as HTMLSelectElement;
    for (const src of SOURCE_OPTIONS) {
      sel.append(
        el('option', s.source === src ? { value: src, selected: 'selected' } : { value: src }, src),
      );
    }
    sel.addEventListener('change', () => {
      s.source = sel.value as IndicatorSource;
      this.commit();
    });
    return el('label', { class: 'ind-ctrl' }, t('ind.source'), sel);
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

  private numControl(
    label: string,
    value: number,
    set: (v: number) => void,
    float = false,
  ): HTMLElement {
    const input = el('input', {
      type: 'number',
      min: float ? '0.01' : '1',
      step: float ? '0.01' : '1',
      value: String(value),
    }) as HTMLInputElement;
    input.addEventListener('change', () => {
      const v = Number(input.value);
      if (!Number.isFinite(v) || v <= 0) return;
      set(float ? v : Math.floor(v));
    });
    return el('label', { class: 'ind-ctrl' }, label, input);
  }
}
