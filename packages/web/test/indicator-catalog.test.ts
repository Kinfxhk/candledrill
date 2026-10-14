// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { filterCatalog } from '../src/indicator-catalog.js';
import {
  createIndicator,
  loadIndicatorConfig,
  saveIndicatorConfig,
} from '../src/indicator-prefs.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
  });
  return store;
}

describe('indicator catalog v2', () => {
  it('finds SMA by alias and keeps a second period after save', () => {
    expect(filterCatalog('moving', 'trend').some((item) => item.kind === 'sma')).toBe(true);
    expect(filterCatalog('orb', 'session').map((item) => item.kind)).toContain('orb');
    stubStorage();
    const cfg = loadIndicatorConfig();
    cfg.overlays.push(createIndicator('sma', { period: 200, visible: true }));
    saveIndicatorConfig(cfg);
    const periods = loadIndicatorConfig()
      .overlays.filter((o) => o.kind === 'sma')
      .map((o) => o.period);
    expect(periods).toContain(9);
    expect(periods).toContain(200);
    expect(new Set(loadIndicatorConfig().overlays.map((o) => o.id)).size).toBe(
      loadIndicatorConfig().overlays.length,
    );
  });

  it('migrates a v1 slot list when v2 is absent', () => {
    const store = stubStorage();
    store.set(
      'candledrill.indicators',
      JSON.stringify({
        overlays: [{ kind: 'ema', visible: true, period: 21, source: 'close', color: '#d4892a' }],
        panes: [],
      }),
    );
    const cfg = loadIndicatorConfig();
    expect(cfg.overlays.find((o) => o.kind === 'volume')?.visible).toBe(true);
    const visibleEma = cfg.overlays.find((o) => o.kind === 'ema' && o.visible);
    expect(visibleEma?.period).toBe(21);
  });
});
