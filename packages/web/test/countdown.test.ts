// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSession, type Bar } from '@candledrill/core';
import { sessionsApi, type SessionViewDto } from '../src/api.js';
import {
  COUNTDOWN_E2E_KEY,
  COUNTDOWN_SEQUENCE,
  COUNTDOWN_STEP_MS,
  markCountdownPending,
  mountCountdown,
  takeCountdownPending,
} from '../src/countdown.js';
import { setLang } from '../src/i18n.js';
import { PracticeView } from '../src/practice.js';
import type * as Format from '../src/format.js';

vi.mock('../src/format.js', async (original) => ({
  ...(await original<typeof Format>()),
  toast: vi.fn(),
}));

const settings = {
  symbol: 'SYNTH-COUNT',
  tickSize: 0.25,
  pointValue: 1,
  commissionPerContract: 0,
  slippageTicks: 0,
  startingBalance: 50_000,
  dailyLossLimit: null,
  trailingDrawdown: null,
  profitTarget: null,
  utcOffsetMinutes: 0,
  dayStartMinutes: 0,
  trailingDrawdownMode: 'close' as const,
  anchorMinutes: 0,
};

function bar(time: number): Bar {
  return { time, open: 100, high: 101, low: 99, close: 100, volume: 1 };
}

function fixture(id: number, time: number, status: SessionViewDto['state']['status'] = 'active') {
  const bars = [bar(time), bar(time + 60)];
  const state = createSession(bars, settings, time + 60);
  return {
    session: {
      id,
      datasetId: id,
      name: `Session ${id}`,
      startTime: time + 60,
      settings,
      drawings: [],
      createdAt: '',
      updatedAt: '',
    },
    state: { ...state, status },
    cursorTime: time,
    bars: bars.slice(0, 1),
  } satisfies SessionViewDto & { bars: Bar[] };
}

class NodeEl {
  tagName: string;
  className = '';
  hidden = false;
  textContent = '';
  parent: NodeEl | null = null;
  children: NodeEl[] = [];
  attrs: Record<string, string> = {};
  listeners = new Map<string, Array<(ev: { preventDefault(): void }) => void>>();
  classList = {
    contains: (name: string) => this.className.split(/\s+/).includes(name),
    add: (...names: string[]) => {
      for (const name of names) {
        if (!this.classList.contains(name)) this.className = `${this.className} ${name}`.trim();
      }
    },
    remove: (...names: string[]) => {
      const drop = new Set(names);
      this.className = this.className
        .split(/\s+/)
        .filter((name) => name && !drop.has(name))
        .join(' ');
    },
    toggle: () => false,
  };

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

  removeAttribute(name: string): void {
    delete this.attrs[name];
  }

