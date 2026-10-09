// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Full backup and restore of the local SQLite library (datasets, bars, sessions).
//
// Backup: a consistent snapshot of the whole database file (sqlite3_serialize), so it can
// be opened by any SQLite tool and restored here.
//
// Restore: the uploaded file is opened read-only first and must pass every check before
// anything changes: SQLite integrity check, only the tables/indexes CandleDrill creates (no
// triggers or views), a known schema version, foreign keys intact, and settings/state JSON
// that parses. Runtime bars and sessions are validated after migration on a private copy.
// The validated copy is copied
// into the live database in ONE transaction. A copy of the current database is written next
// to it first ("candledrill.db.before-restore-<time>"), so a restore can be undone.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, basename, join } from 'node:path';
import Database from 'better-sqlite3';
import {
  blindIssues,
  checkSessionState,
  disguiseBars,
  journalIssues,
  parseSessionFile,
  validateBars,
  type SessionState,
} from '@candledrill/core';
import {
  MIGRATIONS_COUNT,
  migrate,
  getAllBars,
  listDatasets,
  listSessions,
  type Db,
} from './db.js';
import type { StoredSettings } from './sessions.js';

export const MAX_RESTORE_BYTES = 1024 * 1024 * 1024;
const TABLES = ['datasets', 'bars', 'sessions'] as const;
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');

export class RestoreError extends Error {}

/**
 * A WAL-mode database file says so in its header (bytes 18-19 = 2). Rewrite that to the
 * classic rollback-journal format (1) so the file opens anywhere, including from memory.
 * The page content is unchanged; serialize() already includes every committed change.
 */
function asRollbackJournal(bytes: Buffer): Buffer {
  if (bytes.length < 100 || (bytes[18] !== 2 && bytes[19] !== 2)) return bytes;
  const out = Buffer.from(bytes);
  out[18] = 1;
  out[19] = 1;
  return out;
}

export function backupBytes(db: Db): Buffer {
  return asRollbackJournal(db.serialize());
}

/** Check a candidate backup. Throws RestoreError with a readable reason. */
export function inspectBackup(input: Buffer): {
  datasets: number;
  sessions: number;
  version: number;
} {
  const bytes = asRollbackJournal(input);
  if (bytes.length < 512 || !bytes.subarray(0, 16).equals(SQLITE_MAGIC))
    throw new RestoreError('not an SQLite database file');
  let src: Db;
  try {
    src = new Database(bytes, { readonly: true });
  } catch {
    throw new RestoreError('the file could not be opened as a database');
  }
  try {
    src.pragma('trusted_schema = OFF');
    const ok = src.pragma('integrity_check', { simple: true });
    if (ok !== 'ok') throw new RestoreError('the database is damaged (integrity check failed)');
    const objects = src.prepare(`SELECT type, name, tbl_name FROM sqlite_master`).all() as {
      type: string;
      name: string;
      tbl_name: string;
    }[];
    for (const o of objects) {
      const allowedTable = o.type === 'table' && [...TABLES, 'sqlite_sequence'].includes(o.name);
      const allowedIndex =
        o.type === 'index' &&
        (TABLES as readonly string[]).includes(o.tbl_name) &&
        (o.name === 'sessions_dataset' || o.name.startsWith('sqlite_autoindex_'));
      if (!allowedTable && !allowedIndex)
        throw new RestoreError(`unexpected ${o.type} "${o.name}" in the file`);
    }
    const version = src.pragma('user_version', { simple: true }) as number;
    if (!Number.isInteger(version) || version < 1 || version > MIGRATIONS_COUNT)
      throw new RestoreError(
        version > MIGRATIONS_COUNT
          ? 'the backup was made by a newer CandleDrill; update first'
          : 'not a CandleDrill database',
      );
    const names = new Set(objects.filter((o) => o.type === 'table').map((o) => o.name));
    if (!names.has('datasets') || !names.has('bars'))
      throw new RestoreError('not a CandleDrill database');
    if (version >= 3 && !names.has('sessions'))
      throw new RestoreError('not a CandleDrill database');
    const fk = src.pragma('foreign_key_check') as unknown[];
    if (fk.length) throw new RestoreError('the database has broken links between tables');
    let sessions = 0;
    if (names.has('sessions')) {
      for (const r of src
        .prepare(
          `SELECT settings_json, state_json, drawings_json${version >= 4 ? ', journal_json' : ''} FROM sessions`,
        )
        .iterate() as Iterable<Record<string, string>>) {
        try {
          for (const v of Object.values(r)) {
            const parsed: unknown = JSON.parse(v);
            if (typeof parsed !== 'object' || parsed === null) throw new Error('x');
          }
        } catch {
          throw new RestoreError('a practice session in the file is unreadable');
        }
        sessions++;
      }
    }
    const datasets = (src.prepare('SELECT COUNT(*) AS n FROM datasets').get() as { n: number }).n;
    return { datasets, sessions, version };
  } catch (err) {
    if (err instanceof RestoreError) throw err;
    throw new RestoreError('the database is damaged or unreadable');
  } finally {
    src.close();
  }
}

