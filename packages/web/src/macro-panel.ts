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
import { getLang, t, type MessageKey } from './i18n.js';
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

const INDICATORS: Condition['type'][] = [
  'orb_break',
  'price_vs_ma',
  'rsi',
  'macd',
  'bb',
  'flat_only',
  'ma_cross',
  'donchian_break',
  'stoch_cross',
  'adx',
  'time_window',
  'day_of_week',
  'min_bars_since_entry',
];

const COND_KEY: Record<Condition['type'], MessageKey> = {
  price_vs_ma: 'macro.ind.ma',
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

interface ReactionOpt {
  id: string;
  key: MessageKey;
}

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

function reactionsOf(type: Condition['type']): readonly ReactionOpt[] {
  switch (type) {
    case 'orb_break':
      return [
        { id: 'up', key: 'macro.react.breakUp' },
        { id: 'down', key: 'macro.react.breakDown' },
        { id: 'either', key: 'cond.either' },
      ];
    case 'price_vs_ma':
      return [
        { id: 'above', key: 'macro.react.priceAbove' },
        { id: 'below', key: 'macro.react.priceBelow' },
      ];
    case 'rsi':
      return [
        { id: 'lt', key: 'macro.react.below' },
        { id: 'gt', key: 'macro.react.above' },
        { id: 'cross_above', key: 'cond.crossAbove' },
        { id: 'cross_below', key: 'cond.crossBelow' },
      ];
    case 'macd':
      return [
        { id: 'hist_pos', key: 'cond.histPos' },
        { id: 'hist_neg', key: 'cond.histNeg' },
        { id: 'cross_bull', key: 'cond.crossBull' },
        { id: 'cross_bear', key: 'cond.crossBear' },
      ];
    case 'bb':
      return [
        { id: 'upper_beyond', key: 'macro.react.bbUp' },
        { id: 'lower_beyond', key: 'macro.react.bbDown' },
        { id: 'upper_touch', key: 'macro.react.bbTouchUp' },
        { id: 'lower_touch', key: 'macro.react.bbTouchDown' },
      ];
    case 'flat_only':
      return [{ id: 'flat', key: 'cond.flat_only' }];
    case 'ma_cross':
      return [
        { id: 'bull', key: 'cond.bull' },
        { id: 'bear', key: 'cond.bear' },
      ];
    case 'donchian_break':
      return [
        { id: 'up', key: 'macro.react.breakUp' },
        { id: 'down', key: 'macro.react.breakDown' },
      ];
    case 'stoch_cross':
      return [
        { id: 'bull', key: 'cond.bull' },
        { id: 'bear', key: 'cond.bear' },
      ];
    case 'adx':
      return [
        { id: 'gt', key: 'macro.react.above' },
        { id: 'lt', key: 'macro.react.below' },
      ];
    case 'time_window':
      return [{ id: 'window', key: 'cond.time_window' }];
    case 'day_of_week':
      return [{ id: 'days', key: 'cond.day_of_week' }];
    case 'min_bars_since_entry':
      return [{ id: 'bars', key: 'cond.cooldown' }];
    default: {
      const leftover: never = type;
      return leftover;
    }
  }
}

function defaultTune(type: Condition['type']): number {
  switch (type) {
    case 'orb_break':
      return 30;
    case 'price_vs_ma':
      return 21;
    case 'rsi':
      return 70;
    case 'donchian_break':
      return 20;
    case 'adx':
      return 20;
    case 'min_bars_since_entry':
      return 5;
    case 'ma_cross':
    case 'bb':
    case 'macd':
    case 'stoch_cross':
    case 'time_window':
    case 'day_of_week':
    case 'flat_only':
      return 0;
    default: {
      const leftover: never = type;
      return leftover;
    }
  }
}

function asIndicator(value: string): Condition['type'] {
  return (INDICATORS as readonly string[]).includes(value)
    ? (value as Condition['type'])
    : 'orb_break';
}

function clampInt(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function positive(n: number, fallback: number): number {
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Build one DSL condition from the indicator → reaction composer. Defaults stay inside the schema. */
export function buildCondition(type: Condition['type'], reaction: string, tune: number): Condition {
  switch (type) {
    case 'orb_break':
      return {
        type,
        minutes: clampInt(tune, 1, 1439, 30),
        direction: reaction === 'down' || reaction === 'either' ? reaction : 'up',
      };
    case 'price_vs_ma':
      return {
        type,
        op: reaction === 'below' ? 'below' : 'above',
        ma: 'sma',
        period: clampInt(tune, 1, 500, 21),
        source: 'close',
      };
    case 'rsi':
      return {
        type,
        op:
          reaction === 'gt' || reaction === 'cross_above' || reaction === 'cross_below'
            ? reaction
            : 'lt',
        level: positive(tune, 70),
        period: 14,
      };
    case 'macd':
      return {
        type,
        event:
          reaction === 'hist_neg' || reaction === 'cross_bull' || reaction === 'cross_bear'
            ? reaction
            : 'hist_pos',
        fast: 12,
        slow: 26,
        signal: 9,
      };
    case 'bb':
      return {
        type,
        which: reaction.startsWith('lower') ? 'lower' : 'upper',
        op: reaction.endsWith('touch') ? 'touch' : 'close_beyond',
        period: 20,
        stdDev: 2,
      };
    case 'flat_only':
      return { type };
    case 'ma_cross':
      return {
        type,
        direction: reaction === 'bear' ? 'bear' : 'bull',
        fast: { ma: 'ema', period: 9 },
        slow: { ma: 'ema', period: 21 },
      };
    case 'donchian_break':
      return {
        type,
        period: clampInt(tune, 1, 500, 20),
        direction: reaction === 'down' ? 'down' : 'up',
      };
    case 'stoch_cross':
      return {
        type,
        direction: reaction === 'bear' ? 'bear' : 'bull',
        kPeriod: 14,
        dPeriod: 3,
        smooth: 3,
        level: 20,
      };
    case 'adx':
      return {
        type,
        op: reaction === 'lt' ? 'lt' : 'gt',
        level: positive(tune, 20),
        period: 14,
        di: 'plus_above',
      };
    case 'time_window':
      return { type, startMinute: 9 * 60 + 30, endMinute: 11 * 60 };
    case 'day_of_week':
      return { type, days: [1, 2, 3, 4, 5] };
    case 'min_bars_since_entry':
      return { type, bars: clampInt(tune, 1, 100_000, 5) };
    default: {
      const leftover: never = type;
      return leftover;
    }
  }
}

function hhmm(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function rsiOpKey(op: 'gt' | 'lt' | 'cross_above' | 'cross_below'): MessageKey {
  switch (op) {
    case 'gt':
      return 'macro.react.above';
    case 'lt':
      return 'macro.react.below';
    case 'cross_above':
      return 'cond.crossAbove';
    case 'cross_below':
      return 'cond.crossBelow';
    default: {
      const leftover: never = op;
      return leftover;
    }
  }
}

function macdKey(event: 'hist_pos' | 'hist_neg' | 'cross_bull' | 'cross_bear'): MessageKey {
  switch (event) {
    case 'hist_pos':
      return 'cond.histPos';
    case 'hist_neg':
      return 'cond.histNeg';
    case 'cross_bull':
      return 'cond.crossBull';
    case 'cross_bear':
      return 'cond.crossBear';
    default: {
      const leftover: never = event;
      return leftover;
    }
  }
}

/** One plain-language sentence for a stored condition. */
export function describeCondition(cond: Condition): string {
  switch (cond.type) {
    case 'orb_break':
      return t('macro.say.orb', {
        n: cond.minutes,
        dir: t(
          cond.direction === 'down'
            ? 'macro.react.breakDown'
            : cond.direction === 'either'
              ? 'cond.either'
              : 'macro.react.breakUp',
        ),
      });
    case 'price_vs_ma':
      return t('macro.say.ma', {
        ma: cond.ma.toUpperCase(),
        n: cond.period,
        dir: t(cond.op === 'below' ? 'macro.react.priceBelow' : 'macro.react.priceAbove'),
      });
    case 'rsi':
      return t('macro.say.rsi', { op: t(rsiOpKey(cond.op)), n: cond.level });
    case 'macd':
      return t('macro.say.macd', { event: t(macdKey(cond.event)) });
    case 'bb':
      return t('macro.say.bb', {
        which: t(
          cond.which === 'lower'
            ? 'cond.lower'
            : cond.which === 'middle'
              ? 'cond.middle'
              : 'cond.upper',
        ),
        op: t(cond.op === 'touch' ? 'cond.touch' : 'cond.closeBeyond'),
      });
    case 'flat_only':
      return t('cond.flat_only');
    case 'ma_cross':
      return t('macro.say.cross', {
        dir: t(cond.direction === 'bear' ? 'cond.bear' : 'cond.bull'),
        fast: cond.fast.period,
        slow: cond.slow.period,
      });
    case 'donchian_break':
      return t('macro.say.don', {
        n: cond.period,
        dir: t(cond.direction === 'down' ? 'macro.react.breakDown' : 'macro.react.breakUp'),
      });
    case 'stoch_cross':
      return t('macro.say.stoch', {
        dir: t(cond.direction === 'bear' ? 'cond.bear' : 'cond.bull'),
      });
    case 'adx':
      return t('macro.say.adx', {
        op: t(cond.op === 'lt' ? 'macro.react.below' : 'macro.react.above'),
        n: cond.level,
      });
    case 'time_window':
      return t('macro.say.time', { start: hhmm(cond.startMinute), end: hhmm(cond.endMinute) });
    case 'day_of_week':
      return t('cond.day_of_week');
    case 'min_bars_since_entry':
      return t('macro.say.cool', { n: cond.bars });
    default: {
      const leftover: never = cond;
      return leftover;
    }
  }
}

const PRESETS: { id: string; key: MessageKey; condition: Condition }[] = [
  { id: 'orb-up', key: 'macro.presetOrb', condition: defaultCondition('orb_break') },
  { id: 'sma', key: 'macro.presetSma', condition: defaultCondition('price_vs_ma') },
  { id: 'flat', key: 'macro.presetFlat', condition: { type: 'flat_only' } },
  { id: 'rsi', key: 'macro.presetRsi', condition: defaultCondition('rsi') },
  { id: 'macd', key: 'macro.presetMacd', condition: defaultCondition('macd') },
  { id: 'bb', key: 'macro.presetBb', condition: defaultCondition('bb') },
];

const MISS_ORDER = [
  'macro.needName',
  'macro.needRule',
  'macro.needQty',
  'macro.needStop',
  'macro.needTarget',
] as const satisfies readonly MessageKey[];

const MISS_SHORT: Partial<Record<MessageKey, MessageKey>> = {
  'macro.needName': 'macro.miss.name',
  'macro.needRule': 'macro.miss.rule',
  'macro.needQty': 'macro.miss.qty',
  'macro.needStop': 'macro.miss.stop',
  'macro.needTarget': 'macro.miss.target',
};

/** Green ready line, or the short list of what is still missing. */
export function macroReadiness(keys: readonly MessageKey[]): { ready: boolean; text: string } {
  const labels: MessageKey[] = [];
  for (const key of MISS_ORDER) {
    if (!keys.includes(key)) continue;
    const label = MISS_SHORT[key];
    if (label) labels.push(label);
  }
  if (labels.length === 0) {
    if (keys.includes('macro.blind')) return { ready: false, text: t('macro.blind') };
    return { ready: true, text: t('macro.ready') };
  }
  const sep = getLang() === 'en' ? ', ' : '／';
  return {
    ready: false,
    text: t('macro.notReady', { items: labels.map((key) => t(key)).join(sep) }),
  };
}

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
  private blindShown: boolean | undefined;
  private lang = '';
  private nameDraft: string | null = null;
  private qtyDraft: string | null = null;
  private stopDraft: string | null = null;
  private targetDraft: string | null = null;
  private indicator: Condition['type'] = 'orb_break';
  private reaction = 'up';
  private tune: string | null = null;
  /** Last follow session hid every condition. The stored rule stays disabled until Add. */
  private cleared = false;
  private lastSide: 'buy' | 'sell' | null = null;

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

  /** Move keyboard focus into the wizard after the chart button opens this tab. */
  focus(): void {
    const target =
      this.el.querySelector<HTMLElement>('[data-testid=macro-show]') ??
      this.el.querySelector<HTMLElement>('[data-testid=macro-indicator]') ??
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

  /** A follow check placed a simulated signal. Step 4 reads this; it does not place orders. */
  noteSignal(side: 'buy' | 'sell'): void {
    if (this.lastSide === side) return;
    this.lastSide = side;
    if (this.step === 2 || this.step === 3) this.render();
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
    if (this.cleared && !missing.includes('macro.needRule')) extra.push('macro.needRule');
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
        return true;
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
    this.el.replaceChildren(el('h3', { id: 'h-macro' }, t('macro.title')), show);
  }

  private renderUnavailable(): void {
    this.el.replaceChildren(
      this.header(),
      el('p', { class: 'macro-ready no', 'data-testid': 'macro-unavailable' }, t('macro.blind')),
    );
  }

  private renderWizard(): void {
    const step = STEPS[this.step]!;
    const body = el('div', { class: 'macro-step', 'data-testid': `macro-step-${step.id}` });
    switch (this.step) {
      case 0:
        body.append(...this.stepRules());
        break;
      case 1:
        body.append(...this.stepTrade());
        break;
      case 2:
        body.append(this.renderRun());
        break;
      case 3:
        body.append(this.renderResult());
        break;
      default: {
        const leftover: never = this.step;
        void leftover;
      }
    }
    if (this.error && this.step !== 3) body.append(el('p', { class: 'down small' }, this.error));
    body.append(this.stepNav());
    this.el.replaceChildren(this.header(), this.stepper(), body);
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
        `${index + 1} ${t(step.key)}`,
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
    }
    if (this.step < 3 && this.stepReady(this.step)) {
      const next = el(
        'button',
        { type: 'button', class: 'primary', 'data-testid': 'macro-next' },
        t('macro.next'),
      );
      next.addEventListener('click', () => this.setStep((this.step + 1) as MacroStep));
      row.append(next);
    }
    return row;
  }

  private readinessBar(): HTMLElement {
    const state = macroReadiness(this.blockers());
    return el(
      'p',
      {
        class: `macro-ready ${state.ready ? 'ok' : 'no'}`,
        'data-testid': 'macro-ready',
        role: 'status',
      },
      state.text,
    );
  }

  private stepRules(): HTMLElement[] {
    const name = el('input', {
      type: 'text',
      value: this.nameDraft ?? this.macro.name,
      'data-testid': 'macro-name',
      'aria-label': t('macro.name'),
    }) as HTMLInputElement;
    name.addEventListener('change', () => this.commitName(name.value));
    const blocked = this.blockers();
    const nodes: HTMLElement[] = [];
    if (blocked.includes('macro.needName') || blocked.includes('macro.needRule')) {
      nodes.push(this.readinessBar());
    }
    nodes.push(
      this.field(t('macro.name'), name),
      this.composer(),
      this.conditionList(),
      this.renderQuick(),
    );
    return nodes;
  }

  private composer(): HTMLElement {
    const options = reactionsOf(this.indicator);
    if (!options.some((opt) => opt.id === this.reaction)) this.reaction = options[0]?.id ?? '';
    const indicator = this.select(
      this.indicator,
      INDICATORS.map((id) => [id, t(COND_KEY[id])]),
      (value) => {
        this.indicator = asIndicator(value);
        this.reaction = reactionsOf(this.indicator)[0]?.id ?? '';
        this.tune = null;
        this.render();
      },
    );
    indicator.dataset.testid = 'macro-indicator';
    indicator.setAttribute('aria-label', t('macro.indicator'));
    const reaction = this.select(
      this.reaction,
      options.map((opt) => [opt.id, t(opt.key)]),
      (value) => {
        this.reaction = value;
        this.render();
      },
    );
    reaction.dataset.testid = 'macro-reaction';
    reaction.setAttribute('aria-label', t('macro.reaction'));
    const row = el('div', { class: 'macro-compose' }, indicator, reaction);
    const fallback = defaultTune(this.indicator);
    if (fallback > 0) {
      const input = el('input', {
        type: 'number',
        step: 'any',
        value: this.tune ?? String(fallback),
        'data-testid': 'macro-tune',
        'aria-label': t('macro.tune'),
      }) as HTMLInputElement;
      input.addEventListener('input', () => {
        this.tune = input.value;
      });
      row.append(input);
    }
    row.append(
      this.button('macro-add', t('macro.add'), () => {
        const raw = this.tune === null || this.tune.trim() === '' ? fallback : Number(this.tune);
        this.addCondition(buildCondition(this.indicator, this.reaction, raw));
      }),
    );
    return row;
  }

  private listed(): { ruleIndex: number; condIndex: number; cond: Condition }[] {
    if (this.cleared) return [];
    const out: { ruleIndex: number; condIndex: number; cond: Condition }[] = [];
    this.macro.rules.forEach((rule, ruleIndex) => {
      if (!rule.enabled) return;
      rule.conditions.forEach((cond, condIndex) => out.push({ ruleIndex, condIndex, cond }));
    });
    return out;
  }

  private conditionList(): HTMLElement {
    const items = this.listed();
    if (items.length === 0) {
      return el(
        'p',
        { class: 'muted small', 'data-testid': 'macro-conditions' },
        t('macro.noConditions'),
      );
    }
    const list = el('ul', { class: 'macro-cond-list', 'data-testid': 'macro-conditions' });
    for (const item of items) {
      const remove = el(
        'button',
        {
          type: 'button',
          class: 'small ghost',
          'data-testid': `macro-remove-${item.ruleIndex}-${item.condIndex}`,
          'aria-label': t('ind.remove'),
        },
        '×',
      );
      remove.addEventListener('click', () => this.removeAt(item.ruleIndex, item.condIndex));
      list.append(el('li', {}, el('span', {}, describeCondition(item.cond)), remove));
    }
    return list;
  }

  private addCondition(cond: Condition): void {
    const first = this.macro.rules[0];
    if (!first) {
      this.cleared = false;
      this.persist({
        ...this.macro,
        rules: [{ id: rid(), priority: 1, enabled: true, side: 'buy', conditions: [cond] }],
      });
      return;
    }
    const live = this.macro.rules.some((rule) => rule.enabled && rule.conditions.length > 0);
    if (this.cleared || !live) {
      this.cleared = false;
      this.persist({
        ...this.macro,
        rules: [{ ...first, enabled: true, conditions: [cond] }],
      });
      return;
    }
    const target = Math.max(
      0,
      this.macro.rules.findIndex((rule) => rule.enabled),
    );
    this.persist({
      ...this.macro,
      rules: this.macro.rules.map((rule, index) =>
        index === target
          ? { ...rule, enabled: true, conditions: [...rule.conditions, cond] }
          : rule,
      ),
    });
  }

  private removeAt(ruleIndex: number, condIndex: number): void {
    const rule = this.macro.rules[ruleIndex];
    if (!rule) return;
    const conditions = rule.conditions.filter((_, index) => index !== condIndex);
    if (conditions.length > 0) {
      this.replaceRule(ruleIndex, { ...rule, conditions });
      return;
    }
    const rules = this.macro.rules.filter((_, index) => index !== ruleIndex);
    if (rules.length > 0) {
      this.persist({ ...this.macro, rules });
      return;
    }
    this.cleared = true;
    if (this.armed) {
      this.armed = false;
      this.hooks.onArmed(false);
    }
    this.persist({ ...this.macro, rules: [{ ...rule, enabled: false }] });
  }

  private renderQuick(): HTMLElement {
    const row = el('div', { class: 'macro-presets', 'data-testid': 'macro-quick' });
    row.append(el('span', { class: 'muted small' }, t('macro.quick')));
    for (const preset of PRESETS) {
      const b = el(
        'button',
        { type: 'button', class: 'small ghost', 'data-testid': `macro-preset-${preset.id}` },
        t(preset.key),
      );
      b.addEventListener('click', () => this.addCondition(preset.condition));
      row.append(b);
    }
    return row;
  }

  private stepTrade(): HTMLElement[] {
    const nodes: HTMLElement[] = [];
    if (!macroReadiness(this.blockers()).ready) nodes.push(this.readinessBar());
    nodes.push(this.field(t('macro.qty'), this.qtyField()));
    this.macro.rules.forEach((rule, index) => {
      if (rule.enabled) nodes.push(this.renderSide(rule, index));
    });
    nodes.push(
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
    );
    return nodes;
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
    side.setAttribute('aria-label', t('macro.side'));
    return el(
      'div',
      { class: 'macro-rule-head' },
      el('span', {}, rule.conditions.map((cond) => describeCondition(cond)).join(' · ')),
      side,
    );
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
    const blocked = this.blockers().length > 0;
    const wrap = el('div', { class: 'macro-actions' });
    wrap.append(this.readinessBar());
    if (this.armed) {
      wrap.append(
        el(
          'p',
          { class: 'macro-follow', 'data-testid': 'macro-follow-status' },
          t('macro.armedHint'),
        ),
      );
    }
    const backtest = el('div', { class: 'macro-run-block', 'data-testid': 'macro-backtest' });
    backtest.append(el('h4', {}, t('macro.run')), this.fromSeg(), this.runButton(blocked));
    const follow = el('div', { class: 'macro-run-block', 'data-testid': 'macro-follow' });
    follow.append(el('h4', {}, t('macro.arm')), this.armButton(blocked));
    wrap.append(
      backtest,
      follow,
      el('p', { class: 'muted small' }, t('macro.modeHint')),
      el('div', { class: 'macro-example-row' }, this.exampleButton()),
    );
    return wrap;
  }

  private fromSeg(): HTMLElement {
    const seg = el('div', { class: 'macro-seg', role: 'group', 'aria-label': t('macro.run') });
    const make = (id: 'start' | 'cursor', key: MessageKey) => {
      const button = el(
        'button',
        {
          type: 'button',
          'aria-pressed': String(this.from === id),
          'data-testid': `macro-from-${id}`,
        },
        t(key),
      );
      button.addEventListener('click', () => {
        this.from = id;
        this.render();
      });
      return button;
    };
    seg.append(make('start', 'macro.fromStart'), make('cursor', 'macro.fromCursor'));
    return seg;
  }

  private runButton(blocked: boolean): HTMLButtonElement {
    const run = el(
      'button',
      { type: 'button', class: 'primary', 'data-testid': 'macro-run' },
      t(this.running ? 'macro.running' : 'macro.run'),
    );
    run.classList.toggle('is-blocked', blocked);
    if (blocked) run.setAttribute('aria-disabled', 'true');
    run.disabled = this.running;
    run.addEventListener('click', () => void this.onRun());
    return run;
  }

  private armButton(blocked: boolean): HTMLButtonElement {
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
    arm.classList.toggle('is-blocked', blocked);
    if (blocked) arm.setAttribute('aria-disabled', 'true');
    arm.addEventListener('click', () => {
      if (this.blockers().length > 0) {
        this.jumpToMissing();
        return;
      }
      this.armed = !this.armed;
      if (this.armed) this.lastSide = null;
      this.hooks.onArmed(this.armed);
      this.render();
    });
    return arm;
  }

  private async onRun(): Promise<void> {
    if (this.blockers().length > 0) {
      this.jumpToMissing();
      return;
    }
    this.running = true;
    this.error = '';
    this.render();
    try {
      const result = await this.hooks.run(this.macro, this.from);
      this.result = result;
      this.step = 3;
    } catch (err) {
      this.result = undefined;
      this.error = t('macro.failed', { reason: (err as Error).message });
      this.step = 3;
    } finally {
      this.running = false;
      this.render();
    }
  }

  private jumpToMissing(): void {
    const keys = this.blockers();
    const first = MISS_ORDER.find((key) => keys.includes(key));
    if (first === 'macro.needName' || first === 'macro.needRule') this.step = 0;
    else if (first) this.step = 1;
    this.render();
    const id =
      first === 'macro.needName'
        ? 'macro-name'
        : first === 'macro.needRule'
          ? 'macro-indicator'
          : first === 'macro.needQty'
            ? 'macro-qty'
            : first === 'macro.needStop'
              ? 'macro-stop'
              : first === 'macro.needTarget'
                ? 'macro-target'
                : '';
    if (id) this.el.querySelector<HTMLElement>(`[data-testid=${id}]`)?.focus();
  }

  private renderResult(): HTMLElement {
    const box = el('div', { class: 'macro-result', 'data-testid': 'macro-result' });
    if (this.armed) {
      box.append(
        el('p', { 'data-testid': 'macro-follow-status' }, t('macro.armedHint')),
        el('p', { 'data-testid': 'macro-last-signal' }, this.lastSignalText()),
      );
    } else if (this.lastSide) {
      box.append(el('p', { 'data-testid': 'macro-last-signal' }, this.lastSignalText()));
    }
    if (this.error && !this.result) {
      box.append(el('p', { class: 'down', 'data-testid': 'macro-error' }, this.error));
      return box;
    }
    if (!this.result) {
      box.append(el('p', { class: 'macro-zero-count' }, t('macro.noResult')));
      const go = el('button', { type: 'button', 'data-testid': 'macro-go-run' }, t('macro.goRun'));
      go.addEventListener('click', () => this.setStep(2));
      box.append(go);
      return box;
    }
    const stats = this.result.stats;
    if (stats.trades === 0) {
      const hasOrb = this.macro.rules.some(
        (r) => r.enabled && r.conditions.some((c) => c.type === 'orb_break'),
      );
      box.append(
        el('p', { class: 'macro-zero-count', 'data-testid': 'macro-zero' }, t('macro.zero')),
        el('p', {}, t('macro.zeroWhy')),
        ...(hasOrb
          ? [el('p', { class: 'muted', 'data-testid': 'macro-zero-orb' }, t('macro.zeroWhyOrb'))]
          : []),
      );
      const edit = el(
        'button',
        { type: 'button', 'data-testid': 'macro-edit-conditions' },
        t('macro.editConditions'),
      );
      edit.addEventListener('click', () => this.setStep(0));
      box.append(
        edit,
        this.stat(t('macro.signals'), String(this.result.signals)),
        this.stat(t('macro.bars'), String(this.result.barsProcessed)),
      );
      return box;
    }
    box.append(
      this.stat(t('macro.trades'), String(stats.trades)),
      this.stat(t('macro.winRate'), fmtPct(stats.winRate)),
      this.stat(t('macro.net'), fmtMoney(stats.netPnl)),
      this.stat(t('macro.maxDd'), fmtMoney(stats.maxDrawdown)),
      this.stat(t('macro.signals'), String(this.result.signals)),
      this.stat(t('macro.bars'), String(this.result.barsProcessed)),
      this.stat(t('macro.openQty'), String(this.result.openQty)),
    );
    return box;
  }

  private lastSignalText(): string {
    if (!this.lastSide) return t('macro.notTriggered');
    return t('macro.lastSignal', {
      side: t(this.lastSide === 'sell' ? 'pr.sell' : 'pr.buy'),
    });
  }

  private stat(label: string, value: string): HTMLElement {
    return el('div', { class: 'macro-stat' }, el('span', {}, label), el('b', {}, value));
  }

  private replaceRule(index: number, rule: MacroRule): void {
    const rules = this.macro.rules.map((item, i) => (i === index ? rule : item));
    this.persist({ ...this.macro, rules });
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
      this.cleared = false;
      this.tune = null;
      this.persist(exampleOrbSmaMacro());
    });
    return reset;
  }

  private commitName(raw: string): void {
    const name = raw.trim();
    if (name.length < 1 || name.length > 80) {
      this.nameDraft = raw;
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
