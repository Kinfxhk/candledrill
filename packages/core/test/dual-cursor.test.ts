// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  aggregateBars,
  checkSessionState,
  createSession,
  generateSyntheticBars,
  sessionPlaceOrder,
  stepSession,
  type SessionSettings,
} from '../src/index.js';

const SETTINGS: SessionSettings = {
  symbol: 'SYNTH-DEMO',
  tickSize: 0.25,
  pointValue: 50,
  commissionPerContract: 2,
  slippageTicks: 1,
  startingBalance: 50_000,
  dailyLossLimit: null,
  trailingDrawdown: null,
  profitTarget: null,
  utcOffsetMinutes: 0,
  dayStartMinutes: 0,
  trailingDrawdownMode: 'close',
  anchorMinutes: 0,
};

describe('dual-cursor forming (10s source / 1m fill)', () => {
  const fine = generateSyntheticBars({
    seed: 42,
    startDate: '2026-10-05',
    days: 2,
    timeframeSeconds: 10,
  });
  const source = fine.bars;
  const oneMin = aggregateBars(source, 60);
  const dualSettings: SessionSettings = { ...SETTINGS, practiceTimeframeSeconds: 60 };

  it('meta and spacing are 10s', () => {
    expect(fine.meta.timeframeSeconds).toBe(10);
    expect(source[1]!.time - source[0]!.time).toBe(10);
  });

  it('reveals source bars every step but fills only on 1m closes', () => {
    let s = createSession(source, dualSettings, source[30]!.time);
    const before = s.trading.fills.length;
    // Place a market buy on the current (forming) practice bar.
    s = sessionPlaceOrder(source, dualSettings, s, {
      side: 'buy',
      type: 'market',
      qty: 1,
    });
    // Step five 10s bars — still inside the same minute → no fill yet.
    let r = stepSession(source, dualSettings, s, 5);
    expect(r.revealed).toHaveLength(5);
    expect(r.revealed.every((b, i, a) => i === 0 || b.time - a[i - 1]!.time === 10)).toBe(true);
    s = r.state;
    expect(s.trading.fills.length).toBe(before);
    // Keep stepping until the practice bar that follows the place bar closes.
    let filled = false;
    for (let n = 0; n < 20 && !filled; n++) {
      r = stepSession(source, dualSettings, s, 1);
      s = r.state;
      if (s.trading.fills.length > before) filled = true;
    }
    expect(filled).toBe(true);
    // Fill time must be a 1m bucket open (aggregateBars time), not an arbitrary 10s stamp
    // that is mid-bucket without being the practice bar time.
    const fillTime = s.trading.fills[0]!.time;
    expect(oneMin.some((b) => b.time === fillTime)).toBe(true);
  });

  it('fills match the same orders on pre-aggregated 1m bars', () => {
    // Align start to a 1m boundary present in both series.
    const start1m = oneMin[20]!.time;
    const startFine = source.find((b) => b.time === start1m)!.time;

    const entryRef = oneMin[20]!.open;
    const run = (bars: typeof source, settings: SessionSettings, start: number, steps: number) => {
      let s = createSession(bars, settings, start);
      s = sessionPlaceOrder(bars, settings, s, {
        side: 'buy',
        type: 'market',
        qty: 1,
        stopLoss: entryRef - 10,
        takeProfit: entryRef + 20,
      });
      const r = stepSession(bars, settings, s, steps);
      return r.state;
    };

    // Dual: step enough 10s bars to cover ~40 one-minute bars.
    const dual = run(source, dualSettings, startFine, 40 * 6);
    // Legacy 1m: step 40 one-minute bars.
    const legacy = run(oneMin, SETTINGS, start1m, 40);

    const slimFill = (f: (typeof dual.trading.fills)[number]) => ({
      time: f.time,
      side: f.side,
      qty: f.qty,
      price: f.price,
      commission: f.commission,
      role: f.role,
    });
    const slimTrade = (tr: (typeof dual.trading.trades)[number]) => ({
      side: tr.side,
      qty: tr.qty,
      openTime: tr.openTime,
      closeTime: tr.closeTime,
      entryPrice: tr.entryPrice,
      exitPrice: tr.exitPrice,
      netPnl: tr.netPnl,
    });
    expect(dual.trading.fills.map(slimFill)).toEqual(legacy.trading.fills.map(slimFill));
    expect(dual.trading.trades.map(slimTrade)).toEqual(legacy.trading.trades.map(slimTrade));
    expect(dual.trading.realizedPnl).toBe(legacy.trading.realizedPnl);
  });

  it('checkSessionState accepts dual-cursor fills on practice bars', () => {
    let s = createSession(source, dualSettings, source[30]!.time);
    s = sessionPlaceOrder(source, dualSettings, s, { side: 'buy', type: 'market', qty: 1 });
    for (let n = 0; n < 30 && s.trading.fills.length === 0; n++) {
      s = stepSession(source, dualSettings, s, 1).state;
    }
    expect(s.trading.fills.length).toBeGreaterThan(0);
    // Step a bit further so we are mid-forming again (common e2e/backup shape).
    s = stepSession(source, dualSettings, s, 3).state;
    expect(checkSessionState(source, dualSettings, s)).toEqual([]);
  });

  it('without practiceTimeframeSeconds, each 10s bar still fills (path 1 — not V0 default)', () => {
    // Guard: omitting practice TF keeps legacy 1:1 (so old callers are unchanged).
    let s = createSession(source, SETTINGS, source[10]!.time);
    s = sessionPlaceOrder(source, SETTINGS, s, { side: 'buy', type: 'market', qty: 1 });
    const r = stepSession(source, SETTINGS, s, 1);
    expect(r.state.trading.fills.length).toBeGreaterThan(0);
  });
});
