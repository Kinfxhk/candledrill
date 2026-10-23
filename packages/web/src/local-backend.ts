// SPDX-License-Identifier: AGPL-3.0-or-later
//
// In-browser backend for the GitHub Pages build. It implements the same HTTP-style routes as
// the local server (packages/server) on top of @candledrill/core, with IndexedDB storage, so the
// UI code is identical in both builds. Route logic mirrors packages/server/src/{app,sessions}.ts;
// keep the two in step when either changes.
//
// Honest limit: everything runs in the page, so blind-mode data is in browser memory. Blind mode
// here protects practice integrity (no accidental peeking), not against a user reading devtools.

import {
  BLIND_SYMBOL,
  CANDLEDRILL_RISK_NOTICE_EN,
  FILL_MODEL_NOTE,
  MAX_SESSION_FILE_BYTES,
  OrderError,
  SYNTHETIC_SYMBOL_PREFIX,
  blindIssues,
  checkSessionState,
  createSession,
  disguiseBars,
  generateSyntheticBars,
  groupTrades,
  importCsv,
  journalEntryIssues,
  journalIssues,
  jumpSession,
  normalizeSettings,
  normalizeTags,
  parseMacro,
  parseSessionFile,
  pickBlindParams,
  pickBlindStartIndex,
  reportHtml,
  runMacro,
  sessionCancelOrder,
  sessionFlatten,
  sessionModifyOrder,
  sessionPlaceOrder,
  sessionStats,
  simulationPolicyFor,
  stepSession,
  tradeExcursions,
  tradesToCsv,
  upgradeState,
  validateSettings,
  visibleBars,
  type Bar,
  type DatasetMeta,
  type SessionSettings,
  type SessionState,
} from '@candledrill/core';

export const MAX_HISTORY_BARS = 50_000;
export const MAX_DRAWINGS = 200;
const MAX_SYNTHETIC_DAYS = 366;
const DB_NAME = 'candledrill';
const DB_VERSION = 1;
export const LOCAL_BACKUP_FORMAT = 'candledrill-browser-backup';

interface BlindInfo {
  readonly timeShift: number;
  readonly priceOffset: number;
  readonly revealed: boolean;
  readonly symbol: string;
}
type StoredSettings = SessionSettings & { readonly blind?: BlindInfo };

interface DatasetRecord {
  id: number;
  name: string;
  symbol: string;
  source: DatasetMeta['source'];
  synthetic: boolean;
  timeframeSeconds: number;
  tickSize: number;
  generator: DatasetMeta['generator'] | null;
  barCount: number;
  firstTime: number | null;
  lastTime: number | null;
  utcOffsetMinutes: number;
  createdAt: string;
}

interface SessionRecord {
  id: number;
  datasetId: number;
  name: string;
  startTime: number;
  settings: StoredSettings;
  state: SessionState;
  drawings: unknown[];
  journal: Record<string, { tags: string[]; note: string }>;
  createdAt: string;
  updatedAt: string;
}

/** A Response-like result so api.ts can treat both transports the same. */
export interface LocalReply {
  status: number;
  body: unknown;
  /** For downloads (exports / backup). */
  download?: { filename: string; type: string; text: string };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(String(body.error ?? status));
  }
}
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): never => {
  throw new HttpError(status, { error, ...extra });
};

// ------------------------------------------------------------------ IndexedDB
function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

