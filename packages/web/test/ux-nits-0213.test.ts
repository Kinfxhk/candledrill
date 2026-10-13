// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { arrowHeadPath, clampPosition, type Drawing } from '../src/chart.js';
import {
  DEFAULT_OVERLAYS,
  loadIndicatorConfig,
  saveIndicatorConfig,
} from '../src/indicator-prefs.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('arrow head geometry', () => {
  it('draws a filled triangle large enough to read past endpoint handles', () => {
    const d = arrowHeadPath(100, 50, 0, 12);
    expect(d.startsWith('M100 50')).toBe(true);
    expect(d.endsWith('Z')).toBe(true);
    expect(d.match(/M/g)?.length).toBe(1);
  });
});

describe('long/short R body drag', () => {
  it('keeps stop/target on the correct side while the body is moved', () => {
    const d: Extract<Drawing, { kind: 'position' }> = {
      kind: 'position',
      id: 'r1',
      side: 'long',
      t1: 100,
      t2: 200,
      entry: 50,
      stop: 48,
      target: 54,
    };
    const moved = clampPosition({ ...d, entry: 60, stop: 58, target: 64, t1: 110, t2: 210 }, 0.25);
    expect(moved.stop).toBeLessThan(moved.entry);
    expect(moved.target).toBeGreaterThan(moved.entry);
  });
});

describe('volume indicator pref', () => {
  it('defaults volume visible and persists a toggle', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
    });
    const cfg = loadIndicatorConfig();
    const vol = cfg.overlays.find((o) => o.kind === 'volume');
    expect(vol?.visible).toBe(true);
    expect(DEFAULT_OVERLAYS[0]?.kind).toBe('volume');
    vol!.visible = false;
    saveIndicatorConfig(cfg);
    expect(loadIndicatorConfig().overlays.find((o) => o.kind === 'volume')?.visible).toBe(false);
  });

  it('migrates older prefs that lacked a volume row', () => {
    const store = new Map<string, string>();
    store.set(
      'candledrill.indicators',
      JSON.stringify({
        overlays: [{ kind: 'sma', visible: true, period: 9, source: 'close', color: '#7cc4ff' }],
        panes: [],
      }),
    );
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
    });
    const cfg = loadIndicatorConfig();
    expect(cfg.overlays.find((o) => o.kind === 'volume')?.visible).toBe(true);
    expect(cfg.overlays.find((o) => o.kind === 'sma' && o.period === 9)?.visible).toBe(true);
  });
});
