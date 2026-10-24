// SPDX-License-Identifier: AGPL-3.0-or-later
// Rule profiles in the UI: the live rule-check card on the practice rail and the profile
// manager (list, editor, import/export) opened from the library.

import {
  evaluateProfile,
  profileIssues,
  type RuleId,
  type RuleProfile,
  type RuleResult,
  type SessionSettings,
  type SessionState,
} from '@candledrill/core';
import { t, type MessageKey } from './i18n.js';
import { el, fmtMoney, fmtTime, toast } from './format.js';
import { importProfile, newProfile, readProfiles, writeProfiles } from './settings.js';

const RULE_LABEL: Record<RuleId, MessageKey> = {
  profitTarget: 'v1.ruleProfitTarget',
  dailyLoss: 'v1.ruleDailyLoss',
  maxLoss: 'v1.ruleMaxLoss',
  consistency: 'v1.ruleConsistency',
  minTradingDays: 'v1.ruleMinTradingDays',
  maxTradingDays: 'v1.ruleMaxTradingDays',
  minProfitDays: 'v1.ruleMinProfitDays',
  maxContracts: 'v1.ruleMaxContracts',
  flatBy: 'v1.ruleFlatBy',
  noOvernight: 'v1.ruleNoOvernight',
  maxTradesPerDay: 'v1.ruleMaxTradesPerDay',
  maxConsecutiveLosses: 'v1.ruleMaxConsecutiveLosses',
};
const MONEY_RULES = new Set<RuleId>(['profitTarget', 'dailyLoss', 'maxLoss']);

/** Whole currency in the rule card: the column is narrow and cents add nothing to a limit. */
const money0 = (x: number) => Math.round(x).toLocaleString(undefined, { maximumFractionDigits: 0 });

function valueText(r: RuleResult): string {
  const v = (x: number | null) =>
    x === null ? '–' : MONEY_RULES.has(r.id) ? money0(x) : String(x);
  if (r.id === 'consistency') return r.value === null ? '–' : `${r.value}% / ${r.limit}%`;
  if (r.id === 'flatBy') {
    const m = r.limit ?? 0;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  }
  if (r.id === 'noOvernight') return '–';
  return `${v(r.value)} / ${v(r.limit)}`;
}

/** Fraction 0..1 for the meter, or null when the rule has no meaningful progress bar. */
function meter(r: RuleResult): number | null {
  if (r.value === null || r.limit === null || r.limit <= 0) return null;
  if (r.id === 'flatBy' || r.id === 'noOvernight') return null;
  return Math.max(0, Math.min(1, r.value / r.limit));
}

/** Live rule check on the practice rail. */
export class RulesView {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private profile: RuleProfile | null = null;

  constructor() {
    this.body = el('div', { 'data-testid': 'rule-check' });
    this.el = el(
      'section',
      { class: 'card rule-check' },
      el('h3', { 'data-i18n': 'v1.rulesPanel' }, t('v1.rulesPanel')),
      this.body,
    );
  }

  setProfile(p: RuleProfile | null): void {
    this.profile = p;
  }

