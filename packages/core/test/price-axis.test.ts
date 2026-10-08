// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { tickDecimals } from '../src/index.js';

/** v0.1.1 chart.ts: ceil(-log10(tick)). Drops a digit for 0.25, 0.025 and 0.125. */
function legacyPrecision(tick: number): number {
  return Math.min(10, Math.max(0, Math.ceil(-Math.log10(tick) - 1e-9)));
}

describe('price axis precision', () => {
  it('uses the tick’s own decimal count, not ceil(-log10)', () => {
    const cases: [number, number][] = [
      [0.25, 2],
      [0.025, 3],
      [0.125, 3],
      [0.1, 1],
      [0.01, 2],
      [0.005, 3],
    ];
    for (const [tick, decimals] of cases) expect(tickDecimals(tick)).toBe(decimals);
    // These are the ticks the old formula got wrong. 0.1 / 0.01 / 0.005 stay the same.
    expect(legacyPrecision(0.25)).toBe(1);
    expect(legacyPrecision(0.025)).toBe(2);
    expect(legacyPrecision(0.125)).toBe(1);
    expect(legacyPrecision(0.1)).toBe(1);
    expect(legacyPrecision(0.01)).toBe(2);
    expect(legacyPrecision(0.005)).toBe(3);
  });
});
