#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Guard: CandleDrill must never ship real market data. Fails if any tracked file looks
// like a data dump (CSV/Parquet/SQLite etc.) or if required notice files are missing.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const FORBIDDEN_EXT =
  /\.(csv|tsv|parquet|feather|arrow|h5|hdf5|db|sqlite|sqlite3|scid|dly|bcd|hcc|tick|ticks)$/i;
/** Fixtures that are explicitly allowed (must be synthetic and documented). */
const ALLOWED_PATHS = new Set([]);

const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

const problems = [];
for (const f of files) {
  if (FORBIDDEN_EXT.test(f) && !ALLOWED_PATHS.has(f))
    problems.push(`data-like file not allowed: ${f}`);
}

for (const required of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'README.md']) {
  if (!existsSync(required)) problems.push(`missing required file: ${required}`);
}
if (existsSync('README.md')) {
  const readme = readFileSync('README.md', 'utf8');
  if (!readme.includes('not investment advice')) problems.push('README.md lacks the risk notice');
  if (!readme.includes('https://buymeacoffee.com/kinfxhk'))
    problems.push('README.md lacks Support link');
}
if (existsSync('THIRD_PARTY_NOTICES.md')) {
  const tp = readFileSync('THIRD_PARTY_NOTICES.md', 'utf8');
  if (!tp.includes('lightweight-charts'))
    problems.push('THIRD_PARTY_NOTICES.md lacks lightweight-charts entry');
}

// lightweight-charts (Apache-2.0) attribution must stay visible in the UI.
const UI = 'packages/web/index.html';
if (existsSync(UI)) {
  const html = readFileSync(UI, 'utf8');
  if (
    !html.includes('TradingView Lightweight Charts™') ||
    !html.includes('href="https://www.tradingview.com/"')
  )
    problems.push(`${UI} lacks the lightweight-charts NOTICE attribution or tradingview.com link`);
}
const CHART = 'packages/web/src/chart.ts';
if (existsSync(CHART) && /attributionLogo:\s*false/.test(readFileSync(CHART, 'utf8')))
  problems.push(`${CHART} disables the lightweight-charts attribution logo`);

if (problems.length) {
  console.error('Repository hygiene check FAILED:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.info(`Repository hygiene check passed (${files.length} files, no bundled market data).`);
