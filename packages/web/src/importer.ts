// SPDX-License-Identifier: AGPL-3.0-or-later
// CSV import dialog: local preview + column mapping; the server re-parses and validates.

import { guessMapping, parseCsv, type CsvMapping, type CsvImportReport } from '@candledrill/core';
import { api, ApiError, type DatasetRow } from './api.js';
import { t, type MessageKey } from './i18n.js';
import { el, fmtTime, toast } from './format.js';

const FIELDS: { key: keyof CsvMapping; label: MessageKey; optional: boolean }[] = [
  { key: 'time', label: 'imp.time', optional: false },
  { key: 'timeOfDay', label: 'imp.timeOfDay', optional: true },
  { key: 'open', label: 'imp.open', optional: false },
  { key: 'high', label: 'imp.high', optional: false },
  { key: 'low', label: 'imp.low', optional: false },
  { key: 'close', label: 'imp.close', optional: false },
  { key: 'volume', label: 'imp.volume', optional: true },
];

export function setupImporter(onImported: (ds: DatasetRow) => void): () => void {
  const dialog = document.getElementById('import-dialog') as HTMLDialogElement;
  const form = document.getElementById('import-form') as HTMLFormElement;
  const preview = document.getElementById('import-preview')!;
  const mappingBox = document.getElementById('import-mapping')!;
  const result = document.getElementById('import-result')!;
  const submit = document.getElementById('import-submit') as HTMLButtonElement;
  const fileInput = form.elements.namedItem('file') as HTMLInputElement;
  let text = '';
  let header: string[] = [];

  const field = (name: string) =>
    form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement;

  function renderMapping(guess: CsvMapping | undefined): void {
    mappingBox.replaceChildren();
    for (const f of FIELDS) {
      const select = el('select', { name: `map-${f.key}`, 'data-testid': `map-${f.key}` });
      if (f.optional) select.append(el('option', { value: '' }, t('imp.none')));
      header.forEach((h, i) => select.append(el('option', { value: String(i) }, `${i + 1}: ${h}`)));
      const g = guess?.[f.key];
      if (g !== undefined) select.value = String(g);
      else if (!f.optional) select.value = String(Math.min(FIELDS.indexOf(f), header.length - 1));
      mappingBox.append(el('label', { class: 'field' }, el('span', {}, t(f.label)), select));
    }
  }

  function refreshPreview(): void {
    if (!text) return;
    const delim = field('delimiter').value || undefined;
    const sample = text.slice(0, 64 * 1024);
    const rows = parseCsv(sample, delim).slice(0, 9);
    const hasHeader = (field('hasHeader') as HTMLInputElement).checked;
    const first = rows[0] ?? [];
    header = hasHeader ? first : first.map((_, i) => `col${i + 1}`);
    const table = el('table', { class: 'data' });
    const thead = el('tr');
    header.forEach((h) => thead.append(el('th', {}, h)));
    table.append(thead);
    rows.slice(hasHeader ? 1 : 0).forEach((r) => {
      const tr = el('tr');
      r.forEach((c) => tr.append(el('td', {}, c)));
      table.append(tr);
    });
    preview.replaceChildren(table);
    preview.hidden = false;
    renderMapping(hasHeader ? guessMapping(header) : undefined);
  }

  function renderReport(report: CsvImportReport, ok: boolean): void {
    const lines: (string | Node)[] = [];
    const summary =
      `${ok ? t('imp.ok', { n: report.imported }) : t('imp.failed')} ` +
      `rows=${report.rows} skipped=${report.skipped} duplicates=${report.duplicatesDropped} ` +
      `tf=${report.timeframeSeconds}s gaps=${report.gaps} ` +
      `${fmtTime(report.firstTime)} → ${fmtTime(report.lastTime)}`;
    lines.push(el('p', { class: ok ? 'up' : 'down' }, summary));
    const issues = [
      ...report.rowIssues.map((i) => `line ${i.line}: ${i.message}`),
      ...report.barIssues.map((i) => `bar #${i.index + 1}: ${i.code} – ${i.message}`),
    ];
    if (issues.length)
      lines.push(el('div', { class: 'issues' }, ...issues.map((s) => el('div', {}, s))));
    result.replaceChildren(...lines);
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    text = await file.text();
    const base = file.name.replace(/\.[^.]+$/, '');
    const nameEl = field('name') as HTMLInputElement;
    const symEl = field('symbol') as HTMLInputElement;
    if (!nameEl.value) nameEl.value = base.slice(0, 80);
    if (!symEl.value) symEl.value = base.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 32) || 'DATA';
    result.replaceChildren();
    refreshPreview();
  });
  field('delimiter').addEventListener('change', refreshPreview);
  field('hasHeader').addEventListener('change', refreshPreview);
  document.getElementById('import-cancel')!.addEventListener('click', () => dialog.close());

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!text) return;
    const mapping: Record<string, number> = {};
    for (const f of FIELDS) {
      const v = (form.elements.namedItem(`map-${f.key}`) as HTMLSelectElement).value;
      if (v !== '') mapping[f.key] = Number(v);
    }
    const tf = (field('timeframe') as HTMLInputElement).value;
    const delim = field('delimiter').value;
    submit.disabled = true;
    try {
      const res = await api.importCsv({
        name: (field('name') as HTMLInputElement).value.trim(),
        symbol: (field('symbol') as HTMLInputElement).value.trim(),
        tickSize: Number((field('tickSize') as HTMLInputElement).value),
        csv: text,
        options: {
          mapping: mapping as unknown as CsvMapping,
          hasHeader: (field('hasHeader') as HTMLInputElement).checked,
          ...(delim ? { delimiter: delim } : {}),
          timeFormat: field('timeFormat').value as 'auto',
          dateOrder: field('dateOrder').value as 'ymd',
          utcOffsetMinutes: Number((field('utcOffset') as HTMLInputElement).value || 0),
          ...(tf ? { timeframeSeconds: Number(tf) } : {}),
          skipInvalidRows: (field('skipInvalid') as HTMLInputElement).checked,
        },
      });
      renderReport(res.report, true);
      toast(t('imp.ok', { n: res.report.imported }));
      onImported(res.dataset);
      setTimeout(() => dialog.close(), 600);
    } catch (err) {
      if (err instanceof ApiError && (err.body as { report?: CsvImportReport })?.report) {
        renderReport((err.body as { report: CsvImportReport }).report, false);
      } else {
        result.replaceChildren(el('p', { class: 'down' }, (err as Error).message));
      }
    } finally {
      submit.disabled = false;
    }
  });

  return () => {
    form.reset();
    text = '';
    preview.hidden = true;
    mappingBox.replaceChildren();
    result.replaceChildren();
    dialog.showModal();
  };
}
