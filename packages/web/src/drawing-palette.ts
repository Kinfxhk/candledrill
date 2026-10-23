// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Collapsible floating drawing-tool palette inside each chart pane (UX Option A).

import * as overlays from './overlays.js';
import { t, type MessageKey } from './i18n.js';
import { el } from './format.js';

/** Phone / short-screen layout (the tools become a bottom sheet there, see phone.css). */
export const PaletteLayout = {
  compact: (): boolean =>
    typeof window !== 'undefined' &&
    !!window.matchMedia?.('(max-width: 899px), (max-height: 520px)').matches,
};

export type PaletteTool =
  | 'hline'
  | 'tline'
  | 'ray'
  | 'vline'
  | 'channel'
  | 'fib'
  | 'measure'
  | 'rect'
  | 'text'
  | 'arrow'
  | 'freehand'
  | 'long'
  | 'short'
  | null;

export interface DrawingPaletteHooks {
  select: (tool: PaletteTool) => void;
  clear: () => void;
}

export const PALETTE_EXPANDED_KEY = 'candledrill.paletteExpanded';

export function readPaletteExpanded(storage: Pick<Storage, 'getItem'> = localStorage): boolean {
  return storage.getItem(PALETTE_EXPANDED_KEY) === '1';
}

export function writePaletteExpanded(
  on: boolean,
  storage: Pick<Storage, 'setItem'> = localStorage,
): void {
  storage.setItem(PALETTE_EXPANDED_KEY, on ? '1' : '0');
}

const TOOLS: { key: Exclude<PaletteTool, null>; i18n: MessageKey }[] = [
  { key: 'hline', i18n: 'pr.hline' },
  { key: 'tline', i18n: 'pr.tline' },
  { key: 'ray', i18n: 'v1.toolRay' },
  { key: 'vline', i18n: 'v1.toolVline' },
  { key: 'channel', i18n: 'v1.toolChannel' },
  { key: 'fib', i18n: 'v1.toolFib' },
  { key: 'measure', i18n: 'v1.toolMeasure' },
  { key: 'rect', i18n: 'pr.rect' },
  { key: 'text', i18n: 'pr.textTool' },
  { key: 'arrow', i18n: 'pr.arrowTool' },
  { key: 'freehand', i18n: 'pr.freehandTool' },
  { key: 'long', i18n: 'pr.longTool' },
  { key: 'short', i18n: 'pr.shortTool' },
];

export class DrawingPalette {
  private root: HTMLElement;
  private toggleBtn: HTMLButtonElement;
  private toolsEl: HTMLElement;
  private buttons = new Map<PaletteTool, HTMLButtonElement>();
  private active: PaletteTool = null;
  private expanded: boolean;

  constructor(
    container: HTMLElement,
    private readonly hooks: DrawingPaletteHooks,
  ) {
    // Always start folded: an open palette covers the chart and must be opened on purpose.
    this.expanded = false;
    void readPaletteExpanded;
    this.root = el('div', {
      class: 'drawing-palette',
      'data-testid': 'drawing-palette',
    });
    this.toggleBtn = el(
      'button',
      {
        type: 'button',
        class: 'small drawing-palette-toggle',
        'data-testid': 'drawing-palette-toggle',
        'data-i18n': 'pr.drawTools',
        'data-i18n-title': 'pr.drawTools',
        title: t('pr.drawTools'),
        'aria-expanded': String(this.expanded),
        'aria-controls': '',
      },
      t('pr.drawTools'),
    );
    this.toolsEl = el('div', {
      class: 'drawing-palette-tools',
      role: 'toolbar',
      'aria-label': t('pr.drawTools'),
      'data-i18n-aria': 'pr.drawTools',
    });
    const toolsId = `drawing-palette-tools-${Math.random().toString(36).slice(2, 9)}`;
    this.toolsEl.id = toolsId;
    this.toggleBtn.setAttribute('aria-controls', toolsId);

    for (const { key, i18n } of TOOLS) {
      const label = t(i18n);
      const b = el(
        'button',
        {
          type: 'button',
          class: 'small',
          title: label,
          'data-tool': key,
          'data-testid': `palette-${key}`,
          'data-i18n': i18n,
          'data-i18n-title': i18n,
        },
        label,
      );
      b.addEventListener('click', () => this.toggleTool(key));
      this.buttons.set(key, b);
      this.toolsEl.append(b);
    }

    const clear = el(
      'button',
      {
        type: 'button',
        class: 'small ghost drawing-palette-clear',
        title: t('pr.clearDrawings'),
        'data-tool': 'clear',
        'data-testid': 'drawing-palette-clear',
        'data-i18n': 'pr.clearDrawings',
        'data-i18n-title': 'pr.clearDrawings',
      },
      t('pr.clearDrawings'),
    );
    clear.addEventListener('click', () => {
      if (!confirm(t('pr.clearDrawingsConfirm'))) return;
      this.hooks.clear();
    });
    this.toolsEl.append(clear);

    this.toggleBtn.addEventListener('click', () => this.setExpanded(!this.expanded));
    this.root.append(this.toggleBtn, this.toolsEl);
    this.applyExpanded();
    container.append(this.root);
  }

  private toggleTool(tool: Exclude<PaletteTool, null>): void {
    const next = this.active === tool ? null : tool;
    this.setActive(next);
    this.hooks.select(next);
    // Phones: picking a tool folds the tools sheet so the chart is free to draw on (the Draw
    // button names the active tool). Desktop keeps the palette open for repeated drawing.
    if (next !== null && PaletteLayout.compact()) this.setExpanded(false);
  }

  setActive(tool: PaletteTool): void {
    this.active = tool;
    for (const [key, b] of this.buttons) b.setAttribute('aria-pressed', String(key === tool));
    // The folded Draw button names the tool in use, so a folded palette is never ambiguous.
    const label = tool ? (this.buttons.get(tool)?.textContent ?? '') : '';
    this.toggleBtn.textContent = tool ? `${t('pr.drawTools')} · ${label}` : t('pr.drawTools');
    this.toggleBtn.classList.toggle('active-tool', tool !== null);
  }

  isExpanded(): boolean {
    return this.expanded;
  }

  private readonly overlayId = `pal-${Math.random().toString(36).slice(2, 8)}`;

  setExpanded(on: boolean): void {
    this.expanded = on;
    writePaletteExpanded(on);
    this.applyExpanded();
    // Phones only: the tools sheet closes on an outside tap. On desktop the palette is a
    // toolbar you keep open while drawing, so a chart click must reach the chart.
    if (on && PaletteLayout.compact())
      overlays.opened({
        id: this.overlayId,
        contains: (n) => this.root.contains(n),
        close: () => this.setExpanded(false),
      });
    else overlays.closed(this.overlayId);
  }

  expand(): void {
    this.setExpanded(true);
  }

  collapse(): void {
    this.setExpanded(false);
  }

  private applyExpanded(): void {
    this.root.classList.toggle('collapsed', !this.expanded);
    this.toggleBtn.setAttribute('aria-expanded', String(this.expanded));
    this.toolsEl.hidden = !this.expanded;
  }

  destroy(): void {
    this.root.remove();
  }
}