class Store {
  private dbp: Promise<IDBDatabase> | null = null;
  private db(): Promise<IDBDatabase> {
    if (!this.dbp) {
      this.dbp = new Promise((resolve, reject) => {
        const open = indexedDB.open(DB_NAME, DB_VERSION);
        open.onupgradeneeded = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('datasets'))
            db.createObjectStore('datasets', { keyPath: 'id', autoIncrement: true });
          if (!db.objectStoreNames.contains('bars')) db.createObjectStore('bars');
          if (!db.objectStoreNames.contains('sessions'))
            db.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
        };
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
    }
    return this.dbp;
  }
  async all<T>(store: string): Promise<T[]> {
    const db = await this.db();
    return req(db.transaction(store).objectStore(store).getAll() as IDBRequest<T[]>);
  }
  async get<T>(store: string, key: number): Promise<T | undefined> {
    const db = await this.db();
    return req(db.transaction(store).objectStore(store).get(key) as IDBRequest<T | undefined>);
  }
  async put<T extends { id?: number }>(store: string, value: T): Promise<number> {
    const db = await this.db();
    const tx = db.transaction(store, 'readwrite');
    const key = (await req(tx.objectStore(store).put(value))) as number;
    await done(tx);
    return key;
  }
  async insertDataset(rec: Omit<DatasetRecord, 'id'>, bars: Bar[]): Promise<DatasetRecord> {
    const db = await this.db();
    const tx = db.transaction(['datasets', 'bars'], 'readwrite');
    const id = (await req(tx.objectStore('datasets').add(rec))) as number;
    tx.objectStore('bars').put(bars, id);
    await done(tx);
    return { ...rec, id };
  }
  async bars(id: number): Promise<Bar[]> {
    const db = await this.db();
    return (
      (await req(db.transaction('bars').objectStore('bars').get(id) as IDBRequest<Bar[]>)) ?? []
    );
  }
  async deleteDataset(id: number): Promise<boolean> {
    const db = await this.db();
    const existing = await this.get<DatasetRecord>('datasets', id);
    if (!existing) return false;
    const sessions = (await this.all<SessionRecord>('sessions')).filter((s) => s.datasetId === id);
    const tx = db.transaction(['datasets', 'bars', 'sessions'], 'readwrite');
    tx.objectStore('datasets').delete(id);
    tx.objectStore('bars').delete(id);
    for (const s of sessions) tx.objectStore('sessions').delete(s.id);
    await done(tx);
    return true;
  }
  async deleteSession(id: number): Promise<boolean> {
    const db = await this.db();
    if (!(await this.get('sessions', id))) return false;
    const tx = db.transaction('sessions', 'readwrite');
    tx.objectStore('sessions').delete(id);
    await done(tx);
    return true;
  }
  /** Close the connection (tests delete the database between cases). */
  async close(): Promise<void> {
    if (this.dbp) (await this.dbp).close();
    this.dbp = null;
  }
  async clearAll(): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(['datasets', 'bars', 'sessions'], 'readwrite');
    for (const s of ['datasets', 'bars', 'sessions']) tx.objectStore(s).clear();
    await done(tx);
  }
}

// ------------------------------------------------------------------ helpers mirrored from the server
const cryptoRandom = (): number => {
  const a = new Uint32Array(2);
  crypto.getRandomValues(a);
  // 47 bits like the server's randomInt(0, 2**47) / 2**47.
  return ((a[0]! & 0x7fff) * 2 ** 32 + a[1]!) / 2 ** 47;
};

