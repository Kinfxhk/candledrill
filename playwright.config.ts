// SPDX-License-Identifier: AGPL-3.0-or-later
// Headless browser smoke test. Run with `npm run test:e2e` (builds the web UI first).
// Uses Playwright's bundled Chromium (`npx playwright install chromium`), or any local
// Chrome/Chromium via PW_CHROMIUM_PATH=/usr/bin/google-chrome.
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 4899);
const executablePath = process.env.PW_CHROMIUM_PATH;

// The first-open countdown covers the chart and then presses Play. Existing specs
// click Play, step, and the ticket while the session is still stopped. Turn the
// intro off for this origin; e2e/countdown.spec.ts opts back in.
const storageState = join(tmpdir(), `candledrill-e2e-${PORT}.json`);
writeFileSync(
  storageState,
  JSON.stringify({
    cookies: [],
    origins: [
      {
        origin: `http://127.0.0.1:${PORT}`,
        localStorage: [{ name: 'candledrill.countdownE2E', value: '0' }],
      },
    ],
  }),
);

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  // One shared in-memory server: run specs one after another so they never interleave.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    storageState,
    headless: true,
    locale: 'en-US',
    colorScheme: 'dark',
    viewport: { width: 1440, height: 900 },
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    // Safari's engine for the phone fit / alignment checks (iPhones run WebKit).
    // Opt-in with E2E_WEBKIT=1 (needs `npx playwright install webkit`); the Linux CI job sets it.
    ...(process.env.E2E_WEBKIT
      ? [
          {
            name: 'webkit',
            testMatch: /(devices|phone)\.spec\.ts/,
            use: { browserName: 'webkit' as const, launchOptions: {} },
          },
        ]
      : []),
  ],
  webServer: {
    // A plain Node entry point works on every OS (the Unix-style .bin shim path does not
    // run under Windows cmd.exe).
    command: 'node --import tsx packages/server/src/main.ts',
    url: `http://127.0.0.1:${PORT}/api/health`,
    env: { CANDLEDRILL_DB: ':memory:', CANDLEDRILL_PORT: String(PORT) },
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
