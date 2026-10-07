// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANDLEDRILL_RISK_NOTICE_EN } from '@candledrill/core';
import { resolveConfig } from './config.js';
import { openDatabase } from './db.js';
import { buildApp } from './app.js';

const config = resolveConfig();
if (config.databasePath !== ':memory:')
  mkdirSync(dirname(config.databasePath), { recursive: true });
const db = openDatabase(config.databasePath);
const staticDir =
  process.env.CANDLEDRILL_STATIC_DIR ??
  resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
const app = buildApp({ db, logger: process.env.CANDLEDRILL_LOG_LEVEL ?? 'warn', staticDir });

const close = async () => {
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', close);
process.on('SIGTERM', close);

await app.listen({ host: config.host, port: config.port });
const port = app.server.address();
const actualPort = typeof port === 'object' && port ? port.port : config.port;
console.info(
  `\nCandleDrill is running: http://127.0.0.1:${actualPort}/\n` +
    (config.host === '127.0.0.1'
      ? ''
      : 'Container mode: publish the port on the host loopback only (127.0.0.1:4870:4870).\n') +
    `${CANDLEDRILL_RISK_NOTICE_EN}\nNo telemetry. Data stays in ${config.databasePath}\n`,
);
