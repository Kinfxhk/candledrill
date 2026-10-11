// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  PALETTE_EXPANDED_KEY,
  readPaletteExpanded,
  writePaletteExpanded,
} from '../src/drawing-palette.js';
import { en, zhHant, setLang, t } from '../src/i18n.js';
import { zhHans } from '../src/i18n/zhHans.js';
import { ja } from '../src/i18n/ja.js';
import { ko } from '../src/i18n/ko.js';

describe('drawing palette expand preference', () => {
  it('defaults collapsed and remembers expand/collapse', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
    };
    expect(readPaletteExpanded(storage)).toBe(false);
    writePaletteExpanded(true, storage);
    expect(store.get(PALETTE_EXPANDED_KEY)).toBe('1');
    expect(readPaletteExpanded(storage)).toBe(true);
    writePaletteExpanded(false, storage);
    expect(readPaletteExpanded(storage)).toBe(false);
  });
});

describe('drawing palette i18n', () => {
  it('has drawTools and clear confirm in every language', () => {
    const dicts = { en, zhHant, zhHans, ja, ko };
    for (const [name, dict] of Object.entries(dicts)) {
      expect(dict['pr.drawTools']?.trim(), name).toBeTruthy();
      expect(dict['pr.clearDrawingsConfirm']?.trim(), name).toBeTruthy();
      expect(dict['pr.clearDrawings'], name).not.toMatch(/^[×xX]$/);
    }
    setLang('en');
    expect(t('pr.drawTools')).toBe('Draw');
    setLang('zh-Hant');
    expect(t('pr.drawTools')).toBe('畫圖');
    setLang('ja');
    expect(t('pr.drawTools')).toBe('描画');
    setLang('en');
  });
});
