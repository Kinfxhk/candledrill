// SPDX-License-Identifier: AGPL-3.0-or-later
// Profit target basis "net-after-exit-costs": the target only counts once the position
// could be closed at the bar close AFTER exit commission and slippage, so a passed session
// never ends with a realized result below the target.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  createSession,
  estimatedExitCost,
  liquidationEquity,
  ruleStatus,
  sessionPlaceOrder,
  stepSession,
  type Bar,
  type SessionSettings,
} from '../src/index.js';

const BASE: SessionSettings = {
  symbol: 'SYNTH-TARGET',
  tickSize: 1,
  pointValue: 1,
  commissionPerContract: 1,
  slippageTicks: 0,
  startingBalance: 10_000,
  dailyLossLimit: null,
  trailingDrawdown: null,
  profitTarget: 10,
  utcOffsetMinutes: 0,
  dayStartMinutes: 0,
};
const bar = (i: number, open: number, close: number): Bar => ({
  time: i * 60,
  open,
  high: Math.max(open, close),
  low: Math.min(open, close),
  close,
  volume: 1,
});

function run(settings: SessionSettings, side: 'buy' | 'sell', closes: number[]) {
  const bars = [
    bar(0, 100, 100),
    ...closes.map((c, k) => bar(k + 1, k === 0 ? 100 : closes[k - 1]!, c)),
  ];
  bars.push(bar(bars.length, closes.at(-1)!, closes.at(-1)!)); // keep a bar after the last close
  let s = createSession(bars, settings, 60);
  s = sessionPlaceOrder(bars, settings, s, { side, type: 'market', qty: 1 });
  for (let i = 0; i < closes.length; i++) s = stepSession(bars, settings, s, 1).state;
  return s;
}

describe('profit target basis: net after exit costs', () => {
  it('review case: +11 gross with 1 commission per side is net 9 -> not passed', () => {
    const s = run(BASE, 'buy', [111]);
    expect(s.status).toBe('active');
    expect(liquidationEquity(BASE, s) - BASE.startingBalance).toBe(9);
    expect(ruleStatus(BASE, s).targetProgress).toBeCloseTo(0.9);
  });

  it.each([
    // [side, slippage ticks, closes that do NOT pass, close that passes]
    ['buy', 0, 111, 112],
    ['sell', 0, 89, 88],
    ['buy', 1, 113, 114],
    ['sell', 1, 87, 86],
  ] as const)('%s with %i tick slippage: passes only at net >= target', (side, slip, no, yes) => {
    const settings = { ...BASE, slippageTicks: slip };
    const notYet = run(settings, side, [no]);
    expect(notYet.status).toBe('active');
    expect(estimatedExitCost(settings, notYet)).toBe(1 + slip);
    const passed = run(settings, side, [yes]);
    expect(passed.status).toBe('passed');
    expect(passed.trading.position).toBeNull();
    // Realized result after the forced exit (both commissions and slippage) meets the target.
    expect(passed.trading.realizedPnl).toBe(10);
    expect(passed.trading.trades[0]!.netPnl).toBe(10);
    expect(passed.trading.trades[0]!.exitReason).toBe('rule');
  });

  it('flat sessions compare realized P&L directly (no exit cost)', () => {
    const s = createSession([bar(0, 100, 100), bar(1, 100, 100)], BASE, 60);
    expect(estimatedExitCost(BASE, s)).toBe(0);
    expect(liquidationEquity(BASE, s)).toBe(BASE.startingBalance);
  });

  it('property: a passed target never ends below the target after exit costs', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('buy' as const, 'sell' as const),
        fc.integer({ min: 0, max: 3 }),
        fc.integer({ min: 0, max: 3 }),
        fc.integer({ min: 1, max: 40 }),
        fc.array(fc.integer({ min: 60, max: 140 }), { minLength: 1, maxLength: 15 }),
        (side, commission, slip, target, closes) => {
          const settings = {
            ...BASE,
            commissionPerContract: commission,
            slippageTicks: slip,
            profitTarget: target,
          };
          const s = run(settings, side, closes);
          if (s.status === 'passed') {
            expect(s.trading.realizedPnl).toBeGreaterThanOrEqual(target - 1e-9);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
