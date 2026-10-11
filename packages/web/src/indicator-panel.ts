// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Small popover for enabling and configuring built-in indicators per chart pane.

import { t } from './i18n.js';
import { el } from './format.js';
import {
  DEFAULT_OVERLAYS,
  DEFAULT_PANES,
  loadIndicatorConfig,
  saveIndicatorConfig,
  type IndicatorSetting,
  type PaneIndicatorConfig,
} from './indicator-prefs.js';
import type { IndicatorSource } from './indicators.js';

export type IndicatorChangeHandler = (cfg: PaneIndicatorConfig) => void;

const SOURCE_OPTIONS: IndicatorSource[] = ['open', 'high', 'low', 'close', 'hlc3'];

export class IndicatorPanel {
  private root: HTMLElement | undefined;
  private cfg: PaneIndicatorConfig;

  constructor(
    private readonly anchor: HTMLElement,
    private readonly onChange: IndicatorChangeHandler,
  ) {
    this.cfg = loadIndicatorConfig();
  }

  open(): void {
    this.close();
    this.root = el('div', { class: 'indicator-panel' });
    this.render();
    this.anchor.append(this.root);
    const clickOutside = (e: MouseEvent) => {
      if (!this.root || this.root.contains(e.target as Node)) return;
      this.close();
      document.removeEventListener('click', clickOutside, true);
    };
    document.addEventListener('click', clickOutside, true);
  }

  close(): void {
    this.root?.remove();
    this.root = undefined;
  }

  private render(): void {
    if (!this.root) return;
    this.root.replaceChildren(
      el('h4', {}, t('pr.indicators')),
      this.renderGroup(t('pr.indOverlays'), this.cfg.overlays, DEFAULT_OVERLAYS),
      this.renderGroup(t('pr.indPanes'), this.cfg.panes, DEFAULT_PANES),
    );
  }

  private renderGroup(
    title: string,
    settings: IndicatorSetting[],
    fallbacks: IndicatorSetting[],
  ): HTMLElement {
    const g = el('div', { class: 'indicator-group' });
    g.append(el('h5', {}, title));
    for (let i = 0; i < settings.length; i++) {
      const s = settings[i]!;
      const fb = fallbacks[i]!;
      const row = el('label', { class: 'indicator-row' });
      const box = el('input', { type: 'checkbox' }) as HTMLInputElement;
      box.checked = s.visible;
      box.addEventListener('change', () => {
        s.visible = box.checked;
        saveIndicatorConfig(this.cfg);
        this.render();
        this.onChange(this.cfg);
      });
      const label =
        (s.kind === 'sma' || s.kind === 'ema') && s.period
          ? `${t(`ind.${s.kind}` as const)} ${s.period}`
          : t(`ind.${s.kind}` as const);
      row.append(box, el('span', {}, label));
      if (s.visible) row.append(this.renderControls(s, fb));
      g.append(row);
    }
    return g;
  }

  private renderControls(s: IndicatorSetting, fb: IndicatorSetting): HTMLElement {
    const wrap = el('div', { class: 'indicator-controls' });
    if (s.period !== undefined) {
      wrap.append(
        this.numControl(t('ind.period'), s.period, (v) => {
          s.period = v;
          saveIndicatorConfig(this.cfg);
          this.onChange(this.cfg);
        }),
      );
    }
    if (s.source !== undefined) {
      const sel = el('select', {}) as HTMLSelectElement;
      for (const src of SOURCE_OPTIONS)
        sel.append(
          el(
            'option',
            s.source === src ? { value: src, selected: 'selected' } : { value: src },
            src,
          ),
        );
      sel.addEventListener('change', () => {
        s.source = sel.value as IndicatorSource;
        saveIndicatorConfig(this.cfg);
        this.onChange(this.cfg);
      });
      wrap.append(el('label', { class: 'ind-ctrl' }, t('ind.source'), sel));
    }
    if (s.stdDev !== undefined) {
      wrap.append(
        this.numControl(t('ind.stdDev'), s.stdDev, (v) => {
          s.stdDev = v;
          saveIndicatorConfig(this.cfg);
          this.onChange(this.cfg);
        }),
      );
    }
    if (s.fast !== undefined) {
      wrap.append(
        this.numControl(t('ind.fast'), s.fast, (v) => {
          s.fast = v;
          saveIndicatorConfig(this.cfg);
          this.onChange(this.cfg);
        }),
      );
    }
    if (s.slow !== undefined) {
      wrap.append(
        this.numControl(t('ind.slow'), s.slow, (v) => {
          s.slow = v;
          saveIndicatorConfig(this.cfg);
          this.onChange(this.cfg);
        }),
      );
    }
    if (s.signal !== undefined) {
      wrap.append(
        this.numControl(t('ind.signal'), s.signal, (v) => {
          s.signal = v;
          saveIndicatorConfig(this.cfg);
          this.onChange(this.cfg);
        }),
      );
    }
    const color = el('input', {
      type: 'color',
      value: s.color ?? fb.color ?? '#888888',
    }) as HTMLInputElement;
    color.addEventListener('input', () => {
      s.color = color.value;
      saveIndicatorConfig(this.cfg);
      this.onChange(this.cfg);
    });
    wrap.append(el('label', { class: 'ind-ctrl' }, t('ind.color'), color));
    return wrap;
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
