// SPDX-License-Identifier: AGPL-3.0-or-later
// Locale switch must refresh strings that were built once (browser notice, rule profiles,
// About / footer, an already-open Settings dialog) and the OHLC legend labels.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyI18n, setLang } from '../src/i18n.js';
import { ohlcLegendText } from '../src/chart.js';
import {
  browserNotice,
  mountFooterLink,
  mountProfiles,
  mountRecommendations,
  mountSettings,
} from '../src/v1.js';

const root = fileURLToPath(new URL('../..', import.meta.url));

class MiniEl {
  readonly attrs = new Map<string, string>();
  children: (MiniEl | string)[] = [];
  parent: MiniEl | null = null;
  className = '';
  hidden = false;
  value = '';
  checked = false;
  open = false;
  lang = '';
  id = '';
  readonly style: Record<string, string> = {};
  readonly listeners = new Map<string, (() => void)[]>();

  constructor(readonly tagName: string) {}

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
    if (name === 'id') this.id = value;
    if (name === 'value') this.value = value;
    if (name === 'class') this.className = value;
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  addEventListener(type: string, fn: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  append(...nodes: (MiniEl | string)[]): void {
    for (const node of nodes) {
      if (typeof node !== 'string') node.parent = this;
      this.children.push(node);
    }
  }
  prepend(...nodes: (MiniEl | string)[]): void {
    const items = nodes.map((node) => {
      if (typeof node !== 'string') node.parent = this;
      return node;
    });
    this.children = [...items, ...this.children];
  }
  insertBefore(node: MiniEl, ref: MiniEl | null): void {
    node.parent = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(node);
    else this.children.splice(i, 0, node);
  }
  replaceChildren(...nodes: (MiniEl | string)[]): void {
    this.children = [];
    this.append(...nodes);
  }
  querySelector(sel: string): MiniEl | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  querySelectorAll(sel: string): MiniEl[] {
    const out: MiniEl[] = [];
    const walk = (n: MiniEl) => {
      for (const c of n.children) {
        if (typeof c === 'string') continue;
        if (matches(c, sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  click(): void {
    for (const fn of this.listeners.get('click') ?? []) fn();
  }
  showModal(): void {
    this.open = true;
  }
  get textContent(): string {
    return this.children
      .map((child) => (typeof child === 'string' ? child : child.textContent))
      .join('');
  }
  set textContent(value: string) {
    this.children = value === '' ? [] : [value];
  }
  get dataset(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of this.attrs) {
      if (!k.startsWith('data-')) continue;
      const camel = k.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      out[camel] = v;
    }
    return out;
  }
}

function matches(n: MiniEl, sel: string): boolean {
  const attr = /^\[([a-zA-Z0-9-]+)(?:="([^"]*)")?\]$/.exec(sel);
  if (attr) {
    const name = attr[1]!;
    if (!n.attrs.has(name)) return false;
    return attr[2] === undefined || n.getAttribute(name) === attr[2];
  }
  if (sel.startsWith('.')) return n.className.split(/\s+/).includes(sel.slice(1));
  const tagged = /^([a-z]+)\[([a-zA-Z-]+)="?([^"\]]+)"?\]$/.exec(sel);
  if (tagged) {
    return n.tagName === tagged[1]!.toUpperCase() && n.getAttribute(tagged[2]!) === tagged[3];
  }
  return n.tagName === sel.toUpperCase();
}

function installDom(): () => void {
  const prevDoc = globalThis.document;
  const prevStorage = globalThis.localStorage;
  const prevStyle = globalThis.getComputedStyle;
  const html = new MiniEl('HTML');
  const body = new MiniEl('BODY');
  html.append(body);
  const document = {
    documentElement: html,
    body,
    createElement: (tag: string) => new MiniEl(tag.toUpperCase()),
    querySelector: (sel: string) => html.querySelector(sel),
    querySelectorAll: (sel: string) => html.querySelectorAll(sel),
  };
  const store = new Map<string, string>();
  globalThis.document = document as unknown as Document;
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  };
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '#26a69a' }));
  return () => {
    globalThis.document = prevDoc;
    globalThis.localStorage = prevStorage;
    globalThis.getComputedStyle = prevStyle;
    setLang('en');
  };
}

function text(sel: string): string {
  const html = document.documentElement as unknown as MiniEl;
  const found = html.querySelector(sel);
  if (!found) throw new Error(`missing ${sel}`);
  return found.textContent;
}

