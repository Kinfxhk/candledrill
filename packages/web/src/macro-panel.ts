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
import { el, fmtMoney, fmtPct } from './format.js';
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

export class MacroPanel {
  readonly el: HTMLElement;
  private macro: MacroV1;
  private armed = false;
  private running = false;
  private from: 'start' | 'cursor' = 'start';
  private result: MacroRunView | undefined;
  private error = '';

  constructor(private readonly hooks: MacroPanelHooks) {
    this.macro = loadMacro();
    this.el = el('section', {
      class: 'card macro-panel',
      'data-testid': 'macro-panel',
      'aria-labelledby': 'h-macro',
    });
    this.el.hidden = !macroFeatureEnabled();
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
    this.el.hidden = false;
    this.render();
  }

  showResult(result: MacroRunView): void {
    this.result = result;
    this.error = '';
    this.running = false;
    this.render();
  }

  private persist(next: MacroV1): void {
    try {
      this.macro = parseMacro(next);
      saveMacro(this.macro);
      this.error = '';
    } catch (err) {
      this.error = (err as Error).message;
    }
    this.render();
  }

  /** Re-render when blind state flips so Run/Arm follow the session. */
  noteBlind(blind: boolean): void {
    if (blind && this.armed) {
      this.armed = false;
      this.hooks.onArmed(false);
    }
    const shown =
      this.el.querySelector('[data-testid=macro-arm]')?.hasAttribute('disabled') ?? false;
    if (shown !== blind) this.render();
  }

  private render(): void {
    const blind = this.hooks.blind();
    const banner = el(
      'p',
      { class: 'macro-banner', 'data-testid': 'macro-banner' },
      t('macro.badge'),
    );
    const notice = el('p', { class: 'muted small' }, t('macro.notice'));
    const manual = el('p', { class: 'muted small' }, t('macro.manual'));
    const hide = el(
      'button',
      { type: 'button', class: 'small ghost', 'data-testid': 'macro-hide' },
      t('macro.hide'),
    );
    hide.addEventListener('click', () => {
      this.armed = false;
      this.hooks.onArmed(false);
      setMacroFeatureEnabled(false);
      this.el.hidden = true;
    });
    this.el.replaceChildren(
      el('div', { class: 'macro-head' }, el('h3', { id: 'h-macro' }, t('macro.title')), hide),
      banner,
      notice,
      manual,
      this.field(
        t('macro.name'),
        this.textInput(this.macro.name, 'macro-name', (name) => {
          this.persist({ ...this.macro, name });
        }),
      ),
      this.field(
        t('macro.qty'),
        this.numInput(this.macro.qty, 'macro-qty', (qty) => this.persist({ ...this.macro, qty })),
      ),
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
      this.renderRun(blind),
      this.renderResult(),
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
    const side = this.select(
      rule.side,
      [
        ['buy', t('pr.buy')],
        ['sell', t('pr.sell')],
      ],
      (value) => this.replaceRule(index, { ...rule, side: value === 'sell' ? 'sell' : 'buy' }),
    );
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
        side,
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
      this.numInput(this.macro.exit.stop.value, 'macro-stop', (value) => {
        this.persist({
          ...this.macro,
          exit: { ...this.macro.exit, stop: { ...this.macro.exit.stop, value } },
        });
      }),
      el('span', {}, t('macro.target')),
      this.select(this.macro.exit.target.mode, targetModes, (mode) => {
        const targetMode: TargetMode =
          mode === 'atr_mult' || mode === 'rr' || mode === 'percent' ? mode : 'ticks';
        this.persist({
          ...this.macro,
          exit: { ...this.macro.exit, target: { ...this.macro.exit.target, mode: targetMode } },
        });
      }),
      this.numInput(this.macro.exit.target.value, 'macro-target', (value) => {
        this.persist({
          ...this.macro,
          exit: { ...this.macro.exit, target: { ...this.macro.exit.target, value } },
        });
      }),
    );
  }

  private renderRun(blind: boolean): HTMLElement {
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
    arm.disabled = blind;
    arm.addEventListener('click', () => {
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
    run.disabled = blind || this.running;
    run.addEventListener('click', () => void this.onRun());
    const reset = el(
      'button',
      { type: 'button', class: 'small ghost', 'data-testid': 'macro-example' },
      t('macro.example'),
    );
    reset.addEventListener('click', () => this.persist(exampleOrbSmaMacro()));
    const wrap = el('div', { class: 'macro-actions' }, arm, from, run, reset);
    if (this.armed) wrap.append(el('p', { class: 'muted small' }, t('macro.armedHint')));
    if (blind) wrap.append(el('p', { class: 'muted small' }, t('macro.blind')));
    if (this.error) wrap.append(el('p', { class: 'down small' }, this.error));
    return wrap;
  }

  private async onRun(): Promise<void> {
    this.running = true;
    this.error = '';
    this.render();
    try {
      const result = await this.hooks.run(this.macro, this.from);
      this.result = result;
    } catch (err) {
      this.error = t('macro.failed', { reason: (err as Error).message });
    } finally {
      this.running = false;
      this.render();
    }
  }

  private renderResult(): HTMLElement {
    const box = el('div', { class: 'macro-result', 'data-testid': 'macro-result' });
    if (!this.result) return box;
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

  private textInput(value: string, testid: string, set: (v: string) => void): HTMLInputElement {
    const input = el('input', { type: 'text', value, 'data-testid': testid }) as HTMLInputElement;
    input.addEventListener('change', () => {
      const next = input.value.trim();
      if (next) set(next);
    });
    return input;
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
