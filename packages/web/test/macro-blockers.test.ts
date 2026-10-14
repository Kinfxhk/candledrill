// SPDX-License-Identifier: AGPL-3.0-or-later
import { exampleOrbSmaMacro, type MacroV1 } from '@candledrill/core';
import { describe, expect, it } from 'vitest';
import { setLang } from '../src/i18n.js';
import {
  buildCondition,
  describeCondition,
  macroReadiness,
  macroRunBlockers,
} from '../src/macro-panel.js';

function withRules(macro: MacroV1, rules: MacroV1['rules']): MacroV1 {
  return { ...macro, rules };
}

describe('macroRunBlockers', () => {
  it('lets the example macro run when the session is not blind', () => {
    expect(macroRunBlockers(exampleOrbSmaMacro(), false)).toEqual([]);
  });

  it('blocks a hidden blind session and a macro with no enabled rule', () => {
    const macro = exampleOrbSmaMacro();
    expect(macroRunBlockers(macro, true)).toContain('macro.blind');
    const off = withRules(
      macro,
      macro.rules.map((rule) => ({ ...rule, enabled: false })),
    );
    expect(macroRunBlockers(off, false)).toEqual(['macro.needRule']);
  });

  it('blocks an empty name, a zero quantity, and a non-positive stop', () => {
    const macro = exampleOrbSmaMacro();
    expect(macroRunBlockers({ ...macro, name: '  ' }, false)).toContain('macro.needName');
    expect(macroRunBlockers({ ...macro, qty: 0 }, false)).toContain('macro.needQty');
    expect(
      macroRunBlockers(
        { ...macro, exit: { ...macro.exit, stop: { mode: 'ticks', value: 0 } } },
        false,
      ),
    ).toContain('macro.needStop');
  });
});

describe('semi-auto copy', () => {
  it('says whether a run is ready in one line', () => {
    setLang('zh-Hant');
    expect(macroReadiness([]).text).toBe('就緒 — 可以回測或邊播邊跟');
    expect(macroReadiness(['macro.needName', 'macro.needQty', 'macro.needStop']).text).toBe(
      '未就緒 — 仲欠：名稱／數量／止蝕',
    );
    setLang('en');
    expect(macroReadiness([]).ready).toBe(true);
    expect(macroReadiness(['macro.needRule', 'macro.needTarget']).text).toBe(
      'Not ready — still need: rules, target',
    );
  });

  it('describes an added condition in one sentence', () => {
    setLang('zh-Hant');
    expect(describeCondition(buildCondition('orb_break', 'up', 30))).toBe('ORB 30 分鐘突破向上');
    expect(describeCondition(buildCondition('rsi', 'lt', 70))).toBe('RSI 低於 70');
    expect(describeCondition(buildCondition('price_vs_ma', 'above', 21))).toBe('SMA 21 價格之上');
    setLang('en');
    expect(describeCondition(buildCondition('orb_break', 'down', 15))).toBe('ORB 15m Break down');
  });
});
