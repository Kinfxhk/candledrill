// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { DEFAULT_PORT, LOOPBACK_HOST, resolveConfig } from '../src/config.js';

describe('resolveConfig', () => {
  it('defaults to 127.0.0.1 and the default port', () => {
    const c = resolveConfig({ CANDLEDRILL_DATA_DIR: '/tmp/cd' });
    expect(c.host).toBe(LOOPBACK_HOST);
    expect(c.port).toBe(DEFAULT_PORT);
    expect(c.databasePath).toBe('/tmp/cd/candledrill.db');
  });

  it.each(['0.0.0.0', '::', '192.168.1.10', 'localhost', '::1'])(
    'refuses to bind to %s',
    (host) => {
      expect(() => resolveConfig({ CANDLEDRILL_HOST: host })).toThrow(/127\.0\.0\.1/);
    },
  );

  it('validates the port', () => {
    expect(() => resolveConfig({ CANDLEDRILL_PORT: 'abc' })).toThrow();
    expect(() => resolveConfig({ CANDLEDRILL_PORT: '70000' })).toThrow();
    expect(resolveConfig({ CANDLEDRILL_PORT: '0' }).port).toBe(0);
  });
});
