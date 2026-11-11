// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { atr, ema, sma, vwap } from '../src/indicators.js';
import {
  aroon,
  awesomeOscillator,
  balanceOfPower,
  cci,
  cmf,
  dema,
  elderRay,
  envelope,
  hull,
  ichimoku,
  kdj,
  keltner,
  momentum,
  obv,
  parabolicSar,
  priceChannel,
  roc,
  standardErrorBands,
  supertrend,
  tema,
  vwapBands,
  vwma,
  williamsR,
  wma,
  zigzag,
} from '../src/indicators.js';
import type { Bar } from '../src/types.js';

function synth(n = 30): Bar[] {
  const bars: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const close = 100 + (i % 7) - 3;
    const open = close - ((i % 3) - 1);
    const high = Math.max(open, close) + 1 + (i % 2);
    const low = Math.min(open, close) - 1 - (i % 2);
    bars.push({
      time: 1_700_000_000 + i * 60,
      open,
      high,
      low,
      close,
      volume: 10 + (i % 5),
    });
  }
  return bars;
}

function closes(bars: readonly Bar[]): number[] {
  return bars.map((b) => b.close);
}

describe('wma', () => {
  it('weights the newest close highest and matches an independent sum', () => {
    const bars = synth();
    const period = 3;
    const r = wma(bars, period);
    expect(r).toHaveLength(30);
    expect(r.slice(0, 2)).toEqual([null, null]);
    // closes 97, 98, 99 with weights 1, 2, 3
    expect(r[2]).toBeCloseTo(590 / 6, 9);
    for (let i = period - 1; i < bars.length; i++) {
      let acc = 0;
      let w = 0;
      for (let k = 0; k < period; k++) {
        const weight = k + 1;
        acc += bars[i - period + 1 + k]!.close * weight;
        w += weight;
      }
      expect(r[i]).toBeCloseTo(acc / w, 9);
    }
  });
});

describe('momentum and roc', () => {
  it('subtracts the close `period` bars ago', () => {
    const bars = synth();
    const mom = momentum(bars, 4);
    const rate = roc(bars, 4);
    expect(mom.slice(0, 4)).toEqual([null, null, null, null]);
    expect(mom[4]).toBe(bars[4]!.close - bars[0]!.close);
    expect(rate[4]).toBeCloseTo((100 * (bars[4]!.close - bars[0]!.close)) / bars[0]!.close, 9);
    expect(roc([{ ...bars[0]!, close: 0 }, bars[1]!], 1, 'close')[1]).toBeNull();
  });
});

describe('obv', () => {
  it('starts at 0 and adds or subtracts volume with the close', () => {
    const bars = synth(6);
    const r = obv(bars);
    expect(r[0]).toBe(0);
    expect(r[1]).toBe(bars[1]!.volume);
    let acc = 0;
    for (let i = 1; i < bars.length; i++) {
      if (bars[i]!.close > bars[i - 1]!.close) acc += bars[i]!.volume;
      else if (bars[i]!.close < bars[i - 1]!.close) acc -= bars[i]!.volume;
      expect(r[i]).toBe(acc);
    }
  });
});

describe('cmf', () => {
  it('is the period sum of money-flow volume over volume', () => {
    const bars = synth();
    const period = 5;
    const r = cmf(bars, period);
    expect(r[3]).toBeNull();
    let sumF = 0;
    let sumV = 0;
    for (let k = 0; k < period; k++) {
      const b = bars[k]!;
      const mfm = (2 * b.close - b.high - b.low) / (b.high - b.low);
      sumF += mfm * b.volume;
      sumV += b.volume;
    }
    expect(r[4]).toBeCloseTo(sumF / sumV, 9);
  });

  it('treats a flat bar as zero money flow', () => {
    const flat: Bar = { time: 0, open: 5, high: 5, low: 5, close: 5, volume: 3 };
    expect(cmf([flat, { ...flat, time: 60 }], 2)[1]).toBe(0);
  });
});

describe('williams %R', () => {
  it('is -100 at the period low and -50 on a zero range', () => {
    const bars = [
      { time: 0, open: 1, high: 10, low: 0, close: 0, volume: 1 },
      { time: 60, open: 1, high: 8, low: 2, close: 8, volume: 1 },
    ];
    const r = williamsR(bars, 2);
    expect(r[0]).toBeNull();
    // hh 10, ll 0, close 8 → -100 * (10-8) / 10
    expect(r[1]).toBeCloseTo(-20, 9);
    const flat: Bar = { time: 0, open: 4, high: 4, low: 4, close: 4, volume: 1 };
    expect(williamsR([flat, { ...flat, time: 60 }], 2)[1]).toBe(-50);
  });
});

