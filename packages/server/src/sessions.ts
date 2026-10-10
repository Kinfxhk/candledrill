// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Practice-session routes. The server is the only place that holds the full bar series;
// these session routes only ever send bars up to the session cursor (no look-ahead on the
// practice data path). Note: the dataset library routes in app.ts can return any bars of a
// dataset (used for the import preview), so this is not a whole-app guarantee.

import { createHash, randomInt } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  BLIND_SYMBOL,
  groupTrades,
  journalEntryIssues,
  journalIssues,
  normalizeTags,
  tradeExcursions,
  MAX_NOTE_LENGTH,
  MAX_TAGS,
  MAX_TAG_LENGTH,
  blindIssues,
  checkSessionState,
  disguiseBars,
  parseSessionFile,
  pickBlindParams,
  pickBlindStartIndex,
  MAX_SESSION_FILE_BYTES,
  createSession,
  jumpSession,
  OrderError,
  sessionCancelOrder,
  sessionFlatten,
  sessionModifyOrder,
  sessionPlaceOrder,
  sessionStats,
  upgradeState,
  tradesToCsv,
  reportHtml,
  FILL_MODEL_NOTE,
  SIMULATION_POLICY,
  CANDLEDRILL_RISK_NOTICE_EN,
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
  listDatasets,
  listSessions,
  updateSessionDrawings,
  updateSessionJournal,
  updateSessionSettings,
  updateSessionState,
  type Db,
  type SessionRow,
} from './db.js';

/** Max visible bars sent when a session is opened (older history is trimmed). */
export const MAX_HISTORY_BARS = 50_000;
export const MAX_DRAWINGS = 200;

/** Blind-mode parameters, stored with the session settings (server-side only). */
export interface BlindInfo {
  readonly timeShift: number;
  readonly priceOffset: number;
  readonly revealed: boolean;
  /** The real symbol; the engine settings carry BLIND_SYMBOL instead. */
  readonly symbol: string;
}
export type StoredSettings = SessionSettings & { readonly blind?: BlindInfo };
type Row = SessionRow<StoredSettings, SessionState>;

/** Uniform [0, 1) from the OS crypto source (blind parameters must not be guessable). */
const cryptoRandom = (): number => randomInt(0, 2 ** 47) / 2 ** 47;

/** SHA-256 over every bar of a dataset; identifies the data a session file belongs to. */
export function barsFingerprint(bars: readonly Bar[]): string {
  const h = createHash('sha256');
  for (const b of bars) h.update(`${b.time},${b.open},${b.high},${b.low},${b.close},${b.volume}\n`);
  return h.digest('hex');
}

/** True while a blind session is running: its period and prices must stay hidden. */
export function isBlindHidden(settings: StoredSettings, state: SessionState): boolean {
  return settings.blind !== undefined && !settings.blind.revealed && state.status !== 'finished';
}

/** Datasets that have a running, unrevealed blind session (their bars must not be served). */
export function blindLockedDatasets(db: Db): Set<number> {
  const out = new Set<number>();
  for (const r of listSessions<StoredSettings, SessionState>(db))
    if (isBlindHidden(r.settings, r.state)) out.add(r.datasetId);
  return out;
}

/** Engine settings without the blind block (for reports and exports). */
function engineSettings(s: StoredSettings): SessionSettings {
  const { blind: _b, ...rest } = s;
  void _b;
  return rest;
}

/** Checks JSON Schema cannot express: unique ids, R tool sides, a positive time span. */
export function drawingProblem(drawings: unknown[]): string | null {
  const ids = new Set<string>();
  for (const raw of drawings) {
    const d = raw as Record<string, unknown> & { id: string; kind: string };
    if (ids.has(d.id)) return `duplicate drawing id ${d.id}`;
    ids.add(d.id);
    if (d.kind === 'position') {
      const dir = d.side === 'long' ? 1 : -1;
      const entry = d.entry as number;
      if (dir * (entry - (d.stop as number)) <= 0 || dir * ((d.target as number) - entry) <= 0)
        return 'R tool: the stop must be on the losing side and the target on the winning side';
      if ((d.t2 as number) <= (d.t1 as number)) return 'R tool: the end must be after the start';
    }
  }
  return null;
}