async function barsFingerprint(bars: readonly Bar[]): Promise<string> {
  const text = bars
    .map((b) => `${b.time},${b.open},${b.high},${b.low},${b.close},${b.volume}\n`)
    .join('');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function isBlindHidden(settings: StoredSettings, state: SessionState): boolean {
  return settings.blind !== undefined && !settings.blind.revealed && state.status !== 'finished';
}
function engineSettings(s: StoredSettings): SessionSettings {
  const { blind: _b, ...rest } = s;
  void _b;
  return rest;
}

function drawingProblem(drawings: unknown[]): string | null {
  if (!Array.isArray(drawings)) return 'drawings must be an array';
  if (drawings.length > MAX_DRAWINGS) return `at most ${MAX_DRAWINGS} drawings`;
  const ids = new Set<string>();
  for (const raw of drawings) {
    const d = raw as Record<string, unknown> & { id: string; kind: string };
    if (!d || typeof d.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(d.id))
      return 'drawing id invalid';
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

function sessionView(row: SessionRecord, bars: readonly Bar[], state: SessionState = row.state) {
  const { state: _omit, settings, ...rest } = row;
  void _omit;
  const base = engineSettings(settings);
  const blind = settings.blind
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

// ------------------------------------------------------------------ backend
export class LocalBackend {
  private readonly store = new Store();
  private readonly barCache = new Map<number, Bar[]>();
  private readonly blindCache = new Map<string, Bar[]>();
  private readonly prints = new Map<number, string>();

  constructor(
    private readonly releaseVersion: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  close(): Promise<void> {
    return this.store.close();
  }

  private async realBars(id: number): Promise<Bar[]> {
    let b = this.barCache.get(id);
    if (!b) {
      b = await this.store.bars(id);
      this.barCache.set(id, b);
      while (this.barCache.size > 4) this.barCache.delete(this.barCache.keys().next().value!);
    }
    return b;
  }
  private async disguised(id: number, blind: BlindInfo, tick: number): Promise<Bar[]> {
    const key = `${id}:${blind.timeShift}:${blind.priceOffset}:${tick}`;
    let b = this.blindCache.get(key);
    if (!b) {
      b = disguiseBars(await this.realBars(id), blind, tick);
      this.blindCache.set(key, b);
      while (this.blindCache.size > 4) this.blindCache.delete(this.blindCache.keys().next().value!);
    }
    return b;
  }
  private async fingerprint(id: number): Promise<string> {
    let f = this.prints.get(id);
    if (!f) {
      f = await barsFingerprint(await this.realBars(id));
      this.prints.set(id, f);
    }
    return f;
  }
  private invalidate(id: number): void {
    this.barCache.delete(id);
    this.prints.delete(id);
    for (const k of [...this.blindCache.keys()])
      if (k.startsWith(`${id}:`)) this.blindCache.delete(k);
  }

  private async load(id: number): Promise<{ row: SessionRecord; bars: Bar[] }> {
    const row = await this.store.get<SessionRecord>('sessions', id);
    if (!row) return fail(404, 'session not found');
    const bars = row.settings.blind
      ? await this.disguised(row.datasetId, row.settings.blind, row.settings.tickSize)
      : await this.realBars(row.datasetId);
    const settings = normalizeSettings(row.settings);
    return {
      row: {
        ...row,
        settings: { ...row.settings, ...settings },
        state: upgradeState(bars, settings, row.state),
      },
      bars,
    };
  }
  private async save(row: SessionRecord, patch: Partial<SessionRecord>): Promise<SessionRecord> {
    const next = { ...row, ...patch, updatedAt: this.now().toISOString() };
    await this.store.put('sessions', next);
    return next;
  }
  private async blindLocked(): Promise<Set<number>> {
    const out = new Set<number>();
    for (const r of await this.store.all<SessionRecord>('sessions'))
      if (isBlindHidden(r.settings, r.state)) out.add(r.datasetId);
    return out;
  }

  /** Dispatch one API call. Throws nothing: errors come back as a status + body. */
  async handle(method: string, url: string, body: unknown): Promise<LocalReply> {
    try {
      return await this.route(method, url, body);
    } catch (err) {
      if (err instanceof HttpError) return { status: err.status, body: err.body };
      if (err instanceof OrderError) return { status: 400, body: { error: err.message } };
      return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
    }
  }

  private async route(method: string, url: string, body: unknown): Promise<LocalReply> {
    const u = new URL(url, 'http://local');
    const p = u.pathname;
    const b = (body ?? {}) as Record<string, unknown>;
    const ok = (v: unknown, status = 200): LocalReply => ({ status, body: v });
    let m: RegExpExecArray | null;

    if (method === 'GET' && p === '/api/health')
      return ok({
        status: 'ok',
        name: 'CandleDrill',
        releaseVersion: this.releaseVersion,
        telemetry: false,
        backend: 'browser',
        notice: CANDLEDRILL_RISK_NOTICE_EN,
      });
    if (method === 'GET' && p === '/api/updates')
      return ok({
        current: this.releaseVersion,
        latest: null,
        newer: false,
        url: 'https://github.com/Kinfxhk/candledrill/releases',
        name: null,
        available: false,
      });

    // ---------------------------------------------------------------- datasets
    if (method === 'GET' && p === '/api/datasets') {
      const locked = await this.blindLocked();
      const rows = (await this.store.all<DatasetRecord>('datasets')).sort((a, c) => a.id - c.id);
      return ok({ datasets: rows.map((d) => ({ ...d, blindLocked: locked.has(d.id) })) });
    }
    if (method === 'POST' && p === '/api/datasets/synthetic') {
      const seed = Number(b.seed);
      const days = Number(b.days);
      const startDate = String(b.startDate ?? '');
      if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) fail(400, 'bad seed');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) fail(400, 'bad startDate');
      if (!Number.isInteger(days) || days < 1 || days > MAX_SYNTHETIC_DAYS) fail(400, 'bad days');
      let dataset;
      try {
        dataset = generateSyntheticBars({
          seed,
          startDate,
          days,
          ...(typeof b.name === 'string' ? { name: b.name } : {}),
          ...(b.timeframeSeconds !== undefined
            ? { timeframeSeconds: Number(b.timeframeSeconds) }
            : {}),
        });
      } catch (err) {
        return fail(400, (err as Error).message);
      }
      const rec = await this.store.insertDataset(
        {
          name: `${dataset.meta.symbol} seed=${seed} ${startDate} +${days}d`,
          symbol: dataset.meta.symbol,
          source: dataset.meta.source,
          synthetic: dataset.meta.synthetic,
          timeframeSeconds: dataset.meta.timeframeSeconds,
          tickSize: dataset.meta.tickSize,
          generator: dataset.meta.generator ?? null,
          barCount: dataset.bars.length,
          firstTime: dataset.bars[0]?.time ?? null,
          lastTime: dataset.bars.at(-1)?.time ?? null,
          utcOffsetMinutes: 0,
          createdAt: this.now().toISOString(),
        },
        [...dataset.bars],
      );
      return ok({ dataset: rec }, 201);
    }
    if (method === 'POST' && p === '/api/datasets/import') {
      const { name, symbol, tickSize, csv, options } = b as {
        name: string;
        symbol: string;
        tickSize: number;
        csv: string;
        options: Record<string, unknown>;
      };
      if (typeof name !== 'string' || !name || name.length > 80) fail(400, 'bad name');
      if (typeof symbol !== 'string' || !/^[A-Za-z0-9._-]{1,32}$/.test(symbol))
        fail(400, 'bad symbol');
      if (symbol.toUpperCase().startsWith(SYNTHETIC_SYMBOL_PREFIX))
        fail(400, `symbols starting with ${SYNTHETIC_SYMBOL_PREFIX} are reserved`);
      if (!(tickSize > 0)) fail(400, 'bad tickSize');
      const result = importCsv(csv, { ...(options as object), tickSize } as Parameters<
        typeof importCsv
      >[1]);
      if (!result.ok)
        return { status: 422, body: { error: 'import failed', report: result.report } };
      const bars = [...result.bars];
      const rec = await this.store.insertDataset(
        {
          name,
          symbol,
          source: 'user-import',
          synthetic: false,
          timeframeSeconds: result.report.timeframeSeconds,
          tickSize,
          generator: null,
          barCount: bars.length,
          firstTime: bars[0]?.time ?? null,
          lastTime: bars.at(-1)?.time ?? null,
          utcOffsetMinutes: Number(options?.utcOffsetMinutes ?? 0),
          createdAt: this.now().toISOString(),
        },
        bars,
      );
      return ok({ dataset: rec, report: result.report }, 201);
    }
    if ((m = /^\/api\/datasets\/(\d+)$/.exec(p)) && method === 'DELETE') {
      const id = Number(m[1]);
      if (!(await this.store.deleteDataset(id))) fail(404, 'not found');
      this.invalidate(id);
      return { status: 204, body: undefined };
    }
    if ((m = /^\/api\/datasets\/(\d+)\/bars$/.exec(p)) && method === 'GET') {
      const id = Number(m[1]);
      const ds = await this.store.get<DatasetRecord>('datasets', id);
      if (!ds) fail(404, 'dataset not found');
      if ((await this.blindLocked()).has(id))
        fail(423, 'hidden while a blind session on this dataset is running', {
          code: 'blind-lock',
        });
      const all = await this.realBars(id);
      const from = u.searchParams.has('from') ? Number(u.searchParams.get('from')) : -Infinity;
      const to = u.searchParams.has('to') ? Number(u.searchParams.get('to')) : Infinity;
      const limit = Math.min(Number(u.searchParams.get('limit') ?? 5000), MAX_HISTORY_BARS);
      const range = all.filter((x) => x.time >= from && x.time <= to);
      const bars =
        u.searchParams.get('last') === 'true' ? range.slice(-limit) : range.slice(0, limit);
      return ok({ datasetId: id, synthetic: ds!.synthetic, bars });
    }

    // ---------------------------------------------------------------- backup (browser: JSON)
    if (method === 'GET' && p === '/api/backup') {
      const datasets = await this.store.all<DatasetRecord>('datasets');
      const bars: Record<string, Bar[]> = {};
      for (const d of datasets) bars[d.id] = await this.realBars(d.id);
      const sessions = await this.store.all<SessionRecord>('sessions');
      const stamp = this.now().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
      return {
        status: 200,
        body: undefined,
        download: {
          filename: `candledrill-backup-${stamp}.json`,
          type: 'application/json',
          text: JSON.stringify({
            format: LOCAL_BACKUP_FORMAT,
            formatVersion: 1,
            exportedAt: this.now().toISOString(),
            note: CANDLEDRILL_RISK_NOTICE_EN,
            datasets,
            bars,
            sessions,
          }),
        },
      };
    }
    if (method === 'POST' && p === '/api/restore') {
      let parsed: {
        format?: string;
        datasets?: DatasetRecord[];
        bars?: Record<string, Bar[]>;
        sessions?: SessionRecord[];
      };
      try {
        parsed = JSON.parse(
          typeof body === 'string' ? body : new TextDecoder().decode(body as ArrayBuffer),
        );
      } catch {
        return fail(400, 'not a CandleDrill browser backup (JSON)');
      }
      if (parsed.format !== LOCAL_BACKUP_FORMAT || !Array.isArray(parsed.datasets))
        fail(400, 'not a CandleDrill browser backup');
      await this.store.clearAll();
      this.barCache.clear();
      this.blindCache.clear();
      this.prints.clear();
      const idMap = new Map<number, number>();
      for (const d of parsed.datasets!) {
        const { id, ...rest } = d;
        const rec = await this.store.insertDataset(rest, parsed.bars?.[id] ?? []);
        idMap.set(id, rec.id);
      }
      let sessions = 0;
      for (const s of parsed.sessions ?? []) {
        const datasetId = idMap.get(s.datasetId);
        if (datasetId === undefined) continue;
        const { id: _id, ...rest } = s;
        void _id;
        await this.store.put('sessions', { ...rest, datasetId } as SessionRecord);
        sessions++;
      }
      return ok({ datasets: idMap.size, sessions, previousCopy: null });
    }

    // ---------------------------------------------------------------- sessions
    if (method === 'GET' && p === '/api/sessions') {
      const rows = (await this.store.all<SessionRecord>('sessions')).sort(
        (a, c) => c.updatedAt.localeCompare(a.updatedAt) || c.id - a.id,
      );
      return ok({
        sessions: rows.map((r) => ({
          id: r.id,
          datasetId: r.datasetId,
          name: r.name,
          status: r.state.status,
          blind: r.settings.blind
            ? isBlindHidden(r.settings, r.state)
              ? 'hidden'
              : 'revealed'
            : null,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        })),
      });
    }
    if (method === 'POST' && p === '/api/sessions') return this.createSession(b);
    if (method === 'POST' && p === '/api/sessions/import') return this.importSession(b);

    m = /^\/api\/sessions\/(\d+)(\/.*)?$/.exec(p);
    if (m) {
      const id = Number(m[1]);
      const sub = m[2] ?? '';
      if (sub === '' && method === 'GET') {
        const { row, bars } = await this.load(id);
        const history = Math.min(
          Number(u.searchParams.get('history') ?? MAX_HISTORY_BARS),
          MAX_HISTORY_BARS,
        );
        const visible = visibleBars(bars, row.state.cursor);
        return ok({ ...sessionView(row, bars), bars: visible.slice(-history) });
      }
      if (sub === '' && method === 'DELETE') {
        if (!(await this.store.deleteSession(id))) fail(404, 'session not found');
        return { status: 204, body: undefined };
      }
      if (sub === '/step' && method === 'POST') {
        const { row, bars } = await this.load(id);
        const count = b.count === undefined ? 1 : Number(b.count);
        if (!Number.isInteger(count) || count < 1 || count > 5000) fail(400, 'bad count');
        const r = stepSession(bars, row.settings, row.state, count);
        await this.save(row, { state: r.state });
        return ok({ ...sessionView(row, bars, r.state), revealed: r.revealed });
      }
      if (sub === '/jump' && method === 'POST') {
        const { row, bars } = await this.load(id);
        if (!Number.isInteger(b.time)) fail(400, 'bad time');
        const r = jumpSession(bars, row.settings, row.state, Number(b.time));
        await this.save(row, { state: r.state });
        const revealed =
          r.revealed.length > MAX_HISTORY_BARS ? r.revealed.slice(-MAX_HISTORY_BARS) : r.revealed;
        return ok({
          ...sessionView(row, bars, r.state),
          revealed,
          truncated: revealed.length < r.revealed.length,
        });
      }
      if (sub === '/state' && method === 'PUT') {
        // Rewind / checkpoints: restore an earlier engine state of this same session.
        const { row, bars } = await this.load(id);
        const state = b.state as SessionState;
        if (!state || typeof state !== 'object') fail(400, 'state required');
        if (isBlindHidden(row.settings, row.state))
          fail(423, 'rewind is off in a blind session until you reveal');
        const issues = checkSessionState(bars, row.settings, state);
        if (issues.length) fail(400, 'state does not match this session', { issues });
        const next = upgradeState(bars, normalizeSettings(row.settings), state);
        await this.save(row, { state: next });
        const visible = visibleBars(bars, next.cursor);
        return ok({ ...sessionView(row, bars, next), bars: visible.slice(-MAX_HISTORY_BARS) });
      }
      if (sub === '/orders' && method === 'POST') {
        const { row, bars } = await this.load(id);
        const state = sessionPlaceOrder(bars, row.settings, row.state, b as never);
        await this.save(row, { state });
        return ok(sessionView(row, bars, state));
      }
      if ((m = /^\/orders\/(\d+)$/.exec(sub))) {
        const orderId = Number(m[1]);
        const { row, bars } = await this.load(id);
        let state: SessionState;
        if (method === 'DELETE') state = sessionCancelOrder(row.state, orderId);
        else if (method === 'PATCH')
          state = sessionModifyOrder(
            row.settings,
            row.state,
            orderId,
            b as never,
            bars[row.state.cursor]!.time,
          );
        else return fail(405, 'method not allowed');
        await this.save(row, { state });
        return ok(sessionView(row, bars, state));
      }
      if (sub === '/flatten' && method === 'POST') {
        const { row, bars } = await this.load(id);
        const state = sessionFlatten(bars, row.state);
        await this.save(row, { state });
        return ok(sessionView(row, bars, state));
      }
      if (sub === '/macro-run' && method === 'POST') {
        const { row, bars } = await this.load(id);
        if (isBlindHidden(row.settings, row.state))
          fail(423, 'blind session is hidden; macro backtest stays off until you reveal');
        let macro;
        try {
          macro = parseMacro(b.macro);
        } catch (err) {
          return fail(400, err instanceof Error ? err.message : 'invalid macro');
        }
        const result = runMacro(bars, engineSettings(row.settings), row.state, macro, {
          mode: (b.mode as 'to_end' | 'n_bars') ?? 'to_end',
          from: (b.from as 'start' | 'cursor') ?? 'start',
          ...(b.count !== undefined ? { count: Number(b.count) } : {}),
        });
        const { trades: _t, ...rest } = result;
        void _t;
        return ok({ ...rest, notice: CANDLEDRILL_RISK_NOTICE_EN, researchCopy: true });
      }
      if (sub === '/drawings' && method === 'PUT') {
        const { row } = await this.load(id);
        const bad = drawingProblem(b.drawings as unknown[]);
        if (bad) fail(400, bad);
        await this.save(row, { drawings: b.drawings as unknown[] });
        return ok({ drawings: b.drawings });
      }
      if (sub === '/journal' && method === 'GET') {
        const { row, bars } = await this.load(id);
        const trades = row.state.trading.trades;
        return ok({
          journal: row.journal,
          excursions: tradeExcursions(bars, trades, row.settings),
          byHour: groupTrades(trades, row.settings, 'hour'),
          byWeekday: groupTrades(trades, row.settings, 'weekday'),
        });
      }
      if ((m = /^\/journal\/(\d+)$/.exec(sub)) && method === 'PUT') {
        const tradeId = Number(m[1]);
        const { row } = await this.load(id);
        if (!row.state.trading.trades.some((t) => t.id === tradeId)) fail(404, 'trade not found');
        const entry = {
          tags: normalizeTags((b.tags as string[]) ?? []),
          note: String(b.note ?? '').trim(),
        };
        const issues = journalEntryIssues(entry);
        if (issues.length) fail(400, issues.join('; '));
        const journal = { ...row.journal };
        if (entry.tags.length === 0 && entry.note === '') delete journal[String(tradeId)];
        else journal[String(tradeId)] = entry;
        await this.save(row, { journal });
        return ok({ journal });
      }
      if (sub === '/reveal' && method === 'POST') {
        const { row, bars } = await this.load(id);
        if (!row.settings.blind) fail(400, 'not a blind session');
        const settings: StoredSettings = {
          ...row.settings,
          blind: { ...row.settings.blind!, revealed: true },
        };
        const saved = await this.save(row, { settings });
        return ok(sessionView(saved, bars));
      }
      if (
        (m = /^\/export\/(trades\.csv|report\.html|session\.json)$/.exec(sub)) &&
        method === 'GET'
      )
        return this.exportFile(id, m[1]!);
    }
    return fail(404, `no route ${method} ${p}`);
  }

  private async createSession(b: Record<string, unknown>): Promise<LocalReply> {
    const datasetId = Number(b.datasetId);
    const name = String(b.name ?? '');
    if (!name || name.length > 80) fail(400, 'bad name');
    const ds = await this.store.get<DatasetRecord>('datasets', datasetId);
    if (!ds) fail(404, 'dataset not found');
    const input = (b.settings ?? {}) as Omit<SessionSettings, 'symbol'>;
    const practiceTf =
      input.practiceTimeframeSeconds ?? (ds!.timeframeSeconds < 60 ? 60 : undefined);
    const plain = normalizeSettings({
      ...input,
      symbol: ds!.symbol,
      ...(practiceTf !== undefined ? { practiceTimeframeSeconds: practiceTf } : {}),
    } as SessionSettings);
    const errors = validateSettings(plain);
    if (errors.length) fail(400, errors.join('; '));
    const real = await this.realBars(ds!.id);
    let settings: StoredSettings = plain;
    let bars = real;
    let startTime = b.startTime === undefined ? undefined : Number(b.startTime);
    if (b.blind) {
      if (real.length < 3) fail(400, 'dataset too short for blind mode');
      const pbl = pickBlindParams(real, plain.tickSize, cryptoRandom);
      const blind: BlindInfo = { ...pbl, revealed: false, symbol: ds!.symbol };
      settings = { ...plain, symbol: BLIND_SYMBOL, blind };
      bars = await this.disguised(ds!.id, blind, plain.tickSize);
      startTime = bars[pickBlindStartIndex(bars.length, cryptoRandom)]!.time;
    }
    if (startTime === undefined) fail(400, 'startTime is required (or use blind mode)');
    let state: SessionState;
    try {
      state = createSession(bars, settings, startTime!);
    } catch (err) {
      return fail(400, (err as Error).message);
    }
    const now = this.now().toISOString();
    const rec: Omit<SessionRecord, 'id'> = {
      datasetId: ds!.id,
      name,
      startTime: startTime!,
      settings,
      state,
      drawings: [],
      journal: {},
      createdAt: now,
      updatedAt: now,
    };
    const id = await this.store.put('sessions', rec as SessionRecord);
    return { status: 201, body: sessionView({ ...rec, id }, bars) };
  }

  private async importSession(b: Record<string, unknown>): Promise<LocalReply> {
    const file = String(b.file ?? '');
    if (!file || file.length > MAX_SESSION_FILE_BYTES) fail(400, 'invalid session file');
    const parsed = parseSessionFile(file);
    if (!parsed.file) fail(400, 'invalid session file', { issues: parsed.issues });
    const f = parsed.file!;
    let datasetId = b.datasetId === undefined ? undefined : Number(b.datasetId);
    if (f.fingerprint) {
      let match: DatasetRecord | undefined;
      for (const d of await this.store.all<DatasetRecord>('datasets'))
        if ((await this.fingerprint(d.id)) === f.fingerprint) {
          match = d;
          break;
        }
      if (!match)
        fail(409, 'no dataset in this library has the same bars as the session file', {
          code: 'no-matching-dataset',
        });
      if (datasetId !== undefined && datasetId !== match!.id)
        fail(409, 'the chosen dataset is not the one this session was made with', {
          code: 'dataset-mismatch',
        });
      datasetId = match!.id;
    }
    if (datasetId === undefined)
      fail(400, 'this older session file has no dataset fingerprint: choose the dataset', {
        code: 'choose-dataset',
      });
    const ds = await this.store.get<DatasetRecord>('datasets', datasetId!);
    if (!ds) fail(404, 'dataset not found');
    let settings: StoredSettings = f.settings;
    let bars = await this.realBars(ds!.id);
    if (f.blind) {
      const issues = blindIssues(f.blind, bars, f.settings.tickSize);
      if (f.blind.symbol !== ds!.symbol) issues.push('blind symbol does not match the dataset');
      if (issues.length) fail(400, 'invalid session file', { issues });
      settings = { ...f.settings, symbol: BLIND_SYMBOL, blind: f.blind };
      bars = await this.disguised(ds!.id, f.blind, f.settings.tickSize);
    } else if (f.settings.symbol !== ds!.symbol) {
      fail(400, 'invalid session file', {
        issues: [`symbol ${f.settings.symbol} does not match the dataset (${ds!.symbol})`],
      });
    }
    const issues = checkSessionState(bars, settings, f.state);
    if (!issues.length && f.journal)
      issues.push(...journalIssues(f.journal, f.state.trading.trades));
    if (issues.length) fail(400, 'the session does not match this dataset', { issues });
    const state = upgradeState(bars, normalizeSettings(settings), f.state);
    const now = this.now().toISOString();
    const rec: Omit<SessionRecord, 'id'> = {
      datasetId: ds!.id,
      name: f.name,
      startTime: f.startTime,
      settings,
      state,
      drawings: [...f.drawings],
      journal: (f.journal ?? {}) as SessionRecord['journal'],
      createdAt: now,
      updatedAt: now,
    };
    const id = await this.store.put('sessions', rec as SessionRecord);
    return { status: 201, body: sessionView({ ...rec, id }, bars) };
  }

  private async exportFile(id: number, file: string): Promise<LocalReply> {
    const { row } = await this.load(id);
    const dl = (filename: string, type: string, text: string): LocalReply => ({
      status: 200,
      body: undefined,
      download: { filename: filename.replace(/[^A-Za-z0-9._-]+/g, '_'), type, text },
    });
    if (file === 'trades.csv')
      return dl(
        `candledrill-${row.id}-trades.csv`,
        'text/csv;charset=utf-8',
        tradesToCsv(row.state.trading.trades, row.settings.symbol, row.journal),
      );
    if (file === 'report.html') {
      const ds = await this.store.get<DatasetRecord>('datasets', row.datasetId);
      const { symbol, ...rest } = engineSettings(row.settings);
      return dl(
        `candledrill-${row.id}-report.html`,
        'text/html;charset=utf-8',
        reportHtml({
          title: row.name,
          symbol,
          synthetic: ds?.synthetic ?? false,
          generatedAt: this.now().toISOString(),
          settings: rest,
          stats: sessionStats(row.settings, row.state),
          trades: row.state.trading.trades,
          riskNotice: CANDLEDRILL_RISK_NOTICE_EN,
          fillModel: FILL_MODEL_NOTE,
        }),
      );
    }
    if (isBlindHidden(row.settings, row.state))
      fail(423, 'blind session file is withheld until you reveal');
    return dl(
      `candledrill-${row.id}-session.json`,
      'application/json;charset=utf-8',
      JSON.stringify(
        {
          format: 'candledrill-session',
          formatVersion: 2,
          note:
            'Practice session without price bars (it does contain fill prices and times derived ' +
            'from the dataset; check your data licence before sharing). ' +
            CANDLEDRILL_RISK_NOTICE_EN,
          simulationPolicy: simulationPolicyFor(engineSettings(row.settings).trailingDrawdownMode),
          name: row.name,
          startTime: row.startTime,
          settings: engineSettings(row.settings),
          state: row.state,
          drawings: row.drawings,
          journal: row.journal,
          stats: sessionStats(row.settings, row.state),
          dataset: { fingerprint: await this.fingerprint(row.datasetId) },
          ...(row.settings.blind ? { blind: row.settings.blind } : {}),
        },
        null,
        2,
      ),
    );
  }
}