describe('envelope', () => {
  it('places percentage bands around the SMA', () => {
    const bars = synth();
    const r = envelope(bars, 4, 10);
    const mid = sma(bars, 4);
    expect(r.middle).toEqual(mid);
    expect(r.upper[3]).toBeCloseTo(mid[3]! * 1.1, 9);
    expect(r.lower[3]).toBeCloseTo(mid[3]! * 0.9, 9);
    expect(r.upper[2]).toBeNull();
  });
});

describe('vwma', () => {
  it('weights closes by volume', () => {
    const bars = synth();
    const r = vwma(bars, 3);
    expect(r[1]).toBeNull();
    let pv = 0;
    let vol = 0;
    for (let k = 0; k < 3; k++) {
      pv += bars[k]!.close * bars[k]!.volume;
      vol += bars[k]!.volume;
    }
    expect(r[2]).toBeCloseTo(pv / vol, 9);
    const zero: Bar[] = bars.slice(0, 3).map((b) => ({ ...b, volume: 0 }));
    expect(vwma(zero, 3)[2]).toBeNull();
  });
});

describe('price channel', () => {
  it('excludes the current bar, unlike a Donchian window', () => {
    const bars: Bar[] = [];
    for (let i = 0; i < 6; i++) {
      bars.push({
        time: i * 60,
        open: 10,
        high: i === 5 ? 50 : 10 + i,
        low: 5,
        close: 10,
        volume: 1,
      });
    }
    const r = priceChannel(bars, 3);
    expect(r.upper[2]).toBeNull();
    expect(r.upper[5]).toBe(14);
    expect(r.lower[5]).toBe(5);
    expect(r.middle[5]).toBe(9.5);
    expect(r.upper[5]).not.toBe(50);
  });
});

describe('aroon', () => {
  it('is 100 when the extreme is the current bar and 0 when it is `period` bars ago', () => {
    const bars: Bar[] = [];
    for (let i = 0; i < 6; i++) {
      bars.push({
        time: i * 60,
        open: 10,
        high: i === 5 ? 20 : 10 + i,
        low: i === 1 ? 1 : 8,
        close: 10,
        volume: 1,
      });
    }
    const r = aroon(bars, 4);
    expect(r.up[3]).toBeNull();
    expect(r.up[5]).toBe(100);
    expect(r.down[5]).toBe((100 * (4 - (5 - 1))) / 4);
  });
});

describe('balance of power', () => {
  it('smooths (close - open) / (high - low) and uses 0 for a flat bar', () => {
    const bars = synth();
    const r = balanceOfPower(bars, 2);
    expect(r[0]).toBeNull();
    const raw = (b: Bar) => (b.close - b.open) / (b.high - b.low);
    expect(r[1]).toBeCloseTo((raw(bars[0]!) + raw(bars[1]!)) / 2, 9);
    const flat: Bar = { time: 0, open: 3, high: 3, low: 3, close: 3, volume: 1 };
    expect(balanceOfPower([flat, flat], 1)[0]).toBe(0);
  });
});

describe('cci', () => {
  it('scales typical-price distance by mean absolute deviation', () => {
    const bars = synth();
    const period = 4;
    const r = cci(bars, period);
    expect(r[2]).toBeNull();
    const tp = bars.slice(0, 4).map((b) => (b.high + b.low + b.close) / 3);
    const m = tp.reduce((a, b) => a + b, 0) / 4;
    const dev = tp.reduce((a, b) => a + Math.abs(b - m), 0) / 4;
    expect(r[3]).toBeCloseTo((tp[3]! - m) / (0.015 * dev), 8);
  });
});

describe('kdj', () => {
  it('seeds K and D with the first RSV and lets J leave 0-100', () => {
    const bars = synth();
    const r = kdj(bars, 3);
    expect(r.k[1]).toBeNull();
    let hh = -Infinity;
    let ll = Infinity;
    for (let i = 0; i < 3; i++) {
      hh = Math.max(hh, bars[i]!.high);
      ll = Math.min(ll, bars[i]!.low);
    }
    const rsv = (100 * (bars[2]!.close - ll)) / (hh - ll);
    expect(r.k[2]).toBeCloseTo(rsv, 9);
    expect(r.d[2]).toBeCloseTo(rsv, 9);
    expect(r.j[2]).toBeCloseTo(rsv, 9);
    const nextK =
      (2 / 3) * rsv +
      (1 / 3) *
        ((100 * (bars[3]!.close - Math.min(ll, bars[3]!.low))) /
          (Math.max(hh, bars[3]!.high) - Math.min(ll, bars[3]!.low)));
    expect(r.k[3]).toBeCloseTo(nextK, 8);
  });
});

