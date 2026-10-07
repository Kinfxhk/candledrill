// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Practice-session routes. The server is the only place that holds the full bar series;
// the browser only ever receives bars up to the session cursor (strict no-future-leak).

import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  createSession,
  jumpSession,
  stepSession,
  validateSettings,
  visibleBars,
  type Bar,
  type SessionSettings,
  type SessionState,
} from '@candledrill/core';
import {
  deleteSession,
  getAllBars,
  getDataset,
  getSession,
  insertSession,
  listSessions,
  updateSessionState,
  type Db,
  type SessionRow,
} from './db.js';

/** Max visible bars sent when a session is opened (older history is trimmed). */
export const MAX_HISTORY_BARS = 50_000;

type Row = SessionRow<SessionSettings, SessionState>;

/** Small per-process cache of full bar series, keyed by dataset id. */
export class BarCache {
  private readonly map = new Map<number, Bar[]>();
  constructor(
    private readonly db: Db,
    private readonly capacity = 4,
  ) {}
  get(datasetId: number): Bar[] {
    let bars = this.map.get(datasetId);
    if (bars) {
      this.map.delete(datasetId);
      this.map.set(datasetId, bars);
      return bars;
    }
    bars = getAllBars(this.db, datasetId);
    this.map.set(datasetId, bars);
    while (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value!);
    return bars;
  }
  invalidate(datasetId: number): void {
    this.map.delete(datasetId);
  }
}

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
} as const;

const nullablePositive = { type: ['number', 'null'], exclusiveMinimum: 0 } as const;

export const settingsSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'tickSize',
    'pointValue',
    'commissionPerContract',
    'slippageTicks',
    'startingBalance',
    'dailyLossLimit',
    'trailingDrawdown',
    'profitTarget',
    'utcOffsetMinutes',
    'dayStartMinutes',
  ],
  properties: {
    tickSize: { type: 'number', exclusiveMinimum: 0 },
    pointValue: { type: 'number', exclusiveMinimum: 0 },
    commissionPerContract: { type: 'number', minimum: 0 },
    slippageTicks: { type: 'integer', minimum: 0, maximum: 1000 },
    startingBalance: { type: 'number', exclusiveMinimum: 0 },
    dailyLossLimit: nullablePositive,
    trailingDrawdown: nullablePositive,
    profitTarget: nullablePositive,
    utcOffsetMinutes: { type: 'integer', minimum: -840, maximum: 840 },
    dayStartMinutes: { type: 'integer', minimum: 0, maximum: 1439 },
  },
} as const;

export interface SessionRouteDeps {
  readonly db: Db;
  readonly cache: BarCache;
  readonly now: () => Date;
}

export interface SessionView {
  session: Omit<Row, 'state'>;
  state: SessionState;
  cursorTime: number;
}

export function sessionView(
  row: Row,
  bars: readonly Bar[],
  state: SessionState = row.state,
): SessionView {
  const { state: _omit, ...session } = row;
  void _omit;
  return { session, state, cursorTime: bars[state.cursor]!.time };
}

export function registerSessionRoutes(app: FastifyInstance, deps: SessionRouteDeps): void {
  const { db, cache, now } = deps;

  const load = (id: number, reply: FastifyReply): { row: Row; bars: Bar[] } | undefined => {
    const row = getSession<SessionSettings, SessionState>(db, id);
    if (!row) {
      void reply.code(404).send({ error: 'session not found' });
      return undefined;
    }
    return { row, bars: cache.get(row.datasetId) };
  };

  const save = (row: Row, state: SessionState) =>
    updateSessionState(db, row.id, state, now().toISOString());

  app.get('/api/sessions', async () => ({
    sessions: listSessions<SessionSettings, SessionState>(db).map((r) => ({
      id: r.id,
      datasetId: r.datasetId,
      name: r.name,
      status: r.state.status,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
  }));

  app.post<{
    Body: {
      datasetId: number;
      name: string;
      startTime: number;
      settings: Omit<SessionSettings, 'symbol'>;
    };
  }>(
    '/api/sessions',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['datasetId', 'name', 'startTime', 'settings'],
          properties: {
            datasetId: { type: 'integer', minimum: 1 },
            name: { type: 'string', minLength: 1, maxLength: 80 },
            startTime: { type: 'integer' },
            settings: settingsSchema,
          },
        },
      },
    },
    async (req, reply) => {
      const ds = getDataset(db, req.body.datasetId);
      if (!ds) return reply.code(404).send({ error: 'dataset not found' });
      const settings: SessionSettings = { ...req.body.settings, symbol: ds.symbol };
      const errors = validateSettings(settings);
      if (errors.length) return reply.code(400).send({ error: errors.join('; ') });
      const bars = cache.get(ds.id);
      let state: SessionState;
      try {
        state = createSession(bars, settings, req.body.startTime);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
      const row = insertSession(db, {
        datasetId: ds.id,
        name: req.body.name,
        startTime: req.body.startTime,
        settings,
        state,
        now: now().toISOString(),
      });
      return reply.code(201).send(sessionView(row, bars));
    },
  );

  app.get<{ Params: { id: number }; Querystring: { history?: number } }>(
    '/api/sessions/:id',
    {
      schema: {
        params: idParams,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { history: { type: 'integer', minimum: 1, maximum: MAX_HISTORY_BARS } },
        },
      },
    },
    async (req, reply) => {
      const loaded = load(req.params.id, reply);
      if (!loaded) return reply;
      const { row, bars } = loaded;
      const visible = visibleBars(bars, row.state.cursor);
      const history = req.query.history ?? MAX_HISTORY_BARS;
      return { ...sessionView(row, bars), bars: visible.slice(-history) };
    },
  );

  app.post<{ Params: { id: number }; Body: { count?: number } }>(
    '/api/sessions/:id/step',
    {
      schema: {
        params: idParams,
        body: {
          type: ['object', 'null'],
          additionalProperties: false,
          properties: { count: { type: 'integer', minimum: 1, maximum: 5000 } },
        },
      },
    },
    async (req, reply) => {
      const loaded = load(req.params.id, reply);
      if (!loaded) return reply;
      const { row, bars } = loaded;
      const r = stepSession(bars, row.settings, row.state, req.body?.count ?? 1);
      save(row, r.state);
      return { ...sessionView(row, bars, r.state), revealed: r.revealed };
    },
  );

  app.post<{ Params: { id: number }; Body: { time: number } }>(
    '/api/sessions/:id/jump',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['time'],
          properties: { time: { type: 'integer' } },
        },
      },
    },
    async (req, reply) => {
      const loaded = load(req.params.id, reply);
      if (!loaded) return reply;
      const { row, bars } = loaded;
      const r = jumpSession(bars, row.settings, row.state, req.body.time);
      save(row, r.state);
      // Large jumps: only send the tail the chart needs; the client reloads history if needed.
      const revealed =
        r.revealed.length > MAX_HISTORY_BARS ? r.revealed.slice(-MAX_HISTORY_BARS) : r.revealed;
      return {
        ...sessionView(row, bars, r.state),
        revealed,
        truncated: revealed.length < r.revealed.length,
      };
    },
  );

  app.delete<{ Params: { id: number } }>(
    '/api/sessions/:id',
    { schema: { params: idParams } },
    async (req, reply) => {
      if (!deleteSession(db, req.params.id))
        return reply.code(404).send({ error: 'session not found' });
      return reply.code(204).send();
    },
  );
}
