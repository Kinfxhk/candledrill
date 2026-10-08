// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { DAY_MS, loadBackup, shouldRemind } from '../src/reminder.js';
import { clampPosition, type Drawing } from '../src/chart.js';

describe('backup reminder', () => {
  const now = Date.UTC(2026, 9, 8);
  it('reminds after a few changes and stays quiet after a backup or dismissal', () => {
    expect(shouldRemind({ lastBackup: null, dismissedAt: null, changes: 2 }, now)).toBe(false);
    expect(shouldRemind({ lastBackup: null, dismissedAt: null, changes: 3 }, now)).toBe(true);
    expect(shouldRemind({ lastBackup: now - DAY_MS, dismissedAt: null, changes: 9 }, now)).toBe(
      false,
    );
    expect(shouldRemind({ lastBackup: null, dismissedAt: now - DAY_MS, changes: 9 }, now)).toBe(
      false,
    );
    expect(
      shouldRemind({ lastBackup: now - 15 * DAY_MS, dismissedAt: null, changes: 9 }, now),
    ).toBe(true);
    // A clock set back does not silence it forever.
    expect(
      shouldRemind({ lastBackup: now + 400 * DAY_MS, dismissedAt: null, changes: 9 }, now),
    ).toBe(true);
  });
  it('loading never throws on junk', () => {
    for (const raw of [
      null,
      '',
      'x',
      '[]',
      'null',
      '{"changes":-5,"lastBackup":"y"}',
      '{"changes":1e999}',
    ])
      expect(loadBackup(raw).changes).toBeGreaterThanOrEqual(0);
  });
});

describe('R tool', () => {
  type P = Extract<Drawing, { kind: 'position' }>;
  it('property: stop stays on the losing side and target on the winning side', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('long' as const, 'short' as const),
        fc.integer({ min: 100, max: 10_000 }),
        fc.integer({ min: -500, max: 500 }),
        fc.integer({ min: -500, max: 500 }),
        (side, e, s, tgt) => {
          const tick = 0.25;
          const d: P = {
            kind: 'position',
            id: 'a',
            side,
            t1: 0,
            t2: 60,
            entry: e * tick,
            stop: (e + s) * tick,
            target: (e + tgt) * tick,
          };
          const c = clampPosition(d, tick);
          const dir = side === 'long' ? 1 : -1;
          expect(dir * (c.entry - c.stop)).toBeGreaterThanOrEqual(tick - 1e-9);
          expect(dir * (c.target - c.entry)).toBeGreaterThanOrEqual(tick - 1e-9);
          if (dir * s < 0) expect(c.stop).toBe(d.stop); // already valid: untouched
          if (dir * tgt > 0) expect(c.target).toBe(d.target);
        },
      ),
    );
  });
});