/** Small per-process cache of full bar series, keyed by dataset id. */
export class BarCache {
  private readonly map = new Map<number, Bar[]>();
  private readonly blindMap = new Map<string, Bar[]>();
  private readonly prints = new Map<number, string>();
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
  /** The disguised copy of a dataset used by a blind session. */
  disguised(datasetId: number, blind: BlindInfo, tickSize: number): Bar[] {
    const key = `${datasetId}:${blind.timeShift}:${blind.priceOffset}:${tickSize}`;
    let bars = this.blindMap.get(key);
    if (!bars) {
      bars = disguiseBars(this.get(datasetId), blind, tickSize);
      this.blindMap.set(key, bars);
      while (this.blindMap.size > this.capacity)
        this.blindMap.delete(this.blindMap.keys().next().value!);
    }
    return bars;
  }
  fingerprint(datasetId: number): string {
    let f = this.prints.get(datasetId);
    if (!f) {
      f = barsFingerprint(this.get(datasetId));
      this.prints.set(datasetId, f);
    }
    return f;
  }
  invalidate(datasetId: number): void {
    this.map.delete(datasetId);
    this.prints.delete(datasetId);
    for (const k of [...this.blindMap.keys()])
      if (k.startsWith(`${datasetId}:`)) this.blindMap.delete(k);
  }
  clear(): void {
    this.map.clear();
    this.blindMap.clear();
    this.prints.clear();
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
    maxDailyTradeCycles: { type: ['integer', 'null'], minimum: 1 },
    maxConsecutiveLosses: { type: ['integer', 'null'], minimum: 1 },
    utcOffsetMinutes: { type: 'integer', minimum: -840, maximum: 840 },
    dayStartMinutes: { type: 'integer', minimum: 0, maximum: 1439 },
  },
} as const;

export interface SessionRouteDeps {
  readonly db: Db;
  readonly cache: BarCache;
  readonly now: () => Date;
}

export interface PublicBlind {
  readonly revealed: boolean;
  readonly symbol?: string;
  readonly timeShift?: number;
  readonly priceOffset?: number;
}
export interface SessionView {
  session: Omit<Row, 'state' | 'settings'> & {
    settings: SessionSettings & { blind?: PublicBlind };
  };
  state: SessionState;
  cursorTime: number;
}

export function sessionView(
  row: Row,
  bars: readonly Bar[],
  state: SessionState = row.state,
): SessionView {
  const { state: _omit, settings, ...rest } = row;
  void _omit;
  const base = engineSettings(settings);
  const blind: PublicBlind | undefined = settings.blind
    ? isBlindHidden(settings, state)
      ? { revealed: false }
      : {
          revealed: true,
          symbol: settings.blind.symbol,
          timeShift: settings.blind.timeShift,
          priceOffset: settings.blind.priceOffset,
        }
    : undefined;
  return {
    session: { ...rest, settings: blind ? { ...base, blind } : base },
    state,
    cursorTime: bars[state.cursor]!.time,
  };
}

