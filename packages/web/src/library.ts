// SPDX-License-Identifier: AGPL-3.0-or-later
// Library view: datasets, static preview chart, CSV import, new practice session form.

import { api, ApiError, type DatasetRow } from './api.js';
import { PriceChart } from './chart.js';
import { t } from './i18n.js';
import { el, fmtTime, tfLabel, toast } from './format.js';
import { setupImporter } from './importer.js';

export interface LibraryHooks {
  /** Called when the user submits the new-session form (wired from M2 on). */
  createSession?: (ds: DatasetRow, form: HTMLFormElement) => Promise<void>;
  /** Re-render the sessions table (wired from M4 on). */
  renderSessions?: () => Promise<void>;
}

export class LibraryView {
  private datasets: DatasetRow[] = [];
  private selected: DatasetRow | undefined;
  private chart: PriceChart | undefined;
  private readonly list = document.getElementById('dataset-list')!;
  private readonly form = document.getElementById('new-session-form') as HTMLFormElement;
  private readonly openImport: () => void;

  constructor(private readonly hooks: LibraryHooks = {}) {
    this.openImport = setupImporter((ds) => void this.reload(ds.id));
    document.getElementById('btn-import')!.addEventListener('click', () => this.openImport());
    document.getElementById('btn-demo')!.addEventListener('click', () => void this.createDemo());
    const blind = this.form.elements.namedItem('blind') as HTMLInputElement;
    blind.addEventListener('change', () => {
      this.applyBlindToggle();
      // Seeing the whole dataset right before a blind session would spoil it.
      if (blind.checked) this.chart?.setBars([]);
      else if (this.selected) void this.select(this.selected.id);
    });
    this.form.addEventListener('blind-reset', () => this.applyBlindToggle());
    this.form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (this.selected && this.hooks.createSession)
        void this.hooks.createSession(this.selected, this.form);
    });
  }

  async reload(selectId?: number): Promise<void> {
    this.datasets = (await api.datasets()).datasets;
    this.renderList();
    const next =
      this.datasets.find((d) => d.id === selectId) ?? this.selected ?? this.datasets.at(-1);
    if (next && this.datasets.some((d) => d.id === next.id)) await this.select(next.id);
    else this.clearSelection();
    await this.hooks.renderSessions?.();
  }

  private async createDemo(): Promise<void> {
    const seed = (Math.floor(Math.random() * 0xffffffff) >>> 0) % 4294967295;
    const start = new Date(Date.UTC(2026, 0, 5)).toISOString().slice(0, 10);
    const { dataset } = await api.createSynthetic(seed, start, 28);
    toast(`${dataset.symbol}: ${dataset.barCount} ${t('lib.bars')}`);
    await this.reload(dataset.id);
  }

  private renderList(): void {
    document.getElementById('dataset-empty')!.hidden = this.datasets.length > 0;
    this.list.replaceChildren(
      ...this.datasets.map((d) => {
        const del = el(
          'button',
          { type: 'button', class: 'small ghost', 'aria-label': `${t('lib.delete')} ${d.name}` },
          t('lib.delete'),
        );
        del.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          if (!confirm(t('lib.confirmDelete'))) return;
          await api.deleteDataset(d.id);
          if (this.selected?.id === d.id) this.selected = undefined;
          await this.reload();
        });
        const li = el(
          'li',
          {
            role: 'option',
            tabindex: '0',
            'aria-selected': String(this.selected?.id === d.id),
            'data-id': String(d.id),
          },
          el(
            'div',
            { class: 'row' },
            el('span', { class: 'title' }, d.name),
            el(
              'span',
              { class: `badge ${d.synthetic ? 'synth' : ''}` },
              d.synthetic ? t('lib.synthetic') : t('lib.imported'),
            ),
            el('span', { class: 'spacer' }),
            del,
          ),
          el(
            'div',
            { class: 'muted' },
            `${d.symbol} · ${tfLabel(d.timeframeSeconds)} · ${d.barCount.toLocaleString()} ${t('lib.bars')} · ` +
              `${fmtTime(d.firstTime, d.utcOffsetMinutes)} → ${fmtTime(d.lastTime, d.utcOffsetMinutes)}`,
          ),
        );
        li.addEventListener('click', () => void this.select(d.id));
        li.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            void this.select(d.id);
          }
        });
        return li;
      }),
    );
  }

  private clearSelection(): void {
    this.selected = undefined;
    this.form.hidden = true;
    this.chart?.setBars([]);
  }

  async select(id: number): Promise<void> {
    const ds = this.datasets.find((d) => d.id === id);
    if (!ds) return;
    this.selected = ds;
    this.list
      .querySelectorAll('li')
      .forEach((li) => li.setAttribute('aria-selected', String(li.dataset.id === String(id))));
    if (!this.chart) this.chart = new PriceChart(document.getElementById('preview-chart')!);
    this.chart.setTimeShift(ds.utcOffsetMinutes * 60);
    this.chart.setTickSize(ds.tickSize);
    this.prefillForm(ds);
    const locked = document.getElementById('preview-locked')!;
    locked.hidden = true;
    const blind = (this.form.elements.namedItem('blind') as HTMLInputElement).checked;
    if (blind) this.chart.setBars([]);
    else {
      try {
        const { bars } = await api.previewBars(id);
        this.chart.setBars(bars);
        this.chart.fit();
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 423)) throw err;
        this.chart.setBars([]);
        locked.hidden = false;
      }
    }
  }

  /** Default session name; a blind session must not be named after the symbol. */
  private defaultName(ds: DatasetRow): string {
    const blind = (this.form.elements.namedItem('blind') as HTMLInputElement).checked;
    return `${blind ? t('pr.blindBadge') : ds.symbol} ${new Date().toISOString().slice(0, 10)}`;
  }

  private applyBlindToggle(): void {
    const name = this.form.elements.namedItem('name') as HTMLInputElement;
    if (this.selected) {
      const ds = this.selected;
      const date = new Date().toISOString().slice(0, 10);
      const defaults = [`${ds.symbol} ${date}`, `${t('pr.blindBadge')} ${date}`];
      if (defaults.includes(name.value)) name.value = this.defaultName(ds);
    }
    const blind = (this.form.elements.namedItem('blind') as HTMLInputElement).checked;
    const start = this.form.elements.namedItem('start') as HTMLInputElement;
    start.disabled = blind;
    start.required = !blind;
  }

  get selectedDataset(): DatasetRow | undefined {
    return this.selected;
  }

  private prefillForm(ds: DatasetRow): void {
    if (!this.hooks.createSession) return;
    this.form.hidden = false;
    const f = (n: string) => this.form.elements.namedItem(n) as HTMLInputElement;
    f('name').value = this.defaultName(ds);
    f('tickSize').value = String(ds.tickSize);
    f('utcOffset').value = String(ds.utcOffsetMinutes);
    if (ds.firstTime !== null && ds.lastTime !== null) {
      // Default: start one fifth into the data so there is history on screen.
      const start = ds.firstTime + Math.floor((ds.lastTime - ds.firstTime) / 5);
      const local = new Date((start + ds.utcOffsetMinutes * 60) * 1000).toISOString().slice(0, 16);
      f('start').value = local;
    }
  }

  applyTheme(): void {
    this.chart?.applyTheme();
  }

  rerender(): void {
    this.renderList();
    void this.hooks.renderSessions?.();
  }
}
