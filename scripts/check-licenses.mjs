#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Dependency licence gate. CandleDrill is AGPL-3.0-or-later, so every dependency we
// ship must be compatible with (A)GPLv3. Uses `npm query` (no extra tooling needed).
// Fails on unknown, missing or non-allowlisted licences.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { satisfiesSpdx as satisfies } from './lib/spdx.mjs';

/** Licences we may ship in runtime dependencies (all GPLv3/AGPLv3-compatible per FSF). */
const RUNTIME_ALLOW = new Set([
  'MIT',
  'MIT-0',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'Unlicense',
  'Zlib',
  'MPL-2.0',
  'LGPL-2.1-or-later',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
  'GPL-3.0-only',
  'GPL-3.0-or-later',
  'AGPL-3.0-only',
  'AGPL-3.0-or-later',
]);

/** Extra licences acceptable for build/test-only tooling that is never shipped. */
const DEV_ONLY_ALLOW = new Set(['CC-BY-4.0', 'CC-BY-3.0', 'Python-2.0']);

/**
 * Manually reviewed exceptions: "name@version" -> reason. Keep this empty unless a
 * human has read the actual licence text. Never add GPL-2.0-only here.
 */
const REVIEWED_EXCEPTIONS = new Map([]);

function normalise(lic) {
  if (!lic) return undefined;
  if (typeof lic === 'object') return lic.type;
  return String(lic).trim();
}

/**
 * Run `npm query '*'` portably. `execFileSync('npm')` fails on Windows (npm is a .cmd
 * shim, so it reports ENOENT), so we start npm's JavaScript entry point with the current
 * Node binary instead.
 */
function npmQueryAll() {
  const opts = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };
  const candidates = [
    process.env.npm_execpath, // set by `npm run`
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), // Windows
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), // Unix
  ].filter((p) => p && /npm-cli\.js$/.test(p) && existsSync(p));
  if (candidates.length > 0) {
    return execFileSync(process.execPath, [candidates[0], 'query', '*'], opts);
  }
  // Last resort: let the OS shell resolve npm (needed for the .cmd shim on Windows).
  return execFileSync('npm', ['query', '*'], { ...opts, shell: process.platform === 'win32' });
}

const raw = npmQueryAll();
const pkgs = JSON.parse(raw);
const devAllowed = new Set([...RUNTIME_ALLOW, ...DEV_ONLY_ALLOW]);

const failures = [];
const counts = new Map();
let checked = 0;
for (const p of pkgs) {
  if (p.name?.startsWith('@candledrill/') || p.location === '') continue; // our own code
  const id = `${p.name}@${p.version}`;
  const lic = normalise(p.license);
  checked++;
  counts.set(lic ?? '(none)', (counts.get(lic ?? '(none)') ?? 0) + 1);
  if (REVIEWED_EXCEPTIONS.has(id)) continue;
  if (!lic) {
    failures.push(`${id}: no licence field`);
    continue;
  }
  const ok = satisfies(lic, p.dev ? devAllowed : RUNTIME_ALLOW);
  if (!ok) failures.push(`${id}: ${lic} (${p.dev ? 'dev' : 'runtime'}) not allowlisted`);
}

console.info(`Checked ${checked} third-party packages.`);
for (const [lic, n] of [...counts].sort((a, b) => b[1] - a[1])) console.info(`  ${lic}: ${n}`);
if (failures.length) {
  console.error(`\nLicence check FAILED (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.info('Licence check passed: all dependencies are AGPL-3.0-compatible.');
