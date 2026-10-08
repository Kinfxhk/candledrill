// SPDX-License-Identifier: AGPL-3.0-or-later
// Thin client for the local CandleDrill server. Same-origin only; no third-party requests.

import type {
  Bar,
  CsvImportOptions,
  CsvImportReport,
  OrderChange,
  OrderRequest,
  SessionState,
} from '@candledrill/core';

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

export interface SessionSettings {
  symbol: string;
  tickSize: number;
  pointValue: number;
  commissionPerContract: number;
  slippageTicks: number;
  startingBalance: number;
  dailyLossLimit: number | null;
  trailingDrawdown: number | null;
  profitTarget: number | null;
  utcOffsetMinutes: number;
  dayStartMinutes: number;
}

export interface SessionMeta {
  id: number;
  datasetId: number;
  name: string;
  startTime: number;
  settings: SessionSettings;
  drawings: unknown[];
  createdAt: string;
  updatedAt: string;
}

export interface SessionSummary {
  id: number;
  datasetId: number;
  name: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

/** Engine state as sent by the server. */
export type SessionStateDto = SessionState;

export interface SessionViewDto {
  session: SessionMeta;
  state: SessionStateDto;
  cursorTime: number;
}

export const sessionsApi = {
  list: () => request<{ sessions: SessionSummary[] }>('GET', '/api/sessions'),
  create: (body: {
    datasetId: number;
    name: string;
    startTime: number;
    settings: Omit<SessionSettings, 'symbol'>;
  }) => request<SessionViewDto>('POST', '/api/sessions', body),
  open: (id: number) => request<SessionViewDto & { bars: Bar[] }>('GET', `/api/sessions/${id}`),
  step: (id: number, count: number) =>
    request<SessionViewDto & { revealed: Bar[] }>('POST', `/api/sessions/${id}/step`, { count }),
  jump: (id: number, time: number) =>
    request<SessionViewDto & { revealed: Bar[]; truncated: boolean }>(
      'POST',
      `/api/sessions/${id}/jump`,
      { time },
    ),
  remove: (id: number) => request<void>('DELETE', `/api/sessions/${id}`),
  placeOrder: (id: number, req: OrderRequest) =>
    request<SessionViewDto>('POST', `/api/sessions/${id}/orders`, req),
  cancelOrder: (id: number, orderId: number) =>
    request<SessionViewDto>('DELETE', `/api/sessions/${id}/orders/${orderId}`),
  modifyOrder: (id: number, orderId: number, change: OrderChange) =>
    request<SessionViewDto>('PATCH', `/api/sessions/${id}/orders/${orderId}`, change),
  flatten: (id: number) => request<SessionViewDto>('POST', `/api/sessions/${id}/flatten`, {}),
  saveDrawings: (id: number, drawings: unknown[]) =>
    request<{ drawings: unknown[] }>('PUT', `/api/sessions/${id}/drawings`, { drawings }),
};