export function registerSessionRoutes(app: FastifyInstance, deps: SessionRouteDeps): void {
  const { db, cache, now } = deps;

  const load = (id: number, reply: FastifyReply): { row: Row; bars: Bar[] } | undefined => {
    const row = getSession<StoredSettings, SessionState>(db, id);
    if (!row) {
      void reply.code(404).send({ error: 'session not found' });
      return undefined;
    }
    const bars = row.settings.blind
      ? cache.disguised(row.datasetId, row.settings.blind, row.settings.tickSize)
      : cache.get(row.datasetId);
    return { row: { ...row, state: upgradeState(bars, row.settings, row.state) }, bars };
  };

  const save = (row: Row, state: SessionState) =>
    updateSessionState(db, row.id, state, now().toISOString());

  app.get('/api/sessions', async () => ({
    sessions: listSessions<StoredSettings, SessionState>(db).map((r) => ({
      id: r.id,
      datasetId: r.datasetId,
      name: r.name,
      status: r.state.status,
      blind: r.settings.blind ? (isBlindHidden(r.settings, r.state) ? 'hidden' : 'revealed') : null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
  }));

  app.post<{
    Body: {
      datasetId: number;
      name: string;
      startTime?: number;
      blind?: boolean;
      settings: Omit<SessionSettings, 'symbol'>;
    };
  }>(
    '/api/sessions',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['datasetId', 'name', 'settings'],
          properties: {
            datasetId: { type: 'integer', minimum: 1 },
            name: { type: 'string', minLength: 1, maxLength: 80 },
            startTime: { type: 'integer' },
            blind: { type: 'boolean' },
            settings: settingsSchema,
          },
        },
      },
    },
    async (req, reply) => {
      const ds = getDataset(db, req.body.datasetId);
      if (!ds) return reply.code(404).send({ error: 'dataset not found' });
      const plain: SessionSettings = { ...req.body.settings, symbol: ds.symbol };
      const errors = validateSettings(plain);
      if (errors.length) return reply.code(400).send({ error: errors.join('; ') });
      const real = cache.get(ds.id);
      let settings: StoredSettings = plain;
      let bars: Bar[] = real;
      let startTime = req.body.startTime;
      if (req.body.blind) {
        if (real.length < 3)
          return reply.code(400).send({ error: 'dataset too short for blind mode' });
        const p = pickBlindParams(real, plain.tickSize, cryptoRandom);
        const blind: BlindInfo = { ...p, revealed: false, symbol: ds.symbol };
        settings = { ...plain, symbol: BLIND_SYMBOL, blind };
        bars = cache.disguised(ds.id, blind, plain.tickSize);
        // Random start, chosen here so the user never sees where in the data it is.
        startTime = bars[pickBlindStartIndex(bars.length, cryptoRandom)]!.time;
      }
      if (startTime === undefined)
        return reply.code(400).send({ error: 'startTime is required (or use blind mode)' });
      let state: SessionState;
      try {
        state = createSession(bars, settings, startTime);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
      const row = insertSession(db, {
        datasetId: ds.id,
        name: req.body.name,
        startTime,
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

  const mutate = async (
    id: number,
    reply: FastifyReply,
    fn: (row: Row, bars: Bar[]) => SessionState,
  ): Promise<unknown> => {
    const loaded = load(id, reply);
    if (!loaded) return reply;
    const { row, bars } = loaded;
    let state: SessionState;
    try {
      state = fn(row, bars);
    } catch (err) {
      if (err instanceof OrderError) return reply.code(400).send({ error: err.message });
      throw err;
    }
    save(row, state);
    return sessionView(row, bars, state);
  };

  const priceOrNull = { type: ['number', 'null'], exclusiveMinimum: 0 } as const;

  app.post<{
    Params: { id: number };
    Body: {
      side: 'buy' | 'sell';
      type: 'market' | 'limit' | 'stop';
      qty: number;
      price?: number | null;
      stopLoss?: number | null;
      takeProfit?: number | null;
    };
  }>(
    '/api/sessions/:id/orders',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['side', 'type', 'qty'],
          properties: {
            side: { type: 'string', enum: ['buy', 'sell'] },
            type: { type: 'string', enum: ['market', 'limit', 'stop'] },
            qty: { type: 'integer', minimum: 1, maximum: 10000 },
            price: priceOrNull,
            stopLoss: priceOrNull,
            takeProfit: priceOrNull,
          },
        },
      },
    },
    async (req, reply) =>
      mutate(req.params.id, reply, (row, bars) =>
        sessionPlaceOrder(bars, row.settings, row.state, req.body),
      ),
  );

  const orderParams = {
    type: 'object',
    required: ['id', 'orderId'],
    properties: { id: { type: 'integer', minimum: 1 }, orderId: { type: 'integer', minimum: 1 } },
  } as const;

  app.delete<{ Params: { id: number; orderId: number } }>(
    '/api/sessions/:id/orders/:orderId',
    { schema: { params: orderParams } },
    async (req, reply) =>
      mutate(req.params.id, reply, (row) => sessionCancelOrder(row.state, req.params.orderId)),
  );

  app.patch<{
    Params: { id: number; orderId: number };
    Body: {
      price?: number;
      stopLoss?: number | null;
      takeProfit?: number | null;
      shiftBracket?: boolean;
    };
  }>(
    '/api/sessions/:id/orders/:orderId',
    {
      schema: {
        params: orderParams,
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            price: { type: 'number', exclusiveMinimum: 0 },
            stopLoss: priceOrNull,
            takeProfit: priceOrNull,
            shiftBracket: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) =>
      mutate(req.params.id, reply, (row, bars) =>
        sessionModifyOrder(
          row.settings,
          row.state,
          req.params.orderId,
          req.body,
          bars[row.state.cursor]!.time,
        ),
      ),
  );

  app.post<{ Params: { id: number } }>(
    '/api/sessions/:id/flatten',
    { schema: { params: idParams } },
    async (req, reply) =>
      mutate(req.params.id, reply, (row, bars) => sessionFlatten(bars, row.state)),
  );

  const exportRoute = (
    path: string,
    type: string,
    filename: (row: Row) => string,
    body: (row: Row, bars: Bar[]) => string,
  ) =>
    app.get<{ Params: { id: number } }>(
      path,
      { schema: { params: idParams } },
      async (req, reply) => {
        const loaded = load(req.params.id, reply);
        if (!loaded) return reply;
        const safe = filename(loaded.row).replace(/[^A-Za-z0-9._-]+/g, '_');
        return reply
          .header('content-type', type)
          .header('content-disposition', `attachment; filename="${safe}"`)
          .header('cache-control', 'no-store')
          .send(body(loaded.row, loaded.bars));
      },
    );

  exportRoute(
    '/api/sessions/:id/export/trades.csv',
    'text/csv; charset=utf-8',
    (row) => `candledrill-${row.id}-trades.csv`,
    (row) => tradesToCsv(row.state.trading.trades, row.settings.symbol, row.journal),
  );

  exportRoute(
    '/api/sessions/:id/export/report.html',
    'text/html; charset=utf-8',
    (row) => `candledrill-${row.id}-report.html`,
    (row) => {
      const ds = getDataset(db, row.datasetId);
      const { symbol, ...rest } = engineSettings(row.settings);
      return reportHtml({
        title: row.name,
        symbol,
        synthetic: ds?.synthetic ?? false,
        generatedAt: now().toISOString(),
        settings: rest,
        stats: sessionStats(row.settings, row.state),
        trades: row.state.trading.trades,
        riskNotice: CANDLEDRILL_RISK_NOTICE_EN,
        fillModel: FILL_MODEL_NOTE,
      });
    },
  );

  exportRoute(
    '/api/sessions/:id/export/session.json',
    'application/json; charset=utf-8',
    (row) => `candledrill-${row.id}-session.json`,
    (row) =>
      JSON.stringify(
        {
          format: 'candledrill-session',
          formatVersion: 1,
          note:
            'Practice session without price bars (it does contain fill prices and times derived ' +
            'from the dataset; check your data licence before sharing). ' +
            CANDLEDRILL_RISK_NOTICE_EN,
          simulationPolicy: SIMULATION_POLICY,
          name: row.name,
          startTime: row.startTime,
          settings: engineSettings(row.settings),
          state: row.state,
          drawings: row.drawings,
          journal: row.journal,
          stats: sessionStats(row.settings, row.state),
          dataset: { fingerprint: cache.fingerprint(row.datasetId) },
          // Blind sessions: the disguise is needed to restore the session. Opening the file
          // shows it, so keep the file closed until the session is finished if you care.
          ...(row.settings.blind ? { blind: row.settings.blind } : {}),
        },
        null,
        2,
      ),
  );

  app.put<{ Params: { id: number }; Body: { drawings: unknown[] } }>(
    '/api/sessions/:id/drawings',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['drawings'],
          properties: {
            drawings: {
              type: 'array',
              maxItems: MAX_DRAWINGS,
              items: {
                oneOf: [
                  {
                    type: 'object',
                    additionalProperties: false,
                    required: ['kind', 'id', 'price'],
                    properties: {
                      kind: { const: 'hline' },
                      id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,40}$' },
                      price: { type: 'number', exclusiveMinimum: 0 },
                    },
                  },
                  {
                    type: 'object',
                    additionalProperties: false,
                    required: ['kind', 'id', 't1', 'p1', 't2', 'p2'],
                    properties: {
                      kind: { const: 'rect' },
                      id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,40}$' },
                      t1: { type: 'integer' },
                      p1: { type: 'number', exclusiveMinimum: 0 },
                      t2: { type: 'integer' },
                      p2: { type: 'number', exclusiveMinimum: 0 },
                    },
                  },
                  {
                    type: 'object',
                    additionalProperties: false,
                    required: ['kind', 'id', 'side', 't1', 't2', 'entry', 'stop', 'target'],
                    properties: {
                      kind: { const: 'position' },
                      id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,40}$' },
                      side: { type: 'string', enum: ['long', 'short'] },
                      t1: { type: 'integer' },
                      t2: { type: 'integer' },
                      entry: { type: 'number', exclusiveMinimum: 0 },
                      stop: { type: 'number', exclusiveMinimum: 0 },
                      target: { type: 'number', exclusiveMinimum: 0 },
                    },
                  },
                  {
                    type: 'object',
                    additionalProperties: false,
                    required: ['kind', 'id', 't1', 'p1', 't2', 'p2'],
                    properties: {
                      kind: { const: 'tline' },
                      id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,40}$' },
                      t1: { type: 'integer' },
                      p1: { type: 'number', exclusiveMinimum: 0 },
                      t2: { type: 'integer' },
                      p2: { type: 'number', exclusiveMinimum: 0 },
                    },
                  },
                ],
              },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const loaded = load(req.params.id, reply);
      if (!loaded) return reply;
      const bad = drawingProblem(req.body.drawings);
      if (bad) return reply.code(400).send({ error: bad });
      updateSessionDrawings(db, loaded.row.id, req.body.drawings, now().toISOString());
      return { drawings: req.body.drawings };
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

  app.get<{ Params: { id: number } }>(
    '/api/sessions/:id/journal',
    { schema: { params: idParams } },
    async (req, reply) => {
      const loaded = load(req.params.id, reply);
      if (!loaded) return reply;
      const { row, bars } = loaded;
      const trades = row.state.trading.trades;
      return {
        journal: row.journal,
        excursions: tradeExcursions(bars, trades, row.settings),
        byHour: groupTrades(trades, row.settings, 'hour'),
        byWeekday: groupTrades(trades, row.settings, 'weekday'),
      };
    },
  );

  app.put<{ Params: { id: number; tradeId: number }; Body: { tags: string[]; note: string } }>(
    '/api/sessions/:id/journal/:tradeId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id', 'tradeId'],
          properties: {
            id: { type: 'integer', minimum: 1 },
            tradeId: { type: 'integer', minimum: 1 },
          },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['tags', 'note'],
          properties: {
            tags: {
              type: 'array',
              maxItems: MAX_TAGS * 4,
              items: { type: 'string', maxLength: MAX_TAG_LENGTH * 4 },
            },
            note: { type: 'string', maxLength: MAX_NOTE_LENGTH },
          },
        },
      },
    },
    async (req, reply) => {
      const loaded = load(req.params.id, reply);
      if (!loaded) return reply;
      const { row } = loaded;
      if (!row.state.trading.trades.some((t) => t.id === req.params.tradeId))
        return reply.code(404).send({ error: 'trade not found' });
      const entry = { tags: normalizeTags(req.body.tags), note: req.body.note.trim() };
      const issues = journalEntryIssues(entry);
      if (issues.length) return reply.code(400).send({ error: issues.join('; ') });
      const journal = { ...row.journal };
      const key = String(req.params.tradeId);
      if (entry.tags.length === 0 && entry.note === '') delete journal[key];
      else journal[key] = entry;
      updateSessionJournal(db, row.id, journal, now().toISOString());
      return { journal };
    },
  );

  app.post<{ Params: { id: number } }>(
    '/api/sessions/:id/reveal',
    { schema: { params: idParams } },
    async (req, reply) => {
      const loaded = load(req.params.id, reply);
      if (!loaded) return reply;
      const { row, bars } = loaded;
      if (!row.settings.blind) return reply.code(400).send({ error: 'not a blind session' });
      const settings: StoredSettings = {
        ...row.settings,
        blind: { ...row.settings.blind, revealed: true },
      };
      updateSessionSettings(db, row.id, settings, now().toISOString());
      return sessionView({ ...row, settings }, bars);
    },
  );

  // Import a session file exported by CandleDrill (this or another computer). The dataset is
  // found by its fingerprint; every fill and trade is checked against those bars.
  app.post<{ Body: { file: string; datasetId?: number } }>(
    '/api/sessions/import',
    {
      bodyLimit: MAX_SESSION_FILE_BYTES + 4096,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['file'],
          properties: {
            file: { type: 'string', minLength: 1, maxLength: MAX_SESSION_FILE_BYTES },
            datasetId: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    async (req, reply) => {
      const parsed = parseSessionFile(req.body.file);
      if (!parsed.file)
        return reply.code(400).send({ error: 'invalid session file', issues: parsed.issues });
      const f = parsed.file;
      let datasetId = req.body.datasetId;
      if (f.fingerprint) {
        const match = listDatasets(db).find((d) => cache.fingerprint(d.id) === f.fingerprint);
        if (!match)
          return reply.code(409).send({
            error: 'no dataset in this library has the same bars as the session file',
            code: 'no-matching-dataset',
          });
        if (datasetId !== undefined && datasetId !== match.id)
          return reply.code(409).send({
            error: 'the chosen dataset is not the one this session was made with',
            code: 'dataset-mismatch',
          });
        datasetId = match.id;
      }
      if (datasetId === undefined)
        return reply.code(400).send({
          error: 'this older session file has no dataset fingerprint: choose the dataset',
          code: 'choose-dataset',
        });
      const ds = getDataset(db, datasetId);
      if (!ds) return reply.code(404).send({ error: 'dataset not found' });
      let settings: StoredSettings = f.settings;
      let bars = cache.get(ds.id);
      if (f.blind) {
        const issues = blindIssues(f.blind, bars, f.settings.tickSize);
        if (f.blind.symbol !== ds.symbol) issues.push('blind symbol does not match the dataset');
        if (issues.length) return reply.code(400).send({ error: 'invalid session file', issues });
        settings = { ...f.settings, symbol: BLIND_SYMBOL, blind: f.blind };
        bars = cache.disguised(ds.id, f.blind, f.settings.tickSize);
      } else if (f.settings.symbol !== ds.symbol) {
        return reply.code(400).send({
          error: 'invalid session file',
          issues: [`symbol ${f.settings.symbol} does not match the dataset (${ds.symbol})`],
        });
      }
      const issues = checkSessionState(bars, settings, f.state);
      if (!issues.length && f.journal)
        issues.push(...journalIssues(f.journal, f.state.trading.trades));
      if (issues.length)
        return reply.code(400).send({ error: 'the session does not match this dataset', issues });
      const state = upgradeState(bars, settings, f.state);
      const row = insertSession(db, {
        datasetId: ds.id,
        name: f.name,
        startTime: f.startTime,
        settings,
        state,
        now: now().toISOString(),
      });
      if (f.drawings.length) updateSessionDrawings(db, row.id, f.drawings, now().toISOString());
      if (f.journal && Object.keys(f.journal).length)
        updateSessionJournal(db, row.id, f.journal as Row['journal'], now().toISOString());
      const saved = getSession<StoredSettings, SessionState>(db, row.id)!;
      return reply.code(201).send(sessionView(saved, bars));
    },
  );
}
