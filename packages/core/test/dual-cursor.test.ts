// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  aggregateBars,
  checkSessionState,
  createSession,
  defaultPracticeTimeframe,
  FORMING_PARTS,
  formingSourceSeconds,
  generateSyntheticBars,
  practiceChartTimeframes,
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

  it.each([
    [60, 20],
    [300, 100],
    [900, 300],
  ] as const)(
    'practice %i forms from %i-second bars and fills on the practice close',
    (practice, sourceTf) => {
      expect(formingSourceSeconds(practice)).toBe(sourceTf);
      expect(defaultPracticeTimeframe(sourceTf)).toBe(practice);
      const fine = generateSyntheticBars({
        seed: 7,
        startDate: '2026-10-05',
        days: 2,
        timeframeSeconds: sourceTf,
      });
      const source = fine.bars;
      const practiceBars = aggregateBars(source, practice);
      const start = practiceBars[8]!.time;
      const startIdx = source.findIndex((b) => b.time === start);
      const settings: SessionSettings = { ...SETTINGS, practiceTimeframeSeconds: practice };

      // The cursor is the last bar strictly before `start` (the previous practice bar).
      let s = createSession(source, settings, start);
      expect(s.cursor).toBe(startIdx - 1);

      // All but the last source bar build the practice candle. It has not closed, so nothing fills.
      let formingChanged = false;
      const open = source[startIdx]!.open;
      for (let n = 0; n < FORMING_PARTS - 1; n++) {
        s = stepSession(source, settings, s, 1).state;
        expect(s.trading.fills).toHaveLength(0);
        const slice = source.slice(startIdx, s.cursor + 1);
        const visible = aggregateBars(slice, practice);
        expect(visible).toHaveLength(1);
        expect(visible[0]!.time).toBe(start);
        expect(visible[0]!.open).toBe(open);
        expect(visible[0]!.close).toBe(slice[slice.length - 1]!.close);
        expect(visible[0]!.high).toBe(Math.max(...slice.map((b) => b.high)));
        expect(visible[0]!.low).toBe(Math.min(...slice.map((b) => b.low)));
        if (visible[0]!.close !== open || visible[0]!.high !== open || visible[0]!.low !== open) {
          formingChanged = true;
        }
      }
      expect(formingChanged).toBe(true);

      // Placed while that bar is still forming: the close of *this* bar is not a fill.
      s = sessionPlaceOrder(source, settings, s, { side: 'buy', type: 'market', qty: 1 });
      s = stepSession(source, settings, s, 1).state;
      expect(s.trading.fills).toHaveLength(0);

      // The next practice bar closes, and the market order fills there.
      const filled = stepSession(source, settings, s, FORMING_PARTS).state;
      expect(filled.trading.fills.length).toBeGreaterThan(0);
      expect(filled.trading.fills[0]!.time).toBe(start + practice);

      // Same orders on pre-aggregated practice bars match the dual-cursor run.
      const run = (bars: typeof source, tfSettings: SessionSettings, steps: number) => {
        let state = createSession(bars, tfSettings, start);
        state = sessionPlaceOrder(bars, tfSettings, state, {
          side: 'buy',
          type: 'market',
          qty: 1,
          stopLoss: practiceBars[8]!.open - 10,
          takeProfit: practiceBars[8]!.open + 20,
        });
        return stepSession(bars, tfSettings, state, steps).state;
      };
      const dual = run(source, settings, 12 * FORMING_PARTS);
      const legacy = run(practiceBars, SETTINGS, 12);
      const slim = (f: (typeof dual.trading.fills)[number]) => ({
        time: f.time,
        side: f.side,
        qty: f.qty,
        price: f.price,
        role: f.role,
      });
      expect(dual.trading.fills.map(slim)).toEqual(legacy.trading.fills.map(slim));
      expect(dual.trading.realizedPnl).toBe(legacy.trading.realizedPnl);
    },
  );

  it('a file of only practice-TF bars does not grow a finer forming source', () => {
    expect(FORMING_PARTS).toBe(3);
    expect(defaultPracticeTimeframe(60)).toBeUndefined();
    // 300s is the 15m forming source (three real 5m bars), not an invented path.
    expect(defaultPracticeTimeframe(300)).toBe(900);
    expect(defaultPracticeTimeframe(900)).toBeUndefined();
    expect(defaultPracticeTimeframe(3600)).toBeUndefined();
    expect(defaultPracticeTimeframe(86400)).toBeUndefined();
    // Sub-minute data that is not an exact pair still fills on 1m (V0).
    expect(defaultPracticeTimeframe(5)).toBe(60);
    expect(formingSourceSeconds(60)).toBe(20);
    expect(formingSourceSeconds(300)).toBe(100);
    expect(formingSourceSeconds(900)).toBe(300);
    expect(formingSourceSeconds(3600)).toBe(1200);
    expect(formingSourceSeconds(86400)).toBe(28800);
    expect(defaultPracticeTimeframe(20)).toBe(60);
    expect(defaultPracticeTimeframe(100)).toBe(300);
    expect(defaultPracticeTimeframe(1200)).toBe(3600);
    expect(defaultPracticeTimeframe(28800)).toBe(86400);
    // v1.0.4 ÷6 files keep the practice close they were generated for.
    expect(defaultPracticeTimeframe(10)).toBe(60);
    expect(defaultPracticeTimeframe(50)).toBe(300);
    expect(defaultPracticeTimeframe(150)).toBe(900);
    expect(defaultPracticeTimeframe(600)).toBe(3600);
    expect(defaultPracticeTimeframe(14400)).toBe(86400);
    expect(practiceChartTimeframes(20, 60)).toEqual([60, 300, 900, 3600, 86400]);
    expect(practiceChartTimeframes(100, 300)).toEqual([300, 900, 3600, 86400]);
    expect(practiceChartTimeframes(300, 900)).toEqual([900, 3600, 86400]);
    expect(practiceChartTimeframes(10, 60)).toEqual([60, 300, 900, 3600, 86400]);
    expect(practiceChartTimeframes(50, 300)).toEqual([300, 900, 3600, 86400]);
    expect(practiceChartTimeframes(150, 900)).toEqual([900, 3600, 86400]);
    for (const list of [
      practiceChartTimeframes(20, 60),
      practiceChartTimeframes(100, 300),
      practiceChartTimeframes(300, 900),
      practiceChartTimeframes(10, 60),
      practiceChartTimeframes(50, 300),
      practiceChartTimeframes(150, 900),
    ]) {
      expect(list).not.toContain(10);
      expect(list).not.toContain(20);
      expect(list).not.toContain(50);
      expect(list).not.toContain(100);
      expect(list).not.toContain(150);
    }
  });

  it('without practiceTimeframeSeconds, each 10s bar still fills (path 1 — not V0 default)', () => {
    // Guard: omitting practice TF keeps legacy 1:1 (so old callers are unchanged).
    let s = createSession(source, SETTINGS, source[10]!.time);
    s = sessionPlaceOrder(source, SETTINGS, s, { side: 'buy', type: 'market', qty: 1 });
    const r = stepSession(source, SETTINGS, s, 1);
    expect(r.state.trading.fills.length).toBeGreaterThan(0);
  });
});
