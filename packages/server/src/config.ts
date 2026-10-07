// SPDX-License-Identifier: AGPL-3.0-or-later
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The only interface CandleDrill will ever listen on. */
export const LOOPBACK_HOST = '127.0.0.1';
export const DEFAULT_PORT = 4870;

export interface ServerConfig {
  readonly host: typeof LOOPBACK_HOST;
  readonly port: number;
  /** Path to the SQLite file, or ":memory:". */
  readonly databasePath: string;
}

/**
 * Build config from environment variables. Any attempt to bind to a non-loopback
 * address is rejected: CandleDrill is a single-user local tool with no auth layer.
 */
export function resolveConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const host = env.CANDLEDRILL_HOST ?? LOOPBACK_HOST;
  if (host !== LOOPBACK_HOST) {
    throw new Error(
      `CANDLEDRILL_HOST must be ${LOOPBACK_HOST} (got "${host}"). ` +
        'CandleDrill only listens on the local loopback interface.',
    );
  }
  const port = env.CANDLEDRILL_PORT === undefined ? DEFAULT_PORT : Number(env.CANDLEDRILL_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`CANDLEDRILL_PORT must be an integer 0-65535 (got "${env.CANDLEDRILL_PORT}")`);
  }
  const dataDir = env.CANDLEDRILL_DATA_DIR ?? join(homedir(), '.candledrill');
  const databasePath = env.CANDLEDRILL_DB ?? join(dataDir, 'candledrill.db');
  return { host: LOOPBACK_HOST, port, databasePath };
}
