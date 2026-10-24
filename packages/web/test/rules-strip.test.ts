// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createSession, type Bar, type SessionSettings } from '@candledrill/core';
import {
  boxesIntersect,
  clampBox,
  practiceGlance,
  readRulesStripCollapsed,
  readRulesStripPos,
  resolveStripBox,
  RULES_STRIP_COLLAPSED_KEY,
  RULES_STRIP_POS_KEY,
  shouldRedock,
  stripFits,
  writeRulesStripCollapsed,
  writeRulesStripPos,
  type Box,
} from '../src/rules-strip.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));

const settings = (over: Partial<SessionSettings> = {}): SessionSettings => ({
  symbol: 'SYNTH-STRIP',
  tickSize: 0.25,
  pointValue: 50,
  commissionPerContract: 0,
  slippageTicks: 0,
  startingBalance: 50_000,
  dailyLossLimit: null,
  trailingDrawdown: null,
  profitTarget: null,
  utcOffsetMinutes: 0,
  dayStartMinutes: 0,
  trailingDrawdownMode: 'close',
  anchorMinutes: 0,
  ...over,
});

const bars: Bar[] = [
  { time: 1_700_000_000, open: 100, high: 101, low: 99, close: 100, volume: 1 },
  { time: 1_700_000_060, open: 100, high: 102, low: 99, close: 101, volume: 1 },
];

function memory(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const store = new Map<string, string>();
  return {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => {
      store.set(k, v);
    },
    removeItem: (k) => {
      store.delete(k);
    },
  };
}

describe('rules strip placement', () => {
  const bounds: Box = { x: 0, y: 0, w: 400, h: 300 };
  const ohlc: Box = { x: 8, y: 40, w: 180, h: 16 };
  const ticket: Box = { x: 0, y: 260, w: 400, h: 40 };

  it('keeps a clear spot and refuses the OHLC legend and the order row', () => {
    const strip: Box = { x: 12, y: 4, w: 220, h: 28 };
    expect(boxesIntersect(strip, ohlc)).toBe(false);
    expect(resolveStripBox(strip, null, bounds, [ohlc, ticket])).toEqual(strip);

    const overLegend: Box = { x: 12, y: 36, w: 220, h: 28 };
    expect(stripFits(overLegend, bounds, [ohlc])).toBe(false);
    expect(resolveStripBox(overLegend, strip, bounds, [ohlc, ticket])).toEqual(strip);
    expect(resolveStripBox(overLegend, null, bounds, [ohlc])).toBeNull();

    const overTicket: Box = { x: 12, y: 250, w: 220, h: 28 };
    expect(resolveStripBox(overTicket, strip, bounds, [ticket])).toEqual(strip);
  });

  it('clamps a drag that leaves the chart column', () => {
    expect(clampBox({ x: -30, y: 10, w: 80, h: 24 }, bounds)).toEqual({
      x: 0,
      y: 10,
      w: 80,
      h: 24,
    });
    const outside: Box = { x: 360, y: 10, w: 80, h: 24 };
    expect(resolveStripBox(outside, null, bounds, [])).toEqual({ x: 320, y: 10, w: 80, h: 24 });
  });

  it('redocks only when the strip is released at the top-left slot', () => {
    expect(shouldRedock(0, 0)).toBe(true);
    expect(shouldRedock(12, 12)).toBe(true);
    expect(shouldRedock(13, 0)).toBe(false);
    expect(shouldRedock(0, 40)).toBe(false);
  });
});

describe('rules strip preference', () => {
  it('defaults docked and expanded, and remembers a collapse and a drag', () => {
    const storage = memory();
    expect(readRulesStripCollapsed(storage)).toBe(false);
    expect(readRulesStripPos(storage)).toBeNull();
    writeRulesStripCollapsed(true, storage);
    expect(storage.getItem(RULES_STRIP_COLLAPSED_KEY)).toBe('1');
    expect(readRulesStripCollapsed(storage)).toBe(true);
    writeRulesStripPos({ x: 24, y: 48 }, storage);
    expect(readRulesStripPos(storage)).toEqual({ x: 24, y: 48 });
    writeRulesStripPos(null, storage);
    expect(storage.getItem(RULES_STRIP_POS_KEY)).toBeNull();
    expect(readRulesStripPos(storage)).toBeNull();
    expect(readRulesStripPos({ ...storage, getItem: () => '{bad' })).toBeNull();
  });
});

describe('practice glance', () => {
  it('shows daily loss, trailing floor, and target, and nothing when rules are off', () => {
    expect(practiceGlance(settings(), createSession(bars, settings(), bars[0]!.time))).toEqual([]);
    const live = settings({ dailyLossLimit: 1000, trailingDrawdown: 5000, profitTarget: 3000 });
    const state = createSession(bars, live, bars[0]!.time);
    const metrics = practiceGlance(live, state);
    expect(metrics.map((m) => m.id)).toEqual(['dailyLoss', 'trailing', 'target']);
    const trail = metrics[1]!;
    expect(trail.line.find((f) => f.label === 'pr.ddFloor')?.amount).toBe(45_000);
    expect(trail.hot).toBe(false);
    expect(metrics[2]?.goal).toBe(true);
    expect(metrics[0]?.frac).toBe(0);
  });
});

describe('rules strip is not a side card', () => {
  it('mounts the strip above the chart and keeps the profile check off the rail', () => {
    const practice = readFileSync(`${root}/packages/web/src/practice.ts`, 'utf8');
    const side = readFileSync(`${root}/packages/web/src/side.ts`, 'utf8');
    expect(practice).toContain('new RulesStrip');
    expect(practice).toContain("id: 'rulecheck'");
    expect(practice).not.toContain('extra.prepend(this.rulesView');
    expect(side).not.toContain("data-testid': 'rules'");
    expect(side).toContain("data-testid': 'order-ticket'");
  });
});
