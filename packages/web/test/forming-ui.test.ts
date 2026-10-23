// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('demo practice timeframe control', () => {
  it('offers practice timeframes and not the TF/6 source', () => {
    const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
    const start = html.indexOf('id="demo-tf"');
    const end = html.indexOf('</select>', start);
    const menu = html.slice(start, end);
    expect(menu).toContain('value="60"');
    expect(menu).toContain('value="300"');
    expect(menu).toContain('value="900"');
    expect(menu).not.toMatch(/value="10"/);
    expect(menu).not.toMatch(/value="50"/);
    expect(menu).not.toMatch(/value="150"/);
    expect(menu).not.toMatch(/value="600"/);
  });
});
