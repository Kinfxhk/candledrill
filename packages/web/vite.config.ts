// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  .version as string;

// VITE_BACKEND=local builds the GitHub Pages version (engine + IndexedDB in the browser).
// PAGES_BASE sets the public path (for example /candledrill/).
export default defineConfig({
  base: process.env.PAGES_BASE ?? '/',
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 800 },
  server: {
    host: '127.0.0.1',
    strictPort: true,
    port: 4871,
    proxy: { '/api': 'http://127.0.0.1:4870' },
  },
  preview: { host: '127.0.0.1' },
});
