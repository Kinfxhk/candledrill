// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Simulated macro builder. It stacks bar-close conditions and asks the server to run
// them through the same order engine as the manual ticket. It never talks to a broker.

import {
  exampleOrbSmaMacro,
  parseMacro,
  type Condition,
  type MacroRule,
  type MacroV1,
  type SessionStats,
  type TargetMode,
  type StopMode,
} from '@candledrill/core';
import { el, fmtMoney, fmtPct, toast } from './format.js';
import { t, type MessageKey } from './i18n.js';
import {
  loadMacro,
  macroFeatureEnabled,
  saveMacro,
  setMacroFeatureEnabled,
} from './macro-store.js';

export interface MacroRunView {
  simulated: true;
  signals: number;
  barsProcessed: number;
  openQty: number;
  stats: SessionStats;
}

export interface MacroPanelHooks {
  blind(): boolean;
  run(macro: MacroV1, from: 'start' | 'cursor'): Promise<MacroRunView>;
  onArmed(armed: boolean): void;
}

const COND_TYPES: Condition['type'][] = [
  'price_vs_ma',
  'orb_break',
  'flat_only',
  'time_window',
  'rsi',
  'macd',
  'bb',
  'ma_cross',
  'donchian_break',
  'stoch_cross',
  'adx',
  'min_bars_since_entry',
];

const COND_KEY: Record<Condition['type'], MessageKey> = {
  price_vs_ma: 'cond.price_vs_ma',
  ma_cross: 'cond.ma_cross',
  orb_break: 'cond.orb_break',
  rsi: 'cond.rsi',
  bb: 'cond.bb',
  macd: 'cond.macd',
  donchian_break: 'cond.donchian',
  stoch_cross: 'cond.stoch',
  adx: 'cond.adx',
  time_window: 'cond.time_window',
  day_of_week: 'cond.day_of_week',
  min_bars_since_entry: 'cond.cooldown',
  flat_only: 'cond.flat_only',
};

function defaultCondition(type: Condition['type']): Condition {
  switch (type) {
    case 'price_vs_ma':
      return { type, op: 'above', ma: 'sma', period: 21, source: 'close' };
    case 'ma_cross':
      return {
        type,
        direction: 'bull',
        fast: { ma: 'ema', period: 9 },
        slow: { ma: 'ema', period: 21 },
      };
    case 'orb_break':
      return { type, minutes: 30, direction: 'up' };
    case 'rsi':
      return { type, op: 'lt', level: 70, period: 14 };
    case 'bb':
      return { type, which: 'upper', op: 'close_beyond', period: 20, stdDev: 2 };
    case 'macd':
      return { type, event: 'hist_pos', fast: 12, slow: 26, signal: 9 };
    case 'donchian_break':
      return { type, period: 20, direction: 'up' };
    case 'stoch_cross':
      return { type, direction: 'bull', kPeriod: 14, dPeriod: 3, smooth: 3, level: 20 };
    case 'adx':
      return { type, op: 'gt', level: 20, period: 14, di: 'plus_above' };
    case 'time_window':
      return { type, startMinute: 9 * 60 + 30, endMinute: 11 * 60 };
    case 'day_of_week':
      return { type, days: [1, 2, 3, 4, 5] };
    case 'min_bars_since_entry':
      return { type, bars: 5 };
    case 'flat_only':
      return { type };
    default: {
      const leftover: never = type;
      throw new Error(`unknown condition ${String(leftover)}`);
    }
  }
}

const PRESETS: { id: string; key: MessageKey; condition: Condition }[] = [
  { id: 'orb-up', key: 'macro.presetOrb', condition: defaultCondition('orb_break') },
  {
    id: 'sma',
    key: 'macro.presetSma',
    condition: defaultCondition('price_vs_ma'),
  },
  { id: 'flat', key: 'macro.presetFlat', condition: { type: 'flat_only' } },
  { id: 'rsi', key: 'macro.presetRsi', condition: defaultCondition('rsi') },
  { id: 'macd', key: 'macro.presetMacd', condition: defaultCondition('macd') },
  { id: 'bb', key: 'macro.presetBb', condition: defaultCondition('bb') },
];

