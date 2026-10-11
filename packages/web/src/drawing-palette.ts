// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Floating drawing-tool palette inside each chart pane.

import { t, type MessageKey } from './i18n.js';
import { el } from './format.js';

export type PaletteTool =
  'hline' | 'tline' | 'rect' | 'text' | 'arrow' | 'freehand' | 'long' | 'short' | null;

export interface DrawingPaletteHooks {
  select: (tool: PaletteTool) => void;
  clear: () => void;
}

export class DrawingPalette {
  private root: HTMLElement;
  private buttons = new Map<PaletteTool, HTMLButtonElement>();
  private active: PaletteTool = null;

  constructor(
    container: HTMLElement,
    private readonly hooks: DrawingPaletteHooks,
  ) {
    this.root = el('div', { class: 'drawing-palette' });
    const tools: { key: Exclude<PaletteTool, null>; i18n: MessageKey }[] = [
      { key: 'hline', i18n: 'pr.hline' },
      { key: 'tline', i18n: 'pr.tline' },
      { key: 'rect', i18n: 'pr.rect' },
      { key: 'text', i18n: 'pr.textTool' },
      { key: 'arrow', i18n: 'pr.arrowTool' },
      { key: 'freehand', i18n: 'pr.freehandTool' },
      { key: 'long', i18n: 'pr.longTool' },
      { key: 'short', i18n: 'pr.shortTool' },
    ];
    for (const { key, i18n } of tools) {
      const label = t(i18n);
      const b = el(
        'button',
        {
          type: 'button',
          class: 'small',
          title: label,
          'data-tool': key,
          'data-i18n': i18n,
          'data-i18n-title': i18n,
        },
        label,
      );
      b.addEventListener('click', () => this.toggle(key));
      this.buttons.set(key, b);
      this.root.append(b);
    }
    const clear = el(
      'button',
      {
        type: 'button',
        class: 'small ghost',
        title: t('pr.clearDrawings'),
        'data-tool': 'clear',
        'data-i18n-title': 'pr.clearDrawings',
      },
      '×',
    );
    clear.addEventListener('click', () => this.hooks.clear());
    this.root.append(clear);
    container.append(this.root);
  }

  private toggle(tool: Exclude<PaletteTool, null>): void {
    const next = this.active === tool ? null : tool;
    this.setActive(next);
    this.hooks.select(next);
  }

  setActive(tool: PaletteTool): void {
    this.active = tool;
    for (const [key, b] of this.buttons) b.setAttribute('aria-pressed', String(key === tool));
  }

  destroy(): void {
    this.root.remove();
  }
}
