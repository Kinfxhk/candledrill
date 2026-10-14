// SPDX-License-Identifier: AGPL-3.0-or-later
import { exampleOrbSmaMacro, type MacroV1 } from '@candledrill/core';
import { describe, expect, it } from 'vitest';
import { macroRunBlockers } from '../src/macro-panel.js';

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
