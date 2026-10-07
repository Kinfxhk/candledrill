// SPDX-License-Identifier: AGPL-3.0-or-later
// Thin client for the local CandleDrill server. Same-origin only; no third-party requests.

import type { Bar, CsvImportOptions, CsvImportReport } from '@candledrill/core';

export interface DatasetRow {
  id: number;
  name: string;
  symbol: string;
  source: 'synthetic' | 'user-import';
  synthetic: boolean;
  timeframeSeconds: number;
  tickSize: number;
  barCount: number;
  firstTime: number | null;
  lastTime: number | null;
  utcOffsetMinutes: number;
  createdAt: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
  }
}

export async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const json: unknown = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const msg = (json as { error?: string; message?: string } | undefined)?.error ?? res.statusText;
    throw new ApiError(msg, res.status, json);
  }
  return json as T;
}

export const api = {
  health: () =>
    request<{ status: string; version: string; telemetry: boolean }>('GET', '/api/health'),
  datasets: () => request<{ datasets: DatasetRow[] }>('GET', '/api/datasets'),
  createSynthetic: (seed: number, startDate: string, days: number) =>
    request<{ dataset: DatasetRow }>('POST', '/api/datasets/synthetic', { seed, startDate, days }),
  importCsv: (body: {
    name: string;
    symbol: string;
    tickSize: number;
    csv: string;
    options: Omit<CsvImportOptions, 'tickSize' | 'maxBars'>;
  }) =>
    request<{ dataset: DatasetRow; report: CsvImportReport }>('POST', '/api/datasets/import', body),
  deleteDataset: (id: number) => request<void>('DELETE', `/api/datasets/${id}`),
  previewBars: (id: number, limit = 5000) =>
    request<{ bars: Bar[] }>('GET', `/api/datasets/${id}/bars?limit=${limit}&last=true`),
};
