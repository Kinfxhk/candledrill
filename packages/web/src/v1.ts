// SPDX-License-Identifier: AGPL-3.0-or-later
// v1 shell: settings dialog, rule-profile card and picker on the new-session form,
// recommendations + disclosure (About), browser-build notice.

import { profileToSettings, type RuleProfile } from '@candledrill/core';
import { BROWSER_BACKEND } from './api.js';
import { getLang, t } from './i18n.js';
import { el, toast } from './format.js';
import { ProfileManager } from './rules-view.js';
import {
  DEFAULT_SETTINGS,
  getSettings,
  loadSettings,
  readProfiles,
  saveSettings,
  type UiSettings,
} from './settings.js';

export const REFERRAL_URL = 'https://linktr.ee/kinfx';

// ------------------------------------------------------------------ settings dialog
export function mountSettings(button: HTMLElement): void {
  const dialog = el('dialog', {
    'data-testid': 'settings-dialog',
    'aria-labelledby': 'settings-title',
  }) as HTMLDialogElement;
  document.body.append(dialog);
  const render = () => {
    const s = getSettings();
    const color = (name: 'upColor' | 'downColor', fallbackVar: string) => {
      const v =
        s[name] || getComputedStyle(document.documentElement).getPropertyValue(fallbackVar).trim();
      return el('input', { type: 'color', name, value: /^#[0-9a-f]{6}$/i.test(v) ? v : '#26a69a' });
    };
    const check = (name: keyof UiSettings, on: boolean) => {
      const c = el('input', { type: 'checkbox', name });
      c.checked = on;
      return c;
    };
    const num = (name: 'defaultSl' | 'defaultTp', v: number | null) =>
      el('input', {
        type: 'number',
        name,
        min: '1',
        step: '1',
        inputmode: 'numeric',
        ...(v ? { value: String(v) } : {}),
      });
    const presets = el('input', {
      name: 'qtyPresets',
      value: s.qtyPresets.join(', '),
      inputmode: 'numeric',
    });
    const field = (label: string, ctl: HTMLElement) =>
      el('label', { class: 'field' }, el('span', {}, label), ctl);
    const row = (ctl: HTMLElement, label: string) =>
      el('label', { class: 'row' }, ctl, el('span', {}, label));
    const form = el('form', { method: 'dialog' });
    const reset = el('button', { type: 'button', class: 'ghost' }, t('v1.setReset'));
    reset.addEventListener('click', () => {
      saveSettings(DEFAULT_SETTINGS);
      render();
      toast(t('v1.setSaved'));
    });
    const exp = el('button', { type: 'button', class: 'ghost' }, t('v1.setExport'));
    exp.addEventListener('click', () => {
      const a = el('a', {
        href: URL.createObjectURL(
          new Blob([JSON.stringify(getSettings(), null, 2)], { type: 'application/json' }),
        ),
        download: 'candledrill-settings.json',
      });
      document.body.append(a);
      a.click();
      a.remove();
    });
    const file = el('input', { type: 'file', accept: '.json,application/json', hidden: '' });
    const imp = el('button', { type: 'button', class: 'ghost' }, t('v1.setImport'));
    imp.addEventListener('click', () => file.click());
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (!f) return;
      saveSettings(loadSettings(await f.text()));
      render();
      toast(t('v1.setSaved'));
    });
    const close = el(
      'button',
      { type: 'submit', class: 'primary', 'data-testid': 'settings-save' },
      t('about.close'),
    );
    form.append(
      el('h2', { id: 'settings-title' }, t('v1.settingsTitle')),
      el('h3', {}, t('v1.setCandles')),
      el(
        'div',
        { class: 'grid3' },
        field(t('v1.setUp'), color('upColor', '--up')),
        field(t('v1.setDown'), color('downColor', '--down')),
      ),
      el(
        'div',
        { class: 'row', style: 'margin-top:8px' },
        row(check('grid', s.grid), t('v1.setGrid')),
        row(check('volume', s.volume), t('v1.setVolume')),
      ),
      el('h3', {}, t('v1.setTicket')),
      el(
        'div',
        { class: 'grid3' },
        field(t('v1.setQtyPresets'), presets),
        field(t('v1.setDefaultSl'), num('defaultSl', s.defaultSl)),
        field(t('v1.setDefaultTp'), num('defaultTp', s.defaultTp)),
      ),
      el(
        'div',
        { class: 'row', style: 'margin-top:8px' },
        row(check('confirmFlatten', s.confirmFlatten), t('v1.setConfirm')),
      ),
      el('h3', {}, t('v1.setHotkeys')),
      el('p', { class: 'muted small keys' }, t('v1.keysList')),
      el(
        'div',
        { class: 'row', style: 'justify-content:space-between;margin-top:12px' },
        el('div', { class: 'row' }, reset, exp, imp, file),
        close,
      ),
    );
    form.addEventListener('submit', () => {
      const fd = new FormData(form);
      const n = (k: string) => {
        const v = String(fd.get(k) ?? '').trim();
        return v === '' ? null : Number(v);
      };
      saveSettings({
        upColor: String(fd.get('upColor') ?? ''),
        downColor: String(fd.get('downColor') ?? ''),
        grid: fd.get('grid') === 'on',
        volume: fd.get('volume') === 'on',
        qtyPresets: String(fd.get('qtyPresets') ?? '')
          .split(/[,\s]+/)
          .map(Number)
          .filter((x) => Number.isInteger(x) && x > 0),
        defaultSl: n('defaultSl'),
        defaultTp: n('defaultTp'),
        confirmFlatten: fd.get('confirmFlatten') === 'on',
      });
      toast(t('v1.setSaved'));
    });
    dialog.replaceChildren(form);
  };
  button.addEventListener('click', () => {
    render();
    dialog.showModal();
  });
}

