// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import {
  generateSyntheticBars,
  importCsv,
  CANDLEDRILL_RISK_NOTICE_EN,
  SYNTHETIC_SYMBOL_PREFIX,
  type CsvImportOptions,
} from '@candledrill/core';
import { deleteDataset, getBars, getDataset, insertDataset, listDatasets, type Db } from './db.js';

export const APP_NAME = 'CandleDrill';
export const APP_VERSION = '0.0.0';
export const MAX_BARS_PER_REQUEST = 50_000;
/** Synthetic datasets created through the API are capped to keep the local DB small. */
export const MAX_SYNTHETIC_DAYS = 366;

export interface AppOptions {
  readonly db: Db;
  /** Injected clock for testability. */
  readonly now?: () => Date;
  readonly logger?: boolean;
  /** Directory with the built web UI. Served at "/" when it exists. */
  readonly staticDir?: string;
}

/** Maximum CSV upload size (bytes). About 1M one-minute bars. */
export const MAX_IMPORT_BYTES = 96 * 1024 * 1024;

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

const ALLOWED_HOSTNAMES = new Set(['127.0.0.1', 'localhost']);

function hostnameOf(hostHeader: string | undefined): string | undefined {
  if (!hostHeader) return undefined;
  const m = /^([^:]+)(?::\d+)?$/.exec(hostHeader.trim().toLowerCase());
  return m?.[1];
}

export function buildApp(opts: AppOptions): FastifyInstance {
  const { db } = opts;
  const now = opts.now ?? (() => new Date());
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 64 * 1024 });

  // Defence against DNS-rebinding: only answer requests addressed to the loopback host.
  app.addHook('onRequest', async (req, reply) => {
    const host = hostnameOf(req.headers.host);
    if (!host || !ALLOWED_HOSTNAMES.has(host)) {
      return reply.code(421).send({ error: 'misdirected request: CandleDrill is local-only' });
    }
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', CSP);
    reply.header('X-Frame-Options', 'DENY');
  });

  if (opts.staticDir && existsSync(opts.staticDir)) {
    void app.register(fastifyStatic, { root: opts.staticDir, index: ['index.html'] });
  }

  app.get('/api/health', async () => ({
    status: 'ok',
    name: APP_NAME,
    version: APP_VERSION,
    telemetry: false,
    notice: CANDLEDRILL_RISK_NOTICE_EN,
  }));

  app.get('/api/datasets', async () => ({ datasets: listDatasets(db) }));

  app.post<{
    Body: { seed: number; startDate: string; days: number; name?: string };
  }>(
    '/api/datasets/synthetic',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['seed', 'startDate', 'days'],
          properties: {
            seed: { type: 'integer', minimum: 0, maximum: 4294967295 },
            startDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            days: { type: 'integer', minimum: 1, maximum: MAX_SYNTHETIC_DAYS },
            name: { type: 'string', pattern: '^[A-Z0-9_-]{1,24}$' },
          },
        },
      },
    },
    async (req, reply) => {
      const { seed, startDate, days, name } = req.body;
      let dataset;
      try {
        dataset = generateSyntheticBars({ seed, startDate, days, ...(name ? { name } : {}) });
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
      const label = `${dataset.meta.symbol} seed=${seed} ${startDate} +${days}d`;
      const row = insertDataset(db, label, dataset.meta, dataset.bars, now().toISOString());
      return reply.code(201).send({ dataset: row });
    },
  );

  app.post<{
    Body: {
      name: string;
      symbol: string;
      tickSize: number;
      csv: string;
      options: Omit<CsvImportOptions, 'tickSize' | 'maxBars'>;
    };
  }>(
    '/api/datasets/import',
    {
      bodyLimit: MAX_IMPORT_BYTES,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'symbol', 'tickSize', 'csv', 'options'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 80 },
            symbol: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,32}$' },
            tickSize: { type: 'number', exclusiveMinimum: 0, maximum: 1_000_000 },
            csv: { type: 'string', minLength: 1 },
            options: {
              type: 'object',
              additionalProperties: false,
              required: ['mapping'],
              properties: {
                mapping: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['time', 'open', 'high', 'low', 'close'],
                  properties: {
                    time: { type: 'integer', minimum: 0, maximum: 200 },
                    timeOfDay: { type: 'integer', minimum: 0, maximum: 200 },
                    open: { type: 'integer', minimum: 0, maximum: 200 },
                    high: { type: 'integer', minimum: 0, maximum: 200 },
                    low: { type: 'integer', minimum: 0, maximum: 200 },
                    close: { type: 'integer', minimum: 0, maximum: 200 },
                    volume: { type: 'integer', minimum: 0, maximum: 200 },
                  },
                },
                hasHeader: { type: 'boolean' },
                delimiter: { type: 'string', enum: [',', ';', '\t', '|'] },
                timeFormat: { type: 'string', enum: ['auto', 'unix-s', 'unix-ms', 'datetime'] },
                dateOrder: { type: 'string', enum: ['ymd', 'dmy', 'mdy'] },
                utcOffsetMinutes: { type: 'integer', minimum: -840, maximum: 840 },
                timeframeSeconds: { type: 'integer', minimum: 1, maximum: 604800 },
                skipInvalidRows: { type: 'boolean' },
              },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const { name, symbol, tickSize, csv, options } = req.body;
      if (symbol.toUpperCase().startsWith(SYNTHETIC_SYMBOL_PREFIX)) {
        return reply
          .code(400)
          .send({ error: `symbols starting with ${SYNTHETIC_SYMBOL_PREFIX} are reserved` });
      }
      const result = importCsv(csv, { ...options, tickSize });
      if (!result.ok)
        return reply.code(422).send({ error: 'import failed', report: result.report });
      const row = insertDataset(
        db,
        name,
        {
          source: 'user-import',
          synthetic: false,
          symbol,
          timeframeSeconds: result.report.timeframeSeconds,
          tickSize,
        },
        result.bars,
        now().toISOString(),
        options.utcOffsetMinutes ?? 0,
      );
      return reply.code(201).send({ dataset: row, report: result.report });
    },
  );

  app.delete<{ Params: { id: number } }>(
    '/api/datasets/:id',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'integer', minimum: 1 } },
        },
      },
    },
    async (req, reply) => {
      if (!deleteDataset(db, req.params.id)) return reply.code(404).send({ error: 'not found' });
      return reply.code(204).send();
    },
  );

  app.get<{
    Params: { id: number };
    Querystring: { from?: number; to?: number; limit?: number; last?: boolean };
  }>(
    '/api/datasets/:id/bars',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'integer', minimum: 1 } },
        },
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            from: { type: 'integer' },
            to: { type: 'integer' },
            limit: { type: 'integer', minimum: 1, maximum: MAX_BARS_PER_REQUEST },
            last: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      const ds = getDataset(db, req.params.id);
      if (!ds) return reply.code(404).send({ error: 'dataset not found' });
      const { from, to, limit, last } = req.query;
      const bars = getBars(db, ds.id, {
        ...(from !== undefined ? { from } : {}),
        ...(to !== undefined ? { to } : {}),
        limit: limit ?? 5_000,
        ...(last ? { last: true } : {}),
      });
      return { datasetId: ds.id, synthetic: ds.synthetic, bars };
    },
  );

  return app;
}