describe('locale chrome', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = installDom();
  });
  afterEach(() => restore());

  it('refreshes mount-once copy and an open Settings dialog after each language', () => {
    setLang('en');
    const library = new MiniEl('DIV');
    (document.body as unknown as MiniEl).append(library);
    library.prepend(browserNotice() as unknown as MiniEl);

    const about = new MiniEl('DIALOG');
    const third = new MiniEl('H3');
    third.setAttribute('data-i18n', 'about.thirdParty');
    third.textContent = 'Third-party notice';
    const source = new MiniEl('SPAN');
    source.setAttribute('data-i18n', 'about.source');
    source.textContent = 'Source code (AGPL-3.0-or-later):';
    const close = new MiniEl('FORM');
    close.setAttribute('method', 'dialog');
    about.append(third, source, close);
    (document.body as unknown as MiniEl).append(about);

    const footer = new MiniEl('FOOTER');
    (document.body as unknown as MiniEl).append(footer);
    mountFooterLink(footer as unknown as HTMLElement, about as unknown as HTMLDialogElement);
    mountRecommendations(about as unknown as HTMLElement);

    const form = new MiniEl('FORM');
    const grid = new MiniEl('DIV');
    grid.className = 'grid3';
    form.append(grid);
    (document.body as unknown as MiniEl).append(form);
    mountProfiles(library as unknown as HTMLElement, form as unknown as HTMLFormElement);

    const settingsBtn = new MiniEl('BUTTON');
    (document.body as unknown as MiniEl).append(settingsBtn);
    mountSettings(settingsBtn as unknown as HTMLElement);
    settingsBtn.click();
    const qty = (document.body as unknown as MiniEl)
      .querySelectorAll('input')
      .find((n) => n.getAttribute('name') === 'qtyPresets');
    if (!qty) throw new Error('missing qty presets');
    qty.value = '9, 9';

    applyI18n();
    expect(text('[data-testid="browser-notice"]')).toContain('Browser version');
    expect(text('[data-testid="profile-new"]')).toBe('New profile');
    expect(text('[data-testid="profile-import"]')).toBe('Import');
    expect(text('[data-i18n="v1.profileNone"]')).toBe('No rule profile');
    expect(text('[data-testid="footer-recommend"]')).toContain('Recommendations');
    expect(text('[data-testid="referral-link"]')).toBe('Open KINFX link page');
    expect(text('[data-i18n="v1.linksMore"]')).toBe('Full disclosure');
    expect(text('[data-testid="disclosure"]')).toContain('Independence');
    expect(text('[data-i18n="about.thirdParty"]')).toBe('Third-party notice');
    expect(text('[data-i18n="v1.settingsTitle"]')).toBe('Settings');

    setLang('zh-Hant');
    applyI18n();
    expect(text('[data-testid="browser-notice"]')).toContain('瀏覽器版');
    expect(text('[data-testid="profile-new"]')).toBe('新增規則檔');
    expect(text('[data-testid="profile-import"]')).toBe('匯入');
    expect(text('[data-i18n="v1.profileNone"]')).toBe('不使用規則檔');
    expect(text('[data-testid="footer-recommend"]')).toBe('推薦連結（含聯盟佣金）');
    expect(text('[data-testid="referral-link"]')).toBe('開啟 KINFX 連結頁');
    expect(text('[data-i18n="v1.linksMore"]')).toBe('完整披露');
    expect(text('[data-testid="disclosure"]')).toContain('獨立性');
    expect(text('[data-testid="disclosure"]')).not.toContain('Independence');
    expect(text('[data-i18n="about.thirdParty"]')).toBe('第三方聲明');
    expect(text('[data-i18n="about.source"]')).toContain('原始碼');
    expect(text('[data-i18n="v1.settingsTitle"]')).toBe('設定');
    expect(text('[data-i18n="v1.setUp"]')).toBe('升');
    expect(qty.value).toBe('9, 9');

    setLang('zh-Hans');
    applyI18n();
    expect(text('[data-testid="browser-notice"]')).toContain('浏览器版');
    expect(text('[data-testid="browser-notice"]')).not.toContain('瀏覽器版');
    expect(text('[data-testid="profile-new"]')).toBe('新建规则档');
    expect(text('[data-testid="profile-import"]')).toBe('导入');
    expect(text('[data-i18n="v1.profileNone"]')).toBe('不使用规则档');
    expect(text('[data-testid="footer-recommend"]')).toBe('推荐链接（含联盟佣金）');
    expect(text('[data-testid="referral-link"]')).toBe('打开 KINFX 链接页');
    expect(text('[data-i18n="about.thirdParty"]')).toBe('第三方声明');
    expect(text('[data-i18n="v1.settingsTitle"]')).toBe('设置');
    expect(text('[data-testid="disclosure"]')).toContain('獨立性');
    expect(qty.value).toBe('9, 9');

    setLang('en');
    applyI18n();
    expect(text('[data-testid="browser-notice"]')).toContain('Browser version');
    expect(text('[data-testid="profile-new"]')).toBe('New profile');
    expect(text('[data-i18n="v1.profileNone"]')).toBe('No rule profile');
    expect(text('[data-testid="disclosure"]')).toContain('Independence');
    expect(text('[data-i18n="v1.settingsTitle"]')).toBe('Settings');
    expect(qty.value).toBe('9, 9');
  });

  it('translates the OHLC legend from the bar already on screen', () => {
    const bar = { open: 100, high: 110, low: 90, close: 105 };
    setLang('en');
    expect(ohlcLegendText(bar, 0.25)).toMatch(/^O /);
    setLang('zh-Hant');
    expect(ohlcLegendText(bar, 0.25)).toMatch(/^開 /);
    expect(ohlcLegendText(bar, 0.25)).toContain('105.00');
    setLang('zh-Hans');
    expect(ohlcLegendText(bar, 0.25)).toMatch(/^开 /);
    const practice = readFileSync(`${root}/web/src/practice.ts`, 'utf8');
    const library = readFileSync(`${root}/web/src/library.ts`, 'utf8');
    expect(practice).toContain('p.chart.refreshLegend()');
    expect(practice).toContain("'data-i18n': 'v1.checkpointNone'");
    expect(library).toContain('this.chart?.refreshLegend()');
    const html = readFileSync(`${root}/web/index.html`, 'utf8');
    expect(html).toContain('data-i18n="about.thirdParty"');
    expect(html).not.toContain('<h3>Third-party notice</h3>');
    const readme = readFileSync(`${root}/../README.md`, 'utf8');
    expect(readme).toContain(
      '[https://kinfxhk.github.io/candledrill/](https://kinfxhk.github.io/candledrill/)',
    );
    expect(readme).not.toContain('**<https://kinfxhk.github.io/candledrill/>**');
  });
});