// ------------------------------------------------------------------ rule profiles in the library
export function mountProfiles(
  container: HTMLElement,
  form: HTMLFormElement,
): () => RuleProfile | null {
  const picker = el('select', { name: 'ruleProfile', 'data-testid': 'ns-profile' });
  const fill = () => {
    const keep = picker.value;
    picker.replaceChildren(el('option', { value: '' }, t('v1.profileNone')));
    for (const p of readProfiles()) picker.append(el('option', { value: p.id }, p.name));
    picker.value = readProfiles().some((p) => p.id === keep) ? keep : '';
  };
  const manager = new ProfileManager(() => fill());
  container.append(manager.el);
  fill();
  // Picking a profile fills the engine rule fields of the form (still editable).
  picker.addEventListener('change', () => {
    const p = readProfiles().find((x) => x.id === picker.value);
    if (!p) return;
    const s = profileToSettings(p);
    const set = (name: string, v: number | string | null) => {
      const input = form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null;
      if (input) input.value = v === null ? '' : String(v);
    };
    set('balance', s.startingBalance);
    set('dailyLoss', s.dailyLossLimit);
    set('trailing', s.trailingDrawdown);
    set('trailingMode', s.trailingDrawdownMode);
    set('target', s.profitTarget);
  });
  const grid = form.querySelector('.grid3');
  grid?.prepend(
    el(
      'label',
      { class: 'field' },
      el('span', { 'data-i18n': 'v1.profiles' }, t('v1.profiles')),
      picker,
    ),
  );
  return () => readProfiles().find((x) => x.id === picker.value) ?? null;
}