/** Validate runtime data on the migrated private copy, before any live writes. */
function validateLibrary(src: Db): void {
  const sessions = listSessions<StoredSettings, SessionState>(src);
  for (const ds of listDatasets(src)) {
    if (
      !Number.isFinite(ds.tickSize) ||
      ds.tickSize <= 0 ||
      !Number.isFinite(ds.timeframeSeconds) ||
      ds.timeframeSeconds <= 0
    )
      throw new RestoreError('a dataset in the file has invalid metadata');
    const bars = getAllBars(src, ds.id);
    if (validateBars(bars, { timeframeSeconds: ds.timeframeSeconds }).length)
      throw new RestoreError('a dataset in the file has invalid bars');
    for (const row of sessions.filter((r) => r.datasetId === ds.id)) {
      const { blind, ...settings } = row.settings;
      const parsed = parseSessionFile(
        JSON.stringify({
          format: 'candledrill-session',
          formatVersion: 1,
          name: row.name,
          startTime: row.startTime,
          settings,
          blind,
          state: row.state,
          drawings: row.drawings,
          journal: row.journal,
        }),
        { source: 'backup' },
      );
      if (!parsed.file) throw new RestoreError('a practice session in the file is invalid');
      const f = parsed.file;
      let sessionBars = bars;
      if (f.blind) {
        if (f.blind.symbol !== ds.symbol || blindIssues(f.blind, bars, f.settings.tickSize).length)
          throw new RestoreError('a blind practice session in the file is invalid');
        sessionBars = disguiseBars(bars, f.blind, f.settings.tickSize);
      } else if (f.settings.symbol !== ds.symbol) {
        throw new RestoreError('a practice session in the file has the wrong symbol');
      }
      if (
        checkSessionState(sessionBars, f.settings, f.state, { source: 'backup' }).length ||
        journalIssues(row.journal, f.state.trading.trades).length
      )
        throw new RestoreError('a practice session in the file does not match its dataset');
    }
  }
}

export interface RestoreResult {
  readonly datasets: number;
  readonly sessions: number;
  /** Where the previous database was saved, or null for an in-memory database. */
  readonly previousCopy: string | null;
}

/** Replace the whole library with the backup. All-or-nothing. */
export function restoreBackup(
  db: Db,
  input: Buffer,
  databasePath: string | undefined,
  now: Date,
): RestoreResult {
  const info = inspectBackup(input);
  const bytes = asRollbackJournal(input);
  // Bring a private copy up to the current schema (never touches the user's file).
  const dir = mkdtempSync(join(tmpdir(), 'candledrill-restore-'));
  const copy = join(dir, 'restore.db');
  try {
    writeFileSync(copy, bytes);
    const src = new Database(copy);
    try {
      src.pragma('trusted_schema = OFF');
      migrate(src);
      validateLibrary(src);
    } catch (err) {
      if (err instanceof RestoreError) throw err;
      throw new RestoreError('the file could not be upgraded to the current layout');
    } finally {
      src.close();
    }

    let previousCopy: string | null = null;
    if (databasePath && databasePath !== ':memory:') {
      const stamp = now.toISOString().replace(/[:.]/g, '-');
      previousCopy = join(
        dirname(databasePath),
        `${basename(databasePath)}.before-restore-${stamp}`,
      );
      writeFileSync(previousCopy, backupBytes(db));
    }

    db.prepare('ATTACH DATABASE ? AS src').run(copy);
    try {
      const cols = (t: string) =>
        (db.pragma(`main.table_info(${t})`) as { name: string }[])
          .map((c) => `"${c.name}"`)
          .join(', ');
      db.transaction(() => {
        db.exec('DELETE FROM main.sessions; DELETE FROM main.bars; DELETE FROM main.datasets;');
        for (const t of TABLES) {
          const c = cols(t);
          db.exec(`INSERT INTO main.${t} (${c}) SELECT ${c} FROM src.${t}`);
        }
        db.exec(
          `DELETE FROM main.sqlite_sequence;
           INSERT INTO main.sqlite_sequence (name, seq) SELECT name, seq FROM src.sqlite_sequence
             WHERE name IN ('datasets', 'sessions');`,
        );
        const fk = db.pragma('main.foreign_key_check') as unknown[];
        if (fk.length) throw new RestoreError('restored data has broken links');
      })();
    } catch (err) {
      if (err instanceof RestoreError) throw err;
      throw new RestoreError('the file does not match the CandleDrill table layout');
    } finally {
      db.exec('DETACH DATABASE src');
    }
    return { datasets: info.datasets, sessions: info.sessions, previousCopy };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
