// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { bracketMarkerLabel, bracketMarkerSize } from '../src/chart.js';

describe('bracket markers', () => {
  it('labels the tick distance from the last close', () => {
    expect(bracketMarkerLabel('stop-loss', 102, 100, 0.25)).toBe('SL +8t');
    expect(bracketMarkerLabel('take-profit', 99, 100, 0.25)).toBe('TP -4t');
    expect(bracketMarkerLabel('stop-loss', 100, 100, 0.25)).toBe('SL 0t');
    expect(bracketMarkerLabel('take-profit', 100.5, 100, 0)).toBe('TP 0t');
  });

  it('uses a 44px hit target for coarse pointers', () => {
    expect(bracketMarkerSize(true)).toEqual({ w: 88, h: 44 });
    expect(bracketMarkerSize(false)).toEqual({ w: 72, h: 28 });
  });
});
