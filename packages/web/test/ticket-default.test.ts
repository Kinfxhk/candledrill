// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  blankProfile,
  createSession,
  profileToSettings,
  type OrderRequest,
} from '@candledrill/core';
import { sessionStatusText } from '../src/labels.js';
import { DEFAULT_ORDER_TYPE, SidePanel } from '../src/side.js';

const rootDir = fileURLToPath(new URL('../../..', import.meta.url));

/** Enough of a DOM for the order ticket. Vitest runs in node. */
class FakeEl {
  readonly attrs = new Map<string, string>();
  children: (FakeEl | string)[] = [];
  parent: FakeEl | null = null;
  className = '';
  hidden = false;
  value = '';
  disabled = false;
  step = '';
  readonly style: Record<string, string> = {};
  readonly listeners = new Map<string, (() => void)[]>();

  constructor(readonly tagName: string) {}

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
    if (name === 'value') this.value = value;
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  addEventListener(type: string, fn: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  append(...nodes: (FakeEl | string)[]): void {
    for (const node of nodes) {
      if (typeof node !== 'string') node.parent = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes: (FakeEl | string)[]): void {
    this.children = [];
    this.append(...nodes);
  }
  querySelector(): null {
    return null;
  }
  querySelectorAll(): FakeEl[] {
    return [];
  }
  click(): void {
    for (const fn of this.listeners.get('click') ?? []) fn();
  }
  get textContent(): string {
    return this.children
      .map((child) => (typeof child === 'string' ? child : child.textContent))
      .join('');
  }
  set textContent(value: string) {
    this.children = [value];
  }
}

function installDom(): void {
  const body = new FakeEl('body');
  const document = {
    body,
    activeElement: null as FakeEl | null,
    createElement: (tag: string) => new FakeEl(tag),
  };
  // SidePanel and `el` use the real DOM globals.
  globalThis.document = document as unknown as Document;
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
    clear: () => undefined,
    key: () => null,
    length: 0,
  };
}

function walk(node: FakeEl): FakeEl[] {
  return [node, ...node.children.filter((c): c is FakeEl => typeof c !== 'string').flatMap(walk)];
}

function byTestId(node: FakeEl, id: string): FakeEl {
  const found = walk(node).find((el) => el.getAttribute('data-testid') === id);
  if (!found) throw new Error(`missing ${id}`);
  return found;
}

const settings = {
  symbol: 'SYNTH',
  tickSize: 0.25,
  pointValue: 1,
  commissionPerContract: 0,
  slippageTicks: 1,
  startingBalance: 50_000,
  dailyLossLimit: null,
  trailingDrawdown: null,
  profitTarget: null,
  utcOffsetMinutes: 0,
  dayStartMinutes: 0,
  trailingDrawdownMode: 'close' as const,
  anchorMinutes: 0,
};

function openTicket(): { panel: SidePanel; root: FakeEl; placed: OrderRequest[] } {
  installDom();
  const root = new FakeEl('div');
  const placed: OrderRequest[] = [];
  const panel = new SidePanel(root as unknown as HTMLElement, {
    place: (req) => {
      placed.push(req);
      return Promise.resolve();
    },
    cancel: () => Promise.resolve(),
    modify: () => Promise.resolve(),
    flatten: () => Promise.resolve(),
  });
  const bars = [
    { time: 0, open: 100, high: 101, low: 99, close: 100, volume: 1 },
    { time: 60, open: 100, high: 102, low: 99, close: 101, volume: 1 },
  ];
  const state = createSession(bars, settings, 0);
  panel.render(settings, state);
  return { panel, root, placed };
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'document');
  Reflect.deleteProperty(globalThis, 'localStorage');
});

describe('default order ticket', () => {
  it('opens a new practice session on market while the session is active', async () => {
    const { panel, root, placed } = openTicket();
    expect(DEFAULT_ORDER_TYPE).toBe('market');
    expect(sessionStatusText('active')).toBe('Active');
    const market = byTestId(root, 'type-market');
    const limit = byTestId(root, 'type-limit');
    const stop = byTestId(root, 'type-stop');
    expect(market.getAttribute('aria-pressed')).toBe('true');
    expect(market.textContent).toBe('Market');
    expect(limit.getAttribute('aria-pressed')).toBe('false');
    expect(stop.getAttribute('aria-pressed')).toBe('false');
    expect(byTestId(root, 'price').parent?.hidden).toBe(true);

    await panel.submit('buy');
    expect(placed.at(-1)).toMatchObject({ side: 'buy', type: 'market', qty: 1, price: null });

    // The phone trade bar has no type control. It uses this same ticket.
    await panel.submitWith('sell', 2);
    expect(placed.at(-1)).toMatchObject({ side: 'sell', type: 'market', qty: 2, price: null });
  });

  it('does not fall back to limit on a chart click, and still lets the user switch', async () => {
    const { panel, root, placed } = openTicket();
    panel.setPrice(99);
    expect(byTestId(root, 'type-market').getAttribute('aria-pressed')).toBe('true');
    expect(byTestId(root, 'type-limit').getAttribute('aria-pressed')).toBe('false');
    expect(byTestId(root, 'price').parent?.hidden).toBe(true);
    await panel.submit('buy');
    expect(placed.at(-1)?.type).toBe('market');

    byTestId(root, 'type-limit').click();
    expect(byTestId(root, 'type-limit').getAttribute('aria-pressed')).toBe('true');
    expect(byTestId(root, 'type-market').getAttribute('aria-pressed')).toBe('false');
    expect(byTestId(root, 'price').parent?.hidden).toBe(false);
    panel.setPrice(99);
    await panel.submit('buy');
    expect(placed.at(-1)).toMatchObject({ type: 'limit', price: 99 });

    panel.applyDefaults();
    expect(byTestId(root, 'type-limit').getAttribute('aria-pressed')).toBe('true');
    byTestId(root, 'type-market').click();
    expect(byTestId(root, 'type-market').getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps backtest, follow-along, and a new profile off a limit default', () => {
    const macro = readFileSync(`${rootDir}/packages/core/src/macro.ts`, 'utf8');
    const practice = readFileSync(`${rootDir}/packages/web/src/practice.ts`, 'utf8');
    const side = readFileSync(`${rootDir}/packages/web/src/side.ts`, 'utf8');
    expect(macro).toMatch(/sessionPlaceOrder\([\s\S]*?type: 'market'/);
    expect(practice).toMatch(/type: 'market'/);
    expect(side).not.toContain("setType('limit')");
    expect(practice.match(/new SidePanel/g)).toHaveLength(1);

    const profile = blankProfile('new-profile', 'New profile');
    expect(profile).not.toHaveProperty('orderType');
    expect(profileToSettings(profile)).not.toHaveProperty('type');
  });
});
