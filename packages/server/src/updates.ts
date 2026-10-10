// SPDX-License-Identifier: AGPL-3.0-or-later
// Optional new-version check. The local server asks GitHub's public Releases API so the
// browser never talks to the network (CSP connect-src is 'self' only). Failures are quiet:
// the UI treats "unavailable" the same as "no update".

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RELEASES_PAGE = 'https://github.com/Kinfxhk/candledrill/releases';
export const LATEST_RELEASE_API =
  'https://api.github.com/repos/Kinfxhk/candledrill/releases/latest';

/** Quiet cache so a busy library page does not hammer api.github.com. */
export const UPDATE_CACHE_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;

export interface VersionParts {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/** Parse "0.2.5", "v0.2.5", or "0.2.5-rc.1" (prerelease suffix ignored for ordering). */
export function parseVersion(raw: string): VersionParts | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/i.exec(raw.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** True when `latest` is a higher major/minor/patch than `current`. */
export function isNewer(current: string, latest: string): boolean {
  const a = parseVersion(current);
  const b = parseVersion(latest);
  if (!a || !b) return false;
  if (b.major !== a.major) return b.major > a.major;
  if (b.minor !== a.minor) return b.minor > a.minor;
  return b.patch > a.patch;
}

/** Strip a leading `v` so tags and package.json versions compare cleanly. */
export function normalizeTag(tag: string): string {
  const t = tag.trim();
  return t.startsWith('v') || t.startsWith('V') ? t.slice(1) : t;
}

export function readReleaseVersion(
  packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), '../../../package.json'),
): string {
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: string };
  if (typeof pkg.version !== 'string' || !parseVersion(pkg.version))
    throw new Error(`invalid package.json version: ${String(pkg.version)}`);
  return pkg.version;
}

export interface UpdateCheckResult {
  readonly current: string;
  /** Normalised tag without leading v, or null when GitHub was unreachable / empty. */
  readonly latest: string | null;
  readonly newer: boolean;
  readonly url: string;
  readonly name: string | null;
  readonly available: boolean;
}

export type UpdatesFetch = (
  input: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

interface CacheEntry {
  readonly at: number;
  readonly result: UpdateCheckResult;
}

let cache: CacheEntry | null = null;

/** Test helper: drop the in-process latest-release cache. */
export function clearUpdateCache(): void {
  cache = null;
}

export async function checkForUpdate(opts: {
  readonly current: string;
  readonly fetchImpl?: UpdatesFetch;
  readonly now?: number;
  readonly cacheMs?: number;
}): Promise<UpdateCheckResult> {
  const now = opts.now ?? Date.now();
  const cacheMs = opts.cacheMs ?? UPDATE_CACHE_MS;
  if (cache && now - cache.at >= 0 && now - cache.at < cacheMs) return cache.result;

  const unavailable = (): UpdateCheckResult => ({
    current: opts.current,
    latest: null,
    newer: false,
    url: RELEASES_PAGE,
    name: null,
    available: false,
  });

  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as UpdatesFetch);
  let res: Awaited<ReturnType<UpdatesFetch>>;
  try {
    res = await fetchImpl(LATEST_RELEASE_API, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': `CandleDrill/${opts.current} (+https://github.com/Kinfxhk/candledrill)`,
        'x-github-api-version': '2022-11-28',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    const result = unavailable();
    cache = { at: now, result };
    return result;
  }

  if (!res.ok) {
    const result = unavailable();
    cache = { at: now, result };
    return result;
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    const result = unavailable();
    cache = { at: now, result };
    return result;
  }

  const tag =
    typeof body === 'object' && body !== null && 'tag_name' in body
      ? (body as { tag_name?: unknown }).tag_name
      : undefined;
  const name =
    typeof body === 'object' && body !== null && 'name' in body
      ? (body as { name?: unknown }).name
      : undefined;
  const htmlUrl =
    typeof body === 'object' && body !== null && 'html_url' in body
      ? (body as { html_url?: unknown }).html_url
      : undefined;

  if (typeof tag !== 'string' || !parseVersion(tag)) {
    const result = unavailable();
    cache = { at: now, result };
    return result;
  }

  const latest = normalizeTag(tag);
  const url =
    typeof htmlUrl === 'string' && htmlUrl.startsWith('https://github.com/')
      ? htmlUrl
      : `${RELEASES_PAGE}/tag/v${latest}`;
  const result: UpdateCheckResult = {
    current: opts.current,
    latest,
    newer: isNewer(opts.current, latest),
    url,
    name: typeof name === 'string' && name.trim() ? name.trim() : null,
    available: true,
  };
  cache = { at: now, result };
  return result;
}