  render(settings: SessionSettings, state: SessionState, cursorTime: number): void {
    if (!this.profile) {
      this.body.replaceChildren(el('p', { class: 'muted small' }, t('v1.rulesPanelNone')));
      return;
    }
    const rep = evaluateProfile(
      this.profile,
      settings,
      state,
      { utcOffsetMinutes: settings.utcOffsetMinutes, dayStartMinutes: settings.dayStartMinutes },
      cursorTime,
    );
    const overallKey: MessageKey =
      rep.overall === 'pass'
        ? 'v1.overallPass'
        : rep.overall === 'fail'
          ? 'v1.overallFail'
          : 'v1.overallPending';
    const rows = rep.results.map((r) => {
      // Limits (loss, contracts, time…) read "within limit" while not broken; goals read "met".
      const isGoal =
        r.id === 'profitTarget' ||
        r.id === 'consistency' ||
        r.id === 'minTradingDays' ||
        r.id === 'minProfitDays';
      const stKey: MessageKey =
        r.state === 'fail'
          ? 'v1.ruleFail'
          : r.state === 'pending'
            ? 'v1.rulePending'
            : isGoal
              ? 'v1.rulePass'
              : 'v1.ruleOk';
      const f = meter(r);
      const near = !isGoal && f !== null && f >= 0.75 && r.state !== 'fail';
      return el(
        'li',
        {
          class: `rule ${r.state} ${isGoal ? 'goal' : 'limit'}${near ? ' near' : ''}`,
          'data-rule': r.id,
          'data-state': r.state,
        },
        el(
          'div',
          { class: 'rule-head' },
          el('span', { class: 'rule-name' }, t(RULE_LABEL[r.id])),
          el('span', { class: 'rule-val num' }, valueText(r)),
          el('span', { class: `rule-state ${r.state}` }, t(stKey)),
        ),
        ...(f === null
          ? []
          : [
              el(
                'div',
                { class: 'meter' },
                el('span', { style: `width:${(f * 100).toFixed(1)}%` }),
              ),
            ]),
        ...(r.brokenAt !== undefined
          ? [
              el(
                'div',
                { class: 'muted small' },
                t('v1.brokenAt', { time: fmtTime(r.brokenAt, settings.utcOffsetMinutes) }),
              ),
            ]
          : []),
      );
    });
    this.body.replaceChildren(
      el(
        'div',
        { class: `rule-overall ${rep.overall}`, 'data-testid': 'rule-overall' },
        el('strong', {}, this.profile.name),
        el('span', {}, t(overallKey)),
      ),
      el('ul', { class: 'rule-list' }, ...rows),
      el('p', { class: 'muted small' }, t('v1.reportNote')),
    );
  }
}

// ------------------------------------------------------------------ profile manager
type NumField =
  | 'accountSize'
  | 'profitTarget'
  | 'dailyLoss'
  | 'maxLoss'
  | 'consistencyPct'
  | 'minTradingDays'
  | 'maxTradingDays'
  | 'minProfitDays'
  | 'minProfitDayAmount'
  | 'maxContracts'
  | 'maxTradesPerDay'
  | 'maxConsecutiveLosses';

const FIELDS: { key: NumField; label: MessageKey; step: string; required?: boolean }[] = [
  { key: 'accountSize', label: 'v1.pAccount', step: 'any', required: true },
  { key: 'profitTarget', label: 'v1.pTarget', step: 'any' },
  { key: 'dailyLoss', label: 'v1.pDailyLoss', step: 'any' },
  { key: 'maxLoss', label: 'v1.pMaxLoss', step: 'any' },
  { key: 'consistencyPct', label: 'v1.pConsistency', step: 'any' },
  { key: 'minTradingDays', label: 'v1.pMinDays', step: '1' },
  { key: 'maxTradingDays', label: 'v1.pMaxDays', step: '1' },
  { key: 'minProfitDays', label: 'v1.pProfitDays', step: '1' },
  { key: 'minProfitDayAmount', label: 'v1.pProfitDayMin', step: 'any' },
  { key: 'maxContracts', label: 'v1.pMaxContracts', step: '1' },
  { key: 'maxTradesPerDay', label: 'v1.pMaxTradesDay', step: '1' },
  { key: 'maxConsecutiveLosses', label: 'v1.pMaxLosses', step: '1' },
];