  append(...nodes: Array<NodeEl | string>): void {
    for (const node of nodes) {
      if (typeof node === 'string') {
        this.textContent += node;
        continue;
      }
      node.remove();
      node.parent = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes: NodeEl[]): void {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.textContent = '';
    this.append(...nodes);
  }

  remove(): void {
    const parent = this.parent;
    if (!parent) return;
    parent.children = parent.children.filter((child) => child !== this);
    this.parent = null;
  }

  addEventListener(type: string, fn: (ev: { preventDefault(): void }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  focus(): void {}

  query(testid: string): NodeEl | null {
    if (this.attrs['data-testid'] === testid) return this;
    for (const child of this.children) {
      const hit = child.query(testid);
      if (hit) return hit;
    }
    return null;
  }
}

const root = new NodeEl('div');
const empty = new NodeEl('div');
const viewPractice = new NodeEl('div');
viewPractice.className = 'active';
const body = new NodeEl('body');
const keyListeners: Array<
  (ev: { key: string; target: { tagName: string }; preventDefault(): void }) => void
> = [];
const store = new Map<string, string>();

function byTestId(testid: string): NodeEl | null {
  return root.query(testid);
}

function click(node: NodeEl): void {
  for (const fn of node.listeners.get('click') ?? []) fn({ preventDefault() {} });
}

type ViewHooks = { build(): void; resetCharts(): void; playing: boolean };
function hooks(view: PracticeView): ViewHooks {
  return view as unknown as ViewHooks;
}

let view: PracticeView | undefined;

beforeEach(() => {
  root.children = [];
  root.hidden = true;
  empty.hidden = false;
  store.clear();
  keyListeners.length = 0;
  vi.stubGlobal('document', {
    getElementById: (id: string) => {
      if (id === 'practice-root') return root;
      if (id === 'practice-empty') return empty;
      if (id === 'view-practice') return viewPractice;
      return null;
    },
    createElement: (tag: string) => new NodeEl(tag),
    addEventListener: (
      type: string,
      fn: (ev: { key: string; target: { tagName: string }; preventDefault(): void }) => void,
    ) => {
      if (type === 'keydown') keyListeners.push(fn);
    },
    querySelector: () => null,
    body,
  });
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  });
  vi.spyOn(PracticeView.prototype, 'render').mockImplementation(() => {});
  vi.spyOn(hooks(PracticeView.prototype), 'build').mockImplementation(() => {});
  vi.spyOn(hooks(PracticeView.prototype), 'resetCharts').mockImplementation(() => {});
  vi.spyOn(sessionsApi, 'open').mockImplementation(async (id) =>
    structuredClone(fixture(id, 1_000 + id, id === 9 ? 'finished' : 'active')),
  );
  vi.useFakeTimers();
});

afterEach(() => {
  view?.close();
  view = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setLang('en');
});

describe('session countdown', () => {
  it('shows 3 then 2 then 1, each with the pop animation, then starts play', async () => {
    markCountdownPending(1);
    view = new PracticeView();
    await view.open(1);
    const seen: string[] = [];
    const nodes: NodeEl[] = [];
    const read = () => {
      const num = byTestId('countdown-num');
      expect(num).not.toBeNull();
      expect(num!.className).toContain('countdown-pop');
      seen.push(num!.textContent);
      nodes.push(num!);
    };
    read();
    expect(byTestId('countdown-skip')!.textContent).toBe('Skip');
    expect(byTestId('countdown')).not.toBeNull();
    expect(hooks(view).playing).toBe(false);

    vi.advanceTimersByTime(COUNTDOWN_STEP_MS);
    read();
    vi.advanceTimersByTime(COUNTDOWN_STEP_MS);
    read();
    expect(seen).toEqual(COUNTDOWN_SEQUENCE.map(String));
    expect(nodes[0]).not.toBe(nodes[1]);
    expect(nodes[1]).not.toBe(nodes[2]);

    vi.advanceTimersByTime(COUNTDOWN_STEP_MS);
    expect(hooks(view).playing).toBe(true);
    expect(byTestId('countdown')).toBeNull();
  });

  it('Skip starts play immediately and does not keep counting', async () => {
    markCountdownPending(4);
    view = new PracticeView();
    await view.open(4);
    expect(byTestId('countdown-num')!.textContent).toBe('3');
    const play = vi.spyOn(view, 'play');
    click(byTestId('countdown-skip')!);
    expect(play).toHaveBeenCalledTimes(1);
    expect(hooks(view).playing).toBe(true);
    expect(byTestId('countdown')).toBeNull();
    view.pause();
    vi.advanceTimersByTime(COUNTDOWN_STEP_MS * COUNTDOWN_SEQUENCE.length);
    expect(play).toHaveBeenCalledTimes(1);
    expect(hooks(view).playing).toBe(false);
  });

  it('does not count down or play when the same session is opened again', async () => {
    markCountdownPending(2);
    view = new PracticeView();
    await view.open(2);
    expect(byTestId('countdown-num')!.textContent).toBe('3');
    await view.open(2);
    expect(byTestId('countdown')).toBeNull();
    expect(hooks(view).playing).toBe(false);
    vi.advanceTimersByTime(COUNTDOWN_STEP_MS * 4);
    expect(hooks(view).playing).toBe(false);
    expect(byTestId('countdown')).toBeNull();
  });

  it('counts down again for a different new session', async () => {
    markCountdownPending(1);
    markCountdownPending(2);
    view = new PracticeView();
    await view.open(1);
    expect(byTestId('countdown')).not.toBeNull();
    await view.open(2);
    expect(hooks(view).playing).toBe(false);
    expect(byTestId('countdown-num')!.textContent).toBe('3');
    vi.advanceTimersByTime(COUNTDOWN_STEP_MS * COUNTDOWN_SEQUENCE.length);
    expect(hooks(view).playing).toBe(true);
  });

  it('does not count down for an open that was not a new session', async () => {
    view = new PracticeView();
    await view.open(3);
    expect(byTestId('countdown')).toBeNull();
    vi.advanceTimersByTime(COUNTDOWN_STEP_MS * 4);
    expect(hooks(view).playing).toBe(false);
  });

  it('does not count down or play when the armed session is already finished', async () => {
    markCountdownPending(9);
    view = new PracticeView();
    await view.open(9);
    expect(byTestId('countdown')).toBeNull();
    expect(hooks(view).playing).toBe(false);
    vi.advanceTimersByTime(COUNTDOWN_STEP_MS * 4);
    expect(hooks(view).playing).toBe(false);
    await view.open(9);
    expect(byTestId('countdown')).toBeNull();
  });

  it('Escape skips the countdown into play', async () => {
    markCountdownPending(6);
    view = new PracticeView();
    await view.open(6);
    for (const fn of keyListeners) {
      fn({
        key: 'Escape',
        target: { tagName: 'BODY' },
        preventDefault() {},
      });
    }
    expect(hooks(view).playing).toBe(true);
    expect(byTestId('countdown')).toBeNull();
  });

  it('closing during the countdown does not start play', async () => {
    markCountdownPending(7);
    view = new PracticeView();
    await view.open(7);
    view.close();
    vi.advanceTimersByTime(COUNTDOWN_STEP_MS * 4);
    expect(hooks(view).playing).toBe(false);
    expect(byTestId('countdown')).toBeNull();
  });

  it('arms each id once and survives a broken storage', () => {
    markCountdownPending(8);
    markCountdownPending(8);
    expect(takeCountdownPending(8)).toBe(true);
    expect(takeCountdownPending(8)).toBe(false);
    expect(takeCountdownPending(0)).toBe(false);

    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(() => markCountdownPending(1)).not.toThrow();
    expect(takeCountdownPending(1)).toBe(false);
  });

  it('uses the current language on Skip and cancel does not complete', () => {
    const host = new NodeEl('div');
    const done = vi.fn();
    setLang('zh-Hant');
    const countdown = mountCountdown(host as unknown as HTMLElement, {
      onComplete: done,
      stepMs: COUNTDOWN_STEP_MS,
    });
    expect(host.query('countdown-skip')!.textContent).toBe('跳過');
    expect(host.query('countdown-num')!.textContent).toBe('3');
    countdown.cancel();
    vi.advanceTimersByTime(COUNTDOWN_STEP_MS * 4);
    expect(done).not.toHaveBeenCalled();
    expect(host.query('countdown')).toBeNull();

    setLang('ja');
    const again = mountCountdown(host as unknown as HTMLElement, { onComplete: done });
    expect(host.query('countdown-skip')!.textContent).toBe('スキップ');
    setLang('ko');
    again.syncLabel();
    expect(host.query('countdown-skip')!.textContent).toBe('건너뛰기');
    setLang('zh-Hans');
    again.syncLabel();
    expect(host.query('countdown-skip')!.textContent).toBe('跳过');
    again.cancel();
  });

  it('arms the countdown from new-session creation only', () => {
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
    expect(main.match(/markCountdownPending\(/g)).toHaveLength(1);
    expect(main).toContain('markCountdownPending(view.session.id)');
    const spec = readFileSync(new URL('../../../e2e/countdown.spec.ts', import.meta.url), 'utf8');
    const config = readFileSync(new URL('../../../playwright.config.ts', import.meta.url), 'utf8');
    expect(spec).toContain(COUNTDOWN_E2E_KEY);
    expect(config).toContain(COUNTDOWN_E2E_KEY);
  });

  it('stays stopped when the e2e flag is off', async () => {
    localStorage.setItem(COUNTDOWN_E2E_KEY, '0');
    markCountdownPending(5);
    view = new PracticeView();
    await view.open(5);
    expect(byTestId('countdown')).toBeNull();
    vi.advanceTimersByTime(COUNTDOWN_STEP_MS * 4);
    expect(hooks(view).playing).toBe(false);
  });

  it('does not count down in an automated browser unless e2e opts in', async () => {
    vi.stubGlobal('navigator', { webdriver: true });
    markCountdownPending(5);
    view = new PracticeView();
    await view.open(5);
    expect(byTestId('countdown')).toBeNull();
    vi.advanceTimersByTime(COUNTDOWN_STEP_MS * 4);
    expect(hooks(view).playing).toBe(false);
    view.close();

    localStorage.setItem(COUNTDOWN_E2E_KEY, '1');
    markCountdownPending(5);
    view = new PracticeView();
    await view.open(5);
    expect(byTestId('countdown-num')!.textContent).toBe('3');
    expect(hooks(view).playing).toBe(false);
  });
});
