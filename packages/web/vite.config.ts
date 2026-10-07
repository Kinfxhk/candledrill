// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    strictPort: true,
    port: 4871,
    proxy: { '/api': 'http://127.0.0.1:4870' },
  },
  preview: { host: '127.0.0.1' },
});
