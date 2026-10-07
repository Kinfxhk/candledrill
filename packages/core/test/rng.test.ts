// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createRng } from '../src/index.js';

describe('createRng', () => {
  it('is deterministic for the same seed', () => {
    const a = createRng(42);
    const b = createRng(42);
    for (let i = 0; i < 1000; i++) expect(a.next()).toBe(b.next());
  });

  it('produces different streams for different seeds', () => {
    const a = createRng(1);
    const b = createRng(2);
    const sa = Array.from({ length: 16 }, () => a.next());
    const sb = Array.from({ length: 16 }, () => b.next());
    expect(sa).not.toEqual(sb);
  });

  it('stays in [0, 1) for any seed', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffffff }), (seed) => {
        const r = createRng(seed);
        for (let i = 0; i < 200; i++) {
          const x = r.next();
          if (!(x >= 0 && x < 1)) return false;
        }
        return true;
      }),
    );
  });

  it('normal() has roughly mean 0 and sd 1', () => {
    const r = createRng(7);
    const n = 40_000;
    let sum = 0;
    let sq = 0;
    for (let i = 0; i < n; i++) {
      const z = r.normal();
      sum += z;
      sq += z * z;
    }
    const mean = sum / n;
    const sd = Math.sqrt(sq / n - mean * mean);
    expect(Math.abs(mean)).toBeLessThan(0.03);
    expect(Math.abs(sd - 1)).toBeLessThan(0.03);
  });

  it.each([-1, 1.5, 2 ** 32, Number.NaN])('rejects invalid seed %s', (seed) => {
    expect(() => createRng(seed)).toThrow(RangeError);
  });
});
