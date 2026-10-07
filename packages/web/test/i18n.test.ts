// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { en, zhHant, setLang, t, type MessageKey } from '../src/i18n.js';

describe('i18n', () => {
  it('has the same keys in English and Traditional Chinese, none empty', () => {
    expect(Object.keys(zhHant).sort()).toEqual(Object.keys(en).sort());
    for (const v of [...Object.values(en), ...Object.values(zhHant)]) expect(v.trim()).not.toBe('');
  });

  it('every data-i18n key used in the HTML and sources exists', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const files = [
      'index.html',
      'src/practice.ts',
      'src/side.ts',
      'src/bottom.ts',
      'src/library.ts',
      'src/importer.ts',
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
    setLang('en');
    expect(t('imp.ok', { n: 5 })).toBe('Imported 5 bars.');
  });

  it('keeps the risk notice in both languages', () => {
    expect(en['footer.notice']).toMatch(/Not investment advice/);
    expect(zhHant['footer.notice']).toMatch(/不構成投資建議/);
  });
});
