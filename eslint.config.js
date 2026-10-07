// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
    },
  },
  {
    // The core engine must stay pure: no I/O, no clock, no ambient randomness.
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: ['node:*', 'fs', 'path', 'http', 'https', 'net', 'child_process'] },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Use the seeded RNG in rng.ts.' },
        { object: 'Date', property: 'now', message: 'Core must not read the clock.' },
      ],
    },
  },
  {
    files: ['packages/web/src/**/*.ts'],
    languageOptions: { globals: { ...globals.browser } },
  },
  prettier,
);
