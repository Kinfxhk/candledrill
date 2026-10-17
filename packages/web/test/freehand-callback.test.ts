import { describe, expect, it } from 'vitest';
import { PriceChart } from '../src/chart.js';

describe('freehand simplify', () => {
  it('keeps endpoints and drops near duplicates', () => {
    const pts = [
      { t: 0, p: 100 },
      { t: 1, p: 100.1 },
      { t: 50, p: 110 },
      { t: 51, p: 110.2 },
      { t: 100, p: 90 },
    ];
    const out = PriceChart.simplifyFreehand(pts, 8);
    expect(out[0]).toEqual(pts[0]);
    expect(out[out.length - 1]).toEqual(pts[pts.length - 1]);
    expect(out.length).toBeLessThan(pts.length);
  });
});
