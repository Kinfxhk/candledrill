// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 'local' = GitHub Pages build (engine in the browser); unset = local server build. */
  readonly VITE_BACKEND?: string;
}

/** Root package.json version, injected by vite.config.ts. */
declare const __APP_VERSION__: string;
