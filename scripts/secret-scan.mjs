// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Portable secret scan. Preferred: gitleaks (https://github.com/gitleaks/gitleaks, MIT).
// Fallback when gitleaks is not installed: a conservative grep for common key formats.

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function hasGitleaks() {
  const r = spawnSync('gitleaks', ['version'], { stdio: 'ignore' });
  return r.error === undefined && r.status === 0;
}

function runGitleaks() {
  execFileSync('gitleaks git --redact --no-banner --exit-code 1 .', {
    cwd: root,
    stdio: 'inherit',
    shell: true,
  });
  execFileSync('gitleaks dir --redact --no-banner --exit-code 1 --config .gitleaks.toml .', {
    cwd: root,
    stdio: 'inherit',
    shell: true,
  });
  console.info('Secret scan passed (gitleaks).');
}

const PATTERNS = [
  { re: /AKIA[0-9A-Z]{16}/g, name: 'AWS access key id' },
  { re: /gh[pousr]_[A-Za-z0-9]{36,}/g, name: 'GitHub token' },
  { re: /github_pat_[A-Za-z0-9_]{50,}/g, name: 'GitHub fine-grained PAT' },
  { re: /sk-[A-Za-z0-9_-]{20,}/g, name: 'OpenAI/OpenRouter style key' },
  { re: /xox[baprs]-[A-Za-z0-9-]{10,}/g, name: 'Slack token' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, name: 'private key' },
  { re: /AIza[0-9A-Za-z_-]{35}/g, name: 'Google API key' },
];

function listFiles() {
  const r = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (r.error) throw r.error;
  return r.stdout.split('\0').filter(Boolean);
}

function fallbackScan() {
  console.warn('WARNING: gitleaks not found; using fallback pattern scan (less thorough).');
  let found = 0;
  const files = listFiles();
  for (const file of files) {
    if (file === 'scripts/secret-scan.mjs') continue;
    let text;
    try {
      text = readFileSync(join(root, file), 'utf8');
    } catch {
      continue;
    }
    for (const { re, name } of PATTERNS) {
      re.lastIndex = 0;
      if (re.test(text)) {
        console.error(`Possible ${name} in ${file}`);
        found++;
      }
    }
  }
  if (found) {
    console.error('Secret scan FAILED (fallback).');
    process.exit(1);
  }
  console.info('Secret scan passed (fallback patterns).');
}

if (hasGitleaks()) {
  runGitleaks();
} else {
  fallbackScan();
}
