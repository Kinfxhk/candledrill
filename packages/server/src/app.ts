// SPDX-License-Identifier: AGPL-3.0-or-later
import Fastify, { type FastifyInstance } from 'fastify';
import { generateSyntheticBars, CANDLEDRILL_RISK_NOTICE_EN } from '@candledrill/core';
import { getBars, getDataset, insertDataset, listDatasets, type Db } from './db.js';

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
}

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
  });

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

  app.get<{
    Params: { id: number };
    Querystring: { from?: number; to?: number; limit?: number };
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
          },
        },
      },
    },
    async (req, reply) => {
      const ds = getDataset(db, req.params.id);
      if (!ds) return reply.code(404).send({ error: 'dataset not found' });
      const { from, to, limit } = req.query;
      const bars = getBars(db, ds.id, {
        ...(from !== undefined ? { from } : {}),
        ...(to !== undefined ? { to } : {}),
        limit: limit ?? 5_000,
      });
      return { datasetId: ds.id, synthetic: ds.synthetic, bars };
    },
  );

  return app;
}