// ------------------------------------------------------------------ recommendations + disclosure
const LONG_DISCLOSURE: Record<'en' | 'zh-Hant', string[]> = {
  en: [
    'Independence — Free, open-source; demo data is synthetic. Affiliate links do not affect the software, demo data or rule evaluation.',
    'Commission — Some links are affiliate/referral links (simulated evaluations, brokers, platforms, tools). I may receive a commission or reward; it is paid by the other side, and the price you pay is whatever their checkout shows. Commission does not change my assessment; negative findings are published either way.',
    'Simulated accounts — Evaluation accounts, and most “funded” accounts, are simulated: not real capital, not real fills. Separate real-account arrangements require review and are not guaranteed.',
    'Results and payouts — Synthetic demo data only; results exclude real slippage, commissions, latency and liquidity. Simulated or past performance does not indicate future results. Passing, funding, payouts and the firm staying in business are not guaranteed.',
    'No licence, no advice, risk — I am not licensed by the Hong Kong SFC. Nothing here is investment advice, an offer or a solicitation. Futures, leveraged products and CFDs can lose all your capital quickly, and more. Availability, including in Hong Kong, is not promised; check your own eligibility.',
  ],
  'zh-Hant': [
    '獨立性　CandleDrill 免費、開源，內建示範數據為合成數據。推薦連結不影響功能、示範數據或規則判定。',
    '佣金關係　部分外部連結為聯盟或推薦連結（prop firm 模擬評估、券商、平台、工具）。你經連結註冊或購買，我可能取得佣金或推薦獎勵；佣金由對方支付，你應付金額與優惠以對方結帳頁當時顯示為準。有無佣金不影響評價，負面發現照樣公開。',
    '模擬帳戶　「評估／考試」帳戶，以及多數公司所稱「已資助（funded）」，都是模擬帳戶，非真實資金、非真實成交。部分公司另有真實帳戶安排，須另行審核，不保證批核。',
    '成績與出金　本工具只用合成示範數據；即使載入你的規則檔，結果只反映該數據與你的操作，不含真實滑價、佣金、延遲、流動性。模擬或過往表現不代表將來。通過評估、獲資助、出金、公司持續營運均無保證；公司可改規則、拒出金或結業，我無法控制或代追。',
    '非持牌、非建議、風險　我不是香港證監會持牌人。本頁及本工具內容非投資建議、非要約、非招攬。期貨、槓桿及差價合約可迅速損失全部本金，甚至超過本金。產品不一定在所有地區（包括香港）可用，資格須自行確認。本頁不針對任何司法管轄區居民招攬；連結及條款會變，不保證長期有效。',
  ],
};

export function mountRecommendations(aboutDialog: HTMLElement): void {
  const lang = getLang() === 'zh-Hant' || getLang() === 'zh-Hans' ? 'zh-Hant' : 'en';
  const link = el(
    'a',
    {
      href: REFERRAL_URL,
      target: '_blank',
      rel: 'noopener noreferrer sponsored',
      class: 'button',
      'data-testid': 'referral-link',
    },
    t('v1.linksOpen'),
  );
  const details = el(
    'details',
    { class: 'disclosure', 'data-testid': 'disclosure' },
    el('summary', {}, t('v1.linksMore')),
    ...LONG_DISCLOSURE[lang].map((p) => el('p', { class: 'small' }, p)),
    el('p', { class: 'muted small' }, t('v1.linksUpdated')),
  );
  const section = el(
    'section',
    { id: 'affiliate', class: 'recommend', 'data-testid': 'recommendations' },
    el('h3', {}, t('v1.links')),
    el('p', { class: 'small' }, t('v1.linksShort')),
    el('div', { class: 'row' }, link),
    details,
  );
  const close = aboutDialog.querySelector('form[method=dialog]');
  aboutDialog.insertBefore(section, close);
}

export function mountFooterLink(footer: HTMLElement, about: HTMLDialogElement): void {
  const a = el(
    'a',
    { href: '#affiliate', class: 'footer-recommend', 'data-testid': 'footer-recommend' },
    t('v1.links'),
  );
  a.addEventListener('click', (e) => {
    e.preventDefault();
    about.showModal();
    about.querySelector('#affiliate')?.scrollIntoView({ block: 'start' });
  });
  footer.append(a);
}

export function mountBrowserNotice(container: HTMLElement): void {
  if (!BROWSER_BACKEND) return;
  container.prepend(
    el(
      'p',
      { class: 'notice small', 'data-testid': 'browser-notice' },
      t('v1.browserBuild'),
      ' ',
      t('v1.browserBlind'),
    ),
  );
}
