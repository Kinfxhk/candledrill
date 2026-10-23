// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { en, ja, ko, zhHans, zhHant, setLang, t, type MessageKey } from '../src/i18n.js';

const dicts = { en, 'zh-Hant': zhHant, 'zh-Hans': zhHans, ja, ko };

describe('i18n', () => {
  it('has the same keys in every language, none empty', () => {
    const keys = Object.keys(en).sort();
    for (const [name, dict] of Object.entries(dicts)) {
      expect(Object.keys(dict).sort(), name).toEqual(keys);
    }
    for (const dict of Object.values(dicts)) {
      for (const v of Object.values(dict)) expect(v.trim()).not.toBe('');
    }
  });

  it('every data-i18n key used in the HTML and sources exists', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const files = [
      'index.html',
      'src/main.ts',
      'src/practice.ts',
      'src/side.ts',
      'src/bottom.ts',
      'src/library.ts',
      'src/importer.ts',
      'src/drawing-palette.ts',
      'src/indicator-panel.ts',
      'src/macro-panel.ts',
      'src/chart.ts',
      'src/summary.ts',
      'src/v1.ts',
      'src/rules-view.ts',
      'src/settings.ts',
      'src/review-tab.ts',
    ];
    const used = new Set<string>();
    for (const f of files) {
      const text = readFileSync(`${root}/${f}`, 'utf8');
      for (const m of text.matchAll(/data-i18n(?:-title|-aria)?="([a-zA-Z.]+)"/g)) used.add(m[1]!);
      for (const m of text.matchAll(/\bt\('([a-zA-Z.]+)'/g)) used.add(m[1]!);
    }
    expect(used.size).toBeGreaterThan(50);
    for (const k of used) expect(Object.keys(en), `missing key ${k}`).toContain(k);
  });

  it('switches language and interpolates', () => {
    setLang('zh-Hant');
    expect(t('imp.ok' as MessageKey, { n: 5 })).toBe('已匯入 5 根K線。');
    setLang('ja');
    expect(t('imp.ok' as MessageKey, { n: 5 })).toBe('5 足をインポートしました。');
    setLang('en');
    expect(t('imp.ok', { n: 5 })).toBe('Imported 5 bars.');
  });

  it('keeps the risk notice in every language', () => {
    expect(en['footer.notice']).toMatch(/Not investment advice/);
    expect(zhHant['footer.notice']).toMatch(/不構成投資建議/);
    expect(zhHans['footer.notice']).toMatch(/不构成投资建议/);
    expect(ja['footer.notice']).toMatch(/投資助言ではありません/);
    expect(ko['footer.notice']).toMatch(/투자 권유가 아닙니다/);
  });
});
