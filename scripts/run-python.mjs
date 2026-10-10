#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Run a Python script with the first working interpreter. Tries python3 then python.
// Skips ENOENT and Windows Microsoft Store alias exit code 9009.
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('usage: node scripts/run-python.mjs <script> [args...]');
  process.exit(2);
}

for (const bin of ['python3', 'python']) {
  const result = spawnSync(bin, args, { stdio: 'inherit' });
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === 'ENOENT') {
    continue;
  }
  if (result.status === 9009) continue;
  process.exit(result.status ?? 1);
}

console.error('python3 or python is required');
process.exit(1);
