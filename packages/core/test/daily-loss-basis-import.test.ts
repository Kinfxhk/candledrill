// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  createSession,
  parseSessionFile,
  sessionPlaceOrder,
  stepSession,
  type Bar,
  type SessionSettings,
} from '../src/index.js';

const base: SessionSettings = {
  symbol: 'SYNTH',
  tickSize: 1,
  pointValue: 10,
  commissionPerContract: 0,
  slippageTicks: 0,
  startingBalance: 1000,
  dailyLossLimit: 100,
  trailingDrawdown: null,
  trailingDrawdownMode: 'close',
  profitTarget: null,
  utcOffsetMinutes: 0,
  dayStartMinutes: 0,
  anchorMinutes: 0,
};

/** Wick through the daily-loss limit; the close itself stays inside it. */
const bars: Bar[] = [
  { time: 0, open: 100, high: 100, low: 100, close: 100, volume: 100 },
  { time: 60, open: 100, high: 101, low: 88, close: 99, volume: 100 },
];

function sessionFile(settings: object): string {
  return JSON.stringify({
    format: 'candledrill-session',
    formatVersion: 1,
    name: 'Old',
    startTime: 0,
    settings,
    state: { version: 1 },
    drawings: [],
  });
}

/** Market buy, then the adverse bar. End of data finishes a session that did not breach. */
function run(settings: SessionSettings) {
  const init = sessionPlaceOrder(bars, settings, createSession(bars, settings, 0), {
    side: 'buy',
    type: 'market',
    qty: 1,
  });
  return stepSession(bars, settings, init, 1).state;
}

describe('dailyLossBasis session files', () => {
  it('imports an old file without the field and keeps close-only daily loss', () => {
    const parsed = parseSessionFile(sessionFile(base));
    expect(parsed.issues).toEqual([]);
    expect(parsed.file!.settings.dailyLossBasis).toBeUndefined();
    expect(run(parsed.file!.settings).status).toBe('finished');
    expect(run(parsed.file!.settings).statusReason).toBe('end of data');
  });

  it('round-trips dailyLossBasis intraday and still rejects other values', () => {
    const parsed = parseSessionFile(sessionFile({ ...base, dailyLossBasis: 'intraday' }));
    expect(parsed.issues).toEqual([]);
    expect(parsed.file!.settings.dailyLossBasis).toBe('intraday');
    const again = parseSessionFile(sessionFile(parsed.file!.settings));
    expect(again.issues).toEqual([]);
    expect(again.file!.settings.dailyLossBasis).toBe('intraday');
    const breached = run(parsed.file!.settings);
    expect(breached.status).toBe('breached');
    expect(breached.statusReason).toContain('daily loss limit');

    const close = parseSessionFile(sessionFile({ ...base, dailyLossBasis: 'close' }));
    expect(close.issues).toEqual([]);
    expect(close.file!.settings.dailyLossBasis).toBe('close');
    expect(run(close.file!.settings).status).toBe('finished');

    const bad = parseSessionFile(sessionFile({ ...base, dailyLossBasis: 'wick' }));
    expect(bad.file).toBeUndefined();
    expect(bad.issues.join(' ')).toMatch(/dailyLossBasis/);

    const extra = parseSessionFile(sessionFile({ ...base, notASetting: 1 }));
    expect(extra.file).toBeUndefined();
    expect(extra.issues.join(' ')).toMatch(/unknown/);
  });
});