describe('dema and tema', () => {
  it('follows 2E-E(E) and 3E-3E(E)+E(E(E)) with the shared EMA seed', () => {
    const bars = synth(40);
    const period = 4;
    const e1 = ema(bars, period);
    const alpha = 2 / (period + 1);
    const second = (src: readonly (number | null)[]): (number | null)[] => {
      const out: (number | null)[] = [];
      const window: number[] = [];
      let prev: number | null = null;
      for (const v of src) {
        if (v === null) {
          window.length = 0;
          prev = null;
          out.push(null);
          continue;
        }
        window.push(v);
        if (window.length > period) window.shift();
        if (window.length < period) {
          out.push(null);
          continue;
        }
        if (prev === null) prev = window.reduce((a, b) => a + b, 0) / period;
        else prev = alpha * v + (1 - alpha) * prev;
        out.push(prev);
      }
      return out;
    };
    const e2 = second(e1);
    const e3 = second(e2);
    const d = dema(bars, period);
    const t = tema(bars, period);
    expect(d[period - 2]).toBeNull();
    for (let i = 0; i < bars.length; i++) {
      const a = e1[i] ?? null;
      const b = e2[i] ?? null;
      const c = e3[i] ?? null;
      expect(d[i]).toBe(a === null || b === null ? null : 2 * a - b);
      expect(t[i]).toBe(a === null || b === null || c === null ? null : 3 * a - 3 * b + c);
    }
  });
});

describe('hull', () => {
  it('is the WMA of 2×WMA(n/2) − WMA(n) over round(sqrt(n))', () => {
    const bars = synth();
    const period = 4;
    const r = hull(bars, period);
    const half = wma(bars, 2);
    const full = wma(bars, 4);
    const sqrtP = 2;
    expect(r[period + sqrtP - 3]).toBeNull();
    const diff: (number | null)[] = half.map((f, i) =>
      f === null || full[i] === null ? null : 2 * f - full[i]!,
    );
    const start = diff.findIndex((v) => v !== null);
    const window = diff.slice(start, start + sqrtP) as number[];
    const denom = (sqrtP * (sqrtP + 1)) / 2;
    let acc = 0;
    for (let k = 0; k < sqrtP; k++) acc += window[k]! * (k + 1);
    expect(r[start + sqrtP - 1]).toBeCloseTo(acc / denom, 8);
  });
});

describe('keltner', () => {
  it('adds a multiple of ATR to the EMA once both exist', () => {
    const bars = synth();
    const r = keltner(bars, 5, 5, 2);
    const mid = ema(bars, 5);
    const ranges = atr(bars, 5);
    expect(r.middle).toEqual(mid);
    expect(r.upper[3]).toBeNull();
    expect(r.upper[4]).toBeCloseTo(mid[4]! + 2 * ranges[4]!, 8);
    expect(r.lower[4]).toBeCloseTo(mid[4]! - 2 * ranges[4]!, 8);
  });
});

describe('elder ray', () => {
  it('subtracts the EMA from high and low', () => {
    const bars = synth();
    const r = elderRay(bars, 5);
    const basis = ema(bars, 5);
    expect(r.bull[3]).toBeNull();
    expect(r.bull[4]).toBeCloseTo(bars[4]!.high - basis[4]!, 8);
    expect(r.bear[4]).toBeCloseTo(bars[4]!.low - basis[4]!, 8);
  });
});

describe('awesome oscillator', () => {
  it('subtracts the slow median SMA from the fast one', () => {
    const bars = synth(40);
    const r = awesomeOscillator(bars, 3, 5);
    expect(r[3]).toBeNull();
    const med = bars.map((b) => (b.high + b.low) / 2);
    const mean = (i: number, p: number) => {
      let s = 0;
      for (let k = 0; k < p; k++) s += med[i - p + 1 + k]!;
      return s / p;
    };
    expect(r[4]).toBeCloseTo(mean(4, 3) - mean(4, 5), 8);
  });
});

