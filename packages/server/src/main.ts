// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { CANDLEDRILL_RISK_NOTICE_EN } from '@candledrill/core';
import { resolveConfig } from './config.js';
import { openDatabase } from './db.js';
import { buildApp } from './app.js';

const config = resolveConfig();
if (config.databasePath !== ':memory:')
  mkdirSync(dirname(config.databasePath), { recursive: true });
const db = openDatabase(config.databasePath);
const app = buildApp({ db, logger: true });

const close = async () => {
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', close);
process.on('SIGTERM', close);

await app.listen({ host: config.host, port: config.port });
console.info(
  `\n${CANDLEDRILL_RISK_NOTICE_EN}\nNo telemetry. Data stays in ${config.databasePath}\n`,
);
