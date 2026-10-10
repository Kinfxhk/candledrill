// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { openDatabase, type Db } from '../src/db.js';
import { withToken, TEST_TOKEN } from './helpers.js';
import {
  checkForUpdate,
  clearUpdateCache,
  isNewer,
  parseVersion,
  readReleaseVersion,
  RELEASES_PAGE,
  type UpdatesFetch,
} from '../src/updates.js';

afterEach(() => clearUpdateCache());

describe('semver helpers', () => {
  it('orders release tags the way package.json versions do', () => {
    expect(parseVersion('v0.2.5')).toEqual({ major: 0, minor: 2, patch: 5 });
    expect(isNewer('0.2.5', '0.2.6')).toBe(true);
    expect(isNewer('0.2.5', '0.2.5')).toBe(false);
  });

  it('reads the monorepo package.json version', () => {
    expect(parseVersion(readReleaseVersion())).not.toBeNull();
  });
});

describe('checkForUpdate', () => {
  it('returns newer=true for a higher GitHub tag', async () => {
    const fetchImpl: UpdatesFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: 'v0.9.9',
        name: 'CandleDrill v0.9.9',
        html_url: 'https://github.com/Kinfxhk/candledrill/releases/tag/v0.9.9',
      }),
    });
    const r = await checkForUpdate({ current: '0.2.5', fetchImpl, now: 1 });
    expect(r).toMatchObject({
      current: '0.2.5',
      latest: '0.9.9',
      newer: true,
      available: true,
      url: 'https://github.com/Kinfxhk/candledrill/releases/tag/v0.9.9',
    });
  });

  it('fails quiet on network / HTTP / bad JSON', async () => {
    const boom: UpdatesFetch = async () => {
      throw new Error('offline');
    };
    const offline = await checkForUpdate({ current: '0.2.5', fetchImpl: boom, now: 1 });
    expect(offline).toEqual({
      current: '0.2.5',
      latest: null,
      newer: false,
      url: RELEASES_PAGE,
      name: null,
      available: false,
    });

    clearUpdateCache();
    const badStatus: UpdatesFetch = async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    });
    expect(
      (await checkForUpdate({ current: '0.2.5', fetchImpl: badStatus, now: 2 })).available,
    ).toBe(false);

    clearUpdateCache();
    const badBody: UpdatesFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ tag_name: 'not-semver' }),
    });
    expect((await checkForUpdate({ current: '0.2.5', fetchImpl: badBody, now: 3 })).available).toBe(
      false,
    );
  });

  it('reuses the cache within the quiet window', async () => {
    let calls = 0;
    const fetchImpl: UpdatesFetch = async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ tag_name: 'v1.0.0', html_url: RELEASES_PAGE + '/tag/v1.0.0' }),
      };
    };
    await checkForUpdate({ current: '0.2.5', fetchImpl, now: 1000, cacheMs: 60_000 });
    await checkForUpdate({ current: '0.2.5', fetchImpl, now: 30_000, cacheMs: 60_000 });
    expect(calls).toBe(1);
    await checkForUpdate({ current: '0.2.5', fetchImpl, now: 70_000, cacheMs: 60_000 });
    expect(calls).toBe(2);
  });
});

describe('GET /api/updates', () => {
  let app: FastifyInstance | undefined;
  let db: Db | undefined;

  afterEach(async () => {
    await app?.close();
    db?.close();
    app = undefined;
    db = undefined;
  });

  it('proxies a newer release and stays quiet when the lookup fails', async () => {
    db = openDatabase(':memory:');
    const fetchImpl: UpdatesFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: 'v9.9.9',
        name: 'future',
        html_url: 'https://github.com/Kinfxhk/candledrill/releases/tag/v9.9.9',
      }),
    });
    app = withToken(buildApp({ db, apiToken: TEST_TOKEN, fetchUpdates: fetchImpl }));
    const ok = await app.inject({ method: 'GET', url: '/api/updates' });
    expect(ok.statusCode).toBe(200);
    const body = ok.json();
    expect(body.newer).toBe(true);
    expect(body.latest).toBe('9.9.9');
    expect(body.current).toBe(readReleaseVersion());

    clearUpdateCache();
    await app.close();
    const failFetch: UpdatesFetch = async () => {
      throw new Error('no net');
    };
    app = withToken(buildApp({ db, apiToken: TEST_TOKEN, fetchUpdates: failFetch }));
    const quiet = await app.inject({ method: 'GET', url: '/api/updates' });
    expect(quiet.statusCode).toBe(200);
    expect(quiet.json()).toMatchObject({ newer: false, latest: null, available: false });
  });
});
