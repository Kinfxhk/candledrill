// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Floating drawing-tool palette inside each chart pane.

import { t } from './i18n.js';
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
    const tools: { key: Exclude<PaletteTool, null>; label: string }[] = [
      { key: 'hline', label: t('pr.hline') },
      { key: 'tline', label: t('pr.tline') },
      { key: 'rect', label: t('pr.rect') },
      { key: 'text', label: t('pr.textTool') },
      { key: 'arrow', label: t('pr.arrowTool') },
      { key: 'freehand', label: t('pr.freehandTool') },
      { key: 'long', label: t('pr.longTool') },
      { key: 'short', label: t('pr.shortTool') },
    ];
    for (const { key, label } of tools) {
      const b = el(
        'button',
        { type: 'button', class: 'small', title: label, 'data-tool': key },
        label,
      );
      b.addEventListener('click', () => this.toggle(key));
      this.buttons.set(key, b);
      this.root.append(b);
    }
    const clear = el(
      'button',
      { type: 'button', class: 'small ghost', title: t('pr.clearDrawings'), 'data-tool': 'clear' },
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
