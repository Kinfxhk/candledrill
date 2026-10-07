// SPDX-License-Identifier: AGPL-3.0-or-later
import Database from 'better-sqlite3';
import type { Bar, DatasetMeta } from '@candledrill/core';

export type Db = Database.Database;

const MIGRATIONS: readonly string[] = [
  // v1: datasets + 1-minute bars
  `CREATE TABLE datasets (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     symbol TEXT NOT NULL,
     source TEXT NOT NULL CHECK (source IN ('synthetic', 'user-import')),
     synthetic INTEGER NOT NULL CHECK (synthetic IN (0, 1)),
     timeframe_seconds INTEGER NOT NULL,
     tick_size REAL NOT NULL,
     generator_json TEXT,
     bar_count INTEGER NOT NULL DEFAULT 0,
     first_time INTEGER,
     last_time INTEGER,
     created_at TEXT NOT NULL
   );
   CREATE TABLE bars (
     dataset_id INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
     time INTEGER NOT NULL,
     open REAL NOT NULL,
     high REAL NOT NULL,
     low REAL NOT NULL,
     close REAL NOT NULL,
     volume REAL NOT NULL,
     PRIMARY KEY (dataset_id, time)
   ) WITHOUT ROWID;`,
  // v2: exchange-local UTC offset recorded at import time (used as the session default)
  `ALTER TABLE datasets ADD COLUMN utc_offset_minutes INTEGER NOT NULL DEFAULT 0;`,
];

export function openDatabase(path: string): Db {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  if (path !== ':memory:') db.pragma('journal_mode = WAL');
  migrate(db);
  return db;
}

export function migrate(db: Db): number {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  return db.pragma('user_version', { simple: true }) as number;
}

export interface DatasetRow {
  readonly id: number;
  readonly name: string;
  readonly symbol: string;
  readonly source: DatasetMeta['source'];
  readonly synthetic: boolean;
  readonly timeframeSeconds: number;
  readonly tickSize: number;
  readonly generator: DatasetMeta['generator'] | null;
  readonly barCount: number;
  readonly firstTime: number | null;
  readonly lastTime: number | null;
  readonly utcOffsetMinutes: number;
  readonly createdAt: string;
}

interface RawDatasetRow {
  id: number;
  name: string;
  symbol: string;
  source: DatasetMeta['source'];
  synthetic: number;
  timeframe_seconds: number;
  tick_size: number;
  generator_json: string | null;
  bar_count: number;
  first_time: number | null;
  last_time: number | null;
  utc_offset_minutes: number;
  created_at: string;
}

function toRow(r: RawDatasetRow): DatasetRow {
  return {
    id: r.id,
    name: r.name,
    symbol: r.symbol,
    source: r.source,
    synthetic: r.synthetic === 1,
    timeframeSeconds: r.timeframe_seconds,
    tickSize: r.tick_size,
    generator: r.generator_json ? (JSON.parse(r.generator_json) as DatasetMeta['generator']) : null,
    barCount: r.bar_count,
    firstTime: r.first_time,
    lastTime: r.last_time,
    utcOffsetMinutes: r.utc_offset_minutes,
    createdAt: r.created_at,
  };
}

export function insertDataset(
  db: Db,
  name: string,
  meta: DatasetMeta,
  bars: readonly Bar[],
  createdAt: string,
  utcOffsetMinutes = 0,
): DatasetRow {
  const insertMeta = db.prepare(
    `INSERT INTO datasets (name, symbol, source, synthetic, timeframe_seconds, tick_size,
       generator_json, bar_count, first_time, last_time, utc_offset_minutes, created_at)
     VALUES (@name, @symbol, @source, @synthetic, @tf, @tick, @gen, @count, @first, @last,
       @utcOffset, @created)`,
  );
  const insertBar = db.prepare(
    `INSERT INTO bars (dataset_id, time, open, high, low, close, volume)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const id = db.transaction(() => {
    const info = insertMeta.run({
      name,
      symbol: meta.symbol,
      source: meta.source,
      synthetic: meta.synthetic ? 1 : 0,
      tf: meta.timeframeSeconds,
      tick: meta.tickSize,
      gen: meta.generator ? JSON.stringify(meta.generator) : null,
      count: bars.length,
      first: bars[0]?.time ?? null,
      last: bars.at(-1)?.time ?? null,
      utcOffset: utcOffsetMinutes,
      created: createdAt,
    });
    const datasetId = Number(info.lastInsertRowid);
    for (const b of bars) {
      insertBar.run(datasetId, b.time, b.open, b.high, b.low, b.close, b.volume);
    }
    return datasetId;
  })();
  return getDataset(db, id)!;
}

export function getDataset(db: Db, id: number): DatasetRow | undefined {
  const r = db.prepare('SELECT * FROM datasets WHERE id = ?').get(id) as RawDatasetRow | undefined;
  return r ? toRow(r) : undefined;
}

export function listDatasets(db: Db): DatasetRow[] {
  return (db.prepare('SELECT * FROM datasets ORDER BY id').all() as RawDatasetRow[]).map(toRow);
}

export interface BarQuery {
  readonly from?: number;
  /** Inclusive upper bound. The replay clock (M2) will always pass this. */
  readonly to?: number;
  readonly limit: number;
  /** Return the LAST `limit` bars of the range instead of the first. */
  readonly last?: boolean;
}

export function getBars(db: Db, datasetId: number, q: BarQuery): Bar[] {
  const sql = q.last
    ? `SELECT * FROM (SELECT time, open, high, low, close, volume FROM bars
         WHERE dataset_id = @id AND time >= @from AND time <= @to
         ORDER BY time DESC LIMIT @limit) ORDER BY time`
    : `SELECT time, open, high, low, close, volume FROM bars
       WHERE dataset_id = @id AND time >= @from AND time <= @to
       ORDER BY time LIMIT @limit`;
  return db.prepare(sql).all({
    id: datasetId,
    from: q.from ?? Number.MIN_SAFE_INTEGER,
    to: q.to ?? Number.MAX_SAFE_INTEGER,
    limit: q.limit,
  }) as Bar[];
}

export function deleteDataset(db: Db, id: number): boolean {
  return db.prepare('DELETE FROM datasets WHERE id = ?').run(id).changes > 0;
}

/** All bars of a dataset, in time order. Used by the replay engine (server-side only). */
export function getAllBars(db: Db, datasetId: number): Bar[] {
  return db
    .prepare(
      `SELECT time, open, high, low, close, volume FROM bars WHERE dataset_id = ? ORDER BY time`,
    )
    .all(datasetId) as Bar[];
}