function rid(): string {
  return `r${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

const STEPS = [
  { id: 'rules', key: 'macro.stepRules' },
  { id: 'trade', key: 'macro.stepTrade' },
  { id: 'run', key: 'macro.stepRun' },
  { id: 'result', key: 'macro.stepResult' },
] as const;

type MacroStep = 0 | 1 | 2 | 3;

/** Reasons Run must stay blocked. A parsed macro can still fail these (blind, disabled rules). */
export function macroRunBlockers(macro: MacroV1, blind: boolean): MessageKey[] {
  const missing: MessageKey[] = [];
  if (blind) missing.push('macro.blind');
  if (macro.name.trim().length < 1) missing.push('macro.needName');
  if (!Number.isInteger(macro.qty) || macro.qty < 1 || macro.qty > 10000)
    missing.push('macro.needQty');
  const ready = macro.rules.some((rule) => rule.enabled && rule.conditions.length > 0);
  if (!ready) missing.push('macro.needRule');
  if (!(macro.exit.stop.value > 0)) missing.push('macro.needStop');
  if (!(macro.exit.target.value > 0)) missing.push('macro.needTarget');
  return missing;
}

export class MacroPanel {
  readonly el: HTMLElement;
  private macro: MacroV1;
  private armed = false;
  private running = false;
  private from: 'start' | 'cursor' = 'start';
  private result: MacroRunView | undefined;
  private error = '';
  private step: MacroStep = 0;
  private showMissing = false;
  private blindShown: boolean | undefined;
  private lang = '';
  private nameDraft: string | null = null;
  private qtyDraft: string | null = null;
  private stopDraft: string | null = null;
  private targetDraft: string | null = null;

  constructor(private readonly hooks: MacroPanelHooks) {
    this.macro = loadMacro();
    this.el = el('section', {
      class: 'card macro-panel',
      'data-testid': 'macro-panel',
      'aria-labelledby': 'h-macro',
    });
    this.render();
  }

  current(): MacroV1 {
    return this.macro;
  }

  isArmed(): boolean {
    return this.armed;
  }

  enable(): void {
    setMacroFeatureEnabled(true);
    this.render();
  }

  /** Move keyboard focus into the wizard after the chart Macro button opens this tab. */
  focus(): void {
    const target =
      this.el.querySelector<HTMLElement>('[data-testid=macro-show]') ??
      this.el.querySelector<HTMLElement>('[data-testid=macro-next]') ??
      this.el.querySelector<HTMLElement>('h3');
    target?.focus();
  }

  showResult(result: MacroRunView): void {
    this.result = result;
    this.error = '';
    this.running = false;
    this.step = 3;
    this.render();
  }

  private persist(next: MacroV1): void {
    try {
      this.macro = parseMacro(next);
      saveMacro(this.macro);
      this.error = '';
    } catch (err) {
      this.error = (err as Error).message;
      this.showMissing = true;
      toast(this.error, 'error');
    }
    this.render();
  }

  /** Re-render when blind state or language flips. Session ticks do not rebuild the wizard. */
  sync(blind: boolean, lang: string): void {
    if (blind && this.armed) {
      this.armed = false;
      this.hooks.onArmed(false);
    }
    const changed = this.blindShown !== blind || this.lang !== lang;
    this.blindShown = blind;
    this.lang = lang;
    if (changed) this.render();
  }

  private blockers(): MessageKey[] {
    const missing = macroRunBlockers(this.macro, this.hooks.blind());
    const extra: MessageKey[] = [];
    if (this.nameDraft !== null && !missing.includes('macro.needName'))
      extra.push('macro.needName');
    if (this.qtyDraft !== null && !missing.includes('macro.needQty')) extra.push('macro.needQty');
    if (this.stopDraft !== null && !missing.includes('macro.needStop'))
      extra.push('macro.needStop');
    if (this.targetDraft !== null && !missing.includes('macro.needTarget'))
      extra.push('macro.needTarget');
    return [...missing, ...extra];
  }

  private stepReady(step: MacroStep): boolean {
    const blocked = this.blockers();
    switch (step) {
      case 0:
        return (
          this.nameDraft === null &&
          !blocked.includes('macro.needRule') &&
          !blocked.includes('macro.needName')
        );
      case 1:
        return (
          this.nameDraft === null &&
          this.qtyDraft === null &&
          this.stopDraft === null &&
          this.targetDraft === null &&
          !blocked.includes('macro.needName') &&
          !blocked.includes('macro.needQty') &&
          !blocked.includes('macro.needStop') &&
          !blocked.includes('macro.needTarget')
        );
      case 2:
        return blocked.length === 0;
      case 3:
        return this.result !== undefined;
      default: {
        const leftover: never = step;
        return leftover;
      }
    }
  }

  private setStep(step: MacroStep): void {
    this.step = step;
    this.render();
  }

  private render(): void {
    if (!macroFeatureEnabled()) {
      this.renderHidden();
      return;
    }
    if (this.hooks.blind()) {
      this.renderUnavailable();
      return;
    }
    this.renderWizard();
  }

  private header(): HTMLElement {
    const hide = el(
      'button',
      { type: 'button', class: 'small ghost', 'data-testid': 'macro-hide' },
      t('macro.hide'),
    );
    hide.addEventListener('click', () => {
      this.armed = false;
      this.hooks.onArmed(false);
      setMacroFeatureEnabled(false);
      this.render();
    });
    return el('div', { class: 'macro-head' }, el('h3', { id: 'h-macro' }, t('macro.title')), hide);
  }

  private renderHidden(): void {
    const show = el(
      'button',
      { type: 'button', class: 'primary', 'data-testid': 'macro-show' },
      t('macro.open'),
    );
    show.addEventListener('click', () => this.enable());
    this.el.replaceChildren(
      el('h3', { id: 'h-macro' }, t('macro.title')),
      el('p', { class: 'muted small' }, t('macro.notice')),
      show,
    );
  }

  private renderUnavailable(): void {
    this.el.replaceChildren(
      this.header(),
      el('p', { class: 'macro-banner', 'data-testid': 'macro-banner' }, t('macro.badge')),
      el(
        'div',
        { class: 'notice', 'data-testid': 'macro-unavailable' },
        el('p', {}, t('macro.blind')),
        el('p', {}, t('macro.blindStart')),
      ),
    );
  }

  private renderWizard(): void {
    const step = STEPS[this.step]!;
    const body = el('div', { class: 'macro-step', 'data-testid': `macro-step-${step.id}` });
    body.append(el('h4', {}, t(step.key)));
    switch (this.step) {
      case 0:
        body.append(...this.stepRules());
        break;
      case 1:
        body.append(...this.stepTrade());
        break;
      case 2:
        body.append(el('p', { class: 'muted small' }, t('macro.manual')), this.renderRun());
        break;
      case 3:
        body.append(this.renderResult());
        break;
      default: {
        const leftover: never = this.step;
        void leftover;
      }
    }
    if (this.error) body.append(el('p', { class: 'down small' }, this.error));
    body.append(this.stepNav());
    this.el.replaceChildren(
      this.header(),
      el('p', { class: 'macro-banner', 'data-testid': 'macro-banner' }, t('macro.badge')),
      el('p', { class: 'muted small' }, t('macro.notice')),
      this.stepper(),
      body,
    );
  }

  private stepper(): HTMLElement {
    const nav = el('div', { class: 'macro-steps', role: 'group', 'aria-label': t('macro.title') });
    STEPS.forEach((step, index) => {
      const current = index === this.step;
      const button = el(
        'button',
        {
          type: 'button',
          'data-testid': `macro-goto-${step.id}`,
          'aria-current': current ? 'step' : 'false',
        },
        `${index + 1}. ${t(step.key)}`,
      );
      if (this.stepReady(index as MacroStep)) button.classList.add('done');
      button.addEventListener('click', () => this.setStep(index as MacroStep));
      nav.append(button);
    });
    return nav;
  }

  private stepNav(): HTMLElement {
    const row = el('div', { class: 'macro-wizard-nav' });
    if (this.step > 0) {
      const back = el('button', { type: 'button', 'data-testid': 'macro-back' }, t('macro.back'));
      back.addEventListener('click', () => this.setStep((this.step - 1) as MacroStep));
      row.append(back);
    } else {
      row.append(el('span', {}));
    }
    if (this.step < 3 && this.stepReady(this.step)) {
      const next = el(
        'button',
        { type: 'button', class: 'primary macro-next', 'data-testid': 'macro-next' },
        t('macro.next'),
      );
      next.addEventListener('click', () => this.setStep((this.step + 1) as MacroStep));
      row.append(next);
    }
    return row;
  }

  private stepRules(): HTMLElement[] {
    const name = el('input', {
      type: 'text',
      value: this.nameDraft ?? this.macro.name,
      'data-testid': 'macro-name',
    }) as HTMLInputElement;
    name.addEventListener('change', () => this.commitName(name.value));
    return [
      this.field(t('macro.name'), name),
      el('h4', {}, t('macro.rules')),
      ...this.macro.rules.map((rule, index) => this.renderRule(rule, index)),
      this.button('macro-add-rule', t('macro.addRule'), () => {
        const priority = this.macro.rules.reduce((m, r) => Math.max(m, r.priority), 0) + 1;
        this.persist({
          ...this.macro,
          rules: [
            ...this.macro.rules,
            {
              id: rid(),
              priority,
              enabled: true,
              side: 'buy',
              conditions: [defaultCondition('flat_only')],
            },
          ],
        });
      }),
      this.renderPresets(),
      this.exampleButton(),
      ...this.stepHint(['macro.needRule', 'macro.needName']),
    ];
  }

  private stepTrade(): HTMLElement[] {
    return [
      this.field(t('macro.qty'), this.qtyField()),
      ...this.macro.rules.map((rule, index) => this.renderSide(rule, index)),
      el('h4', {}, t('macro.exits')),
      this.renderExits(),
      this.check(
        t('macro.onePosition'),
        this.macro.onePositionOnly !== false,
        'macro-one',
        (on) => {
          this.persist({ ...this.macro, onePositionOnly: on });
        },
      ),
      this.check(
        t('macro.flatten'),
        this.macro.exit.flattenAtSessionEnd === true,
        'macro-flatten',
        (on) => {
          this.persist({
            ...this.macro,
            exit: { ...this.macro.exit, flattenAtSessionEnd: on },
          });
        },
      ),
      ...this.stepHint(['macro.needName', 'macro.needQty', 'macro.needStop', 'macro.needTarget']),
    ];
  }

  private stepHint(keys: readonly MessageKey[]): HTMLElement[] {
    const hit = this.blockers().filter((key) => keys.includes(key));
    if (hit.length === 0) return [];
    return [this.missingList(hit)];
  }

  private missingList(keys: readonly MessageKey[]): HTMLElement {
    const list = el('ul', { 'data-testid': 'macro-missing' });
    for (const key of keys) list.append(el('li', {}, t(key)));
    if (this.error) list.append(el('li', {}, this.error));
    return el(
      'div',
      { class: 'macro-missing' },
      el('p', { class: 'down small' }, t('macro.missingTitle')),
      list,
    );
  }

  private renderSide(rule: MacroRule, index: number): HTMLElement {
    const side = this.select(
      rule.side,
      [
        ['buy', t('pr.buy')],
        ['sell', t('pr.sell')],
      ],
      (value) => this.replaceRule(index, { ...rule, side: value === 'sell' ? 'sell' : 'buy' }),
    );
    return el(
      'div',
      { class: 'macro-rule-head' },
      el('span', {}, `${t('macro.priority')} ${rule.priority}`),
      side,
    );
  }

  private renderRule(rule: MacroRule, index: number): HTMLElement {
    const box = el('div', { class: 'macro-rule' });
    const enabled = el('input', { type: 'checkbox' }) as HTMLInputElement;
    enabled.checked = rule.enabled;
    enabled.addEventListener('change', () =>
      this.replaceRule(index, { ...rule, enabled: enabled.checked }),
    );
    const priority = this.numInput(rule.priority, `macro-priority-${index}`, (n) => {
      this.replaceRule(index, { ...rule, priority: n });
    });
    const remove = el('button', { type: 'button', class: 'small ghost' }, t('ind.remove'));
    remove.addEventListener('click', () => {
      if (this.macro.rules.length < 2) return;
      this.persist({ ...this.macro, rules: this.macro.rules.filter((_, i) => i !== index) });
    });
    box.append(
      el(
        'div',
        { class: 'macro-rule-head' },
        enabled,
        el('span', {}, t('macro.priority')),
        priority,
        remove,
      ),
    );
    rule.conditions.forEach((cond, ci) => box.append(this.renderCondition(index, ci, cond)));
    const add = el('button', { type: 'button', class: 'small ghost' }, t('macro.addCondition'));
    add.addEventListener('click', () => {
      this.replaceRule(index, {
        ...rule,
        conditions: [...rule.conditions, defaultCondition('price_vs_ma')],
      });
    });
    box.append(add);
    return box;
  }

  private renderCondition(ruleIndex: number, condIndex: number, cond: Condition): HTMLElement {
    const row = el('div', { class: 'macro-cond' });
    const type = this.select(
      cond.type,
      COND_TYPES.map((id) => [id, t(COND_KEY[id])]),
      (value) => {
        const next = defaultCondition(value as Condition['type']);
        this.replaceCondition(ruleIndex, condIndex, next);
      },
    );
    row.append(type, ...this.conditionFields(ruleIndex, condIndex, cond));
    const remove = el('button', { type: 'button', class: 'small ghost' }, '×');
    remove.addEventListener('click', () => {
      const rule = this.macro.rules[ruleIndex];
      if (!rule || rule.conditions.length < 2) return;
      this.replaceRule(ruleIndex, {
        ...rule,
        conditions: rule.conditions.filter((_, i) => i !== condIndex),
      });
    });
    row.append(remove);
    return row;
  }

  private conditionFields(ruleIndex: number, condIndex: number, cond: Condition): HTMLElement[] {
    const set = (next: Condition) => this.replaceCondition(ruleIndex, condIndex, next);
    switch (cond.type) {
      case 'price_vs_ma':
        return [
          this.select(
            cond.op,
            [
              ['above', t('cond.above')],
              ['below', t('cond.below')],
            ],
            (op) => set({ ...cond, op: op === 'below' ? 'below' : 'above' }),
          ),
          this.select(
            cond.ma,
            [
              ['sma', 'SMA'],
              ['ema', 'EMA'],
            ],
            (ma) => set({ ...cond, ma: ma === 'ema' ? 'ema' : 'sma' }),
          ),
          this.numInput(cond.period, '', (period) => set({ ...cond, period })),
        ];
      case 'orb_break':
        return [
          this.select(
            cond.direction,
            [
              ['up', t('cond.up')],
              ['down', t('cond.down')],
              ['either', t('cond.either')],
            ],
            (direction) =>
              set({
                ...cond,
                direction: direction === 'down' || direction === 'either' ? direction : 'up',
              }),
          ),
          this.numInput(cond.minutes, '', (minutes) => set({ ...cond, minutes })),
        ];
      case 'rsi':
        return [
          this.select(
            cond.op,
            [
              ['gt', t('cond.gt')],
              ['lt', t('cond.lt')],
              ['cross_above', t('cond.crossAbove')],
              ['cross_below', t('cond.crossBelow')],
            ],
            (op) =>
              set({
                ...cond,
                op: op === 'lt' || op === 'cross_above' || op === 'cross_below' ? op : 'gt',
              }),
          ),
          this.numInput(cond.level, '', (level) => set({ ...cond, level })),
          this.numInput(cond.period ?? 14, '', (period) => set({ ...cond, period })),
        ];
      case 'macd':
        return [
          this.select(
            cond.event,
            [
              ['hist_pos', t('cond.histPos')],
              ['hist_neg', t('cond.histNeg')],
              ['cross_bull', t('cond.crossBull')],
              ['cross_bear', t('cond.crossBear')],
            ],
            (event) =>
              set({
                ...cond,
                event:
                  event === 'hist_neg' || event === 'cross_bull' || event === 'cross_bear'
                    ? event
                    : 'hist_pos',
              }),
          ),
        ];
      case 'bb':
        return [
          this.select(
            cond.which,
            [
              ['upper', t('cond.upper')],
              ['lower', t('cond.lower')],
              ['middle', t('cond.middle')],
            ],
            (which) =>
              set({
                ...cond,
                which: which === 'lower' || which === 'middle' ? which : 'upper',
              }),
          ),
          this.select(
            cond.op,
            [
              ['close_beyond', t('cond.closeBeyond')],
              ['touch', t('cond.touch')],
            ],
            (op) => set({ ...cond, op: op === 'touch' ? 'touch' : 'close_beyond' }),
          ),
        ];
      case 'ma_cross':
        return [
          this.select(
            cond.direction,
            [
              ['bull', t('cond.bull')],
              ['bear', t('cond.bear')],
            ],
            (direction) => set({ ...cond, direction: direction === 'bear' ? 'bear' : 'bull' }),
          ),
          this.numInput(cond.fast.period, '', (period) =>
            set({ ...cond, fast: { ...cond.fast, period } }),
          ),
          this.numInput(cond.slow.period, '', (period) =>
            set({ ...cond, slow: { ...cond.slow, period } }),
          ),
        ];
      case 'donchian_break':
        return [
          this.select(
            cond.direction,
            [
              ['up', t('cond.up')],
              ['down', t('cond.down')],
            ],
            (direction) => set({ ...cond, direction: direction === 'down' ? 'down' : 'up' }),
          ),
          this.numInput(cond.period, '', (period) => set({ ...cond, period })),
        ];
      case 'stoch_cross':
        return [
          this.select(
            cond.direction,
            [
              ['bull', t('cond.bull')],
              ['bear', t('cond.bear')],
            ],
            (direction) => set({ ...cond, direction: direction === 'bear' ? 'bear' : 'bull' }),
          ),
          this.numInput(cond.level ?? 20, '', (level) => set({ ...cond, level })),
        ];
      case 'adx':
        return [
          this.select(
            cond.op,
            [
              ['gt', t('cond.gt')],
              ['lt', t('cond.lt')],
            ],
            (op) => set({ ...cond, op: op === 'lt' ? 'lt' : 'gt' }),
          ),
          this.numInput(cond.level, '', (level) => set({ ...cond, level })),
          this.select(
            cond.di ?? 'any',
            [
              ['plus_above', '+DI'],
              ['minus_above', '−DI'],
              ['any', t('cond.either')],
            ],
            (di) =>
              set({
                ...cond,
                di: di === 'minus_above' || di === 'any' ? di : 'plus_above',
              }),
          ),
        ];
      case 'time_window':
        return [
          this.numInput(cond.startMinute, '', (startMinute) => set({ ...cond, startMinute })),
          this.numInput(cond.endMinute, '', (endMinute) => set({ ...cond, endMinute })),
        ];
      case 'min_bars_since_entry':
        return [this.numInput(cond.bars, '', (bars) => set({ ...cond, bars }))];
      case 'day_of_week':
      case 'flat_only':
        return [];
      default: {
        const leftover: never = cond;
        void leftover;
        return [];
      }
    }
  }

  private renderPresets(): HTMLElement {
    const row = el('div', { class: 'macro-presets' });
    row.append(el('span', { class: 'muted small' }, t('macro.preset')));
    for (const preset of PRESETS) {
      const b = el(
        'button',
        { type: 'button', class: 'small ghost', 'data-testid': `macro-preset-${preset.id}` },
        t(preset.key),
      );
      b.addEventListener('click', () => {
        const rules = this.macro.rules.map((r, i) =>
          i === 0 ? { ...r, conditions: [...r.conditions, preset.condition] } : r,
        );
        this.persist({ ...this.macro, rules });
      });
      row.append(b);
    }
    return row;
  }

  private renderExits(): HTMLElement {
    const stopModes: [StopMode, string][] = [
      ['ticks', t('macro.mode.ticks')],
      ['atr_mult', t('macro.mode.atr')],
      ['percent', t('macro.mode.percent')],
    ];
    const targetModes: [TargetMode, string][] = [
      ['ticks', t('macro.mode.ticks')],
      ['atr_mult', t('macro.mode.atr')],
      ['rr', t('macro.mode.rr')],
      ['percent', t('macro.mode.percent')],
    ];
    return el(
      'div',
      { class: 'macro-exits' },
      el('span', {}, t('macro.stop')),
      this.select(this.macro.exit.stop.mode, stopModes, (mode) => {
        const stopMode: StopMode = mode === 'atr_mult' || mode === 'percent' ? mode : 'ticks';
        this.persist({
          ...this.macro,
          exit: { ...this.macro.exit, stop: { ...this.macro.exit.stop, mode: stopMode } },
        });
      }),
      this.gatedNumber(this.stopDraft ?? String(this.macro.exit.stop.value), 'macro-stop', (raw) =>
        this.commitGated(
          raw,
          'stop',
          (value) => Number.isFinite(value) && value > 0,
          (value) => {
            this.persist({
              ...this.macro,
              exit: { ...this.macro.exit, stop: { ...this.macro.exit.stop, value } },
            });
          },
        ),
      ),
      el('span', {}, t('macro.target')),
      this.select(this.macro.exit.target.mode, targetModes, (mode) => {
        const targetMode: TargetMode =
          mode === 'atr_mult' || mode === 'rr' || mode === 'percent' ? mode : 'ticks';
        this.persist({
          ...this.macro,
          exit: { ...this.macro.exit, target: { ...this.macro.exit.target, mode: targetMode } },
        });
      }),
      this.gatedNumber(
        this.targetDraft ?? String(this.macro.exit.target.value),
        'macro-target',
        (raw) =>
          this.commitGated(
            raw,
            'target',
            (value) => Number.isFinite(value) && value > 0,
            (value) => {
              this.persist({
                ...this.macro,
                exit: { ...this.macro.exit, target: { ...this.macro.exit.target, value } },
              });
            },
          ),
      ),
    );
  }

  private renderRun(): HTMLElement {
    const blocked = this.blockers();
    const arm = el(
      'button',
      {
        type: 'button',
        class: this.armed ? 'primary' : '',
        'data-testid': 'macro-arm',
        'aria-pressed': String(this.armed),
      },
      t(this.armed ? 'macro.disarm' : 'macro.arm'),
    );
    arm.disabled = blocked.length > 0;
    arm.addEventListener('click', () => {
      if (this.blockers().length > 0) {
        this.revealMissing();
        return;
      }
      this.armed = !this.armed;
      this.hooks.onArmed(this.armed);
      this.render();
    });
    const from = this.select(
      this.from,
      [
        ['start', t('macro.fromStart')],
        ['cursor', t('macro.fromCursor')],
      ],
      (value) => {
        this.from = value === 'cursor' ? 'cursor' : 'start';
        this.render();
      },
    );
    const run = el(
      'button',
      { type: 'button', class: 'primary', 'data-testid': 'macro-run' },
      t(this.running ? 'macro.running' : 'macro.run'),
    );
    if (blocked.length > 0) run.setAttribute('aria-disabled', 'true');
    run.classList.toggle('is-blocked', blocked.length > 0);
    run.disabled = this.running;
    run.addEventListener('click', () => void this.onRun());
    const wrap = el('div', { class: 'macro-actions' }, arm, from, run, this.exampleButton());
    if (this.armed) wrap.append(el('p', { class: 'muted small' }, t('macro.armedHint')));
    if (blocked.length > 0 || this.showMissing) wrap.append(this.missingList(blocked));
    return wrap;
  }

  private async onRun(): Promise<void> {
    if (this.blockers().length > 0) {
      this.revealMissing();
      return;
    }
    this.running = true;
    this.error = '';
    this.showMissing = false;
    this.render();
    try {
      const result = await this.hooks.run(this.macro, this.from);
      this.result = result;
      this.step = 3;
    } catch (err) {
      this.error = t('macro.failed', { reason: (err as Error).message });
      this.showMissing = true;
    } finally {
      this.running = false;
      this.render();
    }
  }

  private revealMissing(): void {
    const keys = this.blockers();
    this.showMissing = true;
    this.step = 2;
    toast(keys.map((key) => t(key)).join(' '), 'error');
    this.render();
  }

  private renderResult(): HTMLElement {
    const box = el('div', { class: 'macro-result', 'data-testid': 'macro-result' });
    if (!this.result) {
      box.append(
        el('h4', {}, t('macro.result')),
        el('p', { class: 'muted small' }, t('macro.noResult')),
      );
      return box;
    }
    const s = this.result.stats;
    box.append(
      el('h4', {}, t('macro.result')),
      el('p', { class: 'muted small' }, t('macro.research')),
    );
    const line = (k: string, v: string) =>
      el('div', { class: 'macro-stat' }, el('span', {}, k), el('b', {}, v));
    box.append(
      line(t('macro.trades'), String(s.trades)),
      line(t('macro.winRate'), fmtPct(s.winRate)),
      line(t('macro.maxDd'), fmtMoney(s.maxDrawdown)),
      line(t('macro.net'), fmtMoney(s.netPnl)),
      line(t('macro.signals'), String(this.result.signals)),
      line(t('macro.bars'), String(this.result.barsProcessed)),
      line(t('macro.openQty'), String(this.result.openQty)),
    );
    if (s.trades === 0) box.append(el('p', { class: 'muted small' }, t('macro.noTrades')));
    return box;
  }

  private replaceRule(index: number, rule: MacroRule): void {
    const rules = this.macro.rules.map((r, i) => (i === index ? rule : r));
    this.persist({ ...this.macro, rules });
  }

  private replaceCondition(ruleIndex: number, condIndex: number, cond: Condition): void {
    const rule = this.macro.rules[ruleIndex];
    if (!rule) return;
    const conditions = rule.conditions.map((c, i) => (i === condIndex ? cond : c));
    this.replaceRule(ruleIndex, { ...rule, conditions });
  }

  private field(label: string, input: HTMLElement): HTMLElement {
    return el('label', { class: 'field' }, el('span', {}, label), input);
  }

  private exampleButton(): HTMLButtonElement {
    const reset = el(
      'button',
      { type: 'button', class: 'small ghost', 'data-testid': 'macro-example' },
      t('macro.example'),
    );
    reset.addEventListener('click', () => {
      this.nameDraft = null;
      this.qtyDraft = null;
      this.stopDraft = null;
      this.targetDraft = null;
      this.showMissing = false;
      this.persist(exampleOrbSmaMacro());
    });
    return reset;
  }

  private commitName(raw: string): void {
    const name = raw.trim();
    if (name.length < 1 || name.length > 80) {
      this.nameDraft = raw;
      this.showMissing = true;
      this.render();
      return;
    }
    this.nameDraft = null;
    this.persist({ ...this.macro, name });
  }

  private qtyField(): HTMLInputElement {
    return this.gatedNumber(this.qtyDraft ?? String(this.macro.qty), 'macro-qty', (raw) =>
      this.commitGated(
        raw,
        'qty',
        (value) => Number.isInteger(value) && value >= 1 && value <= 10000,
        (qty) => this.persist({ ...this.macro, qty }),
      ),
    );
  }

  private gatedNumber(value: string, testid: string, set: (raw: string) => void): HTMLInputElement {
    const attrs: Record<string, string> = { type: 'number', step: 'any', value };
    if (testid) attrs['data-testid'] = testid;
    const input = el('input', attrs) as HTMLInputElement;
    input.addEventListener('change', () => set(input.value));
    return input;
  }

  private commitGated(
    raw: string,
    draft: 'qty' | 'stop' | 'target',
    ok: (n: number) => boolean,
    apply: (n: number) => void,
  ): void {
    const n = Number(raw);
    if (!ok(n)) {
      this.setDraft(draft, raw);
      this.showMissing = true;
      this.render();
      return;
    }
    this.setDraft(draft, null);
    apply(n);
  }

  private setDraft(draft: 'qty' | 'stop' | 'target', value: string | null): void {
    switch (draft) {
      case 'qty':
        this.qtyDraft = value;
        break;
      case 'stop':
        this.stopDraft = value;
        break;
      case 'target':
        this.targetDraft = value;
        break;
      default: {
        const leftover: never = draft;
        void leftover;
      }
    }
  }

  private numInput(value: number, testid: string, set: (v: number) => void): HTMLInputElement {
    const attrs: Record<string, string> = { type: 'number', step: 'any', value: String(value) };
    if (testid) attrs['data-testid'] = testid;
    const input = el('input', attrs) as HTMLInputElement;
    input.addEventListener('change', () => {
      const n = Number(input.value);
      if (Number.isFinite(n)) set(n);
    });
    return input;
  }

  private select(
    value: string,
    options: readonly (readonly [string, string])[],
    set: (v: string) => void,
  ): HTMLSelectElement {
    const sel = el('select', {}) as HTMLSelectElement;
    for (const [id, label] of options) {
      sel.append(
        el('option', id === value ? { value: id, selected: 'selected' } : { value: id }, label),
      );
    }
    sel.addEventListener('change', () => set(sel.value));
    return sel;
  }

  private check(
    label: string,
    on: boolean,
    testid: string,
    set: (v: boolean) => void,
  ): HTMLElement {
    const box = el('input', { type: 'checkbox', 'data-testid': testid }) as HTMLInputElement;
    box.checked = on;
    box.addEventListener('change', () => set(box.checked));
    return el('label', { class: 'indicator-row' }, box, el('span', {}, label));
  }

  private button(testid: string, label: string, onClick: () => void): HTMLButtonElement {
    const b = el('button', { type: 'button', class: 'small', 'data-testid': testid }, label);
    b.addEventListener('click', onClick);
    return b;
  }
}