function download(name: string, text: string): void {
  const a = el('a', {
    href: URL.createObjectURL(new Blob([text], { type: 'application/json' })),
    download: name,
  });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** Library card listing the user's profiles plus a dialog editor. */
export class ProfileManager {
  readonly el: HTMLElement;
  private readonly list: HTMLElement;
  private readonly dialog: HTMLDialogElement;
  private readonly form: HTMLFormElement;
  private readonly issues: HTMLElement;
  private editing: RuleProfile | null = null;

  constructor(private readonly onChange: (profiles: RuleProfile[]) => void) {
    this.list = el('ul', { class: 'profile-list', 'data-testid': 'profile-list' });
    const add = el(
      'button',
      {
        type: 'button',
        class: 'primary small',
        'data-testid': 'profile-new',
        'data-i18n': 'v1.profileNew',
      },
      t('v1.profileNew'),
    );
    add.addEventListener('click', () => this.edit(newProfile(t('v1.profileNew'))));
    const file = el('input', { type: 'file', accept: '.json,application/json', hidden: '' });
    const imp = el(
      'button',
      {
        type: 'button',
        class: 'small',
        'data-testid': 'profile-import',
        'data-i18n': 'v1.profileImport',
      },
      t('v1.profileImport'),
    );
    imp.addEventListener('click', () => file.click());
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      file.value = '';
      if (!f) return;
      const all = readProfiles();
      const r = importProfile(await f.text(), all);
      if (!r.profile) {
        toast(t('v1.profileBad', { reason: r.issues.slice(0, 3).join(' · ') }), 'error');
        return;
      }
      this.save([...all, r.profile]);
      toast(t('v1.profileSaved'));
    });
    this.el = el(
      'section',
      { class: 'card', 'data-testid': 'profiles-card' },
      el('h2', { 'data-i18n': 'v1.profiles' }, t('v1.profiles')),
      el('p', { class: 'muted small', 'data-i18n': 'v1.profilesHint' }, t('v1.profilesHint')),
      this.list,
      el('div', { class: 'row', style: 'margin-top:8px' }, add, imp, file),
    );

    this.issues = el('div', { class: 'issues', 'aria-live': 'polite' });
    this.form = el('form', { method: 'dialog', class: 'profile-form' });
    this.dialog = el(
      'dialog',
      {
        'data-testid': 'profile-dialog',
        'aria-label': t('v1.profiles'),
        'data-i18n-aria': 'v1.profiles',
      },
      this.form,
    ) as HTMLDialogElement;
    document.body.append(this.dialog);
    this.render();
  }

  private save(all: RuleProfile[]): void {
    writeProfiles(all);
    this.render();
    this.onChange(all);
  }

  render(): void {
    const all = readProfiles();
    this.list.replaceChildren(
      ...all.map((p) => {
        const edit = el(
          'button',
          { type: 'button', class: 'small', 'data-i18n': 'v1.profileEdit' },
          t('v1.profileEdit'),
        );
        edit.addEventListener('click', () => this.edit(p));
        const exp = el(
          'button',
          { type: 'button', class: 'small ghost', 'data-i18n': 'v1.profileExport' },
          t('v1.profileExport'),
        );
        exp.addEventListener('click', () =>
          download(
            `candledrill-rules-${p.name.replace(/[^A-Za-z0-9_-]+/g, '_')}.json`,
            JSON.stringify(p, null, 2),
          ),
        );
        const del = el(
          'button',
          { type: 'button', class: 'small ghost', 'data-i18n': 'v1.profileDelete' },
          t('v1.profileDelete'),
        );
        del.addEventListener('click', () => {
          if (!confirm(t('v1.profileDeleteConfirm'))) return;
          this.save(readProfiles().filter((x) => x.id !== p.id));
        });
        const facts = [
          fmtMoney(p.accountSize),
          p.profitTarget !== null ? `${t('v1.ruleProfitTarget')} ${fmtMoney(p.profitTarget)}` : '',
          p.maxLoss !== null ? `${t('v1.ruleMaxLoss')} ${fmtMoney(p.maxLoss)}` : '',
        ].filter(Boolean);
        return el(
          'li',
          { 'data-testid': `profile-${p.id}` },
          el('div', { class: 'title' }, p.name),
          el('div', { class: 'muted small' }, facts.join(' · ')),
          el('div', { class: 'row' }, edit, exp, del),
        );
      }),
    );
  }

  private edit(p: RuleProfile): void {
    this.editing = p;
    const input = (key: NumField, step: string, required?: boolean) => {
      const v = p[key];
      return el('input', {
        name: key,
        type: 'number',
        min: '0',
        step,
        inputmode: step === '1' ? 'numeric' : 'decimal',
        ...(v !== null ? { value: String(v) } : {}),
        ...(required ? { required: '' } : {}),
      });
    };
    const mode = el('select', { name: 'maxLossMode' });
    for (const [v, k] of [
      ['eod', 'ns.trailingModeEod'],
      ['intraday', 'ns.trailingModeIntraday'],
      ['close', 'ns.trailingModeClose'],
      ['static', 'ns.trailingModeStatic'],
    ] as const)
      mode.append(el('option', { value: v }, t(k)));
    mode.value = p.maxLossMode;
    const flatBy = el('input', {
      name: 'flatBy',
      type: 'time',
      ...(p.flatBy ? { value: p.flatBy } : {}),
    });
    const overnight = el('input', { name: 'noOvernight', type: 'checkbox' });
    overnight.checked = p.noOvernight;
    const name = el('input', { name: 'name', maxlength: '60', required: '', value: p.name });
    const note = el('textarea', { name: 'note', maxlength: '2000', rows: '2' });
    note.value = p.note ?? '';
    const field = (label: MessageKey, ctl: HTMLElement) =>
      el('label', { class: 'field' }, el('span', {}, t(label)), ctl);
    const save = el(
      'button',
      { type: 'submit', class: 'primary', 'data-testid': 'profile-save' },
      t('v1.profileSave'),
    );
    const cancel = el('button', { type: 'button' }, t('v1.profileCancel'));
    cancel.addEventListener('click', () => this.dialog.close());
    this.form.replaceChildren(
      el('h2', {}, t('v1.profiles')),
      el('p', { class: 'muted small' }, t('v1.profilesHint')),
      el('div', { class: 'grid2' }, field('v1.profileName', name), field('v1.pMaxLossMode', mode)),
      el(
        'div',
        { class: 'grid3', style: 'margin-top:8px' },
        ...FIELDS.map((f) => field(f.label, input(f.key, f.step, f.required))),
        field('v1.pFlatBy', flatBy),
        el(
          'label',
          { class: 'row', style: 'align-self:end' },
          overnight,
          el('span', {}, t('v1.pNoOvernight')),
        ),
      ),
      el('p', { class: 'muted small' }, t('v1.pBlank')),
      field('v1.profileNote', note),
      this.issues,
      el('div', { class: 'row', style: 'justify-content:flex-end;margin-top:12px' }, cancel, save),
    );
    this.issues.replaceChildren();
    this.form.onsubmit = (e) => {
      e.preventDefault();
      const fd = new FormData(this.form);
      const num = (k: string) => {
        const v = String(fd.get(k) ?? '').trim();
        return v === '' ? null : Number(v);
      };
      const next: RuleProfile = {
        ...this.editing!,
        name: String(fd.get('name') ?? '').trim(),
        accountSize: num('accountSize') ?? 0,
        profitTarget: num('profitTarget'),
        dailyLoss: num('dailyLoss'),
        maxLoss: num('maxLoss'),
        maxLossMode: String(fd.get('maxLossMode')) as RuleProfile['maxLossMode'],
        consistencyPct: num('consistencyPct'),
        minTradingDays: num('minTradingDays'),
        maxTradingDays: num('maxTradingDays'),
        minProfitDays: num('minProfitDays'),
        minProfitDayAmount: num('minProfitDayAmount'),
        maxContracts: num('maxContracts'),
        flatBy: String(fd.get('flatBy') ?? '') || null,
        noOvernight: overnight.checked,
        maxTradesPerDay: num('maxTradesPerDay'),
        maxConsecutiveLosses: num('maxConsecutiveLosses'),
      };
      const n = String(fd.get('note') ?? '').trim();
      const clean = n ? { ...next, note: n } : (({ note: _n, ...rest }) => (void _n, rest))(next);
      const problems = profileIssues(clean);
      if (problems.length) {
        this.issues.replaceChildren(...problems.map((x) => el('div', {}, x)));
        return;
      }
      const all = readProfiles();
      const i = all.findIndex((x) => x.id === clean.id);
      if (i >= 0) all[i] = clean as RuleProfile;
      else all.push(clean as RuleProfile);
      this.save(all);
      this.dialog.close();
      toast(t('v1.profileSaved'));
    };
    this.dialog.showModal();
  }
}