describe('vwap bands', () => {
  it('matches session VWAP and puts the first bar on a zero-width band', () => {
    const bars = synth();
    const r = vwapBands(bars);
    const session = vwap(bars);
    expect(r.vwap.map((v, i) => ({ time: bars[i]!.time, value: v }))).toEqual(session);
    expect(r.upper1[0]).toBeCloseTo(r.vwap[0]!, 9);
    expect(r.lower2[0]).toBeCloseTo(r.vwap[0]!, 9);
    const t0 = (bars[0]!.high + bars[0]!.low + bars[0]!.close) / 3;
    const t1 = (bars[1]!.high + bars[1]!.low + bars[1]!.close) / 3;
    const v0 = bars[0]!.volume;
    const v1 = bars[1]!.volume;
    const mid = (t0 * v0 + t1 * v1) / (v0 + v1);
    const variance = (t0 * t0 * v0 + t1 * t1 * v1) / (v0 + v1) - mid * mid;
    expect(r.upper1[1]).toBeCloseTo(mid + Math.sqrt(Math.max(0, variance)), 8);
    expect(r.upper2[1]).toBeCloseTo(mid + 2 * Math.sqrt(Math.max(0, variance)), 8);
  });
});

describe('standard error bands', () => {
  it('fits the current bar and bands it by the residual standard error', () => {
    const bars = synth();
    const r = standardErrorBands(bars, 4, 2);
    expect(r.middle[2]).toBeNull();
    const y = closes(bars).slice(0, 4);
    const n = 4;
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumXX = 0;
    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += y[i]!;
      sumXY += i * y[i]!;
      sumXX += i * i;
    }
    const den = n * sumXX - sumX * sumX;
    const slope = (n * sumXY - sumX * sumY) / den;
    const intercept = (sumY - slope * sumX) / n;
    const fitted = intercept + slope * (n - 1);
    let sse = 0;
    for (let i = 0; i < n; i++) sse += (y[i]! - (intercept + slope * i)) ** 2;
    const se = Math.sqrt(sse / (n - 2));
    expect(r.middle[3]).toBeCloseTo(fitted, 8);
    expect(r.upper[3]).toBeCloseTo(fitted + 2 * se, 8);
    expect(r.lower[3]).toBeCloseTo(fitted - 2 * se, 8);
  });
});

describe('ichimoku', () => {
  it('shifts Senkou forward and leaves the Chikou tail null', () => {
    const bars = synth(20);
    const r = ichimoku(bars, 3, 5, 7, 5);
    expect(r.tenkan[1]).toBeNull();
    const mid = (end: number, period: number) => {
      let hh = -Infinity;
      let ll = Infinity;
      for (let j = end - period + 1; j <= end; j++) {
        hh = Math.max(hh, bars[j]!.high);
        ll = Math.min(ll, bars[j]!.low);
      }
      return (hh + ll) / 2;
    };
    expect(r.tenkan[2]).toBe(mid(2, 3));
    expect(r.kijun[4]).toBe(mid(4, 5));
    expect(r.senkouA[8]).toBeNull();
    expect(r.senkouA[9]).toBe((r.tenkan[4]! + r.kijun[4]!) / 2);
    expect(r.senkouB[11]).toBe(mid(6, 7));
    expect(r.chikou[14]).toBe(bars[19]!.close);
    expect(r.chikou[15]).toBeNull();
    const short = ichimoku(bars.slice(0, 12), 3, 5, 7, 5);
    for (let i = 0; i < short.chikou.length; i++) {
      if (short.chikou[i] !== null) expect(short.chikou[i]).toBe(r.chikou[i]);
    }
    expect(short.senkouA).toEqual(r.senkouA.slice(0, 12));
  });
});

describe('supertrend', () => {
  it('seeds the first ATR bar on the upper band and does not look ahead', () => {
    const bars: Bar[] = [];
    for (let i = 0; i < 8; i++) {
      const close = 10 + i;
      bars.push({
        time: i * 60,
        open: close - 0.5,
        high: close + 1,
        low: close - 1,
        close,
        volume: 1,
      });
    }
    const r = supertrend(bars, 3, 2);
    expect(r.line[1]).toBeNull();
    const tr = [2, 2, 2];
    const atr0 = (tr[0]! + tr[1]! + tr[2]!) / 3;
    const hl2 = (bars[2]!.high + bars[2]!.low) / 2;
    expect(r.line[2]).toBeCloseTo(hl2 + 2 * atr0, 8);
    expect(r.trend[2]).toBe(-1);
    const prefix = supertrend(bars.slice(0, 5), 3, 2);
    expect(prefix.line).toEqual(r.line.slice(0, 5));
    expect(prefix.trend).toEqual(r.trend.slice(0, 5));
  });
});

