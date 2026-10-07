// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { generateSyntheticBars } from '@candledrill/core';
import { getBars, insertDataset, listDatasets, migrate, openDatabase, type Db } from '../src/db.js';

let db: Db | undefined;
afterEach(() => db?.close());

describe('database', () => {
  it('migrates idempotently', () => {
    db = openDatabase(':memory:');
    expect(migrate(db)).toBe(3);
    expect(migrate(db)).toBe(3);
  });

  it('round-trips a synthetic dataset exactly', () => {
    db = openDatabase(':memory:');
    const ds = generateSyntheticBars({ seed: 1, startDate: '2026-10-05', days: 2 });
    const row = insertDataset(db, 'test', ds.meta, ds.bars, '2026-10-07T00:00:00.000Z');
    expect(row.synthetic).toBe(true);
    expect(row.barCount).toBe(ds.bars.length);
    expect(row.generator).toEqual(ds.meta.generator);
    expect(getBars(db, row.id, { limit: 100_000 })).toEqual(ds.bars);
    expect(listDatasets(db)).toHaveLength(1);
  });

  it('never returns bars after the `to` bound', () => {
    db = openDatabase(':memory:');
    const ds = generateSyntheticBars({ seed: 2, startDate: '2026-10-05', days: 1 });
    const row = insertDataset(db, 'test', ds.meta, ds.bars, '2026-10-07T00:00:00.000Z');
    const cut = ds.bars[100]!.time;
    const got = getBars(db, row.id, { to: cut, limit: 100_000 });
    expect(got).toHaveLength(101);
    expect(got.every((b) => b.time <= cut)).toBe(true);
  });
});