describe('parabolic SAR', () => {
  it('matches a hand-worked acceleration and reversal', () => {
    const bars: Bar[] = [
      { time: 0, open: 9, high: 10, low: 8, close: 9, volume: 1 },
      { time: 60, open: 9, high: 11, low: 9, close: 10, volume: 1 },
      { time: 120, open: 10, high: 12, low: 10, close: 11, volume: 1 },
      { time: 180, open: 11, high: 13, low: 11, close: 12, volume: 1 },
      { time: 240, open: 12, high: 11, low: 7, close: 8, volume: 1 },
      { time: 300, open: 8, high: 9, low: 6, close: 7, volume: 1 },
    ];
    const r = parabolicSar(bars, 0.02, 0.2);
    expect(r[0]).toBeNull();
    expect(r[1]).toBe(8);
    expect(r[2]).toBe(8);
    expect(r[3]).toBeCloseTo(8.16, 9);
    expect(r[4]).toBe(13);
    expect(r[5]).toBe(13);
  });
});

describe('zigzag', () => {
  it('draws only confirmed pivots and leaves the live leg null', () => {
    const b = (i: number, high: number, low: number): Bar => ({
      time: i * 60,
      open: (high + low) / 2,
      high,
      low,
      close: (high + low) / 2,
      volume: 1,
    });
    const bars = [
      b(0, 10, 10),
      b(1, 10, 10),
      b(2, 12, 11),
      b(3, 12.5, 11.5),
      b(4, 12, 11),
      b(5, 11, 10.5),
      b(6, 12, 11),
    ];
    const r = zigzag(bars, 10);
    expect(r[0]).toBe(10);
    expect(r[1]).toBeCloseTo(10 + (2.5 * 1) / 3, 8);
    expect(r[3]).toBe(12.5);
    expect(r[4]).toBe(11.5);
    expect(r[5]).toBe(10.5);
    expect(r[6]).toBeNull();
    const early = zigzag(bars.slice(0, 4), 10);
    expect(early.every((v) => v === null)).toBe(true);
  });
});

describe('no look-ahead', () => {
  it('keeps causal indicator values stable when the prefix grows', () => {
    const bars = synth(30);
    const prefix = bars.slice(0, 18);
    expect(wma(prefix, 5)).toEqual(wma(bars, 5).slice(0, 18));
    expect(cci(prefix, 8)).toEqual(cci(bars, 8).slice(0, 18));
    expect(obv(prefix)).toEqual(obv(bars).slice(0, 18));
    expect(cmf(prefix, 6)).toEqual(cmf(bars, 6).slice(0, 18));
    expect(williamsR(prefix, 7)).toEqual(williamsR(bars, 7).slice(0, 18));
    expect(envelope(prefix, 5, 8).upper).toEqual(envelope(bars, 5, 8).upper.slice(0, 18));
    expect(dema(prefix, 4)).toEqual(dema(bars, 4).slice(0, 18));
    expect(tema(prefix, 4)).toEqual(tema(bars, 4).slice(0, 18));
    expect(hull(prefix, 6)).toEqual(hull(bars, 6).slice(0, 18));
    expect(momentum(prefix, 3)).toEqual(momentum(bars, 3).slice(0, 18));
    expect(roc(prefix, 3)).toEqual(roc(bars, 3).slice(0, 18));
    expect(aroon(prefix, 5).up).toEqual(aroon(bars, 5).up.slice(0, 18));
    expect(vwma(prefix, 4)).toEqual(vwma(bars, 4).slice(0, 18));
    expect(priceChannel(prefix, 4).lower).toEqual(priceChannel(bars, 4).lower.slice(0, 18));
    expect(balanceOfPower(prefix, 5)).toEqual(balanceOfPower(bars, 5).slice(0, 18));
    expect(kdj(prefix, 9).j).toEqual(kdj(bars, 9).j.slice(0, 18));
    expect(elderRay(prefix, 5).bull).toEqual(elderRay(bars, 5).bull.slice(0, 18));
    expect(keltner(prefix, 5, 4, 1.5).lower).toEqual(keltner(bars, 5, 4, 1.5).lower.slice(0, 18));
    expect(awesomeOscillator(prefix, 3, 8)).toEqual(awesomeOscillator(bars, 3, 8).slice(0, 18));
    expect(standardErrorBands(prefix, 5, 2).middle).toEqual(
      standardErrorBands(bars, 5, 2).middle.slice(0, 18),
    );
    expect(parabolicSar(prefix, 0.02, 0.2)).toEqual(parabolicSar(bars, 0.02, 0.2).slice(0, 18));
    expect(supertrend(prefix, 5, 3).line).toEqual(supertrend(bars, 5, 3).line.slice(0, 18));
    const zzFull = zigzag(bars, 5);
    const zzShort = zigzag(prefix, 5);
    for (let i = 0; i < zzShort.length; i++) {
      if (zzShort[i] !== null) expect(zzFull[i]).toBeCloseTo(zzShort[i]!, 8);
    }
  });
});
